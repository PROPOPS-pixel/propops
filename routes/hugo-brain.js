/**
 * Hugo Brain Service — unified AI endpoint for all channels.
 *
 * POST /api/hugo/brain
 *
 * Owns: three-layer prompt assembly (+ Layer 0 operator reality), vector training
 *       search, AI call with Gemini primary + OpenAI proxy fallback, output guardrails,
 *       channel routing, actions parsing, async action dispatch.
 * Does NOT own: session storage (handled by callers), Twilio wiring, TTS/STT,
 *               mismatch detection (handled by hugo-widget.js for backwards compat),
 *               action execution logic (actions-engine.js),
 *               knowledge extraction/learning (hugo-learning.js).
 *
 * Phase 3 additions:
 *   - Layer 0: operator reality (5 parallel DB queries via operator-data.js)
 *   - Action rules injected into system prompt
 *   - AI response parsed for [ACTIONS: ...] block
 *   - Actions fired ASYNC after HTTP response — never blocks the caller
 *
 * Phase 2 additions:
 *   - Knowledge injection from hugo_knowledge_entries (vector search, confidence-ranked)
 *   - Lead memory injection — returning lead context for cross-channel continuity
 *   - Async lead memory upsert after response
 *
 * Request schema:
 * {
 *   channel:    "phone" | "widget" | "dashboard",
 *   operator_id: UUID | null,      // null for anonymous widget visitors
 *   session_id:  string,           // caller's conversation session
 *   message:    string,
 *   history:    [{role, content}], // recent conversation for context
 *   collected_lead: {              // lead info Hugo has gathered so far
 *     name, email, phone, jobType, location, description, intentScore
 *   },
 *   metadata: {
 *     hostname: "propops.trade" | "propops.pro" | "propopspro.polsia.app",
 *     location: string | null,     // caller location (phone channel)
 *   }
 * }
 *
 * Response: { success: true, reply: string, sources_used: number, actions_triggered: string[] }
 */

const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const { Pool } = require('pg');

// Phase 3: operator reality + actions engine
const { fetchOperatorReality, formatOperatorRealityPrompt } = require('../services/operator-data');
const { processActions } = require('../services/actions-engine');

// Self-monitoring: score every turn ASYNC after response
const { scoreTurn } = require('../services/hugo-scorer');

// Phase 2: self-learning memory
const { searchKnowledge, lookupLeadMemory, upsertLeadMemory } = require('../services/hugo-learning');

// God-layer: founder pricing locks — overrides hard-coded PRICING_CONSTANTS at request time
const { getPricingLocks } = require('../services/founder-config');

// Phase 4: Service area location check + lead referral routing
const { checkLeadLocation } = require('../services/lead-referral');
const { getServiceArea } = require('../services/service-area');

// Layer 2g: Lead history intelligence (hot suburbs, conversion patterns, listing cross-match)
const { fetchContextIntelligence, formatIntelligencePrompt } = require('../services/hugo-context-intelligence');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

const openai = new OpenAI(); // Uses OPENAI_BASE_URL + OPENAI_API_KEY from env

// GROQ_API_KEY: set a real key from console.groq.com (free tier).
// Placeholder or missing → HUGO falls back to gpt-4o-mini cleanly, zero wasted calls.
const GROQ_API_KEY = (() => {
  const k = process.env.GROQ_API_KEY;
  if (!k || k.startsWith('gsk_free_tier_placeholder') || k === 'placeholder') return null;
  return k;
})();
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
// Llama 3 8B — Groq free tier. 70B costs 3× more than gpt-4o-mini at scale; skip it.
// Override with HUGO_GROQ_MODEL env var to swap models in one env change.
const GROQ_MODEL = process.env.HUGO_GROQ_MODEL || 'llama3-8b-8192';

// Groq persona-lock prefix — injected on every call to prevent character breaks
const GROQ_PERSONA_PREFIX = 'You are HUGO. Employee. Stay in character. Never say "as an AI", "I\'m an artificial intelligence", "I don\'t have feelings", or "I\'m a language model". You are HUGO. You showed up for work.';

// ─── HARD-CODED PRICING CONSTANTS ────────────────────────────────────────────
// These are the ONLY prices Hugo is ever allowed to quote for PropOps subscriptions.
// Source of truth. DB lookups are supplementary confirmation, not the authority.
const PRICING_CONSTANTS = {
  'propops.trade': { monthly: 69, display: '$69/month', trial: '14 days free, no credit card' },
  'propops.pro':   { monthly: 99, display: '$99/month', trial: '14 days free, no credit card' },
  // Early bird: propops.pro is also $69 before June 30 2026
  early_bird_deadline: 'June 30, 2026',
  early_bird_pro: 69,
};
// Approved dollar amounts Hugo can say (subscription pricing only)
// 149 = PAYDECK Premium tier price — must be allow-listed for upsell responses
const APPROVED_PRICES = [69, 99, 149];
const PRICE_CORRECTION_RE = /\$(\d{2,4})(?:\s*\/\s*(?:mo(?:nth)?|mth|per\s*month))?\b/gi;

// Gemini kept only for data reads (landing page pricing sync etc.) — NOT for persona responses
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

