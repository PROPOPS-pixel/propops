/**
 * Hugo Email Service — HUGO reads and replies to operator emails.
 *
 * Owns: storing inbound emails to operator_emails, generating Hugo draft replies,
 *       operator approval flow, sending approved replies via Resend.
 * Does NOT own: email intake parsing (email-parser.js), lead extraction (email.js),
 *               IMAP/Gmail OAuth sync (future — currently operators forward emails
 *               to their PropOps address which populates this table via email-intake.js).
 *
 * Approval mode (default: ON):
 *   Hugo drafts a reply → operator reviews in dashboard → approves → Hugo sends.
 *   Risky emails (angry, legal, large money) always require approval regardless.
 *
 * Risk levels:
 *   normal  — Hugo can draft; approval required before send
 *   risky   — Large money, legal threat, angry customer — always flags boss first
 *   urgent  — Time-sensitive (same-day callback, emergency job)
 */

const { Pool } = require('pg');
const { Resend } = require('resend');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5,
});

// Resend client for sending approved replies
let resend = null;
function getResend() {
  if (!resend && process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

// ─── Risk classification ───────────────────────────────────────────────────────
// Keywords that flag an email as risky (always requires operator approval)
const RISKY_KEYWORDS = [
  /\$\d{4,}/,               // Large dollar amounts ($1000+)
  /legal|lawyer|solicitor|sue|court|dispute|tribunal/i,
  /refund|cancel.*contract|void.*agreement/i,
  /urgent|emergency|asap|immediately/i,
  /angry|furious|disgusted|unacceptable|fraud|scam/i,
  /media|journalist|review.*public|social media/i,
];

const URGENT_KEYWORDS = [
  /urgent|asap|today|immediately|emergency|tonight|right now/i,
  /burst|flood|leak|fire|gas.*smell|no power|blackout/i,
];

function classifyRisk(subject, body) {
  const text = `${subject || ''} ${body || ''}`;
  if (RISKY_KEYWORDS.some(re => re.test(text))) return 'risky';
  if (URGENT_KEYWORDS.some(re => re.test(text))) return 'urgent';
  return 'normal';
}

// ─── Store inbound email ───────────────────────────────────────────────────────
// Called by email-intake.js when an email arrives at the operator's PropOps address.
// Deduplicates on (operator_id + message_id).
async function storeInboundEmail(operatorId, { messageId, fromName, fromEmail, toEmail, subject, bodyText, bodyHtml, receivedAt }) {
  try {
    const riskLevel = classifyRisk(subject, bodyText);
    const result = await pool.query(
      `INSERT INTO operator_emails
         (operator_id, message_id, from_name, from_email, to_email, subject, body_text, body_html, received_at, risk_level, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'unread')
       ON CONFLICT (operator_id, message_id) DO NOTHING
       RETURNING id`,
      [operatorId, messageId, fromName, fromEmail, toEmail, subject, bodyText, bodyHtml, receivedAt || new Date(), riskLevel]
    );
    return result.rows[0]?.id || null;
  } catch (err) {
    console.error('[HugoEmail] storeInboundEmail error:', err.message);
    return null;
  }
}

// ─── Get recent emails for operator ───────────────────────────────────────────
// Hugo reads these when the boss opens the dashboard or asks "show me my emails."
async function getOperatorEmails(operatorId, { limit = 20, status = null } = {}) {
  try {
    const params = [operatorId, limit];
    const statusClause = status ? `AND status = $3` : '';
    if (status) params.push(status);

    const result = await pool.query(
      `SELECT id, message_id, from_name, from_email, subject, body_text,
              hugo_summary, hugo_intent, risk_level, status,
              hugo_draft_reply, draft_created_at, approved_at, sent_at,
              received_at
       FROM operator_emails
       WHERE operator_id = $1 ${statusClause}
       ORDER BY received_at DESC
       LIMIT $2`,
      params
    );
    return result.rows;
  } catch (err) {
    console.error('[HugoEmail] getOperatorEmails error:', err.message);
    return [];
  }
}

// ─── Get single email by id ────────────────────────────────────────────────────
async function getEmailById(operatorId, emailId) {
  try {
    const result = await pool.query(
      `SELECT * FROM operator_emails WHERE id = $1 AND operator_id = $2`,
      [emailId, operatorId]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('[HugoEmail] getEmailById error:', err.message);
    return null;
  }
}

// ─── Search emails by sender name ─────────────────────────────────────────────
// Powers "open Susan's email" — fuzzy match on from_name or from_email.
async function searchEmailsBySender(operatorId, senderQuery) {
  try {
    const result = await pool.query(
      `SELECT id, from_name, from_email, subject, body_text, hugo_summary, risk_level, status, received_at
       FROM operator_emails
       WHERE operator_id = $1
         AND (LOWER(from_name) LIKE $2 OR LOWER(from_email) LIKE $2)
       ORDER BY received_at DESC
       LIMIT 5`,
      [operatorId, `%${senderQuery.toLowerCase()}%`]
    );
    return result.rows;
  } catch (err) {
    console.error('[HugoEmail] searchEmailsBySender error:', err.message);
    return [];
  }
}

// ─── Mark email as read ────────────────────────────────────────────────────────
async function markEmailRead(operatorId, emailId) {
  try {
    await pool.query(
      `UPDATE operator_emails SET status = 'read', updated_at = NOW()
       WHERE id = $1 AND operator_id = $2 AND status = 'unread'`,
      [emailId, operatorId]
    );
  } catch (err) {
    console.error('[HugoEmail] markEmailRead error:', err.message);
  }
}

// ─── Generate Hugo draft reply ─────────────────────────────────────────────────
// Hugo reads the email and drafts a professional reply using Groq/OpenAI.
// Does NOT send — returns draft for operator approval.
async function generateDraftReply(operatorId, emailId, profile) {
  const email = await getEmailById(operatorId, emailId);
  if (!email) throw new Error(`Email ${emailId} not found for operator ${operatorId}`);

  const operatorName = profile?.boss_first_name || profile?.operator_name?.split(' ')[0] || 'Boss';
  const businessName = profile?.business_name || 'the business';

  // Risk check — risky emails get a flag note, not a full draft
  if (email.risk_level === 'risky') {
    const flagNote = `Boss — this one needs your eyes before I touch it.\n\nFrom: ${email.from_name || email.from_email}\nSubject: ${email.subject}\n\nReason: Large money, legal language, or an angry customer. I'm not replying to this one without your direct say-so. What do you want to do?`;
    await pool.query(
      `UPDATE operator_emails
       SET hugo_draft_reply = $1, draft_created_at = NOW(), status = 'draft_reply', updated_at = NOW()
       WHERE id = $2 AND operator_id = $3`,
      [flagNote, emailId, operatorId]
    );
    return { draft: flagNote, risk_level: 'risky', requires_approval: true };
  }

  // Build the draft reply prompt
  const systemPrompt = `You are HUGO. Employee of ${businessName}. You are drafting a reply email on behalf of ${operatorName}.

RULES FOR EMAIL REPLIES:
- Sign off as "HUGO from ${businessName}"
- Professional, friendly, clean, short
- Never promise pricing or timing you don't know for certain
- Never make deals or commitments — that's the boss's call
- If you need info you don't have (schedule, exact price), say "I'll check with ${operatorName} and confirm shortly"
- Australian English. No American spellings.
- Max 3-4 short paragraphs. Get to the point.

Write a reply to this email. Just the email body — no subject line, no "Dear/Hi" opening (HUGO dives in).`;

  const userPrompt = `Original email:
From: ${email.from_name || email.from_email}
Subject: ${email.subject || '(no subject)'}

${email.body_text || '(no body)'}

---
Draft a professional reply. End with:
HUGO
${businessName}`;

  // Use OpenAI proxy (Polsia) for email drafting — data task, not persona chat
  const OpenAI = require('openai');
  const openai = new OpenAI();
  let draft = '';
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 500,
      temperature: 0.5,
    });
    draft = res.choices[0]?.message?.content?.trim() || '';
  } catch (aiErr) {
    throw new Error(`Draft generation failed: ${aiErr.message}`);
  }

  // Save draft to DB with status='draft_reply'
  await pool.query(
    `UPDATE operator_emails
     SET hugo_draft_reply = $1, draft_created_at = NOW(), status = 'draft_reply', updated_at = NOW()
     WHERE id = $2 AND operator_id = $3`,
    [draft, emailId, operatorId]
  );

  console.log(`[HugoEmail] Draft reply generated for email ${emailId}, operator ${operatorId}`);
  return { draft, risk_level: email.risk_level, requires_approval: true };
}

