/**
 * Hugo Email Routes — operator inbox management via HUGO.
 *
 * Owns: CRUD for operator_emails table, draft reply generation, approval + send.
 * Does NOT own: email delivery infrastructure (services/email.js),
 *               lead parsing from portal emails (services/email-parser.js),
 *               inbound webhook routing (routes/email-intake.js).
 *
 * GET  /api/hugo/emails                      — list operator's inbox (with pagination)
 * GET  /api/hugo/emails/:id                  — get single email
 * GET  /api/hugo/emails/search?q=Susan       — fuzzy search by sender name
 * POST /api/hugo/emails/:id/read             — mark as read
 * POST /api/hugo/emails/:id/draft-reply      — generate Hugo draft reply (requires approval)
 * POST /api/hugo/emails/:id/approve-send     — approve + send Hugo's draft (or custom reply)
 * GET  /api/hugo/emails/counts               — unread + pending approval counts (for badge)
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./auth');
const {
  getOperatorEmails,
  getEmailById,
  searchEmailsBySender,
  markEmailRead,
  generateDraftReply,
  approveAndSendReply,
  getUnreadCount,
  getPendingApprovalCount,
} = require('../services/hugo-email');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── Helper: load operator profile for email service ──────────────────────────
async function getProfile(operatorId) {
  try {
    const result = await pool.query(
      `SELECT op.boss_first_name, op.operator_name, op.business_name, op.trade_type,
              op.business_customization, u.email
       FROM operator_profiles op
       JOIN users u ON u.id = op.operator_id
       WHERE op.operator_id = $1`,
      [operatorId]
    );
    return result.rows[0] || null;
  } catch (err) {
    return null;
  }
}

// ─── GET /api/hugo/emails/counts ──────────────────────────────────────────────
router.get('/counts', requireAuth, async (req, res) => {
  try {
    const [unread, pending] = await Promise.all([
      getUnreadCount(req.userId),
      getPendingApprovalCount(req.userId),
    ]);
    res.json({ success: true, unread, pending_approval: pending });
  } catch (err) {
    console.error('[HugoEmails] GET /counts error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get email counts' });
  }
});

// ─── GET /api/hugo/emails/search?q=Susan ──────────────────────────────────────
router.get('/search', requireAuth, async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ success: false, message: 'q must be at least 2 characters' });
  }
  try {
    const emails = await searchEmailsBySender(req.userId, q.trim());
    res.json({ success: true, emails, query: q.trim() });
  } catch (err) {
    console.error('[HugoEmails] GET /search error:', err.message);
    res.status(500).json({ success: false, message: 'Search failed' });
  }
});

// ─── GET /api/hugo/emails ─────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const { status, limit = '20' } = req.query;
  try {
    const emails = await getOperatorEmails(req.userId, {
      status: status || null,
      limit: Math.min(parseInt(limit, 10) || 20, 100),
    });
    res.json({ success: true, emails, total: emails.length });
  } catch (err) {
    console.error('[HugoEmails] GET / error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load emails' });
  }
});

// ─── GET /api/hugo/emails/:id ─────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  const emailId = parseInt(req.params.id, 10);
  if (isNaN(emailId)) return res.status(400).json({ success: false, message: 'Invalid email id' });

  try {
    const email = await getEmailById(req.userId, emailId);
    if (!email) return res.status(404).json({ success: false, message: 'Email not found' });

    // Auto-mark read when opened
    await markEmailRead(req.userId, emailId);
    res.json({ success: true, email });
  } catch (err) {
    console.error('[HugoEmails] GET /:id error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load email' });
  }
});

// ─── POST /api/hugo/emails/:id/read ──────────────────────────────────────────
router.post('/:id/read', requireAuth, async (req, res) => {
  const emailId = parseInt(req.params.id, 10);
  if (isNaN(emailId)) return res.status(400).json({ success: false, message: 'Invalid email id' });

  try {
    await markEmailRead(req.userId, emailId);
    res.json({ success: true });
  } catch (err) {
    console.error('[HugoEmails] POST /:id/read error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to mark email read' });
  }
});

// ─── POST /api/hugo/emails/:id/draft-reply ───────────────────────────────────
// Hugo drafts a reply. Requires operator approval before sending.
// Returns: { draft, risk_level, requires_approval }
router.post('/:id/draft-reply', requireAuth, async (req, res) => {
  const emailId = parseInt(req.params.id, 10);
  if (isNaN(emailId)) return res.status(400).json({ success: false, message: 'Invalid email id' });

  try {
    const profile = await getProfile(req.userId);
    const result = await generateDraftReply(req.userId, emailId, profile);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[HugoEmails] POST /:id/draft-reply error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to generate draft reply' });
  }
});

// ─── POST /api/hugo/emails/:id/approve-send ──────────────────────────────────
// Operator approves Hugo's draft (or provides custom reply text) → Hugo sends it.
// Body: { custom_reply?: string }  — if provided, sends custom text instead of Hugo's draft
router.post('/:id/approve-send', requireAuth, async (req, res) => {
  const emailId = parseInt(req.params.id, 10);
  if (isNaN(emailId)) return res.status(400).json({ success: false, message: 'Invalid email id' });

  const { custom_reply } = req.body || {};

  try {
    const profile = await getProfile(req.userId);
    const result = await approveAndSendReply(req.userId, emailId, profile, custom_reply || null);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[HugoEmails] POST /:id/approve-send error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to send reply' });
  }
});

module.exports = router;
