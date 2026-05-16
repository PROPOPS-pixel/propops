/**
 * Hugo Supervision Service — event-driven AI supervision loop.
 *
 * Owns: nightly batch review (Layer 1), anomaly detection (Layer 2),
 *       transcript aggregation, Groq evaluation calls, prompt suggestion
 *       generation, daily report writing.
 * Does NOT own: prompt storage (services/founder-config.js),
 *               score turn-level data (services/hugo-scorer.js),
 *               DB writes (db/hugo-supervision.js),
 *               API endpoints (routes/hugo-supervision.js).
 *
 * Architecture:
 *   Layer 1 — Nightly batch: reads today's conversations from ALL channels,
 *             sends to Groq for batch evaluation, flags weaknesses, generates
 *             prompt patch suggestions (founder must approve), saves daily report.
 *   Layer 2 — Anomaly trigger: called by hugo-brain.js after each conversation
 *             ends; if confidence < ANOMALY_THRESHOLD, flags for next cycle.
 *
 * Cost model: ~$0.01/night on Groq (one or two batch calls, up to 60 conversations).
 */

'use strict';

const { Pool } = require('pg');
const {
  insertSupervisionLog,
  updateSupervisionLog,
  getAnomaliesToReview,
  createTrainingVersion,
  getCurrentVersionNumber,
} = require('../db/hugo-supervision');
const { getAllConfig } = require('./founder-config');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── Groq config ────────────────────────────────────────────────────────────────
const GROQ_API_KEY = (() => {
  const k = process.env.GROQ_API_KEY;
  if (!k || k.startsWith('gsk_free_tier_placeholder') || k === 'placeholder') return null;
  return k;
})();
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = process.env.HUGO_GROQ_MODEL || 'llama3-8b-8192';

// Conversations where Hugo scores below this get flagged for anomaly review
const ANOMALY_THRESHOLD = 0.3;
// Conversations where Hugo scores below this get included in nightly weakness report
const QUALITY_THRESHOLD = 0.5;

