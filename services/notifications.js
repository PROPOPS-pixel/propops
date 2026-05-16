/**
 * Notification service — orchestrates per-lead alerts and daily digest emails.
 *
 * Two public functions:
 *   notifyNewLead(lead, aiResponse, responseTimeSec) — fires SMS + email to all subscribed users
 *   sendDailyDigest()                                — sends daily summary to all opted-in users
 *
 * All errors are caught and logged — notifications must never crash the main flow.
 */

const { sendEmail } = require('./email');
const { sendSMS }   = require('./sms');
const { Pool }      = require('pg');

const APP_URL = process.env.APP_URL || 'https://propops.pro';

// ─── Rate limiter — prevents burning email quota ────────────────────────────
// Tracks notification emails sent in a rolling 1-hour window.
// Hard cap: 30 notification emails per hour (configurable via env).
// This is a safety net — even if something bulk-creates leads, we won't
// exhaust the Resend free-tier daily limit (100/day) in a single burst.
const NOTIFY_EMAIL_LIMIT_PER_HOUR = parseInt(process.env.NOTIFY_EMAIL_LIMIT_PER_HOUR || '30', 10);
const _notifyEmailTimestamps = []; // timestamps of recent notification emails

function isNotifyRateLimited() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  // Prune old entries
  while (_notifyEmailTimestamps.length > 0 && _notifyEmailTimestamps[0] < oneHourAgo) {
    _notifyEmailTimestamps.shift();
  }
  return _notifyEmailTimestamps.length >= NOTIFY_EMAIL_LIMIT_PER_HOUR;
}

function recordNotifyEmail() {
  _notifyEmailTimestamps.push(Date.now());
}

let _pool = null;
function getPool() {
  if (!_pool && process.env.DATABASE_URL) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 2,
    });
  }
  return _pool;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Return users who have opted into at least one notification channel.
 *
 * Note: includes 'cancelled' users — they may have cancelled their subscription
 * but still want lead alerts (e.g. they still own the property). Respecting
 * their notify_* preferences is the right product behavior.
 */
async function getActiveUsers() {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(`
      SELECT id, email, name,
             mobile_number,
             COALESCE(notify_sms, TRUE) AS notify_sms,
             COALESCE(notify_email_per_lead, TRUE) AS notify_email_per_lead,
             COALESCE(notify_daily_digest, TRUE) AS notify_daily_digest,
             COALESCE(digest_time, '18:00') AS digest_time
      FROM users
      WHERE (subscription_status IN ('trial', 'active', 'cancelled'))
        AND (COALESCE(notify_sms, TRUE) = TRUE OR COALESCE(notify_email_per_lead, TRUE) = TRUE)
    `);
    return result.rows;
  } catch (err) {
    console.error('[Notifications] Failed to fetch active users:', err.message);
    return [];
  }
}

// ─── Per-lead alert ───────────────────────────────────────────────────────────

/**
 * Fire SMS + email notifications when AI responds to a new lead.
 *
 * @param {object} lead            - Lead row from DB
 * @param {object|null} aiResponse - lead_responses row (may be null if AI failed)
 * @param {number} responseTimeSec - Time from lead created → AI response in seconds
 */