// ─── Approve and send reply ────────────────────────────────────────────────────
// Operator calls this from dashboard: "Yes, send it" → Hugo fires it.
async function approveAndSendReply(operatorId, emailId, profile, customReplyText = null) {
  const email = await getEmailById(operatorId, emailId);
  if (!email) throw new Error(`Email ${emailId} not found`);
  if (!email.hugo_draft_reply && !customReplyText) throw new Error('No draft reply to send');

  const replyBody = customReplyText || email.hugo_draft_reply;
  const businessName = profile?.business_name || 'PropOps';
  const operatorEmail = profile?.email || null;

  // Mark approved
  await pool.query(
    `UPDATE operator_emails SET approved_at = NOW(), updated_at = NOW(), status = 'approved_pending_send'
     WHERE id = $1 AND operator_id = $2`,
    [emailId, operatorId]
  );

  // Send via Resend
  const client = getResend();
  if (!client) throw new Error('Resend not configured (RESEND_API_KEY missing)');

  try {
    await client.emails.send({
      from: operatorEmail ? `HUGO from ${businessName} <hugo@re.propops.pro>` : `HUGO from ${businessName} <hugo@re.propops.pro>`,
      replyTo: operatorEmail || undefined,
      to: email.from_email,
      subject: `Re: ${email.subject || ''}`,
      text: replyBody,
    });

    await pool.query(
      `UPDATE operator_emails SET sent_at = NOW(), status = 'sent', updated_at = NOW()
       WHERE id = $1 AND operator_id = $2`,
      [emailId, operatorId]
    );

    console.log(`[HugoEmail] Reply sent for email ${emailId} to ${email.from_email}`);
    return { sent: true, to: email.from_email };
  } catch (sendErr) {
    console.error('[HugoEmail] Send error:', sendErr.message);
    throw sendErr;
  }
}

// ─── Unread count (for dashboard badge) ───────────────────────────────────────
async function getUnreadCount(operatorId) {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM operator_emails WHERE operator_id = $1 AND status = 'unread'`,
      [operatorId]
    );
    return parseInt(result.rows[0]?.count || 0, 10);
  } catch (err) {
    return 0;
  }
}

// ─── Pending approvals count ───────────────────────────────────────────────────
async function getPendingApprovalCount(operatorId) {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM operator_emails WHERE operator_id = $1 AND status = 'draft_reply'`,
      [operatorId]
    );
    return parseInt(result.rows[0]?.count || 0, 10);
  } catch (err) {
    return 0;
  }
}

module.exports = {
  storeInboundEmail,
  getOperatorEmails,
  getEmailById,
  searchEmailsBySender,
  markEmailRead,
  generateDraftReply,
  approveAndSendReply,
  getUnreadCount,
  getPendingApprovalCount,
};
