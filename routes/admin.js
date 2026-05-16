/**
 * Admin routes — internal management endpoints.
 *
 * Owns: admin cron triggers, sync status, content changelog, alerts,
 *       payment issues, grace periods, support contact form, screenshot cache.
 * Does NOT own: Hugo brain logic, billing, auth, leads.
 *
 * All admin endpoints require ADMIN_TOKEN header or is_admin session cookie.
 * Support contact (/api/support/contact) is public.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── Admin auth helper ─────────────────────────────────────────────────────────
async function isAdminRequest(req) {
  const adminToken = process.env.ADMIN_TOKEN;
  const providedToken = req.headers['x-admin-token'] || req.query?.token;
  if (adminToken && providedToken === adminToken) return true;
  const sessionToken = req.headers['x-session-token'] || req.cookies?.propops_session || req.cookies?.relio_session;
  if (sessionToken) {
    const authSvc = require('../services/auth');
    const payload = authSvc.verifySessionToken(sessionToken);
    if (payload && payload.sub) {
      const userRow = await pool.query('SELECT is_admin FROM users WHERE id = $1', [payload.sub]).catch(() => null);
      if (userRow && userRow.rows[0]?.is_admin) return true;
    }
  }
  if (!adminToken) return true;
  return false;
}

// ─── Operator daily digest job ────────────────────────────────────────────────
// Triggers operator lead alert digest immediately (same logic as 8am AEST cron).
// Useful for testing or manual trigger — skips operators with no new activity.
router.post('/send-operator-digest', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.body?.token;
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && token !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const { sendOperatorDailyDigest } = require('../services/operator-notifications');
    await sendOperatorDailyDigest();
    res.json({ success: true, message: 'Operator digest triggered' });
  } catch (err) {
    console.error('[Admin] Operator digest error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Daily digest job ─────────────────────────────────────────────────────────
router.post('/send-daily-digest', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.body?.token;
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && token !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const { sendDailyDigest } = require('../services/notifications');
    await sendDailyDigest();
    res.json({ success: true, message: 'Daily digest sent' });
  } catch (err) {
    console.error('[Admin] Daily digest error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Landing page sync ────────────────────────────────────────────────────────
router.post('/sync-landing-pages', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.body?.token;
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && token !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const { syncLandingPages } = require('../services/landing-page-sync');
    const results = await syncLandingPages();
    res.json({ success: true, results });
  } catch (err) {
    console.error('[Admin] Landing page sync error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Hugo Insights (operator dashboard panel) ─────────────────────────────────
// Moved to /api/dashboard/hugo-insights — handled by this router under /api/admin
// But the route is mounted at /api/dashboard — keep in server.js wiring. This
// handler is exported so server.js can mount it at the correct path.
router.get('/hugo-insights', async (req, res) => {
  const token = req.headers['x-session-token'] || req.cookies?.propops_session || req.cookies?.relio_session;
  const authSvc = require('../services/auth');
  if (!token || !authSvc.verifySessionToken(token)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const userId = authSvc.getUserIdFromToken(token);
    const userRow = await pool.query(
      `SELECT u.id, u.subscription_status, u.business_type,
              op.trade_type, op.service_area_suburb
       FROM users u
       LEFT JOIN operator_profiles op ON op.operator_id = u.id
       WHERE u.id = $1`, [userId]
    );
    const user = userRow.rows[0];
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Trade/region from operator_profiles (no metadata column on users)
    const trade = user.trade_type || user.business_type || null;
    const region = user.service_area_suburb || null;

    const lastRunRow = await pool.query(
      `SELECT MAX(last_updated) AS last_run FROM hugo_learned_knowledge WHERE is_active = true`
    );
    const lastRun = lastRunRow.rows[0]?.last_run || null;

    let insights = [];
    if (trade) {
      const result = await pool.query(
        `SELECT knowledge_type, data_payload, confidence_score, last_updated
         FROM hugo_learned_knowledge
         WHERE trade_category = $1 AND (region = $2 OR region IS NULL)
           AND is_active = true AND last_updated > NOW() - INTERVAL '7 days'
         ORDER BY confidence_score DESC LIMIT 5`,
        [trade, region]
      );
      insights = result.rows;
    } else {
      const result = await pool.query(
        `SELECT knowledge_type, data_payload, confidence_score, last_updated
         FROM hugo_learned_knowledge
         WHERE is_active = true AND last_updated > NOW() - INTERVAL '7 days'
         ORDER BY confidence_score DESC LIMIT 5`
      );
      insights = result.rows;
    }

    const formatted = insights.map(row => {
      const confidence = row.confidence_score >= 0.8 ? 'HIGH' : row.confidence_score >= 0.5 ? 'MEDIUM' : 'LOW';
      const payload = row.data_payload || {};
      let text = '';
      if (row.knowledge_type === 'callout_fee' && payload.avg_fee) {
        text = confidence === 'HIGH'
          ? `Hugo now knows that ${Math.round(payload.sample_size || 0)}+ operators in your region charge around $${payload.avg_fee} as a call-out fee.`
          : `Hugo is noticing call-out fees averaging around $${payload.avg_fee} in your region.`;
      } else if (row.knowledge_type === 'lead_volume_pattern' && payload.peak_day) {
        text = confidence === 'HIGH'
          ? `Hugo now knows that ${row.trade_category || 'trade'} inquiries in your area peak on ${payload.peak_day}s.`
          : `Hugo is noticing ${row.trade_category || 'trade'} inquiry volume is highest on ${payload.peak_day}s.`;
      } else if (row.knowledge_type === 'conversion_pattern' && payload.conversion_rate) {
        const pct = Math.round((payload.conversion_rate || 0) * 100);
        text = confidence === 'HIGH'
          ? `Hugo now knows that ${pct}% of same-day callbacks in your area result in a booking.`
          : `Hugo is noticing that quick callbacks convert to bookings at around ${pct}%.`;
      } else if (payload.summary) {
        text = payload.summary;
      } else {
        text = `Hugo has ${confidence.toLowerCase()} confidence data on ${(row.knowledge_type || '').replace(/_/g, ' ')}.`;
      }
      return { text, confidence, knowledge_type: row.knowledge_type, last_updated: row.last_updated };
    });

    res.json({ success: true, insights: formatted, last_cron_run: lastRun, has_data: formatted.length > 0 });
  } catch (err) {
    console.error('[Hugo Insights] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Sync status ──────────────────────────────────────────────────────────────
router.get('/sync-status', async (req, res) => {
  if (!await isAdminRequest(req)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const syncRows = await pool.query(
      `SELECT domain, scraped_at AS last_synced FROM landing_page_content ORDER BY domain`
    );
    const mismatchRows = await pool.query(
      `SELECT id, conversation_id, content_key, hugo_quoted, actual_value, domain, auto_corrected, detected_at
       FROM content_mismatches
       WHERE detected_at > NOW() - INTERVAL '7 days'
       ORDER BY detected_at DESC LIMIT 20`
    );
    res.json({ success: true, sync_status: syncRows.rows, mismatches: mismatchRows.rows });
  } catch (err) {
    console.error('[Admin] Sync status error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Content changelog ────────────────────────────────────────────────────────
router.get('/content-changelog', async (req, res) => {
  if (!await isAdminRequest(req)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const domain = req.query.domain || null;
  try {
    const whereClause = domain ? `WHERE domain = $1` : '';
    const params = domain ? [domain] : [];
    const rows = await pool.query(
      `SELECT domain, content, prev_content, scraped_at, updated_at
       FROM landing_page_content ${whereClause} ORDER BY domain`, params
    );

    function flattenObj(obj, prefix) {
      const out = {};
      for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          Object.assign(out, flattenObj(v, key));
        } else if (Array.isArray(v)) {
          out[key] = JSON.stringify(v);
        } else {
          out[key] = v;
        }
      }
      return out;
    }

    const changelog = [];
    for (const row of rows.rows) {
      if (!row.prev_content) continue;
      const current = flattenObj(row.content || {});
      const prev = flattenObj(row.prev_content || {});
      const allKeys = new Set([...Object.keys(current), ...Object.keys(prev)]);
      for (const key of allKeys) {
        const currentVal = current[key];
        const prevVal = prev[key];
        if (String(currentVal ?? '') !== String(prevVal ?? '') && prevVal !== undefined) {
          changelog.push({
            domain: row.domain, content_key: key,
            previous_value: String(prevVal ?? ''), current_value: String(currentVal ?? ''),
            changed_at: row.updated_at || row.scraped_at,
          });
        }
      }
    }
    changelog.sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at));
    res.json({ success: true, changes: changelog });
  } catch (err) {
    console.error('[Admin] Content changelog error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Dashboard alerts ─────────────────────────────────────────────────────────
router.get('/alerts', async (req, res) => {
  if (!await isAdminRequest(req)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const result = await pool.query(
      `SELECT id, message, severity, read_at, created_at FROM dashboard_alerts
       ORDER BY created_at DESC LIMIT 50`
    );
    const unreadCount = result.rows.filter(r => !r.read_at).length;
    res.json({ success: true, alerts: result.rows, unread_count: unreadCount });
  } catch (err) {
    console.error('[Admin] Alerts fetch error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/alerts/read', async (req, res) => {
  if (!await isAdminRequest(req)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const result = await pool.query(
      `UPDATE dashboard_alerts SET read_at = NOW() WHERE read_at IS NULL RETURNING id`
    );
    res.json({ success: true, marked_read: result.rowCount });
  } catch (err) {
    console.error('[Admin] Alerts mark-read error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Trial reminders ──────────────────────────────────────────────────────────
router.post('/send-trial-reminders', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.body?.token;
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && token !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const authService = require('../services/auth');
    const { sendTrialReminderEmail } = require('../services/email');
    const users = await authService.getUsersNeedingTrialReminder();
    let sent = 0;
    for (const user of users) {
      const daysLeft = authService.getDaysLeft(user.trial_end);
      await sendTrialReminderEmail({ email: user.email, name: user.name, daysLeft });
      await authService.markTrialReminderSent(user.id);
      sent++;
    }
    res.json({ success: true, sent, total: users.length });
  } catch (err) {
    console.error('[Admin] Trial reminder error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Payment issues ───────────────────────────────────────────────────────────
router.get('/payment-issues', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && token !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const result = await pool.query(
      `SELECT id, email, name, subscription_status, subscription_plan,
              suspension_event, cancellation_reason, cancelled_at, grace_period_ends_at, updated_at,
              CASE WHEN grace_period_ends_at IS NOT NULL AND grace_period_ends_at > NOW()
                   THEN EXTRACT(EPOCH FROM (grace_period_ends_at - NOW())) / 86400
                   ELSE 0 END AS grace_days_remaining
       FROM users
       WHERE subscription_status IN ('payment_failed', 'cancelled', 'suspended', 'past_due')
       ORDER BY CASE subscription_status
         WHEN 'payment_failed' THEN 1 WHEN 'cancelled' THEN 2
         WHEN 'past_due' THEN 3 WHEN 'suspended' THEN 4 ELSE 5 END,
         COALESCE(cancelled_at, updated_at) DESC LIMIT 200`
    );
    const users = result.rows.map(u => ({
      id: u.id, email: u.email, name: u.name || null,
      subscription_status: u.subscription_status, subscription_plan: u.subscription_plan || null,
      suspension_event: u.suspension_event || null, cancellation_reason: u.cancellation_reason || null,
      cancelled_at: u.cancelled_at || null, grace_period_ends_at: u.grace_period_ends_at || null,
      grace_days_remaining: Math.max(0, parseFloat(u.grace_days_remaining || 0)).toFixed(1),
      in_grace_period: u.grace_period_ends_at && new Date(u.grace_period_ends_at) > new Date(),
      updated_at: u.updated_at,
    }));
    res.json({ success: true, count: users.length, users });
  } catch (err) {
    console.error('[Admin] Payment issues error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Expire grace periods ─────────────────────────────────────────────────────
router.post('/expire-grace-periods', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query?.token || req.body?.token;
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && token !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const result = await pool.query(
      `UPDATE users SET subscription_status = 'suspended', updated_at = NOW()
       WHERE grace_period_ends_at IS NOT NULL AND grace_period_ends_at < NOW()
         AND subscription_status NOT IN ('active', 'trial', 'suspended')
       RETURNING id, email, subscription_status`
    );
    const suspended = result.rows;
    console.log(`[Admin] Expired grace periods: ${suspended.length} user(s) suspended`);
    res.json({ success: true, suspended_count: suspended.length, suspended });
  } catch (err) {
    console.error('[Admin] expire-grace-periods error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Email status / retry ─────────────────────────────────────────────────────
router.post('/retry-emails', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.body?.token;
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && token !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const { retryPendingEmails } = require('../services/email');
    const result = await retryPendingEmails();
    console.log(`[Admin] Email retry: ${result.sent} sent, ${result.failed} failed, ${result.total} total`);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Admin] Email retry error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Screenshot capture (admin pre-warm) ──────────────────────────────────────
const _SS_CACHE = '/tmp/relio-ss.png';

const _downloadToBuffer = (targetUrl) => new Promise((resolve, reject) => {
  const https = require('https');
  const http = require('http');
  const protocol = targetUrl.startsWith('https') ? https : http;
  const chunks = [];
  const req2 = protocol.get(targetUrl, (resp) => {
    if (resp.statusCode === 301 || resp.statusCode === 302) {
      const loc = resp.headers.location || '';
      _downloadToBuffer(loc).then(resolve).catch(reject);
      resp.resume();
      return;
    }
    if (resp.statusCode !== 200) { reject(new Error(`HTTP ${resp.statusCode}`)); return; }
    resp.on('data', c => chunks.push(c));
    resp.on('end', () => resolve(Buffer.concat(chunks)));
    resp.on('error', reject);
  });
  req2.on('error', reject);
});

router.get('/capture-screenshot', async (req, res) => {
  const { url, key } = req.query;
  const apiKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
  if (!apiKey || key !== apiKey) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  if (!url) {
    return res.status(400).json({ success: false, message: 'url required' });
  }
  try {
    const fsSync = require('fs');
    const buffer = await _downloadToBuffer(url);
    fsSync.writeFileSync(_SS_CACHE, buffer);
    console.log(`[Admin] Screenshot cached from URL: ${buffer.length} bytes`);
    const b64 = buffer.toString('base64');
    await pool.query(
      `INSERT INTO site_settings (key, value, updated_at) VALUES ('screenshot_b64', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [b64]
    );
    res.json({ ok: true, bytes: buffer.length, cached: _SS_CACHE, db: true });
  } catch (err) {
    console.error('[Admin] Capture screenshot error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/admin/run-learning-batch — Hugo Phase 2 daily extraction ───────
// Mines recent widget chats, dashboard chats, simulation outcomes → knowledge entries.
// Triggered by daily cron (Render cron or external scheduler).
router.post('/run-learning-batch', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.body?.token;
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && token !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  console.log('[Admin] Starting Hugo learning batch...');
  try {
    const { runDailyLearningBatch } = require('../services/hugo-learning');
    const result = await runDailyLearningBatch();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Admin] Learning batch error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/admin/run-simulation-eval — Nightly Groq batch eval of simulations ──
// ONE Groq call evaluates all day's simulation responses.
// Auto-gates: approve typos/clarity, reject pricing changes, escalate edge cases.
// Triggered nightly at midnight AEST (or configurable via external cron).
router.post('/run-simulation-eval', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.body?.token;
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && token !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  console.log('[Admin] Starting nightly simulation batch eval...');
  try {
    const { runNightlyBatchEval } = require('../services/simulation-eval');
    const result = await runNightlyBatchEval();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Admin] Simulation eval error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/admin/simulation-digest — Founder daily digest data ───────────────
// Returns summary of today's simulation evaluations for founder notification.
router.get('/simulation-digest', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query?.token;
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && token !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const { generateFounderDigest } = require('../services/simulation-eval');
    const digest = await generateFounderDigest();
    res.json({ success: true, ...digest });
  } catch (err) {
    console.error('[Admin] Digest generation error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = { router, isAdminRequest, _downloadToBuffer, _SS_CACHE };
