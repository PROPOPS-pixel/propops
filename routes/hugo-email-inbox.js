/**
 * Hugo Email Inbox — on-demand email reading for the dashboard.
 *
 * GET /api/hugo/inbox
 *
 * Owns: Real inbox data for Hugo to read when operator asks about emails.
 * Does NOT own: Email sending, email parsing, email intake.
 *
 * Three data sources:
 *   - operator_emails: inbound emails Hugo has read + summarised
 *   - raw_emails: raw email data from inbox reader (portal leads, parsed)
 *   - network_leads: widget-generated leads
 *
 * Rules: Hugo must query the REAL inbox — NEVER hallucinate email content.
 *        If no emails exist → say "No new emails in your inbox."
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('./auth');
const { getInboxSummary, getEmailIntakeLeads, getOutboundHistory } = require('../db/emails');

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── GET /api/hugo/inbox ──────────────────────────────────────────────────────
// Returns real inbox data for Hugo. Three sections: recent emails, intake leads, outbound.

router.get('/inbox', requireAuth, async (req, res) => {
  try {
    const operatorId = req.userId;
    const summary = await getInboxSummary(operatorId);

    res.json({
      success: true,
      has_data: summary.has_data,
      recent_inbound: summary.recent_inbound,
      email_intake_leads: summary.email_intake_leads,
      outbound_history: summary.outbound_history,
    });
  } catch (err) {
    console.error('[HugoEmailInbox] GET /inbox error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load inbox data' });
  }
});

// ─── GET /api/hugo/inbox/emails ──────────────────────────────────────────────
// Returns only recent inbound emails (for "show me recent emails" query)

router.get('/inbox/emails', requireAuth, async (req, res) => {
  try {
    const operatorId = req.userId;
    const { getRecentEmails } = require('../db/emails');
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const emails = await getRecentEmails(operatorId, limit);

    if (emails.length === 0) {
      return res.json({
        success: true,
        emails: [],
        message: 'No new emails in your inbox.',
      });
    }

    res.json({ success: true, emails });
  } catch (err) {
    console.error('[HugoEmailInbox] GET /inbox/emails error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load emails' });
  }
});

// ─── GET /api/hugo/inbox/intake-leads ─────────────────────────────────────────
// Returns email intake parsed leads (for "any new email leads?" query)

router.get('/inbox/intake-leads', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const leads = await getEmailIntakeLeads(limit);

    res.json({ success: true, leads });
  } catch (err) {
    console.error('[HugoEmailInbox] GET /inbox/intake-leads error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load intake leads' });
  }
});

// ─── GET /api/hugo/inbox/outbound ──────────────────────────────────────────────
// Returns what emails Hugo/system has sent (for "what emails did you send?" query)

router.get('/inbox/outbound', requireAuth, async (req, res) => {
  try {
    const operatorId = req.userId;
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const outbound = await getOutboundHistory(operatorId, limit);

    res.json({ success: true, outbound });
  } catch (err) {
    console.error('[HugoEmailInbox] GET /inbox/outbound error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load outbound history' });
  }
});

module.exports = router;