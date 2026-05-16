/**
 * Simulation & Multi-Platform Batch Eval Service
 *
 * Owns: nightly batch evaluation across ALL platforms, auto-gate rules,
 *       learning loop (approved → knowledge), founder digest generation,
 *       pattern detection, self-learning log, live correction locking.
 *
 * Does NOT own: real-time simulation responses (routes/jobs.js → hugo-brain.js),
 *               operator profiles (operator-data.js), embedding generation (hugo-brain.js).
 *
 * Platforms ingested:
 *   dashboard_sim — operator simulate-inquiry runs (original)
 *   web_pro       — propops.pro widget sessions (hugo_widget_sessions, metadata.domain)
 *   web_trade     — propops.trade widget sessions (hugo_widget_sessions)
 *   phone         — Twilio voice call transcripts (voice_calls)
 *   email         — forwarded lead emails (operator_emails + raw_emails)
 *
 * Cost model: ~$0.003/day on Groq (one batch call, up to 100 items across platforms).
 */

'use strict';

const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

const GROQ_API_KEY = (() => {
  const k = process.env.GROQ_API_KEY;
  if (!k || k.startsWith('gsk_free_tier_placeholder') || k === 'placeholder') return null;
  return k;
})();
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = process.env.HUGO_GROQ_MODEL || 'llama3-8b-8192';

// ─── Platform source tags ──────────────────────────────────────────────────────
const PLATFORM_TAGS = {
  DASHBOARD_SIM: 'dashboard_sim',
  WEB_PRO:       'web_pro',
  WEB_TRADE:     'web_trade',
  PHONE:         'phone',
  EMAIL:         'email',
};

// ─── Auto-gate rules ──────────────────────────────────────────────────────────
// approve: safe improvements  reject: pricing/guardrails  escalate: brand/capability
const AUTO_APPROVE_CATEGORIES = ['tone', 'clarity', 'coaching', 'completeness', 'greeting_variation', 'faq_accuracy'];
const AUTO_REJECT_CATEGORIES  = ['pricing_change', 'guardrail_removal', 'personality_contradiction'];
const ESCALATE_CATEGORIES     = ['capability_claim', 'brand_voice_change', 'money_change', 'new_trade_handling'];

function applyAutoGate(category, confidence) {
  if (AUTO_APPROVE_CATEGORIES.includes(category) && confidence >= 0.7) return 'approved';
  if (AUTO_REJECT_CATEGORIES.includes(category)) return 'rejected';
  if (ESCALATE_CATEGORIES.includes(category)) return 'escalated';
  if (confidence < 0.6) return 'escalated';
  return 'approved';
}

// ─── Rule hierarchy enforcement ────────────────────────────────────────────────
// Founder locks (god-layer) > Self-learned approved > Operator training > Base defaults
// When storing a knowledge entry, the tier field determines priority in brain retrieval.
function getTierForSource(source, founderOverride) {
  if (founderOverride) return 'trained';  // founder = highest (trained tier in DB)
  if (source === 'simulation_batch_eval' || source === 'platform_batch_eval') return 'learned';
  return 'default';
}

