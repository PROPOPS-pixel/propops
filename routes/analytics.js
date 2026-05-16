/**
 * Analytics routes — lightweight self-hosted event tracking.
 *
 * POST /api/analytics/event   — record a single event (legacy path)
 * POST /api/analytics/collect  — record a single event (ad-blocker resistant)
 * GET  /api/analytics/summary  — dashboard summary (admin-only)
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { Pool } = require('pg');

let _pool = null;
function getPool() {
    if (!_pool) {
        _pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
            max: 3,
        });
    }
    return _pool;
}

/**
 * Hash an IP address for privacy-preserving uniqueness.
 * One-way — cannot be reversed to the original IP.
 */
function hashIP(ip) {
    if (!ip) return null;
    return crypto.createHash('sha256').update(ip + (process.env.ANALYTICS_SALT || 'propops-salt')).digest('hex').slice(0, 32);
}

/**
 * Core event handler — shared by both /event and /collect endpoints
 */
async function handleEvent(req, res) {
    try {
        const body = req.body || {};
        const { event_type, session_id, metadata = {} } = body;

        // Validate event_type
        const ALLOWED_EVENTS = ['page_view', 'cta_click', 'form_submit', 'scroll_depth', 'video_play'];
        if (!event_type || !ALLOWED_EVENTS.includes(event_type)) {
            return res.status(400).json({ success: false, message: 'Invalid event_type' });
        }

        // Get real IP — respect Render's X-Forwarded-For
        const rawIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
        const ip_hash = hashIP(rawIP);

        // Respond immediately — never block the client on a DB write
        res.json({ success: true });

        // Fire-and-forget: write to DB asynchronously after response is sent
        const pool = getPool();
        pool.query(
            `INSERT INTO analytics_events (event_type, ip_hash, session_id, metadata)
             VALUES ($1, $2, $3, $4)`,
            [event_type, ip_hash, session_id || null, JSON.stringify(metadata)]
        ).catch(err => {
            console.error('[Analytics] Event insert error:', err.message);
        });
    } catch (err) {
        console.error('[Analytics] Event handler error:', err.message);
        if (!res.headersSent) res.json({ success: false });
    }
}

/**
 * POST /api/analytics/event — legacy endpoint (may be blocked by ad blockers)
 * POST /api/analytics/collect — ad-blocker resistant endpoint
 *
 * Body: { event_type, session_id, metadata }
 *
 * Supported event_type values:
 *   page_view      — landing page loaded
 *   cta_click      — "Start Free Trial" or "Subscribe" button clicked
 *   form_submit    — signup form submitted
 *   scroll_depth   — user scrolled to pricing section (scroll_pct %)
 *   video_play     — YouTube video play event
 */
router.post('/event', handleEvent);
router.post('/collect', handleEvent);

/**
 * GET /api/analytics/summary
 * Admin endpoint — returns aggregated metrics for the last N days.
 * Protected by ADMIN_TOKEN header.
 */
