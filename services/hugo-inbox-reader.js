/**
 * Hugo Inbox Reader — Email parsing and lead extraction for operator portals.
 *
 * Polls Gmail inbox for unread emails and processes them through the email intake pipeline.
 */

const pool = require('../db/index');
const { readEmails, isConnected } = require('../lib/gmail');

/**
 * Fetch new unread emails from a specific operator portal connection.
 * Returns array of { id, from, subject, body, received_at, raw_headers }.
 *
 * TODO: implement real inbox reading from external APIs
 * Current: stub returns empty array.
 *
 * @param {number} operatorId
 * @param {string} portalName - 'Hipages', 'ServiceSeeking', 'Airtasker', etc.
 * @returns {Promise<Array>}
 */
async function fetchPortalEmails(operatorId, portalName) {
  // TODO: implement real inbox reading
  // 1. Look up operator's portal credentials (stored encrypted in operator_portal_connections)
  // 2. Authenticate with external portal API (Hipages API, ServiceSeeking API, etc.)
  // 3. Fetch new unread emails/messages
  // 4. Return as array of { id, from, subject, body, received_at, raw_headers }

  console.log(`[Hugo Inbox Reader] Stub: fetchPortalEmails(operatorId=${operatorId}, portalName=${portalName})`);
  return [];
}

/**
 * Parse an inbound email and extract lead data.
 * Returns { name, phone, email, trade, suburb, job_description, urgency }.
 *
 * TODO: implement real email parsing
 * Current: stub returns empty object.
 *
 * @param {object} emailData - { id, from, subject, body, raw_headers }
 * @param {string} portalName - Portal the email came from
 * @returns {object} Extracted lead data
 */
function parseEmailToLead(emailData, portalName) {
  // TODO: implement real email parsing
  // 1. Extract customer name from "From" header or email body
  // 2. Extract phone using regex /\b04\d{8}\b/ or /\b\(\d{2}\)\s*\d{4}\s*\d{4}\b/
  // 3. Extract suburb/postcode from body (lookup in hugo_location_data)
  // 4. Detect trade keywords from subject + body
  // 5. Estimate urgency from email timestamp, language tone, keywords like "urgent", "asap"
  // 6. Extract job description from email body paragraphs

  console.log(`[Hugo Inbox Reader] Stub: parseEmailToLead(emailId=${emailData?.id}, portalName=${portalName})`);
  return {
    name: null,
    phone: null,
    email: null,
    trade: null,
    suburb: null,
    job_description: null,
    urgency: null,
  };
}

/**
 * Save parsed lead to operator_widget_leads table.
 * Returns the saved lead record or null on error.
 *
 * TODO: implement real lead saving
 * Current: stub returns null.
 *
 * @param {number} operatorId
 * @param {object} leadData - { name, phone, email, trade, suburb, job_description, urgency }
 * @param {object} metadata - { portalName, originalEmailId, sourceUrl }
 * @returns {Promise<object|null>}
 */
async function saveLead(operatorId, leadData, metadata = {}) {
  // TODO: implement real lead saving
  // 1. Validate lead has at least: trade + (phone OR email)
  // 2. Check for duplicates by phone/email (skip if already in widget_leads for this operator)
  // 3. Calculate intent_score based on job description length, urgency, contact completeness
  // 4. INSERT into operator_widget_leads (operator_id, name, phone, email, trade, suburb, job_description, urgency, intent_score, status, metadata)
  // 5. Return the inserted row

  console.log(`[Hugo Inbox Reader] Stub: saveLead(operatorId=${operatorId}, leadData=`, leadData, ', metadata=', metadata, ')');
  return null;
}

/**
 * Process a single portal email from start to finish:
 *   1. Parse email → lead data
 *   2. Save to operator_widget_leads
 *   3. Mark email as read in portal (if API supports it)
 *   4. Return the created lead or null if skipped/error
 *
 * TODO: implement real end-to-end processing
 * Current: stub returns null.
 *
 * @param {number} operatorId
 * @param {object} emailData - { id, from, subject, body, received_at, raw_headers }
 * @param {string} portalName
 * @returns {Promise<object|null>}
 */
