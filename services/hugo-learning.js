/**
 * Hugo Learning Service — Phase 2 self-learning memory engine.
 *
 * Owns: knowledge extraction from all channels, validation gate, rate limiting,
 *       per-conversation knowledge writes (Train Your Bot), lead memory CRUD.
 * Does NOT own: Brain prompt assembly (hugo-brain.js), action dispatch (actions-engine.js),
 *               operator profile (operator-data.js), embeddings (hugo-brain.js exports getEmbedding).
 *
 * Public API:
 *   writeTrainedKnowledge(operatorId, question, answer, tradeSlug) → immediate, validated = true
 *   searchKnowledge(queryEmbedding, { operatorId, tradeSlug, limit })  → returns knowledge rows
 *   runDailyLearningBatch()                                            → async batch job
 *   upsertLeadMemory(operatorId, leadInfo, channel, sessionId)         → upsert lead record
 *   lookupLeadMemory(operatorId, { phone, email })                    → find returning lead
 */

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Max auto-extracted entries per day per trade slug (prevents noise flooding)
const DAILY_RATE_LIMIT = 50;

// Minimum Gemini confidence to auto-validate extracted knowledge
const AUTO_VALIDATE_THRESHOLD = 0.85;

// ─── Lazy-load getEmbedding from hugo-brain (avoids circular dep) ─────────────
async function getEmbedding(text) {
  try {
    const { getEmbedding: _get } = require('../routes/hugo-brain');
    return await _get(text);
  } catch {
    return null;
  }
}

// ─── Lazy-load Gemini for extraction jobs ─────────────────────────────────────
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gemini-1.5-flash',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 800,
          temperature: 0.3,
        }),
      }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

// ─── writeTrainedKnowledge ────────────────────────────────────────────────────
// Called by Train Your Bot. Immediately validated, highest authority.
// Returns the inserted row id (UUID).
async function writeTrainedKnowledge(operatorId, question, answer, tradeSlug = null) {
  const knowledgeText = `Q: ${question.trim()}\nA: ${answer.trim()}`;

  // Generate embedding non-blocking after insert
  let embeddingStr = null;
  const embedding = await getEmbedding(knowledgeText);
  if (embedding) embeddingStr = `[${embedding.join(',')}]`;

  const result = await pool.query(
    `INSERT INTO hugo_knowledge_entries
       (operator_id, source_type, knowledge_text, embedding, confidence, trade_slug, validated)
     VALUES ($1, 'train_your_bot', $2, $3::vector, 'trained', $4, true)
     RETURNING id`,
    [operatorId || null, knowledgeText, embeddingStr, tradeSlug]
  );

  console.log(`[Hugo Learning] Trained entry written for operator ${operatorId}, trade=${tradeSlug}`);
  return result.rows[0]?.id;
}

// ─── searchKnowledge ──────────────────────────────────────────────────────────
// Vector search over hugo_knowledge_entries, ordered by confidence priority then
// cosine similarity. Only returns validated = true entries.
//
// Priority order in results:
//   1. 'trained' entries (operator corrections — always win)
//   2. 'learned' + validated entries (auto-extracted, verified)
//   3. 'default' entries (seed data)
async function searchKnowledge(queryEmbedding, { operatorId = null, tradeSlug = null, limit = 6 } = {}) {
  if (!queryEmbedding) return [];

  try {
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // Operator-scoped entries first, then global (trade_slug match or NULL = all trades)
    const result = await pool.query(
      `SELECT knowledge_text, confidence, trade_slug,
              CASE confidence WHEN 'trained' THEN 0 WHEN 'learned' THEN 1 ELSE 2 END AS priority_rank,
              embedding <=> $1::vector AS distance
       FROM hugo_knowledge_entries
       WHERE validated = TRUE
         AND (operator_id = $2 OR operator_id IS NULL)
         AND (trade_slug = $3 OR trade_slug IS NULL OR $3 IS NULL)
       ORDER BY priority_rank ASC, distance ASC
       LIMIT $4`,
      [embeddingStr, operatorId, tradeSlug, limit]
    );

    return result.rows;
  } catch (err) {
    // pgvector may not have the entry yet — non-fatal
    if (!err.message.includes('does not exist') && !err.message.includes('type "vector"')) {
      console.warn('[Hugo Learning] searchKnowledge error (non-fatal):', err.message);
    }
    return [];
  }
}