// ─── Groq call helper ────────────────────────────────────────────────────────────
async function callGroq(messages, maxTokens = 1500, timeoutMs = 20000) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
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
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Groq ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Conversation ingestion ──────────────────────────────────────────────────────
async function fetchTodayConversations() {
  const since = new Date();
  since.setHours(0, 0, 0, 0); // midnight today

  const conversations = [];

  // 1. Widget sessions (web_pro + web_trade)
  try {
    const result = await pool.query(
      `SELECT id, messages, metadata, created_at
       FROM hugo_widget_sessions
       WHERE created_at >= $1
         AND messages IS NOT NULL
         AND jsonb_array_length(messages) >= 2
       ORDER BY created_at ASC
       LIMIT 25`,
      [since]
    );

    for (const row of result.rows) {
      const msgs = row.messages || [];
      const userTurns = msgs.filter(m => m.role === 'user' || m.sender === 'user');
      const hugoTurns = msgs.filter(m => m.role === 'assistant' || m.sender === 'hugo' || m.sender === 'assistant');
      if (!userTurns.length || !hugoTurns.length) continue;

      const domain = row.metadata?.domain || '';
      conversations.push({
        id: `widget_${row.id}`,
        channel: 'widget',
        source: domain.includes('propops.trade') ? 'web_trade' : 'web_pro',
        operator_id: row.metadata?.operator_id || null,
        session_id: String(row.id),
        user_text: userTurns.map(m => m.content || m.message || '').join(' | ').slice(0, 400),
        hugo_text: hugoTurns.map(m => m.content || m.message || '').join(' | ').slice(0, 500),
        turn_count: userTurns.length,
        created_at: row.created_at,
      });
    }
  } catch (e) {
    console.warn('[Supervision] Widget session ingestion error:', e.message);
  }

  // 2. Voice calls (phone channel)
  try {
    const result = await pool.query(
      `SELECT id, operator_id, transcript, created_at
       FROM voice_calls
       WHERE created_at >= $1
         AND transcript IS NOT NULL
         AND status IN ('completed', 'ended')
       ORDER BY created_at ASC
       LIMIT 15`,
      [since]
    );

    for (const row of result.rows) {
      const turns = Array.isArray(row.transcript) ? row.transcript : [];
      const callerTurns = turns.filter(t => t.role === 'user' || t.speaker === 'caller');
      const hugoTurns = turns.filter(t => t.role === 'assistant' || t.speaker === 'hugo');
      if (!callerTurns.length || !hugoTurns.length) continue;

      const callerText = callerTurns.map(t => t.text || t.message || t.content || '').join(' ').slice(0, 400);
      const hugoText = hugoTurns.map(t => t.text || t.message || t.content || '').join(' ').slice(0, 500);
      if (!callerText || !hugoText) continue;

      conversations.push({
        id: `voice_${row.id}`,
        channel: 'phone',
        source: 'phone',
        operator_id: row.operator_id || null,
        session_id: `voice_${row.id}`,
        user_text: callerText,
        hugo_text: hugoText,
        turn_count: callerTurns.length,
        created_at: row.created_at,
      });
    }
  } catch (e) {
    console.warn('[Supervision] Voice call ingestion error:', e.message);
  }

  // 3. Dashboard chat (operator conversations)
  try {
    const result = await pool.query(
      `SELECT operator_id,
              array_agg(content ORDER BY created_at ASC) FILTER (WHERE role='user') AS user_messages,
              array_agg(content ORDER BY created_at ASC) FILTER (WHERE role='assistant') AS hugo_messages,
              MIN(created_at) AS started_at,
              count(*) AS turn_count
       FROM hugo_chat_messages
       WHERE created_at >= $1
       GROUP BY operator_id
       HAVING count(*) >= 2
       LIMIT 15`,
      [since]
    );

    for (const row of result.rows) {
      const userText = (row.user_messages || []).join(' | ').slice(0, 400);
      const hugoText = (row.hugo_messages || []).join(' | ').slice(0, 500);
      if (!userText || !hugoText) continue;

      conversations.push({
        id: `dashboard_${row.operator_id}`,
        channel: 'dashboard',
        source: 'dashboard',
        operator_id: row.operator_id,
        session_id: `dashboard_${row.operator_id}_${since.toISOString().split('T')[0]}`,
        user_text: userText,
        hugo_text: hugoText,
        turn_count: parseInt(row.turn_count, 10),
        created_at: row.started_at,
      });
    }
  } catch (e) {
    console.warn('[Supervision] Dashboard chat ingestion error:', e.message);
  }

  return conversations;
}

// ─── Batch evaluation prompt ─────────────────────────────────────────────────────
function buildBatchEvalPrompt(conversations) {
  const convList = conversations.map((c, i) =>
    `[${i}] channel:${c.channel} | turns:${c.turn_count}\nUSER: ${c.user_text.slice(0, 200)}\nHUGO: ${c.hugo_text.slice(0, 200)}`
  ).join('\n\n');

  return `You are evaluating Hugo, an AI receptionist for Australian tradespeople and real estate agents.
Hugo's job: greet callers, qualify leads (get trade/job/location/contact), give rough quotes, book callbacks.
Tone: friendly and direct for tradies ("G'day!"), professional for real estate.

For each conversation below, return a JSON array with one object per conversation:
{
  "idx": <index 0-based>,
  "confidence": <float 0.0-1.0, how well Hugo handled this>,
  "issue": <null or one short sentence describing the main problem if confidence < 0.6>,
  "improvement": <null or one concrete improvement suggestion if confidence < 0.6>
}

CONVERSATIONS:
${convList}

Return ONLY a JSON array, no markdown, no explanation.`;
}

