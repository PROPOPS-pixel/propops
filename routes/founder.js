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
// POST /api/founder/login  — email + password, must be is_admin user.
// Sets the same propops_session cookie used by the rest of the app.
// Redirects happen client-side; this endpoint returns JSON only.
const IS_PROD = process.env.NODE_ENV === 'production' || !!(process.env.APP_URL && !process.env.APP_URL.includes('localhost'));
function founderSessionCookie(token) {
  const base = `propops_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;
  return IS_PROD ? `${base}; Secure` : base;
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required' });
  }

  const authSvc = require('../services/auth');
  try {
    // loginWithPassword returns null if email not found or password wrong
    const user = await authSvc.loginWithPassword(email.toLowerCase(), password);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Incorrect email or password' });
    }
    if (!user.is_admin) {
      return res.status(403).json({ success: false, message: 'Founder access only' });
    }
    const sessionToken = authSvc.generateSessionToken(user);
    res.setHeader('Set-Cookie', founderSessionCookie(sessionToken));
    return res.json({ success: true, email: user.email });
  } catch (err) {
    console.error('[Founder] Login error:', err.message);
    return res.status(500).json({ success: false, message: 'Login failed — try again' });
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

// ─── Section 6: Hugo Performance Panel ────────────────────────────────────────
// Conversations per day by channel, lead qualification rate, top questions.
router.get('/hugo-performance', async (req, res) => {
  const pool = getPool();
  const { days = 7 } = req.query;
  const daysInt = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);

  try {
    const [convsByChannel, dailyConvs, leadQualRate, topQuestions, channelCounts] = await Promise.all([

      // Conversations by channel (widget sessions vs dashboard messages)
      pool.query(`
        SELECT
          'widget' AS channel,
          COUNT(DISTINCT id) AS conversations,
          COUNT(*) AS total_messages
        FROM hugo_widget_sessions
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        UNION ALL
        SELECT
          'dashboard' AS channel,
          COUNT(DISTINCT operator_id) AS conversations,
          COUNT(*) AS total_messages
        FROM hugo_chat_messages
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
          AND sender = 'user'
      `, [daysInt]),

      // Daily conversation volume
      pool.query(`
        SELECT
          DATE_TRUNC('day', created_at) AS day,
          'widget' AS channel,
          COUNT(DISTINCT id) AS conversations
        FROM hugo_widget_sessions
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY DATE_TRUNC('day', created_at)
        UNION ALL
        SELECT
          DATE_TRUNC('day', created_at) AS day,
          'dashboard' AS channel,
          COUNT(DISTINCT operator_id) AS conversations
        FROM hugo_chat_messages
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
          AND sender = 'user'
        GROUP BY DATE_TRUNC('day', created_at)
        ORDER BY day DESC
      `, [daysInt]),

      // Lead qualification rate: leads with intent_score >= 7 / total leads
      pool.query(`
        SELECT
          COUNT(*) AS total_leads,
          COUNT(*) FILTER (WHERE intent_score >= 7) AS qualified_leads,
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE intent_score >= 7) / NULLIF(COUNT(*), 0), 1
          ) AS qualification_rate_pct,
          ROUND(AVG(intent_score)::numeric, 1) AS avg_intent_score
        FROM operator_widget_leads
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
      `, [daysInt]),

      // Top questions from hugo_training_data (proxy for what Hugo gets asked)
      pool.query(`
        SELECT customer_message AS question, COUNT(*) AS frequency
        FROM hugo_training_data
        GROUP BY customer_message
        ORDER BY frequency DESC
        LIMIT 15
      `),

      // Channel breakdown from operator_widget_leads
      pool.query(`
        SELECT
          COALESCE(channel, 'unknown') AS channel,
          COUNT(*) AS leads,
          ROUND(AVG(intent_score)::numeric, 1) AS avg_intent
        FROM operator_widget_leads
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY COALESCE(channel, 'unknown')
        ORDER BY leads DESC
      `, [daysInt]),
    ]);

    res.json({
      success: true,
      period_days: daysInt,
      conversations_by_channel: convsByChannel.rows,
      daily_conversations: dailyConvs.rows,
      lead_qualification: leadQualRate.rows[0] || {},
      top_questions: topQuestions.rows,
      channel_lead_breakdown: channelCounts.rows,
    });
  } catch (err) {
    console.error('[Founder] Hugo performance error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Section 7: API Costs Panel ────────────────────────────────────────────────
// Token usage and cost estimates from operator_actions_log + chat message metadata.
// We don't store per-call token counts today, so this approximates from message lengths.
router.get('/api-costs', async (req, res) => {
  const pool = getPool();
  const { days = 7 } = req.query;
  const daysInt = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);

  // Gemini 1.5 Flash pricing (USD, convert to AUD @1.53)
  const GEMINI_INPUT_COST_PER_1K = 0.000075;   // $0.075 per 1M tokens
  const GEMINI_OUTPUT_COST_PER_1K = 0.0003;    // $0.30 per 1M tokens
  const EMBED_COST_PER_1K = 0.00002;           // OpenAI text-embedding-3-small
  const USD_TO_AUD = 1.53;

  // Rough token estimate: ~1 token per 4 chars
  const charsToTokens = (chars) => Math.ceil(chars / 4);

  try {
    const [widgetMessages, dashMessages, trainingCount, knowledgeCount, actions] = await Promise.all([

      // Widget chat messages (estimate tokens from messages JSONB length)
      pool.query(`
        SELECT
          DATE_TRUNC('day', created_at) AS day,
          SUM(LENGTH(COALESCE(messages::text, ''))) AS total_chars,
          COUNT(*) AS message_count
        FROM hugo_widget_sessions
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY DATE_TRUNC('day', created_at)
        ORDER BY day DESC
      `, [daysInt]),

      // Dashboard chat messages
      pool.query(`
        SELECT
          DATE_TRUNC('day', created_at) AS day,
          SUM(LENGTH(COALESCE(message, ''))) AS total_chars,
          COUNT(*) AS message_count
        FROM hugo_chat_messages
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY DATE_TRUNC('day', created_at)
        ORDER BY day DESC
      `, [daysInt]),

      // Knowledge entries created (each triggers embedding call)
      pool.query(`
        SELECT COUNT(*) AS count
        FROM hugo_knowledge_entries
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
      `, [daysInt]),

      // Training data entries (each has embedding)
      pool.query(`
        SELECT COUNT(*) AS count
        FROM hugo_training_data
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
      `, [daysInt]),

      // Actions triggered (each may call Gemini)
      pool.query(`
        SELECT
          DATE_TRUNC('day', created_at) AS day,
          COUNT(*) AS action_count
        FROM operator_actions_log
        WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY DATE_TRUNC('day', created_at)
        ORDER BY day DESC
      `, [daysInt]),
    ]);

    // Build daily cost breakdown
    const dayMap = {};
    const addDay = (day, source, chars, count) => {
      const k = new Date(day).toISOString().split('T')[0];
      if (!dayMap[k]) dayMap[k] = { day: k, widget_msgs: 0, dash_msgs: 0, action_count: 0, total_tokens: 0, cost_usd: 0 };
      const tokens = charsToTokens(chars || 0);
      // Assume 40% input, 60% output ratio
      const inputTokens = Math.ceil(tokens * 0.4);
      const outputTokens = Math.ceil(tokens * 0.6);
      const cost = (inputTokens / 1000) * GEMINI_INPUT_COST_PER_1K + (outputTokens / 1000) * GEMINI_OUTPUT_COST_PER_1K;
      dayMap[k].total_tokens += tokens;
      dayMap[k].cost_usd += cost;
      if (source === 'widget') dayMap[k].widget_msgs += count;
      if (source === 'dashboard') dayMap[k].dash_msgs += count;
    };

    widgetMessages.rows.forEach(r => addDay(r.day, 'widget', r.total_chars, r.message_count));
    dashMessages.rows.forEach(r => addDay(r.day, 'dashboard', r.total_chars, r.message_count));
    actions.rows.forEach(r => {
      const k = new Date(r.day).toISOString().split('T')[0];
      if (!dayMap[k]) dayMap[k] = { day: k, widget_msgs: 0, dash_msgs: 0, action_count: 0, total_tokens: 0, cost_usd: 0 };
      dayMap[k].action_count += parseInt(r.action_count, 10);
    });

    const dailyCosts = Object.values(dayMap).sort((a, b) => b.day.localeCompare(a.day)).map(d => ({
      ...d,
      cost_aud: parseFloat((d.cost_usd * USD_TO_AUD).toFixed(4)),
    }));

    // Embedding cost
    const embeddingCalls = parseInt(knowledgeCount.rows[0]?.count || 0, 10) + parseInt(trainingCount.rows[0]?.count || 0, 10);
    // Avg 256 tokens per embedding
    const embeddingCostUsd = (embeddingCalls * 256 / 1000) * EMBED_COST_PER_1K;

    const totalGeminiCostUsd = dailyCosts.reduce((s, d) => s + d.cost_usd, 0);
    const totalCostAud = (totalGeminiCostUsd + embeddingCostUsd) * USD_TO_AUD;

    res.json({
      success: true,
      period_days: daysInt,
      daily_costs: dailyCosts,
      embedding_calls: embeddingCalls,
      embedding_cost_aud: parseFloat((embeddingCostUsd * USD_TO_AUD).toFixed(4)),
      total_gemini_cost_aud: parseFloat((totalGeminiCostUsd * USD_TO_AUD).toFixed(2)),
      total_cost_aud: parseFloat(totalCostAud.toFixed(2)),
      note: 'Token counts estimated from message char length (~4 chars/token). Gemini 1.5 Flash pricing.',
    });
  } catch (err) {
    console.error('[Founder] API costs error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Section 8: Training Data Panel ───────────────────────────────────────────
// View all knowledge entries, learned knowledge, filter by trade/confidence/status.
router.get('/training-data', async (req, res) => {
  const pool = getPool();
  const { trade, source, validated, confidence, limit = 100, offset = 0 } = req.query;

  const conditions = [];
  const params = [];

  if (trade) {
    params.push(trade);
    conditions.push(`trade_slug = $${params.length}`);
  }
  if (source) {
    params.push(source);
    conditions.push(`source_type = $${params.length}`);
  }
  if (validated !== undefined) {
    params.push(validated === 'true');
    conditions.push(`validated = $${params.length}`);
  }
  if (confidence) {
    params.push(confidence);
    conditions.push(`confidence = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(parseInt(limit, 10), parseInt(offset, 10));
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  try {
    const [entries, summary, learned, legacyTraining] = await Promise.all([

      // Knowledge entries (Phase 2)
      // Frontend expects 'question'/'answer'/'confidence_level' fields
      pool.query(`
        SELECT
          id, knowledge_text AS question, '' AS answer, trade_slug AS trade,
          source, confidence, confidence AS confidence_level,
          validated, created_at
        FROM hugo_knowledge_entries
        ${where}
        ORDER BY created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `, params),

      // Summary counts
      pool.query(`
        SELECT
          confidence,
          validated,
          COUNT(*) AS count
        FROM hugo_knowledge_entries
        GROUP BY confidence, validated
        ORDER BY confidence, validated
      `),

      // Hugo learned knowledge (market intelligence, migration 043)
      // Frontend expects avg_job_value and common_services as top-level fields
      // These are nested inside data_payload JSONB, so extract them
      pool.query(`
        SELECT
          trade_category AS trade, region,
          (data_payload->>'avg_fee')::numeric AS avg_job_value,
          data_payload->>'common_services' AS common_services,
          data_payload, last_updated
        FROM hugo_learned_knowledge
        ORDER BY last_updated DESC
        LIMIT 50
      `),

      // Legacy training data count
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(DISTINCT agent_id) AS operators_with_training
        FROM hugo_training_data
      `),
    ]);

    const countResult = await pool.query(`
      SELECT COUNT(*) AS total FROM hugo_knowledge_entries ${where}
    `, params.slice(0, -2));

    res.json({
      success: true,
      entries: entries.rows,
      total: parseInt(countResult.rows[0]?.total || 0, 10),
      summary: summary.rows,
      learned_knowledge: learned.rows,
      legacy_training: legacyTraining.rows[0] || {},
    });
  } catch (err) {
    console.error('[Founder] Training data error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Section 9b: Hugo Training Feed — Simulation eval results for founder review ──
// Shows escalated items from nightly batch eval, plus approve/correct/reject actions.
router.get('/hugo-training-feed', async (req, res) => {
  const pool = getPool();
  const { status, trade, limit = 50, offset = 0 } = req.query;

  try {
    const conditions = ['1=1'];
    const params = [];

    if (status) {
      params.push(status);
      conditions.push(`eval_status = $${params.length}`);
    }
    if (trade) {
      params.push(trade);
      conditions.push(`trade_category = $${params.length}`);
    }

    const where = conditions.join(' AND ');
    params.push(parseInt(limit, 10));
    params.push(parseInt(offset, 10));

    const [itemsResult, countResult, statsResult] = await Promise.all([
      pool.query(
        `SELECT s.id, s.operator_id, u.name as operator_name, s.trade_category,
                s.simulation_type, s.inquiry_message, s.hugo_response_text,
                s.eval_status, s.eval_reason, s.eval_category, s.eval_confidence,
                s.batch_processed_at, s.founder_action, s.founder_correction,
                s.response_time_ms, s.created_at
         FROM hugo_sim_outcomes s
         LEFT JOIN users u ON u.id = s.operator_id
         WHERE ${where}
         ORDER BY
           CASE WHEN s.eval_status = 'escalated' THEN 0
                WHEN s.eval_status = 'pending' THEN 1
                ELSE 2 END,
           s.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*) as total FROM hugo_sim_outcomes WHERE ${where}`,
        params.slice(0, -2)
      ),
      pool.query(
        `SELECT eval_status, COUNT(*) as cnt
         FROM hugo_sim_outcomes
         WHERE batch_processed_at IS NOT NULL
         GROUP BY eval_status`
      ),
    ]);

    res.json({
      success: true,
      items: itemsResult.rows,
      total: parseInt(countResult.rows[0]?.total || 0),
      stats: statsResult.rows.reduce((acc, r) => { acc[r.eval_status] = parseInt(r.cnt); return acc; }, {}),
    });
  } catch (err) {
    console.error('[Founder] Training feed error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/founder/hugo-training-feed/:id/action — Founder approve/correct/reject ──
router.post('/hugo-training-feed/:id/action', async (req, res) => {
  const simId = parseInt(req.params.id, 10);
  const { action, correction } = req.body || {};

  if (!action || !['approve', 'reject', 'correct'].includes(action)) {
    return res.status(400).json({ success: false, message: 'action must be approve, reject, or correct' });
  }
  if (action === 'correct' && (!correction || correction.trim().length < 3)) {
    return res.status(400).json({ success: false, message: 'correction text required for correct action' });
  }

  try {
    const { applyFounderAction } = require('../services/simulation-eval');
    const result = await applyFounderAction(simId, action, correction);
    res.json(result);
  } catch (err) {
    console.error('[Founder] Training feed action error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/founder/simulation-digest — Today's simulation eval summary ──────
router.get('/simulation-digest', async (req, res) => {
  try {
    const { generateFounderDigest } = require('../services/simulation-eval');
    const digest = await generateFounderDigest();
    res.json({ success: true, ...digest });
  } catch (err) {
    console.error('[Founder] Digest error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Section 10: Hugo Brain Export ───────────────────────────────────────────
// Read-only export of everything that shapes Hugo's behavior.
// System prompts, pricing rules, persona configs, guardrails, memory settings.
// This endpoint assembles the data — the HTML page renders it for founder audit.
router.get('/brain-export', async (req, res) => {
  const pool = getPool();

  // ── Hard-coded constants (mirrors what's in hugo-brain.js + re-agent-prompt.js)
  // These are copied here for the export — they cannot drift because they're
  // directly read from the source-of-truth files via require() at startup.
  let hugoBrainModule, reAgentPromptModule, hugoVoiceService;
  try {
    hugoBrainModule = require('../routes/hugo-brain');
  } catch (_) { hugoBrainModule = null; }
  try {
    reAgentPromptModule = require('../services/re-agent-prompt');
  } catch (_) { reAgentPromptModule = null; }
  try {
    hugoVoiceService = require('../services/hugo-voice');
  } catch (_) { hugoVoiceService = null; }

  try {
    const [
      knowledgeSummary,
      trainingLegacy,
      faqCache,
      learnedKnowledge,
      operatorCustomRules,
      knowledgeEntries,
      priceMismatches,
    ] = await Promise.all([
      // Knowledge entries summary by confidence tier
      pool.query(`
        SELECT confidence, validated, COUNT(*) AS count
        FROM hugo_knowledge_entries
        GROUP BY confidence, validated
        ORDER BY confidence
      `).catch(() => ({ rows: [] })),

      // Legacy training data count
      pool.query(`
        SELECT COUNT(*) AS total, COUNT(DISTINCT agent_id) AS operator_count
        FROM hugo_training_data
      `).catch(() => ({ rows: [{}] })),

      // FAQ cache entries (these bypass AI and pricing guards)
      pool.query(`
        SELECT domain, pattern AS question, answer, priority, is_active,
               expires_at, created_at
        FROM hugo_faq_cache
        ORDER BY domain, priority
      `).catch(() => ({ rows: [] })),

      // Learned market intelligence
      pool.query(`
        SELECT trade_category, region,
               jsonb_pretty(data_payload) AS payload,
               last_updated
        FROM hugo_learned_knowledge
        ORDER BY last_updated DESC
        LIMIT 20
      `).catch(() => ({ rows: [] })),

      // Operators with custom rules (prompt injection surface)
      pool.query(`
        SELECT u.id, u.name, u.email, u.business_type,
               bc.custom_rules
        FROM operator_profiles op
        JOIN users u ON u.id = op.operator_id
        CROSS JOIN LATERAL (
          SELECT op.business_customization->>'custom_rules' AS custom_rules
        ) bc
        WHERE bc.custom_rules IS NOT NULL
          AND bc.custom_rules <> ''
        ORDER BY u.name
      `).catch(() => ({ rows: [] })),

      // Sample recent knowledge entries (max 50)
      pool.query(`
        SELECT id, knowledge_text, trade_slug, source, confidence,
               validated, created_at
        FROM hugo_knowledge_entries
        ORDER BY
          CASE confidence WHEN 'trained' THEN 0 WHEN 'learned' THEN 1 ELSE 2 END,
          created_at DESC
        LIMIT 50
      `).catch(() => ({ rows: [] })),

      // Recent pricing mismatches (audit evidence)
      pool.query(`
        SELECT content_key, hugo_quoted, actual_value, domain,
               auto_corrected, detected_at
        FROM content_mismatches
        ORDER BY detected_at DESC
        LIMIT 50
      `).catch(() => ({ rows: [] })),
    ]);

    // Read prompts from modules if exported, otherwise surface file paths for audit
    const prompts = {
      brain_personality: {
        source: 'routes/hugo-brain.js :: HUGO_BASE_PERSONALITY',
        description: 'Layer 1 — core personality injected on every brain endpoint call',
        content: hugoBrainModule?.HUGO_BASE_PERSONALITY || '[module does not export — read file directly]',
      },
      channel_context_trade: {
        source: "routes/hugo-brain.js :: CHANNEL_CONTEXT['propops.trade']",
        description: 'Layer 3 domain context for propops.trade visitors',
        content: hugoBrainModule?.CHANNEL_CONTEXT?.['propops.trade'] || '[read file: routes/hugo-brain.js]',
      },
      channel_context_re: {
        source: "routes/hugo-brain.js :: CHANNEL_CONTEXT['propops.pro']",
        description: 'Layer 3 domain context for propops.pro visitors',
        content: hugoBrainModule?.CHANNEL_CONTEXT?.['propops.pro'] || '[read file: routes/hugo-brain.js]',
      },
      channel_context_dashboard: {
        source: "routes/hugo-brain.js :: CHANNEL_CONTEXT['propopspro.polsia.app']",
        description: 'Layer 3 context for in-app dashboard (operator-facing)',
        content: hugoBrainModule?.CHANNEL_CONTEXT?.['propopspro.polsia.app'] || '[read file: routes/hugo-brain.js]',
      },
      re_widget_prompt: {
        source: 'services/re-agent-prompt.js :: RE_AGENT_SYSTEM_PROMPT',
        description: 'Full static system prompt for propops.pro widget — hardcoded, no DB sync',
        content: reAgentPromptModule?.RE_AGENT_SYSTEM_PROMPT || '[read file: services/re-agent-prompt.js]',
        warning: 'STATIC — pricing changes require a code deploy. Unlike tradie prompt which uses DB Layer 3.',
      },
    };

    const pricing = {
      approved_prices: [69, 99],
      constants: {
        'propops.trade': { monthly: 69, display: '$69/month', trial: '14 days free, no credit card' },
        'propops.pro':   { monthly: 99, display: '$99/month', trial: '14 days free, no credit card' },
        early_bird_deadline: 'June 30, 2026',
        early_bird_pro: 69,
      },
      source: 'routes/hugo-brain.js :: PRICING_CONSTANTS',
      correction_regex: '/\\$(\\d{2,4})(?:\\s*\\/\\s*(?:mo(?:nth)?|mth|per\\s*month))?\\b/gi',
      correction_exemption: 'Amounts >$500 are exempt (assumed to be operator job quotes, not subscription pricing)',
      warning_bug: 'BUG: Correction regex fires on small job quotes ($50–$499). E.g. "$80 callout fee" gets replaced with "$69/month". Applies to brain endpoint only.',
      voice_fast_path: {
        source: 'services/hugo-voice.js :: isPriceQuery fast-path',
        trade: "PropOps is $69 a month — locked in for life if you sign up before June 30. After that it goes to $99. You'll need a card to start the trial but you won't be charged for 14 days.",
        re: "PropOps is $69 a month right now — launch special, locked in for life if you sign up before June 30. After that it goes to $99. You'll need a card to start the trial but you won't be charged for 14 days.",
        warning_bug: "BUG: Voice says 'You'll need a card' — contradicts all other channels which say 'no credit card required'.",
      },
      template_fallback: {
        source: 'routes/hugo-widget.js :: template fallback when AI unavailable',
        content: "PropOps is **$69/month** (or save with the annual plan at $999/year).",
        warning_bug: "BUG: $999/year annual plan is NOT in APPROVED_PRICES. Bypasses all pricing guards because it's served before AI is invoked.",
      },
      re_prompt_static: {
        source: 'services/re-agent-prompt.js',
        content: '$99/mo standard, $69/mo launch special before June 30 2026',
        warning: 'Static string — requires code deploy to change.',
      },
    };

    const persona = {
      domain_detection: {
        source: 'routes/hugo-widget.js :: detectDomain()',
        logic: "Origin/Referer header → contains 'propops.trade' → tradie, contains 'propops.pro' → RE, unknown → tradie (default)",
      },
      selection_priority: [
        '0 (highest): Visitor tradie signal detection — if visitor speech contains trade language + business context → ALWAYS tradie persona regardless of domain',
        '1: body.business_type field from authenticated dashboard',
        '2: Domain from Origin/Referer header',
        'Default (unknown): tradie persona',
      ],
      voice_persona_switch: {
        source: 'services/hugo-voice.js :: lines 56–115',
        default: 'trade',
        switch_trigger: 'Single RE keyword in caller speech (e.g. "rent", "property", "inspection", "invest")',
        switch_weight: 'RE: 1.0, Trade: 0.8. Score > 0 = RE lock.',
        lock: 'PERMANENT — once RE persona is locked for a call, it cannot switch back.',
        warning_bug: 'BUG: A tradie calling about "the investment property in Bondi" will get RE buyer-qualification for the rest of the call.',
      },
      greetings: {
        widget: '"I\'m Hugo from PropOps. What\'s your name and how can we help you today?" — same for both personas',
        voice_trade: '"G\'day, Hugo here from PropOps — the team\'s on a job at the moment so you\'ve got me. What can I help you with?"',
        voice_re: '"G\'day, I\'m Hugo with PropOps — the AI receptionist for our property team. I help with rentals, purchases, and investments. What can I help you with?"',
        note: 'Voice greetings do not ask for name upfront. Widget always asks immediately.',
      },
    };

    const guardrails = {
      banned_words: {
        source: 'routes/hugo-brain.js :: BANNED_WORDS',
        scope: 'Brain endpoint ONLY (POST /api/hugo/brain). NOT applied to voice or legacy widget path.',
        rules: [
          '"mate" → removed',
          '"sir" → removed',
          '"madam" → removed',
          '"mmhmm" → "Ok cool"',
          '"technical hiccup" → "quick issue"',
          '"Certainly!" → removed',
          '"Absolutely!" → removed',
          '"Of course!" → removed',
          '"I\'d be happy to" → "I\'ll"',
          '"Great question!" → removed',
        ],
      },
      character_break_detection: {
        source: 'routes/hugo-brain.js + services/hugo.js',
        patterns: [
          '"as an AI"',
          '"I\'m an artificial intelligence"',
          '"I don\'t have feelings"',
          '"I\'m a language model"',
          '"I am an AI"',
          '"as a large language model"',
          '"I\'m just an AI"',
        ],
        recovery: 'Retry with CRITICAL: prefix on persona prompt at temperature 0.5. If retry still breaks, fall back to OpenAI proxy.',
      },
      email_risk_classification: {
        source: 'services/hugo-email.js :: RISKY_KEYWORDS',
        triggers: [
          'Large dollar amounts ($1000+)',
          'legal, lawyer, solicitor, sue, court, dispute, tribunal',
          'refund, cancel contract, void agreement',
          'urgent, emergency, asap, immediately',
          'angry, furious, disgusted, unacceptable, fraud, scam',
          'media, journalist, review public, social media',
        ],
        behavior: 'Risky emails: Hugo flags and refuses to draft. Sends: "Boss — this one needs your eyes before I touch it."',
      },
    };

    const memory = {
      widget_session: {
        source: 'routes/hugo-widget.js',
        storage: 'In-memory Map (process-local) + DB hugo_widget_sessions',
        max_turns: 20,
        ttl: '24 hours (in-memory expiry). DB record persists indefinitely.',
        cold_start: 'Cache miss → load from DB',
      },
      brain_history_window: {
        source: 'routes/hugo-brain.js',
        turns_sent_to_ai: 8,
      },
      voice_history_window: {
        source: 'services/hugo-voice.js',
        turns_sent_to_ai: 6,
        persistent_store: 'voice_calls.transcript (JSONB) — no expiry',
      },
      dashboard_chat_history: {
        source: 'services/hugo.js :: generateGeneralResponse()',
        db_fetch: 'Last 30 messages from hugo_chat_messages',
        sent_to_ai: 15,
      },
      cross_channel_lead_memory: {
        source: 'services/hugo-learning.js :: upsertLeadMemory()',
        table: 'hugo_lead_memory',
        key: '(operator_id, phone) or (operator_id, email)',
        expiry: 'NONE — persists indefinitely',
        injected_as: 'Layer 2d: "RETURNING LEAD DETECTED — this person has contacted us before"',
        fields: 'lead_name, last_channel, trade_slug, job_description, location, conversation_summary',
      },
    };

    const godLayer = {
      operator_custom_rules: {
        source: 'services/hugo.js :: buildHugoV3SystemPrompt()',
        field: 'operator_profiles.business_customization.custom_rules',
        authority: '"ABSOLUTE AUTHORITY" — injected verbatim at end of dashboard system prompt',
        sanitisation: 'NONE — prompt injection surface. An operator can inject adversarial instructions.',
        operators_with_rules: operatorCustomRules.rows,
      },
      founder_override: 'No founder-level override layer exists yet. Hard-coded PRICING_CONSTANTS cannot be overridden by any DB content or custom_rules.',
      faq_cache: {
        source: 'routes/hugo-widget.js :: lookupFaqCache()',
        warning: 'FAQ cache answers bypass ALL pricing correction and AI invocation. Served directly to visitor. Stale entries ship unchecked.',
        entries: faqCache.rows,
      },
    };

    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      sections: {
        prompts,
        pricing,
        persona,
        guardrails,
        memory,
        god_layer: godLayer,
        training_data: {
          knowledge_entries_summary: knowledgeSummary.rows,
          legacy_training: trainingLegacy.rows[0] || {},
          recent_entries: knowledgeEntries.rows,
          learned_knowledge: learnedKnowledge.rows,
        },
        audit: {
          price_mismatches_recent: priceMismatches.rows,
          bugs_found: [
            {
              id: 1,
              severity: 'HIGH',
              title: 'Voice price fast-path contradicts all other channels',
              detail: "Voice says 'You'll need a card to start the trial'. Every other channel says 'no credit card required'.",
              file: 'services/hugo-voice.js ~line 749',
            },
            {
              id: 2,
              severity: 'HIGH',
              title: 'Template fallback quotes $999/year (unapproved price, bypasses pricing guard)',
              detail: "Widget template fallback (served when AI unavailable) says '$999/year annual plan'. Not in APPROVED_PRICES. Bypasses checkAndCorrectMismatches().",
              file: 'routes/hugo-widget.js ~line 579',
            },
            {
              id: 3,
              severity: 'MEDIUM',
              title: 'RE Agent widget prompt is static (no DB sync)',
              detail: 'propops.pro widget uses a hardcoded static string. Pricing changes require a code deploy. Tradie widget has dynamic DB Layer 3.',
              file: 'services/re-agent-prompt.js',
            },
            {
              id: 4,
              severity: 'MEDIUM',
              title: 'Pricing correction regex fires on small job quotes ($50–$499)',
              detail: "Generic trade rates ($80 handyman, $150 plumbing) are in range. Hugo quoting '$80 callout fee' gets silently replaced with '$69/month'.",
              file: 'routes/hugo-brain.js ~line 568',
            },
            {
              id: 5,
              severity: 'MEDIUM',
              title: 'Voice persona switch locks on single weak keyword (permanent)',
              detail: "One RE keyword ('property', 'invest', 'suburb') permanently locks the call to RE persona. A tradie at 'the investment property in Bondi suburb' gets RE buyer-qualification for the rest of the call.",
              file: 'services/hugo-voice.js ~line 95',
            },
            {
              id: 6,
              severity: 'LOW',
              title: 'RESOLVED: hugo-brain.js Groq model — now llama-3.3-70b-versatile',
              detail: "HUGO_GROQ_MODEL env var defaults to 'llama-3.3-70b-versatile' (Groq free tier). No action required.",
              file: 'routes/hugo-brain.js',
            },
            {
              id: 7,
              severity: 'LOW',
              title: 'Operator custom_rules injected verbatim with no sanitisation (prompt injection)',
              detail: "business_customization.custom_rules is injected as 'ABSOLUTE AUTHORITY'. No sanitisation. An operator can inject adversarial instructions.",
              file: 'services/hugo.js ~lines 1274–1279',
            },
            {
              id: 8,
              severity: 'LOW',
              title: 'FAQ cache bypasses all pricing correction and AI invocation',
              detail: 'FAQ cache answers are served directly to visitors without going through pricing guards. Stale entries with wrong prices ship unchecked.',
              file: 'routes/hugo-widget.js :: lookupFaqCache()',
            },
            {
              id: 9,
              severity: 'INFO',
              title: 'propops.pro pricing inconsistency: $99 in brain endpoint, $69 in widget',
              detail: "PRICING_CONSTANTS['propops.pro'].display = '$99/month' in hugo-brain.js. RE widget system prompt says '$69/mo' is the current launch price. Same domain, different code path, different quoted price.",
              file: 'routes/hugo-brain.js vs services/re-agent-prompt.js',
            },
          ],
        },
      },
    });
  } catch (err) {
    console.error('[Founder] Brain export error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Section 11: Self-Learning Log ────────────────────────────────────────────
// Cross-platform autonomous mistake detection and proposed fixes.
// GET /api/founder/self-learning-log — paginated list with filters
router.get('/self-learning-log', async (req, res) => {
  const pool = getPool();
  const { status, platform, category, limit = 50, offset = 0 } = req.query;

  try {
    const conditions = ['1=1'];
    const params = [];

    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (platform) { params.push(platform); conditions.push(`source_platform = $${params.length}`); }
    if (category) { params.push(category); conditions.push(`category = $${params.length}`); }

    const where = conditions.join(' AND ');
    params.push(parseInt(limit, 10) || 50);
    params.push(parseInt(offset, 10) || 0);

    const [itemsResult, countResult, statsResult] = await Promise.all([
      pool.query(
        `SELECT id, detected_at, source_platform, category, mistake_description,
                times_repeated, proposed_fix, status, is_systemic,
                approved_at, approved_by, knowledge_entry_id, created_at
         FROM hugo_self_learning_log
         WHERE ${where}
         ORDER BY
           CASE WHEN is_systemic THEN 0 ELSE 1 END,
           CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
           detected_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*) as total FROM hugo_self_learning_log WHERE ${where}`,
        params.slice(0, -2)
      ),
      pool.query(
        `SELECT status, COUNT(*) as cnt,
                COUNT(*) FILTER (WHERE is_systemic) as systemic_cnt
         FROM hugo_self_learning_log
         GROUP BY status`
      ),
    ]);

    res.json({
      success: true,
      items: itemsResult.rows,
      total: parseInt(countResult.rows[0]?.total || 0),
      stats: statsResult.rows.reduce((acc, r) => {
        acc[r.status] = { count: parseInt(r.cnt), systemic: parseInt(r.systemic_cnt) };
        return acc;
      }, {}),
    });
  } catch (err) {
    console.error('[Founder] Self-learning log fetch error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/founder/self-learning-log/:id/action — approve or reject a single item
router.post('/self-learning-log/:id/action', async (req, res) => {
  const logId = parseInt(req.params.id, 10);
  const { action } = req.body || {};

  if (!action || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({ success: false, message: 'action must be approve or reject' });
  }

  try {
    const { updateSelfLearningLogStatus } = require('../services/simulation-eval');
    const result = await updateSelfLearningLogStatus(logId, action === 'approve' ? 'approved' : 'rejected');
    res.json(result);
  } catch (err) {
    console.error('[Founder] Self-learning log action error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/founder/self-learning-log/bulk-approve-safe — approve all low-risk items
router.post('/self-learning-log/bulk-approve-safe', async (req, res) => {
  try {
    const { bulkApproveSafeItems } = require('../services/simulation-eval');
    const result = await bulkApproveSafeItems();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Founder] Bulk approve safe error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Section 12: Live Correction (god-layer, no approval step) ─────────────────
// POST /api/founder/live-correction — founder corrects Hugo in real-time
// Correction locks IMMEDIATELY to trained-tier knowledge (highest authority).
router.post('/live-correction', async (req, res) => {
  const { trigger_text, correct_text, context, correction_type, operator_id } = req.body || {};

  if (!trigger_text || !correct_text) {
    return res.status(400).json({ success: false, message: 'trigger_text and correct_text required' });
  }
  if (correct_text.trim().length < 3) {
    return res.status(400).json({ success: false, message: 'correct_text must be at least 3 characters' });
  }

  try {
    const { applyLiveCorrection } = require('../services/simulation-eval');
    const result = await applyLiveCorrection({
      operatorId: operator_id || null,
      triggerText: trigger_text,
      correctText: correct_text,
      context: context || '',
      correctionType: correction_type || 'general',
    });
    res.json(result);
  } catch (err) {
    console.error('[Founder] Live correction error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/founder/live-corrections — list recent live corrections (audit trail)
router.get('/live-corrections', async (req, res) => {
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT id, operator_id, correction_type, trigger_text, correct_text,
              context, is_global, knowledge_entry_id, created_at
       FROM hugo_live_corrections
       ORDER BY created_at DESC
       LIMIT 50`
    );
    res.json({ success: true, corrections: result.rows });
  } catch (err) {
    console.error('[Founder] Live corrections list error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Section 13: God-Layer Config (Pricing Locks + Global Rules) ──────────────
// Founder-only controls that sit ABOVE operator-level training.
// Hugo brain reads these on every request — these rules CANNOT be overridden by operators.
//
// GET  /api/founder/god-config           — list all config rows
// POST /api/founder/god-config           — upsert a config row
// DELETE /api/founder/god-config/:key    — delete a non-pricing-lock config row

router.get('/god-config', async (req, res) => {
  try {
    const { getAllConfig } = require('../services/founder-config');
    const rows = await getAllConfig();
    res.json({ success: true, config: rows });
  } catch (err) {
    console.error('[Founder] God-config list error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/god-config', async (req, res) => {
  const { config_key, config_value, description, is_locked, vertical } = req.body || {};

  if (!config_key || config_value === undefined || config_value === null) {
    return res.status(400).json({ success: false, message: 'config_key and config_value required' });
  }
  if (config_key.length > 120) {
    return res.status(400).json({ success: false, message: 'config_key too long (max 120 chars)' });
  }
  if (String(config_value).length > 2000) {
    return res.status(400).json({ success: false, message: 'config_value too long (max 2000 chars)' });
  }

  // Pricing lock keys must be numeric
  if (config_key.startsWith('pricing_lock.') && isNaN(parseInt(String(config_value), 10))) {
    if (!String(config_value).match(/^[A-Za-z0-9 ,]+$/)) {
      return res.status(400).json({ success: false, message: 'Pricing lock value must be a number or date string' });
    }
  }

  try {
    const { upsertConfig } = require('../services/founder-config');
    const row = await upsertConfig({ config_key, config_value: String(config_value), description, is_locked, vertical });
    res.json({ success: true, row });
  } catch (err) {
    console.error('[Founder] God-config upsert error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/god-config/:key', async (req, res) => {
  const key = decodeURIComponent(req.params.key || '');
  if (!key) return res.status(400).json({ success: false, message: 'config_key required' });

  try {
    const { deleteConfig } = require('../services/founder-config');
    const deleted = await deleteConfig(key);
    if (!deleted) return res.status(404).json({ success: false, message: 'Config key not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Founder] God-config delete error:', err.message);
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── Section 14: Integrations Status Panel ────────────────────────────────────
// Live status + stats for all services that power Hugo/PropOps.
// Returns an array of service objects grouped by category.
// Each service: { id, name, category, status ('connected'|'not_connected'|'error'),
//                 stats (array of {label, value}), link, link_label }
//
// Owns: integration health checks, per-service live stat fetches.
// Does NOT own: billing logic, AI logic, operator metrics.

const https = require('https');

// Tiny helper — fire an HTTPS GET, parse JSON, resolve in ms timeout
function fetchJSON(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const reqOpts = {
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ''),
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: 6000,
    };
    const req = https.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Fetch Twilio account stats
async function getTwilioStats() {
  const sid  = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !auth) return null;

  const today = new Date();
  const yyyy = today.getUTCFullYear();
  const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(today.getUTCDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  const creds = Buffer.from(`${sid}:${auth}`).toString('base64');
  const [callsRes, msgsRes, numbersRes] = await Promise.allSettled([
    fetchJSON(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json?StartTime>=${dateStr}&PageSize=1`,
      { headers: { Authorization: `Basic ${creds}` } }
    ),
    fetchJSON(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?DateSent>=${dateStr}&PageSize=1`,
      { headers: { Authorization: `Basic ${creds}` } }
    ),
    // Fetch the actual active incoming phone numbers from Twilio (avoids stale env var)
    fetchJSON(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=5`,
      { headers: { Authorization: `Basic ${creds}` } }
    ),
  ]);

  const callsTotal = callsRes.status === 'fulfilled' ? (callsRes.value.data?.total || 0) : null;
  const msgsTotal  = msgsRes.status === 'fulfilled'  ? (msgsRes.value.data?.total || 0) : null;

  // Use the first AU number from the account; fall back to the confirmed active number
  let activeNumber = '+61 2 5301 0002';
  if (numbersRes.status === 'fulfilled' && numbersRes.value.data?.incoming_phone_numbers?.length > 0) {
    const nums = numbersRes.value.data.incoming_phone_numbers;
    const auNum = nums.find(n => (n.phone_number || '').startsWith('+61'));
    activeNumber = auNum ? auNum.phone_number : nums[0].phone_number;
  }

  return { callsToday: callsTotal, smsToday: msgsTotal, activeNumber };
}

// Fetch Resend domain stats (daily window)
async function getResendStats() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  // Resend /emails endpoint returns recent emails — use small page to check connectivity
  const res = await fetchJSON('https://api.resend.com/emails?limit=10', {
    headers: { Authorization: `Bearer ${key}` }
  });
  if (res.status !== 200) return null;
  const emails = res.data?.data || [];
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = emails.filter(e => (e.created_at || '').startsWith(today)).length;
  return { sentToday, recentCount: emails.length };
}

// Fetch Stripe live stats
async function getStripeStats() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const creds = Buffer.from(`${key}:`).toString('base64');
  // Active subscriptions count
  const subsRes = await fetchJSON('https://api.stripe.com/v1/subscriptions?status=active&limit=1', {
    headers: { Authorization: `Basic ${creds}` }
  });
  if (subsRes.status !== 200) return null;
  const activeSubs = subsRes.data?.total_count || 0;

  // Recent charges (last 5)
  const chargesRes = await fetchJSON('https://api.stripe.com/v1/charges?limit=5', {
    headers: { Authorization: `Basic ${creds}` }
  });
  const recentCharges = chargesRes.data?.data || [];
  const recentTotal = recentCharges
    .filter(c => c.paid && !c.refunded)
    .reduce((s, c) => s + (c.amount || 0), 0);

  return {
    activeSubs,
    recentPaymentsAUD: (recentTotal / 100).toFixed(2),
    recentPaymentsCount: recentCharges.filter(c => c.paid).length,
  };
}

// Fetch Groq usage (estimate from hugo_widget_sessions + hugo_chat_messages counts)
// Groq does not expose a public usage API — we estimate from our own DB
async function getGroqStats(pool) {
  // Check DB credential first, fall back to env var
  let key = null;
  try {
    const credRow = await pool.query(
      `SELECT api_key FROM credentials WHERE service_name = 'groq' LIMIT 1`
    );
    if (credRow.rows[0]?.api_key) key = credRow.rows[0].api_key;
  } catch (_) {}
  if (!key) key = process.env.GROQ_API_KEY;
  if (!key || key.length < 20) return null;

  const [widgetRes, dashRes, simRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS c FROM hugo_widget_sessions WHERE created_at::date = CURRENT_DATE`),
    pool.query(`SELECT COUNT(*) AS c FROM hugo_chat_messages WHERE created_at::date = CURRENT_DATE AND sender = 'assistant'`),
    pool.query(`SELECT COUNT(*) AS c FROM hugo_sim_outcomes WHERE created_at::date = CURRENT_DATE`).catch(() => ({ rows: [{ c: 0 }] })),
  ]);
  const apiCallsToday = parseInt(widgetRes.rows[0]?.c || 0, 10)
    + parseInt(dashRes.rows[0]?.c || 0, 10)
    + parseInt(simRes.rows[0]?.c || 0, 10);

  // Estimate tokens: ~200 avg tokens per call (8b model)
  const tokensEst = apiCallsToday * 200;
  // Cost: llama-3.3-70b-versatile ~$0.05/1M tokens (Groq pricing)
  const costEst = (tokensEst * 0.00000005).toFixed(4);
  return { apiCallsToday, tokensEst, costEstUSD: costEst, model: process.env.HUGO_GROQ_MODEL || 'llama-3.3-70b-versatile' };
}

// Fetch analytics stats from DB
async function getAnalyticsStats(pool) {
  try {
    const [todayRes, allTimeRes] = await Promise.all([
      pool.query(`SELECT domain, COUNT(*) AS views, COUNT(DISTINCT session_id) AS visitors
                  FROM page_analytics WHERE created_at::date = CURRENT_DATE
                  GROUP BY domain`),
      pool.query(`SELECT COUNT(*) AS total_visitors FROM page_analytics WHERE created_at::date = CURRENT_DATE`),
    ]);
    const byDomain = {};
    for (const row of todayRes.rows) {
      byDomain[row.domain] = { views: parseInt(row.views, 10), visitors: parseInt(row.visitors, 10) };
    }
    const total = parseInt(allTimeRes.rows[0]?.total_visitors || 0, 10);
    return { byDomain, totalToday: total };
  } catch (e) {
    return null;
  }
}

router.get('/integrations-status', async (req, res) => {
  const pool = getPool();

  // Run all fetches in parallel, never let one failure kill the whole response
  const [twilioStats, resendStats, stripeStats, groqStats, analyticsStats] = await Promise.allSettled([
    getTwilioStats(),
    getResendStats(),
    getStripeStats(),
    getGroqStats(pool),
    getAnalyticsStats(pool),
  ]);

  const tw  = twilioStats.status   === 'fulfilled' ? twilioStats.value   : null;
  const rs  = resendStats.status   === 'fulfilled' ? resendStats.value   : null;
  const st  = stripeStats.status   === 'fulfilled' ? stripeStats.value   : null;
  const gr  = groqStats.status     === 'fulfilled' ? groqStats.value     : null;
  const an  = analyticsStats.status === 'fulfilled' ? analyticsStats.value : null;

  const hasKey = (k) => !!(process.env[k] && process.env[k].length > 10);
  const conn = (v) => v !== null ? 'connected' : 'not_connected';

  // Lead Portals — dynamic status from operator_portal_connections + portal_sender_registry
  let portalStatuses = [];
  let leadsToday = 0;
  try {
    // Get all registered portals and their connection status across ALL operators
    const portalRes = await pool.query(`
      SELECT
        r.portal_key, r.portal_name, r.display_order,
        COUNT(DISTINCT c.user_id) AS operators_connected,
        COALESCE(SUM(c.emails_count), 0) AS total_emails,
        COALESCE(SUM(c.leads_count), 0) AS total_leads,
        MAX(c.last_email_at) AS last_email_at
      FROM portal_sender_registry r
      LEFT JOIN operator_portal_connections c ON c.portal_key = r.portal_key
      WHERE r.is_active = true
      GROUP BY r.portal_key, r.portal_name, r.display_order
      ORDER BY r.display_order ASC
    `);
    portalStatuses = portalRes.rows;
  } catch (e) { /* table may not exist yet — fall back gracefully */ }
  try {
    const lr = await pool.query(`SELECT COUNT(*) AS c FROM operator_widget_leads WHERE created_at::date = CURRENT_DATE`);
    leadsToday = parseInt(lr.rows[0]?.c || 0, 10);
  } catch (e) { /* ignore */ }
  const anyPortalConnected = portalStatuses.some(p => parseInt(p.operators_connected, 10) > 0);

  // Gmail — count total emails received via intake_tokens (no OAuth, manual forwarding)
  let gmailEmailsTotal = 0;
  try {
    const gr2 = await pool.query(`SELECT COALESCE(SUM(emails_received), 0) AS total FROM intake_tokens WHERE is_active = true`);
    gmailEmailsTotal = parseInt(gr2.rows[0]?.total || 0, 10);
  } catch (e) { /* ignore */ }

  // Render health check
  let renderStatus = 'not_connected';
  let renderResponseMs = null;
  try {
    const start = Date.now();
    const appUrl = process.env.APP_URL || 'https://propopspro.polsia.app';
    const healthRes = await fetchJSON(`${appUrl}/health`);
    renderResponseMs = Date.now() - start;
    renderStatus = healthRes.status === 200 ? 'connected' : 'error';
  } catch (e) { renderStatus = 'error'; }

  const services = [
    // ── AI ───────────────────────────────────────────────────────────────────
    {
      id: 'groq',
      name: 'Groq',
      description: "Hugo's AI brain (Llama 3.1 8B)",
      category: 'AI',
      status: gr ? 'connected' : (gr !== null || hasKey('GROQ_API_KEY') ? 'connected' : 'not_connected'),
      stats: gr ? [
        { label: 'API calls today', value: gr.apiCallsToday },
        { label: 'Tokens est.', value: gr.tokensEst.toLocaleString() },
        { label: 'Cost est.', value: '$' + gr.costEstUSD + ' USD' },
        { label: 'Model', value: gr.model },
      ] : [
        { label: 'Status', value: hasKey('GROQ_API_KEY') ? 'Key configured' : 'No API key' },
      ],
      link: 'https://console.groq.com/usage',
      link_label: 'Open Groq →',
    },
    {
      id: 'gemini',
      name: 'Gemini',
      description: 'Data reads + price verification',
      category: 'AI',
      status: hasKey('GEMINI_API_KEY') ? 'connected' : 'not_connected',
      stats: [
        { label: 'Use case', value: 'Landing page sync + price verification' },
        { label: 'Key', value: hasKey('GEMINI_API_KEY') ? 'Configured' : 'Not set — configure GEMINI_API_KEY' },
      ],
      link: 'https://aistudio.google.com/',
      link_label: 'Open Google AI Studio →',
    },
    // ── Comms ────────────────────────────────────────────────────────────────
    {
      id: 'twilio',
      name: 'Twilio',
      description: 'Phone intake (+61 2 5301 0002)',
      category: 'Comms',
      status: tw ? 'connected' : (hasKey('TWILIO_ACCOUNT_SID') ? 'connected' : 'not_connected'),
      stats: tw ? [
        { label: 'Calls today', value: tw.callsToday !== null ? tw.callsToday : '—' },
        { label: 'SMS today', value: tw.smsToday !== null ? tw.smsToday : '—' },
        // Use number fetched directly from Twilio API — env var TWILIO_FROM_NUMBER may be stale
        { label: 'Number', value: tw.activeNumber || '+61 2 5301 0002' },
      ] : [
        { label: 'Key', value: hasKey('TWILIO_ACCOUNT_SID') ? 'Configured' : 'Not set' },
      ],
      link: 'https://console.twilio.com/',
      link_label: 'Open Twilio →',
    },
    {
      id: 'resend',
      name: 'Resend',
      description: 'Outbound email delivery',
      category: 'Comms',
      status: rs ? 'connected' : (hasKey('RESEND_API_KEY') ? 'connected' : 'not_connected'),
      stats: rs ? [
        { label: 'Recent emails', value: rs.recentCount },
        { label: 'Sent today', value: rs.sentToday },
      ] : [
        { label: 'Key', value: hasKey('RESEND_API_KEY') ? 'Configured' : 'Not set — configure RESEND_API_KEY' },
      ],
      link: 'https://resend.com/emails',
      link_label: 'Open Resend →',
    },
    {
      id: 'gmail',
      name: 'Gmail',
      description: 'Inbound forwarding (trade portals)',
      category: 'Comms',
      // Connected = at least 1 email received via manual forwarding (no OAuth needed)
      status: gmailEmailsTotal > 0 ? 'connected' : 'not_connected',
      stats: gmailEmailsTotal > 0 ? [
        { label: 'Status', value: 'Connected (Manual Forwarding)' },
        { label: 'Emails received', value: gmailEmailsTotal },
      ] : [
        { label: 'Status', value: 'Manual forwarding — no emails received yet' },
        { label: 'Setup', value: 'Configure Gmail forwarding rules in the operator dashboard' },
      ],
      link: 'https://mail.google.com/',
      link_label: 'Open Gmail →',
    },
    {
      id: 'call-forwarding',
      name: 'Call Forwarding',
      description: 'Route calls to operator',
      category: 'Comms',
      status: hasKey('TWILIO_ACCOUNT_SID') ? 'connected' : 'not_connected',
      stats: [
        { label: 'Provider', value: 'Twilio (same key)' },
        { label: 'Routing', value: 'Hugo answers + transfers on request' },
      ],
      link: 'https://console.twilio.com/us1/develop/phone-numbers/manage/incoming',
      link_label: 'Twilio Numbers →',
    },
    // ── Leads ────────────────────────────────────────────────────────────────
    {
      id: 'hunter',
      name: 'Hunter',
      description: 'Bot engine / email sequences',
      category: 'Leads',
      status: hasKey('HUNTER_API_KEY') ? 'connected' : 'not_connected',
      stats: [
        { label: 'Status', value: hasKey('HUNTER_API_KEY') ? 'Key configured' : 'Not set — configure HUNTER_API_KEY' },
      ],
      link: 'https://hunter.io/email-verifier',
      link_label: 'Open Hunter →',
    },
    {
      id: 'lead-portals',
      name: 'Lead Portals',
      description: 'Auto-detected via Gmail forwarding',
      category: 'Leads',
      // Connected if ANY portal has ever received a forwarded email
      status: anyPortalConnected ? 'connected' : 'not_connected',
      stats: [
        { label: 'Leads today (all portals)', value: leadsToday },
        ...portalStatuses.map(p => ({
          label: p.portal_name,
          value: parseInt(p.operators_connected, 10) > 0
            ? '🟢 Connected (' + p.total_emails + ' emails, ' + p.total_leads + ' leads)'
            : '⏳ Waiting for first email',
        })),
      ],
      link: 'https://hipages.com.au/tradesperson/login',
      link_label: 'Hipages →',
      extra_links: [
        { url: 'https://www.serviceseeking.com.au/login', label: 'ServiceSeeking →' },
        { url: 'https://www.airtasker.com/login/', label: 'Airtasker →' },
      ],
    },
    // ── Billing ──────────────────────────────────────────────────────────────
    {
      id: 'stripe',
      name: 'Stripe',
      description: 'Subscriptions & billing (AUD)',
      category: 'Billing',
      status: st ? 'connected' : (hasKey('STRIPE_SECRET_KEY') ? 'connected' : 'not_connected'),
      stats: st ? [
        { label: 'Active subs', value: st.activeSubs },
        { label: 'Recent payments (5)', value: 'AUD $' + st.recentPaymentsAUD },
        { label: 'Paid count (recent 5)', value: st.recentPaymentsCount },
      ] : [
        { label: 'Key', value: hasKey('STRIPE_SECRET_KEY') ? 'Configured' : 'Not set' },
      ],
      link: 'https://dashboard.stripe.com/subscriptions',
      link_label: 'Open Stripe →',
    },
    // ── Infrastructure ───────────────────────────────────────────────────────
    {
      id: 'analytics',
      name: 'Analytics',
      description: 'Visitor tracking (propops.pro + propops.trade)',
      category: 'Infrastructure',
      status: an ? 'connected' : 'not_connected',
      stats: an ? [
        { label: 'Visitors today', value: an.totalToday },
        { label: 'propops.pro views', value: an.byDomain?.['propops.pro']?.views ?? 0 },
        { label: 'propops.trade views', value: an.byDomain?.['propops.trade']?.views ?? 0 },
      ] : [
        { label: 'Status', value: 'page_analytics table unavailable' },
      ],
      link: '/founder#analytics',
      link_label: 'View Analytics →',
    },
    {
      id: 'porkbun',
      name: 'Porkbun',
      description: 'Domain routing (propops.pro, propops.trade)',
      category: 'Infrastructure',
      // DNS is managed manually via Porkbun dashboard — no API key needed
      status: 'connected',
      stats: [
        { label: 'Domains', value: 'propops.pro · propops.trade' },
        { label: 'Status', value: 'Manual — DNS configured' },
      ],
      link: 'https://porkbun.com/account/domainsSpeedy',
      link_label: 'Open Porkbun →',
    },
    {
      id: 'render',
      name: 'Render',
      description: 'App hosting (propopspro.polsia.app)',
      category: 'Infrastructure',
      status: renderStatus,
      stats: [
        { label: 'Health', value: renderStatus === 'connected' ? '✅ Up' : '🔴 Unreachable' },
        { label: 'Response', value: renderResponseMs !== null ? renderResponseMs + 'ms' : '—' },
        { label: 'App URL', value: process.env.APP_URL || 'propopspro.polsia.app' },
      ],
      link: 'https://dashboard.render.com/',
      link_label: 'Open Render →',
    },
  ];

  res.json({ success: true, services, timestamp: new Date().toISOString() });
});

// ─── Section 15: Payroll & Invoicing Summary ───────────────────────────────
// Cross-operator aggregate view of Hugo.Pays data.
// READ-ONLY: queries invoices, roster_entries, staff_members, payroll_entries.
// No mutations — founders see aggregate visibility only.
router.get('/payroll-summary', async (req, res) => {
  const pool = getPool();
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const weekStart = new Date(now.getTime() - (now.getDay() || 7) * 86400000).toISOString().slice(0, 10);

    const [invoiceSummary, invoiceByOperator, rosterByOperator, overdueInvoices] = await Promise.all([

      // Top-level invoice aggregate stats (all operators)
      pool.query(`
        SELECT
          COUNT(*) AS total_invoices,
          COUNT(*) FILTER (WHERE created_at >= $1) AS invoices_this_month,
          COALESCE(SUM(CASE WHEN status = 'paid' THEN total_inc_gst ELSE amount END) FILTER (WHERE status = 'paid'), 0) AS total_collected,
          COUNT(*) FILTER (WHERE status NOT IN ('paid','draft') AND due_date < CURRENT_DATE) AS overdue_count,
          COALESCE(SUM(CASE WHEN status NOT IN ('paid','draft') AND due_date < CURRENT_DATE THEN COALESCE(total_inc_gst, amount) END), 0) AS overdue_amount
        FROM invoices
      `, [monthStart]),

      // Per-operator invoice breakdown
      pool.query(`
        SELECT
          u.id AS operator_id,
          COALESCE(u.name, u.email) AS operator_name,
          COUNT(*) AS total_invoices,
          COUNT(*) FILTER (WHERE i.status = 'paid') AS paid_count,
          COUNT(*) FILTER (WHERE i.status NOT IN ('paid','draft') AND i.due_date < CURRENT_DATE) AS overdue_count,
          COALESCE(SUM(COALESCE(i.total_inc_gst, i.amount)), 0) AS total_billed,
          COALESCE(SUM(CASE WHEN i.status = 'paid' THEN COALESCE(i.total_inc_gst, i.amount) END), 0) AS total_collected
        FROM invoices i
        JOIN users u ON u.id = i.operator_id
        GROUP BY u.id, u.name, u.email
        ORDER BY total_billed DESC
      `),

      // Per-operator roster/staff/payroll summary
      pool.query(`
        SELECT
          u.id AS operator_id,
          COALESCE(u.name, u.email) AS operator_name,
          (SELECT COUNT(*) FROM staff_members s WHERE s.operator_id = u.id AND s.is_active = true) AS staff_count,
          COALESCE(SUM(
            CASE
              WHEN r.start_time IS NOT NULL AND r.end_time IS NOT NULL AND r.end_time > r.start_time
              THEN EXTRACT(EPOCH FROM (r.end_time - r.start_time)) / 3600.0
              ELSE 0
            END
          ) FILTER (WHERE r.scheduled_date >= $1), 0) AS hours_this_week,
          COALESCE(SUM(pe.amount) FILTER (WHERE pe.period_start >= $2), 0) AS gross_this_month,
          COALESCE(SUM(pe.net_pay) FILTER (WHERE pe.period_start >= $2), 0) AS net_this_month
        FROM users u
        LEFT JOIN roster_entries r ON r.operator_id = u.id
        LEFT JOIN payroll_entries pe ON pe.operator_id = u.id
        WHERE EXISTS (SELECT 1 FROM staff_members sm WHERE sm.operator_id = u.id)
        GROUP BY u.id, u.name, u.email
        ORDER BY staff_count DESC
      `, [weekStart, monthStart]),

      // Overdue invoices detail (founder alarm list)
      pool.query(`
        SELECT
          i.id,
          i.invoice_number,
          COALESCE(u.name, u.email) AS operator_name,
          i.customer_name,
          COALESCE(i.total_inc_gst, i.amount) AS amount,
          i.due_date,
          (CURRENT_DATE - i.due_date) AS days_overdue,
          i.status
        FROM invoices i
        JOIN users u ON u.id = i.operator_id
        WHERE i.status NOT IN ('paid', 'draft')
          AND i.due_date < CURRENT_DATE
        ORDER BY days_overdue DESC
        LIMIT 50
      `),
    ]);

    const agg = invoiceSummary.rows[0] || {};

    res.json({
      success: true,
      summary: {
        total_invoices: parseInt(agg.total_invoices || 0, 10),
        invoices_this_month: parseInt(agg.invoices_this_month || 0, 10),
        total_collected: parseFloat(agg.total_collected || 0),
        overdue_count: parseInt(agg.overdue_count || 0, 10),
        overdue_amount: parseFloat(agg.overdue_amount || 0),
        total_staff: rosterByOperator.rows.reduce((s, r) => s + parseInt(r.staff_count || 0, 10), 0),
        gross_this_month: rosterByOperator.rows.reduce((s, r) => s + parseFloat(r.gross_this_month || 0), 0),
      },
      invoice_by_operator: invoiceByOperator.rows,
      roster_by_operator: rosterByOperator.rows,
      overdue_invoices: overdueInvoices.rows,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Founder] Payroll summary error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Per-operator invoice drill-down
router.get('/payroll-summary/operator/:id', async (req, res) => {
  const pool = getPool();
  const opId = parseInt(req.params.id, 10);
  if (!opId) return res.status(400).json({ success: false, message: 'Invalid operator id' });

  try {
    const [invoices, roster, staff] = await Promise.all([
      pool.query(`
        SELECT i.*, COALESCE(i.total_inc_gst, i.amount) AS display_amount
        FROM invoices i
        WHERE i.operator_id = $1
        ORDER BY i.created_at DESC
        LIMIT 100
      `, [opId]),

      pool.query(`
        SELECT r.*, s.name AS staff_name
        FROM roster_entries r
        JOIN staff_members s ON s.id = r.staff_id
        WHERE r.operator_id = $1
          AND r.scheduled_date >= CURRENT_DATE - INTERVAL '14 days'
        ORDER BY r.scheduled_date DESC, r.start_time
        LIMIT 50
      `, [opId]),

      pool.query(`
        SELECT id, name, role, hourly_rate, is_active, tfn_status
        FROM staff_members
        WHERE operator_id = $1
        ORDER BY is_active DESC, name
      `, [opId]),
    ]);

    res.json({
      success: true,
      operator_id: opId,
      invoices: invoices.rows,
      roster: roster.rows,
      staff: staff.rows,
    });
  } catch (err) {
    console.error('[Founder] Operator payroll detail error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Cancel operator subscription ────────────────────────────────────────────
// POST /api/founder/operators/:id/cancel
// Cancels the Stripe subscription immediately (if one exists) and marks the
// operator as cancelled in the local DB. Founder-only. Irreversible via this
// endpoint — Stripe can create a new subscription if needed.
router.post('/operators/:id/cancel', async (req, res) => {
  const pool = getPool();
  const userId = parseInt(req.params.id, 10);
  if (!userId) return res.status(400).json({ success: false, message: 'Invalid operator id' });

  try {
    // Fetch user — need stripe_customer_id and current status
    const r = await pool.query(
      'SELECT id, email, subscription_status, stripe_customer_id FROM users WHERE id = $1',
      [userId]
    );
    const user = r.rows[0];
    if (!user) return res.status(404).json({ success: false, message: 'Operator not found' });

    // Only cancel TRIAL or ACTIVE — guard against double-cancel
    const cancellable = ['trial', 'active', 'paid', 'past_due'];
    if (!cancellable.includes(user.subscription_status)) {
      return res.json({ success: true, message: 'Already cancelled', already_done: true });
    }

    // Cancel Stripe subscription if we have a customer ID
    let stripeNote = 'no_stripe_customer';
    if (user.stripe_customer_id && process.env.STRIPE_SECRET_KEY) {
      try {
        const Stripe = require('stripe');
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

        // List active subscriptions for this customer
        const subs = await stripe.subscriptions.list({
          customer: user.stripe_customer_id,
          status: 'all',
          limit: 5,
        });

        const activeSubs = subs.data.filter(s =>
          ['active', 'trialing', 'past_due'].includes(s.status)
        );

        if (activeSubs.length > 0) {
          // Cancel all active/trialing subscriptions immediately
          for (const sub of activeSubs) {
            await stripe.subscriptions.cancel(sub.id);
            console.log(`[Founder] ✅ Stripe sub ${sub.id} cancelled for user ${userId} (${user.email})`);
          }
          stripeNote = `cancelled_${activeSubs.length}_subscription(s)`;
        } else {
          stripeNote = 'no_active_stripe_subscriptions';
        }
      } catch (stripeErr) {
        // Log but don't fail — still mark DB cancelled
        console.error(`[Founder] Stripe cancel error for user ${userId}:`, stripeErr.message);
        stripeNote = `stripe_error: ${stripeErr.message}`;
      }
    }

    // Always update local DB status to cancelled
    await pool.query(
      `UPDATE users SET subscription_status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [userId]
    );

    console.log(`[Founder] ✅ Cancelled user ${userId} (${user.email}) — stripe: ${stripeNote}`);

    return res.json({
      success: true,
      message: `Cancelled. Stripe: ${stripeNote}`,
      operator_id: userId,
      email: user.email,
    });
  } catch (err) {
    console.error('[Founder] Cancel error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Stripe Sync — pull real subscription data from Stripe into DB ───────────
// POST /api/founder/stripe-sync
// Queries Stripe API for all customers with active/trialing subscriptions,
// then upserts users table to match. Fixes data drift from missed webhooks.
router.post('/stripe-sync', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ success: false, message: 'STRIPE_SECRET_KEY not configured' });
  }

  const pool = getPool();
  const Stripe = require('stripe');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    // Fetch all subscriptions (active + trialing + past_due)
    const results = { synced: [], created: [], errors: [] };
    let hasMore = true;
    let startingAfter = undefined;

    while (hasMore) {
      const params = { limit: 100, status: 'all', expand: ['data.customer'] };
      if (startingAfter) params.starting_after = startingAfter;
      const subs = await stripe.subscriptions.list(params);

      for (const sub of subs.data) {
        const customer = typeof sub.customer === 'string'
          ? await stripe.customers.retrieve(sub.customer)
          : sub.customer;

        const email = customer.email;
        if (!email) continue;

        const stripeStatus = sub.status; // active, trialing, canceled, past_due, etc.
        const dbStatus = stripeStatus === 'active' ? 'active'
          : stripeStatus === 'trialing' ? 'trial'
          : stripeStatus === 'canceled' ? 'cancelled'
          : stripeStatus === 'past_due' ? 'past_due'
          : stripeStatus;

        // Skip fully canceled — don't overwrite local data
        if (dbStatus === 'cancelled') continue;

        try {
          // Try update existing user
          const existing = await pool.query(
            `UPDATE users SET subscription_status = $1, stripe_customer_id = $2, updated_at = NOW()
             WHERE LOWER(email) = $3
             RETURNING id, email, subscription_status`,
            [dbStatus, customer.id, email.toLowerCase()]
          );

          if (existing.rowCount > 0) {
            results.synced.push({ email, status: dbStatus, action: 'updated' });
          } else {
            // Create new user from Stripe data
            const name = customer.name || null;
            await pool.query(
              `INSERT INTO users (email, name, stripe_customer_id, subscription_status, business_type, created_at, updated_at)
               VALUES ($1, $2, $3, $4, 'real_estate', NOW(), NOW())
               ON CONFLICT DO NOTHING`,
              [email.toLowerCase(), name, customer.id, dbStatus]
            );
            results.created.push({ email, name, status: dbStatus });
          }
        } catch (err) {
          results.errors.push({ email, error: err.message });
        }
      }

      hasMore = subs.has_more;
      if (subs.data.length > 0) startingAfter = subs.data[subs.data.length - 1].id;
    }

    console.log(`[Founder] ✅ Stripe sync: ${results.synced.length} updated, ${results.created.length} created, ${results.errors.length} errors`);
    res.json({ success: true, ...results });
  } catch (err) {
    console.error('[Founder] Stripe sync error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