// ─── checkDailyRateLimit ──────────────────────────────────────────────────────
// Returns true if we're under the per-trade daily extraction limit.
async function checkDailyRateLimit(tradeSlug) {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM hugo_knowledge_entries
       WHERE source_type != 'train_your_bot'
         AND (trade_slug = $1 OR ($1 IS NULL AND trade_slug IS NULL))
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [tradeSlug]
    );
    return parseInt(result.rows[0].cnt, 10) < DAILY_RATE_LIMIT;
  } catch {
    return true; // fail open — don't block on rate limit check failure
  }
}

// ─── extractKnowledgeFromConversation ─────────────────────────────────────────
// Uses Gemini to extract structured Q&A facts from a conversation array.
// Returns array of { question, answer, confidence } objects (0–1 float confidence).
async function extractKnowledgeFromConversation(messages, contextHint = '') {
  if (!messages || messages.length < 2) return [];

  const convo = messages
    .slice(-20) // last 20 turns — avoid token overrun
    .map(m => `${m.role === 'user' ? 'Visitor' : 'Hugo'}: ${m.content}`)
    .join('\n');

  const prompt = `You are a knowledge extractor for an Australian trade and real estate receptionist AI called Hugo.

From the conversation below, extract useful factual Q&A pairs that Hugo should remember for future conversations.
Focus on: trade-specific questions, pricing queries, booking flows, objections, job types, service area questions.
Ignore: generic greetings, complaints without resolution, incomplete exchanges.

Context: ${contextHint || 'General trade conversation'}

Conversation:
${convo}

Respond with JSON ONLY — an array of objects:
[
  { "question": "...", "answer": "...", "confidence": 0.9 },
  ...
]

Rules:
- Only include factual, reusable Q&A pairs (not one-off personal details)
- confidence: 0.0–1.0 where 1.0 = highly reusable, 0.0 = too specific/personal
- Max 5 pairs per conversation
- If nothing useful, return []`;

  const raw = await callGemini(prompt);
  if (!raw) return [];

  try {
    // Strip any markdown code fences Gemini might wrap around the JSON
    const cleaned = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/, '').trim();
    const pairs = JSON.parse(cleaned);
    if (!Array.isArray(pairs)) return [];
    return pairs.filter(p => p.question && p.answer && typeof p.confidence === 'number');
  } catch {
    return [];
  }
}

// ─── persistExtractedKnowledge ────────────────────────────────────────────────
// Takes extracted pairs, validates, checks rate limit, stores high-confidence ones.
async function persistExtractedKnowledge(pairs, { operatorId, tradeSlug, sourceType, sourceId = null }) {
  let stored = 0;

  for (const pair of pairs) {
    if (pair.confidence < 0.5) continue; // Skip low-quality extractions

    const underLimit = await checkDailyRateLimit(tradeSlug);
    if (!underLimit) {
      console.log(`[Hugo Learning] Rate limit hit for trade=${tradeSlug}. Skipping remaining pairs.`);
      break;
    }

    const knowledgeText = `Q: ${pair.question.trim()}\nA: ${pair.answer.trim()}`;

    // Auto-validate only if confidence exceeds threshold
    const validated = pair.confidence >= AUTO_VALIDATE_THRESHOLD;

    const embedding = await getEmbedding(knowledgeText);
    const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;

    try {
      await pool.query(
        `INSERT INTO hugo_knowledge_entries
           (operator_id, source_type, source_id, knowledge_text, embedding, confidence, trade_slug, validated)
         VALUES ($1, $2, $3::uuid, $4, $5::vector, 'learned', $6, $7)`,
        [operatorId || null, sourceType, sourceId, knowledgeText, embeddingStr, tradeSlug, validated]
      );
      stored++;
    } catch (err) {
      console.warn('[Hugo Learning] persistExtractedKnowledge insert error (non-fatal):', err.message);
    }
  }

  return stored;
}

