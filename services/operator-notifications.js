/**
 * Operator notification service — real-time lead alerts + daily digest for Hugo tradie operators.
 *
 * Owns: sendOperatorLeadAlert(), sendOperatorDailyDigest(), sendFounderDigest().
 * Does NOT own: operator auth, lead matching, AI responses — those are caller responsibility.
 *
 * Two functions:
 *   sendOperatorLeadAlert(lead)           — immediate email when Hugo qualifies a lead for an operator
 *   sendOperatorDailyDigest()             — 8am AEST daily digest per operator (skips if no new activity)
 *
 * Founder (gassin123@gmail.com) gets a cross-trade overview digest on the same schedule.
 * All emails use the existing sendEmail() provider chain (Resend → Postmark → Polsia proxy).
 */

const { sendEmail } = require('./email');
const { Pool } = require('pg');

const APP_URL = process.env.APP_URL || 'https://propopspro.polsia.app';
const FOUNDER_EMAIL = process.env.FOUNDER_DIGEST_EMAIL || 'gassin123@gmail.com';

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

// ─── HTML escaping ─────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cap(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).replace(/_/g, ' ');
}

// ─── sendOperatorLeadAlert ─────────────────────────────────────────────────────
/**
 * Send an immediate lead alert email to the operator assigned this lead.
 *
 * @param {object} lead — Row from network_leads, must include assigned_operator_id.
 */