async function processPortalEmail(operatorId, emailData, portalName) {
  // TODO: implement real end-to-end processing
  // This is the main entry point called by the AutoRead poller

  console.log(`[Hugo Inbox Reader] Stub: processPortalEmail(operatorId=${operatorId}, emailId=${emailData?.id}, portalName=${portalName})`);
  return null;
}

/**
 * Mark a Gmail message as read via the Gmail API.
 *
 * @param {object} gmail - Gmail API client from getGmailClient()
 * @param {string} messageId - Gmail message ID
 * @returns {Promise<boolean>} true if successful, false otherwise
 */
async function markEmailAsRead(gmail, messageId) {
  try {
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        removeLabelIds: ['UNREAD']
      }
    });
    return true;
  } catch (err) {
    console.error(`[Hugo Inbox Reader] Failed to mark email ${messageId} as read:`, err.message);
    return false;
  }
}

/**
 * Poll and process company inbox emails.
 * Called by startup.js AutoRead poller — routes emails to email-intake service.
 *
 * 1. Check if Gmail is connected
 * 2. Fetch unread emails from Gmail inbox
 * 3. For each email, call inboundEmailProcessor
 * 4. Mark email as read after processing
 * 5. Track stats: processed, skipped, errors
 * 6. Log summary
 * 7. Return stats object
 *
 * @param {function} inboundEmailProcessor - email-intake.processInboundEmail
 * @param {string} systemToken - system auth token for API
 * @returns {Promise<object>} { processed, skipped_dedup, skipped_loop, errors, disabled }
 */
