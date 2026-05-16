/**
 * Hugo chat routes.
 *
 * GET  /api/hugo/status                — onboarding status + profile summary
 * GET  /api/hugo/chat                  — recent message history
 * POST /api/hugo/chat                  — send a message, get Hugo's reply
 * POST /api/hugo/start                 — start onboarding (first open)
 * POST /api/hugo/training              — bulk import training entries (JSON array)
 * GET  /api/hugo/training              — list training entries with filters
 * POST /api/hugo/simulate              — run simulation scenarios for testing
 * GET  /api/hugo/learned-context       — return active learned knowledge for a trade+region
 * GET  /api/hugo/business-config       — load business_customization JSON for current operator
 * POST /api/hugo/business-config       — save business_customization JSON for current operator
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./auth');
const hugo = require('../services/hugo');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── GET /api/hugo/status ─────────────────────────────────────────────────────

router.get('/status', requireAuth, async (req, res) => {
  try {
    const status = await hugo.getStatus(req.userId);
    res.json({ success: true, ...status });
  } catch (err) {
    console.error('[Hugo] GET /status error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get Hugo status' });
  }
});

// ─── GET /api/hugo/chat ───────────────────────────────────────────────────────

router.get('/chat', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const messages = await hugo.getRecentMessages(req.userId, limit);
    res.json({ success: true, messages });
  } catch (err) {
    console.error('[Hugo] GET /chat error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load chat history' });
  }
});

// ─── POST /api/hugo/start ─────────────────────────────────────────────────────
// Called when operator opens the chat for the first time.
// Sends Hugo's first message if not already started.

router.post('/start', requireAuth, async (req, res) => {
  try {
    const { tradeSlug } = req.body || {};
    const result = await hugo.startOnboarding(req.userId, tradeSlug || null);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Hugo] POST /start error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to start Hugo' });
  }
});

// ─── POST /api/hugo/chat ──────────────────────────────────────────────────────
// Send operator message → get Hugo's reply.

router.post('/chat', requireAuth, async (req, res) => {
  const { message, tradeSlug } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ success: false, message: 'message is required' });
  }

  if (message.trim().length === 0) {
    return res.status(400).json({ success: false, message: 'message cannot be empty' });
  }

  if (message.length > 2000) {
    return res.status(400).json({ success: false, message: 'message too long (max 2000 chars)' });
  }

  try {
    // Prefer the trade slug sent by the dashboard (reflects the active pool the
    // operator is currently viewing) over the static business_type stored on the
    // users row — this is the fix for Hugo defaulting to RE Agent on trade dashboards.
    let businessType;
    if (tradeSlug && typeof tradeSlug === 'string' && tradeSlug.trim().length > 0) {
      businessType = tradeSlug.trim();
    } else {
      // Fallback: look up the user's stored business_type from the DB
      const { Pool } = require('pg');
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
      });
      const userRow = await pool.query(`SELECT business_type FROM users WHERE id = $1`, [req.userId]);
      businessType = userRow.rows[0]?.business_type || 'trades';
      pool.end().catch(() => {});
    }

    const result = await hugo.processMessage(req.userId, message.trim(), businessType);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Hugo] POST /chat error:', err.message);
    res.status(500).json({ success: false, message: 'Hugo had a hiccup — try again in a moment' });
  }
});

// ─── POST /api/hugo/training — Bulk import training data ─────────────────────
// Accepts JSON array of training entries. Each entry:
// { trade_category, scenario_type, customer_message, hugo_response,
//   urgency_level, tags, suburb, cross_referral_to }
// Deduplicates on (trade_category + customer_message) to prevent re-imports.

router.post('/training', requireAuth, async (req, res) => {
  const { entries } = req.body || {};

  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ success: false, message: 'entries[] required (array of training objects)' });
  }

  if (entries.length > 1000) {
    return res.status(400).json({ success: false, message: 'Max 1000 entries per import batch' });
  }

  const VALID_SCENARIO_TYPES = ['inquiry', 'objection', 'qualification', 'cross_referral', 'after_hours', 'emergency', 'simulation'];
  const VALID_URGENCY_LEVELS = ['emergency', 'standard', 'low', null];

  let imported = 0;
  let skipped = 0;
  let errors = [];

  for (const entry of entries) {
    try {
      const {
        trade_category,
        scenario_type,
        customer_message,
        hugo_response,
        urgency_level = null,
        tags = [],
        suburb = null,
        cross_referral_to = null,
      } = entry;

      // Validate required fields
      if (!trade_category || !scenario_type || !customer_message || !hugo_response) {
        skipped++;
        continue;
      }

      if (!VALID_SCENARIO_TYPES.includes(scenario_type)) {
        skipped++;
        continue;
      }

      // Upsert: skip if exact (trade_category, customer_message) combo exists
      const existing = await pool.query(
        `SELECT id FROM hugo_training_data
         WHERE business_type = $1 AND customer_message = $2`,
        [trade_category, customer_message]
      );

      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }

      const insertResult = await pool.query(
        `INSERT INTO hugo_training_data
         (agent_id, business_type, conversation_type, customer_message, ai_response, is_simulation, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING id`,
        [
          req.userId,
          trade_category,
          scenario_type,
          customer_message,
          JSON.stringify({
            hugo_response,
            urgency_level,
            tags: Array.isArray(tags) ? tags : [],
            suburb,
            cross_referral_to,
          }),
          false,
        ]
      );
      imported++;

      // Auto-generate embedding for vector search (non-blocking — never fails the import)
      const newId = insertResult.rows[0]?.id;
      if (newId) {
        const embedText = `${customer_message} ${hugo_response}`.slice(0, 4000);
        setImmediate(async () => {
          try {
            const { getEmbedding } = require('./hugo-brain');
            const embedding = await getEmbedding(embedText);
            if (embedding) {
              const embeddingStr = `[${embedding.join(',')}]`;
              await pool.query(
                `UPDATE hugo_training_data SET embedding = $1::vector WHERE id = $2`,
                [embeddingStr, newId]
              );
            }
          } catch (e) { /* non-blocking — vector may not be installed yet */ }
        });
      }

      // Phase 2: dual-write to hugo_knowledge_entries as a 'trained' entry (highest authority)
      // Non-blocking — never fails the main import
      setImmediate(async () => {
        try {
          const { writeTrainedKnowledge } = require('../services/hugo-learning');
          await writeTrainedKnowledge(req.userId, customer_message, hugo_response, trade_category);
        } catch (e) { /* non-fatal — Train Your Bot still works if knowledge table not migrated yet */ }
      });
    } catch (err) {
      errors.push({ entry: entry.customer_message?.slice(0, 50), error: err.message });
      if (errors.length > 10) break; // Stop if too many errors
    }
  }

  console.log(`[Hugo Training] Import complete: ${imported} imported, ${skipped} skipped, ${errors.length} errors`);
  res.json({
    success: true,
    imported,
    skipped,
    total: entries.length,
    errors: errors.slice(0, 5),
  });
});