async function sendOperatorLeadAlert(lead) {
  const pool = getPool();
  if (!pool || !lead || !lead.assigned_operator_id) return;

  try {
    // Fetch operator prefs — check they want instant alerts
    const userRow = await pool.query(
      `SELECT u.email, u.name, u.notification_email,
              COALESCE(u.notify_email_per_lead, TRUE) AS notify_instant
       FROM users u
       WHERE u.id = $1`,
      [lead.assigned_operator_id]
    );

    const op = userRow.rows[0];
    if (!op) {
      console.warn(`[OpNotify] Operator ${lead.assigned_operator_id} not found — skipping lead alert`);
      return;
    }
    if (!op.notify_instant) {
      console.log(`[OpNotify] Operator ${op.email} has instant alerts disabled — skipping`);
      return;
    }

    // Send to notification_email if set, otherwise account email
    const toEmail = op.notification_email || op.email;
    if (!toEmail) return;

    const firstName = op.name ? op.name.split(' ')[0] : 'there';
    const trade     = cap(lead.trade) || 'Trade';
    const suburb    = lead.suburb || null;
    const job       = lead.job_description || null;
    const urgency   = lead.urgency || null;
    const name      = lead.contact_name || null;
    const phone     = lead.contact_phone || null;
    const email     = lead.contact_email || null;
    const dashLink  = `${APP_URL}/dashboard`;

    const urgencyLabel = urgency === 'today' ? '🔴 Urgent — Today' :
                         urgency === 'this_week' ? '🟡 This Week' :
                         urgency === 'getting_quotes' ? '🟢 Getting Quotes' : null;

    const urgencyRow = urgencyLabel ? `
      <tr>
        <td style="padding:6px 0;font-size:14px;color:#64748b;width:130px;">Urgency</td>
        <td style="padding:6px 0;font-size:14px;color:#0f172a;font-weight:500;">${esc(urgencyLabel)}</td>
      </tr>` : '';

    const suburbRow = suburb ? `
      <tr>
        <td style="padding:6px 0;font-size:14px;color:#64748b;">Location</td>
        <td style="padding:6px 0;font-size:14px;color:#0f172a;font-weight:500;">${esc(suburb)}</td>
      </tr>` : '';

    const phoneRow = phone ? `
      <tr>
        <td style="padding:6px 0;font-size:14px;color:#64748b;">Phone</td>
        <td style="padding:6px 0;font-size:15px;font-weight:700;color:#0f172a;">
          <a href="tel:${esc(phone.replace(/\s/g, ''))}" style="color:#0f172a;text-decoration:none;">${esc(phone)}</a>
        </td>
      </tr>` : '';

    const emailRow = email ? `
      <tr>
        <td style="padding:6px 0;font-size:14px;color:#64748b;">Email</td>
        <td style="padding:6px 0;font-size:14px;color:#0f172a;">
          <a href="mailto:${esc(email)}" style="color:#2563eb;text-decoration:none;">${esc(email)}</a>
        </td>
      </tr>` : '';

    const jobBlock = job ? `
      <tr>
        <td colspan="2" style="padding:10px 0 0;">
          <p style="margin:0;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Job Description</p>
          <p style="margin:6px 0 0;font-size:14px;color:#334155;line-height:1.6;background:#f8fafc;border-left:3px solid #f59e0b;padding:10px 12px;border-radius:0 6px 6px 0;">${esc(job)}</p>
        </td>
      </tr>` : '';

    const subjectSuffix = name ? ` — ${name}` : (suburb ? ` in ${suburb}` : '');
    const subject = `⚡ New ${trade} Lead${subjectSuffix}`;

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

        <tr><td style="background:#0f172a;padding:20px 28px;">
          <p style="margin:0;font-size:18px;font-weight:700;color:#fff;letter-spacing:-0.3px;">
            Hugo<span style="color:#f59e0b;">.</span>trades
            <span style="font-size:12px;font-weight:400;color:#94a3b8;margin-left:10px;">⚡ New Lead Alert</span>
          </p>
        </td></tr>

        <tr><td style="padding:24px 28px;">

          <!-- Badge -->
          <table cellpadding="0" cellspacing="0" style="margin-bottom:18px;">
            <tr><td style="background:#fef3c7;border:1px solid #fde68a;border-radius:20px;padding:5px 14px;">
              <p style="margin:0;font-size:12px;font-weight:700;color:#b45309;letter-spacing:0.5px;">⚡ NEW ${esc(trade.toUpperCase())} LEAD</p>
            </td></tr>
          </table>

          <h1 style="margin:0 0 4px;font-size:20px;font-weight:700;color:#0f172a;line-height:1.3;">
            ${name ? esc(name) : 'New enquiry'}
            ${suburb ? `<span style="font-size:14px;font-weight:400;color:#64748b;"> · ${esc(suburb)}</span>` : ''}
          </h1>
          <p style="margin:0 0 20px;font-size:14px;color:#64748b;">Hugo just qualified this lead for your trade.</p>

          <!-- Lead details -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
            <tr><td style="background:#f8fafc;padding:10px 14px;border-bottom:1px solid #e2e8f0;">
              <p style="margin:0;font-size:11px;font-weight:600;color:#64748b;letter-spacing:0.5px;text-transform:uppercase;">Lead Details</p>
            </td></tr>
            <tr><td style="padding:8px 14px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                ${suburbRow}
                ${urgencyRow}
                ${phoneRow}
                ${emailRow}
                ${jobBlock}
              </table>
            </td></tr>
          </table>

          <!-- CTA -->
          <table cellpadding="0" cellspacing="0">
            <tr><td style="background:#f59e0b;border-radius:8px;">
              <a href="${dashLink}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:700;color:#0f172a;text-decoration:none;">
                View in Dashboard →
              </a>
            </td></tr>
          </table>

        </td></tr>

        <tr><td style="padding:16px 28px;border-top:1px solid #e2e8f0;background:#f8fafc;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">
            You're getting this because instant lead alerts are on. Turn off in
            <a href="${dashLink}" style="color:#64748b;">Settings</a>.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const textParts = [
      `New ${trade} Lead${name ? ' — ' + name : ''}`,
      '',
      suburb ? `Location: ${suburb}` : '',
      urgency ? `Urgency: ${urgencyLabel}` : '',
      phone ? `Phone: ${phone}` : '',
      email ? `Email: ${email}` : '',
      job ? `\nJob: ${job}` : '',
      '',
      `View in dashboard: ${dashLink}`,
    ].filter((l) => l !== null).join('\n');

    await sendEmail({
      to: toEmail,
      subject,
      html,
      text: textParts,
      tag: 'operator_lead_alert',
    });

    console.log(`[OpNotify] ✅ Lead alert sent to ${toEmail} for lead #${lead.id} (${trade})`);
  } catch (err) {
    // Never crash the main lead-save flow
    console.error(`[OpNotify] Lead alert error for lead #${lead.id}:`, err.message);
  }
}