/** 600ms delay — Twilio limits to ~1-2 SMS/sec; SMS sends run sequentially */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notifyNewLead(lead, aiResponse, responseTimeSec, opts = {}) {
  try {
    // ── Rate limit check — prevent burning email quota ──────────────────────
    if (isNotifyRateLimited()) {
      console.warn(`[Notifications] ⚠️  Rate limit hit (${NOTIFY_EMAIL_LIMIT_PER_HOUR}/hr) — skipping notifications for lead #${lead.id}`);
      return;
    }

    let users = await getActiveUsers();
    if (users.length === 0) return;

    // For simulated leads, only notify the agent who triggered the simulation
    // This prevents email/SMS bursts while still letting agents test the flow
    if (opts.onlyUserId) {
      // Use == (not ===) to handle int/string type mismatch between DB ids and JWT payload
      users = users.filter((u) => String(u.id) === String(opts.onlyUserId));
      if (users.length === 0) {
        console.warn(`[Notifications] Simulated lead #${lead.id} — triggering user_id=${opts.onlyUserId} not found in active users, skipping`);
        return;
      }
      console.log(`[Notifications] 🧪 Simulated lead #${lead.id} — scoping notifications to user_id=${opts.onlyUserId} only`);
    }

    const smsUsers = users.filter((u) => u.notify_sms && u.mobile_number);
    console.log(`[Notifications] New lead #${lead.id} — notifying ${users.length} user(s) (${smsUsers.length} SMS, ${users.filter((u) => u.notify_email_per_lead).length} email)`);

    const leadType   = capitalize(lead.lead_type) || 'Unknown';
    const leadName   = lead.name || 'Unknown';
    const timeSec    = Math.round(responseTimeSec || 0);
    const timeStr    = timeSec < 60 ? `${timeSec}s` : `${Math.round(timeSec / 60)}m`;
    const property   = lead.property_interest || null;
    const dashLink   = `${APP_URL}/dashboard`;

    const smsBody = `PropOps: New lead — ${leadName} (${leadType}). AI responded in ${timeStr}. Check your dashboard: ${dashLink}`;

    for (const user of users) {
      // SMS — sequential with rate-limit delay between sends
      if (user.notify_sms && user.mobile_number) {
        sendSMS({ to: user.mobile_number, body: smsBody }).catch((err) => {
          console.error(`[Notifications] SMS to ${user.mobile_number} failed:`, err.message);
        });
        await delay(600); // respect Twilio / upstream SMS rate limits
      }

      // Per-lead email — check rate limit before each send
      if (user.notify_email_per_lead) {
        if (isNotifyRateLimited()) {
          console.warn(`[Notifications] ⚠️  Rate limit hit mid-batch — skipping remaining emails for lead #${lead.id}`);
          break;
        }
        recordNotifyEmail();
        sendLeadAlertEmail({ user, lead, leadType, leadName, property, timeStr, dashLink }).catch((err) => {
          console.error(`[Notifications] Email to ${user.email} failed:`, err.message);
        });
        await delay(600); // prevent Resend 429 rate-limit hits when multiple users notified
      }
    }
  } catch (err) {
    console.error('[Notifications] notifyNewLead error:', err.message);
  }
}

async function sendLeadAlertEmail({ user, lead, leadType, leadName, property, timeStr, dashLink }) {
  const subject = `New Lead: ${leadName} (${leadType}) — AI responded in ${timeStr}`;
  const firstName = user.name ? user.name.split(' ')[0] : 'there';

  const propertyRow = property ? `
    <tr>
      <td style="padding:6px 0;font-size:14px;color:#64748b;">Property interest</td>
      <td style="padding:6px 0;font-size:14px;color:#0f172a;font-weight:500;">${escHtml(property)}</td>
    </tr>` : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

        <tr><td style="background:#0f172a;padding:24px 32px;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.4px;">PropOps<span style="color:#f59e0b;">.</span></p>
        </td></tr>

        <tr><td style="padding:28px 32px;">

          <!-- Alert badge -->
          <table cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
            <tr><td style="background:#fef3c7;border:1px solid #fde68a;border-radius:20px;padding:6px 14px;">
              <p style="margin:0;font-size:12px;font-weight:700;color:#b45309;letter-spacing:0.5px;">⚡ NEW LEAD</p>
            </td></tr>
          </table>

          <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a;line-height:1.3;">
            ${escHtml(leadName)}
            <span style="font-size:15px;font-weight:500;color:#64748b;"> — ${escHtml(leadType)}</span>
          </h1>
          <p style="margin:0 0 24px;font-size:14px;color:#64748b;">
            AI responded in <strong style="color:#0f172a;">${timeStr}</strong>
          </p>

          <!-- Lead details -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
            <tr><td style="background:#f8fafc;padding:12px 16px;border-bottom:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;font-weight:600;color:#64748b;letter-spacing:0.5px;text-transform:uppercase;">Lead Details</p>
            </td></tr>
            <tr><td style="padding:12px 16px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:6px 0;font-size:14px;color:#64748b;">Name</td>
                  <td style="padding:6px 0;font-size:14px;color:#0f172a;font-weight:500;">${escHtml(leadName)}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;font-size:14px;color:#64748b;">Type</td>
                  <td style="padding:6px 0;font-size:14px;color:#0f172a;font-weight:500;">${escHtml(leadType)}</td>
                </tr>
                ${propertyRow}
                <tr>
                  <td style="padding:6px 0;font-size:14px;color:#64748b;">AI response time</td>
                  <td style="padding:6px 0;font-size:14px;color:#059669;font-weight:600;">${timeStr}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;font-size:14px;color:#64748b;">Source</td>
                  <td style="padding:6px 0;font-size:14px;color:#0f172a;">${escHtml(lead.source || 'website')}</td>
                </tr>
              </table>
            </td></tr>
          </table>

          <!-- CTA -->
          <table cellpadding="0" cellspacing="0">
            <tr><td style="background:#f59e0b;border-radius:8px;">
              <a href="${dashLink}" style="display:inline-block;padding:13px 26px;font-size:14px;font-weight:700;color:#0f172a;text-decoration:none;">
                View Lead in Dashboard →
              </a>
            </td></tr>
          </table>

        </td></tr>

        <tr><td style="padding:20px 32px;border-top:1px solid #e2e8f0;background:#f8fafc;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">You're receiving this because email notifications are enabled in your PropOps settings.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `New Lead: ${leadName} (${leadType}) — AI responded in ${timeStr}\n\nLead Details:\nName: ${leadName}\nType: ${leadType}${property ? '\nProperty: ' + property : ''}\nAI response time: ${timeStr}\nSource: ${lead.source || 'website'}\n\nView in dashboard: ${dashLink}\n\n— PropOps`;

  return sendEmail({
    to: user.email,
    subject,
    html,
    text,
    tag: 'lead_alert',
  });
}

