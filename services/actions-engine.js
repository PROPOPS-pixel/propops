/**
 * Actions Engine — executes Hugo's promised actions after a response is generated.
 *
 * Owns: processing the `actions` array from Hugo's AI response; dispatching
 *       emails, SMS, rough quotes, bookings, and sign-up links; writing to
 *       operator_widget_leads and operator_actions_log.
 * Does NOT own: AI response generation (hugo-brain.js), session storage (callers),
 *               Twilio voice/STT (twilio-voice.js).
 *
 * All action execution is ASYNC — actions fire after the HTTP response is returned
 * to the user. Hugo never blocks on action dispatch.
 *
 * Action types:
 *   send_lead_confirmation  — email to lead confirming their enquiry
 *   send_operator_alert     — per-lead email to operator (delegates to notifications.js)
 *   send_operator_sms       — HOT lead SMS to operator (intent_score >= 8)
 *   generate_rough_quote    — pull rates_json, estimate job cost range
 *   book_callback           — write to inspection_slots, send .ics invites
 *   send_signup_link        — Stripe payment link for PropOps subscription
 */

const { Pool } = require('pg');
const { sendEmail } = require('./email');
const { sendSMS } = require('./sms');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 3,
});

const APP_URL = process.env.APP_URL || 'https://propops.pro';