// ─── sendOperatorDailyDigest ───────────────────────────────────────────────────
/**
 * Send 8am AEST daily digest to each operator who had new activity since their last digest.
 * Skips operators with no new leads, calls, or emails.
 * Also sends founder cross-trade overview.
 */
async function sendOperatorDailyDigest() {
  const pool = getPool();
  if (!pool) {
    console.warn('[OpNotify] No DB pool — skipping operator digest');
    return;
  }

  console.log('[OpNotify] Running operator daily digest...');

  try {
    // Fetch all opted-in operators
    const opsResult = await pool.query(`
      SELECT u.id, u.email, u.name, u.last_digest_sent_at,
             COALESCE(u.notify_daily_digest, TRUE) AS want_digest,
             op.trade_type, op.business_name
      FROM users u
      LEFT JOIN operator_profiles op ON op.operator_id = u.id
      WHERE u.subscription_status IN ('trial', 'active')
        AND COALESCE(u.notify_daily_digest, TRUE) = TRUE
        AND u.email IS NOT NULL
    `);

    const operators = opsResult.rows;
    if (operators.length === 0) {
      console.log('[OpNotify] No opted-in operators — skipping digest');
    }

    let totalSent = 0;
    let totalSkipped = 0;

    for (const op of operators) {
      try {
        const sent = await _sendDigestForOperator(pool, op);
        if (sent) {
          totalSent++;
          // Update last_digest_sent_at watermark
          await pool.query(
            `UPDATE users SET last_digest_sent_at = NOW() WHERE id = $1`,
            [op.id]
          );
        } else {
          totalSkipped++;
        }
      } catch (err) {
        console.error(`[OpNotify] Digest error for operator ${op.email}:`, err.message);
      }
    }

    console.log(`[OpNotify] Digest complete: ${totalSent} sent, ${totalSkipped} skipped (no activity)`);

    // Founder digest — cross-trade overview
    await _sendFounderDailyDigest(pool).catch(err =>
      console.error('[OpNotify] Founder digest error:', err.message)
    );

  } catch (err) {
    console.error('[OpNotify] Daily digest fatal error:', err.message);
  }
}

/**
 * Send digest for one operator. Returns true if email was sent, false if skipped (no activity).
 */