// ─── Daily digest ─────────────────────────────────────────────────────────────

/**
 * Send daily digest to all opted-in active users.
 * Covers leads created in the last 24 hours (or since midnight AEST).
 */
async function sendDailyDigest() {
  const pool = getPool();
  if (!pool) {
    console.warn('[Notifications] No DB pool — skipping daily digest');
    return;
  }

  console.log('[Notifications] Running daily digest...');

  try {
    const users = await getActiveUsers();
    const digestUsers = users.filter((u) => u.notify_daily_digest);
    if (digestUsers.length === 0) {
      console.log('[Notifications] No users opted into daily digest — skipping');
      return;
    }

    // Fetch today's lead stats (last 24h)
    const statsResult = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE lead_type = 'buyer')   AS buyers,
        COUNT(*) FILTER (WHERE lead_type = 'renter')  AS renters,
        COUNT(*) FILTER (WHERE lead_type = 'seller')  AS sellers,
        COUNT(*) FILTER (WHERE lead_type = 'landlord') AS landlords,
        COUNT(*) FILTER (WHERE lead_type IS NULL OR lead_type = '') AS unknown_type
      FROM leads
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    `);

    const avgResult = await pool.query(`
      SELECT ROUND(AVG(EXTRACT(EPOCH FROM (lr.created_at - l.created_at)))::numeric, 1) AS avg_sec
      FROM lead_responses lr
      JOIN leads l ON l.id = lr.lead_id
      WHERE lr.response_type = 'initial'
        AND lr.created_at >= NOW() - INTERVAL '24 hours'
    `);

    const recentLeadsResult = await pool.query(`
      SELECT l.id, l.name, l.lead_type, l.status, l.created_at,
             lr.created_at AS responded_at
      FROM leads l
      LEFT JOIN lead_responses lr ON lr.lead_id = l.id AND lr.response_type = 'initial'
      WHERE l.created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY l.created_at DESC
      LIMIT 20
    `);

    const stats    = statsResult.rows[0];
    const avgSec   = parseFloat(avgResult.rows[0].avg_sec);
    const avgStr   = isNaN(avgSec) ? 'n/a' : avgSec < 60 ? `${Math.round(avgSec)}s` : `${Math.round(avgSec / 60)}m`;
    const leads    = recentLeadsResult.rows;
    const total    = parseInt(stats.total, 10);
    const dashLink = `${APP_URL}/dashboard`;

    for (const user of digestUsers) {
      try {
        await sendDigestEmail({ user, total, stats, avgStr, leads, dashLink });
        console.log(`[Notifications] ✅ Digest sent to ${user.email}`);
      } catch (err) {
        console.error(`[Notifications] Digest failed for ${user.email}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Notifications] Daily digest error:', err.message);
  }
}

