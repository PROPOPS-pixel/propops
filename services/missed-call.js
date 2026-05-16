/**
 * Missed Call Pipeline
 *
 * Triggered when Twilio fires a voice webhook for a call forwarded to our AU number.
 *
 * Flow:
 *   1. Normalise the caller's number (From) and the forwarding number (ForwardedFrom)
 *   2. Look up the tradie by their mobile (ForwardedFrom → tradie_phone_mappings)
 *   3. Create a job record with source: 'missed_call'
 *   4. Generate a professional AI callback message via OpenAI
 *   5. Store AI response on the job
 *   6. Notify tradie via SMS + PWA push
 *
 * All errors are caught — this runs in a fire-and-forget async context from the
 * webhook handler, so it must never crash the parent request.
 */

'use strict';

const { Pool }  = require('pg');
const OpenAI    = require('openai');
const { sendSMS } = require('./sms');

const openai = new OpenAI();
// Uses OPENAI_BASE_URL + OPENAI_API_KEY from env automatically

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

const APP_URL = process.env.APP_URL || 'https://propops.pro';

// ─── Phone normalisation ──────────────────────────────────────────────────────

/**
 * Normalise any phone number format to E.164 (+61XXXXXXXXX for AU).
 * Returns null if the number cannot be normalised.
 */
function normalisePhone(raw) {
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, '');
  const hadPlus = digits.startsWith('+');
  if (hadPlus) digits = digits.slice(1);

  // Already E.164 AU: 614XXXXXXXXX
  if (/^614\d{8}$/.test(digits)) return `+${digits}`;
  // AU local: 04XXXXXXXX
  if (/^04\d{8}$/.test(digits)) return `+61${digits.slice(1)}`;
  // AU without leading zero: 4XXXXXXXX
  if (/^4\d{8}$/.test(digits)) return `+61${digits}`;
  // Non-AU international — pass through if looks valid
  if ((hadPlus || digits.length >= 10) && /^\d{7,15}$/.test(digits)) return `+${digits}`;

  return null;
}

/**
 * Format a phone number for display: +61412345678 → 0412 345 678
 */
function formatPhoneDisplay(e164) {
  if (!e164) return 'Unknown';
  const au = e164.replace(/^\+61/, '0');
  if (/^0\d{9}$/.test(au)) {
    return `${au.slice(0, 4)} ${au.slice(4, 7)} ${au.slice(7)}`;
  }
  return e164;
}

// ─── Tradie lookup ────────────────────────────────────────────────────────────

/**
 * Find the user (tradie) whose mobile number matches the forwarding number.
 * Returns full user row or null.
 */
async function findTradieByPhone(forwardedFromRaw) {
  const phone = normalisePhone(forwardedFromRaw);
  if (!phone) return null;

  try {
    const result = await pool.query(
      `SELECT u.*
       FROM tradie_phone_mappings tpm
       JOIN users u ON u.id = tpm.user_id
       WHERE tpm.tradie_phone = $1
       LIMIT 1`,
      [phone]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('[MissedCall] findTradieByPhone error:', err.message);
    return null;
  }
}

// ─── AI response generation ───────────────────────────────────────────────────

/**
 * Generate a professional callback message the tradie can send to the caller.
 * Uses the operator's profile (trade type, business name) if available.
 */
async function generateCallbackMessage(callerPhone, tradie) {
  const displayPhone = formatPhoneDisplay(callerPhone);
  const businessName = tradie?.agency_name || tradie?.name || 'the team';
  const businessType = tradie?.business_type || 'plumber';

  // Pick appropriate tone based on business type
  const isTrades = businessType !== 'real_estate';
  const tone = isTrades
    ? "friendly, casual Australian tradesperson — direct and helpful"
    : "professional, warm real estate team";

  const prompt = `You are an AI receptionist for ${businessName}.

A customer called and couldn't get through. Write a short, professional SMS callback message.

The message should:
- Thank them for calling
- Acknowledge we missed their call
- Promise to call back ASAP
- Be ${tone}
- Be under 100 words
- NOT include placeholders like [Name] — we don't have their name
- Sound natural, not robotic
- Use Australian English

Write ONLY the message text. No subject line, no formatting, no quotes.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 150,
      temperature: 0.7,
    });

    const text = completion.choices[0]?.message?.content?.trim();
    return {
      response: text || null,
      model: completion.model || 'gpt-4o-mini',
    };
  } catch (err) {
    console.error('[MissedCall] AI generation error:', err.message);
    // Return a sensible fallback
    return {
      response: `Hi, thanks for calling ${businessName}. Sorry we missed your call — we'll get back to you as soon as possible.`,
      model: 'template-fallback',
    };
  }
}

// ─── Job creation ─────────────────────────────────────────────────────────────

async function createMissedCallJob(tradieId, callerPhone, businessType, aiResponse, aiModel) {
  const displayPhone = formatPhoneDisplay(callerPhone);
  const result = await pool.query(
    `INSERT INTO jobs
       (agent_id, business_type, customer_name, customer_phone,
        job_type, job_description, source, status,
        ai_response, ai_response_model, ai_response_at)
     VALUES ($1,$2,$3,$4,$5,$6,'missed_call','new',$7,$8,NOW())
     RETURNING *`,
    [
      tradieId,
      businessType || 'plumber',
      `Caller ${displayPhone}`,
      callerPhone,
      'Missed Call — Callback Required',
      `Incoming call received via call forwarding. Caller number: ${displayPhone}. Hugo has generated a callback message.`,
      aiResponse,
      aiModel,
    ]
  );
  return result.rows[0];
}

