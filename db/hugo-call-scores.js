/**
 * DB module — hugo_call_scores
 *
 * Owns: all reads and writes for the hugo_call_scores table.
 * Does NOT own: scoring logic (services/hugo-scorer.js), route auth.
 *
 * Public API:
 *   insertScore(row)                          → inserts one score row, returns inserted id
 *   getScoresByOperator(operatorId, opts)     → paginated scores for one operator
 *   getAveragesByOperator(operatorId, days)   → rolling average per dimension
 *   getRecentFlags(operatorId, limit)         → flagged turns for review
 *   getSystemStats(days)                      → founder-level aggregate across all operators
 */

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Auto-create table if migration hasn't run yet — belt-and-suspenders for cold starts.
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hugo_call_scores (
      id                   SERIAL PRIMARY KEY,
      operator_id          INTEGER,
      session_id           VARCHAR(64),
      channel              VARCHAR(20) NOT NULL DEFAULT 'widget',
      message_snippet      TEXT,
      reply_snippet        TEXT,
      score_helpfulness    SMALLINT,
      score_on_brand       SMALLINT,
      score_lead_capture   SMALLINT,
      score_action_quality SMALLINT,
      score_brevity        SMALLINT,
      score_overall        NUMERIC(3,1),
      scorer_model         VARCHAR(80),
      flags                JSONB NOT NULL DEFAULT '[]',
      raw_scoring_json     JSONB,
      created_at           TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}
ensureTable().catch(e => console.error('[hugo-call-scores] ensureTable error:', e.message));

/**
 * Insert a single score row.
 * @param {object} row
 * @param {number|null}  row.operator_id
 * @param {string}       row.session_id
 * @param {string}       row.channel         - widget | phone | dashboard
 * @param {string}       row.message_snippet
 * @param {string}       row.reply_snippet
 * @param {number}       row.score_helpfulness
 * @param {number}       row.score_on_brand
 * @param {number}       row.score_lead_capture
 * @param {number}       row.score_action_quality
 * @param {number}       row.score_brevity
 * @param {number}       row.score_overall
 * @param {string}       row.scorer_model
 * @param {string[]}     row.flags
 * @param {object|null}  row.raw_scoring_json
 * @returns {Promise<number>} inserted row id
 */
async function insertScore(row) {
  const {
    operator_id = null,
    session_id = null,
    channel = 'widget',
    message_snippet = null,
    reply_snippet = null,
    score_helpfulness = null,
    score_on_brand = null,
    score_lead_capture = null,
    score_action_quality = null,
    score_brevity = null,
    score_overall = null,
    scorer_model = null,
    flags = [],
    raw_scoring_json = null,
  } = row;

  const result = await pool.query(
    `INSERT INTO hugo_call_scores
       (operator_id, session_id, channel, message_snippet, reply_snippet,
        score_helpfulness, score_on_brand, score_lead_capture, score_action_quality,
        score_brevity, score_overall, scorer_model, flags, raw_scoring_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      operator_id, session_id, channel,
      message_snippet ? String(message_snippet).substring(0, 120) : null,
      reply_snippet   ? String(reply_snippet).substring(0, 120)   : null,
      score_helpfulness, score_on_brand, score_lead_capture,
      score_action_quality, score_brevity, score_overall,
      scorer_model,
      JSON.stringify(flags),
      raw_scoring_json ? JSON.stringify(raw_scoring_json) : null,
    ]
  );
  return result.rows[0].id;
}

/**
 * Get recent scores for a single operator, newest first.
 * @param {number} operatorId
 * @param {{ limit?: number, offset?: number }} opts
 * @returns {Promise<object[]>}
 */
async function getScoresByOperator(operatorId, { limit = 20, offset = 0 } = {}) {
  const result = await pool.query(
    `SELECT id, session_id, channel, message_snippet, reply_snippet,
            score_helpfulness, score_on_brand, score_lead_capture,
            score_action_quality, score_brevity, score_overall,
            scorer_model, flags, created_at
     FROM hugo_call_scores
     WHERE operator_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [operatorId, limit, offset]
  );
  return result.rows;
}

/**
 * Rolling dimension averages for an operator over the last N days.
 * Returns a single object with avg_* fields and total_scored.
 * @param {number} operatorId
 * @param {number} days  - default 30
 * @returns {Promise<object>}
 */
async function getAveragesByOperator(operatorId, days = 30) {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int                              AS total_scored,
       ROUND(AVG(score_helpfulness)::numeric, 1)    AS avg_helpfulness,
       ROUND(AVG(score_on_brand)::numeric, 1)        AS avg_on_brand,
       ROUND(AVG(score_lead_capture)::numeric, 1)    AS avg_lead_capture,
       ROUND(AVG(score_action_quality)::numeric, 1)  AS avg_action_quality,
       ROUND(AVG(score_brevity)::numeric, 1)          AS avg_brevity,
       ROUND(AVG(score_overall)::numeric, 1)          AS avg_overall
     FROM hugo_call_scores
     WHERE operator_id = $1
       AND created_at >= NOW() - ($2 || ' days')::INTERVAL`,
    [operatorId, days]
  );
  return result.rows[0] || {};
}

/**
 * Get turns that have at least one flag, for operator review.
 * @param {number} operatorId
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
async function getRecentFlags(operatorId, limit = 10) {
  const result = await pool.query(
    `SELECT id, session_id, channel, message_snippet, reply_snippet,
            score_overall, flags, created_at
     FROM hugo_call_scores
     WHERE operator_id = $1
       AND jsonb_array_length(flags) > 0
     ORDER BY created_at DESC
     LIMIT $2`,
    [operatorId, limit]
  );
  return result.rows;
}

/**
 * System-wide aggregates for founder dashboard (all operators, last N days).
 * @param {number} days
 * @returns {Promise<object>}
 */
async function getSystemStats(days = 7) {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int                              AS total_scored,
       ROUND(AVG(score_overall)::numeric, 2)      AS avg_overall,
       ROUND(AVG(score_helpfulness)::numeric, 2)  AS avg_helpfulness,
       ROUND(AVG(score_on_brand)::numeric, 2)     AS avg_on_brand,
       COUNT(*) FILTER (WHERE score_overall < 3)::int AS low_score_count,
       COUNT(*) FILTER (WHERE jsonb_array_length(flags) > 0)::int AS flagged_count,
       channel,
       COUNT(*)::int AS channel_count
     FROM hugo_call_scores
     WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
     GROUP BY ROLLUP(channel)
     ORDER BY channel NULLS LAST`,
    [days]
  );
  return result.rows;
}

module.exports = {
  insertScore,
  getScoresByOperator,
  getAveragesByOperator,
  getRecentFlags,
  getSystemStats,
};
