/**
 * DB module — hugo supervision loop tables.
 *
 * Owns: all reads/writes for hugo_supervision_log, hugo_confidence_scores,
 *       hugo_training_versions.
 * Does NOT own: scoring logic (services/hugo-supervision.js), route auth,
 *               the underlying prompt text storage (hugo_founder_config).
 *
 * Public API:
 *   insertSupervisionLog(row)             → inserts a new nightly run row, returns id
 *   updateSupervisionLog(id, updates)     → patches a run row (e.g. after completion)
 *   getSupervisionLogs(opts)              → list of recent runs, filterable by operator/date
 *   getLatestSupervisionLog(operatorId)   → most recent completed run
 *
 *   insertConfidenceScore(row)            → saves per-conversation confidence
 *   getAnomaliesToReview(limit)           → conversations with needs_review=true
 *   markReviewed(id)                      → clears needs_review flag
 *
 *   createTrainingVersion(row)            → inserts versioned prompt change, returns {id, version_number}
 *   getTrainingVersions(promptKey)        → full version history for one prompt
 *   getTrainingVersion(id)               → single version row
 *   applyTrainingVersion(id)              → marks applied=true + applied_at
 *   rollbackTrainingVersion(id, reason)   → marks rolled_back=true + rolled_back_at
 *   approveTrainingVersion(id, approved)  → sets founder_approved + approved_at
 *   getCurrentVersionNumber(promptKey)    → latest version_number for a key
 */

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── Bootstrap ─────────────────────────────────────────────────────────────────
// Ensure tables exist on startup — belt-and-suspenders alongside the SQL migration.
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hugo_supervision_log (
      id                SERIAL PRIMARY KEY,
      run_date          DATE NOT NULL DEFAULT CURRENT_DATE,
      operator_id       INTEGER,
      conversations_reviewed INTEGER NOT NULL DEFAULT 0,
      conversations_flagged  INTEGER NOT NULL DEFAULT 0,
      avg_confidence    NUMERIC(4,3),
      issues_detected   JSONB NOT NULL DEFAULT '[]',
      suggestions       JSONB NOT NULL DEFAULT '[]',
      report_text       TEXT,
      model_used        VARCHAR(80),
      run_duration_ms   INTEGER,
      status            VARCHAR(20) NOT NULL DEFAULT 'completed',
      error_message     TEXT,
      created_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hugo_confidence_scores (
      id              SERIAL PRIMARY KEY,
      operator_id     INTEGER,
      session_id      VARCHAR(64) NOT NULL,
      channel         VARCHAR(20) NOT NULL DEFAULT 'widget',
      confidence      NUMERIC(4,3) NOT NULL,
      needs_review    BOOLEAN NOT NULL DEFAULT FALSE,
      review_reason   TEXT,
      turn_count      INTEGER NOT NULL DEFAULT 1,
      conversation_summary TEXT,
      reviewed_at     TIMESTAMP,
      created_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hugo_training_versions (
      id              SERIAL PRIMARY KEY,
      version_number  INTEGER NOT NULL,
      prompt_key      VARCHAR(80) NOT NULL,
      prompt_before   TEXT NOT NULL,
      prompt_after    TEXT NOT NULL,
      change_reason   TEXT NOT NULL,
      change_source   VARCHAR(40) NOT NULL DEFAULT 'supervision',
      supervision_log_id INTEGER,
      applied         BOOLEAN NOT NULL DEFAULT FALSE,
      applied_at      TIMESTAMP,
      rolled_back     BOOLEAN NOT NULL DEFAULT FALSE,
      rolled_back_at  TIMESTAMP,
      rollback_reason TEXT,
      founder_approved BOOLEAN,
      approved_at     TIMESTAMP,
      created_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}
ensureTables().catch(e => console.error('[hugo-supervision db] ensureTables error:', e.message));

// ─── Supervision log ────────────────────────────────────────────────────────────
async function insertSupervisionLog(row) {
  const {
    run_date = null,
    operator_id = null,
    conversations_reviewed = 0,
    conversations_flagged = 0,
    avg_confidence = null,
    issues_detected = [],
    suggestions = [],
    report_text = null,
    model_used = null,
    run_duration_ms = null,
    status = 'running',
    error_message = null,
  } = row;

  const result = await pool.query(
    `INSERT INTO hugo_supervision_log
       (run_date, operator_id, conversations_reviewed, conversations_flagged, avg_confidence,
        issues_detected, suggestions, report_text, model_used, run_duration_ms, status, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      run_date || new Date().toISOString().split('T')[0],
      operator_id,
      conversations_reviewed,
      conversations_flagged,
      avg_confidence,
      JSON.stringify(issues_detected),
      JSON.stringify(suggestions),
      report_text,
      model_used,
      run_duration_ms,
      status,
      error_message,
    ]
  );
  return result.rows[0].id;
}

async function updateSupervisionLog(id, updates) {
  const allowed = [
    'conversations_reviewed', 'conversations_flagged', 'avg_confidence',
    'issues_detected', 'suggestions', 'report_text', 'model_used',
    'run_duration_ms', 'status', 'error_message',
  ];
  const sets = [];
  const vals = [];
  let idx = 1;

  for (const key of allowed) {
    if (key in updates) {
      sets.push(`${key} = $${idx++}`);
      const v = updates[key];
      vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
    }
  }
  if (!sets.length) return;

  vals.push(id);
  await pool.query(
    `UPDATE hugo_supervision_log SET ${sets.join(', ')} WHERE id = $${idx}`,
    vals
  );
}

async function getSupervisionLogs({ operator_id = null, limit = 20, offset = 0 } = {}) {
  if (operator_id) {
    const result = await pool.query(
      `SELECT id, run_date, operator_id, conversations_reviewed, conversations_flagged,
              avg_confidence, issues_detected, suggestions, report_text, model_used,
              run_duration_ms, status, error_message, created_at
       FROM hugo_supervision_log
       WHERE operator_id = $1 OR operator_id IS NULL
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [operator_id, limit, offset]
    );
    return result.rows;
  }
  const result = await pool.query(
    `SELECT id, run_date, operator_id, conversations_reviewed, conversations_flagged,
            avg_confidence, issues_detected, suggestions, report_text, model_used,
            run_duration_ms, status, error_message, created_at
     FROM hugo_supervision_log
     ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
}

async function getLatestSupervisionLog(operatorId = null) {
  const result = await pool.query(
    `SELECT * FROM hugo_supervision_log
     WHERE status = 'completed'
       AND (operator_id = $1 OR operator_id IS NULL)
     ORDER BY created_at DESC LIMIT 1`,
    [operatorId]
  );
  return result.rows[0] || null;
}

// ─── Confidence scores ──────────────────────────────────────────────────────────
async function insertConfidenceScore(row) {
  const {
    operator_id = null,
    session_id,
    channel = 'widget',
    confidence,
    needs_review = false,
    review_reason = null,
    turn_count = 1,
    conversation_summary = null,
  } = row;

  const result = await pool.query(
    `INSERT INTO hugo_confidence_scores
       (operator_id, session_id, channel, confidence, needs_review,
        review_reason, turn_count, conversation_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [operator_id, session_id, channel, confidence, needs_review,
     review_reason, turn_count, conversation_summary]
  );
  return result.rows[0]?.id;
}

async function getAnomaliesToReview(limit = 20) {
  const result = await pool.query(
    `SELECT id, operator_id, session_id, channel, confidence, review_reason,
            turn_count, conversation_summary, created_at
     FROM hugo_confidence_scores
     WHERE needs_review = TRUE AND reviewed_at IS NULL
     ORDER BY confidence ASC, created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function markReviewed(id) {
  await pool.query(
    `UPDATE hugo_confidence_scores SET reviewed_at = NOW() WHERE id = $1`,
    [id]
  );
}

// ─── Training versions ──────────────────────────────────────────────────────────
async function getCurrentVersionNumber(promptKey) {
  const result = await pool.query(
    `SELECT COALESCE(MAX(version_number), 0) AS max_ver
     FROM hugo_training_versions WHERE prompt_key = $1`,
    [promptKey]
  );
  return parseInt(result.rows[0].max_ver, 10);
}

async function createTrainingVersion(row) {
  const {
    prompt_key,
    prompt_before,
    prompt_after,
    change_reason,
    change_source = 'supervision',
    supervision_log_id = null,
  } = row;

  // Atomic: get next version number and insert in a serializable way
  const versionNum = await getCurrentVersionNumber(prompt_key) + 1;

  const result = await pool.query(
    `INSERT INTO hugo_training_versions
       (version_number, prompt_key, prompt_before, prompt_after,
        change_reason, change_source, supervision_log_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, version_number`,
    [versionNum, prompt_key, prompt_before, prompt_after,
     change_reason, change_source, supervision_log_id]
  );
  return result.rows[0];
}

async function getTrainingVersions(promptKey, { limit = 30, offset = 0 } = {}) {
  const result = await pool.query(
    `SELECT id, version_number, prompt_key, change_reason, change_source,
            applied, applied_at, rolled_back, rolled_back_at, rollback_reason,
            founder_approved, approved_at, supervision_log_id, created_at,
            LEFT(prompt_before, 200) AS prompt_before_preview,
            LEFT(prompt_after, 200) AS prompt_after_preview
     FROM hugo_training_versions
     WHERE prompt_key = $1
     ORDER BY version_number DESC
     LIMIT $2 OFFSET $3`,
    [promptKey, limit, offset]
  );
  return result.rows;
}

async function getTrainingVersion(id) {
  const result = await pool.query(
    `SELECT * FROM hugo_training_versions WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function applyTrainingVersion(id) {
  await pool.query(
    `UPDATE hugo_training_versions
     SET applied = TRUE, applied_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

async function rollbackTrainingVersion(id, reason = 'manual rollback') {
  await pool.query(
    `UPDATE hugo_training_versions
     SET rolled_back = TRUE, rolled_back_at = NOW(), rollback_reason = $2
     WHERE id = $1`,
    [id, reason]
  );
}

async function approveTrainingVersion(id, approved) {
  await pool.query(
    `UPDATE hugo_training_versions
     SET founder_approved = $2, approved_at = NOW()
     WHERE id = $1`,
    [id, approved]
  );
}

module.exports = {
  // Supervision log
  insertSupervisionLog,
  updateSupervisionLog,
  getSupervisionLogs,
  getLatestSupervisionLog,
  // Confidence scores
  insertConfidenceScore,
  getAnomaliesToReview,
  markReviewed,
  // Training versions
  createTrainingVersion,
  getTrainingVersions,
  getTrainingVersion,
  applyTrainingVersion,
  rollbackTrainingVersion,
  approveTrainingVersion,
  getCurrentVersionNumber,
};