// ─── GET /api/hugo/training — List training entries ──────────────────────────
// Query params: ?trade_category=Plumber&scenario_type=inquiry&limit=50&offset=0

router.get('/training', requireAuth, async (req, res) => {
  try {
    const { trade_category, scenario_type, limit = '50', offset = '0' } = req.query;
    const params = [];
    let where = '';
    let idx = 1;

    if (trade_category) {
      where += ` AND business_type = $${idx++}`;
      params.push(trade_category);
    }
    if (scenario_type) {
      where += ` AND conversation_type = $${idx++}`;
      params.push(scenario_type);
    }

    params.push(Math.min(parseInt(limit, 10) || 50, 200));
    params.push(parseInt(offset, 10) || 0);

    const result = await pool.query(
      `SELECT id, business_type as trade_category, conversation_type as scenario_type,
              customer_message, ai_response, is_simulation, created_at
       FROM hugo_training_data
       WHERE 1=1 ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM hugo_training_data WHERE 1=1 ${where}`,
      params.slice(0, params.length - 2)
    );

    res.json({
      success: true,
      entries: result.rows,
      total: parseInt(countResult.rows[0].total, 10),
    });
  } catch (err) {
    console.error('[Hugo Training] GET error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load training data' });
  }
});

// ─── POST /api/hugo/simulate — Run simulation scenarios ─────────────────────
// Simulates the 7 core scenarios for testing/demo purposes.
// Body: { scenario: "email_intake" | "pwa_install" | "lead_dispatch" | "phone_intake" | "simulate_inquiry" | "re_agent" | "22_trades", input?: {} }