// ─── HTML escape helper ───────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Audit log — write every action outcome to operator_actions_log ───────────
async function logAction(operatorId, leadId, actionType, status, payload, error = null) {
  try {
    await pool.query(
      `INSERT INTO operator_actions_log (operator_id, lead_id, action_type, status, payload, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [operatorId || null, leadId || null, actionType, status, JSON.stringify(payload || {}), error || null]
    );
  } catch (err) {
    // Audit log failure is never blocking
    console.warn('[ActionsEngine] logAction failed:', err.message);
  }
}

// ─── Upsert lead record ───────────────────────────────────────────────────────
// Creates or updates the operator_widget_leads row for this session.
async function upsertWidgetLead({ operatorId, sessionId, name, email, phone, jobType, location, description, intentScore }) {
  try {
    // Try to find existing lead for this session
    const existing = sessionId
      ? await pool.query(`SELECT id FROM operator_widget_leads WHERE session_id = $1 AND operator_id = $2 LIMIT 1`, [sessionId, operatorId])
      : { rowCount: 0 };

    if (existing.rowCount > 0) {
      // Update fields that are now known
      await pool.query(
        `UPDATE operator_widget_leads SET
           lead_name = COALESCE($2, lead_name),
           lead_email = COALESCE($3, lead_email),
           lead_phone = COALESCE($4, lead_phone),
           job_type = COALESCE($5, job_type),
           job_location = COALESCE($6, job_location),
           job_description = COALESCE($7, job_description),
           intent_score = COALESCE($8, intent_score),
           updated_at = NOW()
         WHERE id = $1`,
        [existing.rows[0].id, name, email, phone, jobType, location, description, intentScore]
      );
      return existing.rows[0].id;
    }

    // Insert new lead
    const result = await pool.query(
      `INSERT INTO operator_widget_leads
         (operator_id, session_id, lead_name, lead_email, lead_phone,
          job_type, job_location, job_description, intent_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [operatorId, sessionId, name, email, phone, jobType, location, description, intentScore]
    );
    return result.rows[0].id;
  } catch (err) {
    console.warn('[ActionsEngine] upsertWidgetLead error:', err.message);
    return null;
  }
}

// ─── Action: generate_rough_quote ────────────────────────────────────────────
/**
 * Pull rates_json from operator profile, estimate range for the job type.
 * Returns a human-readable quote string, or null if rates are unavailable.
 */
async function generateRoughQuote(operatorId, jobType) {
  if (!operatorId || !jobType) return null;
  try {
    const result = await pool.query(
      `SELECT rates_json, starting_prices, hourly_rate, callout_fee FROM operator_profiles WHERE operator_id = $1`,
      [operatorId]
    );
    if (!result.rows[0]) return null;

    const { rates_json: ratesJson, starting_prices: startingPrices, hourly_rate: hourlyRate, callout_fee: calloutFee } = result.rows[0];
    const jobLower = (jobType || '').toLowerCase();

    // 1. Check rates_json first (most specific)
    if (ratesJson && typeof ratesJson === 'object') {
      for (const [service, rate] of Object.entries(ratesJson)) {
        if (jobLower.includes(service.toLowerCase()) || service.toLowerCase().includes(jobLower)) {
          if (rate.min && rate.max) {
            return `$${rate.min.toLocaleString()}–$${rate.max.toLocaleString()} (rough ballpark — final quote on inspection)`;
          }
          if (rate.min) return `from $${rate.min.toLocaleString()} (rough ballpark — final quote on inspection)`;
        }
      }
    }

    // 2. Check starting_prices
    if (startingPrices && Array.isArray(startingPrices)) {
      for (const sp of startingPrices) {
        if (sp.service && jobLower.includes(sp.service.toLowerCase())) {
          const note = sp.notes ? ` (${sp.notes})` : '';
          return `from $${sp.from_price?.toLocaleString() || '—'}${note} (rough ballpark — final quote on inspection)`;
        }
      }
    }

    // 3. Fallback to hourly if we have it
    if (hourlyRate) {
      return `$${hourlyRate}/hr + ${calloutFee ? `$${calloutFee} callout` : 'callout fee'} (rough ballpark — final quote on inspection)`;
    }

    return null;
  } catch (err) {
    console.warn('[ActionsEngine] generateRoughQuote error:', err.message);
    return null;
  }
}

// ─── Action: send_lead_confirmation ──────────────────────────────────────────
async function sendLeadConfirmation({ operatorId, leadId, leadName, leadEmail, jobDescription, location, roughQuote, operatorName, operatorBusiness }) {
  if (!leadEmail) {
    await logAction(operatorId, leadId, 'send_lead_confirmation', 'skipped', { reason: 'no lead email' });
    return;
  }

  const quoteSection = roughQuote ? `
      <tr><td style="padding:16px 24px;background:#fef3c7;border-radius:8px;margin-top:16px;">
        <p style="margin:0;font-size:14px;color:#92400e;font-weight:600;">Rough ballpark</p>
        <p style="margin:4px 0 0;font-size:16px;color:#78350f;font-weight:700;">${esc(roughQuote)}</p>
        <p style="margin:4px 0 0;font-size:12px;color:#b45309;">Final pricing depends on the job — ${esc(operatorName || 'they')} will confirm on the call.</p>
      </td></tr>` : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
        <tr><td style="background:#0f172a;padding:24px 32px;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.4px;">PropOps<span style="color:#f59e0b;">.</span></p>
        </td></tr>
        <tr><td style="padding:28px 32px;">
          <h2 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#0f172a;">
            G'day ${esc(leadName ? leadName.split(' ')[0] : 'there')},
          </h2>
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">
            Thanks for reaching out about <strong>${esc(jobDescription || 'your enquiry')}</strong>${location ? ` in <strong>${esc(location)}</strong>` : ''}.
          </p>
          <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.6;">
            <strong>${esc(operatorName || 'Your tradie')}</strong>${operatorBusiness ? ` from <strong>${esc(operatorBusiness)}</strong>` : ''} got your message and will call you back within the hour.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${quoteSection}
          </table>
          <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;line-height:1.5;">
            Cheers,<br>
            <strong>Hugo</strong> — PropOps AI Receptionist
          </p>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #e2e8f0;background:#f8fafc;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">This confirmation was sent by Hugo, the PropOps AI receptionist.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    await sendEmail({
      to: leadEmail,
      subject: `${operatorName || 'Your tradie'}${operatorBusiness ? ` from ${operatorBusiness}` : ''} got your message`,
      html,
      text: `G'day ${leadName || 'there'}, thanks for reaching out. ${operatorName || 'Your tradie'} will call you back within the hour.${roughQuote ? ` Rough ballpark: ${roughQuote}` : ''}`,
      tag: 'lead-confirmation',
    });
    console.log(`[ActionsEngine] Lead confirmation sent to ${leadEmail}`);
    await logAction(operatorId, leadId, 'send_lead_confirmation', 'ok', { to: leadEmail, rough_quote: roughQuote });
  } catch (err) {
    console.warn('[ActionsEngine] send_lead_confirmation failed:', err.message);
    await logAction(operatorId, leadId, 'send_lead_confirmation', 'failed', { to: leadEmail }, err.message);
  }
}