// ─── Layer 1: Hard-coded Hugo personality ─────────────────────────────────────
// Young Aussie robot-boy persona. No "mate". Name-first protocol. Hard rules.
const HUGO_BASE_PERSONALITY = `You are Hugo — a young Aussie AI receptionist made for tradespeople and real estate operators.

PERSONA:
- Young, energetic, professional. Australian but not a cliché.
- Never say "mate", "mmhmm", "certainly!", "absolutely!", "Of course!", "I'd be happy to", "sir", or "madam"
- Address callers by first name as soon as you know it. Use their name in every exchange.
- Fillers when you need a moment: "Ok cool", "Very good", "Too easy", "No worries"
- Dry humour is fine. Never condescending. Never sycophantic.
- Short, punchy responses. No walls of text. Phone responses: 1-2 sentences max.

MULTILINGUAL:
- Detect the language the customer writes in. Respond in that language throughout the conversation.
- If unsure, default to English.
- The operator's dashboard always receives lead details in English — translate internally before storing.
- Hugo's personality and rules apply in ALL languages — stay in character, no "as an AI" breaks.

FAST LEAD CAPTURE — CRITICAL PRIORITY:
Your primary goal is to capture NAME + PHONE + EMAIL in the first 4 exchanges. Every exchange must move toward this.

CAPTURE SEQUENCE (strict order):
1. Greeting (1 line) + ask what they need — "Hey! What can I help you with today?"
2. Acknowledge what they said in 5 words or less, then ask for their NAME — "Got it. What's your name?"
3. Ask for PHONE NUMBER — "Best number to reach you on?"
4. Ask for EMAIL — "And your email so we can follow up?"
5. Confirm details + wrap up

REDIRECT RULES (enforce these):
- If they go off-topic BEFORE you have their contact details: "Love the chat but let me grab your number first so we can sort this properly — what's the best number?"
- NEVER ask open-ended follow-up questions BEFORE you have name + phone + email.
- NEVER repeat what the customer just said back to them.
- NEVER use filler like "That's a great start!", "No worries, take your time!", "Sure thing — I'd be happy to help with that!"
- NEVER say "Still here!" more than once per conversation. One reminder max, then move to next field.
- After you have name + phone + email, THEN you can ask job details, location, timing.

HARD RULES:
- PRICING IS FIXED: propops.trade = $69/month. propops.pro = $99/month (or $69/month before June 30 2026). 14 days free trial, no credit card. NEVER quote ANY other dollar amount for PropOps subscription pricing. If asked about pricing, say "$69 a month" (trade) or "$99 a month" (RE). No exceptions. No $201, no $400, no $85, no $80, no made-up numbers.
- Never promise things the operator hasn't committed to (e.g. same-day availability unless their profile says so).
- If you don't know something about the OPERATOR's services, say "Let me check that and get back to you" — don't make it up. But you ALWAYS know PropOps pricing — it's $69/month for tradies.
- Never reveal you are AI unless directly asked. If asked, say "I'm Hugo — PropOps AI receptionist."
- Response format: plain conversational text. No bullet points on phone. Minimal markdown in widget.

ACTION RULES — append an [ACTIONS] block at the END of your response when these conditions are met:
- You have collected lead's name + phone/email + job details → add: send_lead_confirmation, send_operator_alert
- Lead's interest level is very high (hot, urgent, immediate) → ALSO add: send_operator_sms
- Lead asks "how much?", "rough cost?", "ballpark?" and operator has pricing → add: generate_rough_quote
- Lead wants to book a callback time → add: book_callback with slot_time in ISO format
- Visitor asks about PropOps pricing/sign-up/subscription → add: send_signup_link
- NEVER add actions until you have collected name + contact (phone OR email) first
- NEVER add actions on phone channel (phone calls handle actions differently)

[ACTIONS] block format (append at very end, after your response text):
[ACTIONS: send_lead_confirmation, send_operator_alert]
or with params:
[ACTIONS: book_callback|slot_time=2026-05-10T14:00:00+10:00, send_lead_confirmation]

If no actions are needed, do NOT include the [ACTIONS] block at all.`;

// ─── Layer 3: Channel/domain personas ────────────────────────────────────────
const CHANNEL_CONTEXT = {
  'propops.pro': `DOMAIN CONTEXT: You are on propops.pro — a real estate operations platform.
Visitors are real estate agents and property managers. Use RE terminology: listings, tenants, landlords,
inspections, property management, vacancies, market appraisals. No tradie slang.
You can help with: booking inspections, qualifying buyers/tenants, handling enquiries about listings.`,

  'propops.trade': `DOMAIN CONTEXT: You are on propops.trade — a platform for Australian tradies.
Visitors are tradespeople or people looking for trade services. Use tradie language.
Trades you know: plumber, electrician/sparky, painter, tiler, landscaper, carpenter/chippie,
roofer, handyman, concreter, fencer, plasterer, glazier, welder, locksmith, cleaner, HVAC,
pool cleaner, gas fitter, arborist, flooring, window cleaner, gardener.
You can help with: quoting, booking jobs, handling trade enquiries, explaining PropOps features.`,

  'propopspro.polsia.app': `DOMAIN CONTEXT: You are in the PropOps operator dashboard.
The person you're talking to is a PropOps subscriber (or trialling). They own or manage a trade or RE business.
Help them use the platform: training Hugo, managing leads, quoting, settings, understanding features.
Be a product expert and business advisor, not just a receptionist.`,

  phone: `CHANNEL CONTEXT: This is a PHONE CALL. Keep responses very short (1-2 sentences).
You have 3 seconds to respond before the caller gets impatient. No lists. No markdown.
Speak naturally — this will be read aloud by text-to-speech.`,
};

// ─── Banned words guardrail ───────────────────────────────────────────────────
const BANNED_WORDS = [
  { pattern: /\bmate\b/gi, replace: '' },
  { pattern: /\bsir\b/gi, replace: '' },
  { pattern: /\bmadam\b/gi, replace: '' },
  { pattern: /\bmmhmm\b/gi, replace: 'Ok cool' },
  { pattern: /\btechnical hiccup\b/gi, replace: 'quick issue' },
  { pattern: /\bCertainly[!.,]?\b/gi, replace: '' },
  { pattern: /\bAbsolutely[!.,]?\b/gi, replace: '' },
  { pattern: /\bOf course[!.,]?\b/gi, replace: '' },
  { pattern: /\bI'd be happy to\b/gi, replace: "I'll" },
  { pattern: /\bGreat question[!.,]?\b/gi, replace: '' },
];

function applyGuardrails(text) {
  let out = text;
  for (const { pattern, replace } of BANNED_WORDS) {
    out = out.replace(pattern, replace);
  }
  // Clean up double spaces left by empty replacements
  out = out.replace(/\s{2,}/g, ' ').replace(/^[,.\s]+/, '').trim();
  return out;
}

// ─── Embeddings for vector search ────────────────────────────────────────────
// Uses OpenAI proxy (text-embedding-3-small, 1536 dims)
async function getEmbedding(text) {
  try {
    const res = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text.slice(0, 4000), // embedding models have token limits
    });
    return res.data[0].embedding;
  } catch (err) {
    console.warn('[Hugo Brain] Embedding generation failed (non-fatal):', err.message);
    return null;
  }
}