async function _sendDigestForOperator(pool, op) {
  // Watermark: last digest or 24h ago, whichever is more recent
  const since = op.last_digest_sent_at
    ? new Date(op.last_digest_sent_at)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Count new leads assigned to this operator since last digest
  const leadsResult = await pool.query(`
    SELECT nl.id, nl.trade, nl.suburb, nl.urgency, nl.contact_name,
           nl.contact_phone, nl.contact_email, nl.created_at
    FROM network_leads nl
    WHERE nl.assigned_operator_id = $1
      AND nl.created_at > $2
    ORDER BY nl.created_at DESC
    LIMIT 20
  `, [op.id, since]);

  // Count calls (from hugo_widget_sessions if session has operator context)
  // We use a conservative count: Hugo sessions that had AI interactions via this operator
  const callsResult = await pool.query(`
    SELECT COUNT(*) AS calls_count
    FROM hugo_widget_sessions hws
    WHERE hws.operator_id = $1
      AND hws.created_at > $2
  `, [op.id, since]).catch(() => ({ rows: [{ calls_count: 0 }] }));

  // Count emails processed (from operator_emails table)
  const emailsResult = await pool.query(`
    SELECT COUNT(*) AS emails_count
    FROM operator_emails oe
    WHERE oe.operator_id = $1
      AND oe.received_at > $2
  `, [op.id, since]).catch(() => ({ rows: [{ emails_count: 0 }] }));

  const newLeads  = leadsResult.rows;
  const callCount = parseInt(callsResult.rows[0]?.calls_count || 0, 10);
  const emailCount = parseInt(emailsResult.rows[0]?.emails_count || 0, 10);

  const hasActivity = newLeads.length > 0 || callCount > 0 || emailCount > 0;

  // Skip if zero activity — CRITICAL: no empty digests
  if (!hasActivity) {
    return false;
  }

  const toEmail   = op.email;
  const firstName = op.name ? op.name.split(' ')[0] : 'there';
  const trade     = cap(op.trade_type) || 'Trades';
  const dashLink  = `${APP_URL}/dashboard`;

  const today = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'Australia/Sydney'
  });

  const subject = `Hugo Daily: ${newLeads.length > 0 ? `${newLeads.length} new lead${newLeads.length !== 1 ? 's' : ''}` : `${callCount + emailCount} activity`} since yesterday`;

  // Build leads table rows
  const leadsRows = newLeads.map(l => {
    const urgColor = l.urgency === 'today' ? '#ef4444' :
                     l.urgency === 'this_week' ? '#f59e0b' : '#059669';
    const urgLabel = l.urgency === 'today' ? 'Urgent' :
                     l.urgency === 'this_week' ? 'This week' : 'Quotes';
    return `
      <tr style="border-bottom:1px solid #f1f5f9;">
        <td style="padding:10px 12px;font-size:13px;color:#0f172a;font-weight:500;">${esc(l.contact_name || 'Unknown')}</td>
        <td style="padding:10px 12px;font-size:13px;color:#64748b;">${esc(l.suburb || '—')}</td>
        <td style="padding:10px 12px;font-size:12px;">
          ${l.urgency ? `<span style="background:${urgColor}22;color:${urgColor};padding:2px 8px;border-radius:12px;font-weight:600;">${esc(urgLabel)}</span>` : '—'}
        </td>
        <td style="padding:10px 12px;font-size:12px;color:#94a3b8;">
          ${new Date(l.created_at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' })}
        </td>
      </tr>`;
  }).join('');

  const leadsTable = newLeads.length > 0 ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <tr style="background:#f8fafc;border-bottom:1px solid #e2e8f0;">
        <th style="padding:9px 12px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Name</th>
        <th style="padding:9px 12px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Location</th>
        <th style="padding:9px 12px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Urgency</th>
        <th style="padding:9px 12px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Time</th>
      </tr>
      ${leadsRows}
    </table>` : '';

  const statsRow = `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td width="32%" style="padding:0 6px 0 0;">
          <div style="background:#f8fafc;border-radius:10px;padding:14px;text-align:center;border:1px solid #e2e8f0;">
            <p style="margin:0;font-size:26px;font-weight:700;color:#0f172a;">${newLeads.length}</p>
            <p style="margin:3px 0 0;font-size:12px;color:#64748b;font-weight:500;">New Leads</p>
          </div>
        </td>
        <td width="32%" style="padding:0 3px;">
          <div style="background:#f8fafc;border-radius:10px;padding:14px;text-align:center;border:1px solid #e2e8f0;">
            <p style="margin:0;font-size:26px;font-weight:700;color:#2563eb;">${callCount}</p>
            <p style="margin:3px 0 0;font-size:12px;color:#64748b;font-weight:500;">Chat Sessions</p>
          </div>
        </td>
        <td width="32%" style="padding:0 0 0 6px;">
          <div style="background:#f8fafc;border-radius:10px;padding:14px;text-align:center;border:1px solid #e2e8f0;">
            <p style="margin:0;font-size:26px;font-weight:700;color:#8b5cf6;">${emailCount}</p>
            <p style="margin:3px 0 0;font-size:12px;color:#64748b;font-weight:500;">Emails In</p>
          </div>
        </td>
      </tr>
    </table>`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

        <tr><td style="background:#0f172a;padding:20px 28px;">
          <p style="margin:0;font-size:18px;font-weight:700;color:#fff;letter-spacing:-0.3px;">Hugo<span style="color:#f59e0b;">.</span>trades</p>
          <p style="margin:3px 0 0;font-size:12px;color:#94a3b8;">Daily Summary — ${today}</p>
        </td></tr>

        <tr><td style="padding:24px 28px;">
          <h1 style="margin:0 0 6px;font-size:20px;font-weight:700;color:#0f172a;">G'day, ${esc(firstName)}</h1>
          <p style="margin:0 0 22px;font-size:14px;color:#64748b;">Here's what happened since your last digest.</p>

          ${statsRow}
          ${leadsTable}

          ${newLeads.length === 0 ? `
          <p style="margin:0 0 20px;font-size:14px;color:#64748b;background:#f8fafc;padding:14px 16px;border-radius:8px;border:1px dashed #cbd5e1;">
            No new leads yet — Hugo handled ${callCount} chat session${callCount !== 1 ? 's' : ''} and ${emailCount} email${emailCount !== 1 ? 's' : ''} on your behalf.
          </p>` : ''}

          <table cellpadding="0" cellspacing="0">
            <tr><td style="background:#f59e0b;border-radius:8px;">
              <a href="${dashLink}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:700;color:#0f172a;text-decoration:none;">
                View Dashboard →
              </a>
            </td></tr>
          </table>

        </td></tr>

        <tr><td style="padding:16px 28px;border-top:1px solid #e2e8f0;background:#f8fafc;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">
            Daily digest from Hugo. Adjust in
            <a href="${dashLink}" style="color:#64748b;">Settings</a>.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const textLines = [
    `Hugo Daily Summary — ${today}`,
    `G'day, ${firstName}`,
    '',
    `New Leads: ${newLeads.length}  |  Chat Sessions: ${callCount}  |  Emails In: ${emailCount}`,
    '',
  ];

  if (newLeads.length > 0) {
    textLines.push('Leads today:');
    newLeads.forEach(l => {
      textLines.push(`• ${l.contact_name || 'Unknown'} — ${l.suburb || '—'} (${l.urgency || 'getting quotes'})`);
    });
    textLines.push('');
  }

  textLines.push(`View dashboard: ${dashLink}`);

  await sendEmail({
    to: toEmail,
    subject,
    html,
    text: textLines.join('\n'),
    tag: 'operator_daily_digest',
  });

  console.log(`[OpNotify] ✅ Digest sent to ${toEmail} (${newLeads.length} leads, ${callCount} calls, ${emailCount} emails)`);
  return true;
}