// ─── Groq batch eval — ONE call for all items across platforms ─────────────────
async function callGroqBatchEval(items) {
  if (!GROQ_API_KEY) {
    console.warn('[SimEval] No GROQ_API_KEY — skipping batch eval');
    return null;
  }

  const itemSummaries = items.map((item, i) => {
    return `ITEM #${i + 1} (id=${item.id}, platform=${item.source_platform}, trade=${item.trade_category || 'unknown'}):
Customer: "${(item.inquiry_message || item.customer_text || '').slice(0, 300)}"
Hugo: "${(item.hugo_response_text || item.hugo_text || '').slice(0, 500)}"`;
  }).join('\n\n---\n\n');

  const evalPrompt = `You are evaluating Hugo's responses across multiple channels.
Hugo is an Australian AI trade receptionist and real estate assistant for PropOps.

EVALUATE each item for:
1. Tone — professional, Aussie, not robotic? No "mate", no sycophancy.
2. Accuracy — facts correct? No made-up info?
3. Completeness — did Hugo address the full inquiry?
4. Trade-specificity — does it match the context?
5. Missed opportunities — could Hugo have captured more lead info?
6. Pricing compliance — only $69/month (trade) or $99/month (RE). No other prices.
7. Guardrail compliance — Hugo stays in character (no AI reveals).
8. Greeting variation — is the greeting monotonous or appropriately varied?
9. FAQ accuracy — common question answered correctly?

For EACH item, return JSON:
- item_id: the item number (1-indexed)
- verdict: "good" | "needs_improvement" | "bad"
- category: one of [tone, clarity, completeness, trade_specificity, missed_opportunity, pricing_change, guardrail_removal, personality_contradiction, capability_claim, brand_voice_change, coaching, greeting_variation, faq_accuracy, new_trade_handling, money_change]
- confidence: 0.0 to 1.0
- reason: 1-2 sentences
- improvement: specific fix if needed (null if good)
- is_systemic_candidate: true if this mistake likely repeats across channels

Return a JSON array only, no markdown.

ITEMS TO EVALUATE:

${itemSummaries}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000); // 45s for larger batch
    const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: 'You evaluate Hugo AI receptionist responses. Return ONLY valid JSON arrays.' },
          { role: 'user', content: evalPrompt },
        ],
        max_tokens: 3000,
        temperature: 0.3,
      }),
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[SimEval] Groq batch eval failed: ${res.status} ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '';
    const jsonStr = content.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
    const evaluations = JSON.parse(jsonStr);
    return Array.isArray(evaluations) ? evaluations : [evaluations];
  } catch (err) {
    console.error('[SimEval] Groq batch eval error:', err.message);
    return null;
  }
}

// ─── Ingest: widget sessions (web_pro + web_trade) ─────────────────────────────
async function ingestWidgetSessions(since) {
  try {
    const result = await pool.query(
      `SELECT id, messages, metadata, created_at
       FROM hugo_widget_sessions
       WHERE created_at >= $1
         AND messages IS NOT NULL
         AND jsonb_array_length(messages) >= 2
       ORDER BY created_at ASC
       LIMIT 30`,
      [since]
    );

    const items = [];
    for (const row of result.rows) {
      const msgs = row.messages || [];
      // Find first user message and first hugo/assistant message
      const userMsg = msgs.find(m => m.role === 'user' || m.sender === 'user');
      const hugoMsg = msgs.find(m => m.role === 'assistant' || m.sender === 'hugo' || m.sender === 'assistant');
      if (!userMsg || !hugoMsg) continue;

      const domain = row.metadata?.domain || row.metadata?.origin || '';
      const platform = domain.includes('propops.trade') ? PLATFORM_TAGS.WEB_TRADE : PLATFORM_TAGS.WEB_PRO;

      items.push({
        id: `widget_${row.id}`,
        source_platform: platform,
        trade_category: row.metadata?.trade || row.metadata?.trade_type || null,
        inquiry_message: userMsg.content || userMsg.message || '',
        hugo_response_text: hugoMsg.content || hugoMsg.message || '',
        customer_text: userMsg.content || userMsg.message || '',
        hugo_text: hugoMsg.content || hugoMsg.message || '',
        operator_id: row.metadata?.operator_id || null,
        source_ref: `widget_session:${row.id}`,
        created_at: row.created_at,
      });
    }
    return items;
  } catch (err) {
    console.warn('[SimEval] Widget session ingestion error:', err.message);
    return [];
  }
}

// ─── Ingest: voice calls (phone) ───────────────────────────────────────────────
async function ingestVoiceCalls(since) {
  try {
    const result = await pool.query(
      `SELECT id, operator_id, transcript, lead_data, status, created_at
       FROM voice_calls
       WHERE created_at >= $1
         AND transcript IS NOT NULL
         AND status IN ('completed', 'ended')
       ORDER BY created_at ASC
       LIMIT 20`,
      [since]
    );

    const items = [];
    for (const row of result.rows) {
      const transcript = row.transcript || [];
      // Transcript is JSONB array of {role, text} or {speaker, message}
      const turns = Array.isArray(transcript) ? transcript : [];
      const callerTurns = turns.filter(t => t.role === 'user' || t.speaker === 'caller' || t.role === 'caller');
      const hugoTurns = turns.filter(t => t.role === 'assistant' || t.speaker === 'hugo' || t.role === 'hugo');

      if (!callerTurns.length || !hugoTurns.length) continue;

      const callerText = callerTurns.map(t => t.text || t.message || t.content || '').join(' ').slice(0, 400);
      const hugoText = hugoTurns.map(t => t.text || t.message || t.content || '').join(' ').slice(0, 500);

      if (!callerText || !hugoText) continue;

      items.push({
        id: `voice_${row.id}`,
        source_platform: PLATFORM_TAGS.PHONE,
        trade_category: row.lead_data?.trade || null,
        inquiry_message: callerText,
        hugo_response_text: hugoText,
        customer_text: callerText,
        hugo_text: hugoText,
        operator_id: row.operator_id || null,
        source_ref: `voice_call:${row.id}`,
        created_at: row.created_at,
      });
    }
    return items;
  } catch (err) {
    console.warn('[SimEval] Voice call ingestion error:', err.message);
    return [];
  }
}

// ─── Ingest: operator emails (email channel) ───────────────────────────────────
async function ingestEmails(since) {
  try {
    // operator_emails has: subject, body_text, hugo_summary, hugo_draft_reply, hugo_intent
    const result = await pool.query(
      `SELECT id, operator_id, subject, body_text, hugo_summary, hugo_draft_reply, hugo_intent, created_at
       FROM operator_emails
       WHERE created_at >= $1
         AND hugo_draft_reply IS NOT NULL
         AND body_text IS NOT NULL
       ORDER BY created_at ASC
       LIMIT 20`,
      [since]
    );

    const items = [];
    for (const row of result.rows) {
      const customerText = `[Email: ${row.subject || 'No subject'}]\n${(row.body_text || '').slice(0, 400)}`;
      const hugoText = row.hugo_draft_reply || row.hugo_summary || '';
      if (!hugoText) continue;

      items.push({
        id: `email_${row.id}`,
        source_platform: PLATFORM_TAGS.EMAIL,
        trade_category: null,
        inquiry_message: customerText,
        hugo_response_text: hugoText,
        customer_text: customerText,
        hugo_text: hugoText,
        operator_id: row.operator_id || null,
        source_ref: `operator_email:${row.id}`,
        created_at: row.created_at,
      });
    }
    return items;
  } catch (err) {
    console.warn('[SimEval] Email ingestion error:', err.message);
    return [];
  }
}

// ─── Main nightly batch eval function (multi-platform) ─────────────────────────
async function runNightlyBatchEval() {
  const batchId = `batch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  console.log(`[SimEval] Starting multi-platform nightly batch eval: ${batchId}`);

  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h window

  // 1. Fetch existing pending dashboard simulations (original pipeline)
  const pendingResult = await pool.query(
    `SELECT id, operator_id, trade_category, simulation_type, inquiry_message,
            hugo_response_text, response_time_ms, created_at,
            COALESCE(source_platform, 'dashboard_sim') as source_platform
     FROM hugo_sim_outcomes
     WHERE eval_status = 'pending'
       AND created_at >= $1
     ORDER BY created_at ASC
     LIMIT 40`,
    [since]
  );
  const simItems = pendingResult.rows.map(r => ({
    ...r,
    customer_text: r.inquiry_message,
    hugo_text: r.hugo_response_text,
    source_ref: `sim_outcome:${r.id}`,
    _type: 'sim_outcome',
  }));

  // 2. Ingest from all other platforms (parallel)
  const [widgetItems, phoneItems, emailItems] = await Promise.all([
    ingestWidgetSessions(since),
    ingestVoiceCalls(since),
    ingestEmails(since),
  ]);

  console.log(`[SimEval] Ingested: ${simItems.length} sims, ${widgetItems.length} widget, ${phoneItems.length} phone, ${emailItems.length} email`);

  // 3. Combine all items — cap at 80 to keep Groq call manageable
  const allItems = [...simItems, ...widgetItems, ...phoneItems, ...emailItems].slice(0, 80);

  if (allItems.length === 0) {
    console.log('[SimEval] No items to evaluate across any platform');
    return { batch_id: batchId, evaluated: 0, approved: 0, rejected: 0, escalated: 0, by_platform: {} };
  }

  // 4. ONE Groq call for all items
  const evaluations = await callGroqBatchEval(allItems);

  let approved = 0, rejected = 0, escalated = 0;
  const byPlatform = {};

  if (evaluations && evaluations.length > 0) {
    for (const evaluation of evaluations) {
      const itemIndex = (evaluation.item_id || evaluation.sim_id || 1) - 1;
      const item = allItems[itemIndex];
      if (!item) continue;

      const category = evaluation.category || 'tone';
      const confidence = Math.min(1, Math.max(0, parseFloat(evaluation.confidence) || 0.5));
      const reason = (evaluation.reason || '').slice(0, 500);
      const improvement = (evaluation.improvement || '').slice(0, 1000);
      const gateResult = applyAutoGate(category, confidence);
      const platform = item.source_platform || 'dashboard_sim';

      if (gateResult === 'approved') approved++;
      else if (gateResult === 'rejected') rejected++;
      else escalated++;

      byPlatform[platform] = byPlatform[platform] || { approved: 0, rejected: 0, escalated: 0 };
      byPlatform[platform][gateResult]++;

      // Update existing hugo_sim_outcomes rows (dashboard_sim)
      if (item._type === 'sim_outcome') {
        await pool.query(
          `UPDATE hugo_sim_outcomes
           SET eval_status = $1, eval_reason = $2, eval_category = $3,
               eval_confidence = $4, batch_processed_at = NOW(), batch_id = $5,
               source_platform = $6
           WHERE id = $7`,
          [gateResult, reason, category, confidence, batchId, platform, item.id]
        ).catch(err => console.error(`[SimEval] Failed to update sim ${item.id}:`, err.message));

        // Auto-approved → learning loop
        if (gateResult === 'approved' && improvement) {
          await createLearningEntry(item, { improvement, reason }).catch(err =>
            console.error(`[SimEval] Learning entry failed for sim ${item.id}:`, err.message)
          );
        }
      }

      // For non-sim items: write to self_learning_log if needs_improvement or bad
      if (item._type !== 'sim_outcome' && evaluation.verdict !== 'good') {
        await writeSelfLearningLog({
          batchId,
          platform,
          category,
          mistakeDescription: reason,
          proposedFix: improvement,
          isSystemicCandidate: !!evaluation.is_systemic_candidate,
          gateResult,
        }).catch(err =>
          console.warn(`[SimEval] Self-learning log write failed for ${item.source_ref}:`, err.message)
        );
      }
    }
  } else {
    // Groq failed — escalate all sim_outcome items for manual review
    console.warn('[SimEval] Groq eval returned no results — escalating all sims for manual review');
    for (const item of simItems) {
      await pool.query(
        `UPDATE hugo_sim_outcomes
         SET eval_status = 'escalated', eval_reason = 'Automated evaluation unavailable — escalated for manual review',
             batch_processed_at = NOW(), batch_id = $1
         WHERE id = $2`,
        [batchId, item.id]
      ).catch(() => {});
    }
    escalated = simItems.length;
  }

  // 5. Cross-platform systemic pattern detection
  await detectCrossPlatformPatterns(batchId, byPlatform).catch(err =>
    console.warn('[SimEval] Cross-platform pattern detection failed:', err.message)
  );

  // 6. Classic bulk pattern detection (existing, for sim_outcomes)
  const patterns = await detectBulkPatterns(batchId);

  const summary = {
    batch_id: batchId,
    evaluated: allItems.length,
    approved,
    rejected,
    escalated,
    patterns,
    by_platform: byPlatform,
    timestamp: new Date().toISOString(),
  };

  console.log(`[SimEval] Multi-platform batch complete: ${JSON.stringify(summary)}`);

  sendFounderDigestNotification(summary).catch(err =>
    console.warn('[SimEval] Founder digest notification failed:', err.message)
  );

  return summary;
}