async function logJobActivity(jobId, description, metadata = {}) {
  try {
    await pool.query(
      `INSERT INTO job_activities (job_id, activity_type, description, metadata)
       VALUES ($1,'missed_call',$2,$3)`,
      [jobId, description, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error('[MissedCall] logJobActivity error:', err.message);
  }
}

// ─── PWA push notification ────────────────────────────────────────────────────

async function sendPushNotification(userId, payload) {
  try {
    // Lazily require web-push to avoid breaking startup if the package isn't installed yet
    const webpush = require('web-push');

    // Ensure VAPID keys exist
    const vapidPublic  = await getOrCreateVapidKey('vapid_public_key');
    const vapidPrivate = await getOrCreateVapidKey('vapid_private_key');

    if (!vapidPublic || !vapidPrivate) {
      console.warn('[MissedCall] VAPID keys not available — skipping push');
      return;
    }

    webpush.setVapidDetails(
      `mailto:support@propops.pro`,
      vapidPublic,
      vapidPrivate
    );

    // Fetch all push subscriptions for this user
    const subs = await pool.query(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
      [userId]
    );

    if (subs.rows.length === 0) {
      console.log(`[MissedCall] No push subscriptions for user ${userId}`);
      return;
    }

    const payloadStr = JSON.stringify(payload);

    for (const sub of subs.rows) {
      const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      webpush.sendNotification(subscription, payloadStr).catch(async (err) => {
        console.error(`[MissedCall] Push to ${sub.endpoint.slice(0, 40)}... failed: ${err.message}`);
        // Remove expired/invalid subscriptions (410 Gone)
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query(
            `DELETE FROM push_subscriptions WHERE endpoint = $1`,
            [sub.endpoint]
          ).catch(() => {});
        }
      });
    }
  } catch (err) {
    console.error('[MissedCall] sendPushNotification error:', err.message);
  }
}

// ─── VAPID key management ─────────────────────────────────────────────────────

async function getOrCreateVapidKey(keyName) {
  try {
    // Check app_settings first
    const existing = await pool.query(
      `SELECT value FROM app_settings WHERE key = $1`,
      [keyName]
    );
    if (existing.rows.length > 0 && existing.rows[0].value) {
      return existing.rows[0].value;
    }

    // Generate both keys atomically if either is missing
    const webpush = require('web-push');
    const { publicKey, privateKey } = webpush.generateVAPIDKeys();

    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('vapid_public_key', $1)
       ON CONFLICT (key) DO NOTHING`,
      [publicKey]
    );
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('vapid_private_key', $1)
       ON CONFLICT (key) DO NOTHING`,
      [privateKey]
    );

    console.log('[MissedCall] Generated new VAPID keys');

    // Return the appropriate key
    return keyName === 'vapid_public_key' ? publicKey : privateKey;
  } catch (err) {
    console.error(`[MissedCall] getOrCreateVapidKey(${keyName}) error:`, err.message);
    return null;
  }
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Process an incoming missed call.
 *
 * @param {string} callerNumber  - E.164 format (From header from Twilio)
 * @param {string} forwardedFrom - E.164 format (ForwardedFrom or diversion header — tradie's number)
 */
async function processMissedCall(callerNumber, forwardedFrom) {
  const caller = normalisePhone(callerNumber);
  const tradie  = await findTradieByPhone(forwardedFrom);

  if (!tradie) {
    // No mapping found — log and bail. The call came in but we can't attribute it.
    console.warn(`[MissedCall] No tradie mapping for ForwardedFrom="${forwardedFrom}" — job not created`);
    return { success: false, reason: 'no_tradie_mapping' };
  }

  console.log(`[MissedCall] Missed call from ${caller} for tradie ${tradie.id} (${tradie.email})`);

  // Generate AI callback message
  const { response: aiResponse, model: aiModel } = await generateCallbackMessage(caller, tradie);

  // Create job
  let job;
  try {
    job = await createMissedCallJob(tradie.id, caller, tradie.business_type, aiResponse, aiModel);
    await logJobActivity(job.id, `Missed call from ${formatPhoneDisplay(caller)}`, {
      caller_number: caller,
      forwarded_from: forwardedFrom,
    });
  } catch (err) {
    console.error('[MissedCall] Job creation error:', err.message);
    return { success: false, reason: 'db_error' };
  }

  const dashUrl = `${APP_URL}/dashboard`;

  // SMS the tradie
  const smsBody = `PropOps: Missed call from ${formatPhoneDisplay(caller)}. Hugo's drafted a callback message — check your dashboard: ${dashUrl}`;
  sendSMS({ to: tradie.mobile_number || forwardedFrom, body: smsBody }).catch((err) => {
    console.error('[MissedCall] SMS notify error:', err.message);
  });

  // PWA push to the tradie
  sendPushNotification(tradie.id, {
    title: `Missed call — ${formatPhoneDisplay(caller)}`,
    body: `Hugo drafted a response. Tap to view in dashboard.`,
    url: dashUrl,
    icon: '/icon-192.svg',
    tag: `missed-call-${job.id}`,
  }).catch((err) => {
    console.error('[MissedCall] Push notify error:', err.message);
  });

  console.log(`[MissedCall] ✅ Job #${job.id} created for tradie ${tradie.id}`);
  return { success: true, jobId: job.id, tradieId: tradie.id };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  processMissedCall,
  normalisePhone,
  getOrCreateVapidKey,
};
