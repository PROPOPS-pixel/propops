/**
 * Operator Data Service — fetches Hugo's "read every file in the cabinet" context.
 *
 * Owns: five parallel DB queries that build a full-picture summary of an operator's
 *       current reality — leads, email intake, simulations, training entries, profile.
 * Does NOT own: AI prompt assembly (hugo-brain.js), action dispatch (actions-engine.js).
 *
 * All 5 queries run in Promise.all — total budget < 500ms.
 * Results cached per operator for 5 minutes (invalidated on dashboard save via
 * clearOperatorDataCache(operatorId)).
 *
 * Table mapping:
 *   "Leads"           → leads (general) + operator_widget_leads (Hugo-captured)
 *   "Email Intake"    → raw_emails (Hipages, ServiceSeeking, Airtasker)
 *   "Simulations"     → jobs table (simulate inquiry outcomes)
 *   "Train Your Bot"  → hugo_training_data (operator-scoped custom instructions)
 *   "Operator Context"→ operator_profiles JOIN users (rates, trade, location)
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5,
});

// ─── Time-ago helper for lead age display ────────────────────────────────────
function timeSince(dateStr) {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

// ─── In-memory cache (operator_id → { data, fetchedAt }) ────────────────────
const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(operatorId) {
  const entry = _cache.get(operatorId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    _cache.delete(operatorId);
    return null;
  }
  return entry.data;
}

function setCache(operatorId, data) {
  _cache.set(operatorId, { data, fetchedAt: Date.now() });
}

/**
 * Invalidate cache for an operator. Call this after dashboard saves.
 */
function clearOperatorDataCache(operatorId) {
  _cache.delete(operatorId);
}

// ─── Query 1: Recent leads (last 20) ─────────────────────────────────────────
async function fetchLeads(operatorId) {
  try {
    // operator_widget_leads are Hugo-captured (scoped to operator)
    const widgetLeads = await pool.query(
      `SELECT lead_name, lead_phone, lead_email, job_type, job_location,
              intent_score, status, rough_quote, created_at
       FROM operator_widget_leads
       WHERE operator_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [operatorId]
    );

    // General leads table (platform-wide, filter by user_id if column exists)
    let generalLeads = [];
    try {
      const gl = await pool.query(
        `SELECT name, email, phone, lead_type, source, notes, status, created_at
         FROM leads
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [operatorId]
      );
      generalLeads = gl.rows;
    } catch {
      // leads table may not have user_id scoping — skip gracefully
    }

    return {
      widget_leads: widgetLeads.rows,
      general_leads: generalLeads,
      total: widgetLeads.rowCount + generalLeads.length,
    };
  } catch (err) {
    console.warn('[OperatorData] fetchLeads error (non-fatal):', err.message);
    return { widget_leads: [], general_leads: [], total: 0 };
  }
}

// ─── Query 2: Email intake (last 10 from Hipages, ServiceSeeking, Airtasker) ─
async function fetchEmailIntake(operatorId) {
  try {
    // raw_emails is not strictly per-operator in the legacy schema — fetch latest
    // system-wide intake as context (operators share one inbound address for now)
    const result = await pool.query(
      `SELECT from_address, subject, parsed_lead_id, source_portal, created_at
       FROM raw_emails
       ORDER BY created_at DESC
       LIMIT 10`
    );
    return { emails: result.rows, total: result.rowCount };
  } catch (err) {
    console.warn('[OperatorData] fetchEmailIntake error (non-fatal):', err.message);
    return { emails: [], total: 0 };
  }
}