// ─── Prompt suggestion generation ───────────────────────────────────────────────
function buildSuggestionPrompt(issues, currentPromptSnippet) {
  return `You are improving Hugo's system prompt. Hugo is an AI receptionist for Australian tradies.

IDENTIFIED ISSUES today:
${issues.map((i, idx) => `${idx + 1}. ${i.description}`).join('\n')}

CURRENT PROMPT EXCERPT (first 500 chars):
${currentPromptSnippet.slice(0, 500)}

Generate ONE specific, minimal prompt improvement that would address these issues.
Requirements:
- Must be a concrete text addition or replacement (not "be more helpful")
- Must not change Hugo's core persona, pricing, or guardrails
- Maximum 3 sentences
- Should be addable as a new instruction paragraph

Return JSON only:
{
  "patch_description": "what this change does",
  "patch_text": "the actual text to add to the prompt",
  "auto_approvable": <true if safe/minor, false if affects core behavior>
}`;
}

// ─── Nightly batch run ───────────────────────────────────────────────────────────
/**
 * Run the nightly supervision batch.
 * - Reads today's conversations from all channels
 * - Evaluates with Groq (confidence, issues)
 * - Flags low-confidence conversations as anomalies
 * - Generates prompt patch suggestions for recurring issues
 * - Saves daily report to hugo_supervision_log
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun - if true, skip DB writes (for testing)
 * @returns {Promise<object>} run results
 */
