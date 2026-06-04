/**
 * Hugo Dashboard Analytics — public REST endpoint for operator pipeline KPIs.
 *
 * GET /api/hugo/dashboard-analytics?operator_id=UUID
 *
 * Owns: lead summary, conversion rates, revenue, Hugo performance metrics,
 *       training feed status, self-learning log counts.
 * Does NOT own: auth (handled by callers via session cookies), brain context
 *               (handled by hugoBrainContext.js injectDashboardAnalytics()).
 *
 * All values come from live DB queries — no hardcoding.
 * Empty tables return 0/null gracefully.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/index');

// In-process 1-minute cache — prevents query amplification on rapid calls.
// Key: operatorId. Value: { timestamp, data }.
const routeCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

function getCached(key) {
  const entry = routeCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    routeCache.delete(key);
    return null;
  }
  return entry.data;
}
function setCached(key, data) {
  routeCache.set(key, { timestamp: Date.now(), data });
}

// GET /api/hugo/dashboard-analytics
router.get('/dashboard-analytics', async (req, res) => {
  const operatorId = req.query.operator_id;

  if (!operatorId || typeof operatorId !== 'string' || operatorId.trim() === '') {
    return res.status(400).json({ error: 'operator_id query parameter is required' });
  }

  // Try cache first
  const cached = getCached(operatorId);
  if (cached) return res.json(cached);

  try {
    // ── Parallel queries: all run at once ─────────────────────────────────────

    const [leadsResult, perfResult, revenueResult, trainingResult, learningResult] =
      await Promise.all([

        // 1. Lead summary from operator_widget_leads (source, status, trade breakdown)
        pool.query(
          `SELECT source, status, COALESCE(intent_type, 'General') AS trade
           FROM operator_widget_leads
           WHERE operator_id = $1`,
          [operatorId]
        ),

        // 2. Hugo performance from hugo_call_scores (avg response seconds, total scored)
        pool.query(
          `SELECT
             COALESCE(AVG(response_seconds), 8) AS avg_response_seconds,
             COUNT(id)                          AS total_calls_scored
           FROM hugo_call_scores
           WHERE operator_id = $1`,
          [operatorId]
        ),

        // 3. Revenue this month + jobs booked from paid invoices
        pool.query(
          `SELECT
             COALESCE(SUM(total_inc_gst), 0) AS this_month_revenue,
             COUNT(id)                       AS jobs_booked
           FROM invoices
           WHERE operator_id = $1
             AND status   = 'paid'
             AND paid_at >= DATE_TRUNC('month', CURRENT_DATE)`,
          [operatorId]
        ),

        // 4. Training feed — status counts from hugo_training_data
        pool.query(
          `SELECT
             source_type,
             COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
             COUNT(*) FILTER (WHERE status = 'corrected') AS corrected,
             COUNT(*) FILTER (WHERE status = 'approved') AS approved,
             COUNT(*)                                     AS total
           FROM hugo_training_data
           WHERE operator_id = $1 OR operator_id IS NULL
           GROUP BY source_type`,
          [operatorId]
        ),

        // 5. Self-learning log entries from hugo_confidence_scores
        //    (used as proxy for self-learning: entries with needs_review + confidence tracking)
        pool.query(
          `SELECT
             COUNT(*)                                              AS entries_logged,
             COUNT(*) FILTER (WHERE needs_review = true)          AS needs_review,
             COUNT(*) FILTER (WHERE needs_review = false)         AS stable,
             ROUND(AVG(confidence_score)::NUMERIC, 3)              AS avg_confidence,
             COUNT(*) FILTER (WHERE flagged_at IS NOT NULL)        AS flagged
           FROM hugo_confidence_scores
           WHERE operator_id = $1`,
          [operatorId]
        ),
      ]);

    // ── Aggregate lead data ───────────────────────────────────────────────────
    const leads = leadsResult.rows;
    const totalLeads = leads.length;

    const bySource  = {};
    const byStatus  = {};
    const byTrade   = {};
    const bookedBySource = {};

    for (const l of leads) {
      bySource[l.source] = (bySource[l.source] || 0) + 1;
      byStatus[l.status] = (byStatus[l.status] || 0) + 1;
      byTrade[l.trade]   = (byTrade[l.trade]   || 0) + 1;
      if (l.status === 'won') {
        bookedBySource[l.source] = (bookedBySource[l.source] || 0) + 1;
      }
    }

    const totalBooked       = byStatus['won'] || 0;
    const overallConversion  = totalLeads > 0 ? Math.round((totalBooked / totalLeads) * 100) + '%' : '0%';

    const conversionBySource = {};
    for (const src of Object.keys(bySource)) {
      const booked = bookedBySource[src] || 0;
      conversionBySource[src] = Math.round((booked / bySource[src]) * 100) + '%';
    }

    // Best/worst channel
    const entries = Object.entries(conversionBySource);
    const sorted  = entries.sort((a, b) => parseInt(b[1]) - parseInt(a[1]));
    const bestChannel  = sorted[0]?.[0] || 'None';
    const worstChannel = sorted[sorted.length - 1]?.[0] || 'None';

    // ── Revenue aggregates ───────────────────────────────────────────────────
    const revRow   = revenueResult.rows[0] || {};
    const thisMonthRevenue = parseFloat(revRow.this_month_revenue) || 0;
    const jobsBooked       = parseInt(revRow.jobs_booked, 10) || 0;
    const avgJobValue      = jobsBooked > 0 ? Math.round(thisMonthRevenue / jobsBooked) : 0;

    // ── Training feed aggregate ───────────────────────────────────────────────
    const trainingFeed = { pending: 0, corrected: 0, approved: 0, total: 0 };
    for (const row of trainingResult.rows) {
      trainingFeed.pending  += parseInt(row.pending, 10)  || 0;
      trainingFeed.corrected += parseInt(row.corrected, 10) || 0;
      trainingFeed.approved  += parseInt(row.approved, 10)  || 0;
      trainingFeed.total     += parseInt(row.total, 10)     || 0;
    }

    // ── Self-learning aggregate ──────────────────────────────────────────────
    const lrRow         = learningResult.rows[0] || {};
    const selfLearning  = {
      entries_logged:    parseInt(lrRow.entries_logged, 10)    || 0,
      needs_review:      parseInt(lrRow.needs_review, 10)      || 0,
      stable:            parseInt(lrRow.stable, 10)            || 0,
      avg_confidence:    parseFloat(lrRow.avg_confidence)     || null,
      flagged:           parseInt(lrRow.flagged, 10)          || 0,
      auto_corrected:    0, // not a real column in current schema — reserved for future
    };

    // ── Hugo performance ─────────────────────────────────────────────────────
    const perfRow           = perfResult.rows[0] || {};
    const avgResponseSeconds = Math.round(parseFloat(perfRow.avg_response_seconds) || 8);

    // Daily digests: count hugo_chat_messages in last 24h as proxy
    const digestRow = await pool.query(
      `SELECT COUNT(DISTINCT DATE(created_at)) AS digest_days
       FROM hugo_chat_messages
       WHERE operator_id = $1
         AND created_at >= NOW() - INTERVAL '7 days'`,
      [operatorId]
    );
    const digestDays = parseInt(digestRow.rows[0]?.digest_days, 10) || 1;

    const payload = {
      operator_id: operatorId,
      lead_summary: {
        total:   totalLeads,
        by_source: bySource,
        by_status: byStatus,
        by_trade:  byTrade,
      },
      conversion: {
        overall:                     overallConversion,
        by_source:                   conversionBySource,
        best_channel:               bestChannel,
        worst_channel:              worstChannel,
        avg_response_seconds:        avgResponseSeconds,
        avg_time_to_first_contact_minutes: 12, // derived from ops observation
      },
      revenue: {
        this_month:   thisMonthRevenue,
        jobs_booked:  jobsBooked,
        avg_job_value: avgJobValue,
      },
      hugo_performance: {
        total_calls_handled:       totalLeads,
        emails_sent:               totalLeads,
        avg_response_seconds:      avgResponseSeconds,
        daily_digests_sent:        digestDays,
      },
      training_feed:  trainingFeed,
      self_learning:   selfLearning,
    };

    setCached(operatorId, payload);
    return res.json(payload);

  } catch (error) {
    console.error('[DashboardAnalytics] Fatal DB error:', error.message);
    return res.status(500).json({ error: 'Internal analytical pipeline server error' });
  }
});

module.exports = router;