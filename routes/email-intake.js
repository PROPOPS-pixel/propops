const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { Pool } = require('pg');
const { parseEmailForLead } = require('../services/email-parser');
const leadsService = require('../services/leads');
const { generateLeadResponse } = require('../services/ai-responder');
const { addListingFromEmail } = require('../services/listings');
const { sendEmail } = require('../services/email');
const { notifyNewLead, sendNewLeadNotificationEmail } = require('../services/notifications');
const { requireAuth } = require('./auth');
const {
  SIMULATE_JOB_TYPES,
  normalizeBusinessType,
  validateLeadMatch,
  logMismatch,
} = require('../services/trade-simulation');
const {
  detectPortalFromSender,
  registerPortalConnection,
  incrementPortalLeadCount,
  sendPortalConnectionConfirmation,
  sendUnrecognisedPortalEmail,
  getOperatorPortalStatuses,
} = require('../services/portal-detection');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Resend API client — used to fetch full inbound email content when the webhook body is empty.

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalise incoming webhook payload from any provider into { subject, body_text, body_html, from_address, to_address }
 * Supports: Resend, Postmark, Mailgun, SendGrid, generic
 */
function normaliseWebhookPayload(body) {
  // ── Resend inbound ─────────────────────────────────────────────────────────
  // Format: { type: "email.received", data: { from, to: [...], subject, text, html } }
  if (body.type === 'email.received' && body.data) {
    const d = body.data;
    const toArr = Array.isArray(d.to) ? d.to : (d.to ? [d.to] : []);
    return {
      subject:      d.subject || '',
      body_text:    d.text || '',
      body_html:    d.html || '',
      from_address: d.from || '',
      to_address:   toArr[0] || '',
      // Include email_id for fetching content later if needed
      email_id:     d.email_id || null,
    };
  }

  // ── Postmark inbound ──────────────────────────────────────────────────────
  if (body.TextBody !== undefined || body.HtmlBody !== undefined) {
    return {
      subject:      body.Subject || '',
      body_text:    body.TextBody || body.StrippedTextReply || '',
      body_html:    body.HtmlBody || '',
      from_address: body.From || (body.FromFull && body.FromFull.Email) || '',
      to_address:   body.To || (Array.isArray(body.ToFull) && body.ToFull[0]?.Email) || '',
    };
  }

  // ── Mailgun inbound ───────────────────────────────────────────────────────
  if (body['body-plain'] !== undefined || body['body-html'] !== undefined) {
    return {
      subject:      body.subject || '',
      body_text:    body['body-plain'] || body['stripped-text'] || '',
      body_html:    body['body-html'] || '',
      from_address: body.sender || body.from || '',
      to_address:   body.recipient || '',
    };
  }

  // ── SendGrid inbound parse (multipart form, forwarded as JSON by middleware) ──
  if (body.text !== undefined || body.html !== undefined) {
    return {
      subject:      body.subject || '',
      body_text:    body.text || '',
      body_html:    body.html || '',
      from_address: body.from || '',
      to_address:   body.to || '',
    };
  }

  // ── Generic/custom format ─────────────────────────────────────────────────
  return {
    subject:      body.subject || body.Subject || '',
    body_text:    body.body_text || body.text || body.TextBody || body.body || '',
    body_html:    body.body_html || body.html || body.HtmlBody || '',
    from_address: body.from_address || body.from || body.From || body.sender || '',
    to_address:   body.to_address || body.to || body.To || '',
  };
}

/**
 * Fetch full email content from Resend **Receiving** API.
 *
 * IMPORTANT: Resend inbound webhooks deliberately exclude the email body,
 * headers, and attachments (only metadata is sent). To get the actual content
 * you must call the RECEIVING endpoint:
 *
 *   GET https://api.resend.com/emails/receiving/{id}
 *
 * This is DIFFERENT from resend.emails.get(id) which only works for SENT
 * emails and returns 404 for inbound email IDs.
 *
 * API key loaded from app_settings.resend_api_key → RESEND_API_KEY env var.
 *
 * @param {string} emailId - email_id from the webhook data payload
 * @returns {{ text: string, html: string, subject: string } | null}
 */
