/**
 * Founder routes — god-mode dashboard for the founder only.
 *
 * Owns: founder-only business metrics, cross-operator data views, revenue
 *       panel, system health, Phase 3C content audit, alert management.
 * Does NOT own: operator dashboard logic, Hugo brain, billing webhooks, auth.
 *
 * All endpoints require is_admin=true on the session. 401 for everyone else.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  }
  return _pool;
}

// ─── Auth gate ────────────────────────────────────────────────────────────────
// Checks is_admin flag on the session user. Must be true for all founder endpoints.
async function requireFounder(req, res, next) {
  const token = req.headers['x-session-token'] || req.cookies?.propops_session || req.cookies?.relio_session;
  if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const authSvc = require('../services/auth');
  const payload = authSvc.verifySessionToken(token);
  if (!payload?.sub) return res.status(401).json({ success: false, message: 'Unauthorized' });

  try {
    const r = await getPool().query('SELECT is_admin, email FROM users WHERE id = $1', [payload.sub]);
    if (!r.rows[0]?.is_admin) return res.status(403).json({ success: false, message: 'Founder access only' });
    req.founderEmail = r.rows[0].email;
    next();
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Auth check failed' });
  }
}

// ─── Founder login (no auth gate — this IS the auth gate) ────────────────────
// POST /api/founder/login       — email only, generates + emails magic link
// GET  /founder/magic?token=... — verify token, set session, redirect to /founder

const IS_PROD = process.env.NODE_ENV === 'production' || !!(process.env.APP_URL && !process.env.APP_URL.includes('localhost'));
function founderSessionCookie(token) {
  const base = `propops_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Domain=.propops.pro`;
  return IS_PROD ? `${base}; Secure` : base;
}

// POST /api/founder/login — Send magic link to founder email
router.post('/login', async (req, res) => {
  const { email } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Valid email required' });
  }

  const authSvc = require('../services/auth');
  const { sendEmail } = require('../services/email');
  const crypto = require('crypto');
  const pool = getPool();

  try {
    // Check if user exists and is an admin (founder)
    const userResult = await pool.query(
      `SELECT id, email, name, is_admin FROM users WHERE LOWER(email) = LOWER($1)`,
      [email.trim()]
    );

    const user = userResult.rows[0];
    if (!user || !user.is_admin) {
      // Return success to prevent email enumeration — don't reveal whether user exists or is admin
      return res.json({ success: true, message: `If that email is a founder account, a magic link has been sent.` });
    }

    // Generate secure token (same format as email_tokens)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 15 minutes

    // Store in email_tokens table — reuse the same table as operator magic links
    await pool.query(
      `INSERT INTO email_tokens (user_id, email, token, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, user.email, token, expiresAt]
    );

    // Build magic link URL — hardcode to guarantee correct domain
    const magicUrl = `https://app.propops.pro/api/founder/magic?token=${token}`;
    // Send magic link email
    const emailResult = await sendEmail({
      to: user.email,
      subject: 'Your PropOps Founder Dashboard login link',
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <tr><td style="background:#0f172a;padding:28px 40px;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#fff;">PropOps<span style="color:#f59e0b;">.</span></p>
        </td></tr>
        <tr><td style="padding:40px;">
          <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0f172a;">Founder Dashboard Access</h1>
          <p style="margin:0 0 24px;font-size:15px;color:#334155;line-height:1.6;">Click the button below to log in to your PropOps Founder Dashboard. This link expires in 24 hours and can only be used once.</p>
          <table cellpadding="0" cellspacing="0">
            <tr><td style="background:#0f172a;border-radius:8px;">
              <a href="${magicUrl}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#fff;text-decoration:none;">
                Access Dashboard →
              </a>
            </td></tr>
          </table>
          <p style="margin:20px 0 0;font-size:13px;color:#94a3b8;">If you didn't request this, you can safely ignore this email.</p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #e2e8f0;background:#f8fafc;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">PropOps Founder Dashboard</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
      `.trim(),
      text: `Founder Dashboard Access:\n\n${magicUrl}\n\nexpires in 24 hours, single-use. If you didn't request this, ignore this email.\n\nPropOps Founder Dashboard`,
      tag: 'magic_link',
    });

    if (emailResult && emailResult.ok) {
      return res.json({ success: true, message: `Magic link sent to ${user.email}` });
    } else {
      console.error(`[Founder] Magic link email FAILED for ${user.email}:`, JSON.stringify(emailResult));
      return res.status(502).json({ success: false, message: 'Unable to send login email. Please try again in a few minutes.' });
    }
  } catch (err) {
    console.error('[Founder] Login error:', err.message);
    return res.status(500).json({ success: false, message: 'Login failed — try again' });
  }
});

// GET /founder/magic?token=... — Verify magic link token and create session
router.get('/magic', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/founder/login?error=missing_token');

  const authSvc = require('../services/auth');
  const pool = getPool();

  try {
    // Find valid, unused token
    const linkResult = await pool.query(
      `SELECT ml.*, u.id, u.email, u.name, u.is_admin
       FROM email_tokens ml
       JOIN users u ON u.id = ml.user_id
       WHERE ml.token = $1 AND ml.used = FALSE AND ml.expires_at > NOW()
       LIMIT 1`,
      [token]
    );

    if (!linkResult.rows[0]) {
      return res.redirect('/founder/login?error=invalid_or_expired');
    }

    const link = linkResult.rows[0];

    // Verify user is still an admin (founder)
    if (!link.is_admin) {
      return res.redirect('/founder/login?error=access_denied');
    }

    // Mark token as used (single-use)
    await pool.query('UPDATE email_tokens SET used = TRUE WHERE id = $1', [link.id]);

    // Create session token
    const user = { id: link.user_id, email: link.email, name: link.name };
    const sessionToken = authSvc.generateSessionToken(user);

    // Set session cookie and redirect to founder dashboard
    res.setHeader('Set-Cookie', founderSessionCookie(sessionToken));
    res.redirect('/founder');
  } catch (err) {
    console.error('[Founder] Magic link verification error:', err.message);
    res.redirect('/founder/login?error=server_error');
  }
});

router.use(requireFounder);

// ─── Section 1: Overview Panel ────────────────────────────────────────────────
// MRR, subscription counts, leads today, conversations today
router.get('/overview', async (req, res) => {
  const pool = getPool();
  try {
    const [subStats, leadsToday, convsToday] = await Promise.all([
      // Subscription counts + crude MRR estimate
      pool.query(`
        SELECT
          subscription_status,
          COUNT(*) AS count
        FROM users
        WHERE subscription_status IS NOT NULL
        GROUP BY subscription_status
      `),

      // Leads created today across ALL sources
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM leads WHERE created_at >= CURRENT_DATE) +
          (SELECT COUNT(*) FROM phone_leads WHERE created_at >= CURRENT_DATE) +
          (SELECT COUNT(*) FROM network_leads WHERE created_at >= CURRENT_DATE) +
          (SELECT COUNT(*) FROM operator_widget_leads WHERE created_at >= CURRENT_DATE)
        AS count
      `),

      // Conversations today (widget sessions + dashboard chat messages grouped by session)
      pool.query(`
        SELECT
          (SELECT COUNT(DISTINCT id) FROM hugo_widget_sessions WHERE created_at >= CURRENT_DATE) AS widget,
          (SELECT COUNT(*) FROM hugo_chat_messages WHERE created_at >= CURRENT_DATE AND sender = 'user') AS dashboard
      `),
    ]);

    // Build status map
    const statusMap = {};
    for (const row of subStats.rows) statusMap[row.subscription_status] = parseInt(row.count, 10);

    const activeCount = (statusMap['active'] || 0) + (statusMap['paid'] || 0);
    const trialCount = statusMap['trial'] || 0;

    // Crude MRR: $69/mo per active paid subscriber (subscription price from landing page)
    const MONTHLY_PRICE = 69;
    const mrr = activeCount * MONTHLY_PRICE;

    const conv = convsToday.rows[0] || {};

    res.json({
      success: true,
      mrr,
      active_count: activeCount,
      trial_count: trialCount,
      cancelled_count: (statusMap['cancelled'] || 0) + (statusMap['canceled'] || 0),
      leads_today: parseInt(leadsToday.rows[0]?.count || 0, 10),
      conversations_today: {
        widget: parseInt(conv.widget || 0, 10),
        dashboard: parseInt(conv.dashboard || 0, 10),
        total: parseInt(conv.widget || 0, 10) + parseInt(conv.dashboard || 0, 10),
      },
    });
  } catch (err) {
    console.error('[Founder] Overview error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Section 3: Operators Panel ───────────────────────────────────────────────
// All operators: name, trade, status, lead count, last active
router.get('/operators', async (req, res) => {
  const pool = getPool();
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.name,
        u.email,
        u.business_type,
        u.subscription_status,
        u.trial_end,
        u.last_login,
        u.created_at,
        COALESCE(op.trade_type, u.business_type) AS trade,
        op.service_area_suburb AS service_area,
        (SELECT COUNT(*) FROM operator_widget_leads l WHERE l.operator_id = u.id) AS lead_count,
        (SELECT COUNT(*) FROM hugo_chat_messages m WHERE m.operator_id = u.id) AS chat_count,
        (SELECT COUNT(*) FROM hugo_training_data t WHERE t.agent_id = u.id) AS training_count
      FROM users u
      LEFT JOIN operator_profiles op ON op.operator_id = u.id
      ORDER BY u.created_at DESC
    `);

    res.json({ success: true, operators: result.rows });
  } catch (err) {
    console.error('[Founder] Operators error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Single operator detail — leads, conversations, training entries
router.get('/operators/:id', async (req, res) => {
  const pool = getPool();
  const userId = parseInt(req.params.id, 10);
  if (!userId) return res.status(400).json({ success: false, message: 'Invalid operator id' });

  try {
    const [userRow, leads, chats, training] = await Promise.all([
      pool.query(`
        SELECT u.*, op.trade_type AS trade, op.service_area_suburb AS service_area, op.rates_json
        FROM users u
        LEFT JOIN operator_profiles op ON op.operator_id = u.id
        WHERE u.id = $1
      `, [userId]),

      pool.query(`
        SELECT * FROM operator_widget_leads
        WHERE operator_id = $1
        ORDER BY created_at DESC
        LIMIT 50
      `, [userId]),

      pool.query(`
        SELECT sender AS role, message AS content, created_at
        FROM hugo_chat_messages
        WHERE operator_id = $1
        ORDER BY created_at DESC
        LIMIT 50
      `, [userId]),

      pool.query(`
        SELECT customer_message AS question, ai_response AS answer, created_at
        FROM hugo_training_data
        WHERE agent_id = $1
        ORDER BY created_at DESC
        LIMIT 30
      `, [userId]),
    ]);

    if (!userRow.rows[0]) return res.status(404).json({ success: false, message: 'Operator not found' });

    res.json({
      success: true,
      operator: userRow.rows[0],
      leads: leads.rows,
      chats: chats.rows,
      training: training.rows,
    });
  } catch (err) {
    console.error('[Founder] Operator detail error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Section 4: All Leads Panel ───────────────────────────────────────────────
// UNION across all lead sources: leads (RE portal), phone_leads (Twilio),
// network_leads (widget), operator_widget_leads (per-operator).
// Previous bug: only queried operator_widget_leads (0 rows), missing 90+ leads.
router.get('/leads', async (req, res) => {
  const pool = getPool();
  const { date_from, date_to, status, trade, channel, intent_min, limit: rawLimit = 100, offset: rawOffset = 0 } = req.query;

  // Shared date params — reused across all sub-queries
  const params = [];
  const dateFromIdx = date_from ? (params.push(date_from), params.length) : null;
  const dateToIdx = date_to ? (params.push(date_to + 'T23:59:59.999Z'), params.length) : null;

  // Status filter on the outer UNION result (applied after UNION, before LIMIT)
  let statusFilter = '';
  let statusIdx = null;
  if (status) {
    params.push(status);
    statusIdx = params.length;
    statusFilter = `WHERE status = $${statusIdx}`;
  }

  // Generic date WHERE builder (prefix is the table alias)
  function dateConds(alias) {
    const c = [];
    if (dateFromIdx) c.push(`${alias}.created_at >= $${dateFromIdx}`);
    if (dateToIdx) c.push(`${alias}.created_at <= $${dateToIdx}`);
    return c.length ? `WHERE ${c.join(' AND ')}` : '';
  }

  params.push(parseInt(rawLimit, 10));
  const limitIdx = params.length;
  params.push(parseInt(rawOffset, 10));
  const offsetIdx = params.length;

  // Outer-query filters applied to the UNION result (status, trade, channel, intent_min)
  const outerConds = [];
  if (status) { params.push(status); outerConds.push(`status = $${params.length}`); }
  if (trade) { params.push(trade); outerConds.push(`trade = $${params.length}`); }
  if (channel) { params.push(channel); outerConds.push(`channel = $${params.length}`); }
  if (intent_min) { params.push(parseInt(intent_min, 10)); outerConds.push(`intent_score >= $${params.length}`); }
  const outerWhere = outerConds.length ? `WHERE ${outerConds.join(' AND ')}` : '';

  try {
    const result = await pool.query(`
      SELECT * FROM (
        -- 1. RE leads (main leads table — portal/email/Facebook sources)
        SELECT ld.id, ld.name AS lead_name, ld.phone AS lead_phone, ld.email AS lead_email,
               ld.status, ld.source AS channel, NULL::integer AS intent_score,
               ld.property_interest AS rough_quote, ld.created_at,
               u.name AS operator_name, u.email AS operator_email,
               'real_estate' AS trade, 'leads' AS source
        FROM leads ld
        LEFT JOIN users u ON u.id = ld.user_id
        ${dateConds('ld')}

        UNION ALL

        -- 2. Phone leads (Twilio AI calls)
        SELECT pl.id, pl.caller_name AS lead_name, pl.caller_phone AS lead_phone,
               pl.caller_email AS lead_email, pl.stage AS status, 'phone' AS channel,
               NULL::integer AS intent_score, pl.intent AS rough_quote, pl.created_at,
               NULL AS operator_name, NULL AS operator_email,
               COALESCE(pl.trade_type, 'unknown') AS trade, 'phone' AS source
        FROM phone_leads pl
        ${dateConds('pl')}

        UNION ALL

        -- 3. Network leads (public widget)
        SELECT n.id, n.contact_name AS lead_name, n.contact_phone AS lead_phone,
               n.contact_email AS lead_email, n.status, 'widget' AS channel,
               NULL::integer AS intent_score, NULL AS rough_quote, n.created_at,
               ou.name AS operator_name, ou.email AS operator_email,
               n.trade, 'network' AS source
        FROM network_leads n
        LEFT JOIN users ou ON ou.id = n.assigned_operator_id
        ${dateConds('n')}

        UNION ALL

        -- 4. Operator widget leads (per-operator)
        SELECT l.id, l.lead_name, l.lead_phone, l.lead_email, l.status, l.channel,
               l.intent_score, l.rough_quote, l.created_at,
               u2.name AS operator_name, u2.email AS operator_email,
               COALESCE(op.trade_type, u2.business_type) AS trade, 'operator' AS source
        FROM operator_widget_leads l
        JOIN users u2 ON u2.id = l.operator_id
        LEFT JOIN operator_profiles op ON op.operator_id = l.operator_id
        ${dateConds('l')}
      ) AS all_leads
      ${outerWhere}
      ORDER BY created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, params);

    // Count with same filters
    const countResult = await pool.query(`
      SELECT COUNT(*) AS total FROM (
        SELECT ld.status, ld.source AS channel, NULL::integer AS intent_score, ld.created_at, 'real_estate' AS trade
        FROM leads ld ${dateConds('ld')}
        UNION ALL
        SELECT pl.stage AS status, 'phone' AS channel, NULL::integer AS intent_score, pl.created_at, COALESCE(pl.trade_type, 'unknown') AS trade
        FROM phone_leads pl ${dateConds('pl')}
        UNION ALL
        SELECT n.status, 'widget' AS channel, NULL::integer AS intent_score, n.created_at, n.trade
        FROM network_leads n ${dateConds('n')}
        UNION ALL
        SELECT l.status, l.channel, l.intent_score, l.created_at, COALESCE(op.trade_type, u2.business_type) AS trade
        FROM operator_widget_leads l JOIN users u2 ON u2.id = l.operator_id LEFT JOIN operator_profiles op ON op.operator_id = l.operator_id ${dateConds('l')}
      ) AS all_leads ${outerWhere}
    `, params.slice(0, -2));

    res.json({
      success: true,
      leads: result.rows,
      total: parseInt(countResult.rows[0]?.total || 0, 10),
    });
  } catch (err) {
    console.error('[Founder] Leads error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Section 5: Revenue Panel ─────────────────────────────────────────────────
// Subscription breakdown, trial expirations, churn estimate
router.get('/revenue', async (req, res) => {
  const pool = getPool();
  const MONTHLY_PRICE = 69;

  try {
    const [breakdown, trialExpiring, churnData, byTrade] = await Promise.all([
      // Subscription status breakdown
      pool.query(`
        SELECT subscription_status, COUNT(*) AS count
        FROM users
        GROUP BY subscription_status
        ORDER BY count DESC
      `),

      // Trial expirations in next 7 days
      pool.query(`
        SELECT id, name, email, trial_end, business_type
        FROM users
        WHERE subscription_status = 'trial'
          AND trial_end BETWEEN NOW() AND NOW() + INTERVAL '7 days'
        ORDER BY trial_end ASC
      `),

      // Users who cancelled in last 30 days
      pool.query(`
        SELECT COUNT(*) AS churned
        FROM users
        WHERE subscription_status IN ('cancelled', 'canceled')
          AND updated_at >= NOW() - INTERVAL '30 days'
      `),

      // Revenue breakdown by trade
      pool.query(`
        SELECT
          COALESCE(op.trade_type, u.business_type, 'unknown') AS trade,
          COUNT(*) FILTER (WHERE u.subscription_status IN ('active', 'paid')) AS active_count
        FROM users u
        LEFT JOIN operator_profiles op ON op.operator_id = u.id
        GROUP BY COALESCE(op.trade_type, u.business_type, 'unknown')
        ORDER BY active_count DESC
      `),
    ]);

    const statusMap = {};
    for (const row of breakdown.rows) statusMap[row.subscription_status] = parseInt(row.count, 10);

    const activeCount = (statusMap['active'] || 0) + (statusMap['paid'] || 0);
    const trialCount = statusMap['trial'] || 0;
    const totalPaid = activeCount + trialCount;

    const mrr = activeCount * MONTHLY_PRICE;
    const conversionRate = totalPaid > 0 ? ((activeCount / totalPaid) * 100).toFixed(1) : '0.0';
    const churned = parseInt(churnData.rows[0]?.churned || 0, 10);

    res.json({
      success: true,
      mrr,
      active_count: activeCount,
      trial_count: trialCount,
      conversion_rate: parseFloat(conversionRate),
      churned_last_30_days: churned,
      trial_expiring_soon: trialExpiring.rows,
      by_trade: byTrade.rows.map(r => ({
        trade: r.trade,
        active_count: parseInt(r.active_count, 10),
        mrr: parseInt(r.active_count, 10) * MONTHLY_PRICE,
      })),
      status_breakdown: breakdown.rows.map(r => ({
        status: r.subscription_status,
        count: parseInt(r.count, 10),
      })),
    });
  } catch (err) {
    console.error('[Founder] Revenue error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Section 9: System Health ─────────────────────────────────────────────────
// Content mismatch alerts, landing page sync status, content change audit
router.get('/health', async (req, res) => {
  const pool = getPool();
  try {
    const [mismatches, syncStatus, contentChanges, alertsBanner] = await Promise.all([
      // Recent content mismatches (last 7 days)
      pool.query(`
        SELECT * FROM content_mismatches
        ORDER BY detected_at DESC
        LIMIT 50
      `),

      // Landing page sync status per domain
      pool.query(`
        SELECT domain, scraped_at, updated_at
        FROM landing_page_content
        ORDER BY domain ASC
      `),

      // Content change audit log (last 30 days)
      // content_mismatches as proxy for detected changes
      pool.query(`
        SELECT
          id, content_key, hugo_quoted, actual_value, domain, auto_corrected, detected_at
        FROM content_mismatches
        WHERE detected_at >= NOW() - INTERVAL '30 days'
        ORDER BY detected_at DESC
        LIMIT 100
      `),

      // Unread alerts banner
      pool.query(`
        SELECT * FROM dashboard_alerts
        WHERE read_at IS NULL
        ORDER BY created_at DESC
        LIMIT 20
      `),
    ]);

    // Build sync status with freshness
    const now = Date.now();
    const syncStatusData = syncStatus.rows.map(row => {
      const lastSync = row.scraped_at || row.updated_at;
      const ageMs = lastSync ? now - new Date(lastSync).getTime() : null;
      const ageMinutes = ageMs ? Math.floor(ageMs / 60000) : null;
      const isStale = ageMs ? ageMs > 24 * 60 * 60 * 1000 : true; // >24h = stale
      return {
        domain: row.domain,
        last_synced: lastSync,
        age_minutes: ageMinutes,
        status: isStale ? 'stale' : 'fresh',
      };
    });

    res.json({
      success: true,
      mismatches: mismatches.rows,
      sync_status: syncStatusData,
      content_changes: contentChanges.rows,
      unread_alerts: alertsBanner.rows,
    });
  } catch (err) {
    console.error('[Founder] Health error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Mark alert as read ───────────────────────────────────────────────────────
router.post('/alerts/:id/read', async (req, res) => {
  const pool = getPool();
  const alertId = parseInt(req.params.id, 10);
  if (!alertId) return res.status(400).json({ success: false, message: 'Invalid alert id' });

  try {
    await pool.query(
      `UPDATE dashboard_alerts SET read_at = NOW() WHERE id = $1`,
      [alertId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[Founder] Mark alert read error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Check if current session is founder (for dashboard to gate UI) ───────────
// Public-ish: returns is_founder boolean without leaking data
router.get('/me', async (req, res) => {
  // requireFounder already ran — if we got here, they're admin
  try {
    // First try propops_operators (new table) for role + intake_email
    const opsResult = await getPool().query(
      `SELECT po.name, po.email, po.phone, po.role, po.intake_email, u.mobile_number
       FROM propops_operators po
       JOIN users u ON u.id = po.user_id
       WHERE po.role = 'founder'
       LIMIT 1`
    );
    if (opsResult.rows[0]) {
      const row = opsResult.rows[0];
      return res.json({
        success: true,
        is_founder: true,
        name: row.name,
        email: row.email || req.founderEmail,
        phone: row.phone || row.mobile_number || '',
        role: row.role,
        intake_email: 'propopspro@polsia.app', // Platform constant — overrides stale DB value
      });
    }
  } catch (err) {
    // propops_operators may not exist yet — fall through
    console.warn('[founder] /me propops_operators lookup failed:', err.message);
  }
  // Fallback: just return from users table
  res.json({ success: true, is_founder: true, email: req.founderEmail, name: 'Founder', role: 'founder', phone: '', intake_email: 'propopspro@polsia.app' });
});

// ─── Update founder profile ───────────────────────────────────────────────────
router.put('/me', async (req, res) => {
  try {
    const { name, email, phone } = req.body || {};
    const userId = req.userId || (await getPool().query('SELECT id FROM users WHERE is_admin = true LIMIT 1')).rows[0]?.id;

    if (!userId) return res.status(400).json({ success: false, message: 'Cannot identify founder user' });

    // Update users table
    await getPool().query(
      `UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email), mobile_number = COALESCE($3, mobile_number), updated_at = NOW() WHERE id = $4`,
      [name || null, email || null, phone || null, userId]
    );

    // Update propops_operators table if it exists
    await getPool().query(
      `UPDATE propops_operators SET name = COALESCE($1, name), email = COALESCE($2, email), phone = COALESCE($3, phone), updated_at = NOW() WHERE role = 'founder'`,
      [name || null, email || null, phone || null]
    );

    res.json({ success: true, message: 'Profile updated' });
  } catch (err) {
    console.error('[founder] /me PUT error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Section 2: Landing Page Analytics ────────────────────────────────────────
// Aggregated visitor stats from page_analytics table (populated by tracking script).
router.get('/analytics', async (req, res) => {
  const pool = getPool();
  const { days = 7 } = req.query;
  const daysInt = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);

  try {
    const [dailyVisitors, trafficSources, deviceSplit, funnelStats, topReferrers, recentPeriod] = await Promise.all([

      // Daily unique visitors per domain for last N days
      pool.query(`
        SELECT
          domain,
          DATE_TRUNC('day', created_at) AS day,
          COUNT(DISTINCT session_id) AS unique_visitors,
          COUNT(*) AS page_views
        FROM page_analytics
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY domain, DATE_TRUNC('day', created_at)
        ORDER BY day DESC, domain
      `, [daysInt]),

      // UTM traffic sources breakdown
      pool.query(`
        SELECT
          domain,
          COALESCE(utm_source, 'organic') AS source,
          COUNT(DISTINCT session_id) AS sessions
        FROM page_analytics
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY domain, COALESCE(utm_source, 'organic')
        ORDER BY sessions DESC
        LIMIT 20
      `, [daysInt]),

      // Device split per domain
      pool.query(`
        SELECT
          domain,
          COALESCE(device_type, 'unknown') AS device,
          COUNT(DISTINCT session_id) AS sessions
        FROM page_analytics
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY domain, COALESCE(device_type, 'unknown')
        ORDER BY sessions DESC
      `, [daysInt]),

      // Funnel: page view → Hugo chat started → Lead captured → Operator notified
      // Each event is stored with a utm_campaign = 'funnel-<step>' by the tracking script
      pool.query(`
        SELECT
          domain,
          COUNT(DISTINCT CASE WHEN path = '/' OR path IS NULL THEN session_id END) AS page_views,
          COUNT(DISTINCT CASE WHEN utm_campaign = 'funnel-chat-started' THEN session_id END) AS chat_started,
          COUNT(DISTINCT CASE WHEN utm_campaign = 'funnel-lead-captured' THEN session_id END) AS lead_captured,
          COUNT(DISTINCT CASE WHEN utm_campaign = 'funnel-operator-notified' THEN session_id END) AS operator_notified
        FROM page_analytics
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY domain
      `, [daysInt]),

      // Top referrers
      pool.query(`
        SELECT
          domain,
          COALESCE(referrer, 'direct') AS referrer,
          COUNT(DISTINCT session_id) AS sessions
        FROM page_analytics
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
          AND (referrer IS NULL OR referrer NOT LIKE '%propops%')
        GROUP BY domain, COALESCE(referrer, 'direct')
        ORDER BY sessions DESC
        LIMIT 10
      `, [daysInt]),

      // Summary totals for the period
      pool.query(`
        SELECT
          domain,
          COUNT(DISTINCT session_id) AS total_visitors,
          COUNT(*) AS total_page_views,
          COUNT(DISTINCT region) AS regions_reached
        FROM page_analytics
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY domain
      `, [daysInt]),
    ]);

    res.json({
      success: true,
      period_days: daysInt,
      summary: recentPeriod.rows,
      daily: dailyVisitors.rows,
      traffic_sources: trafficSources.rows,
      device_split: deviceSplit.rows,
      funnel: funnelStats.rows,
      top_referrers: topReferrers.rows,
    });
  } catch (err) {
    console.error('[Founder] Analytics error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