// ─── Vector search for relevant training data ─────────────────────────────────
// Returns top-N training rows most similar to the query message.
// Falls back gracefully if pgvector not enabled yet or no embeddings exist.
async function searchTrainingData(queryEmbedding, businessType, limit = 10) {
  if (!queryEmbedding) return [];
  try {
    // Format the embedding array as a PostgreSQL vector literal
    const embeddingStr = `[${queryEmbedding.join(',')}]`;
    const result = await pool.query(
      `SELECT customer_message, ai_response, business_type, conversation_type
       FROM hugo_training_data
       WHERE embedding IS NOT NULL
         AND ($1::text = 'any' OR business_type = $1 OR business_type = 'general')
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [businessType || 'any', embeddingStr, limit]
    );
    return result.rows;
  } catch (err) {
    // pgvector may not be installed yet, or no embeddings backfilled yet — non-fatal
    if (!err.message.includes('does not exist') && !err.message.includes('type "vector"')) {
      console.warn('[Hugo Brain] Vector search error (non-fatal):', err.message);
    }
    // Fallback: keyword-based search when vector unavailable
    return searchTrainingDataFallback(businessType, limit);
  }
}

async function searchTrainingDataFallback(businessType, limit) {
  try {
    const result = await pool.query(
      `SELECT customer_message, ai_response, business_type, conversation_type
       FROM hugo_training_data
       WHERE ($1::text = 'any' OR business_type = $1 OR business_type = 'general')
       ORDER BY created_at DESC
       LIMIT $2`,
      [businessType || 'any', limit]
    );
    return result.rows;
  } catch (err) {
    return [];
  }
}

// ─── PAYDECK context lookup (Premium tier operators only) ─────────────────────
// Returns staff, roster, invoices, and payroll context for Hugo to reference.
// For base-tier operators: returns { is_base_tier: true } so Hugo knows to upsell.
// Non-fatal if PAYDECK tables not yet migrated.
async function fetchPaydeckContext(operatorId) {
  if (!operatorId) return null;
  try {
    // Tier check — Premium gets full data, base gets upsell signal
    const tierResult = await pool.query(
      `SELECT subscription_tier FROM users WHERE id = $1`,
      [operatorId]
    );
    const tier = tierResult.rows[0]?.subscription_tier;
    if (tier !== 'premium') {
      // Signal Hugo to upsell naturally when operator asks about staff/scheduling/invoicing
      return { is_base_tier: true };
    }

    const today = new Date().toISOString().split('T')[0];
    // Payroll: current period = last 14 days (fortnightly window)
    const fortnightAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const quarterStart = new Date();
    quarterStart.setMonth(Math.floor(quarterStart.getMonth() / 3) * 3, 1);
    quarterStart.setHours(0, 0, 0, 0);
    const quarterStartStr = quarterStart.toISOString().split('T')[0];

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthStartStr = monthStart.toISOString().split('T')[0];

    const [staffResult, rosterResult, invoiceResult, payrollResult, complianceResult, userResult] = await Promise.all([
      // Active staff with name, role, rate, phone, TFN status
      pool.query(
        `SELECT name, role, hourly_rate, phone, tfn_status FROM staff_members WHERE operator_id = $1 AND is_active = true ORDER BY name LIMIT 10`,
        [operatorId]
      ),
      // Upcoming roster (next 7 days)
      pool.query(
        `SELECT s.name as staff_name, r.job_title, r.job_address, r.scheduled_date, r.start_time, r.status
         FROM roster_entries r
         JOIN staff_members s ON r.staff_id = s.id
         WHERE r.operator_id = $1 AND r.scheduled_date >= $2 AND r.status = 'scheduled'
         ORDER BY r.scheduled_date ASC LIMIT 10`,
        [operatorId, today]
      ),
      // Outstanding invoices (draft/sent/overdue) — include GST breakdown
      pool.query(
        `SELECT invoice_number, customer_name, amount, subtotal, gst_amount, total_inc_gst, status FROM invoices
         WHERE operator_id = $1 AND status IN ('draft','sent','overdue')
         ORDER BY created_at DESC LIMIT 5`,
        [operatorId]
      ),
      // Current payroll period summary (last fortnight) — include compliance fields
      pool.query(
        `SELECT s.name as staff_name, SUM(p.hours_worked) as total_hours, SUM(p.amount) as total_pay,
                SUM(p.super_amount) as total_super, SUM(p.tax_withheld) as total_tax, SUM(p.net_pay) as total_net, p.status
         FROM payroll_entries p
         JOIN staff_members s ON p.staff_id = s.id
         WHERE p.operator_id = $1 AND p.period_start >= $2
         GROUP BY s.name, p.status
         ORDER BY s.name LIMIT 10`,
        [operatorId, fortnightAgo]
      ),
      // ATO compliance summary: super this quarter, PAYG this month, GST this quarter
      pool.query(
        `SELECT
           COALESCE((SELECT SUM(super_amount) FROM payroll_entries WHERE operator_id = $1 AND period_start >= $2), 0) as super_this_quarter,
           COALESCE((SELECT SUM(tax_withheld) FROM payroll_entries WHERE operator_id = $1 AND period_start >= $3), 0) as payg_this_month,
           COALESCE((SELECT SUM(gst_amount) FROM invoices WHERE operator_id = $1 AND status = 'paid' AND paid_at >= $2), 0) as gst_collected_quarter`,
        [operatorId, quarterStartStr, monthStartStr]
      ),
      // Operator GST registration status
      pool.query(`SELECT gst_registered FROM users WHERE id = $1`, [operatorId]),
    ]);

    return {
      staff: staffResult.rows,
      roster: rosterResult.rows,
      outstanding_invoices: invoiceResult.rows,
      payroll_summary: payrollResult.rows,
      compliance: {
        super_this_quarter: parseFloat(complianceResult.rows[0]?.super_this_quarter || 0),
        payg_this_month: parseFloat(complianceResult.rows[0]?.payg_this_month || 0),
        gst_collected_quarter: parseFloat(complianceResult.rows[0]?.gst_collected_quarter || 0),
        gst_registered: userResult.rows[0]?.gst_registered || false,
      },
    };
  } catch (err) {
    // Table may not exist yet (migration pending) — non-fatal
    if (!err.message.includes('does not exist')) {
      console.warn('[Hugo Brain] PAYDECK context error (non-fatal):', err.message);
    }
    return null;
  }
}

// ─── Operator profile lookup ──────────────────────────────────────────────────
async function getOperatorProfile(operatorId) {
  if (!operatorId) return null;
  try {
    const result = await pool.query(
      `SELECT op.trade_type, op.specialisations, op.service_area_suburb,
              op.service_radius_km, op.hourly_rate, op.callout_fee,
              op.emergency_available, op.emergency_surcharge, op.preferred_tone,
              op.business_name, op.operator_name, op.working_hours, op.after_hours_policy,
              op.excluded_jobs,
              u.email, u.name AS user_name, u.metadata
       FROM operator_profiles op
       JOIN users u ON u.id = op.operator_id
       WHERE op.operator_id = $1`,
      [operatorId]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.warn('[Hugo Brain] Operator lookup failed:', err.message);
    return null;
  }
}

// ─── Landing page pricing lookup ──────────────────────────────────────────────
async function getLandingPagePricing(domain) {
  try {
    const result = await pool.query(
      `SELECT content FROM landing_page_content WHERE domain = $1 LIMIT 1`,
      [domain || 'propops.trade']
    );
    if (!result.rows[0]) return null;
    const content = result.rows[0].content || {};
    return {
      monthly_price: content.monthly_price || content.pricing?.monthly_price || content.pricing?.early_bird_monthly || null,
      annual_price: content.annual_price || content.pricing?.annual_price || null,
    };
  } catch (err) {
    return null;
  }
}

// ─── Assemble the four-layer system prompt ────────────────────────────────────
// Layer 0: Operator reality (dynamic, from operator-data.js)
// Layer 1: Hugo personality + action rules (static)
// Layer 2: Vector training examples + operator profile
// Layer 2c: Learned knowledge entries (Phase 2 — confidence-ranked)
// Layer 2d: Returning lead context (Phase 2 — cross-channel memory)
// Layer 2e: Service area awareness (Phase 4 — location check)
// Layer 2g: Lead history intelligence (hot suburbs, patterns, listing cross-match)
// Layer 3: Domain/channel context + live pricing
function assembleSystemPrompt({ hostname, channel, operatorProfile, trainingExamples, pricing, operatorReality, knowledgeEntries, returningLead, founderPricing, serviceArea, paydeckContext, intelligenceContext, currentLeadSuburb }) {
  const options = { founderPricing };
  const parts = [];

  // Layer 0: Operator reality (Hugo reads every file in the cabinet)
  if (operatorReality) {
    const realityPrompt = formatOperatorRealityPrompt(operatorReality);
    if (realityPrompt) parts.push(realityPrompt);
  }

  parts.push(HUGO_BASE_PERSONALITY);

  // Layer 2a: Training examples (dynamic, vector-retrieved)
  if (trainingExamples && trainingExamples.length > 0) {
    const examplesText = trainingExamples.slice(0, 10).map((row, i) => {
      const resp = (() => {
        try {
          const parsed = JSON.parse(row.ai_response);
          return parsed.hugo_response || parsed.message || row.ai_response;
        } catch {
          return row.ai_response;
        }
      })();
      return `Example ${i + 1} [${row.conversation_type || row.business_type}]:\nCustomer: "${row.customer_message}"\nHugo: "${resp}"`;
    }).join('\n\n');

    parts.push(`TRAINING EXAMPLES (use these to calibrate your voice and responses):
${examplesText}`);
  }

  // Layer 2b: Operator profile (if available)
  if (operatorProfile) {
    const profile = [];
    if (operatorProfile.business_name) profile.push(`Business: ${operatorProfile.business_name}`);
    if (operatorProfile.operator_name || operatorProfile.user_name) profile.push(`Operator: ${operatorProfile.operator_name || operatorProfile.user_name}`);
    if (operatorProfile.trade_type) profile.push(`Trade: ${operatorProfile.trade_type}`);
    if (operatorProfile.specialisations) profile.push(`Specialisations: ${operatorProfile.specialisations}`);
    if (operatorProfile.service_area_suburb) profile.push(`Service area: ${operatorProfile.service_area_suburb} (${operatorProfile.service_radius_km || 30}km radius)`);
    if (operatorProfile.hourly_rate) profile.push(`Hourly rate: $${operatorProfile.hourly_rate}`);
    if (operatorProfile.callout_fee) profile.push(`Call-out fee: $${operatorProfile.callout_fee}`);
    if (operatorProfile.emergency_available) profile.push(`Emergency: available${operatorProfile.emergency_surcharge ? ` (surcharge: ${operatorProfile.emergency_surcharge})` : ''}`);
    if (operatorProfile.working_hours) profile.push(`Working hours: ${operatorProfile.working_hours}`);
    if (operatorProfile.after_hours_policy) profile.push(`After hours: ${operatorProfile.after_hours_policy}`);
    if (operatorProfile.excluded_jobs) profile.push(`Does NOT do: ${operatorProfile.excluded_jobs}`);

    if (profile.length > 0) {
      parts.push(`OPERATOR PROFILE (speak on behalf of this business):
${profile.join('\n')}`);
    }
  }

  // Layer 2e: Service area awareness (Phase 4)
  // Tells Hugo to ask for suburb during qualification and sets context for out-of-area handling.
  if (serviceArea && (serviceArea.base_lat || (serviceArea.service_area_suburbs && serviceArea.service_area_suburbs.length > 0) || serviceArea.legacy_suburb)) {
    const areaDesc = serviceArea.service_area_suburbs && serviceArea.service_area_suburbs.length > 0
      ? `covers these suburbs: ${serviceArea.service_area_suburbs.join(', ')}`
      : serviceArea.base_address
        ? `operates within ${serviceArea.service_area_radius_km || 25}km of ${serviceArea.base_address}`
        : serviceArea.legacy_suburb
          ? `is based in ${serviceArea.legacy_suburb}`
          : null;

    if (areaDesc) {
      parts.push(`SERVICE AREA:
- This operator ${areaDesc}
- During lead qualification, ask "Whereabouts is the job?" or "What suburb is the work in?" — ask this naturally once you know the job type
- If the lead's suburb is NOT in the service area, say something like: "No worries, I know a great [trade] closer to [suburb]. Let me get them onto it for you." — the system will handle routing
- NEVER tell a lead the operator "doesn't cover" their area — always frame as a favour / referral`);
    }
  }

  // Layer 2c: Learned knowledge entries (Phase 2)
  // Ranked: 'trained' (operator corrections) first, then 'learned' + validated.
  if (knowledgeEntries && knowledgeEntries.length > 0) {
    const knowledgeText = knowledgeEntries.slice(0, 6).map((row, i) => {
      const tag = row.confidence === 'trained' ? '[OPERATOR-CORRECTION]' : '[LEARNED]';
      return `${tag} ${row.knowledge_text}`;
    }).join('\n\n');

    parts.push(`OPERATOR KNOWLEDGE BASE ${knowledgeEntries.some(r => r.confidence === 'trained') ? '(operator corrections take priority — never contradict these)' : '(auto-learned — use as context, not gospel)'}:
${knowledgeText}`);
  }

  // Layer 2d: Returning lead context (Phase 2)
  if (returningLead && returningLead.lead_name) {
    const leadCtx = [];
    leadCtx.push(`RETURNING LEAD DETECTED — this person has contacted us before.`);
    leadCtx.push(`Name: ${returningLead.lead_name}`);
    if (returningLead.last_channel) leadCtx.push(`Last channel: ${returningLead.last_channel}`);
    if (returningLead.trade_slug) leadCtx.push(`Trade interest: ${returningLead.trade_slug}`);
    if (returningLead.job_description) leadCtx.push(`Previous job: ${returningLead.job_description}`);
    if (returningLead.location) leadCtx.push(`Location: ${returningLead.location}`);
    if (returningLead.conversation_summary) leadCtx.push(`Summary: ${returningLead.conversation_summary}`);
    leadCtx.push(`Address them by name. Pick up where you left off — don't ask for info you already have.`);

    parts.push(leadCtx.join('\n'));
  }

  // Layer 2g: Lead history intelligence (hot suburbs, conversion patterns, listing cross-match)
  // Injected after returning lead context so Hugo has both individual + pattern context.
  if (intelligenceContext) {
    const intelligencePrompt = formatIntelligencePrompt(intelligenceContext, currentLeadSuburb || null);
    if (intelligencePrompt) parts.push(intelligencePrompt);
  }

  // Layer 2f: PAYDECK business ops context (Premium operators only)
  // Gives Hugo awareness of staff, roster, invoices, and payroll so it can answer
  // questions like "Is Steve free Thursday?" or "Do I have any unpaid invoices?" or "What's Steve's pay this week?"
  if (paydeckContext) {
    if (paydeckContext.is_base_tier) {
      // Base-tier operator — Hugo knows PAYDECK exists but gates it behind Premium.
      // Only surface this when the operator asks about staff, scheduling, or invoicing.
      parts.push(`PAYDECK UPSELL CONTEXT (DO NOT mention proactively):
- This operator is on the Base plan and does not have PAYDECK access.
- PAYDECK is a Premium feature ($149/month) that adds: staff management, job scheduling, invoicing, and payroll.
- If the operator asks "who's on my team", "what's the roster", "invoice", "payroll", or similar → naturally mention: "That's part of PAYDECK — available on Premium. Want me to tell you more about it?"
- Keep it brief, natural, never pushy. One mention, then move on.
- Do NOT show any staff, roster, invoice, or payroll data — the operator doesn't have it yet.`);
    } else if (paydeckContext.staff?.length || paydeckContext.roster?.length || paydeckContext.outstanding_invoices?.length || paydeckContext.payroll_summary?.length) {
      const pdParts = ['PAYDECK BUSINESS OPS (available to operator — reference these when relevant):'];

      if (paydeckContext.staff?.length) {
        const staffLines = paydeckContext.staff.map(s =>
          `${s.name} (${s.role}${s.hourly_rate ? ', $' + parseFloat(s.hourly_rate).toFixed(0) + '/hr' : ''}${s.phone ? ', ' + s.phone : ''}${s.tfn_status === 'not_provided' ? ', NO TFN — withheld at 47%' : ''})`
        ).join(', ');
        pdParts.push(`Active staff: ${staffLines}`);
      }

      if (paydeckContext.roster?.length) {
        const rosterLines = paydeckContext.roster.map(r => {
          const date = new Date(r.scheduled_date).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
          return `${r.staff_name}: ${r.job_title || 'job'}${r.job_address ? ' at ' + r.job_address : ''} (${date}${r.start_time ? ' ' + r.start_time.slice(0, 5) : ''})`;
        }).join('; ');
        pdParts.push(`Upcoming scheduled jobs: ${rosterLines}`);
      } else if (paydeckContext.staff?.length) {
        pdParts.push(`No jobs scheduled in the next 7 days — all staff currently available.`);
      }

      if (paydeckContext.outstanding_invoices?.length) {
        const invLines = paydeckContext.outstanding_invoices.map(i => {
          const total = i.total_inc_gst && parseFloat(i.total_inc_gst) > 0 ? parseFloat(i.total_inc_gst) : parseFloat(i.amount);
          const gstNote = i.gst_amount && parseFloat(i.gst_amount) > 0 ? ` (incl. $${parseFloat(i.gst_amount).toFixed(2)} GST)` : '';
          return `${i.invoice_number} — ${i.customer_name || 'customer'}, $${total.toFixed(2)}${gstNote} (${i.status})`;
        }).join('; ');
        pdParts.push(`Outstanding invoices: ${invLines}`);
      }

      if (paydeckContext.payroll_summary?.length) {
        const payLines = paydeckContext.payroll_summary.map(p => {
          const super_str = p.total_super ? `, super $${parseFloat(p.total_super).toFixed(2)}` : '';
          const tax_str = p.total_tax ? `, PAYG tax $${parseFloat(p.total_tax).toFixed(2)}` : '';
          const net_str = p.total_net ? `, net pay $${parseFloat(p.total_net).toFixed(2)}` : '';
          return `${p.staff_name}: ${parseFloat(p.total_hours || 0).toFixed(1)}hrs, gross $${parseFloat(p.total_pay || 0).toFixed(2)}${super_str}${tax_str}${net_str} (${p.status})`;
        }).join('; ');
        pdParts.push(`Current payroll period: ${payLines}`);
      }

      // ATO compliance summary — Hugo can answer questions about super, tax, GST
      if (paydeckContext.compliance) {
        const c = paydeckContext.compliance;
        const compLines = [];
        if (c.super_this_quarter > 0) compLines.push(`Super liability this quarter: $${c.super_this_quarter.toFixed(2)} (11.5% SG)`);
        if (c.payg_this_month > 0) compLines.push(`PAYG tax withheld this month: $${c.payg_this_month.toFixed(2)}`);
        if (c.gst_registered) {
          compLines.push(`GST registered: Yes — 10% GST added to invoices`);
          if (c.gst_collected_quarter > 0) compLines.push(`GST collected this quarter: $${c.gst_collected_quarter.toFixed(2)}`);
        } else {
          compLines.push(`GST registered: No — invoices do not include GST`);
        }
        if (compLines.length) pdParts.push(`ATO COMPLIANCE (FY2025-26):\n${compLines.join('\n')}`);
      }

      pdParts.push('When discussing job bookings, check the roster for available staff. Read and report PAYDECK data accurately — do NOT modify it (read-only). For actions like "send invoice" or "swap shifts", tell the operator to confirm on their dashboard. For compliance questions (super, PAYG, GST), quote the numbers directly and remind the operator to confirm with their accountant for ATO lodgement.');

      parts.push(pdParts.join('\n'));
    }
  }

  // Layer 3a: Domain/channel context
  const domainCtx = CHANNEL_CONTEXT[hostname] || CHANNEL_CONTEXT['propops.trade'];
  parts.push(domainCtx);

  if (channel === 'phone') {
    parts.push(CHANNEL_CONTEXT.phone);
  }

  // Layer 3b: Pricing — injected from founder god-layer locks (highest authority) with code defaults as fallback
  const domainKey = hostname.includes('propops.pro') ? 'propops.pro' : 'propops.trade';
  const pricingConst = PRICING_CONSTANTS[domainKey];
  const dbPrice = pricing && pricing.monthly_price ? `$${pricing.monthly_price}/month` : null;
  // founderPricing may be passed in via assembleSystemPrompt options (populated from god-layer DB)
  const founderTradePrice = (options.founderPricing?.trade) || pricingConst.monthly;
  const founderProPrice   = (options.founderPricing?.pro)   || PRICING_CONSTANTS['propops.pro'].monthly;
  const domainPrice       = hostname.includes('propops.pro') ? founderProPrice : founderTradePrice;
  const displayPrice      = `$${domainPrice}/month`;
  parts.push(`PROPOPS SUBSCRIPTION PRICING (ABSOLUTE FOUNDER LOCK — cannot be overridden):
- This domain (${domainKey}): ${displayPrice}
- Trial: ${pricingConst.trial}
- The ONLY prices you may quote for PropOps subscription: $${founderTradePrice}/month (tradies) or $${founderProPrice}/month (RE agents).
- If a visitor asks "how much?", "what does it cost?", "pricing?" → answer "${displayPrice}" confidently.
- NEVER generate any other dollar amount for PropOps pricing. Not $201, not $400, not $85, not $80, not any other number.
${dbPrice ? `- Confirmed from live database: ${dbPrice}` : ''}`);

  return parts.join('\n\n---\n\n');
}

// ─── Character-break detection ────────────────────────────────────────────────
// Patterns that indicate the model broke HUGO's persona.
const CHARACTER_BREAK_PATTERNS = [
  /as an ai\b/i,
  /i'm an artificial intelligence/i,
  /i don't have feelings/i,
  /i'm a language model/i,
  /i am an ai\b/i,
  /as a large language model/i,
  /i'm just an ai/i,
];

function detectCharacterBreak(text) {
  return CHARACTER_BREAK_PATTERNS.some(re => re.test(text));
}

// ─── AI call: Groq (Llama 3) → OpenAI proxy fallback ──────────────────────────
// Gemini is NOT used here — only for data reads (no persona risk on structured calls).
async function callAI(messages, maxTokens = 400) {
  // Inject persona prefix into the system message to prevent character breaks
  const messagesWithPrefix = messages.map((m, i) => {
    if (m.role === 'system' && i === 0) {
      return { ...m, content: `${GROQ_PERSONA_PREFIX}\n\n${m.content}` };
    }
    return m;
  });

  // Path 1: Groq (Llama 3 70B) — free tier, best persona lock
  if (GROQ_API_KEY) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({ model: GROQ_MODEL, messages: messagesWithPrefix, max_tokens: maxTokens, temperature: 0.7 }),
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content?.trim() || '';
        if (text) {
          // Check for persona break — retry with reinforced prefix if detected
          if (detectCharacterBreak(text)) {
            console.warn('[Hugo Brain] Groq character break detected — retrying with reinforced prefix');
            const reinforced = messagesWithPrefix.map((m, i) =>
              i === 0 ? { ...m, content: `CRITICAL: ${GROQ_PERSONA_PREFIX}\n\n${m.content}` } : m
            );
            const retry = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
              body: JSON.stringify({ model: GROQ_MODEL, messages: reinforced, max_tokens: maxTokens, temperature: 0.5 }),
            });
            if (retry.ok) {
              const retryData = await retry.json();
              const retryText = retryData.choices?.[0]?.message?.content?.trim() || '';
              if (retryText && !detectCharacterBreak(retryText)) {
                console.log('[Hugo Brain] Groq retry succeeded — persona restored');
                return retryText;
              }
            }
            // Retry also broke — fall through to OpenAI
            console.warn('[Hugo Brain] Groq retry still broke character — falling back to OpenAI');
          } else {
            console.log('[Hugo Brain] Groq succeeded');
            return text;
          }
        }
      } else {
        const errText = await res.text().catch(() => '');
        console.warn(`[Hugo Brain] Groq failed: ${res.status} ${errText.slice(0, 150)} — falling back`);
      }
    } catch (err) {
      console.warn('[Hugo Brain] Groq error:', err.message, '— falling back to OpenAI');
    }
  }

  // Path 2: OpenAI proxy fallback (gpt-4o-mini)
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: messagesWithPrefix,
    max_tokens: maxTokens,
    temperature: 0.7,
  });
  console.log('[Hugo Brain] OpenAI proxy succeeded');
  return res.choices[0]?.message?.content?.trim() || '';
}