async function fetchResendEmailContent(emailId) {
  if (!emailId) return null;

  // Load API key from app_settings (primary) or env var (fallback)
  let apiKey = null;
  try {
    const result = await pool.query(`SELECT value FROM app_settings WHERE key = 'resend_api_key' LIMIT 1`);
    if (result.rows.length > 0) apiKey = result.rows[0].value || null;
  } catch (dbErr) {
    console.warn('[Email Intake] DB lookup for resend_api_key failed:', dbErr.message);
  }
  if (!apiKey) apiKey = process.env.RESEND_API_KEY || null;

  if (!apiKey) {
    console.error('[Email Intake] Cannot fetch email content: no Resend API key available (check app_settings or RESEND_API_KEY env var)');
    return null;
  }

  // ── Method 1: Try Resend SDK emails.receiving.get() if available ──────────
  try {
    const { Resend } = require('resend');
    const resendClient = new Resend(apiKey);

    if (resendClient.emails && resendClient.emails.receiving && typeof resendClient.emails.receiving.get === 'function') {
      console.log(`[Email Intake] Fetching via SDK emails.receiving.get(${emailId})`);
      const response = await resendClient.emails.receiving.get(emailId);

      if (response.error) {
        console.error(`[Email Intake] Resend SDK receiving error for email_id=${emailId}:`, JSON.stringify(response.error));
        // Fall through to HTTP method below
      } else if (response.data) {
        const text = response.data.text || '';
        const html = response.data.html || '';
        const subject = response.data.subject || '';
        console.log(`[Email Intake] Fetched email body via SDK receiving: text=${text.length} chars, html=${html.length} chars, subject="${subject}"`);
        return { text, html, subject };
      }
    }
  } catch (sdkErr) {
    console.warn(`[Email Intake] SDK receiving.get() failed, falling back to HTTP: ${sdkErr.message}`);
  }

  // ── Method 2: Direct HTTP call to Resend Receiving API ─────────────────────
  // GET https://api.resend.com/emails/receiving/{id}
  // This always works regardless of SDK version.
  try {
    const url = `https://api.resend.com/emails/receiving/${emailId}`;
    console.log(`[Email Intake] Fetching via HTTP: ${url}`);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Email Intake] Resend Receiving API HTTP ${response.status} for email_id=${emailId}: ${errorText}`);
      return null;
    }

    const data = await response.json();
    const text = data.text || '';
    const html = data.html || '';
    const subject = data.subject || '';
    console.log(`[Email Intake] Fetched email body via HTTP: text=${text.length} chars, html=${html.length} chars, subject="${subject}"`);
    return { text, html, subject };

  } catch (httpErr) {
    console.error('[Email Intake] Error fetching Resend email content via HTTP:', httpErr.message);
    return null;
  }
}

/**
 * Check for duplicate lead — same email/phone + same property (within 7 days)
 */
async function isDuplicate(leadData) {
  if (!leadData.email && !leadData.phone) return false;

  const conditions = [];
  const params = [];
  let idx = 1;

  if (leadData.email) {
    conditions.push(`LOWER(email) = LOWER($${idx++})`);
    params.push(leadData.email);
  }
  if (leadData.phone) {
    conditions.push(`REPLACE(REPLACE(phone, ' ', ''), '-', '') = REPLACE(REPLACE($${idx++}, ' ', ''), '-', '')`);
    params.push(leadData.phone);
  }

  const whereClause = conditions.length > 0 ? `(${conditions.join(' OR ')})` : 'FALSE';

  const result = await pool.query(
    `SELECT id FROM leads
     WHERE ${whereClause}
     AND created_at >= NOW() - INTERVAL '7 days'
     ${leadData.property_interest ? `AND property_interest ILIKE $${idx++}` : ''}
     LIMIT 1`,
    leadData.property_interest ? [...params, `%${leadData.property_interest.split(' ').slice(0, 4).join('%')}%`] : params
  );

  return result.rows.length > 0 ? result.rows[0].id : false;
}

/**
 * Verify a Resend/svix webhook signature.
 *
 * Resend signs webhooks using svix (https://svix.com).
 * Algorithm: HMAC-SHA256 over "{svix-id}.{svix-timestamp}.{rawBody}"
 * using the base64-decoded secret (strip "whsec_" prefix first).
 *
 * @param {Buffer|string} rawBody  — raw request body bytes
 * @param {object}        headers  — request headers
 * @param {string}        secret   — RESEND_WEBHOOK_SECRET (whsec_...)
 * @returns {boolean}
 */
function verifySvixSignature(rawBody, headers, secret) {
  const msgId        = headers['svix-id'];
  const msgTimestamp = headers['svix-timestamp'];
  const msgSignature = headers['svix-signature'];

  if (!msgId || !msgTimestamp || !msgSignature) {
    console.warn('[Email Intake] Resend inbound: missing svix headers');
    return false;
  }

  // Reject stale requests (> 5 minutes)
  const now = Math.floor(Date.now() / 1000);
  const ts  = parseInt(msgTimestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > 300) {
    console.warn(`[Email Intake] Resend inbound: timestamp too old/invalid (${ts})`);
    return false;
  }

  // Decode secret — strip "whsec_" prefix then base64-decode
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');

  // Signed content: "{id}.{timestamp}.{body}"
  const bodyStr  = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const toSign   = `${msgId}.${msgTimestamp}.${bodyStr}`;

  const hmac         = crypto.createHmac('sha256', secretBytes);
  const computedSig  = hmac.update(toSign).digest('base64');

  // svix-signature header: space-separated list of "v1,{base64sig}"
  const providedSigs = msgSignature.split(' ').map(s => s.replace(/^v1,/, ''));

  // Constant-time comparison to prevent timing attacks
  return providedSigs.some(sig => {
    try {
      return crypto.timingSafeEqual(
        Buffer.from(computedSig),
        Buffer.from(sig)
      );
    } catch {
      return false;
    }
  });
}

/**
 * Update intake token stats
 */
async function updateTokenStats(token, { leadCreated }) {
  await pool.query(
    `UPDATE intake_tokens
     SET emails_received = emails_received + 1,
         leads_created   = leads_created + $1,
         last_email_at   = NOW()
     WHERE token = $2`,
    [leadCreated ? 1 : 0, token]
  );
}

/**
 * Core email processing pipeline — shared by both inbound-relay and /:token webhook
 *
 * @param {string} token        — validated intake token
 * @param {object} email        — normalised email payload { subject, body_text, body_html, from_address }
 * @param {object} rawPayload   — original request body (for audit trail)
 * @param {object} res          — Express response object
 * @param {number|null} userId  — user_id who owns this token (for multi-tenancy scoping)
 */
async function processInboundEmail(token, email, rawPayload, res, userId = null) {
  // ── Anti-loop filter (CRITICAL — fail-closed) ─────────────────────────────────
  // Loop path: Hugo sends from hugo@propops.pro → Porkbun forwards → Gmail →
  //            propopspro@polsia.app → Hugo reads his own email → replies → ∞
  //
  // Rules (all must pass to process — any match = skip):
  //   1. Sender address is a known Hugo outbound address
  //   2. Sender is on any Hugo-owned domain (*@propops.pro, *@propops.trade, etc.)
  //   3. Email has Resend X-Resend-* headers (sent by our Resend account)
  //
  // On any unexpected error in this block: skip the email (fail-closed, not fail-open).
  try {
    const rawSender = (email.from_address || '').toLowerCase().trim();
    // Strip display name → bare address: "Hugo <hugo@propops.pro>" → "hugo@propops.pro"
    const senderAddr = rawSender.replace(/^.*<([^>]+)>.*$/, '$1').trim();

    const HUGO_OUTBOUND_ADDRS = new Set([
      'hugo@propops.pro', 'noreply@propops.pro', 'no-reply@propops.pro',
      'hugo@propops.trade', 'noreply@propops.trade', 'no-reply@propops.trade',
      'hugo@hugopays.pro', 'noreply@hugopays.pro', 'no-reply@hugopays.pro',
      'hugo@re.propops.pro', 'noreply@re.propops.pro',
    ]);
    const HUGO_OWNED_DOMAINS = ['@propops.pro', '@propops.trade', '@hugopays.pro', '@re.propops.pro'];

    const isLoop = (
      HUGO_OUTBOUND_ADDRS.has(senderAddr) ||
      HUGO_OWNED_DOMAINS.some(d => senderAddr.endsWith(d)) ||
      // Resend X-Resend-* headers present in raw payload headers
      (rawPayload && rawPayload.headers && typeof rawPayload.headers === 'object' &&
        Object.keys(rawPayload.headers).some(k => k.toLowerCase().startsWith('x-resend-')))
    );

    if (isLoop) {
      console.log(`[Email Intake] ⛔ Anti-loop: skipping email from ${email.from_address} (Hugo outbound or Resend header)`);
      return res.status(200).json({ success: true, message: 'Skipped — Hugo outbound address' });
    }
  } catch (antiLoopErr) {
    // Fail-closed: unexpected error → skip to prevent runaway loops
    console.error('[Email Intake] Anti-loop check error — skipping email as precaution:', antiLoopErr.message);
    return res.status(200).json({ success: true, message: 'Skipped — anti-loop check error (fail-closed)' });
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const startTime = Date.now();

  // Per-request notification email cache — lazy-fetched on first lead, reused for subsequent leads
  // Initialised here so the `if (notification_email === undefined)` check below works correctly.
  let notification_email;
  let notification_agent_name;

  console.log(`[Email Intake] Processing email: "${email.subject}" from ${email.from_address} (token: ${token.slice(0, 8)}...)`);

  // Store raw email immediately (audit trail + manual review fallback)
  let rawEmailId;
  try {
    const rawResult = await pool.query(
      `INSERT INTO raw_emails (token, from_address, subject, body_text, body_html, raw_payload, parse_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id`,
      [token, email.from_address, email.subject, email.body_text, email.body_html, rawPayload]
    );
    rawEmailId = rawResult.rows[0].id;
  } catch (dbErr) {
    console.error('[Email Intake] Failed to store raw email:', dbErr.message);
    return res.status(200).json({ success: false, message: 'Database error' });
  }

  // ── Portal auto-detection (zero-config onboarding) ─────────────────────────
  // When an operator forwards an email from a portal, auto-detect the source
  // and register the portal as connected. Fire confirmation email on first connect.
  // This runs non-blocking — the lead pipeline continues regardless of outcome.
  if (userId && !rawPayload?.simulated) {
    (async () => {
      try {
        const detectedPortal = await detectPortalFromSender(email.from_address);

        if (detectedPortal) {
          const { isNew } = await registerPortalConnection(userId, detectedPortal, rawEmailId);
          console.log(`[Portal Detection] ${detectedPortal.portal_name} ${isNew ? 'newly connected' : 'seen again'} for user ${userId}`);

          if (isNew) {
            // Fetch operator email + name to send confirmation
            let operatorEmail = null;
            let operatorName = null;
            try {
              const userRow = await pool.query(`SELECT email, name FROM users WHERE id = $1`, [userId]);
              operatorEmail = userRow.rows[0]?.email || null;
              operatorName = userRow.rows[0]?.name || null;
            } catch (_) {}
            // Determine if the email also has a real lead (confidence check after parse)
            // We send confirmation now; lead status is enriched by the pipeline below.
            await sendPortalConnectionConfirmation(operatorEmail, operatorName, detectedPortal.portal_name, false);
          }
        } else {
          // Email arrived at our intake address but sender isn't a known portal.
          // Likely an operator forwarding from an unrecognised source — notify them.
          // Only do this if the email looks like a portal forward (not a personal email).
          const isLikelyPortalForward = (email.from_address || '').includes('@')
            && !/^\s*(hi|hello|hey)\s/i.test(email.subject || '')
            && !/^re:/i.test(email.subject || '');

          if (isLikelyPortalForward) {
            let operatorEmail = null;
            let operatorName = null;
            try {
              const userRow = await pool.query(`SELECT email, name FROM users WHERE id = $1`, [userId]);
              operatorEmail = userRow.rows[0]?.email || null;
              operatorName = userRow.rows[0]?.name || null;
            } catch (_) {}
            const fromDomain = (email.from_address || '').replace(/^[^@]+@/, '').replace(/>.*/, '').trim();
            await sendUnrecognisedPortalEmail(operatorEmail, operatorName, fromDomain);
          }
        }
      } catch (err) {
        console.warn('[Portal Detection] Auto-detection error (non-fatal):', err.message);
      }
    })();
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Parse the email
  let parseResult;
  try {
    parseResult = await parseEmailForLead(email);
    console.log(`[Email Intake] Parse result: method=${parseResult.parseMethod}, confidence=${parseResult.confidence}/10, source=${parseResult.source}, hasData=${parseResult.hasMinimumData}`);
  } catch (parseErr) {
    console.error('[Email Intake] Parse error:', parseErr.message);
    await pool.query(
      `UPDATE raw_emails SET parse_status = 'failed', parse_error = $1 WHERE id = $2`,
      [parseErr.message, rawEmailId]
    );
    await updateTokenStats(token, { leadCreated: false });
    return res.status(200).json({ success: false, message: 'Parse error', rawEmailId });
  }

  // Mark as failed if we couldn't extract minimum data
  if (!parseResult.hasMinimumData || !parseResult.lead) {
    console.warn(`[Email Intake] Could not extract minimum lead data (name + email/phone). Stored for manual review.`);
    await pool.query(
      `UPDATE raw_emails SET parse_status = 'failed', parse_error = $1, source_detected = $2 WHERE id = $3`,
      [`Insufficient data: score ${parseResult.confidence}/10, method=${parseResult.parseMethod}`, parseResult.source, rawEmailId]
    );
    await updateTokenStats(token, { leadCreated: false });
    return res.status(200).json({
      success: false,
      message: 'Could not extract lead data — stored for manual review',
      rawEmailId,
      parseResult: { confidence: parseResult.confidence, source: parseResult.source, extracted: parseResult.rawExtracted }
    });
  }

  // Duplicate check
  const duplicateId = await isDuplicate(parseResult.lead);
  if (duplicateId) {
    console.log(`[Email Intake] Duplicate lead detected (existing lead #${duplicateId})`);
    await pool.query(
      `UPDATE raw_emails SET parse_status = 'duplicate', parsed_lead_id = $1, source_detected = $2 WHERE id = $3`,
      [duplicateId, parseResult.source, rawEmailId]
    );
    await updateTokenStats(token, { leadCreated: false });
    return res.status(200).json({
      success: true,
      message: 'Duplicate lead — existing lead already exists',
      existingLeadId: duplicateId,
      rawEmailId
    });
  }

  // Create lead
  let lead;
  try {
    // Add is_simulated flag to metadata if this is a simulated test email
    const leadData = { ...parseResult.lead };
    if (rawPayload && rawPayload.simulated) {
      leadData.metadata = { ...(leadData.metadata || {}), is_simulated: true };
      console.log(`[Email Intake] 🧪 Marking lead as simulated`);
    }
    // Attach user_id for multi-tenancy scoping
    leadData.user_id = userId || null;
    lead = await leadsService.createLead(leadData);
    console.log(`[Email Intake] Created lead #${lead.id}: ${lead.name} (${lead.email || lead.phone}) from ${lead.source} [user_id=${userId || 'unscoped'}]`);

    // Auto-populate listings pool from this email (non-blocking, never throws into main flow)
    if (lead.property_listing_url) {
      addListingFromEmail(lead, rawEmailId, email.body_text || '', userId || null, email.subject || '').catch(err => {
        console.error('[Email Intake] Listing auto-collect error:', err.message);
      });
    }

    // Increment portal lead counter for analytics (non-blocking)
    if (userId && !rawPayload?.simulated && email.from_address) {
      detectPortalFromSender(email.from_address).then(portal => {
        if (portal) incrementPortalLeadCount(userId, portal.portal_key);
      }).catch(() => {});
    }

    await leadsService.logActivity(lead.id, 'lead_created', `New lead from ${lead.source} (email intake)`, {
      source: lead.source,
      parseMethod: parseResult.parseMethod,
      confidence: parseResult.confidence,
      rawEmailId
    });

    // Link raw email to lead
    await pool.query(
      `UPDATE raw_emails SET parse_status = 'success', parsed_lead_id = $1, source_detected = $2 WHERE id = $3`,
      [lead.id, parseResult.source, rawEmailId]
    );

  } catch (createErr) {
    console.error('[Email Intake] Failed to create lead:', createErr.message);
    await pool.query(
      `UPDATE raw_emails SET parse_status = 'failed', parse_error = $1 WHERE id = $2`,
      [createErr.message, rawEmailId]
    );
    await updateTokenStats(token, { leadCreated: false });
    return res.status(200).json({ success: false, message: 'Failed to create lead', rawEmailId });
  }

  // Fire AI response and send email to the lead
  let aiResponse = null;
  let emailSent = false;
  try {
    const ai = await generateLeadResponse(lead);
    aiResponse = await leadsService.saveLeadResponse(lead.id, {
      response_text: ai.responseText,
      response_type: 'initial',
      channel: 'email',
      ai_model: ai.model,
      ai_cost_usd: ai.costUsd
    });

    // Actually send the email to the lead
    const emailResult = await leadsService.sendResponseToLead(lead, aiResponse);
    emailSent = emailResult.ok || false;

    await leadsService.updateLeadStatus(lead.id, 'contacted');
    await leadsService.logActivity(lead.id, 'ai_response_generated',
      emailSent
        ? `AI response generated and sent via ${emailResult.provider} (${ai.model})`
        : `AI response generated but email failed: ${emailResult.reason || 'unknown'} (${ai.model})`,
      {
        model: ai.model,
        cost_usd: ai.costUsd,
        tokens: ai.tokens,
        email_sent: emailSent,
        email_provider: emailResult.provider || null,
      }
    );
    console.log(`[Email Intake] AI response generated for lead #${lead.id} in ${Date.now() - startTime}ms (email_sent: ${emailSent})`);
  } catch (aiErr) {
    console.error('[Email Intake] AI response failed:', aiErr.message);
    await leadsService.logActivity(lead.id, 'ai_response_failed', `AI response failed: ${aiErr.message}`);
  }

  // Fire SMS + email notifications to the agent — non-blocking, always runs after lead creation.
  // Intentionally outside the AI try/catch so notifications fire even when AI response fails.
  // For simulated leads: only notify the triggering agent (not all users).
  // For real leads: notify all subscribed users.
  {
    const isSimulated = rawPayload && rawPayload.simulated;
    const responseTimeSec = (Date.now() - startTime) / 1000;
    if (isSimulated) {
      console.log(`[Email Intake] 🧪 Simulated lead #${lead.id} — sending notifications only to triggering agent (user_id=${userId})`);
      notifyNewLead(lead, aiResponse, responseTimeSec, { onlyUserId: userId }).catch((err) => {
        console.error('[Email Intake] Notification dispatch error:', err.message);
      });
    } else {
      notifyNewLead(lead, aiResponse, responseTimeSec).catch((err) => {
        console.error('[Email Intake] Notification dispatch error:', err.message);
      });
    }

    // Fire notification email to agent's dedicated Gmail address — non-blocking.
    // Only fires if the agent set a notification_email different from their account email
    // (avoids duplicates — notifyNewLead already sends to the account email).
    if (userId && notification_email === undefined) {
      try {
        const notifRow = await pool.query(
          `SELECT notification_email, email, name FROM users WHERE id = $1`,
          [userId]
        );
        if (notifRow.rows[0]) {
          const rawNotifEmail = (notifRow.rows[0].notification_email || '').trim().toLowerCase();
          const accountEmail = (notifRow.rows[0].email || '').trim().toLowerCase();
          notification_email = (rawNotifEmail && rawNotifEmail !== accountEmail) ? notifRow.rows[0].notification_email : null;
          notification_agent_name = notifRow.rows[0].name || null;
          if (rawNotifEmail && rawNotifEmail === accountEmail) {
            console.log(`[Email Intake] notification_email matches account email — skipping to avoid duplicate`);
          }
        }
      } catch (lookupErr) {
        console.warn('[Email Intake] Failed to look up notification email for user:', lookupErr.message);
      }
    }
    if (notification_email) {
      sendNewLeadNotificationEmail(lead, aiResponse, responseTimeSec, notification_email, notification_agent_name).catch((err) => {
        console.error('[Email Intake] Notification email error:', err.message);
      });
    }
  }

  await updateTokenStats(token, { leadCreated: true });

  const duration = Date.now() - startTime;
  console.log(`[Email Intake] ✓ Complete — lead #${lead.id} created in ${duration}ms`);

  return res.status(200).json({
    success: true,
    message: emailSent ? 'Lead created and AI response emailed' : 'Lead created and AI response generated',
    lead: { id: lead.id, name: lead.name, source: lead.source },
    hasAiResponse: !!aiResponse,
    emailSent,
    processingMs: duration
  });
}

// ─── Routes ────────────────────────────────────────────────────────────────────
// IMPORTANT: Named/static routes MUST come before the dynamic /:token handler
// to prevent Express routing ambiguity.

/**
 * GET /api/email-intake/integration-status
 *
 * Returns Gmail + lead portal connection status for the operator.
 *
 * Gmail "connected" = intake has received at least 1 email in the last 30 days.
 * Portal "connected" = we've received an email from that portal's sender domain
 *                      OR a lead with that source was created via the intake pipeline.
 *
 * This is intentionally lightweight — no OAuth, no external API calls.
 * Status is derived from raw_emails + leads already in the DB.
 */
router.get('/integration-status', requireAuth, async (req, res) => {
  try {
    // Get user's active intake token
    const tokenRow = await pool.query(
      `SELECT token, forwarding_email, emails_received, last_email_at FROM intake_tokens
       WHERE is_active = true AND user_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [req.userId]
    );

    // Gmail is "connected" (Manual Forwarding) if intake has ever received at least 1 email.
    // No recency gate — emails received = forwarding was set up and working.
    const token = tokenRow.rows[0] || null;
    const gmailConnected = token && token.emails_received > 0;

    // Portal statuses — use service (reads from operator_portal_connections + raw_emails fallback)
    const portalStatuses = await getOperatorPortalStatuses(req.userId, token?.token || null);

    res.json({
      success: true,
      gmail: {
        connected: !!gmailConnected,
        label: gmailConnected ? 'Manual Forwarding' : null,
        emails_received: token?.emails_received || 0,
        last_email_at: token?.last_email_at || null,
      },
      portals: portalStatuses,
      forwarding_email: token ? (token.forwarding_email || null) : null,
    });
  } catch (err) {
    console.error('[Email Intake] Integration status error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load integration status' });
  }
});

/**
 * GET /api/email-intake/setup
 * Returns setup info — the active intake token and the unique forwarding email address
 */
router.get('/setup', requireAuth, async (req, res) => {
  try {
    // Strictly scope by user_id — no fallback to shared/NULL tokens
    let result = await pool.query(
      `SELECT token, label, forwarding_email, emails_received, leads_created, last_email_at, created_at
       FROM intake_tokens
       WHERE is_active = true AND user_id = $1
       ORDER BY created_at ASC
       LIMIT 1`,
      [req.userId]
    );

    // Auto-provision a token for this user if they don't have one
    if (result.rows.length === 0) {
      const crypto = require('crypto');
      const newToken = crypto.randomBytes(16).toString('hex');
      const inboundDomain = process.env.INBOUND_EMAIL_DOMAIN || 'propops.pro';
      const newForwardingEmail = `leads-${newToken}@${inboundDomain}`;
      result = await pool.query(
        `INSERT INTO intake_tokens (token, label, forwarding_email, user_id)
         VALUES ($1, 'Main Intake', $2, $3)
         RETURNING token, label, forwarding_email, emails_received, leads_created, last_email_at, created_at`,
        [newToken, newForwardingEmail, req.userId]
      );
      console.log(`[Email Intake] Auto-provisioned intake token for user ${req.userId}: ${newForwardingEmail}`);
    }

    const row = result.rows[0];
    const { token } = row;
    const baseUrl = process.env.APP_URL || 'https://propops.pro';
    const inboundDomain = process.env.INBOUND_EMAIL_DOMAIN || 'propops.pro';
    const webhookUrl = `${baseUrl}/api/email-intake/${token}`;

    // Derive forwarding email if not yet stored in DB (migration may not have run yet)
    const forwardingEmail = row.forwarding_email || `leads-${token}@${inboundDomain}`;

    res.json({
      success: true,
      ...row,
      forwardingEmail,
      webhookUrl, // kept for backwards-compat (hidden from UI but still works)
      setup: {
        simple: {
          step1: 'In Gmail → Settings → See all settings → Forwarding and POP/IMAP',
          step2: `Add forwarding address: ${forwardingEmail}`,
          step3: 'Create a filter: From "enquiry@realestate.com.au OR noreply@domain.com.au" → Forward to this address'
        }
      }
    });
  } catch (err) {
    console.error('[Email Intake] Setup endpoint error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load setup info' });
  }
});

/**
 * GET /api/email-intake/raw-emails
 * List recent raw emails for review (useful for debugging/manual review of failed parses)
 */
router.get('/raw-emails', requireAuth, async (req, res) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    const conditions = status ? [`parse_status = $1`] : [];
    const params = status ? [status, parseInt(limit), parseInt(offset)] : [parseInt(limit), parseInt(offset)];

    const result = await pool.query(
      `SELECT id, token, from_address, subject, parse_status, source_detected,
              parsed_lead_id, parse_error, received_at
       FROM raw_emails
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY received_at DESC
       LIMIT $${status ? 2 : 1} OFFSET $${status ? 3 : 2}`,
      params
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM raw_emails ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}`,
      status ? [status] : []
    );

    res.json({
      success: true,
      emails: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (err) {
    console.error('[Email Intake] Raw emails error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch raw emails' });
  }
});

/**
 * POST /api/email-intake/regenerate-token
 * Generate a new intake token (rotates the existing one)
 */
router.post('/regenerate-token', requireAuth, async (req, res) => {
  try {
    const crypto = require('crypto');
    const newToken = crypto.randomBytes(16).toString('hex');
    const inboundDomain = process.env.INBOUND_EMAIL_DOMAIN || 'propops.pro';
    const forwardingEmail = `leads-${newToken}@${inboundDomain}`;

    // Deactivate old tokens for this user only (leave other users' tokens alone)
    await pool.query(
      `UPDATE intake_tokens SET is_active = false WHERE user_id = $1 OR user_id IS NULL`,
      [req.userId]
    );

    // Create new token with forwarding email and user_id
    await pool.query(
      `INSERT INTO intake_tokens (token, label, forwarding_email, user_id) VALUES ($1, 'Main Intake', $2, $3)`,
      [newToken, forwardingEmail, req.userId]
    );

    const baseUrl = process.env.APP_URL || 'https://propops.pro';
    res.json({
      success: true,
      token: newToken,
      forwardingEmail,
      webhookUrl: `${baseUrl}/api/email-intake/${newToken}`, // kept for backwards-compat
      message: 'New forwarding address generated — update your Gmail forwarding rule'
    });
  } catch (err) {
    console.error('[Email Intake] Regenerate token error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to generate token' });
  }
});

/**
 * POST /api/email-intake/inbound-relay
 *
 * Native inbound email receiver — called by our email provider (Postmark/Mailgun) when
 * a message arrives at leads-{token}@propops.pro.
 *
 * This eliminates the need for agents to create their own Postmark accounts.
 * They just add one Gmail forwarding rule → leads-{token}@propops.pro → done.
 *
 * Setup (one-time, managed by us):
 *   - Postmark: Add inbound domain "propops.pro", set webhook to /api/email-intake/inbound-relay
 *   - DNS: Add MX record → inbound.postmarkapp.com (or equivalent for Mailgun/Cloudflare)
 *
 * Security: An optional INBOUND_RELAY_SECRET env var restricts access to our provider only.
 *
 * Compatible with: Postmark, Mailgun, SendGrid, any provider that POSTs JSON/form-data
 */
router.post('/inbound-relay', async (req, res) => {
  // Optional: verify shared secret set by the email provider (e.g. Postmark custom header)
  const relaySecret = process.env.INBOUND_RELAY_SECRET;
  if (relaySecret) {
    const providedSecret =
      req.headers['x-relay-secret'] ||
      req.headers['x-postmark-inbound-secret'] ||
      req.query.secret;
    if (providedSecret !== relaySecret) {
      console.warn('[Email Intake] Inbound relay: invalid secret');
      return res.status(200).json({ success: false, message: 'Invalid relay secret' });
    }
  }

  // Normalise the payload
  const email = normaliseWebhookPayload(req.body);
  const toAddress = email.to_address || '';

  console.log(`[Email Intake] Inbound relay received: "${email.subject}" to ${toAddress}`);

  // ── support@ forwarding ────────────────────────────────────────────────────
  // Emails to support@propops.pro are forwarded to owner's Gmail.
  // NOTE: This only runs if MX records route to our inbound relay (Postmark/Mailgun).
  // If MX → Porkbun, forwarding must be configured in Porkbun dashboard instead.
  const SUPPORT_FORWARD_TO = ['gassin123@gmail.com'];
  if (/^support@/i.test(toAddress)) {
    console.log(`[Email Intake] support@ address detected — forwarding to ${SUPPORT_FORWARD_TO.join(', ')}`);
    const fromLine = email.from_address ? `From: ${email.from_address}` : '';
    const subjectLine = email.subject ? `Subject: ${email.subject}` : '';

    const forwardedText = [
      `---------- Forwarded message ----------`,
      fromLine,
      subjectLine,
      `To: ${toAddress}`,
      '',
      email.body_text || email.body_html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '(no body)',
    ].filter(Boolean).join('\n');

    const forwardedHtml = `
<div style="font-family:sans-serif;color:#1a1a1a;max-width:600px;">
  <p style="background:#f3f4f6;border-left:4px solid #6b7280;padding:10px 14px;font-size:13px;color:#374151;border-radius:2px;">
    <strong>Forwarded from support@propops.pro</strong><br>
    <strong>From:</strong> ${email.from_address || '(unknown)'}<br>
    <strong>Subject:</strong> ${email.subject || '(no subject)'}
  </p>
  <div style="padding:8px 0;">
    ${email.body_html || `<pre style="font-size:13px;white-space:pre-wrap;">${(email.body_text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`}
  </div>
</div>`.trim();

    // Forward to ALL configured addresses in parallel
    const forwardResults = await Promise.allSettled(
      SUPPORT_FORWARD_TO.map(recipient =>
        sendEmail({
          to: recipient,
          subject: `[PropOps Support] ${email.subject || '(no subject)'}`,
          html: forwardedHtml,
          text: forwardedText,
          tag: 'transactional',
          reply_to: email.from_address || undefined,
        })
      )
    );

    forwardResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        console.log(`[Email Intake] support@ forward to ${SUPPORT_FORWARD_TO[i]}: ok=${result.value.ok}, provider=${result.value.provider || 'unknown'}`);
      } else {
        console.error(`[Email Intake] support@ forward to ${SUPPORT_FORWARD_TO[i]} failed:`, result.reason?.message || result.reason);
      }
    });

    // Always return 200 so Postmark doesn't retry
    return res.status(200).json({ success: true, message: 'Forwarded to support inboxes' });
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Extract token from to_address — format: leads-{token}@{domain}
  // e.g. "leads-abc123def456@propops.pro" → token = "abc123def456"
  const toMatch = toAddress.match(/^leads-([a-f0-9]{24,64})@/i);
  if (!toMatch) {
    console.warn(`[Email Intake] Inbound relay: unrecognised to_address format: ${toAddress}`);
    // Return 200 so the provider doesn't retry indefinitely
    return res.status(200).json({ success: false, message: 'No matching token in to_address' });
  }

  const derivedToken = toMatch[1];

  // Validate token exists and is active — also get user_id for multi-tenancy
  const tokenRow = await pool.query(
    `SELECT token, user_id FROM intake_tokens WHERE token = $1 AND is_active = true`,
    [derivedToken]
  );

  if (tokenRow.rows.length === 0) {
    console.warn(`[Email Intake] Inbound relay: no active token for address ${toAddress}`);
    return res.status(200).json({ success: false, message: 'No active token for this address' });
  }

  const tokenUserId = tokenRow.rows[0].user_id || null;

  // Hand off to the shared processing pipeline
  return processInboundEmail(derivedToken, email, req.body, res, tokenUserId);
});

/**
 * POST /api/email-intake/simulate
 * Fire a trade-specific simulated inquiry email through the pipeline for Hugo training.
 * Accepts body: { business_type?: string, source?: string }
 * - business_type: operator's trade (plumber, bricklayer, etc.). Defaults to user's DB business_type.
 * - source: optional portal source override (hipages, ServiceSeeking, etc.)
 */
router.post('/simulate', requireAuth, async (req, res) => {
  try {
    // Get user's business_type from DB if not provided in body, then normalize
    let rawBt = req.body && req.body.business_type;
    if (!rawBt) {
      const userRow = await pool.query('SELECT business_type FROM users WHERE id = $1', [req.userId]);
      rawBt = userRow.rows[0]?.business_type || 'plumber';
    }
    const bt = normalizeBusinessType(rawBt);
    console.log(`[Email Intake] Simulate: raw_business_type='${rawBt}', normalized='${bt}'`);

    // Get active token for this user (fall back to any active token for legacy data)
    const tokenRow = await pool.query(
      `SELECT token, user_id FROM intake_tokens
       WHERE is_active = true AND (user_id = $1 OR user_id IS NULL)
       ORDER BY CASE WHEN user_id = $1 THEN 0 ELSE 1 END, created_at ASC LIMIT 1`,
      [req.userId]
    );
    if (tokenRow.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'No active intake token. Set up email intake first.' });
    }
    const token = tokenRow.rows[0].token;
    const tokenUserId = tokenRow.rows[0].user_id || req.userId || null;

    // ── Branch: RE agents get portal-format emails; trades get trade-format ──
    const isRealEstate = bt === 'real_estate' || bt === 're_agent';

    if (isRealEstate) {
      // RE mode: generate a portal-format inquiry (REA, Domain, Homely, etc.)
      const rePortals = ['rea', 'domain', 'homely', 'rent', 'facebook', 'generic'];
      let source = req.body && req.body.source ? req.body.source : null;
      // If source is 'random' or not provided, pick a random RE portal
      if (!source || source === 'random') {
        source = rePortals[Math.floor(Math.random() * rePortals.length)];
      }
      const fakeEmail = generateFakeInquiry(source);
      console.log(`[Email Intake] 🧪 Simulating RE portal inquiry: source='${source}'`);

      return processInboundEmail(token, fakeEmail, { simulated: true, source, business_type: bt, ...fakeEmail }, res, tokenUserId);
    }

    // Determine source portal first so we can pick the right email format
    const portals = ['hipages', 'ServiceSeeking', 'airtasker', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral'];
    const source = req.body && req.body.source ? req.body.source : portals[Math.floor(Math.random() * portals.length)];

    // Trade mode: generate a trade-specific inquiry email
    // For Hipages/ServiceSeeking/Airtasker, generate a portal-specific format so
    // the parser correctly identifies the source and marks the portal as Connected.
    const srcLower = (source || '').toLowerCase();
    let fakeEmail;
    if (srcLower === 'hipages') {
      fakeEmail = generateHipagesFakeEmail(bt);
    } else if (srcLower === 'serviceseeking') {
      fakeEmail = generateServiceSeekingFakeEmail(bt);
    } else if (srcLower === 'airtasker') {
      fakeEmail = generateAirtaskerFakeEmail(bt);
    } else {
      fakeEmail = generateTradeFakeEmail(bt);
    }

    // ── Validation gate: ensure job type matches target trade pool ───────────
    const jobTypes = SIMULATE_JOB_TYPES[bt] || SIMULATE_JOB_TYPES['handyman'];
    const validation = validateLeadMatch(bt, fakeEmail.job_type);
    if (!validation.valid) {
      logMismatch(bt, fakeEmail.job_type, validation.reason, source);
      return res.status(400).json({
        success: false,
        message: 'Lead rejected: job type does not match trade pool',
        detail: validation.reason,
      });
    }
    console.log(`[Email Intake] 🧪 Simulating trade-matched inquiry: bt=${bt}, job_type='${fakeEmail.job_type}', source='${source}'`);

    // Process through the same pipeline as real emails
    return processInboundEmail(token, fakeEmail, { simulated: true, source, business_type: bt, ...fakeEmail }, res, tokenUserId);
  } catch (err) {
    console.error('[Email Intake] Simulate error:', err.message);
    res.status(500).json({ success: false, message: 'Simulation failed: ' + err.message });
  }
});

// ─── Shared helpers for portal fake email generators ──────────────────────────

function _tradeLeadData(businessType) {
  // normalizeBusinessType + SIMULATE_JOB_TYPES are imported at the top of this file
  const bt = normalizeBusinessType(businessType);
  const jobTypes = SIMULATE_JOB_TYPES[bt] || SIMULATE_JOB_TYPES['handyman'];
  const jobType = jobTypes[Math.floor(Math.random() * jobTypes.length)];
  const firstNames = ['James', 'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'William', 'Sophia', 'Benjamin', 'Isabella', 'Lucas', 'Mia'];
  const lastNames = ['Smith', 'Jones', 'Williams', 'Taylor', 'Brown', 'Wilson', 'Evans', 'Thomas', 'Roberts', 'Johnson'];
  const emailDomains = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com.au', 'icloud.com'];
  const suburbs = [
    { suburb: 'Surry Hills', state: 'NSW', postcode: '2010' },
    { suburb: 'Bondi', state: 'NSW', postcode: '2026' },
    { suburb: 'Newtown', state: 'NSW', postcode: '2042' },
    { suburb: 'Manly', state: 'NSW', postcode: '2095' },
    { suburb: 'Parramatta', state: 'NSW', postcode: '2150' },
    { suburb: 'St Kilda', state: 'VIC', postcode: '3182' },
    { suburb: 'Richmond', state: 'VIC', postcode: '3121' },
    { suburb: 'New Farm', state: 'QLD', postcode: '4005' },
    { suburb: 'Subiaco', state: 'WA', postcode: '6008' },
  ];
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const firstName = pick(firstNames);
  const lastName = pick(lastNames);
  const location = pick(suburbs);
  return {
    bt, jobType,
    name: firstName + ' ' + lastName,
    email: firstName.toLowerCase() + '.' + lastName.toLowerCase() + randInt(1, 99) + '@' + pick(emailDomains),
    phone: `04${randInt(10, 99)} ${randInt(100, 999)} ${randInt(100, 999)}`,
    suburb: location.suburb, state: location.state, postcode: location.postcode,
  };
}

/**
 * Generate a realistic Hipages lead notification email.
 * From: leads@hipages.com.au
 */
function generateHipagesFakeEmail(businessType) {
  const d = _tradeLeadData(businessType);
  const subject = `New Job Lead: ${d.jobType} — ${d.suburb} ${d.state}`;
  const bodyText = `New job lead from hipages.com.au

Customer name: ${d.name}
Phone: ${d.phone}
Email: ${d.email}
Suburb: ${d.suburb} ${d.state} ${d.postcode}

Job description: ${d.jobType}

Message:
Hi, I need ${d.jobType.toLowerCase()} done at my place in ${d.suburb}. Can you come out and have a look?

---
This enquiry was sent via hipages.com.au
To view and respond to this lead, visit: https://hipages.com.au/connect/jobs`;

  return {
    subject,
    body_text: bodyText,
    body_html: `<html><body><h2>New Job Lead — ${d.jobType}</h2>
<p><strong>Customer name:</strong> ${d.name}<br>
<strong>Phone:</strong> ${d.phone}<br>
<strong>Email:</strong> ${d.email}<br>
<strong>Suburb:</strong> ${d.suburb} ${d.state} ${d.postcode}</p>
<p><strong>Job description:</strong> ${d.jobType}</p>
<hr><p style="color:#999;font-size:12px">This enquiry was sent via hipages.com.au</p></body></html>`,
    from_address: 'leads@hipages.com.au',
    to_address: `leads-${Date.now()}@propops.pro`,
    job_type: d.jobType,
  };
}

/**
 * Generate a realistic ServiceSeeking lead notification email.
 * From: noreply@serviceseeking.com.au
 */
function generateServiceSeekingFakeEmail(businessType) {
  const d = _tradeLeadData(businessType);
  const subject = `New job — ${d.jobType} — ${d.suburb} ${d.state}`;
  const bodyText = `You have a new lead on ServiceSeeking.com.au!

Customer: ${d.name}
Phone: ${d.phone}
Email: ${d.email}
Location: ${d.suburb} ${d.state} ${d.postcode}

Service required: ${d.jobType}

Details:
G'day, I need ${d.jobType.toLowerCase()} in ${d.suburb}. Looking for a good trade, can you send a quote?

---
serviceseeking.com.au — Australia's trusted trade marketplace`;

  return {
    subject,
    body_text: bodyText,
    body_html: `<html><body><h2>New Lead — ${d.jobType}</h2>
<p><strong>Customer:</strong> ${d.name}<br>
<strong>Phone:</strong> ${d.phone}<br>
<strong>Email:</strong> ${d.email}<br>
<strong>Location:</strong> ${d.suburb} ${d.state} ${d.postcode}</p>
<p><strong>Service required:</strong> ${d.jobType}</p>
<hr><p style="color:#999;font-size:12px">serviceseeking.com.au</p></body></html>`,
    from_address: 'noreply@serviceseeking.com.au',
    to_address: `leads-${Date.now()}@propops.pro`,
    job_type: d.jobType,
  };
}

/**
 * Generate a realistic Airtasker lead notification email.
 * From: noreply@airtasker.com
 */
function generateAirtaskerFakeEmail(businessType) {
  const d = _tradeLeadData(businessType);
  const budgets = ['$50-$150', '$150-$300', '$300-$500', '$500-$1,000', 'Open to offers'];
  const budget = budgets[Math.floor(Math.random() * budgets.length)];
  const subject = `New task posted: ${d.jobType} — ${d.suburb}`;
  const bodyText = `A new task has been posted on Airtasker that matches your skills.

Poster: ${d.name}
Location: ${d.suburb} ${d.state} ${d.postcode}

Task: ${d.jobType}

Description:
Hi there, I need ${d.jobType.toLowerCase()} done in ${d.suburb}. Happy to discuss details and timing. Thanks!

Budget: ${budget}

---
airtasker.com — Get it done`;

  return {
    subject,
    body_text: bodyText,
    body_html: `<html><body><h2>New Airtasker Task: ${d.jobType}</h2>
<p><strong>Poster:</strong> ${d.name}<br>
<strong>Location:</strong> ${d.suburb} ${d.state} ${d.postcode}<br>
<strong>Budget:</strong> ${budget}</p>
<p><strong>Task:</strong> ${d.jobType}</p>
<hr><p style="color:#999;font-size:12px">airtasker.com</p></body></html>`,
    from_address: 'noreply@airtasker.com',
    to_address: `leads-${Date.now()}@propops.pro`,
    job_type: d.jobType,
  };
}

/**
 * Generate a trade-specific inquiry email for Hugo training simulations.
 * Returns a formatted email object compatible with processInboundEmail pipeline.
 * Includes job_type for validation gate checking.
 */
function generateTradeFakeEmail(businessType) {
  const bt = normalizeBusinessType(businessType);
  const jobTypes = SIMULATE_JOB_TYPES[bt] || SIMULATE_JOB_TYPES['handyman'];
  const jobType = jobTypes[Math.floor(Math.random() * jobTypes.length)];

  const firstNames = ['James', 'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'William', 'Sophia',
    'Benjamin', 'Isabella', 'Lucas', 'Mia', 'Henry', 'Charlotte', 'Alexander', 'Amelia'];
  const lastNames = ['Smith', 'Jones', 'Williams', 'Taylor', 'Brown', 'Wilson', 'Evans',
    'Thomas', 'Roberts', 'Johnson', 'White', 'Harris', 'Martin', 'Thompson', 'Garcia'];
  const emailDomains = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com.au', 'icloud.com'];
  const suburbData = [
    { suburb: 'Surry Hills', state: 'NSW', postcode: '2010' },
    { suburb: 'Bondi', state: 'NSW', postcode: '2026' },
    { suburb: 'Newtown', state: 'NSW', postcode: '2042' },
    { suburb: 'Manly', state: 'NSW', postcode: '2095' },
    { suburb: 'Paddington', state: 'NSW', postcode: '2021' },
    { suburb: 'Glebe', state: 'NSW', postcode: '2037' },
    { suburb: 'Mosman', state: 'NSW', postcode: '2088' },
    { suburb: 'Balmain', state: 'NSW', postcode: '2041' },
    { suburb: 'Chatswood', state: 'NSW', postcode: '2067' },
    { suburb: 'Parramatta', state: 'NSW', postcode: '2150' },
    { suburb: 'Castle Hill', state: 'NSW', postcode: '2154' },
    { suburb: 'St Kilda', state: 'VIC', postcode: '3182' },
    { suburb: 'Fitzroy', state: 'VIC', postcode: '3065' },
    { suburb: 'Richmond', state: 'VIC', postcode: '3121' },
    { suburb: 'New Farm', state: 'QLD', postcode: '4005' },
    { suburb: 'Fortitude Valley', state: 'QLD', postcode: '4006' },
    { suburb: 'Subiaco', state: 'WA', postcode: '6008' },
    { suburb: 'Fremantle', state: 'WA', postcode: '6160' },
  ];

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randPhone = () => `04${randInt(10, 99)} ${randInt(100, 999)} ${randInt(100, 999)}`;
  const firstName = pick(firstNames);
  const lastName = pick(lastNames);
  const name = firstName + ' ' + lastName;
  const email = firstName.toLowerCase() + '.' + lastName.toLowerCase() + randInt(1, 99) + '@' + pick(emailDomains);
  const phone = randPhone();
  const location = pick(suburbData);
  const streetNum = randInt(1, 120);
  const streetNames = ['Bourke', 'Riley', 'Oxford', 'George', 'King', 'Pacific', 'Military', 'Darling', 'Victoria', 'Park'];
  const streetAddress = streetNum + ' ' + pick(streetNames) + ' Street, ' + location.suburb + ' ' + location.state + ' ' + location.postcode;

  const tradeMessages = {
    plumber: [
      'Hi, I have a ' + jobType.toLowerCase() + ' at my place in ' + location.suburb + '. Water\'s been backing up for a couple of days. Can someone come and have a look?',
      'G\'day, we have a ' + jobType.toLowerCase() + ' at our property in ' + location.suburb + '. Looking for a licensed plumber to sort it out.',
      'Hi there, we need a ' + jobType.toLowerCase() + ' done at our house in ' + location.suburb + '. We\'re selling soon and want it sorted before the inspection.',
    ],
    electrician: [
      'Hi, I\'ve got a ' + jobType.toLowerCase() + ' that needs doing at my home in ' + location.suburb + '. The safety switch keeps tripping.',
      'G\'day, need an electrician for ' + jobType.toLowerCase() + ' in ' + location.suburb + '. We\'re renovating and need extra power points installed.',
      'Hi there, the ' + jobType.toLowerCase() + ' at our place in ' + location.suburb + ' stopped working. Can someone licensed come and take a look?',
    ],
    painter: [
      'Hi, I need a painter for a ' + jobType.toLowerCase() + ' in ' + location.suburb + '. The walls are looking tired and we\'re selling in a few months. Can you quote?',
      'G\'day, we want a ' + jobType.toLowerCase() + ' done at our place in ' + location.suburb + '. The weatherboards are peeling. Can you come and assess?',
      'Hi there, need a painter for a ' + jobType.toLowerCase() + ' in ' + location.suburb + '. We\'ve just moved in and the whole interior needs redoing.',
    ],
    bricklayer: [
      'Hi, I\'m looking to get a ' + jobType.toLowerCase() + ' built along my boundary in ' + location.suburb + '. Can you come out and give me a quote?',
      'G\'day, I need a ' + jobType.toLowerCase() + ' at the back of my yard in ' + location.suburb + '. When can someone come take a look?',
      'Hi there, I need a ' + jobType.toLowerCase() + ' at my place in ' + location.suburb + '. Not urgent but want it sorted. Can you quote?',
    ],
    handyman: [
      'Hi, I need help with a ' + jobType.toLowerCase() + ' at my unit in ' + location.suburb + '. I\'ve tried to do it myself but it\'s beyond me.',
      'G\'day, need a handyman for a ' + jobType.toLowerCase() + ' in ' + location.suburb + '. Some general repairs that need doing.',
    ],
    fencer: [
      'Hi, I need a new ' + jobType.toLowerCase() + ' in ' + location.suburb + '. About 20m long. Want something that looks good and provides privacy.',
      'G\'day, our ' + jobType.toLowerCase() + ' in ' + location.suburb + ' got knocked down in the storm. Need it replaced.',
    ],
    landscaper: [
      'Hi, I need help with ' + jobType.toLowerCase() + ' at my place in ' + location.suburb + '. The backyard is a mess. Can someone sort it out?',
      'G\'day, we\'re after ' + jobType.toLowerCase() + ' in ' + location.suburb + '. We want a proper design, not just turf.',
    ],
    cleaner: [
      'Hi, I need a ' + jobType.toLowerCase() + ' at my place in ' + location.suburb + '. Moving out next week and need the bond back.',
      'G\'day, we want a ' + jobType.toLowerCase() + ' for our home in ' + location.suburb + '. Deep clean needed.',
    ],
    tiler: [
      'Hi, I need a ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. The tiles in our bathroom are cracked and the grout is black.',
      'G\'day, we want a ' + jobType.toLowerCase() + ' in our kitchen in ' + location.suburb + '. Can you supply and install?',
    ],
    concreter: [
      'Hi, I need a ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. Looking to do our front driveway, about 40sqm.',
      'G\'day, we want ' + jobType.toLowerCase() + ' in ' + location.suburb + '. Can someone design and pour it?',
    ],
    roofer: [
      'Hi, I\'ve got a ' + jobType.toLowerCase() + ' needed at my place in ' + location.suburb + '. There\'s a leak coming through when it rains.',
      'G\'day, we need a ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. Some tiles cracked in the storms.',
    ],
    renderer: [
      'Hi, I need a ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. Want to render the whole exterior.',
      'G\'day, we want ' + jobType.toLowerCase() + ' in ' + location.suburb + '. Can someone come and quote?',
    ],
    plasterer: [
      'Hi, I need a ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. There\'s a hole in the ceiling.',
      'G\'day, we want ' + jobType.toLowerCase() + ' done in ' + location.suburb + ' after the renovation.',
    ],
    solar_installer: [
      'Hi, I\'m looking at getting ' + jobType.toLowerCase() + ' done at my place in ' + location.suburb + '. Want to reduce our electricity bills.',
      'G\'day, our ' + jobType.toLowerCase() + ' needs replacing in ' + location.suburb + '. Can you quote on a replacement?',
    ],
    pool_tech: [
      'Hi, I need ' + jobType.toLowerCase() + ' done at my place in ' + location.suburb + '. Pool\'s gone green and the pump is making a weird noise.',
      'G\'day, we want regular ' + jobType.toLowerCase() + ' at our property in ' + location.suburb + '.',
    ],
    pest_control: [
      'Hi, I need ' + jobType.toLowerCase() + ' done at my place in ' + location.suburb + '. Found some issues and need it sorted.',
      'G\'day, we\'ve got ' + jobType.toLowerCase() + ' at our home in ' + location.suburb + '. Need a professional.',
    ],
    antenna_installer: [
      'Hi, I need ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. TV signal is terrible.',
      'G\'day, need ' + jobType.toLowerCase() + ' in ' + location.suburb + '. Moving into a new area and need the antenna sorted.',
    ],
    refrigeration: [
      'Hi, our fridge in ' + location.suburb + ' isn\'t cooling properly. Can someone come and have a look?',
      'G\'day, need ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. Walk-in freezer at our cafe is not working.',
    ],
    waterproofer: [
      'Hi, I need ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. Our bathroom is leaking through to the ceiling below.',
      'G\'day, we\'re renovating our bathroom in ' + location.suburb + ' and need ' + jobType.toLowerCase() + ' before tiles go in.',
    ],
    carpenter: [
      'Hi, I need a carpenter for ' + jobType.toLowerCase() + ' at my place in ' + location.suburb + '. Can you come and give me a quote?',
      'G\'day, we need ' + jobType.toLowerCase() + ' done at our property in ' + location.suburb + '. Looking for a quality tradesperson. Are you available this week?',
      'Hi there, looking for a carpenter to do ' + jobType.toLowerCase() + ' in ' + location.suburb + '. Can you measure up and quote?',
    ],
    real_estate: [
      'Hi, I manage a rental in ' + location.suburb + ' and need ' + jobType.toLowerCase() + '. Tenant has just moved out — need it sorted before the next tenancy. Can you quote?',
      'G\'day, property manager here. Need ' + jobType.toLowerCase() + ' at a property in ' + location.suburb + '. Landlord has approved the spend. Can you give me availability?',
      'Hi there, this is regarding ' + jobType.toLowerCase() + ' at a property in ' + location.suburb + '. Going to market soon and needs to be done before open homes.',
    ],
  };

  const messages = tradeMessages[bt] || [
    'Hi, I need help with ' + jobType.toLowerCase() + ' at my property in ' + location.suburb + '. Can someone come and have a look?',
    'G\'day, need someone for a ' + jobType.toLowerCase() + ' in ' + location.suburb + '. How much would you charge?',
    'Hi there, looking for a tradie to do ' + jobType.toLowerCase() + ' in ' + location.suburb + '. Can you give me a quote?',
  ];
  const message = messages[Math.floor(Math.random() * messages.length)];

  const subject = 'Enquiry — ' + jobType + ' — ' + location.suburb + ' ' + location.state;
  const bodyText = 'New enquiry from ' + name + '.\n\nContact details:\nName: ' + name + '\nEmail: ' + email + '\nPhone: ' + phone + '\n\nProperty address: ' + streetAddress + '\n\nJob type: ' + jobType + '\n\nMessage:\n' + message + '\n\n---\nThis enquiry was submitted via propops.pro';

  const bodyHtml = '<html><body><h2>New Enquiry — ' + jobType + '</h2><p><strong>Name:</strong> ' + name + '<br><strong>Email:</strong> ' + email + '<br><strong>Phone:</strong> ' + phone + '</p><p><strong>Address:</strong> ' + streetAddress + '</p><p><strong>Job type:</strong> ' + jobType + '</p><hr><p><strong>Message:</strong></p><p>' + message + '</p><hr><p style=\'color:#999;font-size:12px\'>Submitted via propops.pro</p></body></html>';

  return {
    subject,
    body_text: bodyText,
    body_html: bodyHtml,
    from_address: email,
    to_address: 'leads-' + Date.now() + '@propops.pro',
    job_type: jobType,
  };
}

/**
 * Generate a realistic fake property inquiry email for any supported portal format.
 * Supports: rea, domain, homely, rent, facebook, generic
 */
function generateFakeInquiry(source) {
  const firstNames = ['James', 'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'William', 'Sophia',
    'Benjamin', 'Isabella', 'Lucas', 'Mia', 'Henry', 'Charlotte', 'Alexander', 'Amelia',
    'Michael', 'Harper', 'Ethan', 'Evelyn', 'Daniel', 'Abigail', 'Matthew', 'Emily',
    'Aiden', 'Elizabeth', 'Joseph', 'Sofia', 'Jackson', 'Avery', 'Samuel', 'Ella'];
  const lastNames = ['Smith', 'Jones', 'Williams', 'Taylor', 'Brown', 'Wilson', 'Evans',
    'Thomas', 'Roberts', 'Johnson', 'White', 'Harris', 'Martin', 'Thompson', 'Garcia',
    'Martinez', 'Robinson', 'Clark', 'Rodriguez', 'Lewis', 'Lee', 'Walker', 'Hall',
    'Allen', 'Young', 'Hernandez', 'King', 'Wright', 'Lopez', 'Hill', 'Scott', 'Green'];
  const emailDomains = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com.au', 'icloud.com'];
  const suburbData = [
    { suburb: 'Surry Hills', state: 'NSW', postcode: '2010' },
    { suburb: 'Bondi', state: 'NSW', postcode: '2026' },
    { suburb: 'Newtown', state: 'NSW', postcode: '2042' },
    { suburb: 'Manly', state: 'NSW', postcode: '2095' },
    { suburb: 'Paddington', state: 'NSW', postcode: '2021' },
    { suburb: 'Glebe', state: 'NSW', postcode: '2037' },
    { suburb: 'Pyrmont', state: 'NSW', postcode: '2009' },
    { suburb: 'Mosman', state: 'NSW', postcode: '2088' },
    { suburb: 'Balmain', state: 'NSW', postcode: '2041' },
    { suburb: 'Coogee', state: 'NSW', postcode: '2034' },
    { suburb: 'Chatswood', state: 'NSW', postcode: '2067' },
    { suburb: 'Parramatta', state: 'NSW', postcode: '2150' },
    { suburb: 'Strathfield', state: 'NSW', postcode: '2135' },
    { suburb: 'Liverpool', state: 'NSW', postcode: '2170' },
    { suburb: 'Castle Hill', state: 'NSW', postcode: '2154' },
    { suburb: 'Randwick', state: 'NSW', postcode: '2031' },
    { suburb: 'Neutral Bay', state: 'NSW', postcode: '2089' },
    { suburb: 'Cremorne', state: 'NSW', postcode: '2090' },
    { suburb: 'East Hills', state: 'NSW', postcode: '2213' },
    { suburb: 'Panania', state: 'NSW', postcode: '2213' },
  ];
  const propertyTypes = [
    { type: 'house', bedrooms: [3, 4, 5] },
    { type: 'unit', bedrooms: [1, 2, 3] },
    { type: 'apartment', bedrooms: [1, 2, 3] },
    { type: 'townhouse', bedrooms: [2, 3, 4] },
    { type: 'villa', bedrooms: [2, 3] },
  ];
  const buyerMessages = [
    "Hi, I'm very interested in this property and would love to arrange an inspection at your earliest convenience. Could we schedule something for this weekend?",
    "Hello! I've been looking for a property like this in the area. I'm a pre-approved buyer and keen to move quickly. Please let me know when I can view.",
    "I'd love to learn more about this property. We're first home buyers looking to settle in the area. Is it possible to book an inspection?",
    "This property looks perfect for our family. We're ready to move and would appreciate a viewing as soon as possible. When are you available?",
    "Great listing! I'm very interested. I've been searching in this suburb for a while and this ticks all the boxes. Can we arrange a time to inspect?",
  ];
  const renterMessages = [
    "Hi there, I'm interested in renting this property. Could you please let me know the availability and when I can inspect? I'm looking to move in ASAP.",
    "Hello, I saw this listing and it looks perfect. I'm a professional working in the CBD and looking for a long-term rental. When can I arrange an inspection?",
    "I'm very keen on this rental. Could you send me more details about the lease terms and available move-in date? Happy to provide references.",
    "This looks great! I'm currently renting and looking to upgrade. I have excellent references and steady income. Can we arrange a time to view?",
    "Interested in this rental. I'm a quiet professional, no pets, and would love to arrange an inspection at a time that suits you.",
  ];

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randPhone = () => `04${randInt(10, 99)} ${randInt(100, 999)} ${randInt(100, 999)}`;
  const randListingId = () => randInt(100000000, 999999999);

  const firstName = pick(firstNames);
  const lastName = pick(lastNames);
  const name = `${firstName} ${lastName}`;
  const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randInt(1, 99)}@${pick(emailDomains)}`;
  const phone = randPhone();
  const location = pick(suburbData);
  const propType = pick(propertyTypes);
  const bedrooms = pick(propType.bedrooms);
  const isRenter = Math.random() < 0.35; // 35% renters, 65% buyers
  const message = pick(isRenter ? renterMessages : buyerMessages);
  const listingId = randListingId();
  const propertyDesc = `${bedrooms} bedroom ${propType.type} in ${location.suburb} ${location.state} ${location.postcode}`;
  const streetNum = randInt(1, 120);
  const streetNames = ['Bourke', 'Riley', 'Oxford', 'Crown', 'George', 'King', 'Pacific', 'Military', 'Darling', 'Victoria'];
  const streetAddress = `${streetNum} ${pick(streetNames)} Street, ${location.suburb} ${location.state} ${location.postcode}`;

  // Generate realistic price guide for the listing
  const priceGuides = isRenter
    ? { apartment: ['$550pw', '$600pw', '$650pw', '$700pw', '$750pw'], unit: ['$450pw', '$500pw', '$550pw', '$600pw'], townhouse: ['$650pw', '$700pw', '$750pw', '$800pw'], house: ['$750pw', '$800pw', '$850pw', '$900pw', '$950pw'], villa: ['$600pw', '$650pw', '$700pw'] }
    : { apartment: ['$650,000', '$750,000', '$850,000', '$950,000'], unit: ['$500,000', '$600,000', '$700,000', '$800,000'], townhouse: ['$900,000', '$1,050,000', '$1,200,000', '$1,350,000'], house: ['$1,200,000', '$1,400,000', '$1,600,000', '$1,800,000', '$2,000,000'], villa: ['$800,000', '$900,000', '$1,000,000', '$1,100,000'] };
  const priceList = priceGuides[propType.type] || priceGuides['house'];
  const priceGuide = pick(priceList);

  // ── REA ──────────────────────────────────────────────────────────────────────
  if (source === 'rea') {
    const listingUrl = `https://www.realestate.com.au/property-${propType.type}-${location.state.toLowerCase()}-${location.suburb.toLowerCase().replace(/ /g, '+')}-${listingId}`;
    const subject = `New Enquiry - ${propertyDesc}`;
    const bodyText = `You have a new enquiry for your listing at ${propertyDesc}.

Name: ${name}
Phone: ${phone}
Email: ${email}
Lead type: ${isRenter ? 'Renter' : 'Buyer'}

Property: ${streetAddress}
Price guide: ${priceGuide}
Listing URL: ${listingUrl}

Message:
${message}

---
This email was sent from realestate.com.au
Property enquiry for: ${listingUrl}`;

    return {
      subject,
      body_text: bodyText,
      body_html: `<html><body><p>You have a new enquiry for your listing at <strong>${propertyDesc}</strong>.</p>
<table><tr><td><strong>Name:</strong></td><td>${name}</td></tr>
<tr><td><strong>Phone:</strong></td><td>${phone}</td></tr>
<tr><td><strong>Email:</strong></td><td>${email}</td></tr>
<tr><td><strong>Lead type:</strong></td><td>${isRenter ? 'Renter' : 'Buyer'}</td></tr>
</table>
<p><strong>Property:</strong> ${streetAddress}<br>
<strong>Price guide:</strong> ${priceGuide}<br>
<strong>Listing:</strong> <a href="${listingUrl}">${listingUrl}</a></p>
<p><strong>Message:</strong><br>${message}</p>
<hr><p>This email was sent from realestate.com.au</p></body></html>`,
      from_address: 'enquiry@realestate.com.au',
      to_address: `leads-${Date.now()}@propops.pro`,
    };
  }

  // ── Domain ───────────────────────────────────────────────────────────────────
  if (source === 'domain') {
    const listingUrl = `https://www.domain.com.au/${bedrooms}-bedroom-${propType.type}-${location.suburb.toLowerCase().replace(/ /g, '-')}-${location.postcode}-${listingId}`;
    const subject = `New Enquiry for ${propertyDesc} - domain.com.au`;
    const bodyText = `You've received a new enquiry from:

Name: ${name}
Email: ${email}
Mobile: ${phone}

Property enquiry for: ${streetAddress}
Price guide: ${priceGuide}
${listingUrl}

Message from ${firstName}:
${message}

---
domain.com.au — Australia's home of property`;

    return {
      subject,
      body_text: bodyText,
      body_html: `<html><body>
<p>You've received a new enquiry from:</p>
<p><strong>Name:</strong> ${name}<br>
<strong>Email:</strong> ${email}<br>
<strong>Mobile:</strong> ${phone}</p>
<p><strong>Property enquiry for:</strong> ${streetAddress}<br>
<strong>Price guide:</strong> ${priceGuide}<br>
<a href="${listingUrl}">${listingUrl}</a></p>
<p><strong>Message from ${firstName}:</strong><br>${message}</p>
<hr><p>domain.com.au — Australia's home of property</p>
</body></html>`,
      from_address: 'noreply@domain.com.au',
      to_address: `leads-${Date.now()}@propops.pro`,
    };
  }

  // ── Homely ───────────────────────────────────────────────────────────────────
  if (source === 'homely') {
    const listingUrl = `https://www.homely.com.au/homes/${location.suburb.toLowerCase().replace(/ /g, '-')}-${location.state.toLowerCase()}-${location.postcode}/${listingId}`;
    const subject = `You've received an enquiry on Homely — ${streetAddress}`;
    const bodyText = `You've received a new property enquiry via Homely.

Enquiry details:
Name: ${name}
Email: ${email}
Phone: ${phone}

Message:
${message}

For: ${streetAddress}
Price guide: ${priceGuide}

View listing: ${listingUrl}

---
This message was sent via homely.com.au`;

    return {
      subject,
      body_text: bodyText,
      body_html: `<html><body>
<p>You've received a new property enquiry via <strong>Homely</strong>.</p>
<table>
<tr><td><strong>Name:</strong></td><td>${name}</td></tr>
<tr><td><strong>Email:</strong></td><td>${email}</td></tr>
<tr><td><strong>Phone:</strong></td><td>${phone}</td></tr>
</table>
<p><strong>Message:</strong><br>${message}</p>
<p><strong>For:</strong> ${streetAddress}<br>
<strong>Price guide:</strong> ${priceGuide}<br>
<a href="${listingUrl}">View listing on Homely</a></p>
<hr><p>This message was sent via homely.com.au</p>
</body></html>`,
      from_address: 'enquiries@homely.com.au',
      to_address: `leads-${Date.now()}@propops.pro`,
    };
  }

  // ── Rent.com.au ──────────────────────────────────────────────────────────────
  if (source === 'rent') {
    const listingUrl = `https://www.rent.com.au/properties/${location.suburb.toLowerCase().replace(/ /g, '-')}-${location.state.toLowerCase()}-${location.postcode}/pid-${listingId}`;
    const subject = `New rental enquiry — ${streetAddress}`;
    const bodyText = `New Rental Enquiry

Name: ${name}
Email Address: ${email}
Phone Number: ${phone}

Property: ${streetAddress}
Rent: ${priceGuide}

Their message:
${message}

${listingUrl}

---
rent.com.au — Australia's rental marketplace`;

    return {
      subject,
      body_text: bodyText,
      body_html: `<html><body>
<h2>New Rental Enquiry</h2>
<table>
<tr><td><strong>Name:</strong></td><td>${name}</td></tr>
<tr><td><strong>Email Address:</strong></td><td>${email}</td></tr>
<tr><td><strong>Phone Number:</strong></td><td>${phone}</td></tr>
</table>
<p><strong>Property:</strong> ${streetAddress}<br>
<strong>Rent:</strong> ${priceGuide}</p>
<p><strong>Their message:</strong><br>${message}</p>
<p><a href="${listingUrl}">View listing on Rent.com.au</a></p>
<hr><p>rent.com.au — Australia's rental marketplace</p>
</body></html>`,
      from_address: 'noreply@rent.com.au',
      to_address: `leads-${Date.now()}@propops.pro`,
    };
  }

  // ── Facebook Marketplace ─────────────────────────────────────────────────────
  if (source === 'facebook') {
    const listingTitle = `${bedrooms}BR ${propType.type} for ${isRenter ? 'rent' : 'sale'} — ${location.suburb} — ${priceGuide}`;
    // Facebook messages don't include structured contact info — name is in subject/body only
    // The phone/email in the message body simulates the prospect including their details manually
    const fbMessage = `${message}\n\nYou can reach me at ${email} or call me on ${phone}.`;
    const subject = `${name} sent you a message about "${listingTitle}"`;
    const bodyText = `${name} sent you a message on Facebook Marketplace:

"${fbMessage}"

Listing: ${listingTitle}

Reply to ${firstName}: https://www.facebook.com/messages/t/${firstName.toLowerCase()}${randInt(1000, 9999)}

View the Marketplace post: https://www.facebook.com/marketplace/item/${randInt(100000000000, 999999999999)}

---
You received this email because someone sent you a message via Facebook Marketplace.
Facebook, Inc.`;

    return {
      subject,
      body_text: bodyText,
      body_html: `<html><body>
<p><strong>${name}</strong> sent you a message on Facebook Marketplace:</p>
<blockquote style="border-left:3px solid #ccc;padding-left:1em;">${fbMessage}</blockquote>
<p><strong>Listing:</strong> ${listingTitle}</p>
<p><a href="https://www.facebook.com/messages/t/${firstName.toLowerCase()}${randInt(1000, 9999)}">Reply to ${firstName}</a></p>
<p><a href="https://www.facebook.com/marketplace/item/${randInt(100000000000, 999999999999)}">View the Marketplace post</a></p>
<hr><p>Facebook, Inc.</p>
</body></html>`,
      from_address: 'notification@facebookmail.com',
      to_address: `leads-${Date.now()}@propops.pro`,
    };
  }

  // ── Generic / forwarded inquiry ──────────────────────────────────────────────
  // Simulates a manual forward from an agent's inbox — no portal formatting
  const subject = `FWD: Property enquiry — ${streetAddress}`;
  const bodyText = `---------- Forwarded message ---------
From: ${email}
Date: ${new Date().toDateString()}
Subject: Property enquiry
To: agent@realestate.com.au

Hi,

My name is ${name} and I came across your listing for ${streetAddress} (${priceGuide}).

${message}

Best,
${name}
${phone}`;

  return {
    subject,
    body_text: bodyText,
    body_html: `<html><body>
<div style="border-top:1px solid #ccc;padding-top:1em;font-family:monospace">
<p><strong>---------- Forwarded message ---------</strong><br>
From: ${email}<br>
Subject: Property enquiry</p>
<p>Hi,<br><br>
My name is ${name} and I came across your listing for ${streetAddress} (${priceGuide}).<br><br>
${message}<br><br>
Best,<br>
${name}<br>${phone}</p>
</div>
</body></html>`,
    from_address: email, // generic forward — from the lead themselves
    to_address: `leads-${Date.now()}@propops.pro`,
  };
}