// ─── runDailyLearningBatch ────────────────────────────────────────────────────
// Called once a day (via POST /api/admin/run-learning-batch).
// Mines: widget sessions, dashboard chats, simulation outcomes.
// Phone transcripts are already stored as widget_sessions with channel='phone'.
async function runDailyLearningBatch() {
  const results = { widget: 0, dashboard: 0, simulations: 0, errors: [] };

  // ── 1. Widget chat sessions (last 24h, not yet processed) ─────────────────
  try {
    const sessions = await pool.query(
      `SELECT DISTINCT session_id, operator_id
       FROM hugo_widget_sessions
       WHERE created_at >= NOW() - INTERVAL '25 hours'
       LIMIT 200`
    ).catch(() => ({ rows: [] }));

    for (const session of sessions.rows) {
      try {
        const msgs = await pool.query(
          `SELECT role, content FROM hugo_widget_sessions
           WHERE session_id = $1 ORDER BY created_at ASC`,
          [session.session_id]
        ).catch(() => ({ rows: [] }));

        if (msgs.rows.length < 4) continue; // too short to extract from

        const pairs = await extractKnowledgeFromConversation(msgs.rows, 'Trade/RE widget conversation');
        if (pairs.length > 0) {
          const stored = await persistExtractedKnowledge(pairs, {
            operatorId: session.operator_id,
            tradeSlug: null, // widget sessions don't always have trade context
            sourceType: 'widget_chat',
            sourceId: null,
          });
          results.widget += stored;
        }
      } catch (err) {
        results.errors.push(`widget session ${session.session_id}: ${err.message}`);
      }
    }
  } catch (err) {
    results.errors.push(`widget batch: ${err.message}`);
  }

  // ── 2. Dashboard chat messages (operator ↔ Hugo, last 24h) ────────────────
  try {
    const operatorIds = await pool.query(
      `SELECT DISTINCT agent_id AS operator_id
       FROM hugo_chat_messages
       WHERE created_at >= NOW() - INTERVAL '25 hours'
       LIMIT 100`
    ).catch(() => ({ rows: [] }));

    for (const row of operatorIds.rows) {
      try {
        const msgs = await pool.query(
          `SELECT role, content FROM hugo_chat_messages
           WHERE agent_id = $1
             AND created_at >= NOW() - INTERVAL '25 hours'
           ORDER BY created_at ASC`,
          [row.operator_id]
        ).catch(() => ({ rows: [] }));

        if (msgs.rows.length < 4) continue;

        // Get trade context for this operator
        const profileRow = await pool.query(
          `SELECT trade_type FROM operator_profiles WHERE operator_id = $1`,
          [row.operator_id]
        ).catch(() => ({ rows: [] }));
        const tradeSlug = profileRow.rows[0]?.trade_type || null;

        const pairs = await extractKnowledgeFromConversation(msgs.rows, 'Operator dashboard conversation');
        if (pairs.length > 0) {
          const stored = await persistExtractedKnowledge(pairs, {
            operatorId: row.operator_id,
            tradeSlug,
            sourceType: 'dashboard_chat',
            sourceId: null,
          });
          results.dashboard += stored;
        }
      } catch (err) {
        results.errors.push(`dashboard op ${row.operator_id}: ${err.message}`);
      }
    }
  } catch (err) {
    results.errors.push(`dashboard batch: ${err.message}`);
  }

  // ── 3. Simulation outcomes (last 24h, final_status = 'Booked') ────────────
  // Extract patterns from successful simulations — what questions led to bookings
  try {
    const sims = await pool.query(
      `SELECT id, operator_id, trade_category, simulation_type, hugo_response_text
       FROM hugo_sim_outcomes
       WHERE created_at >= NOW() - INTERVAL '25 hours'
         AND final_status = 'Booked'
       LIMIT 50`
    ).catch(() => ({ rows: [] }));

    for (const sim of sims.rows) {
      try {
        if (!sim.hugo_response_text) continue;

        let responseData;
        try { responseData = JSON.parse(sim.hugo_response_text); } catch { continue; }

        // Extract from simulation samples if they exist
        const samples = responseData.samples || [];
        for (const sample of samples.slice(0, 3)) {
          if (!sample.message || !sample.hugo_response) continue;
          const pairs = [{ question: sample.message, answer: sample.hugo_response, confidence: 0.8 }];
          const stored = await persistExtractedKnowledge(pairs, {
            operatorId: sim.operator_id,
            tradeSlug: sim.trade_category,
            sourceType: 'simulation',
            sourceId: null,
          });
          results.simulations += stored;
        }
      } catch (err) {
        results.errors.push(`sim ${sim.id}: ${err.message}`);
      }
    }
  } catch (err) {
    results.errors.push(`simulation batch: ${err.message}`);
  }

  const total = results.widget + results.dashboard + results.simulations;
  console.log(`[Hugo Learning] Daily batch complete: ${total} entries stored (widget=${results.widget}, dashboard=${results.dashboard}, sims=${results.simulations}, errors=${results.errors.length})`);

  return { success: true, total, ...results };
}

