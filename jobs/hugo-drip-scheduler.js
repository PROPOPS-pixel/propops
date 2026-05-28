/**
 * Hugo Drip Scheduler — processes the outbound drip queue each morning.
 *
 * This script is triggered by polsia.toml [[crons]] at 9:00 AM AEST Mon-Fri.
 * It processes all pending hugo_drip_queue entries whose target_send_date is today,
 * respecting the Resend 100/day limit.
 *
 * No in-process scheduler — just pure batch logic.
 *
 * Drip logic:
 *   Day 0: Initial cold outreach email
 *   Day 3: Follow-up if no reply
 *   Day 7: Final follow-up if still no reply
 *   Any reply → REPLIED state (stops drip)
 *   Unsubscribe → UNSUBSCRIBED state (stops drip)
 */

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 2,
});

const { sendDripEmail, getTodaySentCount, DAILY_LIMIT } = require('../services/hugo-drip-resend');
const { buildDripHtmlBody } = require('../services/flyerService');

// ─── Day / time guards ─────────────────────────────────────────────────────────

const AEST_OFFSET_HOURS = 10; // UTC+10

function isAestWeekday() {
  const now = new Date();
  // Convert to AEST (approx — UTC+10, no DST in NSW)
  const aestHour = (now.getUTCHours() + AEST_OFFSET_HOURS) % 24;
  const aestDay = (now.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  // Mon–Fri = 0–4
  return aestDay >= 0 && aestDay <= 4;
}

function isAestBusinessHours() {
  const now = new Date();
  const aestHour = (now.getUTCHours() + AEST_OFFSET_HOURS) % 24;
  return aestHour >= 8 && aestHour <= 18; // 8 AM – 6 PM AEST
}

// ─── Fetch lead details for email composition ──────────────────────────────────

async function getLeadForDrip(leadId) {
  const r = await pool.query(
    `SELECT l.id, l.name, l.email, l.phone, l.service AS job_type,
            l.source, l.property_interest AS description, l.lead_type,
            u.name AS operator_name, u.business_type,
            op.trade_type, op.business_name AS operator_business
     FROM leads l
     LEFT JOIN users u ON l.operator_id = u.id
     LEFT JOIN operator_profiles op ON u.id = op.operator_id
     WHERE l.id = $1`,
    [leadId]
  );
  return r.rows[0] || null;
}

// ─── Generate drip email content ────────────────────────────────────────────────

const DRIP_SUBJECTS = {
  cold_drip_day0: (lead) => `Quick question about your ${lead.job_type || 'property'} needs`,
  cold_drip_day3: (lead) => `Following up — still looking for a ${lead.job_type || 'tradie'}?`,
  cold_drip_day7: (lead) => `Last note — can I help with your ${lead.job_type || 'job'}?`,
};

const DRIP_BODIES = {
  cold_drip_day0: (lead) =>
    `${lead.name ? `Hi ${lead.name.split(' ')[0]},` : 'Hi,'}

I noticed you're looking for ${lead.job_type || 'property services'} in ${lead.service || 'your area'}.

I run PropOps — we handle the lot. From emergency call-outs to scheduled work, we're set up for Australian tradies and property managers who need someone reliable.

No fluff, no call-centre. Just a real tradie who shows up.

Want to chat?
— Hugo from PropOps
propops.pro`,

  cold_drip_day3: (lead) =>
    `${lead.name ? `Hi ${lead.name.split(' ')[0]},` : 'Hi,'}

Just following up on the ${lead.job_type || 'work'} you were after — did you find someone sorted, or are you still looking?

We've helped a heap of property managers in your area sort out their maintenance without the back-and-forth. Worth a quick chat if you're not locked in yet.

— Hugo
propops.pro`,

  cold_drip_day7: (lead) =>
    `${lead.name ? `Hi ${lead.name.split(' ')[0]},` : 'Hi,'}

I'll leave you alone after this one — just wanted to make sure you saw this.

We're PropOps. One place to book any tradie, any job, any time. Used by property managers and owners across NSW.

If you're sorted, ignore and I'll stop. If not — we're one click away: propops.pro

— Hugo`,
};

// ─── Main batch process ────────────────────────────────────────────────────────

async function processDripBatch() {
  if (!isAestWeekday()) {
    console.log('[HugoDripScheduler] Not a weekday in AEST — skipping');
    return { sent: 0, skipped: 0, reason: 'weekend' };
  }

  const stats = { sent: 0, skipped: 0, errors: 0, daily_limit: false };

  // Check Resend daily limit
  const sentToday = await getTodaySentCount();
  const remaining = DAILY_LIMIT - sentToday;
  if (remaining <= 0) {
    console.log(`[HugoDripScheduler] Resend daily limit reached (${sentToday}/${DAILY_LIMIT})`);
    stats.daily_limit = true;
    return stats;
  }

  // Fetch pending queue entries due today
  const todayAEST = new Date();
  const todayStr = todayAEST.toISOString().split('T')[0]; // YYYY-MM-DD in UTC (close enough for daily batch)

  let rows;
  try {
    const r = await pool.query(
      `SELECT q.id, q.lead_id, q.drip_day, q.email_type,
              l.name, l.email, l.service, l.status AS lead_status, l.drip_status
       FROM hugo_drip_queue q
       JOIN leads l ON q.lead_id = l.id
       WHERE q.status = 'pending'
         AND q.target_send_date <= CURRENT_DATE
       ORDER BY q.target_send_date ASC, q.drip_day ASC
       LIMIT $1`,
      [remaining]
    );
    rows = r.rows;
  } catch (err) {
    // Table may not exist yet (migration not applied)
    console.warn('[HugoDripScheduler] Could not query drip queue:', err.message);
    return stats;
  }

  if (!rows.length) {
    console.log('[HugoDripScheduler] No pending drip emails to send');
    return stats;
  }

  console.log(`[HugoDripScheduler] Processing ${rows.length} pending drip email(s)`);

  for (const row of rows) {
    try {
      // Skip if lead already replied or unsubscribed
      if (row.drip_status === 'replied' || row.drip_status === 'unsubscribed' || row.drip_status === 'bounced') {
        await markQueueSkipped(row.id, 'lead_status_final');
        stats.skipped++;
        continue;
      }

      const lead = await getLeadForDrip(row.lead_id);
      if (!lead || !lead.email) {
        await markQueueFailed(row.id, 'no_email');
        stats.skipped++;
        continue;
      }

      const subject = DRIP_SUBJECTS[row.email_type] ? DRIP_SUBJECTS[row.email_type](lead) : 'Update from PropOps';
      const body = DRIP_BODIES[row.email_type] ? DRIP_BODIES[row.email_type](lead) : 'Hi, just checking in.';
      const htmlBody = buildDripHtmlBody(body, lead.lead_type || null);

      const result = await sendDripEmail({
        to: lead.email,
        subject,
        textBody: body,
        htmlBody,
        leadId: row.lead_id,
        emailType: row.email_type,
      });

      if (result.blocked) {
        await markQueueSkipped(row.id, result.error);
        stats.skipped++;
        continue;
      }

      if (!result.success && result.error === 'daily_limit_reached') {
        stats.daily_limit = true;
        break;
      }

      if (result.success) {
        // Update lead drip status
        const statusCol = row.drip_day === 0 ? 'drip_sent_day_0_at' : row.drip_day === 3 ? 'drip_sent_day_3_at' : 'drip_sent_day_7_at';
        await pool.query(
          `UPDATE leads SET drip_status = $1, ${statusCol} = NOW() WHERE id = $2`,
          [`sent_day_${row.drip_day}`, row.lead_id]
        );
        stats.sent++;
      } else {
        await markQueueFailed(row.id, result.error || 'unknown');
        stats.errors++;
      }
    } catch (err) {
      console.error(`[HugoDripScheduler] Error processing lead ${row.lead_id}:`, err.message);
      await markQueueFailed(row.id, err.message.slice(0, 200));
      stats.errors++;
    }
  }

  console.log(`[HugoDripScheduler] Done — sent=${stats.sent} skipped=${stats.skipped} errors=${stats.errors}`);
  return stats;
}

async function markQueueSkipped(queueId, reason) {
  await pool.query(
    `UPDATE hugo_drip_queue SET status = 'skipped' WHERE id = $1`,
    [queueId]
  ).catch(() => {});
}

async function markQueueFailed(queueId, errorMessage) {
  await pool.query(
    `UPDATE hugo_drip_queue SET status = 'failed', error_message = $1 WHERE id = $2`,
    [errorMessage.slice(0, 500), queueId]
  ).catch(() => {});
}

// ─── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    try {
      console.log('[HugoDripScheduler] Starting drip batch...');
      const result = await processDripBatch();
      console.log('[HugoDripScheduler] Result:', JSON.stringify(result));
      process.exit(0);
    } catch (err) {
      console.error('[HugoDripScheduler] Fatal error:', err.message);
      process.exit(1);
    } finally {
      await pool.end().catch(() => {});
    }
  })();
}

module.exports = { processDripBatch };