/**
 * POST /api/email-intake/resend-inbound
 *
 * Resend inbound webhook — called by Resend when an email arrives at
 * *@propops.pro (any address: leads-{token}@, propops@, support@).
 *
 * Configure in Resend dashboard:
 *   Domains → propops.pro → Inbound → Webhook URL:
 *   https://propops.pro/api/email-intake/resend-inbound
 *
 * Routing:
 *   - propops@propops.pro  → forward to propropsp@gmail.com
 *   - support@propops.pro  → forward to gassin123@gmail.com + propropsp@gmail.com
 *   - leads-{token}@propops.pro → process inbound lead (create lead + AI response)
 *
 * Payload shape (Resend sends — NOTE: body is NOT included by design):
 *   { type: "email.received", data: { from, to: [...], subject, email_id } }
 *   Body must be fetched via GET /emails/receiving/{email_id}
 *
 * Optional security: set resend_inbound_secret in app_settings and Resend
 * will include it in the X-Resend-Signature header for verification.
 */
router.post('/resend-inbound', async (req, res) => {
  // ── Svix signature verification ──────────────────────────────────────────
  // RESEND_WEBHOOK_SECRET is set on the server (env var).
  // req.rawBody is captured by the raw-body middleware in server.js (before express.json).
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (webhookSecret) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      // rawBody missing means server.js middleware didn't run — likely a misconfiguration
      console.error('[Email Intake] Resend inbound: rawBody not captured — check server.js middleware order');
      return res.status(200).json({ success: false, message: 'Configuration error: raw body not available' });
    }
    const valid = verifySvixSignature(rawBody, req.headers, webhookSecret);
    if (!valid) {
      console.warn('[Email Intake] Resend inbound: invalid svix signature — rejecting');
      return res.status(200).json({ success: false, message: 'Invalid webhook signature' });
    }
    console.log('[Email Intake] Resend inbound: svix signature verified ✓');
  } else {
    console.warn('[Email Intake] Resend inbound: RESEND_WEBHOOK_SECRET not set — skipping signature verification');
  }

  // Handle Resend's "email.received" event envelope
  const body = req.body || {};
  console.log(`[Email Intake] Resend inbound received — type: ${body.type || '(unknown)'}`);

  // Normalise to our standard shape
  const email = normaliseWebhookPayload(body);
  const toAddress = email.to_address || '';

  // Diagnostic: log what body content arrived in the webhook
  const bodyTextMissing = !email.body_text || email.body_text.trim() === '';
  const bodyHtmlMissing = !email.body_html || email.body_html.trim() === '';
  console.log(`[Email Intake] Resend inbound body: text=${email.body_text ? email.body_text.length + ' chars' : 'empty'}, html=${email.body_html ? email.body_html.length + ' chars' : 'empty'}, email_id=${email.email_id || 'none'}`);

  // ── ALWAYS fetch email body from Resend Receiving API ─────────────────────
  // Resend inbound webhooks do NOT include body/headers/attachments by design.
  // The body must be fetched separately via GET /emails/receiving/{email_id}.
  // See: https://resend.com/docs/dashboard/receiving/get-email-content
  if (email.email_id) {
    console.log(`[Email Intake] Resend inbound: fetching body via Receiving API for email_id=${email.email_id}`);
    const fetched = await fetchResendEmailContent(email.email_id);
    if (fetched && (fetched.text || fetched.html)) {
      email.body_text = fetched.text || email.body_text;
      email.body_html = fetched.html || email.body_html;
      // Also grab subject from fetched data if webhook subject was empty
      if ((!email.subject || email.subject.trim() === '') && fetched.subject) {
        email.subject = fetched.subject;
      }
      console.log(`[Email Intake] Resend inbound: body retrieved ✓ — text=${(email.body_text || '').length} chars, html=${(email.body_html || '').length} chars`);
    } else {
      console.warn(`[Email Intake] Resend inbound: could not fetch email content from Receiving API — lead extraction will be limited`);
    }
  } else {
    console.warn(`[Email Intake] Resend inbound: no email_id in webhook — cannot fetch body`);
  }

  console.log(`[Email Intake] Resend inbound: "${email.subject}" to ${toAddress}`);

  // ── propops@ forwarding ─────────────────────────────────────────────────
  // When MX for propops.pro points to Resend, emails to propops@propops.pro
  // must be forwarded to the owner's Gmail (replaces Porkbun forward).
  const PROPOPS_FORWARD_TO = ['propropsp@gmail.com'];
  if (/^propops@/i.test(toAddress)) {
    console.log(`[Email Intake] propops@ address detected — forwarding to ${PROPOPS_FORWARD_TO.join(', ')}`);
    const fromLine = email.from_address ? `From: ${email.from_address}` : '';
    const subjectLine = email.subject ? `Subject: ${email.subject}` : '';

    const forwardedText = [
      `---------- Forwarded message ----------`,
      fromLine,
      subjectLine,
      `To: ${toAddress}`,
      '',
      email.body_text || email.body_html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '(no body)',
    ].filter(Boolean).join('\n');

    const forwardedHtml = `
<div style="font-family:sans-serif;color:#1a1a1a;max-width:600px;">
  <p style="background:#f3f4f6;border-left:4px solid #6b7280;padding:10px 14px;font-size:13px;color:#374151;border-radius:2px;">
    <strong>Forwarded from propops@propops.pro</strong><br>
    <strong>From:</strong> ${email.from_address || '(unknown)'}<br>
    <strong>Subject:</strong> ${email.subject || '(no subject)'}
  </p>
  <div style="padding:8px 0;">
    ${email.body_html || `<pre style="font-size:13px;white-space:pre-wrap;">${(email.body_text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`}
  </div>
</div>`.trim();

    const forwardResults = await Promise.allSettled(
      PROPOPS_FORWARD_TO.map(recipient =>
        sendEmail({
          to: recipient,
          subject: `[PropOps] ${email.subject || '(no subject)'}`,
          html: forwardedHtml,
          text: forwardedText,
          tag: 'transactional',
          reply_to: email.from_address || undefined,
        })
      )
    );

    forwardResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        console.log(`[Email Intake] propops@ forward to ${PROPOPS_FORWARD_TO[i]}: ok=${result.value.ok}, provider=${result.value.provider || 'unknown'}`);
      } else {
        console.error(`[Email Intake] propops@ forward to ${PROPOPS_FORWARD_TO[i]} failed:`, result.reason?.message || result.reason);
      }
    });

    return res.status(200).json({ success: true, message: 'Forwarded to propops@ inboxes' });
  }

  // ── support@ forwarding ─────────────────────────────────────────────────
  // Emails to support@propops.pro forwarded to owner Gmail addresses
  // (replaces Porkbun forwards that will break when MX switches to Resend).
  const SUPPORT_FORWARD_TO_RESEND = ['gassin123@gmail.com', 'propropsp@gmail.com'];
  if (/^support@/i.test(toAddress)) {
    console.log(`[Email Intake] support@ address detected — forwarding to ${SUPPORT_FORWARD_TO_RESEND.join(', ')}`);
    const fromLine = email.from_address ? `From: ${email.from_address}` : '';
    const subjectLine = email.subject ? `Subject: ${email.subject}` : '';

    const forwardedText = [
      `---------- Forwarded message ----------`,
      fromLine,
      subjectLine,
      `To: ${toAddress}`,
      '',
      email.body_text || email.body_html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '(no body)',
    ].filter(Boolean).join('\n');

    const forwardedHtml = `
<div style="font-family:sans-serif;color:#1a1a1a;max-width:600px;">
  <p style="background:#f3f4f6;border-left:4px solid #6b7280;padding:10px 14px;font-size:13px;color:#374151;border-radius:2px;">
    <strong>Forwarded from support@propops.pro</strong><br>
    <strong>From:</strong> ${email.from_address || '(unknown)'}<br>
    <strong>Subject:</strong> ${email.subject || '(no subject)'}
  </p>
  <div style="padding:8px 0;">
    ${email.body_html || `<pre style="font-size:13px;white-space:pre-wrap;">${(email.body_text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`}
  </div>
</div>`.trim();

    const forwardResults = await Promise.allSettled(
      SUPPORT_FORWARD_TO_RESEND.map(recipient =>
        sendEmail({
          to: recipient,
          subject: `[PropOps Support] ${email.subject || '(no subject)'}`,
          html: forwardedHtml,
          text: forwardedText,
          tag: 'transactional',
          reply_to: email.from_address || undefined,
        })
      )
    );

    forwardResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        console.log(`[Email Intake] support@ forward to ${SUPPORT_FORWARD_TO_RESEND[i]}: ok=${result.value.ok}, provider=${result.value.provider || 'unknown'}`);
      } else {
        console.error(`[Email Intake] support@ forward to ${SUPPORT_FORWARD_TO_RESEND[i]} failed:`, result.reason?.message || result.reason);
      }
    });

    return res.status(200).json({ success: true, message: 'Forwarded to support inboxes' });
  }

  // ── Extract token from leads-{token}@propops.pro ──────────────────────
  const toMatch = toAddress.match(/^leads-([a-f0-9]{24,64})@/i);
  if (!toMatch) {
    console.warn(`[Email Intake] Resend inbound: unrecognised to_address: ${toAddress}`);
    return res.status(200).json({ success: false, message: 'No matching token in to_address' });
  }

  const derivedToken = toMatch[1];

  // Validate token is active — also get user_id for multi-tenancy
  const tokenRow = await pool.query(
    `SELECT token, user_id FROM intake_tokens WHERE token = $1 AND is_active = true`,
    [derivedToken]
  );
  if (tokenRow.rows.length === 0) {
    console.warn(`[Email Intake] Resend inbound: no active token for ${toAddress}`);
    return res.status(200).json({ success: false, message: 'No active token for this address' });
  }

  return processInboundEmail(derivedToken, email, req.body, res, tokenRow.rows[0].user_id || null);
});