const SIMULATION_SCENARIOS = {
  email_intake: {
    description: 'Email Intake (Hipages/ServiceSeeking/Airtasker forwarding)',
    samples: [
      { source: 'Hipages', message: "Hi, I need a plumber ASAP. Water leaking from ceiling. Address: 45 Cambridge St, Concord. Phone: 0412 345 678.", expected_trade: 'Plumber', urgency: 'emergency' },
      { source: 'ServiceSeeking', message: "Looking for painters to quote on a 3-bedroom house exterior in Randwick. Owner, not rental.", expected_trade: 'Painter', urgency: 'standard' },
      { source: 'Airtasker', message: "Flat needs bond clean. 2 bed, 1 bath. Moving out Friday.", expected_trade: 'Cleaner', urgency: 'standard' },
      { source: 'Generic', message: "How much for a handyman to fix a broken door handle?", expected_trade: 'Handyman', urgency: 'low' },
    ],
  },
  pwa_install: {
    description: 'PWA Install Flow',
    samples: [
      { message: "How do I get the app?", hugo_response: "You can install PropOps straight to your phone — just head to propops.trade/app and hit 'Add to Home Screen'. Takes about 5 seconds. Heads up: on iPhone, the mic works better in the browser tab than the PWA — just a Safari thing." },
      { message: "Is there an app?", hugo_response: "Yeah! It's a one-click install at propops.trade/app. Works on Android and iPhone. Want me to send you the link?" },
    ],
  },
  lead_dispatch: {
    description: 'Lead Dispatch & Routing',
    samples: [
      { trade: 'Painter', suburb: 'Parramatta', action: 'Route to painter operator with proximity match' },
      { trade: 'Unknown', suburb: 'CBD', action: 'Route to handyman as catch-all' },
      { trade: 'All', trigger: 'Property sold', action: 'RE agent → ALL 22 TRADES for buyer needs' },
    ],
  },
  phone_intake: {
    description: 'Phone Intake (Twilio → Hugo → Dashboard)',
    flow: [
      '1. Caller dials +61 2 5301 0002',
      '2. Twilio answers → Hugo greets via Google.en-AU-Neural2-B',
      '3. Caller speaks → Twilio STT (en-AU) → SpeechResult POSTed to /webhook/phone',
      '4. Hugo processes → qualifies → books job',
      '5. Lead card created in dashboard with contact + job details',
      '6. Operator notified via email + SMS (if per-lead alerts enabled)',
    ],
  },
  simulate_inquiry: {
    description: 'Simulate Inquiry (Dashboard Test Tool)',
    samples: [
      { channel: 'phone', message: "I need a sparky in Penrith" },
      { channel: 'email', message: "Looking for a plumber to fix a burst pipe in Concord" },
      { channel: 'widget', message: "Need a quote for painting 3 rooms in Randwick" },
    ],
  },
  re_agent: {
    description: 'RE Agent Persona (propops.pro specific)',
    samples: [
      { type: 'inspection', message: "I'd like to inspect 42 Ocean Parade, Cronulla", hugo_response: "Great choice — let me get you booked in for an inspection. Are you available this Saturday arvo, or would a weekday work better?" },
      { type: 'buyer_qualification', message: "I'm looking to buy my first home near Parramatta", hugo_response: "First home — exciting! Have you had a chat with the bank yet about pre-approval? That's usually the first step." },
      { type: 'human_handoff', message: "I need to speak to the agent NOW — this is urgent", hugo_response: "Absolutely, let me put you through to the agent right away." },
    ],
  },
  '22_trades': {
    description: '22 Trade Categories Knowledge Base',
    trades: [
      'Real Estate Agent', 'Plumber', 'Electrician', 'HVAC',
      'Builder', 'Bricklayer', 'Concreter', 'Renderer',
      'Plasterer', 'Painter', 'Fencer', 'Gardener/Landscaper',
      'Roofer', 'Tiler', 'Waterproofer', 'Pest Control',
      'Pool Cleaning', 'Lawn Care', 'Carpet Cleaning',
      'Cleaner (Bond/Regular/Commercial)', 'Commercial Cleaning', 'Handyman',
    ],
    test_questions: [
      { q: "Do you cover plumbing?", expected: "Yeah mate, we've got that covered." },
      { q: "What's a sparky?", expected: "That's an electrician — we cover all 22 trades." },
      { q: "What's the cheapest trade?", expected: "All trades are on the same $69/month plan." },
      { q: "Do you do roof painting?", expected: "Route to roofer + painter" },
    ],
  },
};