// ─── upsertLeadMemory ─────────────────────────────────────────────────────────
// Upserts a lead record. Match priority: phone → email.
// On match, updates last_seen_at, channel, session, and any new fields provided.
async function upsertLeadMemory(operatorId, leadInfo = {}, channel = 'widget', sessionId = null) {
  if (!operatorId) return null;
  if (!leadInfo.phone && !leadInfo.email && !leadInfo.name) return null; // nothing to store

  const { name, phone, email, jobType, location, intentScore, description } = leadInfo;

  try {
    // Try to find existing record
    let existing = null;

    if (phone) {
      const r = await pool.query(
        `SELECT id FROM hugo_lead_memory WHERE operator_id = $1 AND lead_phone = $2 LIMIT 1`,
        [operatorId, phone]
      );
      existing = r.rows[0] || null;
    }

    if (!existing && email) {
      const r = await pool.query(
        `SELECT id FROM hugo_lead_memory WHERE operator_id = $1 AND lower(lead_email) = lower($2) LIMIT 1`,
        [operatorId, email]
      );
      existing = r.rows[0] || null;
    }

    if (existing) {
      // Update existing record with any new info provided
      await pool.query(
        `UPDATE hugo_lead_memory SET
           lead_name        = COALESCE($2, lead_name),
           lead_phone       = COALESCE($3, lead_phone),
           lead_email       = COALESCE($4, lead_email),
           trade_slug       = COALESCE($5, trade_slug),
           job_description  = COALESCE($6, job_description),
           location         = COALESCE($7, location),
           intent_score     = COALESCE($8, intent_score),
           last_channel     = $9,
           last_session_id  = $10,
           last_seen_at     = NOW()
         WHERE id = $1`,
        [existing.id, name || null, phone || null, email || null,
         jobType || null, description || null, location || null,
         intentScore || null, channel, sessionId]
      );
      return existing.id;
    } else {
      // Insert new lead memory record
      const r = await pool.query(
        `INSERT INTO hugo_lead_memory
           (operator_id, lead_name, lead_phone, lead_email, trade_slug,
            job_description, location, intent_score, last_channel, last_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [operatorId, name || null, phone || null, email || null,
         jobType || null, description || null, location || null,
         intentScore || null, channel, sessionId]
      );
      return r.rows[0]?.id;
    }
  } catch (err) {
    console.warn('[Hugo Learning] upsertLeadMemory error (non-fatal):', err.message);
    return null;
  }
}

// ─── lookupLeadMemory ─────────────────────────────────────────────────────────
// Returns a returning lead's context if found, or null.
// Used by Brain Service to inject "welcome back" context.
async function lookupLeadMemory(operatorId, { phone, email } = {}) {
  if (!operatorId) return null;
  if (!phone && !email) return null;

  try {
    let row = null;

    if (phone) {
      const r = await pool.query(
        `SELECT lead_name, lead_phone, lead_email, trade_slug, job_description,
                location, intent_score, last_channel, conversation_summary,
                first_seen_at, last_seen_at
         FROM hugo_lead_memory
         WHERE operator_id = $1 AND lead_phone = $2
         ORDER BY last_seen_at DESC LIMIT 1`,
        [operatorId, phone]
      );
      row = r.rows[0] || null;
    }

    if (!row && email) {
      const r = await pool.query(
        `SELECT lead_name, lead_phone, lead_email, trade_slug, job_description,
                location, intent_score, last_channel, conversation_summary,
                first_seen_at, last_seen_at
         FROM hugo_lead_memory
         WHERE operator_id = $1 AND lower(lead_email) = lower($2)
         ORDER BY last_seen_at DESC LIMIT 1`,
        [operatorId, email]
      );
      row = r.rows[0] || null;
    }

    return row;
  } catch (err) {
    // Table may not exist yet (migration pending) — non-fatal
    return null;
  }
}

module.exports = {
  writeTrainedKnowledge,
  searchKnowledge,
  runDailyLearningBatch,
  upsertLeadMemory,
  lookupLeadMemory,
};
