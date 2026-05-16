/**
 * Jobs routes — trade operator job pipeline.
 *
 * GET    /api/jobs              — list jobs with filters
 * GET    /api/jobs/stats        — pipeline metrics
 * POST   /api/jobs              — create job manually
 * POST   /api/jobs/simulate     — create simulated test job
 * GET    /api/jobs/:id          — job detail + activities
 * PATCH  /api/jobs/:id/status   — advance pipeline stage
 * PATCH  /api/jobs/:id          — update job fields
 * DELETE /api/jobs/simulated    — clear all test jobs
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./auth');
const { generateJobResponse } = require('../services/ai-responder');
const { notifyNewLead, sendNewLeadNotificationEmail } = require('../services/notifications');
// Hugo's REAL brain — wired for simulation responses (not fake previews)
const {
  callAI, assembleSystemPrompt, applyGuardrails, parseActionsFromReply,
  getEmbedding, searchTrainingData, getOperatorProfile, getLandingPagePricing,
  PRICING_CONSTANTS, APPROVED_PRICES, PRICE_CORRECTION_RE,
} = require('./hugo-brain');
const { fetchOperatorReality, formatOperatorRealityPrompt } = require('../services/operator-data');
const { searchKnowledge, lookupLeadMemory } = require('../services/hugo-learning');
const {
  SIMULATE_JOB_TYPES,
  TRADE_PORTALS,
  DEFAULT_PORTALS,
  TEST_NAMES,
  SUBURBS,
  normalizeBusinessType,
  generateTradeLead,
  validateLeadMatch,
  logMismatch,
} = require('../services/trade-simulation');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Valid pipeline stages for trades
const TRADE_STAGES = ['new', 'contacted', 'quoted', 'booked', 'in_progress', 'complete', 'paid'];
const RE_STAGES    = ['new', 'contacted', 'inspected', 'listed', 'sold'];

// Stage display labels
const STAGE_LABELS = {
  new: 'New', contacted: 'Contacted', quoted: 'Quoted', booked: 'Booked',
  in_progress: 'In Progress', complete: 'Complete', paid: 'Paid',
  inspected: 'Inspected', listed: 'Listed', sold: 'Sold',
};

// Valid stages for a given business type
function stagesFor(businessType) {
  return businessType === 'real_estate' ? RE_STAGES : TRADE_STAGES;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function logActivity(jobId, activityType, description, metadata = {}) {
  await pool.query(
    `INSERT INTO job_activities (job_id, activity_type, description, metadata)
     VALUES ($1, $2, $3, $4)`,
    [jobId, activityType, description, JSON.stringify(metadata)]
  );
}

// ─── GET /api/jobs/stats ──────────────────────────────────────────────────────

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const includeSimulated = req.query.include_simulated !== 'false';
    const simFilter = includeSimulated ? '' : 'AND (j.is_simulated IS NULL OR j.is_simulated = FALSE)';

    // This week boundaries (Monday–Sunday, local to server)
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay() + (weekStart.getDay() === 0 ? -6 : 1));
    weekStart.setHours(0, 0, 0, 0);

    // Month boundaries
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [pipeline, revenue, weekJobs, avgResp] = await Promise.all([
      // Count by status
      pool.query(
        `SELECT status, COUNT(*) AS count
         FROM jobs j
         WHERE j.agent_id = $1 ${simFilter}
         GROUP BY status`,
        [req.userId]
      ),
      // Revenue this month (paid jobs)
      pool.query(
        `SELECT COALESCE(SUM(invoice_amount), 0) AS total
         FROM jobs j
         WHERE j.agent_id = $1
           AND j.status = 'paid'
           AND j.paid_at >= $2 ${simFilter}`,
        [req.userId, monthStart.toISOString()]
      ),
      // Jobs this week (any active stage)
      pool.query(
        `SELECT COUNT(*) AS count
         FROM jobs j
         WHERE j.agent_id = $1
           AND j.created_at >= $2
           AND j.status NOT IN ('paid') ${simFilter}`,
        [req.userId, weekStart.toISOString()]
      ),
      // Avg response time (seconds from job created to first activity of type contacted)
      pool.query(
        `SELECT AVG(EXTRACT(EPOCH FROM (ja.created_at - j.created_at))) AS avg_secs
         FROM jobs j
         JOIN job_activities ja ON ja.job_id = j.id AND ja.activity_type = 'status_changed'
                                AND ja.description LIKE '%contacted%'
         WHERE j.agent_id = $1 ${simFilter}`,
        [req.userId]
      ),
    ]);

    // Build pipeline stage counts map
    const counts = {};
    for (const row of pipeline.rows) {
      counts[row.status] = parseInt(row.count, 10);
    }
    const total = Object.values(counts).reduce((s, n) => s + n, 0);

    res.json({
      success: true,
      stats: {
        pipeline: {
          total,
          ...counts,
          jobs_this_week: parseInt(weekJobs.rows[0]?.count || 0, 10),
          quotes_pending: counts.quoted || 0,
        },
        revenue: {
          this_month: parseFloat(revenue.rows[0]?.total || 0).toFixed(2),
        },
        responses: {
          avg_response_time_seconds: avgResp.rows[0]?.avg_secs ?? null,
        },
      },
    });
  } catch (err) {
    console.error('[Jobs] Stats error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load stats' });
  }
});

// ─── GET /api/jobs ─────────────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, search, limit = '100', include_simulated } = req.query;
    const showSimulated = include_simulated !== 'false';

    const params = [req.userId];
    const conditions = ['j.agent_id = $1'];

    if (status && status !== 'all') {
      params.push(status);
      conditions.push(`j.status = $${params.length}`);
    }
    if (!showSimulated) {
      conditions.push('(j.is_simulated IS NULL OR j.is_simulated = FALSE)');
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      const p = params.length;
      conditions.push(`(LOWER(j.customer_name) LIKE $${p} OR LOWER(j.suburb) LIKE $${p} OR LOWER(j.job_type) LIKE $${p})`);
    }

    params.push(parseInt(limit, 10) || 100);
    const limitIdx = params.length;

    const sql = `
      SELECT j.*
      FROM jobs j
      WHERE ${conditions.join(' AND ')}
      ORDER BY j.created_at DESC
      LIMIT $${limitIdx}
    `;

    const result = await pool.query(sql, params);
    res.json({ success: true, jobs: result.rows });
  } catch (err) {
    console.error('[Jobs] List error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load jobs' });
  }
});

// ─── POST /api/jobs ────────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      customer_name, customer_email, customer_phone, suburb,
      job_type, job_description, source = 'manual', notes,
      status = 'new', quote_amount, business_type,
    } = req.body;

    if (!customer_name) {
      return res.status(400).json({ success: false, message: 'Customer name is required' });
    }

    // Determine business_type from body or fall back to user's business_type
    const userResult = await pool.query('SELECT business_type FROM users WHERE id = $1', [req.userId]);
    const bt = business_type || userResult.rows[0]?.business_type || 'plumber';

    const result = await pool.query(
      `INSERT INTO jobs
         (agent_id, business_type, customer_name, customer_email, customer_phone,
          suburb, job_type, job_description, status, quote_amount, source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [req.userId, bt, customer_name, customer_email || null, customer_phone || null,
       suburb || null, job_type || null, job_description || null, status,
       quote_amount || null, source, notes || null]
    );

    const job = result.rows[0];
    await logActivity(job.id, 'job_created', `New job from ${source}`, { source });

    // Fire per-lead notification email to operator's dedicated Gmail — non-blocking
    pool.query(
      'SELECT notification_email, name FROM users WHERE id = $1',
      [req.userId]
    ).then(({ rows }) => {
      const { notification_email, name: agentName } = rows[0] || {};
      if (notification_email) {
        const leadLike = {
          name:              job.customer_name,
          lead_type:         job.job_type,
          phone:             job.customer_phone,
          email:             job.customer_email,
          property_interest: null,
        };
        sendNewLeadNotificationEmail(leadLike, null, 0, notification_email, agentName)
          .catch((err) => console.error('[Jobs] Notification email error:', err.message));
      }
    }).catch((err) => {
      console.warn('[Jobs] Failed to look up notification_email for job create:', err.message);
    });

    res.status(201).json({ success: true, job });
  } catch (err) {
    console.error('[Jobs] Create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create job' });
  }
});

// ─── POST /api/jobs/simulate ───────────────────────────────────────────────────
// Uses generateTradeLead() from trade-simulation service for trade-matched lead generation.

router.post('/simulate', requireAuth, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT business_type FROM users WHERE id = $1', [req.userId]);
    const rawBt = userResult.rows[0]?.business_type || 'plumber';
    const bt = normalizeBusinessType(rawBt);

    console.log(`[Jobs] Simulate: user=${req.userId}, raw_business_type='${rawBt}', normalized='${bt}'`);

    // Generate a trade-specific lead — job type and description are locked to this trade's pool
    const lead = generateTradeLead(bt);

    // ── Validation gate: belt-and-suspenders check before storing ────────────
    const validation = validateLeadMatch(bt, lead.jobType);
    if (!validation.valid) {
      logMismatch(bt, lead.jobType, validation.reason, lead.source);
      return res.status(400).json({
        success: false,
        message: 'Lead rejected: job type does not match trade pool',
        detail: validation.reason,
      });
    }
    console.log(`[Jobs] Simulating trade-matched lead: bt=${bt} (raw=${rawBt}), job_type='${lead.jobType}', source='${lead.source}'`);

    const result = await pool.query(
      `INSERT INTO jobs
         (agent_id, business_type, customer_name, customer_email, customer_phone,
          suburb, job_type, job_description, status, source, is_simulated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'new',$9,TRUE)
       RETURNING *`,
      [req.userId, bt, lead.customer.name, lead.customer.email, lead.customer.phone, lead.suburb, lead.jobType, lead.description, lead.source]
    );

    const job = result.rows[0];
    await logActivity(job.id, 'job_created', `Simulated inquiry received from ${lead.source}`, { source: lead.source, simulated: true, business_type: bt, job_type: lead.jobType });

    // ── REAL BRAIN CALL — wire simulation through Hugo's actual brain pipeline ──
    // Same Groq→OpenAI callAI path, same 4-layer prompt, same guardrails.
    // Response is returned inline so the operator sees Hugo's REAL answer immediately.
    const brainStart = Date.now();
    let hugoReply = '';
    let actionsTriggered = [];
    let brainModel = 'groq'; // default; callAI tries Groq first
    try {
      // Determine hostname/domain for correct persona + pricing context
      const hostname = bt === 'real_estate' ? 'propops.pro' : 'propops.trade';

      // Parallel lookups — same as the real brain endpoint
      const queryEmbedding = await getEmbedding(lead.description);
      const tradeSlug = bt === 'real_estate' ? 're_agent' : bt;

      const [operatorReality, trainingExamples, operatorProfile, pricing, knowledgeEntries] = await Promise.all([
        fetchOperatorReality(req.userId),
        searchTrainingData(queryEmbedding, bt, 10),
        getOperatorProfile(req.userId),
        getLandingPagePricing(hostname),
        searchKnowledge(queryEmbedding, { operatorId: req.userId, tradeSlug, limit: 6 }),
      ]);

      // Assemble full 4-layer system prompt
      const systemPrompt = assembleSystemPrompt({
        hostname, channel: 'widget', operatorProfile, trainingExamples, pricing, operatorReality,
        knowledgeEntries, returningLead: null, // simulated lead has no memory
      });

      // Build message array — lead.description is the "customer message"
      const aiMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: lead.description },
      ];

      // Call Hugo's REAL brain (Groq primary → OpenAI fallback)
      let rawReply = await callAI(aiMessages, 450);

      // Parse actions + apply guardrails (identical to /api/hugo/brain)
      const parsed = parseActionsFromReply(rawReply);
      hugoReply = applyGuardrails(parsed.cleanReply);
      actionsTriggered = parsed.actions.map(a => a.type);

      // Pricing guard
      const correctPrice = PRICING_CONSTANTS[hostname.includes('propops.pro') ? 'propops.pro' : 'propops.trade'].display;
      hugoReply = hugoReply.replace(PRICE_CORRECTION_RE, (match, digits) => {
        const num = parseInt(digits, 10);
        if (APPROVED_PRICES.includes(num) || num > 500) return match;
        return correctPrice;
      });

      console.log(`[Jobs] Hugo REAL brain response for sim job ${job.id}: ${hugoReply.length} chars, ${actionsTriggered.length} actions`);
    } catch (brainErr) {
      console.error(`[Jobs] Hugo brain call failed for sim job ${job.id}:`, brainErr.message);
      hugoReply = '(Hugo brain unavailable — simulation created but no AI response generated)';
    }

    const responseTimeMs = Date.now() - brainStart;

    // ── Store AI response on the job record ───────────────────────────────
    pool.query(
      `UPDATE jobs SET ai_response = $1, ai_response_model = 'hugo_brain', ai_response_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [hugoReply, job.id]
    ).catch(err => console.error(`[Jobs] Failed to store brain response for job ${job.id}:`, err.message));

    // ── Log to hugo_sim_outcomes with is_simulation tag for nightly batch eval ──
    pool.query(
      `INSERT INTO hugo_sim_outcomes
         (operator_id, trade_category, simulation_type, inquiry_message, hugo_response_text,
          lead_status_progression, final_status, response_time_ms, channel, eval_status)
       VALUES ($1, $2, 'simulate_inquiry', $3, $4, $5, 'New', $6, 'widget', 'pending')`,
      [req.userId, bt, lead.description, hugoReply, ['New'], responseTimeMs]
    ).catch(err => console.warn('[Jobs] Failed to log sim outcome:', err.message));

    // ── Store as Hugo training data (is_simulation = TRUE) ─────────────────
    pool.query(
      `INSERT INTO hugo_training_data
         (agent_id, business_type, conversation_type, customer_message, ai_response, job_id, is_simulation)
       VALUES ($1, $2, 'inbound_inquiry', $3, $4, $5, TRUE)
       ON CONFLICT DO NOTHING`,
      [req.userId, bt, lead.description, hugoReply, job.id]
    ).catch(err => console.warn('[Jobs] Failed to store training data:', err.message));

    await logActivity(job.id, 'hugo_brain_response', `Hugo real brain responded (${responseTimeMs}ms)`, {
      response_chars: hugoReply.length,
      actions: actionsTriggered,
      is_simulation: true,
      response_time_ms: responseTimeMs,
    });

    // ── Fire per-lead notification email to operator's dedicated Gmail ─────────
    // Reads notification_email from users settings — only fires if set.
    // Non-blocking; never throws into main response path.
    pool.query(
      'SELECT notification_email, name FROM users WHERE id = $1',
      [req.userId]
    ).then(({ rows }) => {
      const { notification_email, name: agentName } = rows[0] || {};
      if (notification_email) {
        // Map job fields to the shape sendNewLeadNotificationEmail expects
        const leadLike = {
          name:              job.customer_name,
          lead_type:         job.job_type,
          phone:             job.customer_phone,
          email:             job.customer_email,
          property_interest: null, // not applicable for trade jobs
        };
        sendNewLeadNotificationEmail(
          leadLike,
          hugoReply ? { content: hugoReply } : null,
          responseTimeMs / 1000,
          notification_email,
          agentName
        ).catch((err) => {
          console.error('[Jobs] Notification email error:', err.message);
        });
      }
    }).catch((err) => {
      console.warn('[Jobs] Failed to look up notification_email for simulate:', err.message);
    });

    // Return job + Hugo's real response to the operator
    res.status(201).json({
      success: true,
      job,
      hugo_response: hugoReply,
      actions_triggered: actionsTriggered,
      response_time_ms: responseTimeMs,
    });
  } catch (err) {
    console.error('[Jobs] Simulate error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to simulate job' });
  }
});

// ─── GET /api/jobs/:id ────────────────────────────────────────────────────────

router.get('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid job ID' });

  try {
    const jobResult = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND agent_id = $2',
      [id, req.userId]
    );
    if (!jobResult.rows[0]) return res.status(404).json({ success: false, message: 'Job not found' });

    const activitiesResult = await pool.query(
      'SELECT * FROM job_activities WHERE job_id = $1 ORDER BY created_at ASC',
      [id]
    );

    res.json({ success: true, job: jobResult.rows[0], activities: activitiesResult.rows });
  } catch (err) {
    console.error('[Jobs] Detail error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load job' });
  }
});

// ─── PATCH /api/jobs/:id/status ───────────────────────────────────────────────

router.patch('/:id/status', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid job ID' });

  const { status } = req.body;
  if (!status) return res.status(400).json({ success: false, message: 'Status is required' });

  const allStages = [...TRADE_STAGES, ...RE_STAGES];
  if (!allStages.includes(status)) {
    return res.status(400).json({ success: false, message: `Invalid status: ${status}` });
  }

  try {
    // Build timestamp updates for terminal stages
    const extras = [];
    if (status === 'complete') {
      extras.push(`completed_at = COALESCE(completed_at, NOW())`);
    }
    if (status === 'paid') {
      extras.push(`paid_at = COALESCE(paid_at, NOW())`);
    }

    const extraSql = extras.length ? `, ${extras.join(', ')}` : '';

    const result = await pool.query(
      `UPDATE jobs SET status = $1, updated_at = NOW() ${extraSql}
       WHERE id = $2 AND agent_id = $3 RETURNING *`,
      [status, id, req.userId]
    );

    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Job not found' });

    const label = STAGE_LABELS[status] || status;
    await logActivity(id, 'status_changed', `Moved to ${label}`, { from: result.rows[0]?.status, to: status });

    res.json({ success: true, job: result.rows[0] });
  } catch (err) {
    console.error('[Jobs] Status update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

// ─── PATCH /api/jobs/:id ──────────────────────────────────────────────────────

router.patch('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid job ID' });

  const {
    customer_name, customer_email, customer_phone, suburb,
    job_type, job_description, quote_amount, invoice_amount, notes, source,
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE jobs SET
         customer_name    = COALESCE($1, customer_name),
         customer_email   = COALESCE($2, customer_email),
         customer_phone   = COALESCE($3, customer_phone),
         suburb           = COALESCE($4, suburb),
         job_type         = COALESCE($5, job_type),
         job_description  = COALESCE($6, job_description),
         quote_amount     = COALESCE($7::DECIMAL, quote_amount),
         invoice_amount   = COALESCE($8::DECIMAL, invoice_amount),
         notes            = COALESCE($9, notes),
         source           = COALESCE($10, source),
         updated_at       = NOW()
       WHERE id = $11 AND agent_id = $12
       RETURNING *`,
      [
        customer_name || null, customer_email || null, customer_phone || null,
        suburb || null, job_type || null, job_description || null,
        quote_amount != null ? quote_amount : null,
        invoice_amount != null ? invoice_amount : null,
        notes || null, source || null,
        id, req.userId,
      ]
    );

    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Job not found' });

    await logActivity(id, 'job_updated', 'Job details updated');
    res.json({ success: true, job: result.rows[0] });
  } catch (err) {
    console.error('[Jobs] Update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update job' });
  }
});

// ─── DELETE /api/jobs/simulated ───────────────────────────────────────────────

router.delete('/simulated', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM jobs WHERE agent_id = $1 AND is_simulated = TRUE RETURNING id`,
      [req.userId]
    );
    res.json({ success: true, deleted_count: result.rows.length });
  } catch (err) {
    console.error('[Jobs] Clear simulated error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to clear test jobs' });
  }
});

module.exports = router;