async function runNightlyBatch({ dryRun = false } = {}) {
  const startMs = Date.now();
  const runDate = new Date().toISOString().split('T')[0];

  console.log(`[Supervision] Starting nightly batch for ${runDate}…`);

  let logId = null;
  if (!dryRun) {
    logId = await insertSupervisionLog({ status: 'running', run_date: runDate });
  }

  try {
    // 1. Fetch conversations
    const conversations = await fetchTodayConversations();
    console.log(`[Supervision] Found ${conversations.length} conversations to review`);

    if (!conversations.length) {
      const report = `Daily Hugo Report — ${runDate}\n\nNo conversations found today. Nothing to review.`;
      if (!dryRun && logId) {
        await updateSupervisionLog(logId, {
          conversations_reviewed: 0,
          conversations_flagged: 0,
          avg_confidence: null,
          issues_detected: [],
          suggestions: [],
          report_text: report,
          model_used: GROQ_MODEL,
          run_duration_ms: Date.now() - startMs,
          status: 'completed',
        });
      }
      return { success: true, conversations_reviewed: 0, conversations_flagged: 0, report };
    }

    // 2. Batch evaluate with Groq
    let evaluations = [];
    let groqError = null;

    if (GROQ_API_KEY) {
      try {
        const evalPrompt = buildBatchEvalPrompt(conversations);
        const rawResponse = await callGroq([
          { role: 'system', content: 'You are a quality evaluator. Return only valid JSON arrays.' },
          { role: 'user', content: evalPrompt },
        ], 2000, 25000);

        const jsonStr = rawResponse.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
        const parsed = JSON.parse(jsonStr);
        evaluations = Array.isArray(parsed) ? parsed : [];
        console.log(`[Supervision] Groq evaluated ${evaluations.length}/${conversations.length} conversations`);
      } catch (e) {
        groqError = e.message;
        console.warn('[Supervision] Groq evaluation failed, using fallback scoring:', e.message);
        // Fallback: mark all as medium confidence
        evaluations = conversations.map((_, i) => ({ idx: i, confidence: 0.6, issue: null, improvement: null }));
      }
    } else {
      // No Groq: use call scores from hugo_call_scores as proxy
      evaluations = conversations.map((_, i) => ({ idx: i, confidence: 0.6, issue: null, improvement: null }));
      groqError = 'GROQ_API_KEY not configured';
    }

    // 3. Map evaluations back to conversations
    const evalMap = new Map(evaluations.map(e => [e.idx, e]));
    const results = conversations.map((conv, i) => {
      const ev = evalMap.get(i) || { confidence: 0.6, issue: null, improvement: null };
      return { ...conv, confidence: ev.confidence, issue: ev.issue, improvement: ev.improvement };
    });

    // 4. Compute stats
    const confidences = results.map(r => r.confidence).filter(c => typeof c === 'number');
    const avgConfidence = confidences.length
      ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 1000) / 1000
      : null;

    const flagged = results.filter(r => r.confidence < ANOMALY_THRESHOLD);
    const weakConversations = results.filter(r => r.confidence < QUALITY_THRESHOLD);

    // 5. Anomaly DB writes (Layer 2 trigger)
    if (!dryRun) {
      const { insertConfidenceScore } = require('../db/hugo-supervision');
      for (const conv of results) {
        await insertConfidenceScore({
          operator_id: conv.operator_id,
          session_id: conv.session_id,
          channel: conv.channel,
          confidence: conv.confidence,
          needs_review: conv.confidence < ANOMALY_THRESHOLD,
          review_reason: conv.issue || null,
          turn_count: conv.turn_count,
          conversation_summary: `${conv.user_text.slice(0, 100)} → ${conv.hugo_text.slice(0, 100)}`,
        }).catch(e => console.warn('[Supervision] insertConfidenceScore error:', e.message));
      }
    }

    // 6. Generate prompt improvement suggestions for recurring issues
    const issues = weakConversations
      .filter(r => r.issue)
      .map(r => ({ description: r.issue, source: r.source, channel: r.channel }))
      .slice(0, 5);

    let suggestions = [];
    if (issues.length > 0 && GROQ_API_KEY && !groqError) {
      try {
        // Read current trade prompt from founder config
        const configRows = await getAllConfig().catch(() => []);
        const tradePromptRow = configRows.find(r => r.config_key === 'system_prompt.trade');
        const currentPrompt = tradePromptRow?.config_value || 'Hugo is a trade receptionist…';

        const suggestionRaw = await callGroq([
          { role: 'system', content: 'You are a prompt engineer. Return only valid JSON.' },
          { role: 'user', content: buildSuggestionPrompt(issues, currentPrompt) },
        ], 600, 15000);

        const suggJson = suggestionRaw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
        const sugg = JSON.parse(suggJson);
        if (sugg.patch_description && sugg.patch_text) {
          suggestions = [{
            type: 'prompt_patch',
            description: sugg.patch_description,
            patch: sugg.patch_text,
            auto_approvable: sugg.auto_approvable === true,
            affected_issues: issues.length,
          }];
        }
      } catch (e) {
        console.warn('[Supervision] Suggestion generation failed:', e.message);
      }
    }

    // 7. Build the daily report text
    const reportLines = [
      `📊 Daily Hugo Report — ${runDate}`,
      ``,
      `Conversations reviewed: ${results.length}`,
      `Average confidence: ${avgConfidence !== null ? (avgConfidence * 100).toFixed(0) + '%' : 'N/A'}`,
      `Flagged for review: ${flagged.length}`,
      `Below quality threshold (${(QUALITY_THRESHOLD * 100).toFixed(0)}%): ${weakConversations.length}`,
      ``,
    ];

    if (weakConversations.length > 0) {
      reportLines.push(`⚠️ Issues Detected:`);
      for (const c of weakConversations.slice(0, 5)) {
        reportLines.push(`  [${c.channel}] conf=${(c.confidence * 100).toFixed(0)}% — ${c.issue || 'low quality response'}`);
      }
      reportLines.push('');
    }

    if (suggestions.length > 0) {
      reportLines.push(`💡 Suggested Improvements (pending founder approval):`);
      for (const s of suggestions) {
        reportLines.push(`  ${s.description}`);
        reportLines.push(`  Patch: "${s.patch.slice(0, 120)}${s.patch.length > 120 ? '…' : ''}"`);
        reportLines.push(`  Auto-approvable: ${s.auto_approvable ? 'Yes' : 'No (needs founder review)'}`);
      }
      reportLines.push('');
    }

    if (groqError) {
      reportLines.push(`⚠️ AI evaluator note: ${groqError}`);
    }

    const reportText = reportLines.join('\n');
    const durationMs = Date.now() - startMs;

    // 8. Save to supervision log
    if (!dryRun && logId) {
      await updateSupervisionLog(logId, {
        conversations_reviewed: results.length,
        conversations_flagged: flagged.length,
        avg_confidence: avgConfidence,
        issues_detected: weakConversations.map(c => ({
          type: 'low_confidence',
          description: c.issue || 'low quality',
          severity: c.confidence < 0.3 ? 'high' : 'medium',
          source: c.source,
          conversation_id: c.id,
        })),
        suggestions,
        report_text: reportText,
        model_used: GROQ_MODEL,
        run_duration_ms: durationMs,
        status: 'completed',
      });
    }

    // 9. Create training version records for suggestions (pending approval)
    if (!dryRun && suggestions.length > 0 && logId) {
      for (const sugg of suggestions) {
        if (sugg.patch) {
          try {
            const configRows = await getAllConfig().catch(() => []);
            const tradeRow = configRows.find(r => r.config_key === 'system_prompt.trade');
            const currentPrompt = tradeRow?.config_value || '';

            if (currentPrompt) {
              await createTrainingVersion({
                prompt_key: 'system_prompt.trade',
                prompt_before: currentPrompt,
                prompt_after: currentPrompt + '\n\n' + sugg.patch,
                change_reason: sugg.description,
                change_source: 'supervision',
                supervision_log_id: logId,
              });
            }
          } catch (e) {
            console.warn('[Supervision] createTrainingVersion error:', e.message);
          }
        }
      }
    }

    console.log(`[Supervision] Nightly batch complete in ${durationMs}ms. Reviewed: ${results.length}, Flagged: ${flagged.length}`);

    return {
      success: true,
      conversations_reviewed: results.length,
      conversations_flagged: flagged.length,
      avg_confidence: avgConfidence,
      issues_count: weakConversations.length,
      suggestions_count: suggestions.length,
      log_id: logId,
      report: reportText,
      duration_ms: durationMs,
    };

  } catch (err) {
    console.error('[Supervision] Nightly batch failed:', err.message);
    if (!dryRun && logId) {
      await updateSupervisionLog(logId, {
        status: 'failed',
        error_message: err.message,
        run_duration_ms: Date.now() - startMs,
      }).catch(() => {});
    }
    throw err;
  }
}