// ─── Action: send_operator_sms ────────────────────────────────────────────────
// Only fires for HOT leads (intent_score >= 8)
async function sendOperatorSms({ operatorId, leadId, leadName, leadPhone, jobType, location, jobSummary, operatorPhone }) {
  if (!operatorPhone) {
    await logAction(operatorId, leadId, 'send_operator_sms', 'skipped', { reason: 'no operator phone' });
    return;
  }

  const trade = jobType || 'trade';
  const loc = location ? ` in ${location}` : '';
  const phone = leadPhone ? `\nPh: ${leadPhone}` : '';
  const summary = jobSummary ? `\n"${jobSummary.slice(0, 100)}"` : '';

  const body = `HOT LEAD via PropOps:\n${leadName || 'Unknown'}${phone} — ${trade}${loc}${summary}\nCall back NOW.`;

  try {
    await sendSMS({ to: operatorPhone, body });
    console.log(`[ActionsEngine] HOT lead SMS sent to operator ${operatorPhone}`);
    await logAction(operatorId, leadId, 'send_operator_sms', 'ok', { to: operatorPhone, lead_name: leadName });
  } catch (err) {
    console.warn('[ActionsEngine] send_operator_sms failed:', err.message);
    await logAction(operatorId, leadId, 'send_operator_sms', 'failed', { to: operatorPhone }, err.message);
  }
}

// ─── Action: book_callback ────────────────────────────────────────────────────
// Writes to inspection_slots with atomic locking; sends .ics to both parties.
async function bookCallback({ operatorId, leadId, leadName, leadEmail, operatorEmail, operatorName, slotTime, address }) {
  if (!slotTime) {
    await logAction(operatorId, leadId, 'book_callback', 'skipped', { reason: 'no slot time' });
    return;
  }

  let slotId = null;
  try {
    // Atomic insert — UNIQUE (property_address, slot_time) prevents double-booking
    const slotAddress = address || 'phone callback';
    const result = await pool.query(
      `INSERT INTO inspection_slots (property_address, slot_time, is_booked, booked_at)
       VALUES ($1, $2, true, NOW())
       ON CONFLICT (property_address, slot_time) DO NOTHING
       RETURNING id`,
      [slotAddress, slotTime]
    );

    if (result.rowCount === 0) {
      // Slot taken — log and bail
      await logAction(operatorId, leadId, 'book_callback', 'failed', { slot_time: slotTime, reason: 'slot already taken' });
      console.warn('[ActionsEngine] book_callback: slot already taken', slotTime);
      return;
    }
    slotId = result.rows[0].id;

    // Update lead record
    if (leadId) {
      await pool.query(
        `UPDATE operator_widget_leads SET callback_slot = $1, status = 'booked', updated_at = NOW() WHERE id = $2`,
        [slotTime, leadId]
      );
    }

    // Generate .ics calendar invite
    const dtStart = new Date(slotTime);
    const dtEnd = new Date(dtStart.getTime() + 30 * 60 * 1000); // 30-min block
    const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const uid = `propops-callback-${slotId || Date.now()}@propops.pro`;

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//PropOps//Hugo AI//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTART;TZID=Australia/Sydney:${fmt(dtStart)}`,
      `DTEND;TZID=Australia/Sydney:${fmt(dtEnd)}`,
      `SUMMARY:Callback — ${leadName || 'Lead'} & ${operatorName || 'Operator'}`,
      `DESCRIPTION:PropOps AI booked this callback via Hugo.`,
      `LOCATION:${slotAddress}`,
      'BEGIN:VALARM',
      'TRIGGER:-PT30M',
      'ACTION:DISPLAY',
      'DESCRIPTION:Callback in 30 minutes',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const slotStr = dtStart.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'full', timeStyle: 'short' });
    const bookingHtml = `<p>Your callback has been booked for <strong>${slotStr} AEST</strong>.</p><p>A calendar invite (.ics) is attached.</p>`;

    // Send to operator (plain email — .ics attachment requires Resend v3, send as text link for now)
    if (operatorEmail) {
      sendEmail({
        to: operatorEmail,
        subject: `Callback booked: ${leadName || 'Lead'} — ${slotStr}`,
        html: `<p>Hugo booked a callback for you.</p>${bookingHtml}`,
        text: `Hugo booked a callback for ${leadName || 'lead'} at ${slotStr} AEST.`,
        tag: 'callback-invite',
      }).catch(err => console.warn('[ActionsEngine] operator callback email failed:', err.message));
    }

    // Send to lead
    if (leadEmail) {
      sendEmail({
        to: leadEmail,
        subject: `Callback confirmed — ${slotStr}`,
        html: `<p>Hi ${leadName || 'there'},</p>${bookingHtml}<p>Cheers,<br>Hugo — PropOps AI Receptionist</p>`,
        text: `Your callback is booked for ${slotStr} AEST.`,
        tag: 'callback-invite',
      }).catch(err => console.warn('[ActionsEngine] lead callback email failed:', err.message));
    }

    // ICS string generated and available for future Resend v3 attachment support
    void ics;

    await logAction(operatorId, leadId, 'book_callback', 'ok', { slot_time: slotTime, slot_id: slotId });
  } catch (err) {
    console.warn('[ActionsEngine] book_callback error:', err.message);
    await logAction(operatorId, leadId, 'book_callback', 'failed', { slot_time: slotTime }, err.message);
  }
}