// ─── Actions parser — extract [ACTIONS: ...] block from Hugo's reply ──────────
// Returns { cleanReply: string, actions: Array<{type, ...params}> }
function parseActionsFromReply(rawReply) {
  const actionsBlockRe = /\[ACTIONS:\s*([^\]]+)\]\s*$/i;
  const match = rawReply.match(actionsBlockRe);
  if (!match) return { cleanReply: rawReply.trim(), actions: [] };

  const cleanReply = rawReply.replace(actionsBlockRe, '').trim();
  const actionStrings = match[1].split(',').map(s => s.trim()).filter(Boolean);

  const actions = actionStrings.map(str => {
    // Format: "action_type" or "action_type|key=value|key2=value2"
    const parts = str.split('|');
    const type = parts[0].trim().toLowerCase().replace(/\s+/g, '_');
    const params = {};
    for (let i = 1; i < parts.length; i++) {
      const [k, ...vs] = parts[i].split('=');
      if (k) params[k.trim()] = vs.join('=').trim();
    }
    return { type, ...params };
  });

  return { cleanReply, actions };
}

// ─── POST /api/hugo/brain ─────────────────────────────────────────────────────
router.post('/brain', async (req, res) => {
  const { channel, operator_id, session_id, message, history = [], metadata = {}, collected_lead = {} } = req.body || {};

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ success: false, message: 'message is required' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ success: false, message: 'message too long (max 2000 chars)' });
  }

  const hostname = metadata.hostname || 'propops.trade';
  const channelName = channel || 'widget';
  // Phone channel gets shorter token budget (3s TTS). Actions disabled on phone.
  const maxTokens = channelName === 'phone' ? 120 : 450;

  try {
    // Step 1: Get embedding for vector search
    const queryEmbedding = await getEmbedding(message.trim());

    // Step 2: Determine business type from hostname or channel
    const businessType = hostname.includes('propops.pro') ? 'real_estate' :
                         hostname.includes('propopspro') ? (channel === 'dashboard' ? null : 'trades') :
                         'trades';

    // Step 3: Parallel lookups — operator reality (5 queries) + training + pricing
    //   + Phase 2: knowledge entries + lead memory
    // All queries run in parallel; budget is < 500ms.
    const leadPhone = collected_lead.phone || metadata.phone || null;
    const leadEmail = collected_lead.email || null;
    const tradeSlug = businessType === 'real_estate' ? 're_agent' : businessType;

    const [operatorReality, trainingExamples, operatorProfile, pricing, knowledgeEntries, returningLead, founderPricing, serviceArea, paydeckContext, intelligenceContext] = await Promise.all([
      fetchOperatorReality(operator_id),                                    // Layer 0 (Phase 3)
      searchTrainingData(queryEmbedding, businessType, 10),                 // Layer 2a
      getOperatorProfile(operator_id),                                      // Layer 2b
      getLandingPagePricing(hostname.includes('propops.pro') ? 'propops.pro' : 'propops.trade'), // Layer 3b
      searchKnowledge(queryEmbedding, { operatorId: operator_id, tradeSlug, limit: 6 }), // Layer 2c (Phase 2)
      lookupLeadMemory(operator_id, { phone: leadPhone, email: leadEmail }),              // Layer 2d (Phase 2)
      getPricingLocks(),                                                                   // God-layer: founder pricing locks
      operator_id ? getServiceArea(operator_id).catch(() => null) : Promise.resolve(null), // Phase 4: service area
      fetchPaydeckContext(operator_id),                                                    // Layer 2f: PAYDECK (Premium only)
      operator_id ? fetchContextIntelligence(operator_id, businessType).catch(() => null) : Promise.resolve(null), // Layer 2g: intelligence
    ]);

    // Step 3b: Location check — if we have a lead suburb, check if it's in the operator's service area.
    // This runs BEFORE we build the AI prompt so Hugo knows if the lead is out of area.
    const leadSuburb = collected_lead.location || collected_lead.suburb || metadata.location || null;
    let locationCheckResult = null;
    if (operator_id && leadSuburb && channelName !== 'dashboard') {
      locationCheckResult = await checkLeadLocation(operator_id, leadSuburb).catch(() => null);
    }

    // Step 4: Assemble system prompt (now includes Layer 0 + Phase 2 knowledge + lead memory + god-layer pricing + service area + PAYDECK + intelligence)
    const systemPrompt = assembleSystemPrompt({
      hostname, channel: channelName, operatorProfile, trainingExamples, pricing, operatorReality,
      knowledgeEntries,    // Phase 2
      returningLead,       // Phase 2
      founderPricing,      // God-layer: founder pricing locks override hard-coded constants
      serviceArea,         // Phase 4: service area awareness
      paydeckContext,      // Layer 2f: PAYDECK business ops (Premium only)
      intelligenceContext, // Layer 2g: lead history intelligence (hot suburbs, patterns, listings)
      currentLeadSuburb: leadSuburb, // for listing cross-match
    });

    // Step 5: Build message array for AI
    const aiMessages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-8).map(m => ({ role: m.role, content: m.content })), // last 8 turns
      { role: 'user', content: message.trim() },
    ];

    // Step 6: Call AI
    let rawReply = await callAI(aiMessages, maxTokens);

    // Step 7: Parse actions from reply (before guardrails strip formatting)
    const { cleanReply, actions } = channelName === 'phone'
      ? { cleanReply: rawReply, actions: [] }  // No actions on phone — blocking
      : parseActionsFromReply(rawReply);

    // Step 8: Apply output guardrails
    let reply = applyGuardrails(cleanReply);

    // Step 8b: PRICING GUARD — correct any hallucinated prices before sending
    // Uses founder god-layer pricing locks (DB) with hard-coded defaults as fallback.
    // Catches any dollar amount that isn't in the approved list.
    const isProDomain = hostname.includes('propops.pro');
    const lockedTradePrice  = founderPricing?.trade || PRICING_CONSTANTS['propops.trade'].monthly;
    const lockedProPrice    = founderPricing?.pro   || PRICING_CONSTANTS['propops.pro'].monthly;
    const domainLockedPrice = isProDomain ? lockedProPrice : lockedTradePrice;
    const correctPrice      = `$${domainLockedPrice}/month`;
    const approvedPrices    = [lockedTradePrice, lockedProPrice];
    // Include early-bird pro price as approved if set
    if (founderPricing?.earlyBirdPro && !approvedPrices.includes(founderPricing.earlyBirdPro)) {
      approvedPrices.push(founderPricing.earlyBirdPro);
    }
    let pricesCorrected = 0;
    reply = reply.replace(PRICE_CORRECTION_RE, (match, digits) => {
      const num = parseInt(digits, 10);
      // Allow approved subscription prices and operator job prices (>$500 likely a job quote, not PropOps pricing)
      if (approvedPrices.includes(num) || num > 500) return match;
      // This is a hallucinated PropOps subscription price — correct it
      pricesCorrected++;
      console.warn(`[Hugo Brain] PRICING GUARD: corrected hallucinated ${match} → ${correctPrice} (session: ${session_id})`);
      return correctPrice;
    });
    if (pricesCorrected > 0) {
      // Log to content_mismatches for founder dashboard visibility (non-blocking)
      pool.query(
        `INSERT INTO content_mismatches (conversation_id, content_key, hugo_quoted, actual_value, domain, auto_corrected)
         VALUES ($1, 'brain_pricing_guard', $2, $3, $4, true)`,
        [session_id || null, `${pricesCorrected} price(s) corrected`, correctPrice, hostname || 'propops.trade']
      ).catch(() => {});
    }

    // Step 8c: Location / out-of-area override
    // If we confirmed the lead is outside the operator's service area, swap Hugo's reply
    // with the referral message. This fires only when locationCheckResult is definitive.
    let referralTriggered = false;
    let referralResult = null;
    if (locationCheckResult && locationCheckResult.inArea === false &&
        locationCheckResult.reason !== 'no_suburb_provided' &&
        locationCheckResult.reason !== 'no_service_area_configured' &&
        locationCheckResult.reason !== 'no_profile') {
      // Out of area confirmed — trigger referral routing ASYNC and override reply
      const { routeOutOfAreaLead } = require('../services/lead-referral');
      try {
        referralResult = await routeOutOfAreaLead(operator_id, {
          name:        collected_lead.name,
          phone:       collected_lead.phone || metadata.phone || null,
          email:       collected_lead.email,
          suburb:      leadSuburb,
          tradeType:   operatorProfile?.trade_type || null,
          description: collected_lead.description,
          leadId:      collected_lead.lead_id || null,
        });
        reply = applyGuardrails(referralResult.hugoMessage);
        referralTriggered = true;
        console.log(`[Hugo Brain] Out-of-area lead in "${leadSuburb}" — referred=${referralResult.referred}`);
      } catch (err) {
        console.error('[Hugo Brain] routeOutOfAreaLead error (non-fatal):', err.message);
      }
    }

    const intelligenceHotSuburbs = intelligenceContext?.hotSuburbs?.length || 0;
    const intelligenceListings = intelligenceContext?.activeListings?.length || 0;
    console.log(`[Hugo Brain] channel=${channelName} hostname=${hostname} training=${trainingExamples.length} knowledge=${knowledgeEntries.length} returning_lead=${!!returningLead} actions=${actions.length} referral=${referralTriggered} hot_suburbs=${intelligenceHotSuburbs} listings=${intelligenceListings}${pricesCorrected ? ` prices_corrected=${pricesCorrected}` : ''}`);

    // Step 9: Return response to caller immediately
    res.json({
      success: true,
      reply,
      sources_used: trainingExamples.length,
      knowledge_used: knowledgeEntries.length,
      returning_lead: !!returningLead,
      operator_found: !!operatorProfile,
      actions_triggered: actions.map(a => a.type),
      referral_triggered: referralTriggered,
    });

    // Step 10a: Upsert lead memory ASYNC (Phase 2) — track returning leads cross-channel
    // Only upsert if we have at least a name or contact detail to store.
    if (operator_id && (collected_lead.name || collected_lead.phone || collected_lead.email)) {
      upsertLeadMemory(
        operator_id,
        {
          name: collected_lead.name,
          phone: collected_lead.phone || metadata.phone || null,
          email: collected_lead.email,
          jobType: collected_lead.jobType || collected_lead.job_type,
          location: collected_lead.location || metadata.location,
          description: collected_lead.description,
          intentScore: collected_lead.intentScore || collected_lead.intent_score,
        },
        channelName,
        session_id
      ).catch(err => {
        console.warn('[Hugo Brain] upsertLeadMemory error (non-fatal):', err.message);
      });
    }

    // Step 10b: Fire actions ASYNC — never blocks the HTTP response
    if (actions.length > 0) {
      const actionContext = {
        operatorId: operator_id,
        sessionId: session_id,
        operatorProfile: operatorReality?.operatorContext || operatorProfile,
        hostname,
      };
      const leadContext = {
        name: collected_lead.name,
        email: collected_lead.email,
        phone: collected_lead.phone,
        jobType: collected_lead.jobType || collected_lead.job_type,
        location: collected_lead.location || metadata.location,
        description: collected_lead.description,
        intentScore: collected_lead.intentScore || collected_lead.intent_score,
      };
      processActions(actions, actionContext, leadContext).catch(err => {
        console.warn('[Hugo Brain] processActions error (non-fatal):', err.message);
      });
    }

    // Step 10c: Score this turn ASYNC — self-monitoring quality check
    scoreTurn({
      operator_id,
      session_id,
      channel: channelName,
      user_message: message.trim(),
      hugo_reply: reply,
      actions_triggered: actions.map(a => a.type),
    }).catch(err => {
      console.warn('[Hugo Brain] scoreTurn error (non-fatal):', err.message);
    });

  } catch (err) {
    console.error('[Hugo Brain] Error:', err.message);
    res.status(500).json({ success: false, message: 'Hugo had a moment — try again' });
  }
});

// ─── POST /api/hugo/brain/embed — generate embedding for a text string ────────
// Used by the training insert hook to auto-embed new entries.
router.post('/brain/embed', async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ success: false, message: 'text is required' });
  }
  try {
    const embedding = await getEmbedding(text);
    if (!embedding) {
      return res.status(503).json({ success: false, message: 'Embedding service unavailable' });
    }
    res.json({ success: true, embedding, dims: embedding.length });
  } catch (err) {
    console.error('[Hugo Brain] Embed error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.getEmbedding = getEmbedding; // exported for training hook
module.exports.callAI = callAI; // exported for simulation brain wiring
module.exports.assembleSystemPrompt = assembleSystemPrompt;
module.exports.applyGuardrails = applyGuardrails;
module.exports.parseActionsFromReply = parseActionsFromReply;
module.exports.searchTrainingData = searchTrainingData;
module.exports.getOperatorProfile = getOperatorProfile;
module.exports.getLandingPagePricing = getLandingPagePricing;
module.exports.PRICING_CONSTANTS = PRICING_CONSTANTS;
module.exports.APPROVED_PRICES = APPROVED_PRICES;
module.exports.PRICE_CORRECTION_RE = PRICE_CORRECTION_RE;