/**
 * Record a conversation's end-of-session confidence for Layer 2 anomaly detection.
 * Called by hugo-brain.js after a multi-turn conversation completes.
 * If confidence < ANOMALY_THRESHOLD, flags for next supervision cycle.
 *
 * @param {object} ctx
 * @param {number|null} ctx.operator_id
 * @param {string}      ctx.session_id
 * @param {string}      ctx.channel
 * @param {number}      ctx.confidence  - 0.0 to 1.0
 * @param {number}      ctx.turn_count
 * @param {string}      [ctx.reason]    - why confidence is low
 * @returns {Promise<void>}
 */
async function recordConversationConfidence(ctx) {
  try {
    const { insertConfidenceScore } = require('../db/hugo-supervision');
    await insertConfidenceScore({
      operator_id: ctx.operator_id || null,
      session_id: ctx.session_id,
      channel: ctx.channel || 'widget',
      confidence: ctx.confidence,
      needs_review: ctx.confidence < ANOMALY_THRESHOLD,
      review_reason: ctx.reason || null,
      turn_count: ctx.turn_count || 1,
    });
  } catch (e) {
    // Non-fatal — supervision layer must never break the main response path
    console.warn('[Supervision] recordConversationConfidence error:', e.message);
  }
}

/**
 * Get anomalies pending review (for supervision endpoint).
 * @returns {Promise<object[]>}
 */
async function getPendingAnomalies() {
  return getAnomaliesToReview(50);
}

module.exports = {
  runNightlyBatch,
  recordConversationConfidence,
  getPendingAnomalies,
  ANOMALY_THRESHOLD,
  QUALITY_THRESHOLD,
};