router.post('/simulate', requireAuth, async (req, res) => {
  const { scenario, input = {} } = req.body || {};

  if (!scenario) {
    return res.json({
      success: true,
      available_scenarios: Object.keys(SIMULATION_SCENARIOS).map(key => ({
        id: key,
        description: SIMULATION_SCENARIOS[key].description,
      })),
    });
  }

  const scenarioData = SIMULATION_SCENARIOS[scenario];
  if (!scenarioData) {
    return res.status(400).json({
      success: false,
      message: `Unknown scenario: ${scenario}`,
      available: Object.keys(SIMULATION_SCENARIOS),
    });
  }

  const simStart = Date.now();

  // Log simulation run to legacy training table (existing behaviour — preserved)
  try {
    await pool.query(
      `INSERT INTO hugo_training_data
       (agent_id, business_type, conversation_type, customer_message, ai_response, is_simulation, created_at)
       VALUES ($1, $2, $3, $4, $5, true, NOW())`,
      [
        req.userId,
        'simulation',
        scenario,
        JSON.stringify(input),
        JSON.stringify({ scenario: scenarioData }),
      ]
    );
  } catch (err) {
    // Non-blocking — simulation still returns data
    console.warn('[Hugo Simulate] Failed to log training data:', err.message);
  }

  // Phase 3A — also log to hugo_sim_outcomes for learning engine
  try {
    const responseTimeMs = Date.now() - simStart;
    // Derive trade from input.trade or the scenario's first sample expected_trade
    const trade = input.trade
      || (scenarioData.samples && scenarioData.samples[0]?.expected_trade)
      || null;

    await pool.query(
      `INSERT INTO hugo_sim_outcomes
         (operator_id, trade_category, simulation_type, hugo_response_text, lead_status_progression, final_status, response_time_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.userId,
        trade ? trade.toLowerCase() : null,
        scenario,
        JSON.stringify(scenarioData),
        ['New'],
        'New',
        responseTimeMs,
      ]
    );
  } catch (err) {
    // Non-blocking — never break the simulation on logging failure
    console.warn('[Hugo Simulate] Failed to log sim outcome:', err.message);
  }

  return res.json({
    success: true,
    scenario,
    description: scenarioData.description,
    data: scenarioData,
    timestamp: new Date().toISOString(),
  });
});

// ─── GET /api/hugo/learned-context ───────────────────────────────────────────
// Returns active learned knowledge for a given trade + region combination.
// Used by Hugo's prompt builder to supplement static knowledge with real data.
//
// Query params:
//   trade  — e.g. 'plumber', 'sparky', 're_agent'  (required)
//   region — e.g. 'sydney', 'melbourne'             (optional — falls back to NULL/global)
//
// Privacy rules enforced here:
//   - Only returns rows with confidence_score >= 0.5 (3+ data points)
//   - Never exposes individual operator rates — only aggregated data_payload
//
// Returns empty array when no learned data exists (correct initial state).

router.get('/learned-context', requireAuth, async (req, res) => {
  const { trade, region } = req.query;

  if (!trade || typeof trade !== 'string' || !trade.trim()) {
    return res.status(400).json({
      success: false,
      message: 'trade query param is required (e.g. ?trade=plumber)',
    });
  }

  try {
    const result = await pool.query(
      `SELECT knowledge_type, data_payload, confidence_score, sample_size, source, last_updated
       FROM hugo_learned_knowledge
       WHERE trade_category = $1
         AND (region = $2 OR region IS NULL)
         AND is_active = true
         AND confidence_score >= 0.5
       ORDER BY confidence_score DESC`,
      [trade.trim().toLowerCase(), region ? region.trim().toLowerCase() : null]
    );

    return res.json({
      success: true,
      trade: trade.trim().toLowerCase(),
      region: region ? region.trim().toLowerCase() : null,
      count: result.rows.length,
      knowledge: result.rows,
    });
  } catch (err) {
    console.error('[Hugo] GET /learned-context error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch learned context' });
  }
});

// ─── GET /api/hugo/operator-context/:operatorId ───────────────────────────────
// Returns the full operator profile for Hugo to use in system prompts.
// The :operatorId param is the user's ID. requireAuth ensures callers can only
// fetch their own context (unless admin — but we don't expose this publicly).
//
// Also callable as GET /api/hugo/operator-context (no param — uses req.userId).

router.get('/operator-context/:operatorId?', requireAuth, async (req, res) => {
  // Allow fetching own profile only (param must match authenticated user)
  const operatorId = req.params.operatorId
    ? parseInt(req.params.operatorId, 10)
    : req.userId;

  if (isNaN(operatorId) || operatorId !== req.userId) {
    // Only allow fetching your own profile
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }

  try {
    const result = await pool.query(
      `SELECT
         id, operator_id,
         trade_type, specialisations, service_area_suburb,
         service_radius_km, service_area_lat, service_area_lng,
         pricing_structure, callout_fee, free_quotes,
         emergency_available, emergency_surcharge,
         preferred_tone, tone_slider,
         business_name, operator_name, boss_first_name,
         working_hours, after_hours_logic, after_hours_policy,
         excluded_jobs, no_go_jobs, min_job_size,
         top_services, starting_prices,
         social_proof, payment_methods,
         lead_delivery,
         train_hugo_phase1_done, train_hugo_phase1_at,
         train_hugo_phase2_done, train_hugo_phase2_at,
         business_customization,
         onboarding_step, onboarding_completed_at,
         created_at, updated_at
       FROM operator_profiles
       WHERE operator_id = $1`,
      [operatorId]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, profile: null });
    }

    return res.json({ success: true, profile: result.rows[0] });
  } catch (err) {
    console.error('[Hugo] GET /operator-context error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch operator context' });
  }
});

// ─── POST /api/hugo/operator-profile ─────────────────────────────────────────
// Save Phase 1 or Phase 2 questionnaire data.
// Upserts into operator_profiles; caller passes a `phase` (1 or 2) and
// a flat object of profile fields.
//
// Phase 1 fields (all optional, wizard saves what it has):
//   business_name, boss_first_name, operator_name,
//   trade_type, service_area_suburb, service_radius_km,
//   service_area_lat, service_area_lng,
//   top_services (array), no_go_jobs (array), min_job_size,
//   callout_fee, free_quotes, lead_delivery
//
// Phase 2 fields:
//   after_hours_logic, social_proof, payment_methods (array),
//   tone_slider, starting_prices (array)
//
// Returns the updated profile row.

const PHASE1_FIELDS = [
  'business_name', 'boss_first_name', 'operator_name',
  'trade_type', 'service_area_suburb', 'service_radius_km',
  'service_area_lat', 'service_area_lng',
  'top_services', 'no_go_jobs', 'min_job_size',
  'callout_fee', 'free_quotes', 'lead_delivery',
];

const PHASE2_FIELDS = [
  'after_hours_logic', 'social_proof', 'payment_methods',
  'tone_slider', 'starting_prices',
];

const JSONB_FIELDS = new Set(['top_services', 'no_go_jobs', 'payment_methods', 'starting_prices']);

router.post('/operator-profile', requireAuth, async (req, res) => {
  const { phase, ...fields } = req.body || {};

  if (![1, 2].includes(Number(phase))) {
    return res.status(400).json({ success: false, message: 'phase must be 1 or 2' });
  }

  const allowedFields = Number(phase) === 1 ? PHASE1_FIELDS : PHASE2_FIELDS;

  // Build the SET clause dynamically — only allowed fields present in body
  const updates = {};
  for (const key of allowedFields) {
    if (key in fields) {
      updates[key] = fields[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ success: false, message: 'No valid fields provided' });
  }

  // Mark phase completion
  const phaseFlag = Number(phase) === 1 ? 'train_hugo_phase1_done' : 'train_hugo_phase2_done';
  const phaseAt   = Number(phase) === 1 ? 'train_hugo_phase1_at'   : 'train_hugo_phase2_at';
  if (fields.complete === true) {
    updates[phaseFlag] = true;
    updates[phaseAt]   = new Date().toISOString();
  }

  updates['updated_at'] = new Date().toISOString();

  // Ensure JSONB columns are stringified
  for (const key of Object.keys(updates)) {
    if (JSONB_FIELDS.has(key) && typeof updates[key] !== 'string') {
      updates[key] = JSON.stringify(updates[key]);
    }
  }

  try {
    // Upsert
    const cols = Object.keys(updates);
    const vals = Object.values(updates);
    const setClauses = cols.map((col, i) => `${col} = $${i + 2}`).join(', ');

    const result = await pool.query(
      `INSERT INTO operator_profiles (operator_id, ${cols.join(', ')})
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (operator_id) DO UPDATE SET ${setClauses}
       RETURNING *`,
      [req.userId, ...vals]
    );

    return res.json({ success: true, profile: result.rows[0] });
  } catch (err) {
    console.error('[Hugo] POST /operator-profile error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to save operator profile' });
  }
});

// ─── GET /api/hugo/business-config ───────────────────────────────────────────
// Returns the business_customization JSONB blob for the authenticated operator.
// Returns {} if no profile exists yet (no 404 — caller renders empty form).

router.get('/business-config', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT business_customization FROM operator_profiles WHERE operator_id = $1`,
      [req.userId]
    );
    const config = result.rows[0]?.business_customization || {};
    return res.json({ success: true, config });
  } catch (err) {
    console.error('[Hugo] GET /business-config error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load business config' });
  }
});