// ─── Query 3: Recent simulations (last 10) ────────────────────────────────────
async function fetchSimulations(operatorId) {
  try {
    // jobs table holds simulate_inquiry outcomes
    const result = await pool.query(
      `SELECT source, status, notes, metadata, created_at
       FROM jobs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [operatorId]
    );
    return { simulations: result.rows, total: result.rowCount };
  } catch (err) {
    // jobs table might not exist or have different schema — non-fatal
    console.warn('[OperatorData] fetchSimulations error (non-fatal):', err.message);
    return { simulations: [], total: 0 };
  }
}

// ─── Query 4: Training entries (operator's custom instructions) ───────────────
async function fetchTrainingEntries(operatorId) {
  try {
    // hugo_training_data rows scoped to this operator (operator_id column added in migration 048)
    const result = await pool.query(
      `SELECT customer_message, ai_response, trade_category, scenario_type,
              urgency_level, confidence_score, created_at
       FROM hugo_training_data
       WHERE operator_id = $1
       ORDER BY created_at DESC
       LIMIT 15`,
      [operatorId]
    );
    return { entries: result.rows, total: result.rowCount };
  } catch (err) {
    // operator_id column might not exist yet — try without it
    try {
      const fallback = await pool.query(
        `SELECT customer_message, ai_response, business_type, conversation_type
         FROM hugo_training_data
         ORDER BY created_at DESC
         LIMIT 10`
      );
      return { entries: fallback.rows, total: fallback.rowCount, scoped: false };
    } catch {
      return { entries: [], total: 0 };
    }
  }
}

// ─── Query 5: Operator profile (full context) ─────────────────────────────────
async function fetchOperatorContext(operatorId) {
  try {
    const result = await pool.query(
      `SELECT
         op.trade_type, op.specialisations, op.service_area_suburb,
         op.service_radius_km, op.hourly_rate, op.callout_fee,
         op.emergency_available, op.emergency_surcharge,
         op.working_hours, op.after_hours_policy, op.excluded_jobs,
         op.business_name, op.operator_name, op.boss_first_name,
         op.top_services, op.no_go_jobs, op.min_job_size,
         op.free_quotes, op.lead_delivery, op.starting_prices,
         op.rates_json, op.tone_slider, op.business_customization,
         u.email, u.name AS user_name, u.mobile_number, u.metadata AS user_metadata
       FROM operator_profiles op
       JOIN users u ON u.id = op.operator_id
       WHERE op.operator_id = $1`,
      [operatorId]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.warn('[OperatorData] fetchOperatorContext error (non-fatal):', err.message);
    return null;
  }
}

// ─── Main: fetch all 5 sources in parallel ────────────────────────────────────
/**
 * Fetch the complete operator reality for Hugo.
 * All 5 queries run in parallel — budget < 500ms.
 *
 * @param {string} operatorId - UUID of the operator
 * @returns {Promise<{leads, emailIntake, simulations, trainingEntries, operatorContext}>}
 */
async function fetchOperatorReality(operatorId) {
  if (!operatorId) {
    return { leads: null, emailIntake: null, simulations: null, trainingEntries: null, operatorContext: null };
  }

  const cached = getCached(operatorId);
  if (cached) return cached;

  const [leads, emailIntake, simulations, trainingEntries, operatorContext] = await Promise.all([
    fetchLeads(operatorId),
    fetchEmailIntake(operatorId),
    fetchSimulations(operatorId),
    fetchTrainingEntries(operatorId),
    fetchOperatorContext(operatorId),
  ]);

  const data = { leads, emailIntake, simulations, trainingEntries, operatorContext };
  setCache(operatorId, data);
  return data;
}

// ─── Format operator reality as Layer 0 prompt injection ─────────────────────
/**
 * Converts operator reality into a concise system prompt segment.
 * Hugo reads this before every response — it's his "cabinet of files."
 */
function formatOperatorRealityPrompt(reality) {
  if (!reality || !reality.operatorContext) return '';

  const lines = [];
  const ctx = reality.operatorContext;

  // Identity
  const name = ctx.boss_first_name || ctx.operator_name || ctx.user_name || 'the operator';
  const trade = ctx.trade_type || 'general contractor';
  const biz = ctx.business_name ? `${ctx.business_name}` : null;
  lines.push(`OPERATOR: ${name}${biz ? ` (${biz})` : ''}, ${trade}`);

  // Location
  if (ctx.service_area_suburb) {
    lines.push(`AREA: ${ctx.service_area_suburb}${ctx.service_radius_km ? ` within ${ctx.service_radius_km}km` : ''}`);
  }

  // Pricing
  const pricingParts = [];
  if (ctx.hourly_rate) pricingParts.push(`$${ctx.hourly_rate}/hr`);
  if (ctx.callout_fee) pricingParts.push(`$${ctx.callout_fee} callout`);
  if (ctx.starting_prices && Array.isArray(ctx.starting_prices) && ctx.starting_prices.length > 0) {
    const sp = ctx.starting_prices.slice(0, 3).map(p => `${p.service}: from $${p.from_price}`).join(', ');
    pricingParts.push(sp);
  }
  if (pricingParts.length > 0) lines.push(`PRICING: ${pricingParts.join(' | ')}`);

  // Availability
  if (ctx.working_hours) lines.push(`HOURS: ${ctx.working_hours}`);
  if (ctx.after_hours_policy) lines.push(`AFTER-HOURS: ${ctx.after_hours_policy}`);
  if (ctx.emergency_available) lines.push(`EMERGENCY: yes${ctx.emergency_surcharge ? ` (surcharge: ${ctx.emergency_surcharge})` : ''}`);
  if (ctx.excluded_jobs) lines.push(`WILL NOT DO: ${ctx.excluded_jobs}`);
  if (ctx.no_go_jobs && Array.isArray(ctx.no_go_jobs) && ctx.no_go_jobs.length > 0) {
    lines.push(`NO-GO JOBS: ${ctx.no_go_jobs.join(', ')}`);
  }

  // Lead delivery preference
  if (ctx.lead_delivery) lines.push(`LEAD DELIVERY: ${ctx.lead_delivery}`);

  // Recent leads context — full detail so Hugo can read/describe any lead
  const widgetLeads = reality.leads?.widget_leads?.slice(0, 10) || [];
  const generalLeads = reality.leads?.general_leads?.slice(0, 5) || [];
  const allLeads = [...widgetLeads, ...generalLeads];
  const totalLeadCount = reality.leads?.total || 0;

  if (allLeads.length > 0) {
    lines.push('');
    lines.push(`YOUR LEADS (${totalLeadCount} total in pipeline):`);
    allLeads.forEach((l, i) => {
      const parts = [];
      parts.push(`${i + 1}. ${l.lead_name || l.name || 'Unknown'}`);
      if (l.lead_phone || l.phone) parts.push(`📞 ${l.lead_phone || l.phone}`);
      if (l.lead_email || l.email) parts.push(`✉️ ${l.lead_email || l.email}`);
      if (l.job_type || l.lead_type) parts.push(`Type: ${l.job_type || l.lead_type}`);
      if (l.job_location) parts.push(`Location: ${l.job_location}`);
      if (l.intent_score) parts.push(`Intent: ${l.intent_score}/10`);
      if (l.status) parts.push(`Status: ${l.status}`);
      if (l.rough_quote) parts.push(`Quote: $${l.rough_quote}`);
      if (l.source) parts.push(`Source: ${l.source}`);
      if (l.notes) parts.push(`Notes: ${l.notes}`);
      const age = l.created_at ? timeSince(l.created_at) : null;
      if (age) parts.push(`(${age} ago)`);
      lines.push(parts.join(' | '));
    });
  } else {
    lines.push('');
    lines.push('YOUR LEADS: No leads have come through yet. Once they start arriving, you\'ll see full details here.');
  }

  // Email intake (portal leads from Hipages, ServiceSeeking, etc.)
  const emails = reality.emailIntake?.emails?.slice(0, 5) || [];
  if (emails.length > 0) {
    lines.push('');
    lines.push(`RECENT EMAIL INTAKE (${reality.emailIntake?.total || emails.length} total):`);
    emails.forEach((e, i) => {
      const parts = [];
      parts.push(`${i + 1}. From: ${e.from_address || 'unknown'}`);
      if (e.subject) parts.push(`Subject: "${e.subject}"`);
      if (e.source_portal) parts.push(`Portal: ${e.source_portal}`);
      const age = e.created_at ? timeSince(e.created_at) : null;
      if (age) parts.push(`(${age} ago)`);
      lines.push(parts.join(' | '));
    });
  }

  // Custom training entries (highest authority)
  const customTraining = reality.trainingEntries?.entries?.filter(e => e.scenario_type === 'custom') || [];
  if (customTraining.length > 0) {
    const trainingNotes = customTraining.slice(0, 3).map(e => `"${e.customer_message?.slice(0, 100)}" → "${String(e.ai_response || '').slice(0, 100)}"`).join('\n');
    lines.push(`OPERATOR INSTRUCTIONS (HIGHEST AUTHORITY — always follow):\n${trainingNotes}`);
  }

  // business_customization custom_rules (from "Customize Your Hugo" panel)
  const bizCfgRaw = ctx.business_customization;
  const bizCfg = bizCfgRaw ? (typeof bizCfgRaw === 'string' ? JSON.parse(bizCfgRaw) : bizCfgRaw) : null;
  if (bizCfg?.custom_rules?.trim()) {
    lines.push(`CUSTOM RULES (ABSOLUTE — follow exactly, no exceptions):\n${bizCfg.custom_rules.trim()}`);
  }

  if (lines.length === 0) return '';

  return `LAYER 0 — OPERATOR REALITY (read before responding):
${lines.join('\n')}`;
}

module.exports = {
  fetchOperatorReality,
  formatOperatorRealityPrompt,
  clearOperatorDataCache,
};