async function sendDigestEmail({ user, total, stats, avgStr, leads, dashLink }) {
  const today     = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Sydney' });
  const firstName = user.name ? user.name.split(' ')[0] : 'there';
  const subject   = total === 0
    ? `PropOps Daily: No new leads today`
    : `PropOps Daily: ${total} new lead${total === 1 ? '' : 's'} today`;

  const typeBreakdown = [];
  if (parseInt(stats.buyers,    10) > 0) typeBreakdown.push(`${stats.buyers} Buyer${stats.buyers == 1 ? '' : 's'}`);
  if (parseInt(stats.renters,   10) > 0) typeBreakdown.push(`${stats.renters} Renter${stats.renters == 1 ? '' : 's'}`);
  if (parseInt(stats.sellers,   10) > 0) typeBreakdown.push(`${stats.sellers} Seller${stats.sellers == 1 ? '' : 's'}`);
  if (parseInt(stats.landlords, 10) > 0) typeBreakdown.push(`${stats.landlords} Landlord${stats.landlords == 1 ? '' : 's'}`);

  const summaryLine = total === 0
    ? 'No new leads today — here\'s your pipeline summary.'
    : `${total} new lead${total === 1 ? '' : 's'} today${typeBreakdown.length ? ', ' + typeBreakdown.join(', ') : ''}. Average AI response time: ${avgStr}.`;

  const leadsTableRows = leads.map((l) => {
    const type    = capitalize(l.lead_type) || 'Unknown';
    const status  = capitalize(l.status?.replace('_', ' ')) || 'New';
    const time    = new Date(l.created_at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' });
    const statusColor = l.status === 'won' ? '#059669' : l.status === 'lost' ? '#ef4444' : l.status === 'contacted' ? '#f59e0b' : '#3b82f6';
    return `
      <tr style="border-bottom:1px solid #f1f5f9;">
        <td style="padding:10px 12px;font-size:13px;color:#0f172a;font-weight:500;">${escHtml(l.name || 'Unknown')}</td>
        <td style="padding:10px 12px;font-size:13px;color:#64748b;">${escHtml(type)}</td>
        <td style="padding:10px 12px;font-size:13px;">
          <span style="background:${statusColor}22;color:${statusColor};padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600;">${escHtml(status)}</span>
        </td>
        <td style="padding:10px 12px;font-size:13px;color:#94a3b8;">${time}</td>
      </tr>`;
  }).join('');

  const leadsTable = total > 0 ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <tr style="background:#f8fafc;border-bottom:1px solid #e2e8f0;">
        <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Name</th>
        <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Type</th>
        <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Status</th>
        <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Time</th>
      </tr>
      ${leadsTableRows}
    </table>` : '';

  const noLeadsBlock = total === 0 ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr><td style="padding:24px;background:#f8fafc;border-radius:10px;border:1px dashed #cbd5e1;text-align:center;">
        <p style="margin:0;font-size:14px;color:#94a3b8;">No new leads in the last 24 hours.</p>
        <p style="margin:8px 0 0;font-size:13px;color:#64748b;">Your pipeline is ready for the next enquiry.</p>
      </td></tr>
    </table>` : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

        <tr><td style="background:#0f172a;padding:24px 32px;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.4px;">PropOps<span style="color:#f59e0b;">.</span></p>
          <p style="margin:4px 0 0;font-size:12px;color:#94a3b8;">Daily Digest — ${today}</p>
        </td></tr>

        <tr><td style="padding:28px 32px;">

          <h1 style="margin:0 0 8px;font-size:21px;font-weight:700;color:#0f172a;line-height:1.3;">
            Good evening, ${escHtml(firstName)}
          </h1>
          <p style="margin:0 0 24px;font-size:15px;color:#334155;line-height:1.6;">
            ${summaryLine}
          </p>

          <!-- Quick stats (only shown if there were leads) -->
          ${total > 0 ? `
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr>
              <td width="33%" style="padding:0 6px 0 0;">
                <div style="background:#f8fafc;border-radius:10px;padding:16px;text-align:center;border:1px solid #e2e8f0;">
                  <p style="margin:0;font-size:26px;font-weight:700;color:#0f172a;">${total}</p>
                  <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:500;">New Leads</p>
                </div>
              </td>
              <td width="33%" style="padding:0 3px;">
                <div style="background:#f8fafc;border-radius:10px;padding:16px;text-align:center;border:1px solid #e2e8f0;">
                  <p style="margin:0;font-size:26px;font-weight:700;color:#059669;">${avgStr}</p>
                  <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:500;">Avg Response</p>
                </div>
              </td>
              <td width="33%" style="padding:0 0 0 6px;">
                <div style="background:#f8fafc;border-radius:10px;padding:16px;text-align:center;border:1px solid #e2e8f0;">
                  <p style="margin:0;font-size:26px;font-weight:700;color:#f59e0b;">${typeBreakdown.length}</p>
                  <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:500;">Lead Types</p>
                </div>
              </td>
            </tr>
          </table>` : ''}

          ${leadsTable}
          ${noLeadsBlock}

          <!-- CTA -->
          <table cellpadding="0" cellspacing="0">
            <tr><td style="background:#f59e0b;border-radius:8px;">
              <a href="${dashLink}" style="display:inline-block;padding:13px 26px;font-size:14px;font-weight:700;color:#0f172a;text-decoration:none;">
                View Full Dashboard →
              </a>
            </td></tr>
          </table>

        </td></tr>

        <tr><td style="padding:20px 32px;border-top:1px solid #e2e8f0;background:#f8fafc;">
          <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
            You're receiving this daily digest from PropOps. Adjust or turn off in your
            <a href="${dashLink}" style="color:#64748b;">Settings</a>.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const textLeads = leads.map((l) =>
    `• ${l.name || 'Unknown'} (${capitalize(l.lead_type) || 'Unknown'}) — ${capitalize(l.status) || 'New'}`
  ).join('\n');

  const text = `PropOps Daily Digest — ${today}\n\n${summaryLine}\n\n${total > 0 ? 'Leads today:\n' + textLeads + '\n\n' : ''}View your dashboard: ${dashLink}\n\n— PropOps`;

  return sendEmail({
    to: user.email,
    subject,
    html,
    text,
    tag: 'daily_digest',
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Agent notification email (dedicated Gmail address) ──────────────────────

/**
 * Send a push notification email to the agent's dedicated notification Gmail address.
 * Fired AFTER AI responds to a new lead — gives the agent the key info they need
 * to decide if/when to call the lead back.
 *
 * Only sends if the agent has set a notification_email in their settings.
 * This is a SEPARATE channel from the standard notifyNewLead() email alert —
 * that goes to the agent's account email; this goes to their dedicated Gmail inbox
 * which they can route to their phone as push notifications.
 *
 * @param {object} lead           - Lead row from DB
 * @param {object|null} aiResponse - lead_responses row (may be null if AI failed)
 * @param {number} responseTimeSec - Time from lead created → AI response in seconds
 * @param {string} notificationEmail - The agent's dedicated notification Gmail address
 * @param {string} agentName      - Agent's display name (for the "from" display)
 */
async function sendNewLeadNotificationEmail(lead, aiResponse, responseTimeSec, notificationEmail, agentName) {
  if (!notificationEmail || !notificationEmail.includes('@')) return;

  const leadType = capitalize(lead.lead_type) || 'Unknown';
  const leadName = lead.name || 'Unknown';
  const property = lead.property_interest || null;
  const phone    = lead.phone || null;
  const email    = lead.email || null;
  const dashLink = `${APP_URL}/dashboard`;
  const timeStr  = `${Math.round(responseTimeSec || 0)}s`;

  // Build tap-to-call and tap-to-email links
  const telLink  = phone ? `tel:${phone.replace(/\s/g, '')}` : null;
  const mailLink  = email ? `mailto:${email}` : null;

  // Build property row (only if we have a property)
  const propertyRow = property ? `
    <tr><td style="padding:6px 0;font-size:13px;color:#94a3b8;">Property</td>
        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:500;">${escHtml(property)}</td></tr>` : '';

  const phoneRow = phone ? `
    <tr><td style="padding:6px 0;font-size:13px;color:#94a3b8;">Phone</td>
        <td style="padding:6px 0;font-size:14px;font-weight:700;color:#0f172a;"><a href="${telLink}" style="color:#0f172a;text-decoration:none;">${escHtml(phone)}</a></td></tr>` : '';

  const emailRow = email ? `
    <tr><td style="padding:6px 0;font-size:13px;color:#94a3b8;">Email</td>
        <td style="padding:6px 0;font-size:13px;"><a href="${mailLink}" style="color:#2563eb;text-decoration:none;">${escHtml(email)}</a></td></tr>` : '';

  const aiBadge = aiResponse
    ? `<span style="background:#dcfce7;color:#16a34a;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;">✓ AI response sent</span>`
    : `<span style="background:#fef9c3;color:#ca8a04;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;">⚠ AI response pending</span>`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:24px 16px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);border:1px solid #e2e8f0;">

        <!-- Header bar -->
        <tr><td style="background:#0f172a;padding:18px 28px;">
          <p style="margin:0;font-size:17px;font-weight:700;color:#fff;letter-spacing:-0.3px;">PropOps<span style="color:#f59e0b;">.</span>
          <span style="font-size:12px;font-weight:400;color:#94a3b8;margin-left:8px;">🔔 New Lead</span>
          </p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:24px 28px;">

          <!-- Lead name + type row -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;">
            <tr>
              <td>
                <p style="margin:0 0 4px;font-size:22px;font-weight:800;color:#0f172a;letter-spacing:-0.5px;">${escHtml(leadName)}</p>
                <p style="margin:0;font-size:13px;color:#64748b;">
                  <span style="background:#f1f5f9;padding:2px 8px;border-radius:6px;font-weight:600;">${escHtml(leadType)}</span>
                  &nbsp;${aiBadge}
                </p>
              </td>
            </tr>
          </table>

          ${property ? `<p style="margin:0 0 16px;font-size:13px;color:#64748b;">📍 ${escHtml(property)}</p>` : ''}

          <!-- Contact card — phone front and centre -->
          ${phone ? `
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;overflow:hidden;">
            <tr>
              <td style="padding:14px 18px;border-bottom:1px solid #e2e8f0;">
                <p style="margin:0 0 3px;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;">📞 Call now</p>
                <a href="${telLink}" style="font-size:22px;font-weight:800;color:#0f172a;text-decoration:none;letter-spacing:-0.5px;">${escHtml(phone)}</a>
              </td>
            </tr>
            ${email ? `<tr>
              <td style="padding:12px 18px;">
                <p style="margin:0 0 3px;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;">✉️ Email</p>
                <a href="${mailLink}" style="font-size:14px;color:#2563eb;text-decoration:none;">${escHtml(email)}</a>
              </td>
            </tr>` : ''}
          </table>` : (email ? `
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;overflow:hidden;">
            <tr>
              <td style="padding:14px 18px;">
                <p style="margin:0 0 3px;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;">✉️ Email</p>
                <a href="${mailLink}" style="font-size:16px;font-weight:700;color:#2563eb;text-decoration:none;">${escHtml(email)}</a>
              </td>
            </tr>
          </table>` : '')}

          <!-- Lead details table -->
          ${propertyRow || phoneRow || emailRow ? `
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
            <tr><td style="background:#f8fafc;padding:8px 14px;border-bottom:1px solid #e2e8f0;">
              <p style="margin:0;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Lead Details</p>
            </td></tr>
            <tr><td style="padding:4px 14px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                ${propertyRow}
                ${phoneRow}
                ${emailRow}
                <tr><td style="padding:6px 0;font-size:13px;color:#94a3b8;">Response time</td>
                    <td style="padding:6px 0;font-size:13px;color:#059669;font-weight:600;">${timeStr}</td></tr>
              </table>
            </td></tr>
          </table>` : ''}

          <!-- Dashboard CTA -->
          <table cellpadding="0" cellspacing="0">
            <tr><td style="background:#f59e0b;border-radius:8px;">
              <a href="${dashLink}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:700;color:#0f172a;text-decoration:none;">
                View Lead in Dashboard →
              </a>
            </td></tr>
          </table>

        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:16px 28px;border-top:1px solid #f1f5f9;background:#f8fafc;">
          <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
            🔔 This is a notification only — do not reply to this email.<br>
            Use the <a href="${dashLink}" style="color:#64748b;">dashboard</a> or call the lead directly to respond.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `New Lead — ${leadName} (${leadType})\n${property ? 'Property: ' + property + '\n' : ''}${phone ? 'Phone: ' + phone + '\n' : ''}${email ? 'Email: ' + email + '\n' : ''}AI response: ${aiResponse ? 'sent (' + timeStr + ')' : 'pending'}\n\nView lead: ${dashLink}\n\nThis is a notification only — do not reply to this email.`;

  return sendEmail({
    to: notificationEmail,
    subject: `🔔 New Lead — ${leadName} (${leadType})`,
    html,
    text,
    tag: 'lead_alert',
  });
}

module.exports = { notifyNewLead, sendDailyDigest, sendNewLeadNotificationEmail };
