const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const leadsService = require('../services/leads');
const { generateLeadResponse } = require('../services/ai-responder');
const { notifyNewLead } = require('../services/notifications');
const { requireAuth } = require('./auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

/**
 * Validate that :id param is a positive integer.
 * Rejects strings like "simulate" before they reach the database.
 */
function validateLeadId(req, res, next) {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ success: false, message: 'Invalid lead ID — must be a number' });
  }
  next();
}

/**
 * POST /api/leads - Submit a new lead inquiry
 * This is the core endpoint — receives leads and triggers AI response
 */
router.post('/', async (req, res) => {
  try {
    const { name, email, phone, property_interest, property_listing_url, lead_type, source, notes } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    if (!email && !phone) {
      return res.status(400).json({ success: false, message: 'Email or phone is required' });
    }

    // 1. Save the lead
    const lead = await leadsService.createLead({
      name, email, phone, property_interest, property_listing_url, lead_type, source, notes
    });

    // Log activity
    await leadsService.logActivity(lead.id, 'lead_created', `New lead from ${source || 'website'}`, { source });

    // 2. Generate AI response (async but we wait for it)
    let aiResponse = null;
    const aiStartTime = Date.now();
    try {
      const ai = await generateLeadResponse(lead);
      aiResponse = await leadsService.saveLeadResponse(lead.id, {
        response_text: ai.responseText,
        response_type: 'initial',
        channel: 'email',
        ai_model: ai.model,
        ai_cost_usd: ai.costUsd
      });

      // Actually send the email to the lead
      const emailResult = await leadsService.sendResponseToLead(lead, aiResponse);

      // Update lead status to contacted
      await leadsService.updateLeadStatus(lead.id, 'contacted');
      await leadsService.logActivity(lead.id, 'ai_response_generated',
        emailResult.ok
          ? `AI response generated and sent via ${emailResult.provider}`
          : `AI response generated (email delivery failed: ${emailResult.reason || 'unknown'})`,
        {
          model: ai.model,
          cost_usd: ai.costUsd,
          tokens: ai.tokens,
          email_sent: emailResult.ok || false,
          email_provider: emailResult.provider || null,
        }
      );

      // Fire notifications — non-blocking, never throws into main flow
      const responseTimeSec = (Date.now() - aiStartTime) / 1000;
      notifyNewLead(lead, aiResponse, responseTimeSec).catch((err) => {
        console.error('[Leads] Notification dispatch error:', err.message);
      });

    } catch (aiError) {
      console.error('[Leads] AI response generation failed:', aiError.message);
      await leadsService.logActivity(lead.id, 'ai_response_failed', `AI response failed: ${aiError.message}`);
    }

    res.status(201).json({
      success: true,
      lead,
      response: aiResponse,
      message: aiResponse ? 'Lead received and AI response generated' : 'Lead received (AI response pending)'
    });

  } catch (error) {
    console.error('[Leads] Error creating lead:', error.message);
    res.status(500).json({ success: false, message: 'Failed to create lead' });
  }
});

/**
 * GET /api/leads - List all leads with filters
 * Query params: status, source, lead_type, search, limit, offset, include_simulated
 * include_simulated: 'true' (default) to include, 'false' to exclude test leads
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, source, lead_type, search, limit, offset, include_simulated } = req.query;
    const result = await leadsService.getLeads({
      status,
      source,
      lead_type,
      search,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
      include_simulated: include_simulated !== 'false', // default true
      userId: req.userId
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[Leads] Error fetching leads:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch leads' });
  }
});

/**
 * DELETE /api/leads/simulated - Delete all simulated (test) leads AND their auto-collected listings
 * Catches both:
 *   1. Leads with metadata.is_simulated = true (current flag)
 *   2. Legacy leads whose raw_emails entry has raw_payload.simulated = true
 *      (created before the is_simulated flag was added to metadata)
 *
 * Also removes auto-collected listings (source = 'email') that originated from
 * simulated emails. Manually added listings (source = 'manual') are NEVER touched.
 */