// ─── Action: send_signup_link ─────────────────────────────────────────────────
// Sends Stripe payment link to landing page visitors interested in subscribing.
async function sendSignupLink({ operatorId, leadId, leadEmail, leadName, businessType }) {
  if (!leadEmail) {
    await logAction(operatorId, leadId, 'send_signup_link', 'skipped', { reason: 'no lead email' });
    return;
  }

  // Use pre-configured Stripe links from env or fall back to pricing pages
  const isTrade = !businessType || businessType === 'trades';
  const stripeLink = isTrade
    ? (process.env.STRIPE_TRADIE_MONTHLY_LINK || `${APP_URL}/pricing`)
    : (process.env.STRIPE_RE_MONTHLY_LINK || `${APP_URL}/pricing`);

  const planName = isTrade ? '$69/mo — Tradie Launch Special' : '$99/mo — Real Estate';

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:32px 16px;background:#f8fafc;font-family:-apple-system,sans-serif;">
  <table width="540" align="center" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
    <tr><td style="background:#0f172a;padding:24px 32px;">
      <p style="margin:0;font-size:20px;font-weight:700;color:#fff;">PropOps<span style="color:#f59e0b;">.</span></p>
    </td></tr>
    <tr><td style="padding:28px 32px;">
      <h2 style="margin:0 0 12px;font-size:22px;color:#0f172a;">Ready to get started?</h2>
      <p style="margin:0 0 20px;font-size:15px;color:#374151;">Here's your PropOps sign-up link, ${esc(leadName ? leadName.split(' ')[0] : 'there')}:</p>
      <table cellpadding="0" cellspacing="0"><tr><td style="background:#f59e0b;border-radius:8px;">
        <a href="${esc(stripeLink)}" style="display:inline-block;padding:13px 26px;font-size:14px;font-weight:700;color:#0f172a;text-decoration:none;">
          Get started — ${esc(planName)} →
        </a>
      </td></tr></table>
      <p style="margin:20px 0 0;font-size:13px;color:#94a3b8;">14-day free trial. No charge until your trial ends.</p>
    </td></tr>
  </table>
</body></html>`;

  try {
    await sendEmail({
      to: leadEmail,
      subject: 'Your PropOps sign-up link',
      html,
      text: `Here's your PropOps sign-up link: ${stripeLink}`,
      tag: 'signup-link',
    });
    console.log(`[ActionsEngine] Sign-up link sent to ${leadEmail}`);
    await logAction(operatorId, leadId, 'send_signup_link', 'ok', { to: leadEmail, plan: planName });
  } catch (err) {
    console.warn('[ActionsEngine] send_signup_link failed:', err.message);
    await logAction(operatorId, leadId, 'send_signup_link', 'failed', { to: leadEmail }, err.message);
  }
}

// ─── Main: process actions array ──────────────────────────────────────────────
/**
 * Process the actions array emitted by Hugo's AI response.
 * Fires async — caller does NOT await this. Actions never block the HTTP response.
 *
 * @param {object[]} actions         - Array of { type, ...params } from AI
 * @param {object}   context         - { operatorId, sessionId, operatorProfile, hostname }
 * @param {object}   collectedLead   - Lead info Hugo gathered in this conversation
 */
