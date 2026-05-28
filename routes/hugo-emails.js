/**
 * Hugo Email Routes — operator inbox management via HUGO.
 *
 * Owns: CRUD for operator_emails table, draft reply generation, approval + send,
 *       and outbound lead reply (POST /email/reply → hugo_email_outbox).
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
 * POST /api/hugo/email/reply                 — compose + send a reply to a lead (lead response engine)
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
const { composeReply, VALID_EMAIL_TYPES } = require('../services/emailComposer');
const { sendEmail } = require('../services/emailSender');

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

// ─── POST /api/hugo/email/reply ───────────────────────────────────────────────
// Compose and send a Hugo reply to a lead. Requires operator auth.
// Body: { leadId, inboundEmailId?, replyType, tone?, customBody? }
//
// Guards:
//   - leadId must be a positive integer (leads.id is SERIAL)
//   - replyType must be a valid enum
//   - 5-minute idempotency: suppresses duplicate sends for (leadId, emailType)
router.post('/reply', requireAuth, async (req, res) => {
  try {
    const { leadId, inboundEmailId, replyType, tone, customBody } = req.body || {};

    // VALIDATION 1: Integer format guard — leads.id is SERIAL (integer), not UUID
    if (!leadId || !/^\d+$/.test(String(leadId))) {
      return res.status(400).json({ error: 'Invalid parameter format: leadId must be a positive integer.' });
    }
    const leadIdInt = parseInt(leadId, 10);

    // VALIDATION 2: Email type enum guard
    const emailType = replyType || 'custom';
    if (!VALID_EMAIL_TYPES.includes(emailType)) {
      return res.status(400).json({ error: `Invalid replyType. Must be one of: ${VALID_EMAIL_TYPES.join(', ')}` });
    }

    // VALIDATION 3: Idempotency guard — 5-minute duplicate send suppression
    const recent = await pool.query(
      `SELECT outbox_id FROM hugo_email_outbox
       WHERE lead_id = $1
         AND email_type = $2
         AND sent_at >= NOW() - INTERVAL '5 minutes'
       LIMIT 1`,
      [leadIdInt, emailType]
    );
    if (recent.rows.length > 0) {
      return res.status(409).json({
        error: 'Duplicate request suppressed. A matching email was processed within the last 5 minutes.',
        outbox_id: recent.rows[0].outbox_id,
      });
    }

    // Fetch lead data — scoped to operator via user_id for security
    let lead = null;
    try {
      const leadResult = await pool.query(
        `SELECT id, name, email, phone, lead_type, source, notes FROM leads WHERE id = $1 AND user_id = $2`,
        [leadIdInt, req.userId]
      );
      lead = leadResult.rows[0] || null;
    } catch {
      // leads.user_id column may not exist — try without scoping
      const leadResult = await pool.query(
        `SELECT id, name, email, phone, lead_type, source, notes FROM leads WHERE id = $1`,
        [leadIdInt]
      );
      lead = leadResult.rows[0] || null;
    }

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    if (!lead.email) {
      return res.status(422).json({ error: 'Lead has no email address — cannot send reply.' });
    }

    // Fetch inbound email context if provided
    let inboundEmail = { body: customBody || '' };
    if (inboundEmailId) {
      const inboundResult = await pool.query(
        `SELECT body_text AS body FROM operator_emails
         WHERE id = $1 AND operator_id = $2`,
        [parseInt(inboundEmailId, 10), req.userId]
      );
      if (inboundResult.rows[0]) inboundEmail = inboundResult.rows[0];
    }

    // Fetch operator context for personalisation
    let operatorCtx = {};
    try {
      const profileResult = await pool.query(
        `SELECT op.business_name, op.operator_name, u.mobile_number AS phone
         FROM operator_profiles op
         JOIN users u ON u.id = op.operator_id
         WHERE op.operator_id = $1`,
        [req.userId]
      );
      if (profileResult.rows[0]) {
        const p = profileResult.rows[0];
        operatorCtx = {
          businessName: p.business_name || 'PropOps Pro',
          operatorName: p.operator_name || 'Hugo',
          phone: p.phone || '',
        };
      }
    } catch {
      // profile missing — use defaults
    }

    // Compose or use custom body
    let emailBody;
    if (customBody && emailType === 'custom') {
      emailBody = customBody;
    } else {
      emailBody = await composeReply({
        leadData: lead,
        inboundEmail,
        replyType: emailType,
        tone: tone || 'professional',
        operatorCtx,
      });
    }

    const subject = `Re: ${lead.lead_type || lead.source || 'Your inquiry'}`;

    // Send via multi-provider pipeline (Resend → Postmark → Polsia proxy)
    await sendEmail({ to: lead.email, subject, body: emailBody });

    // Log to outbox — audit trail + idempotency source
    const outboxResult = await pool.query(
      `INSERT INTO hugo_email_outbox (lead_id, email_type, subject, body, sent_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       RETURNING outbox_id`,
      [leadIdInt, emailType, subject, emailBody]
    );

    console.log(`[HugoEmail] Lead reply sent to ${lead.email} (lead ${leadIdInt}, type: ${emailType})`);
    res.json({
      success:    true,
      message:    'Email sent',
      leadId:     leadIdInt,
      outbox_id:  outboxResult.rows[0].outbox_id,
    });

  } catch (err) {
    console.error('[HugoEmail] POST /email/reply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