router.delete('/simulated', requireAuth, async (req, res) => {
  try {
    const userClause = req.userId ? `AND (user_id = $1 OR user_id IS NULL)` : '';
    const listingsUserClause = req.userId ? `AND (user_id = $1 OR user_id IS NULL)` : '';
    const userParams = req.userId ? [req.userId] : [];

    // Step 1a: Delete auto-collected listings linked to simulated raw_emails
    // (primary path — source_email_id intact)
    const listingsResult = await pool.query(
      `DELETE FROM listings
       WHERE source = 'email'
         AND source_email_id IN (
           SELECT id FROM raw_emails
           WHERE raw_payload->>'simulated' = 'true'
         )
         ${listingsUserClause}
       RETURNING id`,
      userParams
    );
    let listingsDeleted = listingsResult.rowCount;
    if (listingsDeleted > 0) {
      console.log(`[Leads] Deleted ${listingsDeleted} auto-collected listings (via source_email_id)`);
    }

    // Step 1b: Fallback — delete orphaned auto-collected listings whose source_email_id
    // was set to NULL by the ON DELETE SET NULL FK constraint (from previous partial clears).
    // Match by listing_url against simulated leads' property_listing_url.
    const orphanResult = await pool.query(
      `DELETE FROM listings
       WHERE source = 'email'
         AND source_email_id IS NULL
         AND listing_url IN (
           SELECT DISTINCT l.property_listing_url
           FROM leads l
           WHERE l.property_listing_url IS NOT NULL
             AND (
               l.metadata->>'is_simulated' = 'true'
               OR l.id IN (
                 SELECT parsed_lead_id FROM raw_emails
                 WHERE raw_payload->>'simulated' = 'true'
                   AND parsed_lead_id IS NOT NULL
               )
             )
         )
         ${listingsUserClause}
       RETURNING id`,
      userParams
    );
    if (orphanResult.rowCount > 0) {
      console.log(`[Leads] Deleted ${orphanResult.rowCount} orphaned listings (fallback via lead URL match)`);
      listingsDeleted += orphanResult.rowCount;
    }

    // Step 2: Delete the simulated leads themselves
    const result = await pool.query(
      `DELETE FROM leads
       WHERE (metadata->>'is_simulated' = 'true'
          OR id IN (
            SELECT parsed_lead_id FROM raw_emails
            WHERE raw_payload->>'simulated' = 'true'
              AND parsed_lead_id IS NOT NULL
          ))
          ${userClause}
       RETURNING id`,
      userParams
    );
    console.log(`[Leads] Deleted ${result.rowCount} simulated test leads (includes legacy)`);

    // Step 3: Count simulated raw_emails so we can decrement intake token counters
    const simEmailCount = await pool.query(
      `SELECT COUNT(*) as cnt FROM raw_emails WHERE raw_payload->>'simulated' = 'true'`,
    );
    const simEmails = parseInt(simEmailCount.rows[0].cnt) || 0;

    // Step 4: Delete simulated raw_emails
    await pool.query(`DELETE FROM raw_emails WHERE raw_payload->>'simulated' = 'true'`);

    // Step 5: Decrement intake token counters to reflect cleared test data
    if (simEmails > 0 && req.userId) {
      await pool.query(
        `UPDATE intake_tokens
         SET emails_received = GREATEST(0, emails_received - $1),
             leads_created   = GREATEST(0, leads_created - $2)
         WHERE user_id = $3 AND is_active = true`,
        [simEmails, result.rowCount, req.userId]
      );
    }

    res.json({
      success: true,
      message: `Deleted ${result.rowCount} test leads and ${listingsDeleted} auto-collected listings`,
      deleted_count: result.rowCount,
      listings_deleted: listingsDeleted
    });
  } catch (error) {
    console.error('[Leads] Error deleting simulated leads:', error.message);
    res.status(500).json({ success: false, message: 'Failed to delete simulated leads' });
  }
});

/**
 * GET /api/leads/stats - Dashboard statistics
 */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const include_simulated = req.query.include_simulated !== 'false'; // default true (match table behavior)
    const stats = await leadsService.getDashboardStats(req.userId, { include_simulated });
    res.json({ success: true, stats });
  } catch (error) {
    console.error('[Leads] Error fetching stats:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

/**
 * GET /api/leads/:id - Get a single lead with history
 */
router.get('/:id', requireAuth, validateLeadId, async (req, res) => {
  try {
    const lead = await leadsService.getLeadById(req.params.id);
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }
    res.json({ success: true, lead });
  } catch (error) {
    console.error('[Leads] Error fetching lead:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch lead' });
  }
});

/**
 * PATCH /api/leads/:id/status - Update lead status
 */