async function pollAndProcessInbox(inboundEmailProcessor, systemToken) {
  let gmailClient;

  try {
    // Check Gmail connection first
    const connected = await isConnected();
    if (!connected) {
      console.log('[Hugo Inbox Reader] Gmail not connected — skipping inbox poll. Visit /setup/gmail to authorize.');
      return {
        processed: 0,
        skipped_dedup: 0,
        skipped_loop: 0,
        errors: 0,
        disabled: true,
      };
    }

    // Get Gmail client
    const { getGmailClient } = require('../lib/gmail');
    gmailClient = await getGmailClient();
  } catch (err) {
    console.error('[Hugo Inbox Reader] Failed to initialize Gmail client:', err.message);
    return {
      processed: 0,
      skipped_dedup: 0,
      skipped_loop: 0,
      errors: 1,
      disabled: false,
    };
  }

  const stats = {
    processed: 0,
    skipped_dedup: 0,
    skipped_loop: 0,
    errors: 0,
    disabled: false,
  };

  try {
    // Fetch unread emails from inbox (max 20)
    const emails = await readEmails('is:unread is:inbox', 20);

    if (emails.length === 0) {
      console.log('[Hugo Inbox Reader] No unread emails in inbox');
      return stats;
    }

    console.log(`[Hugo Inbox Reader] Processing ${emails.length} unread email(s)`);

    // Process each email
    for (const emailMsg of emails) {
      try {
        // Fetch full email content (body)
        const fullEmail = await gmailClient.users.messages.get({
          userId: 'me',
          id: emailMsg.id,
          format: 'full'
        });

        const payload = fullEmail.data.payload || {};
        const headers = payload.headers || [];
        const getHeader = (name) => headers.find(h => h.name === name)?.value || '';

        let bodyText = '';
        let bodyHtml = '';

        // Extract body from parts (handle multipart emails)
        if (payload.parts) {
          for (const part of payload.parts) {
            if (part.mimeType === 'text/plain' && part.body?.data) {
              bodyText = Buffer.from(part.body.data, 'base64').toString('utf-8');
            } else if (part.mimeType === 'text/html' && part.body?.data) {
              bodyHtml = Buffer.from(part.body.data, 'base64').toString('utf-8');
            }
          }
        } else if (payload.body?.data) {
          // Simple email (no parts)
          bodyText = Buffer.from(payload.body.data, 'base64').toString('utf-8');
        }

        // Normalize email data into the format expected by processInboundEmail
        const emailData = {
          subject: getHeader('Subject'),
          body_text: bodyText || emailMsg.snippet || '',
          body_html: bodyHtml,
          from_address: getHeader('From'),
          to_address: getHeader('To'),
        };

        // Create a mock response object (processInboundEmail expects res.status().json())
        let processingResult = null;
        const mockRes = {
          status: function(code) {
            this.statusCode = code;
            return this;
          },
          json: function(data) {
            processingResult = data;
            return this;
          }
        };

        // Process the email through the intake pipeline
        console.log(`[Hugo Inbox Reader] Processing email: "${emailData.subject}" from ${emailData.from_address}`);
        
        await inboundEmailProcessor(
          systemToken,
          emailData,
          { gmail_message_id: emailMsg.id },
          mockRes,
          null // userId = null (system-scoped, not operator-scoped)
        );

        // Check result
        if (processingResult?.success) {
          stats.processed++;
          console.log(`[Hugo Inbox Reader] ✓ Email processed: ${processingResult.message}`);
        } else if (processingResult?.message?.includes('Duplicate')) {
          stats.skipped_dedup++;
          console.log(`[Hugo Inbox Reader] ⊘ Email skipped (duplicate): ${processingResult.message}`);
        } else if (processingResult?.message?.includes('Anti-loop')) {
          stats.skipped_loop++;
          console.log(`[Hugo Inbox Reader] ⊘ Email skipped (anti-loop): ${processingResult.message}`);
        } else {
          stats.errors++;
          console.error(`[Hugo Inbox Reader] ✗ Email processing failed: ${processingResult?.message || 'unknown error'}`);
        }

        // Mark email as read (regardless of processing result)
        const marked = await markEmailAsRead(gmailClient, emailMsg.id);
        if (marked) {
          console.log(`[Hugo Inbox Reader] Marked email ${emailMsg.id} as read`);
        }

      } catch (emailErr) {
        stats.errors++;
        console.error(`[Hugo Inbox Reader] Error processing email ${emailMsg.id}:`, emailErr.message);
      }
    }

    // Log summary
    if (stats.processed > 0 || stats.errors > 0 || stats.skipped_loop > 0 || stats.skipped_dedup > 0) {
      console.log(
        `[Hugo Inbox Reader] Poll complete: processed=${stats.processed} dedup_skip=${stats.skipped_dedup} loop_skip=${stats.skipped_loop} errors=${stats.errors}`
      );
    }

    return stats;

  } catch (err) {
    console.error('[Hugo Inbox Reader] Unexpected error during poll:', err.message);
    stats.errors++;
    return stats;
  }
}

/**
 * AutoRead poller: check all connected operator portal accounts for new emails.
 * Called periodically (e.g., every 60 seconds) by startup.js.
 *
 * TODO: implement real autoread polling
 * Current: stub returns empty stats.
 *
 * @returns {Promise<object>} { operatorsProcessed, emailsRead, leadsCreated, errors }
 */
async function runAutoReadPoller() {
  // TODO: implement real autoread polling
  // 1. Fetch all operator_portal_connections where enabled = true
  // 2. For each connection, call fetchPortalEmails()
  // 3. For each email, call processPortalEmail()
  // 4. Track stats: operators processed, emails read, leads created, errors
  // 5. Log summary to console
  // 6. Return stats object for monitoring/alerting

  console.log('[Hugo Inbox Reader] Stub: runAutoReadPoller() — no emails processed');
  return {
    operatorsProcessed: 0,
    emailsRead: 0,
    leadsCreated: 0,
    errors: [],
  };
}

module.exports = {
  fetchPortalEmails,
  parseEmailToLead,
  saveLead,
  processPortalEmail,
  pollAndProcessInbox,
  runAutoReadPoller,
};
