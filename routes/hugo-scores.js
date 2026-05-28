/**
 * Hugo Scores routes — operator-facing quality dashboard endpoints.
 *
 * Owns: read access to hugo_call_scores for authenticated operators
 *       + founder-level system stats endpoint.
 * Does NOT own: score writes (services/hugo-scorer.js), DB schema (db/hugo-call-scores.js),
 *               brain logic (routes/hugo-brain.js).
 *
 * GET /api/hugo/scores/summary   — rolling averages for the authenticated operator
 * GET /api/hugo/scores/recent    — recent scored turns (paginated)
 * GET /api/hugo/scores/flags     — flagged turns for review
 * GET /api/hugo/scores/system    — founder-only: system-wide stats
 */

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('./auth');
const { pool } = require('../db/index');
const {
  getScoresByOperator,
  getAveragesByOperator,
  getRecentFlags,
  getSystemStats,
} = require('../db/hugo-call-scores');

// ─── GET /api/hugo/scores/summary ─────────────────────────────────────────────
// Rolling dimension averages for the current operator (last 30 days by default).
router.get('/scores/summary', requireAuth, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
    const averages = await getAveragesByOperator(req.userId, days);
    res.json({ success: true, days, averages });
  } catch (err) {
    console.error('[Hugo Scores] summary error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load score summary' });
  }
});

// ─── GET /api/hugo/scores/recent ──────────────────────────────────────────────
// Paginated list of recent scored turns for the current operator.
router.get('/scores/recent', requireAuth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 20, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const scores = await getScoresByOperator(req.userId, { limit, offset });
    res.json({ success: true, scores, limit, offset });
  } catch (err) {
    console.error('[Hugo Scores] recent error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load recent scores' });
  }
});

// ─── GET /api/hugo/scores/flags ───────────────────────────────────────────────
// Flagged conversation turns that need review.
router.get('/scores/flags', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const flags = await getRecentFlags(req.userId, limit);
    res.json({ success: true, flags });
  } catch (err) {
    console.error('[Hugo Scores] flags error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load flagged turns' });
  }
});

// ─── GET /api/hugo/scores/system ──────────────────────────────────────────────
// Founder-only: system-wide aggregate stats.
router.get('/scores/system', requireAuth, async (req, res) => {
  try {
    const userRow = await pool.query(
      `SELECT is_admin FROM users WHERE id = $1 LIMIT 1`,
      [req.userId]
    );
    if (!userRow.rows[0]?.is_admin) {
      return res.status(403).json({ success: false, message: 'Founder access required' });
    }
    const days = Math.min(parseInt(req.query.days, 10) || 7, 90);
    const stats = await getSystemStats(days);
    res.json({ success: true, days, stats });
  } catch (err) {
    console.error('[Hugo Scores] system error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load system stats' });
  }
});

module.exports = router;