router.patch('/:id/status', requireAuth, validateLeadId, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['new', 'contacted', 'qualified', 'viewing_booked', 'won', 'lost'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    const lead = await leadsService.updateLeadStatus(req.params.id, status);
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    await leadsService.logActivity(lead.id, 'status_changed', `Status changed to ${status}`, { status });

    // Phase 3A — log subscriber signal to hugo_subscriber_signals for learning engine
    try {
      // Map lead status to canonical signal type
      const signalTypeMap = {
        contacted:      'lead_contacted',
        won:            'lead_booked',
        lost:           'lead_ignored',
        qualified:      'lead_contacted',
        viewing_booked: 'lead_booked',
        new:            'lead_status_changed',
      };
      const signalType = signalTypeMap[status] || 'lead_status_changed';

      await pool.query(
        `INSERT INTO hugo_subscriber_signals (operator_id, trade_category, signal_type, signal_data)
         VALUES ($1, $2, $3, $4)`,
        [
          req.userId,
          lead.lead_type || null,
          signalType,
          JSON.stringify({ lead_id: lead.id, status, previous_status: lead.status }),
        ]
      );
    } catch (sigErr) {
      // Non-blocking — signal logging must never fail the response
      console.warn('[Leads] Failed to log subscriber signal:', sigErr.message);
    }

    res.json({ success: true, lead });
  } catch (error) {
    console.error('[Leads] Error updating status:', error.message);
    res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

/**
 * PATCH /api/leads/:id - Update lead fields (property_listing_url, notes, etc.)
 */
router.patch('/:id', requireAuth, validateLeadId, async (req, res) => {
  try {
    const allowed = ['property_listing_url', 'property_interest', 'notes', 'name', 'email', 'phone', 'lead_type', 'source'];
    const updates = {};
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid fields to update' });
    }

    const lead = await leadsService.updateLead(req.params.id, updates);
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    await leadsService.logActivity(lead.id, 'lead_updated', `Lead fields updated: ${Object.keys(updates).join(', ')}`, updates);

    res.json({ success: true, lead });
  } catch (error) {
    console.error('[Leads] Error updating lead:', error.message);
    res.status(500).json({ success: false, message: 'Failed to update lead' });
  }
});

/**
 * POST /api/leads/:id/resend - Agent edits (or keeps) the AI response and resends it
 * Body: { response_text: string, original_text?: string }
 * Tracks whether the agent actually edited the text for analytics.
 */
router.post('/:id/resend', requireAuth, validateLeadId, async (req, res) => {
  try {
    const { response_text, original_text } = req.body;

    if (!response_text || !response_text.trim()) {
      return res.status(400).json({ success: false, message: 'response_text is required' });
    }

    const lead = await leadsService.getLeadById(req.params.id);
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const trimmedNew = response_text.trim();
    const trimmedOriginal = (original_text || '').trim();
    const wasEdited = trimmedOriginal.length > 0 && trimmedNew !== trimmedOriginal;

    // Save the response record (response_type = 'agent_resend')
    const response = await leadsService.saveLeadResponse(lead.id, {
      response_text: trimmedNew,
      response_type: 'agent_resend',
      channel: 'email',
      ai_model: null,
      ai_cost_usd: 0
    });

    // Send the email to the lead
    const emailResult = await leadsService.sendResponseToLead(lead, response);

    // Log activity with edit-tracking metadata
    await leadsService.logActivity(
      lead.id,
      'agent_resend',
      wasEdited
        ? `Agent edited and resent response (${Math.abs(trimmedNew.length - trimmedOriginal.length)} chars changed)`
        : 'Agent resent AI response (unchanged)',
      {
        was_edited: wasEdited,
        original_length: trimmedOriginal.length,
        new_length: trimmedNew.length,
        email_sent: emailResult.ok || false,
        email_provider: emailResult.provider || null,
      }
    );

    // Phase 3A — log response_edited signal if operator modified Hugo's response
    if (wasEdited) {
      try {
        await pool.query(
          `INSERT INTO hugo_subscriber_signals (operator_id, trade_category, signal_type, signal_data)
           VALUES ($1, $2, $3, $4)`,
          [
            req.userId,
            lead.lead_type || null,
            'response_edited',
            JSON.stringify({
              lead_id: lead.id,
              original_length: trimmedOriginal.length,
              new_length: trimmedNew.length,
              chars_changed: Math.abs(trimmedNew.length - trimmedOriginal.length),
            }),
          ]
        );
      } catch (sigErr) {
        console.warn('[Leads] Failed to log response_edited signal:', sigErr.message);
      }
    }

    res.json({
      success: true,
      response,
      email_sent: emailResult.ok || false,
      was_edited: wasEdited
    });
  } catch (error) {
    console.error('[Leads] Error resending response:', error.message);
    res.status(500).json({ success: false, message: 'Failed to resend response' });
  }
});

/**
 * POST /api/leads/:id/respond - Generate a new AI response for an existing lead
 */
router.post('/:id/respond', requireAuth, validateLeadId, async (req, res) => {
  try {
    const lead = await leadsService.getLeadById(req.params.id);
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const ai = await generateLeadResponse(lead);
    const response = await leadsService.saveLeadResponse(lead.id, {
      response_text: ai.responseText,
      response_type: 'follow_up',
      channel: req.body.channel || 'email',
      ai_model: ai.model,
      ai_cost_usd: ai.costUsd
    });

    // Actually send the follow-up email to the lead
    const emailResult = await leadsService.sendResponseToLead(lead, response);

    await leadsService.logActivity(lead.id, 'ai_follow_up_generated',
      emailResult.ok
        ? `Follow-up AI response generated and sent via ${emailResult.provider}`
        : `Follow-up AI response generated (email delivery failed: ${emailResult.reason || 'unknown'})`,
      {
        model: ai.model,
        cost_usd: ai.costUsd,
        email_sent: emailResult.ok || false,
        email_provider: emailResult.provider || null,
      }
    );

    res.json({ success: true, response, email_sent: emailResult.ok || false });
  } catch (error) {
    console.error('[Leads] Error generating response:', error.message);
    res.status(500).json({ success: false, message: 'Failed to generate response' });
  }
});

module.exports = router;
