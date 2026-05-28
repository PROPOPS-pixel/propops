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

// ─── POST /api/admin/sync-to-render — Sync Polsia live DB → user's Render Neon ─
// Copies all tables from Polsia DB to a destination Neon DB via pg client.
// Uses parameterized batch INSERT + dynamic CREATE TABLE (no pg_dump needed).
// Requires x-admin-token or ADMIN_TOKEN env var.
router.post('/sync-to-render', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.body?.token;
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && token !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const destUrl = req.body.dest_url;
  if (!destUrl) {
    return res.status(400).json({ success: false, message: 'dest_url required in body' });
  }

  const BATCH = 500;

  // Map PostgreSQL type keywords to PG type strings for CREATE TABLE
  function pgType(dataType, udtName) {
    if (['bytea'].includes(dataType))              return 'bytea';
    if (['json', 'jsonb'].includes(dataType))     return dataType;
    if (['text'].includes(dataType))               return 'text';
    if (['boolean'].includes(dataType))            return 'boolean';
    if (['smallint'].includes(dataType))            return 'smallint';
    if (['integer'].includes(dataType))            return 'integer';
    if (['bigint'].includes(dataType))             return 'bigint';
    if (['real'].includes(dataType))               return 'real';
    if (['double precision'].includes(dataType))   return 'double precision';
    if (['numeric'].includes(dataType))             return 'numeric';
    if (['timestamp', 'timestamp without time zone'].includes(dataType)) return 'timestamp';
    if (['timestamptz', 'timestamp with time zone'].includes(dataType))    return 'timestamptz';
    if (['date'].includes(dataType))               return 'date';
    if (['time'].includes(dataType))                return 'time';
    if (['timetz', 'time with time zone'].includes(dataType))              return 'timetz';
    if (['interval'].includes(dataType))            return 'interval';
    if (['uuid'].includes(dataType))                return 'uuid';
    if (['inet'].includes(dataType))               return 'inet';
    if (['cidr'].includes(dataType))               return 'cidr';
    if (['macaddr'].includes(dataType))            return 'macaddr';
    if (['bit'].includes(dataType))                 return 'bit';
    if (['varbit', 'bit varying'].includes(dataType)) return 'varbit';
    if (['point'].includes(dataType))               return 'point';
    if (['line'].includes(dataType))                return 'line';
    if (['lseg'].includes(dataType))                return 'lseg';
    if (['box'].includes(dataType))                 return 'box';
    if (['path'].includes(dataType))                return 'path';
    if (['polygon'].includes(dataType))             return 'polygon';
    if (['circle'].includes(dataType))              return 'circle';
    if (['serial'].includes(dataType))             return 'serial';
    if (['bigserial'].includes(dataType))          return 'bigserial';
    if (['money'].includes(dataType))               return 'money';
    if (dataType === 'ARRAY')                      return udtName.replace(/[\"]/g, '') + '[]';
    return 'text'; // safe fallback for unknown types
  }

  async function createTableIfMissing(src, dst, tableName) {
    const colRes = await src.query(`
      SELECT column_name, data_type, udt_name, character_maximum_length,
             numeric_precision, numeric_scale, is_nullable, column_default
      FROM   information_schema.columns
      WHERE  table_schema = 'public' AND table_name = $1
      ORDER  BY ordinal_position
    `, [tableName]);

    if (!colRes.rows.length) return false;

    // Check if table already exists in dest
    const destCheck = await dst.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    `, [tableName]);
    if (destCheck.rows.length) return true; // already exists

    // Build CREATE TABLE DDL
    const colDefs = colRes.rows.map(col => {
      let type = pgType(col.data_type, col.udt_name);
      if (col.character_maximum_length) type += `(${col.character_maximum_length})`;
      else if (col.numeric_precision !== null && col.numeric_scale !== null) {
        type += `(${col.numeric_precision},${col.numeric_scale})`;
      } else if (col.numeric_precision !== null) {
        type += `(${col.numeric_precision})`;
      }
      const nullable = col.is_nullable === 'NO' ? 'NOT NULL' : '';
      const def = col.column_default ? ` DEFAULT ${col.column_default}` : '';
      return `  "${col.column_name}" ${type}${def} ${nullable}`;
    }).filter(x => x.trim());

    const ddl = `CREATE TABLE "${tableName}" (\n${colDefs.join(',\n')}\n)`;
    await dst.query(ddl);
    return true;
  }

  async function syncOneTable(src, dst, tableName) {
    const colsResult = await src.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = $1 AND table_schema = 'public'
       ORDER BY ordinal_position`, [tableName]
    );
    if (!colsResult.rows.length) return { table: tableName, status: 'skipped', reason: 'not found in source' };

    const cols = colsResult.rows.map(r => r.column_name);
    const colList = cols.map(c => `"${c}"`).join(', ');
    const srcCount = (await src.query(`SELECT COUNT(*)::int as c FROM "${tableName}" LIMIT 1`)).rows[0]?.c ?? 0;

    // CREATE TABLE if not in dest (fresh DB case)
    await createTableIfMissing(src, dst, tableName);

    // Truncate dest
    try { await dst.query(`TRUNCATE TABLE "${tableName}" RESTART IDENTITY CASCADE`); }
    catch (e) { /* already empty */ }

    if (srcCount === 0) return { table: tableName, status: 'ok', src_rows: 0, dest_rows: 0 };

    // Batched INSERT via parameterized query
    let dstCount = 0;
    for (let offset = 0; offset < srcCount; offset += BATCH) {
      const rows = (await src.query({
        text: `SELECT * FROM "${tableName}" OFFSET $1 LIMIT ${BATCH}`,
        values: [offset],
        rowMode: 'array'
      })).rows;

      if (!rows.length) break;

      const placeholders = rows.map((_, ri) =>
        '(' + cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(',') + ')'
      ).join(',');

      // Flatten with BYTEA hex encoding
      const flat = [];
      for (const row of rows) {
        for (let ci = 0; ci < cols.length; ci++) {
          const v = row[ci];
          flat.push(Buffer.isBuffer(v) ? '\\x' + v.toString('hex') : v);
        }
      }

      await dst.query(`INSERT INTO "${tableName}" (${colList}) VALUES ${placeholders}`, flat);
      dstCount += rows.length;
    }

    return { table: tableName, status: 'ok', src_rows: srcCount, dest_rows: dstCount };
  }

  const destSsl = destUrl.includes('localhost') ? false : { rejectUnauthorized: false };
  const destPool = new Pool({ connectionString: destUrl, ssl: destSsl });

  // Pull ALL tables from source dynamically (excluding pg_internal tables)
  const allTables = (await pool.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE 'pg_%'
    ORDER BY tablename
  `)).rows.map(r => r.tablename);

  const results = [];
  try {
    for (const table of allTables) {
      try {
        const r = await syncOneTable(pool, destPool, table);
        results.push(r);
      } catch (err) {
        results.push({ table, status: 'error', message: err.message });
      }
    }
    const errors = results.filter(r => r.status === 'error');
    res.json({
      success: errors.length === 0,
      synced: results.filter(r => r.status === 'ok').length,
      errors: errors.length,
      details: results,
    });
  } catch (err) {
    console.error('[Admin] sync-to-render fatal:', err.message);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await destPool.end();
  }
});

// ─── GET /api/admin/db-counts — Compare row counts between source and dest ──────
router.get('/db-counts', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query?.token;
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && token !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const destUrl = req.query.dest_url;
  if (!destUrl) {
    return res.status(400).json({ success: false, message: 'dest_url query param required' });
  }

  const destSsl = destUrl.includes('localhost') ? false : { rejectUnauthorized: false };
  const destPool = new Pool({ connectionString: destUrl, ssl: destSsl });

  const TABLES = [
    'users', 'operator_profiles', 'network_leads', 'network_signups',
    'operator_widget_leads', 'operator_actions_log', 'hugo_chat_messages',
    'hugo_widget_sessions', 'hugo_knowledge', 'hugo_training_data',
    'hugo_knowledge_entries', 'hugo_learned_knowledge',
    'content_mismatches', 'landing_page_content', 'dashboard_alerts',
    'site_settings', 'email_queue',
  ];

  const counts = [];
  try {
    for (const table of TABLES) {
      try {
        const src = await pool.query(`SELECT COUNT(*) FROM "${table}"`);
        const dst = await destPool.query(`SELECT COUNT(*) FROM "${table}"`);
        counts.push({
          table,
          source: parseInt(src.rows[0].count, 10),
          dest: parseInt(dst.rows[0].count, 10),
          match: src.rows[0].count === dst.rows[0].count,
        });
      } catch {
        counts.push({ table, source: -1, dest: -1, match: false, error: 'table not found' });
      }
    }
    res.json({ success: true, counts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await destPool.end();
  }
});

// ─── Background DB sync to Neon ────────────────────────────────────────────────
// Fires full table sync to SYNC_TO_RENDER_DEST_URL (or ?dest_url=) in background.
// Returns immediately with job_id — poll /api/admin/sync-status/:jobId for result.
const _syncJobs = new Map();

router.post('/run-db-sync', async (req, res) => {
  const admin = await isAdminRequest(req);
  if (!admin) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const destUrl = req.query.dest_url || process.env.SYNC_TO_RENDER_DEST_URL || process.env.NEON_DATABASE_URL;
  if (!destUrl) return res.status(500).json({ success: false, message: 'dest_url not provided and SYNC_TO_RENDER_DEST_URL / NEON_DATABASE_URL not set' });

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  _syncJobs.set(jobId, { status: 'running', started_at: new Date().toISOString() });

  (async () => {
    try {
      const destPool = new Pool({ connectionString: destUrl, ssl: { rejectUnauthorized: false }, max: 3 });
      const tablesRes = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      const tables = tablesRes.rows.map(r => r.table_name);

      // Helper: build multi-row INSERT
      function buildInsert(table, cols, rows) {
        if (!rows.length) return null;
        const colList = cols.map(c => `"${c}"`).join(', ');
        const placeholders = rows.map((_, ri) =>
          '(' + cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(', ') + ')'
        ).join(', ');
        return `INSERT INTO "${table}" (${colList}) VALUES ${placeholders}`;
      }

      function flatten(rows, cols) {
        const flat = [];
        for (const row of rows) {
          for (const c of cols) {
            const v = row[c];
            flat.push(Buffer.isBuffer(v) ? '\\x' + v.toString('hex') : v);
          }
        }
        return flat;
      }

      let totalSrc = 0, totalDst = 0;
      const details = [];

      for (const table of tables) {
        process.stdout.write(`[sync] ${table}...`);
        try {
          const colsRes = await pool.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]
          );
          if (!colsRes.rows.length) { details.push({ table, status: 'skipped' }); continue; }
          const cols = colsRes.rows.map(r => r.column_name);

          const { rows: srcRows } = await pool.query(`SELECT * FROM "${table}"`);
          const srcCount = srcRows.length;
          totalSrc += srcCount;

          await destPool.query(`TRUNCATE "${table}" RESTART IDENTITY CASCADE`).catch(() => {});

          if (srcCount > 0) {
            const sql = buildInsert(table, cols, srcRows);
            if (sql) {
              try {
                await destPool.query(sql, flatten(srcRows, cols));
              } catch (e) {
                for (const row of srcRows) {
                  try {
                    const rowSql = buildInsert(table, cols, [row]);
                    if (rowSql) await destPool.query(rowSql, flatten([row], cols));
                  } catch (_) {}
                }
              }
            }
          }

          const { rows: dstRows } = await destPool.query(`SELECT COUNT(*) FROM "${table}"`);
          const dstCount = parseInt(dstRows[0].count, 10);
          totalDst += dstCount;
          const match = srcCount === dstCount;
          console.log(` ${dstCount}/${srcCount} ${match ? '✓' : '⚠'}`);
          details.push({ table, status: 'ok', src: srcCount, dst: dstCount, match });
        } catch (err) {
          console.log(` ERROR: ${err.message.slice(0, 80)}`);
          details.push({ table, status: 'error', error: err.message.slice(0, 200) });
        }
      }

      await destPool.end();
      const errors = details.filter(d => d.status === 'error');
      _syncJobs.set(jobId, {
        status: 'done', success: errors.length === 0,
        tables: details.filter(d => d.status === 'ok').length,
        errors: errors.length,
        total_src: totalSrc, total_dst: totalDst,
        details, completed_at: new Date().toISOString(),
      });
    } catch (err) {
      _syncJobs.set(jobId, { status: 'done', success: false, error: err.message, completed_at: new Date().toISOString() });
    }
  })().catch(console.error);

  res.json({ success: true, job_id: jobId, poll_url: `/api/admin/sync-status/${jobId}` });
});

router.get('/sync-status/:jobId', (req, res) => {
  const job = _syncJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, message: 'Job not found or expired' });
  res.json({ success: true, job });
});

module.exports = { router, isAdminRequest, _downloadToBuffer, _SS_CACHE };