// ─── POST /api/hugo/business-config ──────────────────────────────────────────
// Saves the business_customization JSONB blob for the authenticated operator.
// Full-replace semantics — caller sends the complete object.
//
// Allowed keys (all optional strings/arrays):
//   Pricing:      hourly_rate, packages, quote_ranges
//   Business:     abn, service_area_detail, hours_detail, after_hours_detail
//   Specialties:  certs, licenses, specialties_detail
//   Terms:        payment_terms, deposit_policy, terms_summary
//   Custom rules: custom_rules (highest authority, injected verbatim into Hugo)

const BUSINESS_CONFIG_ALLOWED_KEYS = new Set([
  'hourly_rate', 'packages', 'quote_ranges',
  'abn', 'service_area_detail', 'hours_detail', 'after_hours_detail',
  'certs', 'licenses', 'specialties_detail',
  'payment_terms', 'deposit_policy', 'terms_summary',
  'custom_rules',
]);

router.post('/business-config', requireAuth, async (req, res) => {
  const incoming = req.body || {};

  // Strip unknown keys
  const config = {};
  for (const key of Object.keys(incoming)) {
    if (BUSINESS_CONFIG_ALLOWED_KEYS.has(key)) {
      config[key] = incoming[key];
    }
  }

  try {
    await pool.query(
      `INSERT INTO operator_profiles (operator_id, business_customization, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (operator_id) DO UPDATE
         SET business_customization = $2::jsonb,
             updated_at = NOW()`,
      [req.userId, JSON.stringify(config)]
    );

    // Invalidate operator data cache so Hugo picks up new config immediately
    const { clearOperatorDataCache } = require('../services/operator-data');
    if (clearOperatorDataCache) clearOperatorDataCache(req.userId);

    return res.json({ success: true, config });
  } catch (err) {
    console.error('[Hugo] POST /business-config error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to save business config' });
  }
});

module.exports = router;