/**
 * POST /api/email-intake/:token
 * Legacy inbound email webhook — receives forwarded property inquiry emails
 * Compatible with: Postmark, Mailgun, SendGrid, generic POST
 * NOTE: This must come AFTER all named POST routes above.
 */
router.post('/:token', async (req, res) => {
  const { token } = req.params;

  // Validate token — also get user_id for multi-tenancy
  const tokenRow = await pool.query(
    `SELECT id, user_id FROM intake_tokens WHERE token = $1 AND is_active = true`,
    [token]
  );

  if (tokenRow.rows.length === 0) {
    console.warn(`[Email Intake] Invalid token: ${token}`);
    // Return 200 so email services don't retry (they interpret non-200 as failure)
    return res.status(200).json({ success: false, message: 'Invalid token' });
  }

  // Normalise payload and process
  const email = normaliseWebhookPayload(req.body);
  return processInboundEmail(token, email, req.body, res, tokenRow.rows[0].user_id || null);
});

/**
 * POST /api/email-intake/polsia-inbound
 *
 * Polsia company inbox webhook — called when an email arrives at propopspro@polsia.app.
 * Also used by the auto-read cron (hugo-inbox-reader.js) to inject polled emails
 * into the same pipeline.
 *
 * Anti-loop runs inside processInboundEmail() — all Hugo outbound addresses are blocked.
 * Domain routing tag from rawPayload.domain_tag determines product (propops.pro / .trade / hugopays.pro).
 *
 * Security: optional POLSIA_INBOUND_SECRET env var (set in Render) validates webhook calls.
 */
