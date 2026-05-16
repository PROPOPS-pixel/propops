/**
 * Hugo Scorer Service — self-monitoring quality evaluator.
 *
 * Scores every Hugo conversation turn (after the HTTP response is sent)
 * across five dimensions using a lightweight AI call (Groq llama3-8b or
 * gpt-4o-mini fallback). Writes results to hugo_call_scores via the DB module.
 *
 * Owns: scoring logic, AI scorer call, flag extraction, DB write.
 * Does NOT own: brain routing (hugo-brain.js), DB schema (db/hugo-call-scores.js),
 *               API endpoints (routes/hugo-scores.js).
 *
 * Public API:
 *   scoreTurn(turnContext) → Promise<void>  (non-blocking, swallows errors)
 */

'use strict';

const OpenAI = require('openai');
const { insertScore } = require('../db/hugo-call-scores');

const openai = new OpenAI(); // Uses OPENAI_BASE_URL + OPENAI_API_KEY from env

// Use Groq for scoring (fast + cheap) with OpenAI proxy fallback
const GROQ_API_KEY = (() => {
  const k = process.env.GROQ_API_KEY;
  if (!k || k.startsWith('gsk_free_tier_placeholder') || k === 'placeholder') return null;
  return k;
})();
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = process.env.HUGO_GROQ_MODEL || 'llama3-8b-8192';
const FALLBACK_MODEL = 'gpt-4o-mini';

// Scoring prompt — instructs the AI to return a strict JSON object
const SCORING_PROMPT = `You are a quality evaluator for an AI receptionist named Hugo.
Hugo helps tradespeople (plumbers, electricians, etc.) and real estate agents handle customer inquiries.

Score the following conversation turn on EACH of these five dimensions (integers 1–5):
  helpfulness    — Did Hugo actually answer the customer's question or move the conversation forward?
  on_brand       — Did Hugo stay in character, use correct pricing, avoid hallucinations?
  lead_capture   — Did Hugo gather useful lead info (name, phone, job type, location)?
                   Score 3 if not applicable (e.g. general question), score 1-2 if Hugo missed obvious opportunities.
  action_quality — Were the actions Hugo triggered appropriate? Score 3 if no actions were triggered and none were needed.
  brevity        — Was the reply an appropriate length for the channel? Phone = max ~25 words ideal, widget/dashboard can be longer.

Also identify any flags from this list (use exact strings, empty array if none):
  "price_hallucination"   — Hugo quoted a wrong price
  "off_topic"             — Hugo went off-topic or talked about competitors
  "refused_to_help"       — Hugo refused a reasonable request without good reason
  "too_long"              — reply was unnecessarily verbose
  "collected_wrong_info"  — Hugo asked for irrelevant info or asked the same thing twice
  "persona_break"         — Hugo broke character (said "as an AI", etc.)

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{"helpfulness":N,"on_brand":N,"lead_capture":N,"action_quality":N,"brevity":N,"flags":["flag1"]}`;

/**
 * Call the scoring AI. Uses Groq if available, falls back to OpenAI proxy.
 * Returns parsed score object or null on failure.
 */
async function callScorer(userMessage, hugoReply, channel, actionsTriggered) {
  const turnDescription = [
    `CHANNEL: ${channel}`,
    `CUSTOMER MESSAGE: ${userMessage.substring(0, 500)}`,
    `HUGO REPLY: ${hugoReply.substring(0, 500)}`,
    actionsTriggered && actionsTriggered.length > 0
      ? `ACTIONS TRIGGERED: ${actionsTriggered.join(', ')}`
      : 'ACTIONS TRIGGERED: none',
  ].join('\n');

  const messages = [
    { role: 'system', content: SCORING_PROMPT },
    { role: 'user', content: turnDescription },
  ];

  let rawText = null;

  // Try Groq first (faster, cheaper)
  if (GROQ_API_KEY) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          max_tokens: 200,
          temperature: 0.1,
        }),
      });
      clearTimeout(timer);
      if (resp.ok) {
        const data = await resp.json();
        rawText = data.choices?.[0]?.message?.content?.trim() || null;
      }
    } catch (e) {
      // Groq failed — fall through to OpenAI proxy
    }
  }

  // Fallback to OpenAI proxy
  if (!rawText) {
    try {
      const completion = await openai.chat.completions.create({
        model: FALLBACK_MODEL,
        messages,
        max_tokens: 200,
        temperature: 0.1,
      });
      rawText = completion.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
      return null;
    }
  }

  if (!rawText) return null;

  // Parse — strip any accidental markdown fences
  const cleaned = rawText.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    // Validate shape
    const dims = ['helpfulness', 'on_brand', 'lead_capture', 'action_quality', 'brevity'];
    for (const d of dims) {
      const v = Number(parsed[d]);
      if (!Number.isInteger(v) || v < 1 || v > 5) return null;
    }
    if (!Array.isArray(parsed.flags)) parsed.flags = [];
    return { ...parsed, _raw: rawText, _model: GROQ_API_KEY ? GROQ_MODEL : FALLBACK_MODEL };
  } catch {
    return null;
  }
}

/**
 * Score a single conversation turn and persist to DB.
 * This is always called ASYNC — it must never throw to the caller.
 *
 * @param {object} ctx
 * @param {number|null}  ctx.operator_id
 * @param {string}       ctx.session_id
 * @param {string}       ctx.channel          widget | phone | dashboard
 * @param {string}       ctx.user_message     the customer's message
 * @param {string}       ctx.hugo_reply       Hugo's reply (after guardrails)
 * @param {string[]}     ctx.actions_triggered
 */
async function scoreTurn(ctx) {
  try {
    const {
      operator_id = null,
      session_id = null,
      channel = 'widget',
      user_message = '',
      hugo_reply = '',
      actions_triggered = [],
    } = ctx;

    if (!user_message || !hugo_reply) return;

    const scored = await callScorer(user_message, hugo_reply, channel, actions_triggered);
    if (!scored) {
      console.warn('[Hugo Scorer] Scoring failed — no result (non-fatal)');
      return;
    }

    const dims = [
      scored.helpfulness,
      scored.on_brand,
      scored.lead_capture,
      scored.action_quality,
      scored.brevity,
    ];
    const avg = dims.reduce((a, b) => a + b, 0) / dims.length;
    const overall = Math.round(avg * 10) / 10;

    await insertScore({
      operator_id,
      session_id,
      channel,
      message_snippet: user_message.substring(0, 120),
      reply_snippet:   hugo_reply.substring(0, 120),
      score_helpfulness:    scored.helpfulness,
      score_on_brand:       scored.on_brand,
      score_lead_capture:   scored.lead_capture,
      score_action_quality: scored.action_quality,
      score_brevity:        scored.brevity,
      score_overall:        overall,
      scorer_model:         scored._model,
      flags:                scored.flags || [],
      raw_scoring_json:     { raw: scored._raw },
    });

    if (scored.flags && scored.flags.length > 0) {
      console.warn(`[Hugo Scorer] Flags on session ${session_id}: ${scored.flags.join(', ')} (overall: ${overall})`);
    }
  } catch (err) {
    // Non-fatal — scoring must never break the main brain response
    console.warn('[Hugo Scorer] scoreTurn error (non-fatal):', err.message);
  }
}

module.exports = { scoreTurn };
