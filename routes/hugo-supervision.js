/**
 * Hugo Supervision Routes — event-driven AI supervision loop API.
 *
 * Owns: supervision trigger endpoints, transcript aggregation, performance stats,
 *       training version CRUD with rollback, anomaly review.
 * Does NOT own: Hugo brain (routes/hugo-brain.js), scoring (routes/hugo-scores.js),
 *               founder god-layer config (routes/founder.js), billing.
 *
 * Auth model:
 *   - /api/supervision/*     → requires valid operator session OR admin token
 *   - /api/hugo/transcripts  → requires operator session (operator-scoped data)
 *   - /api/hugo/performance  → requires operator session (operator-scoped data)
 *   - /api/hugo/training/*   → requires operator session; destructive ops require founder token
 *
 * Kill switch: if hugo_founder_config has key 'supervision_enabled' = 'false',
 *   all supervision trigger endpoints return 200 with { enabled: false }.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const {
  runNightlyBatch,
  getPendingAnomalies,
  ANOMALY_THRESHOLD,
} = require('../services/hugo-supervision');

const {
  getSupervisionLogs,
  getLatestSupervisionLog,
  getAnomaliesToReview,
  markReviewed,
  createTrainingVersion,
  getTrainingVersions,
  getTrainingVersion,
  applyTrainingVersion,
  rollbackTrainingVersion,
  approveTrainingVersion,
  getCurrentVersionNumber,
} = require('../db/hugo-supervision');

const { getConfigValue, getAllConfig, upsertConfig } = require('../services/founder-config');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── Auth helpers ────────────────────────────────────────────────────────────────

async function requireOperator(req, res, next) {
  try {
    const sessionToken = req.headers['x-session-token'] || req.cookies?.propops_session || req.cookies?.relio_session;
    if (!sessionToken) return res.status(401).json({ success: false, message: 'Authentication required' });

    const authSvc = require('../services/auth');
    const payload = authSvc.verifySessionToken(sessionToken);
    if (!payload?.sub) return res.status(401).json({ success: false, message: 'Invalid session' });

    const userRow = await pool.query('SELECT id, is_admin FROM users WHERE id = $1', [payload.sub]);
    if (!userRow.rows[0]) return res.status(401).json({ success: false, message: 'User not found' });

    req.userId = payload.sub;
    req.isAdmin = !!userRow.rows[0].is_admin;

    // Get operator profile
    const profileRow = await pool.query('SELECT id FROM operator_profiles WHERE user_id = $1 LIMIT 1', [payload.sub]);
    req.operatorId = profileRow.rows[0]?.id || null;
    next();
  } catch (err) {
    res.status(401).json({ success: false, message: 'Auth error' });
  }
}

function requireAdminOrFounder(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;
  const provided = req.headers['x-admin-token'];
  if (adminToken && provided === adminToken) return next();
  if (req.isAdmin) return next();
  return res.status(403).json({ success: false, message: 'Founder access required' });
}

// ─── Kill switch check ────────────────────────────────────────────────────────────
async function isSupervisionEnabled() {
  try {
    const val = await getConfigValue('supervision_enabled');
    return val !== 'false'; // enabled by default
  } catch {
    return true;
  }
}

// ─── /api/hugo/transcripts ────────────────────────────────────────────────────────
// Returns recent conversation transcripts across all channels for this operator.
router.get('/transcripts', requireOperator, async (req, res) => {
  const { limit = 30, days = 7 } = req.query;
  const since = new Date(Date.now() - parseInt(days, 10) * 86400 * 1000);
  const opId = req.operatorId;

  const transcripts = [];

  try {
    // Widget sessions
    const widgetRes = await pool.query(
      `SELECT id, messages, metadata, created_at
       FROM hugo_widget_sessions
       WHERE (metadata->>'operator_id')::int = $1
          OR $1 IS NULL
       AND created_at >= $2
       ORDER BY created_at DESC LIMIT $3`,
      [opId, since, Math.min(parseInt(limit, 10), 50)]
    );

    for (const row of widgetRes.rows) {
      const msgs = row.messages || [];
      if (msgs.length < 2) continue;
      transcripts.push({
        id: `widget_${row.id}`,
        channel: 'widget',
        source: (row.metadata?.domain || '').includes('propops.trade') ? 'web_trade' : 'web_pro',
        messages: msgs.map(m => ({
          role: m.role || (m.sender === 'user' ? 'user' : 'assistant'),
          content: m.content || m.message || '',
        })).slice(0, 20),
        created_at: row.created_at,
      });
    }

    // Dashboard chats
    const chatRes = await pool.query(
      `SELECT role, content, created_at
       FROM hugo_chat_messages
       WHERE operator_id = $1 AND created_at >= $2
       ORDER BY created_at DESC LIMIT 40`,
      [opId, since]
    );

    if (chatRes.rows.length >= 2) {
      transcripts.push({
        id: `dashboard_${opId}`,
        channel: 'dashboard',
        source: 'dashboard',
        messages: chatRes.rows.reverse().map(r => ({ role: r.role, content: r.content })).slice(0, 20),
        created_at: chatRes.rows[0]?.created_at,
      });
    }

    res.json({ success: true, transcripts: transcripts.slice(0, parseInt(limit, 10)), days: parseInt(days, 10) });
  } catch (err) {
    console.error('[Supervision] /transcripts error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch transcripts' });
  }
});

// ─── /api/hugo/performance ────────────────────────────────────────────────────────
// Aggregated performance stats: lead capture rate, avg confidence, drop-offs.
router.get('/performance', requireOperator, async (req, res) => {
  const { days = 30 } = req.query;
  const since = new Date(Date.now() - parseInt(days, 10) * 86400 * 1000);
  const opId = req.operatorId;

  try {
    // Confidence stats from hugo_confidence_scores
    const confRes = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         ROUND(AVG(confidence)::numeric, 3) AS avg_confidence,
         COUNT(*) FILTER (WHERE confidence < $3)::int AS flagged_count,
         COUNT(*) FILTER (WHERE confidence >= 0.7)::int AS high_quality_count
       FROM hugo_confidence_scores
       WHERE (operator_id = $1 OR $1 IS NULL) AND created_at >= $2`,
      [opId, since, ANOMALY_THRESHOLD]
    );

    // Lead capture rate from operator_widget_leads
    const leadRes = await pool.query(
      `SELECT
         COUNT(*)::int AS total_leads,
         COUNT(*) FILTER (WHERE status != 'dropped' AND email IS NOT NULL)::int AS captured_leads,
         ROUND(AVG(COALESCE(intent_score, 5))::numeric, 1) AS avg_intent
       FROM operator_widget_leads
       WHERE operator_id = $1 AND created_at >= $2`,
      [opId, since]
    );

    // Hugo quality scores
    const qualRes = await pool.query(
      `SELECT
         COUNT(*)::int AS scored_turns,
         ROUND(AVG(score_overall)::numeric, 2) AS avg_overall,
         ROUND(AVG(score_lead_capture)::numeric, 2) AS avg_lead_capture,
         ROUND(AVG(score_helpfulness)::numeric, 2) AS avg_helpfulness,
         COUNT(*) FILTER (WHERE jsonb_array_length(flags) > 0)::int AS flagged_turns
       FROM hugo_call_scores
       WHERE operator_id = $1 AND created_at >= $2`,
      [opId, since]
    );

    const conf = confRes.rows[0] || {};
    const leads = leadRes.rows[0] || {};
    const qual = qualRes.rows[0] || {};

    const captureRate = leads.total_leads > 0
      ? Math.round((leads.captured_leads / leads.total_leads) * 100)
      : null;

    res.json({
      success: true,
      days: parseInt(days, 10),
      confidence: {
        avg: conf.avg_confidence || null,
        total_conversations: conf.total || 0,
        flagged: conf.flagged_count || 0,
        high_quality: conf.high_quality_count || 0,
      },
      lead_capture: {
        total: leads.total_leads || 0,
        captured: leads.captured_leads || 0,
        rate_pct: captureRate,
        avg_intent: leads.avg_intent || null,
      },
      quality: {
        scored_turns: qual.scored_turns || 0,
        avg_overall: qual.avg_overall || null,
        avg_lead_capture: qual.avg_lead_capture || null,
        avg_helpfulness: qual.avg_helpfulness || null,
        flagged_turns: qual.flagged_turns || 0,
      },
    });
  } catch (err) {
    console.error('[Supervision] /performance error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch performance stats' });
  }
});

// ─── /api/hugo/training ──────────────────────────────────────────────────────────
// GET: read current prompt for a key (e.g. system_prompt.trade)
// PUT: create a new versioned prompt change (pending founder approval)
router.get('/training', requireOperator, async (req, res) => {
  const { prompt_key = 'system_prompt.trade' } = req.query;
  try {
    const configRows = await getAllConfig();
    const row = configRows.find(r => r.config_key === prompt_key);
    const currentVersionNum = await getCurrentVersionNumber(prompt_key);
    const versions = await getTrainingVersions(prompt_key, { limit: 10 });

    res.json({
      success: true,
      prompt_key,
      current_value: row?.config_value || null,
      current_version: currentVersionNum,
      version_history: versions,
    });
  } catch (err) {
    console.error('[Supervision] GET /training error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to read training data' });
  }
});

router.put('/training', requireOperator, async (req, res) => {
  const { prompt_key, prompt_after, change_reason } = req.body || {};
  if (!prompt_key || !prompt_after || !change_reason) {
    return res.status(400).json({ success: false, message: 'prompt_key, prompt_after, and change_reason are required' });
  }
  if (prompt_after.length > 20000) {
    return res.status(400).json({ success: false, message: 'Prompt too long (max 20,000 chars)' });
  }

  try {
    const configRows = await getAllConfig();
    const currentRow = configRows.find(r => r.config_key === prompt_key);
    const promptBefore = currentRow?.config_value || '';

    // Create versioned record — NOT applied yet (pending founder approval)
    const { id, version_number } = await createTrainingVersion({
      prompt_key,
      prompt_before: promptBefore,
      prompt_after,
      change_reason,
      change_source: 'manual',
    });

    res.json({
      success: true,
      message: 'Training version created — pending founder approval before applying',
      version_id: id,
      version_number,
      prompt_key,
    });
  } catch (err) {
    console.error('[Supervision] PUT /training error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create training version' });
  }
});

// GET version history for a prompt
router.get('/training/versions', requireOperator, async (req, res) => {
  const { prompt_key = 'system_prompt.trade', limit = 20 } = req.query;
  try {
    const versions = await getTrainingVersions(prompt_key, { limit: parseInt(limit, 10) });
    res.json({ success: true, prompt_key, versions });
  } catch (err) {
    console.error('[Supervision] GET /training/versions error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch versions' });
  }
});

// POST approve or reject a training version (founder only)
router.post('/training/approve/:id', requireOperator, requireAdminOrFounder, async (req, res) => {
  const versionId = parseInt(req.params.id, 10);
  const { approved, apply_immediately = false } = req.body || {};

  if (typeof approved !== 'boolean') {
    return res.status(400).json({ success: false, message: 'approved (boolean) is required' });
  }

  try {
    const version = await getTrainingVersion(versionId);
    if (!version) return res.status(404).json({ success: false, message: 'Version not found' });
    if (version.rolled_back) return res.status(400).json({ success: false, message: 'Cannot approve a rolled-back version' });

    await approveTrainingVersion(versionId, approved);

    // If approved and apply_immediately, write to hugo_founder_config
    if (approved && apply_immediately) {
      await upsertConfig({
        config_key: version.prompt_key,
        config_value: version.prompt_after,
        description: `Applied from training version ${versionId}: ${version.change_reason}`,
        is_locked: false,
      });
      await applyTrainingVersion(versionId);
    }

    res.json({
      success: true,
      approved,
      version_id: versionId,
      applied: approved && apply_immediately,
      message: approved
        ? (apply_immediately ? 'Approved and applied to Hugo.' : 'Approved — use /training/apply/:id to deploy.')
        : 'Rejected.',
    });
  } catch (err) {
    console.error('[Supervision] POST /training/approve error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to approve version' });
  }
});

// POST apply an approved training version
router.post('/training/apply/:id', requireOperator, requireAdminOrFounder, async (req, res) => {
  const versionId = parseInt(req.params.id, 10);

  try {
    const version = await getTrainingVersion(versionId);
    if (!version) return res.status(404).json({ success: false, message: 'Version not found' });
    if (!version.founder_approved) return res.status(400).json({ success: false, message: 'Version not approved by founder yet' });
    if (version.rolled_back) return res.status(400).json({ success: false, message: 'Cannot apply a rolled-back version' });

    await upsertConfig({
      config_key: version.prompt_key,
      config_value: version.prompt_after,
      description: `Applied from training v${version.version_number}: ${version.change_reason}`,
      is_locked: false,
    });
    await applyTrainingVersion(versionId);

    res.json({ success: true, message: 'Prompt updated. Hugo will use new version within 60 seconds.', version_id: versionId });
  } catch (err) {
    console.error('[Supervision] POST /training/apply error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to apply training version' });
  }
});

// POST rollback — instant rollback to a previous version
router.post('/training/rollback/:version_id', requireOperator, requireAdminOrFounder, async (req, res) => {
  const versionId = parseInt(req.params.version_id, 10);
  const { reason = 'manual rollback' } = req.body || {};

  try {
    const version = await getTrainingVersion(versionId);
    if (!version) return res.status(404).json({ success: false, message: 'Version not found' });

    // Roll back: restore prompt_before as the active value
    await upsertConfig({
      config_key: version.prompt_key,
      config_value: version.prompt_before,
      description: `Rolled back from v${version.version_number}: ${reason}`,
      is_locked: false,
    });
    await rollbackTrainingVersion(versionId, reason);

    res.json({
      success: true,
      message: `Rolled back to pre-v${version.version_number} prompt. Hugo updated within 60 seconds.`,
      version_id: versionId,
      prompt_key: version.prompt_key,
    });
  } catch (err) {
    console.error('[Supervision] POST /training/rollback error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to rollback' });
  }
});

// ─── /api/supervision/nightly ────────────────────────────────────────────────────
// Triggers the nightly batch review. Called by cron or founder manually.
router.post('/nightly', requireOperator, requireAdminOrFounder, async (req, res) => {
  const enabled = await isSupervisionEnabled();
  if (!enabled) {
    return res.json({ success: true, enabled: false, message: 'Supervision is disabled (kill switch active)' });
  }

  const { dry_run = false } = req.body || {};

  // Respond immediately, run async
  res.json({ success: true, message: 'Nightly supervision batch started.', dry_run: !!dry_run });

  runNightlyBatch({ dryRun: !!dry_run })
    .then(result => {
      console.log(`[Supervision] Nightly batch complete: ${result.conversations_reviewed} reviewed, ${result.conversations_flagged} flagged`);
    })
    .catch(err => {
      console.error('[Supervision] Nightly batch async error:', err.message);
    });
});

// GET latest nightly report
router.get('/nightly/latest', requireOperator, async (req, res) => {
  try {
    const log = await getLatestSupervisionLog(null);
    if (!log) return res.json({ success: true, report: null, message: 'No supervision runs yet' });
    res.json({ success: true, report: log });
  } catch (err) {
    console.error('[Supervision] GET /nightly/latest error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch report' });
  }
});

// GET supervision run history
router.get('/logs', requireOperator, async (req, res) => {
  const { limit = 20 } = req.query;
  try {
    const logs = await getSupervisionLogs({ limit: parseInt(limit, 10) });
    res.json({ success: true, logs });
  } catch (err) {
    console.error('[Supervision] GET /logs error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch logs' });
  }
});

// ─── /api/supervision/anomalies ──────────────────────────────────────────────────
// Returns conversations flagged for immediate review (confidence < threshold).
router.get('/anomalies', requireOperator, async (req, res) => {
  try {
    const anomalies = await getAnomaliesToReview(50);
    res.json({ success: true, anomalies, threshold: ANOMALY_THRESHOLD });
  } catch (err) {
    console.error('[Supervision] GET /anomalies error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch anomalies' });
  }
});

// POST mark anomaly as reviewed
router.post('/anomalies/:id/reviewed', requireOperator, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await markReviewed(id);
    res.json({ success: true, message: 'Marked as reviewed' });
  } catch (err) {
    console.error('[Supervision] POST /anomalies/:id/reviewed error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to mark reviewed' });
  }
});

// ─── Kill switch ─────────────────────────────────────────────────────────────────
// POST enable/disable the supervision loop. Founder only.
router.post('/kill-switch', requireOperator, requireAdminOrFounder, async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ success: false, message: 'enabled (boolean) is required' });
  }

  try {
    await upsertConfig({
      config_key: 'supervision_enabled',
      config_value: enabled ? 'true' : 'false',
      description: 'Hugo supervision loop kill switch. Set to false to disable all automatic supervision.',
      is_locked: false,
    });
    res.json({ success: true, supervision_enabled: enabled, message: enabled ? 'Supervision enabled.' : 'Supervision disabled (kill switch active).' });
  } catch (err) {
    console.error('[Supervision] POST /kill-switch error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update kill switch' });
  }
});

// GET current supervision status
router.get('/status', requireOperator, async (req, res) => {
  try {
    const enabled = await isSupervisionEnabled();
    const latestLog = await getLatestSupervisionLog(null);
    const pendingAnomalies = await getAnomaliesToReview(1);

    res.json({
      success: true,
      supervision_enabled: enabled,
      anomaly_threshold: ANOMALY_THRESHOLD,
      last_run: latestLog ? {
        run_date: latestLog.run_date,
        conversations_reviewed: latestLog.conversations_reviewed,
        conversations_flagged: latestLog.conversations_flagged,
        avg_confidence: latestLog.avg_confidence,
        status: latestLog.status,
        created_at: latestLog.created_at,
      } : null,
      pending_anomalies: pendingAnomalies.length,
    });
  } catch (err) {
    console.error('[Supervision] GET /status error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch status' });
  }
});

module.exports = router;