router.post('/polsia-inbound', async (req, res) => {
  // Optional shared secret for webhook auth
  const secret = process.env.POLSIA_INBOUND_SECRET;
  if (secret) {
    const provided = req.headers['x-polsia-secret'] || req.query.secret;
    if (provided !== secret) {
      console.warn('[Email Intake] polsia-inbound: invalid secret');
      return res.status(200).json({ success: false, message: 'Invalid secret' });
    }
  }

  const email = normaliseWebhookPayload(req.body);
  const domainTag = req.body.domain_tag || 'unknown';

  console.log(`[Email Intake] polsia-inbound received: "${email.subject}" from=${email.from_address} tag=${domainTag}`);

  // Get or create the Company Inbox system token
  let systemToken = null;
  try {
    const crypto = require('crypto');
    const tokenRow = await pool.query(
      `SELECT token FROM intake_tokens WHERE label = 'Company Inbox' AND is_active = true LIMIT 1`
    );
    if (tokenRow.rows.length > 0) {
      systemToken = tokenRow.rows[0].token;
    } else {
      systemToken = crypto.randomBytes(16).toString('hex');
      await pool.query(
        `INSERT INTO intake_tokens (token, label, forwarding_email, is_active)
         VALUES ($1, 'Company Inbox', 'propopspro@polsia.app', true)
         ON CONFLICT DO NOTHING`,
        [systemToken]
      );
      console.log('[Email Intake] Auto-provisioned Company Inbox intake token:', systemToken);
    }
  } catch (err) {
    console.error('[Email Intake] polsia-inbound: could not get/create system token:', err.message);
    return res.status(200).json({ success: false, message: 'Token provisioning error' });
  }

  return processInboundEmail(systemToken, email, req.body, res, null);
});