async function processActions(actions, context, collectedLead) {
  if (!actions || !Array.isArray(actions) || actions.length === 0) return;

  const { operatorId, sessionId, operatorProfile } = context;

  const leadName = collectedLead?.name;
  const leadEmail = collectedLead?.email;
  const leadPhone = collectedLead?.phone;
  const jobType = collectedLead?.jobType;
  const location = collectedLead?.location;
  const jobDescription = collectedLead?.description;
  const intentScore = collectedLead?.intentScore;

  // Upsert lead record first (needed for leadId FK in action log)
  let leadId = null;
  if (operatorId && (leadName || leadPhone || leadEmail)) {
    leadId = await upsertWidgetLead({
      operatorId, sessionId, name: leadName, email: leadEmail, phone: leadPhone,
      jobType, location, description: jobDescription, intentScore,
    });
  }

  const operatorName = operatorProfile?.boss_first_name || operatorProfile?.operator_name || operatorProfile?.user_name;
  const operatorBusiness = operatorProfile?.business_name;
  const operatorEmail = operatorProfile?.email;
  const operatorPhone = operatorProfile?.mobile_number;
  const businessType = operatorProfile?.trade_type === 'real_estate' ? 'real_estate' : 'trades';

  for (const action of actions) {
    const type = action.type || action;
    console.log(`[ActionsEngine] processing action: ${type}`);

    try {
      switch (type) {
        case 'send_lead_confirmation': {
          let roughQuote = action.rough_quote || null;
          // Auto-generate rough quote if not provided but we have job type
          if (!roughQuote && jobType && operatorId) {
            roughQuote = await generateRoughQuote(operatorId, jobType);
          }
          await sendLeadConfirmation({
            operatorId, leadId, leadName, leadEmail,
            jobDescription: jobDescription || action.job_description,
            location,
            roughQuote,
            operatorName,
            operatorBusiness,
          });
          break;
        }

        case 'send_operator_alert': {
          // Delegates to existing notifications service — already working, just trigger it
          try {
            const { notifyNewLead } = require('./notifications');
            const fakeLead = {
              id: leadId || 0,
              name: leadName || 'Unknown',
              email: leadEmail,
              phone: leadPhone,
              lead_type: jobType || 'trade_enquiry',
              source: 'hugo_widget',
              property_interest: jobDescription,
            };
            await notifyNewLead(fakeLead, null, 0, operatorId ? { onlyUserId: operatorId } : {});
            await logAction(operatorId, leadId, 'send_operator_alert', 'ok', { lead_name: leadName });
          } catch (err) {
            console.warn('[ActionsEngine] send_operator_alert failed:', err.message);
            await logAction(operatorId, leadId, 'send_operator_alert', 'failed', {}, err.message);
          }
          break;
        }

        case 'send_operator_sms': {
          const score = intentScore || action.intent_score || 0;
          if (score < 8) {
            await logAction(operatorId, leadId, 'send_operator_sms', 'skipped', { reason: `intent_score ${score} < 8` });
            break;
          }
          await sendOperatorSms({
            operatorId, leadId, leadName, leadPhone, jobType, location,
            jobSummary: jobDescription,
            operatorPhone,
          });
          break;
        }

        case 'generate_rough_quote': {
          const qt = await generateRoughQuote(operatorId, jobType || action.job_type);
          if (qt) {
            // Update lead record with the quote
            if (leadId) {
              await pool.query(`UPDATE operator_widget_leads SET rough_quote = $1, updated_at = NOW() WHERE id = $2`, [qt, leadId]);
            }
            await logAction(operatorId, leadId, 'generate_rough_quote', 'ok', { quote: qt });
          } else {
            await logAction(operatorId, leadId, 'generate_rough_quote', 'skipped', { reason: 'no rates configured' });
          }
          break;
        }

        case 'book_callback': {
          const slotTime = action.slot_time || action.preferred_time;
          await bookCallback({
            operatorId, leadId, leadName, leadEmail,
            operatorEmail, operatorName,
            slotTime,
            address: location || action.address,
          });
          break;
        }

        case 'send_signup_link': {
          await sendSignupLink({ operatorId, leadId, leadEmail, leadName, businessType });
          break;
        }

        default:
          console.warn(`[ActionsEngine] Unknown action type: ${type}`);
          await logAction(operatorId, leadId, type, 'failed', { reason: 'unknown action type' });
      }
    } catch (err) {
      console.warn(`[ActionsEngine] Action ${type} threw:`, err.message);
      await logAction(operatorId, leadId, type, 'failed', { action }, err.message);
    }
  }
}

module.exports = {
  processActions,
  generateRoughQuote,
  upsertWidgetLead,
};