router.get('/summary', async (req, res) => {
    // Simple admin auth
    const token = req.headers['x-admin-token'] || req.query.token;
    const adminToken = process.env.ADMIN_TOKEN;
    if (adminToken && token !== adminToken) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const days = Math.min(parseInt(req.query.days || '30', 10), 365);

    try {
        const pool = getPool();

        // Run all queries in parallel
        const [
            pageViews,
            uniqueVisitors,
            ctaClicks,
            formSubmits,
            videoPlays,
            scrollReach,
            dailyBreakdown,
        ] = await Promise.all([
            // Total page views
            pool.query(
                `SELECT COUNT(*) as count FROM analytics_events
                 WHERE event_type = 'page_view'
                 AND created_at >= NOW() - INTERVAL '${days} days'`
            ),
            // Unique visitors (distinct ip_hash per day)
            pool.query(
                `SELECT COUNT(DISTINCT ip_hash) as count FROM analytics_events
                 WHERE event_type = 'page_view'
                 AND created_at >= NOW() - INTERVAL '${days} days'`
            ),
            // CTA clicks
            pool.query(
                `SELECT COUNT(*) as count FROM analytics_events
                 WHERE event_type = 'cta_click'
                 AND created_at >= NOW() - INTERVAL '${days} days'`
            ),
            // Form submissions (conversions)
            pool.query(
                `SELECT COUNT(*) as count FROM analytics_events
                 WHERE event_type = 'form_submit'
                 AND created_at >= NOW() - INTERVAL '${days} days'`
            ),
            // Video plays
            pool.query(
                `SELECT COUNT(*) as count FROM analytics_events
                 WHERE event_type = 'video_play'
                 AND created_at >= NOW() - INTERVAL '${days} days'`
            ),
            // Scroll-to-pricing reach
            pool.query(
                `SELECT COUNT(*) as count FROM analytics_events
                 WHERE event_type = 'scroll_depth'
                 AND created_at >= NOW() - INTERVAL '${days} days'`
            ),
            // Daily breakdown — page views + conversions per day
            pool.query(
                `SELECT
                   DATE(created_at AT TIME ZONE 'Australia/Sydney') as date,
                   SUM(CASE WHEN event_type = 'page_view' THEN 1 ELSE 0 END) as views,
                   COUNT(DISTINCT CASE WHEN event_type = 'page_view' THEN ip_hash END) as unique_visitors,
                   SUM(CASE WHEN event_type = 'cta_click' THEN 1 ELSE 0 END) as cta_clicks,
                   SUM(CASE WHEN event_type = 'form_submit' THEN 1 ELSE 0 END) as form_submits
                 FROM analytics_events
                 WHERE created_at >= NOW() - INTERVAL '${days} days'
                 GROUP BY DATE(created_at AT TIME ZONE 'Australia/Sydney')
                 ORDER BY date DESC
                 LIMIT 90`
            ),
        ]);

        const totalViews = parseInt(pageViews.rows[0].count, 10);
        const totalCtaClicks = parseInt(ctaClicks.rows[0].count, 10);
        const totalFormSubmits = parseInt(formSubmits.rows[0].count, 10);

        res.json({
            success: true,
            period_days: days,
            summary: {
                page_views: totalViews,
                unique_visitors: parseInt(uniqueVisitors.rows[0].count, 10),
                cta_clicks: totalCtaClicks,
                form_submits: totalFormSubmits,
                video_plays: parseInt(videoPlays.rows[0].count, 10),
                scroll_to_pricing: parseInt(scrollReach.rows[0].count, 10),
                // Conversion rates
                cta_click_rate: totalViews > 0 ? ((totalCtaClicks / totalViews) * 100).toFixed(1) + '%' : '0%',
                conversion_rate: totalViews > 0 ? ((totalFormSubmits / totalViews) * 100).toFixed(1) + '%' : '0%',
            },
            daily: dailyBreakdown.rows,
        });
    } catch (err) {
        console.error('[Analytics] Summary error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/analytics/page-track
 * Lightweight landing page visitor tracking for page_analytics table.
 * Called by the inline tracking script on propops.pro and propops.trade.
 * No auth required — public endpoint. No PII stored.
 *
 * Body: { domain, path, referrer, utm_source, utm_medium, utm_campaign,
 *         device_type, region, session_id, event_type }
 */
router.post('/page-track', async (req, res) => {
  // Respond immediately — never block the landing page load
  res.json({ ok: 1 });

  setImmediate(async () => {
    try {
      const {
        domain, path = '/', referrer, utm_source, utm_medium, utm_campaign,
        device_type, region, session_id, event_type,
      } = req.body || {};

      // Only accept known domains — drop everything else silently
      const ALLOWED_DOMAINS = ['propops.pro', 'propops.trade', 'propopspro.polsia.app'];
      if (!domain || !ALLOWED_DOMAINS.includes(domain)) return;

      // For funnel events, store them as a row with utm_campaign = 'funnel-<event>'
      const campaign = utm_campaign || (event_type && event_type !== 'pageview' ? `funnel-${event_type}` : null);

      const pool = getPool();
      await pool.query(`
        INSERT INTO page_analytics
          (domain, path, referrer, utm_source, utm_medium, utm_campaign,
           device_type, country, region, session_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'AU', $8, $9)
      `, [
        domain,
        path || '/',
        referrer || null,
        utm_source || null,
        utm_medium || null,
        campaign || null,
        device_type || null,
        region || null,
        session_id || null,
      ]);
    } catch (err) {
      console.error('[Analytics] page-track insert error:', err.message);
    }
  });
});

module.exports = router;