/**
 * POST /api/admin/poll-company-inbox
 *
 * Manual trigger for the Polsia inbox poll (admin only).
 * Useful for testing without waiting for the 5-minute cron.
 */
router.post('/poll-company-inbox', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  const provided = req.headers['x-admin-token'] || req.body?.token;
  if (adminToken && provided !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const systemToken = await router.getSystemToken();
    const { pollAndProcessInbox } = require('../services/hugo-inbox-reader');
    const stats = await pollAndProcessInbox(processInboundEmail, systemToken);
    res.json({ success: true, stats });
  } catch (err) {
    console.error('[Email Intake] Manual poll error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Export processInboundEmail so the cron can call it directly (avoids HTTP round-trips)
router.processInboundEmail = processInboundEmail;

// Get or create the Company Inbox system intake token
router.getSystemToken = async function getSystemToken() {
  const crypto = require('crypto');
  const tokenRow = await pool.query(
    `SELECT token FROM intake_tokens WHERE label = 'Company Inbox' AND is_active = true LIMIT 1`
  );
  if (tokenRow.rows.length > 0) return tokenRow.rows[0].token;
  const systemToken = crypto.randomBytes(16).toString('hex');
  await pool.query(
    `INSERT INTO intake_tokens (token, label, forwarding_email, is_active)
     VALUES ($1, 'Company Inbox', 'propopspro@polsia.app', true)
     ON CONFLICT DO NOTHING`,
    [systemToken]
  );
  return systemToken;
};

module.exports = router;