// ─── Founder cross-trade digest ────────────────────────────────────────────────

async function _sendFounderDailyDigest(pool) {
  // Last 24h summary across all trades
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const leadsResult = await pool.query(`
    SELECT trade, COUNT(*) AS count,
           COUNT(*) FILTER (WHERE urgency = 'today') AS urgent_count,
           COUNT(*) FILTER (WHERE assigned_operator_id IS NOT NULL) AS matched_count
    FROM network_leads
    WHERE created_at > $1
    GROUP BY trade
    ORDER BY count DESC
  `, [since]);

  const signupsResult = await pool.query(`
    SELECT COUNT(*) AS count FROM network_signups WHERE created_at > $1
  `, [since]);

  const totalLeads   = leadsResult.rows.reduce((s, r) => s + parseInt(r.count, 10), 0);
  const totalSignups = parseInt(signupsResult.rows[0]?.count || 0, 10);

  // No activity check — skip founder too if nothing happened
  if (totalLeads === 0 && totalSignups === 0) {
    console.log('[OpNotify] No activity for founder digest — skipping');
    return;
  }

  const today = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'Australia/Sydney'
  });

  const subject = `Hugo Founder Digest — ${totalLeads} lead${totalLeads !== 1 ? 's' : ''}, ${totalSignups} signup${totalSignups !== 1 ? 's' : ''}`;

  const tradeRows = leadsResult.rows.map(r => `
    <tr style="border-bottom:1px solid #f1f5f9;">
      <td style="padding:9px 12px;font-size:13px;font-weight:500;color:#0f172a;">${esc(cap(r.trade))}</td>
      <td style="padding:9px 12px;font-size:13px;color:#0f172a;text-align:center;font-weight:700;">${r.count}</td>
      <td style="padding:9px 12px;font-size:13px;color:#ef4444;text-align:center;">${r.urgent_count}</td>
      <td style="padding:9px 12px;font-size:13px;color:#059669;text-align:center;">${r.matched_count}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

        <tr><td style="background:#0f172a;padding:20px 28px;">
          <p style="margin:0;font-size:18px;font-weight:700;color:#fff;">Hugo<span style="color:#f59e0b;">.</span> Founder Digest</p>
          <p style="margin:3px 0 0;font-size:12px;color:#94a3b8;">${today} · Cross-Trade Overview</p>
        </td></tr>

        <tr><td style="padding:24px 28px;">

          <!-- Top stats -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr>
              <td width="50%" style="padding:0 6px 0 0;">
                <div style="background:#0f172a;border-radius:10px;padding:16px;text-align:center;">
                  <p style="margin:0;font-size:32px;font-weight:800;color:#f59e0b;">${totalLeads}</p>
                  <p style="margin:3px 0 0;font-size:12px;color:#94a3b8;">Total Leads</p>
                </div>
              </td>
              <td width="50%" style="padding:0 0 0 6px;">
                <div style="background:#f8fafc;border-radius:10px;padding:16px;text-align:center;border:1px solid #e2e8f0;">
                  <p style="margin:0;font-size:32px;font-weight:800;color:#059669;">${totalSignups}</p>
                  <p style="margin:3px 0 0;font-size:12px;color:#64748b;">New Signups</p>
                </div>
              </td>
            </tr>
          </table>

          <!-- Per-trade breakdown -->
          ${leadsResult.rows.length > 0 ? `
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
            <tr style="background:#f8fafc;border-bottom:1px solid #e2e8f0;">
              <th style="padding:9px 12px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Trade</th>
              <th style="padding:9px 12px;text-align:center;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Leads</th>
              <th style="padding:9px 12px;text-align:center;font-size:11px;color:#ef4444;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Urgent</th>
              <th style="padding:9px 12px;text-align:center;font-size:11px;color:#059669;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Matched</th>
            </tr>
            ${tradeRows}
          </table>` : ''}

          <table cellpadding="0" cellspacing="0">
            <tr><td style="background:#f59e0b;border-radius:8px;">
              <a href="${APP_URL}/founder" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:700;color:#0f172a;text-decoration:none;">
                Open Founder Dashboard →
              </a>
            </td></tr>
          </table>

        </td></tr>

        <tr><td style="padding:16px 28px;border-top:1px solid #e2e8f0;background:#f8fafc;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">Founder digest — last 24h cross-trade summary.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Hugo Founder Digest — ${today}`,
    '',
    `Total Leads: ${totalLeads}  |  New Signups: ${totalSignups}`,
    '',
    'By Trade:',
    ...leadsResult.rows.map(r => `  ${cap(r.trade)}: ${r.count} leads (${r.urgent_count} urgent, ${r.matched_count} matched)`),
    '',
    `Founder dashboard: ${APP_URL}/founder`,
  ].join('\n');

  await sendEmail({
    to: FOUNDER_EMAIL,
    subject,
    html,
    text,
    tag: 'founder_daily_digest',
  });

  console.log(`[OpNotify] ✅ Founder digest sent to ${FOUNDER_EMAIL} (${totalLeads} leads, ${totalSignups} signups)`);
}

module.exports = { sendOperatorLeadAlert, sendOperatorDailyDigest };