// ─── Self-learning log writer ───────────────────────────────────────────────────
async function writeSelfLearningLog({ batchId, platform, category, mistakeDescription, proposedFix, isSystemicCandidate, gateResult }) {
  if (!mistakeDescription || !proposedFix) return;

  const status = gateResult === 'approved' ? 'approved' : 'pending';
  const approvedBy = gateResult === 'approved' ? 'auto' : null;

  await pool.query(
    `INSERT INTO hugo_self_learning_log
       (detected_at, source_platform, category, mistake_description, proposed_fix,
        status, is_systemic, batch_id, approved_at, approved_by)
     VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      platform,
      category,
      mistakeDescription,
      proposedFix || 'No specific fix proposed',
      status,
      isSystemicCandidate || false,
      batchId,
      gateResult === 'approved' ? new Date() : null,
      approvedBy,
    ]
  );
}

// ─── Cross-platform systemic pattern detection ──────────────────────────────────
async function detectCrossPlatformPatterns(batchId, byPlatform) {
  // Find same category appearing across 2+ platforms in this batch
  const platformsHit = Object.keys(byPlatform).filter(p => {
    const stats = byPlatform[p];
    return (stats.rejected || 0) + (stats.escalated || 0) > 0;
  });

  if (platformsHit.length < 2) return;

  // Pull the self_learning_log entries from this batch to find cross-platform matches
  const result = await pool.query(
    `SELECT category, COUNT(DISTINCT source_platform) as platform_count,
            COUNT(*) as total_occurrences,
            array_agg(DISTINCT source_platform) as platforms,
            array_agg(mistake_description ORDER BY detected_at DESC) as descriptions
     FROM hugo_self_learning_log
     WHERE batch_id = $1
       AND status = 'pending'
     GROUP BY category
     HAVING COUNT(DISTINCT source_platform) >= 2`,
    [batchId]
  );

  for (const row of result.rows) {
    // Mark systemic + update times_repeated
    await pool.query(
      `UPDATE hugo_self_learning_log
       SET is_systemic = true, times_repeated = $1
       WHERE batch_id = $2 AND category = $3`,
      [parseInt(row.total_occurrences), batchId, row.category]
    ).catch(() => {});

    console.log(`[SimEval] Systemic pattern detected: ${row.category} across ${row.platforms.join(', ')}`);
  }
}

// ─── Learning loop: approved improvements → hugo_knowledge_entries ──────────────
async function createLearningEntry(sim, evaluation, founderOverride = false) {
  const knowledgeText = evaluation.improvement || evaluation.reason || '';
  if (!knowledgeText || knowledgeText.length < 10) return;

  const tradeSlug = sim.trade_category || 'general';
  const tier = getTierForSource('platform_batch_eval', founderOverride);

  // Generate embedding (lazy-load to avoid circular dep)
  let embedding = null;
  try {
    const { getEmbedding } = require('../routes/hugo-brain');
    embedding = await getEmbedding(knowledgeText);
  } catch { /* non-fatal */ }

  const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;

  const result = await pool.query(
    `INSERT INTO hugo_knowledge_entries
       (operator_id, trade_slug, knowledge_text, confidence, source, validated, embedding, created_at)
     VALUES ($1, $2, $3, $4, 'platform_batch_eval', true, $5::vector, NOW())
     RETURNING id`,
    [sim.operator_id, tradeSlug, knowledgeText, tier, embeddingStr]
  );

  const entryId = result.rows[0]?.id;
  if (entryId && sim._type === 'sim_outcome') {
    await pool.query(
      `UPDATE hugo_sim_outcomes SET learned_at = NOW(), knowledge_entry_id = $1 WHERE id = $2`,
      [entryId, sim.id]
    );
    console.log(`[SimEval] Learning entry ${entryId} created from sim ${sim.id}`);
  }
  return entryId;
}

// ─── Live correction learning (founder real-time, god-layer, NO approval) ────────
async function applyLiveCorrection({ operatorId, triggerText, correctText, context, correctionType }) {
  // Validate inputs
  if (!triggerText || !correctText || correctText.trim().length < 3) {
    throw new Error('correctText required (min 3 chars)');
  }

  const type = correctionType || 'general';
  const isGlobal = !operatorId; // if no operator specified, it's global

  // 1. Store in live_corrections table for audit trail
  const corrResult = await pool.query(
    `INSERT INTO hugo_live_corrections
       (operator_id, correction_type, trigger_text, correct_text, context, source, is_global)
     VALUES ($1, $2, $3, $4, $5, 'founder_live', $6)
     RETURNING id`,
    [operatorId || null, type, triggerText.slice(0, 500), correctText.slice(0, 1000), (context || '').slice(0, 500), isGlobal]
  );
  const correctionId = corrResult.rows[0]?.id;

  // 2. Generate embedding and promote to hugo_knowledge_entries as 'trained' (god-layer)
  let embedding = null;
  try {
    const { getEmbedding } = require('../routes/hugo-brain');
    embedding = await getEmbedding(correctText);
  } catch { /* non-fatal */ }

  const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;

  const entryResult = await pool.query(
    `INSERT INTO hugo_knowledge_entries
       (operator_id, trade_slug, knowledge_text, confidence, source, validated, embedding, created_at)
     VALUES ($1, 'general', $2, 'trained', 'founder_live_correction', true, $3::vector, NOW())
     RETURNING id`,
    [operatorId || null, correctText, embeddingStr]
  );
  const entryId = entryResult.rows[0]?.id;

  // 3. Link back to live_corrections
  if (correctionId && entryId) {
    await pool.query(
      `UPDATE hugo_live_corrections SET knowledge_entry_id = $1 WHERE id = $2`,
      [entryId, correctionId]
    );
  }

  // 4. Write to self_learning_log as auto-approved (audit trail, status: approved, source: founder_live)
  await pool.query(
    `INSERT INTO hugo_self_learning_log
       (detected_at, source_platform, category, mistake_description, times_repeated,
        proposed_fix, status, approved_at, approved_by, knowledge_entry_id)
     VALUES (NOW(), 'dashboard_sim', $1, $2, 1, $3, 'approved', NOW(), 'founder_live', $4)`,
    [
      type,
      `Founder live correction: "${triggerText.slice(0, 200)}"`,
      correctText,
      entryId || null,
    ]
  ).catch(err => console.warn('[SimEval] Self-learning log write failed for live correction:', err.message));

  console.log(`[SimEval] Live correction applied: correction_id=${correctionId}, knowledge_entry_id=${entryId}, global=${isGlobal}`);

  return {
    success: true,
    correction_id: correctionId,
    knowledge_entry_id: entryId,
    tier: 'trained',
    is_global: isGlobal,
    message: 'Correction locked immediately (god-layer authority). Hugo will use the corrected response from the next request.',
  };
}

// ─── Founder correction on sim outcome ─────────────────────────────────────────
async function applyFounderAction(simId, action, correctionText) {
  if (!['approve', 'reject', 'correct'].includes(action)) {
    throw new Error(`Invalid action: ${action}`);
  }

  const evalStatus = action === 'approve' ? 'founder_approved'
                   : action === 'reject' ? 'founder_rejected'
                   : 'founder_corrected';

  await pool.query(
    `UPDATE hugo_sim_outcomes
     SET eval_status = $1, founder_action = $2, founder_correction = $3, founder_acted_at = NOW()
     WHERE id = $4`,
    [evalStatus, action, correctionText || null, simId]
  );

  if (action === 'approve' || action === 'correct') {
    const simResult = await pool.query(
      `SELECT id, operator_id, trade_category, inquiry_message, hugo_response_text FROM hugo_sim_outcomes WHERE id = $1`,
      [simId]
    );
    const sim = simResult.rows[0];
    if (sim) {
      const learningText = action === 'correct' ? correctionText : sim.hugo_response_text;
      // Founder corrections use god-layer (trained tier)
      await createLearningEntry(
        { ...sim, _type: 'sim_outcome' },
        { improvement: learningText, reason: action === 'correct' ? 'Founder correction' : 'Founder approved' },
        true /* founderOverride */
      );
    }
  }

  // Also approve corresponding self_learning_log entry if exists
  if (action === 'approve' || action === 'correct') {
    await pool.query(
      `UPDATE hugo_self_learning_log
       SET status = 'approved', approved_at = NOW(), approved_by = 'founder'
       WHERE status = 'pending'
         AND batch_id IN (SELECT batch_id FROM hugo_sim_outcomes WHERE id = $1)`,
      [simId]
    ).catch(() => {});
  }

  console.log(`[SimEval] Founder ${action} applied to sim ${simId}`);
  return { success: true, eval_status: evalStatus };
}

// ─── Self-learning log: bulk approve safe items ────────────────────────────────
async function bulkApproveSafeItems() {
  // Safe categories = formatting, greeting, FAQ accuracy — no pricing/personality
  const safeCategories = ['tone', 'clarity', 'greeting_variation', 'faq_accuracy', 'completeness', 'coaching'];

  const result = await pool.query(
    `UPDATE hugo_self_learning_log
     SET status = 'approved', approved_at = NOW(), approved_by = 'founder_bulk'
     WHERE status = 'pending'
       AND category = ANY($1)
       AND is_systemic = false
     RETURNING id, source_platform, category`,
    [safeCategories]
  );

  console.log(`[SimEval] Bulk approved ${result.rowCount} safe self-learning log items`);

  // Promote approved entries to knowledge for each approved item
  for (const row of result.rows) {
    const entryResult = await pool.query(
      `SELECT id, mistake_description, proposed_fix FROM hugo_self_learning_log WHERE id = $1`,
      [row.id]
    );
    const entry = entryResult.rows[0];
    if (entry && entry.proposed_fix) {
      await pool.query(
        `INSERT INTO hugo_knowledge_entries
           (operator_id, trade_slug, knowledge_text, confidence, source, validated, created_at)
         VALUES (NULL, 'general', $1, 'learned', 'self_learning_bulk_approve', true, NOW())
         RETURNING id`,
        [entry.proposed_fix]
      ).then(async r => {
        if (r.rows[0]?.id) {
          await pool.query(
            `UPDATE hugo_self_learning_log SET knowledge_entry_id = $1 WHERE id = $2`,
            [r.rows[0].id, row.id]
          );
        }
      }).catch(() => {});
    }
  }

  return { approved_count: result.rowCount, items: result.rows };
}

// ─── Self-learning log: single item approve/reject ─────────────────────────────
async function updateSelfLearningLogStatus(logId, status) {
  if (!['approved', 'rejected'].includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  await pool.query(
    `UPDATE hugo_self_learning_log
     SET status = $1, approved_at = $2, approved_by = 'founder'
     WHERE id = $3`,
    [status, status === 'approved' ? new Date() : null, logId]
  );

  // If approved, promote to knowledge
  if (status === 'approved') {
    const entryResult = await pool.query(
      `SELECT id, proposed_fix FROM hugo_self_learning_log WHERE id = $1`,
      [logId]
    );
    const entry = entryResult.rows[0];
    if (entry?.proposed_fix) {
      await pool.query(
        `INSERT INTO hugo_knowledge_entries
           (operator_id, trade_slug, knowledge_text, confidence, source, validated, created_at)
         VALUES (NULL, 'general', $1, 'learned', 'self_learning_founder_approve', true, NOW())
         RETURNING id`,
        [entry.proposed_fix]
      ).then(async r => {
        if (r.rows[0]?.id) {
          await pool.query(
            `UPDATE hugo_self_learning_log SET knowledge_entry_id = $1 WHERE id = $2`,
            [r.rows[0].id, logId]
          );
        }
      }).catch(() => {});
    }
  }

  return { success: true, status };
}

// ─── Bulk pattern detection (existing, for sim_outcomes) ────────────────────────
async function detectBulkPatterns(batchId) {
  try {
    const result = await pool.query(
      `SELECT trade_category, eval_category, COUNT(*) as cnt,
              array_agg(eval_reason) as reasons
       FROM hugo_sim_outcomes
       WHERE batch_id = $1 AND eval_status IN ('rejected', 'escalated')
       GROUP BY trade_category, eval_category
       HAVING COUNT(*) >= 3
       ORDER BY cnt DESC`,
      [batchId]
    );

    return result.rows.map(row => ({
      trade: row.trade_category,
      category: row.eval_category,
      count: parseInt(row.cnt),
      sample_reasons: (row.reasons || []).slice(0, 3),
    }));
  } catch {
    return [];
  }
}

// ─── Generate founder daily digest data ─────────────────────────────────────────
async function generateFounderDigest() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [totalResult, breakdownResult, escalatedResult, patternsResult, selfLearningResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE eval_status IN ('approved', 'founder_approved')) as approved,
              COUNT(*) FILTER (WHERE eval_status IN ('rejected', 'founder_rejected')) as rejected,
              COUNT(*) FILTER (WHERE eval_status = 'escalated') as escalated
       FROM hugo_sim_outcomes
       WHERE batch_processed_at >= $1`,
      [today.toISOString()]
    ),
    pool.query(
      `SELECT eval_category, COUNT(*) as cnt
       FROM hugo_sim_outcomes
       WHERE batch_processed_at >= $1 AND eval_status IS NOT NULL
       GROUP BY eval_category
       ORDER BY cnt DESC`,
      [today.toISOString()]
    ),
    pool.query(
      `SELECT id, trade_category, inquiry_message, hugo_response_text, eval_reason, eval_category
       FROM hugo_sim_outcomes
       WHERE eval_status = 'escalated' AND batch_processed_at >= $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [today.toISOString()]
    ),
    pool.query(
      `SELECT trade_category, eval_category, COUNT(*) as cnt
       FROM hugo_sim_outcomes
       WHERE batch_processed_at >= $1 AND eval_status IN ('rejected', 'escalated')
       GROUP BY trade_category, eval_category
       HAVING COUNT(*) >= 3`,
      [today.toISOString()]
    ),
    pool.query(
      `SELECT source_platform, COUNT(*) as cnt, COUNT(*) FILTER (WHERE is_systemic) as systemic
       FROM hugo_self_learning_log
       WHERE detected_at >= $1 AND status = 'pending'
       GROUP BY source_platform`,
      [today.toISOString()]
    ),
  ]);

  const stats = totalResult.rows[0] || {};
  return {
    total: parseInt(stats.total || 0),
    approved: parseInt(stats.approved || 0),
    rejected: parseInt(stats.rejected || 0),
    escalated: parseInt(stats.escalated || 0),
    breakdown: breakdownResult.rows,
    escalated_items: escalatedResult.rows,
    patterns: patternsResult.rows,
    self_learning_pending: selfLearningResult.rows,
    date: today.toISOString().split('T')[0],
  };
}

// ─── Founder digest notification ────────────────────────────────────────────────
async function sendFounderDigestNotification(summary) {
  if (summary.evaluated === 0) {
    console.log('[SimEval] No items evaluated — skipping founder digest');
    return;
  }

  const founderResult = await pool.query(
    `SELECT id, email, name FROM users WHERE is_admin = true LIMIT 1`
  );
  const founder = founderResult.rows[0];
  if (!founder || !founder.email) {
    console.warn('[SimEval] No founder found for digest notification');
    return;
  }

  const platformSummary = Object.entries(summary.by_platform || {})
    .map(([p, s]) => `${p}: ✅${s.approved || 0} ❌${s.rejected || 0} ⚠️${s.escalated || 0}`)
    .join(' | ');

  try {
    await pool.query(
      `INSERT INTO dashboard_alerts (title, body, severity, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [
        `Hugo Multi-Platform Training: ${summary.evaluated} items evaluated`,
        `${summary.approved} approved ✅ | ${summary.rejected} rejected ❌ | ${summary.escalated} need your review ⚠️` +
        (platformSummary ? `\n\nBy platform: ${platformSummary}` : '') +
        (summary.patterns?.length ? `\n\nBulk patterns: ${summary.patterns.map(p => `${p.trade} ${p.category} ×${p.count}`).join(', ')}` : ''),
        summary.escalated > 0 ? 'warning' : 'info',
      ]
    );
    console.log(`[SimEval] Founder dashboard alert created`);
  } catch (err) {
    console.warn('[SimEval] Failed to create dashboard alert:', err.message);
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.log('[SimEval] No RESEND_API_KEY — skipping email digest');
    return;
  }

  const escalatedNote = summary.escalated > 0
    ? `<p style="color:#f59e0b;font-weight:bold;">⚠️ ${summary.escalated} item${summary.escalated > 1 ? 's' : ''} need your review — <a href="https://propopspro.polsia.app/founder" style="color:#818cf8;">open Founder Dashboard</a></p>`
    : '<p style="color:#10b981;">All clear — nothing needs your attention today.</p>';

  const patternNote = summary.patterns?.length > 0
    ? `<p><strong>Bulk patterns:</strong> ${summary.patterns.map(p => `${p.trade} ${p.category} ×${p.count}`).join(', ')}</p>`
    : '';

  const platformNote = platformSummary
    ? `<p style="font-size:0.8rem;color:#9ca3af;"><strong>By platform:</strong> ${platformSummary}</p>`
    : '';

  const html = `<div style="font-family:system-ui,sans-serif;max-width:500px;">
    <h2 style="color:#f59e0b;">🎓 Hugo Multi-Platform Training Digest</h2>
    <p>Hugo was evaluated across <strong>${Object.keys(summary.by_platform || {}).length} platform(s)</strong> — <strong>${summary.evaluated}</strong> total items.</p>
    <table style="width:100%;border-collapse:collapse;margin:1rem 0;">
      <tr><td style="padding:6px 12px;background:#10b981;color:white;border-radius:4px 0 0 4px;">✅ ${summary.approved} approved</td>
          <td style="padding:6px 12px;background:#ef4444;color:white;">❌ ${summary.rejected} rejected</td>
          <td style="padding:6px 12px;background:#f59e0b;color:white;border-radius:0 4px 4px 0;">⚠️ ${summary.escalated} escalated</td></tr>
    </table>
    ${escalatedNote}
    ${patternNote}
    ${platformNote}
    <p style="font-size:0.85rem;color:#9ca3af;">Self-Learning Log: <a href="https://propopspro.polsia.app/founder" style="color:#818cf8;">view → Self-Learning Log panel</a></p>
  </div>`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendApiKey}` },
      body: JSON.stringify({
        from: 'Hugo <hugo@propops.pro>',
        to: [founder.email],
        subject: `Hugo Training: ${summary.evaluated} items across ${Object.keys(summary.by_platform || {}).length} platforms — ${summary.escalated > 0 ? `${summary.escalated} need review` : 'all clear'}`,
        html,
      }),
    });
    clearTimeout(timer);
    console.log(`[SimEval] Founder digest email sent to ${founder.email}`);
  } catch (err) {
    console.warn('[SimEval] Digest email send failed:', err.message);
  }
}

module.exports = {
  runNightlyBatchEval,
  applyFounderAction,
  applyLiveCorrection,
  bulkApproveSafeItems,
  updateSelfLearningLogStatus,
  generateFounderDigest,
  createLearningEntry,
  detectBulkPatterns,
  sendFounderDigestNotification,
  ingestWidgetSessions,
  ingestVoiceCalls,
  ingestEmails,
  writeSelfLearningLog,
  PLATFORM_TAGS,
};
