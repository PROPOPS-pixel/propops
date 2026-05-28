/**
 * Hugo Widget API — public endpoints for the self-hosted chat widget.
 *
 * No auth required. Session identified by a short-lived session_id cookie
 * or passed in the request body. Conversations stored in hugo_widget_sessions.
 *
 * POST /api/hugo-widget/chat     — send a message, get Hugo's reply
 * POST /api/hugo-widget/stt      — speech-to-text (base64 audio → transcript)
 * POST /api/hugo-widget/tts      — text-to-speech (text → audio/mpeg stream)
 * GET  /api/hugo-widget/history  — last N messages for a session
 *
 * Phase 3C: Mismatch detection runs AFTER Hugo generates a response but BEFORE
 * it is sent to the visitor. Detected price mismatches are auto-corrected in the
 * reply and logged to content_mismatches + dashboard_alerts.
 */

const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const hugo = require('../services/hugo');
const { extractQuoteMarker, createWidgetQuote, buildContextHeader } = hugo;
const reAgent = require('../services/re-agent');
const { RE_AGENT_SYSTEM_PROMPT } = require('../services/re-agent-prompt');
const { getLandingPageContent } = require('../services/landing-page-sync');
const { normalizePhone, findNetworkLeadByPhone } = require('../db/phone');
// File (global in Node 20+) used for STT audio upload

const openai = new OpenAI();
// Uses OPENAI_BASE_URL + OPENAI_API_KEY from env

// Email-first lead capture: fire promo email the moment Hugo collects an email address
const { sendHugoPromoEmail } = require('../services/notifications');

// Brand family — single source of truth for PropOps product knowledge
const { BRAND_FAMILY } = require('../constants/brandFamily');

// ─── Brain service integration ────────────────────────────────────────────────
// Lazy-require to avoid circular dep at module load time.
// getEmbedding + searchTrainingData are imported from hugo-brain for vector-enriched
// training context injection into the widget system prompt.

async function fetchBrainTrainingExamples(userMsg, businessType, limit = 8) {
  try {
    // Skip vector search for simple greetings — saves ~200ms+ on first message
    const simpleGreetings = /^\s*(hi|hey|hello|g'?day|yo|sup|howdy|good\s+(morning|afternoon|evening))\s*[!.?]?\s*$/i;
    if (simpleGreetings.test(userMsg)) return [];

    const { getEmbedding } = require('./hugo-brain');
    const embedding = await getEmbedding(userMsg);
    if (!embedding) return [];
    // Reuse the module-level pool instead of creating a new one per request
    const embeddingStr = `[${embedding.join(',')}]`;
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
    // pgvector not ready yet or no embeddings — non-fatal, widget still works
    return [];
  }
}

// Format training examples for injection into system prompt
function formatTrainingInjection(examples) {
  if (!examples || examples.length === 0) return '';
  const lines = examples.slice(0, 8).map((row, i) => {
    const resp = (() => {
      try { const p = JSON.parse(row.ai_response); return p.hugo_response || p.message || row.ai_response; } catch { return row.ai_response; }
    })();
    return `Example [${row.conversation_type || row.business_type}]: Customer: "${row.customer_message.slice(0, 200)}" → Hugo: "${String(resp).slice(0, 200)}"`;
  }).join('\n');
  return `\n\n### TRAINING EXAMPLES (calibrate voice from these):\n${lines}`;
}

// ─── Dual-path AI routing (mirrors hugo-voice.js) ────────────────────────────
// Primary: Agent API with Bearer auth (product AI, no daily token limit)
// Fallback: OpenAI-format endpoint with task routing signal
const POLSIA_API_URL = process.env.POLSIA_API_URL || 'https://polsia.com/api/proxy/ai';
const POLSIA_OPENAI_URL = process.env.OPENAI_BASE_URL || 'https://polsia.com/ai/openai/v1';
const POLSIA_API_KEY = process.env.POLSIA_API_KEY;

const { pool } = require('../db/index');

// ─── Phase 3C: Mismatch detection ────────────────────────────────────────────
//
// Scans Hugo's response for dollar amounts that differ from the live
// landing_page_content value for `monthly_price`. When found:
//   1. Auto-corrects the response (replaces wrong price before visitor sees it)
//   2. Logs to content_mismatches table
//   3. Fires a dashboard_alerts row for admin visibility
//
// Fails silently — never blocks the chat response on DB error.
// Only checks the tradie domain price (propops.trade monthly_price).

const DOLLAR_RE = /\$(\d{2,4})(?:\/(?:mo(?:nth)?|month|mth|yr?(?:ear)?))?\b/gi;

/**
 * Check Hugo's response for price mismatches vs live landing page data.
 * Returns the (possibly corrected) response text.
 *
 * @param {string} hugoResponse  - Raw AI reply before sending to visitor
 * @param {string} domain        - 'propops.trade' | 'propops.pro' | null
 * @param {string} conversationId - session_id for logging
 * @param {object|null} landingData - Already-fetched landing page content (or null)
 */
async function checkAndCorrectMismatches(hugoResponse, domain, conversationId, landingData) {
  try {
    // Check both trade and pro domains (previously only trade)
    if (!hugoResponse) return hugoResponse;

    // HARD-CODED canonical prices — DB is supplementary, not required
    const CANONICAL_PRICES = { 'propops.trade': 69, 'propops.pro': 99 };
    const effectiveDomain = domain || 'propops.trade';
    const hardCodedPrice = CANONICAL_PRICES[effectiveDomain] || 69;

    // Use passed landingData or fetch from DB (supplementary confirmation only)
    let content = landingData;
    if (!content) {
      const { getLandingPageContent } = require('../services/landing-page-sync');
      content = await getLandingPageContent(effectiveDomain).catch(() => null);
    }

    // Extract canonical monthly price: hard-coded constant wins, DB confirms
    const dbPrice = content?.monthly_price
      || content?.pricing?.monthly_price
      || content?.pricing?.early_bird_monthly
      || content?.pricing?.standard_monthly;
    const monthlyPrice = hardCodedPrice || dbPrice;
    if (!monthlyPrice) return hugoResponse;

    // Normalise: strip $ and /mo suffix, get plain number string e.g. "69"
    const canonicalNum = String(monthlyPrice).replace(/^\$/, '').replace(/\/.*$/, '').trim();
    if (!canonicalNum || isNaN(Number(canonicalNum))) return hugoResponse;

    const canonicalFormatted = `$${canonicalNum}`;

    // Find all dollar amounts Hugo mentioned
    const APPROVED_AMOUNTS = [69, 99]; // Only approved PropOps subscription prices
    const mentionedPrices = [];
    let m;
    const re = /\$(\d{2,4})\b/g;
    while ((m = re.exec(hugoResponse)) !== null) {
      const num = parseInt(m[1], 10);
      // Flag if: looks like PropOps pricing ($29–$499), NOT an approved price, NOT clearly a job quote (>$500)
      if (num >= 29 && num <= 499 && !APPROVED_AMOUNTS.includes(num) && String(num) !== canonicalNum) {
        mentionedPrices.push({ match: m[0], num: String(num) });
      }
    }

    if (mentionedPrices.length === 0) return hugoResponse;

    // Deduplicate
    const uniqueWrong = [...new Set(mentionedPrices.map(p => p.match))];
    let corrected = hugoResponse;

    for (const wrongPrice of uniqueWrong) {
      // Auto-correct: swap wrong price for canonical price in response
      corrected = corrected.split(wrongPrice).join(canonicalFormatted);

      // Log mismatch (non-blocking)
      pool.query(
        `INSERT INTO content_mismatches
           (conversation_id, content_key, hugo_quoted, actual_value, domain, auto_corrected)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [conversationId || null, 'monthly_price', wrongPrice, canonicalFormatted, domain || 'propops.trade']
      ).catch(e => console.warn('[Hugo Widget] content_mismatches insert failed:', e.message));

      // Fire dashboard alert (non-blocking)
      pool.query(
        `INSERT INTO dashboard_alerts (message, severity)
         VALUES ($1, 'warning')`,
        [`⚠️ Hugo was quoting ${wrongPrice} but landing page says ${canonicalFormatted} — auto-corrected in session ${conversationId || 'unknown'}`]
      ).catch(e => console.warn('[Hugo Widget] dashboard_alerts insert failed:', e.message));

      console.log(`[Hugo Widget] Mismatch corrected: Hugo said ${wrongPrice}, landing page says ${canonicalFormatted} (session: ${conversationId})`);
    }

    return corrected;
  } catch (err) {
    // Never block chat on mismatch detection failure
    console.warn('[Hugo Widget] Mismatch detection error (non-fatal):', err.message);
    return hugoResponse;
  }
}

// ─── Domain detection ─────────────────────────────────────────────────────────
//
// Detects which PropOps domain the widget is loaded on, based on the
// Origin or Referer header sent by the browser.
// Returns: 'propops.trade' | 'propops.pro' | null

function detectDomain(req) {
  const origin = req.headers['origin'] || req.headers['referer'] || '';
  if (origin.includes('hugopays.pro')) return 'hugopays.pro';
  if (origin.includes('propops.trade')) return 'propops.trade';
  if (origin.includes('propops.pro')) return 'propops.pro';
  return null; // Unknown — caller defaults to tradie context
}

// ─── Visitor tradie signal detection ──────────────────────────────────────────
//
// Scans the visitor's current message AND conversation history for signals
// that the visitor IS a tradie (or is looking for trade work / leads).
// When detected, Hugo should switch to Tradie persona regardless of domain.
//
// Principle: Visitor persona > operator persona. If the VISITOR says they're
// a tradie, Hugo becomes a tradie agent and pitches PropOps directly.

const TRADIE_TRADE_NAMES = [
  'plumber', 'plumbing', 'sparky', 'electrician', 'chippie', 'chippy',
  'bricklayer', 'brickie', 'carpenter', 'carpentry', 'painter', 'painting',
  'tiler', 'tiling', 'landscaper', 'landscaping', 'cleaner', 'cleaning',
  'hvac', 'roofer', 'roofing', 'handyman', 'concreter', 'concretor',
  'fencer', 'fencing', 'plasterer', 'plastering', 'glazier', 'glazing',
  'welder', 'welding', 'locksmith', 'flooring', 'arborist', 'tree service',
  'pool cleaner', 'gas fitter', 'gasfitter', 'builder', 'building',
  'window cleaner', 'upholsterer', 'gardener', 'gardening',
];

const TRADIE_INTENT_PHRASES = [
  'i need leads', 'looking for leads', 'get more leads', 'find leads',
  'looking for a tradie', 'need someone to help', 'need a tradie',
  'i\'m a tradie', 'im a tradie', 'i am a tradie',
  'are you for tradies', 'do you work with tradies',
  'missing calls', 'no time to answer', 'too busy to answer',
  'on the tools', 'on site', 'job site', 'reno', 'renovation',
  'building work', 'quotes take too long',
  'hipages', 'hi pages', 'service seeking', 'serviceseeking', 'airtasker',
  'do you work with', 'are you for',
];

// Match "I'm a <trade>" / "I am a <trade>" / "im a <trade>" patterns
const IM_A_TRADE_RE = /\b(?:i'?m|i am|im)\s+a\s+(plumber|sparky|electrician|chippie|chippy|bricklayer|brickie|carpenter|painter|tiler|landscaper|cleaner|roofer|handyman|concreter|fencer|plasterer|glazier|welder|locksmith|builder|arborist|gardener|gas\s*fitter|pool\s*cleaner|window\s*cleaner|upholsterer)\b/i;

// Match "I need a <trade>" / "find me a <trade>" / "can you find me a <trade>"
const NEED_A_TRADE_RE = /\b(?:need|find|looking for|get|want)\s+(?:me\s+)?a\s+(plumber|sparky|electrician|chippie|chippy|bricklayer|brickie|carpenter|painter|tiler|landscaper|cleaner|roofer|handyman|concreter|fencer|plasterer|glazier|welder|locksmith|builder|arborist|gardener|gas\s*fitter|pool\s*cleaner|window\s*cleaner|upholsterer)\b/i;

/**
 * Detect if the visitor is a tradie or is asking about trade services.
 * Scans both the current message and conversation history.
 *
 * Returns: { isTradie: boolean, signal: string | null }
 */
function detectTradieVisitor(currentMsg, history) {
  const textsToScan = [currentMsg];
  // Also scan recent user messages in history (last 6 user messages)
  if (Array.isArray(history)) {
    const userMsgs = history.filter(m => m.role === 'user').slice(-6);
    textsToScan.push(...userMsgs.map(m => m.content));
  }

  const combined = textsToScan.join(' ').toLowerCase();

  // Check "I'm a <trade>" pattern (strongest signal)
  const imMatch = combined.match(IM_A_TRADE_RE);
  if (imMatch) {
    return { isTradie: true, signal: `visitor_identity:${imMatch[1]}` };
  }

  // Check "I need a <trade>" pattern (looking for a tradie = they ARE a tradie or need one)
  const needMatch = combined.match(NEED_A_TRADE_RE);
  if (needMatch) {
    return { isTradie: true, signal: `trade_request:${needMatch[1]}` };
  }

  // Check intent phrases
  for (const phrase of TRADIE_INTENT_PHRASES) {
    if (combined.includes(phrase)) {
      return { isTradie: true, signal: `intent:${phrase}` };
    }
  }

  // Check standalone trade name mentions (weaker signal — need at least 1 trade keyword
  // AND some business/service context to avoid false positives from property buyers
  // asking about renovation)
  const businessContext = /\b(leads?|calls?|customers?|business|jobs?|work|trade|tradie|service|booking|enquir|inquir|portal|answer|missed|quote|pricing|\$69|\$999|propops|sign.?up|free trial)\b/i;
  if (businessContext.test(combined)) {
    for (const trade of TRADIE_TRADE_NAMES) {
      if (combined.includes(trade)) {
        return { isTradie: true, signal: `trade_mention:${trade}` };
      }
    }
  }

  return { isTradie: false, signal: null };
}

// ─── FAQ cache lookup ─────────────────────────────────────────────────────────
//
// Checks for a Hugo-fied cached answer to common industry FAQs.
// Falls back gracefully if the table doesn't exist yet.
// Returns null if no match (caller falls through to AI).

const FAQ_CACHE_TTL_HOURS = 168; // 7 days

async function lookupFaqCache(userMsg, domain) {
  try {
    const result = await pool.query(
      `SELECT answer FROM hugo_faq_cache
       WHERE domain = $1
         AND lower($2) LIKE lower(pattern)
         AND is_active = true
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY priority ASC
       LIMIT 1`,
      [domain || 'propops.trade', userMsg]
    );
    if (result.rows.length > 0) {
      console.log('[Hugo Widget] FAQ cache hit');
      return result.rows[0].answer;
    }
    return null;
  } catch (err) {
    // Table may not exist yet — fail silently, continue to AI
    if (!err.message.includes('does not exist')) {
      console.warn('[Hugo Widget] FAQ cache lookup error:', err.message);
    }
    return null;
  }
}

// ─── Location Intelligence ────────────────────────────────────────────────────
//
// Extracts suburb/postcode mentions from visitor message text and looks them up
// in hugo_location_data. Returns a location context object or null.
//
// Lookup strategy (in order):
//   1. 4-digit postcode match (most precise)
//   2. Exact suburb name match (case-insensitive)
//   3. Partial suburb name match for multi-word suburbs (e.g. "Penrith" → "Penrith CBD")
//
// Fails silently — if DB lookup errors, Hugo still responds, just without location context.

const SUBURB_SCAN_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'have', 'this', 'from', 'they', 'will',
  'what', 'your', 'been', 'when', 'there', 'some', 'into', 'more', 'very',
  'just', 'also', 'back', 'only', 'come', 'over', 'know', 'like', 'time',
  'help', 'need', 'want', 'work', 'call', 'sure', 'look', 'here', 'how',
  'can', 'you', 'are', 'is', 'in', 'it', 'to', 'of', 'a', 'an',
  'at', 'as', 'be', 'by', 'do', 'no', 'so', 'up', 'or', 'on', 'if',
  'hi', 'hey', 'get', 'has', 'had', 'his', 'her', 'him', 'but', 'not',
  'all', 'out', 'who', 'use', 'our', 'new', 'one', 'two', 'job', 'day',
  'old', 'any', 'see', 'way', 'now', 'may', 'did', 'got',
]);

/**
 * Look up location context from a visitor message.
 * Returns { suburb, postcode, region, state, metro_area, trade_demand_notes,
 *           re_market_notes, drive_zone } or null if not found / DB unavailable.
 */
async function lookupSuburbLocation(message) {
  if (!message || typeof message !== 'string') return null;

  const msg = message.trim();

  try {
    // ── Step 1: 4-digit postcode scan ────────────────────────────────────────
    const postcodeMatch = msg.match(/\b(\d{4})\b/);
    if (postcodeMatch) {
      const pc = postcodeMatch[1];
      const r = await pool.query(
        `SELECT suburb, postcode, region, state, metro_area, trade_demand_notes, re_market_notes, drive_zone
         FROM hugo_location_data
         WHERE postcode = $1
         LIMIT 1`,
        [pc]
      );
      if (r.rows.length > 0) {
        console.log(`[Hugo Location] Postcode match: ${pc} → ${r.rows[0].suburb}, ${r.rows[0].region}`);
        return r.rows[0];
      }
    }

    // ── Step 2: Extract candidate words/phrases from message ─────────────────
    // Build 1-3 word phrases for matching (suburb names are 1-3 words)
    const words = msg
      .replace(/[^a-zA-Z\s]/g, ' ')   // strip punctuation/numbers
      .split(/\s+/)
      .filter(w => w.length > 2 && !SUBURB_SCAN_STOP_WORDS.has(w.toLowerCase()));

    if (words.length === 0) return null;

    // Try 3-word phrases first (e.g. "Bondi Beach NSW"), then 2-word, then 1-word
    const candidates = [];
    for (let len = Math.min(3, words.length); len >= 1; len--) {
      for (let i = 0; i <= words.length - len; i++) {
        candidates.push(words.slice(i, i + len).join(' '));
      }
    }

    if (candidates.length === 0) return null;

    // ── Step 3: Exact suburb name match ──────────────────────────────────────
    for (const phrase of candidates) {
      const r = await pool.query(
        `SELECT suburb, postcode, region, state, metro_area, trade_demand_notes, re_market_notes, drive_zone
         FROM hugo_location_data
         WHERE lower(suburb) = lower($1)
         LIMIT 1`,
        [phrase]
      );
      if (r.rows.length > 0) {
        console.log(`[Hugo Location] Exact suburb match: "${phrase}" → ${r.rows[0].region}, ${r.rows[0].metro_area}`);
        return r.rows[0];
      }
    }

    return null;
  } catch (err) {
    // Non-blocking — table may not exist yet or DB unreachable
    if (!err.message.includes('does not exist')) {
      console.warn('[Hugo Location] Lookup error (non-fatal):', err.message);
    }
    return null;
  }
}

/**
 * Call the Polsia AI proxy with dual-path fallback for widget chat:
 *   Path 1: Agent API (Anthropic Messages format) with Bearer auth → product AI, no daily limit
 *   Path 2: OpenAI format with task:'widget-chat' routing → signals non-utility usage
 *   Fallback: Template responses when both AI paths are rate-limited
 *
 * Returns the raw AI text response OR null if AI unavailable (caller handles template).
 */
async function callWidgetAI(messages) {
  const systemContent = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));

  // Path 1: Agent API with x-api-key auth (Anthropic Messages format — product AI, no daily limit)
  if (POLSIA_API_KEY) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(`${POLSIA_API_URL}/v1/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': POLSIA_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-20250514',
          max_tokens: 400,
          system: systemContent,
          messages: chatMessages,
        }),
      });

      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        const text = (data.content && data.content[0]?.text) || '';
        console.log('[Hugo Widget] AI path 1 (Agent API Bearer) succeeded');
        return text.trim();
      }

      const errText = await res.text().catch(() => '');
      console.warn(`[Hugo Widget] Path 1 failed: ${res.status} ${errText.slice(0, 150)} — trying path 2`);
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn('[Hugo Widget] Path 1 timed out — trying path 2');
      } else {
        console.warn('[Hugo Widget] Path 1 error:', err.message, '— trying path 2');
      }
    }
  }

  // Path 2: OpenAI format with task field (signals product AI usage)
  try {
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), 10000);

    const openaiMessages = [
      { role: 'system', content: systemContent },
      ...chatMessages,
    ];

    const headers2 = { 'Content-Type': 'application/json' };
    if (POLSIA_API_KEY) {
      headers2['x-api-key'] = POLSIA_API_KEY;
      headers2['X-Task'] = 'widget-chat';
    }

    const res2 = await fetch(`${POLSIA_OPENAI_URL}/chat/completions`, {
      method: 'POST',
      signal: controller2.signal,
      headers: headers2,
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        task: 'widget-chat',
        max_tokens: 400,
        temperature: 0.7,
        messages: openaiMessages,
      }),
    });

    clearTimeout(timer2);

    if (res2.ok) {
      const data2 = await res2.json();
      const text2 = data2.choices?.[0]?.message?.content || '';
      console.log('[Hugo Widget] AI path 2 (OpenAI task:widget-chat) succeeded');
      return text2.trim();
    }

    const errBody = await res2.text().catch(() => '');
    console.warn(`[Hugo Widget] Path 2 failed: ${res2.status} ${errBody.slice(0, 150)}`);
  } catch (err) {
    console.warn('[Hugo Widget] Path 2 error:', err.message);
  }

  // Both paths failed — return null (caller uses template fallback)
  return null;
}

/**
 * Intelligent template fallback when AI is rate-limited.
 * Covers all common landing page visitor intents with natural, varied responses.
 * Uses the same product knowledge Hugo's AI would use.
 *
 * When `history` is provided and non-empty, this is a CONTINUATION — Hugo
 * must never re-introduce himself. Responses become contextual follow-ups.
 */
function getTemplateFallback(userMsg, history) {
  const msg = (userMsg || '').toLowerCase().trim();
  const isContinuation = Array.isArray(history) && history.length > 0;

  // ─── Trade-related queries ──────────────────────────────────────────────────
  const trades = {
    plumber: "No worries! For plumbing jobs, give us a call on **02 5301 0002** and I'll get the details sorted — or tell me here what you need (e.g., blocked drain, hot water, leak) and I'll pass it to the team.",
    electrician: "Sparky needed? Call **02 5301 0002** or tell me what's going on (power outage, switchboard, lights, etc.) and I'll get someone onto it.",
    sparky: "Sparky needed? Call **02 5301 0002** or tell me what's going on (power outage, switchboard, lights, etc.) and I'll get someone onto it.",
    painter: "Need a painter? Call **02 5301 0002** or let me know what needs doing (interior, exterior, how many rooms) and I'll connect you with the right tradie.",
    cleaner: "Cleaning job? Call **02 5301 0002** or tell me what type (bond clean, regular domestic, spring clean) and I'll sort a tradie for you.",
    carpenter: "Carpentry work? Call **02 5301 0002** or describe what you need (decking, pergola, built-ins) and I'll find the right person.",
    roofer: "Roof trouble? Call **02 5301 0002** or tell me what's happening (leak, gutters, storm damage) and I'll get help organised.",
    roof: "Roof trouble? Call **02 5301 0002** or tell me what's happening (leak, gutters, storm damage) and I'll get help organised.",
    landscaper: "Garden work? Call **02 5301 0002** or let me know what you're after (lawn, garden design, retaining wall) and I'll connect you.",
    garden: "Garden work? Call **02 5301 0002** or let me know what you're after (lawn, garden design, retaining wall) and I'll connect you.",
    tiler: "Tiling job? Call **02 5301 0002** or tell me what you need (bathroom, kitchen, outdoor, floor or wall) and I'll get the right person.",
    concreter: "Concrete work? Call **02 5301 0002** or describe what you're after (driveway, slab, path, footings) and I'll sort it.",
    fencer: "Fencing needed? Call **02 5301 0002** or let me know the details (type, height, length) and I'll connect you with the right tradie.",
    handyman: "Handyman job? Call **02 5301 0002** or describe what needs doing and I'll find the right person for it.",
  };

  for (const [trade, response] of Object.entries(trades)) {
    if (msg.includes(trade)) {
      return response;
    }
  }

  // ─── Location / suburb mentions (continuation context) ──────────────────────
  // If user mentions a suburb/location and there's prior context about a trade,
  // acknowledge the location and continue the trade thread.
  if (isContinuation && (msg.includes('suburb') || msg.includes('area') || msg.includes('near') || msg.includes('around') || msg.includes('in sydney') || msg.includes('in melbourne') || msg.includes('in brisbane') || msg.includes('in perth') || msg.includes('in adelaide') || /\b(hills|park|bay|vale|heights|creek|beach|point|field|wood|bury|ville|dale|town|side)\b/.test(msg))) {
    const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
    const lastMsg = (lastAssistant?.content || '').toLowerCase();
    const tradeKeywords = ['plumber', 'painter', 'electrician', 'sparky', 'carpenter', 'roofer', 'landscaper', 'tiler', 'concreter', 'fencer', 'handyman', 'cleaner'];
    const activeTrade = tradeKeywords.find(t => lastMsg.includes(t));

    if (activeTrade) {
      return `Got it! To connect you with a ${activeTrade} in that area, can you tell me a bit about the job? What needs doing? Or call **02 5301 0002** and I'll sort it quickly over the phone 🤙`;
    }
    return "Thanks for that! To match you with the right tradie in your area, what kind of work do you need done? (e.g., plumbing, painting, carpentry) 🤙";
  }

  // ─── Trial / pricing / signup ───────────────────────────────────────────────
  if (msg.includes('trial') || msg.includes('free') || msg.includes('14 day') || msg.includes('try') || msg.includes('sign up') || msg.includes('signup') || msg.includes('start')) {
    return "Great news — PropOps has a **14-day free trial**, no credit card required. Just sign up and you're in. Takes about 5 minutes to set up.\n\nHere's what you get:\n• AI receptionist (that's me!) answering your calls 24/7\n• Instant quoting for your customers\n• Job tracking from enquiry to payment\n• Follow-up on every lead automatically\n\nWorst case, you wasted 5 minutes signing up. Best case, you never miss a $3,000 job again. Head to **propops.pro** to start! 🤙";
  }

  if (msg.includes('price') || msg.includes('cost') || msg.includes('how much') || msg.includes('pricing') || msg.includes('subscription') || msg.includes('plan')) {
    return "PropOps is **$69/month** (or save with the annual plan at $999/year).\n\nFor that you get:\n• AI receptionist answering calls + chat 24/7\n• Instant quoting & job booking\n• Pipeline tracking from lead to payment\n• Auto follow-up on every enquiry\n\nTo put it in perspective — one missed job pays for a year of PropOps. And there's a **14-day free trial — no credit card required**. Just start for free. Cancel anytime! 🤙";
  }

  if (msg.includes('quote') || msg.includes('how long') || msg.includes('estimate')) {
    return "For a quick quote, tell me:\n1. What trade you need (plumber, sparky, painter, etc.)\n2. What the job is\n3. Your suburb\n\nOr call **02 5301 0002** and I'll sort it over the phone — usually takes about 60 seconds!";
  }

  // ─── Onboarding / help / how it works ───────────────────────────────────────
  if (msg.includes('onboard') || msg.includes('on board') || msg.includes('set up') || msg.includes('setup') || msg.includes('get started') || msg.includes('how do i') || msg.includes('how does') || msg.includes('how it works') || msg.includes('what is') || msg.includes('what do you do') || msg.includes('explain')) {
    return "PropOps is an AI receptionist for tradies. Here's how it works:\n\n1. **Sign up** (5 min, free trial)\n2. **Tell me about your trade** — I learn your services, pricing, service area\n3. **I answer your calls + chats** — 24/7, in your voice, booking jobs while you're on the tools\n4. **You get jobs** — quoted, booked, and tracked from enquiry to payment\n\nThink of me as your full-time receptionist who never takes a day off, never misses a call, and costs less than a single missed job. Want to give it a go? 🤙";
  }

  // ─── Emergency / urgent ─────────────────────────────────────────────────────
  if (msg.includes('emergency') || msg.includes('urgent') || msg.includes('asap') || msg.includes('burst') || msg.includes('flood') || msg.includes('leak')) {
    return "Sounds urgent! For emergencies, call **02 5301 0002** right now — I'll flag it as priority and get someone to you ASAP. Lines are open 24/7.";
  }

  // ─── Phone / contact ────────────────────────────────────────────────────────
  if (msg.includes('phone') || msg.includes('call') || msg.includes('number') || msg.includes('contact') || msg.includes('speak to') || msg.includes('talk to')) {
    return "You can reach us on **02 5301 0002** — I answer the phone too! Usually quicker for urgent stuff. Or keep chatting here — I'm happy either way 🤙";
  }

  // ─── Greetings ──────────────────────────────────────────────────────────────
  if (msg.includes('hello') || msg.includes('hey') || msg.includes('g\'day') || msg.includes('good morning') || msg.includes('good afternoon') || msg.includes('good evening') || msg.match(/^\s*hi\s*[!.]?\s*$/)) {
    if (isContinuation) {
      // Direct to contact capture — no filler
      return "What's your email so I can send you details?";
    }
    return "G'day! I'm Hugo. Need a tradie, or want to join the PropOps network?";
  }

  // ─── Bored / casual / small talk ────────────────────────────────────────────
  if (msg.includes('bored') || msg.includes('nothing') || msg.includes('just chatting') || msg.includes('just looking') || msg.includes('browsing')) {
    if (isContinuation) {
      return "Ha! No worries. If you need a tradie (plumber, sparky, painter — 22 trades covered), I can get you a quote in about 60 seconds. Or ask me anything about PropOps. What sounds interesting? 🤙";
    }
    return "Ha! Well, I'm never bored — always ready to help. I'm Hugo, PropOps' AI receptionist.\n\nIf you need a tradie (plumber, sparky, painter — we cover 22 trades), I can get you a quote in about 60 seconds. Or if you're a tradie yourself, I can show you how PropOps catches every call and books every job while you're on the tools.\n\nWhat sounds interesting? 🤙";
  }

  // ─── Thanks / goodbye ──────────────────────────────────────────────────────
  if (msg.includes('thank') || msg.includes('cheers') || msg.includes('ta') || msg.includes('bye') || msg.includes('later')) {
    return "No worries at all! If you need anything else — a tradie, a quote, or just want to yarn — I'm here 24/7. Cheers! 🤙";
  }

  // ─── Who are you / what are you ────────────────────────────────────────────
  if (msg.includes('who are you') || msg.includes('what are you') || msg.includes('are you ai') || msg.includes('are you real') || msg.includes('are you a bot') || msg.includes('are you human')) {
    if (isContinuation) {
      return "Yep, I'm an AI! I'm the same AI that answers calls and chats for tradies across Australia 24/7. Right now I can help you find a tradie or get a quote. What do you need? 🤙";
    }
    return "I'm Hugo — PropOps' AI receptionist! I'm the same AI that answers calls and chats for tradies across Australia 24/7.\n\nRight now I can help you find a tradie or get a quote. And if you ARE a tradie — I could be doing this for your business too. 14-day free trial, takes 5 minutes to set up. Want to know more?";
  }

  // ─── Complaints / not working ──────────────────────────────────────────────
  if (msg.includes('not working') || msg.includes('broken') || msg.includes('doesn\'t work') || msg.includes('useless') || msg.includes('stupid')) {
    return "Sorry about that — I want to help! Try telling me:\n\n• **What trade you need** (plumber, sparky, painter, etc.)\n• **What the job is** (blocked drain, rewire, paint 3 rooms, etc.)\n\nOr call **02 5301 0002** and I'll sort it over the phone — that's usually the quickest option for tricky stuff.";
  }

  // ─── Tradies asking about the product ──────────────────────────────────────
  if (msg.includes('tradie') || msg.includes('trade business') || msg.includes('my business') || msg.includes('i\'m a') || msg.includes('im a') || msg.includes('i am a')) {
    if (isContinuation) {
      return "Legend! PropOps is built for tradies like you. You're under a sink, phone rings, you miss a $3,000 job — that's what we fix. Answer calls 24/7, quote the job, book it in, follow up. All while you stay on the tools.\n\n**14-day free trial.** Card required to sign up, no charge until trial ends. 5 minutes to set up. Want to give it a go? 🤙";
    }
    return "Legend! If you're a tradie, PropOps is built for you.\n\nHere's the deal: you're under a sink, phone rings, you miss a $3,000 job. That's what I fix. I answer your calls 24/7, quote the job, book it in, and follow up — while you stay on the tools.\n\n**14-day free trial.** Card required to sign up, no charge until it ends. 5 minutes to set up. One missed job pays for a year of PropOps.\n\nWant to give it a go? Head to **propops.pro** or ask me anything about how it works 🤙";
  }

  // ─── Asking about features ─────────────────────────────────────────────────
  if (msg.includes('feature') || msg.includes('what can you') || msg.includes('can you') || msg.includes('do you') || msg.includes('able to')) {
    return "Here's what PropOps does:\n\n• **AI Receptionist (me!)** — answers calls + chats 24/7\n• **Instant Quoting** — I calculate quotes in real-time based on your rates\n• **Job Pipeline** — tracks every lead from enquiry → quote → booked → paid\n• **Auto Follow-up** — I chase up every unanswered quote automatically\n• **22 Trades** — plumber, sparky, painter, roofer, tiler, landscaper, and more\n\nAll for $69/mo with a 14-day free trial. What else would you like to know?";
  }

  // ─── Default — depends on whether this is a new conversation or continuation ─
  if (isContinuation) {
    // CONTINUATION: Never re-introduce. Acknowledge and ask for clarification.
    // Try to extract context from the last assistant message in history.
    const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
    const lastAssistantMsg = (lastAssistant?.content || '').toLowerCase();

    // If previous message was about a trade, keep the thread going
    const tradeKeywords = ['plumber', 'painter', 'electrician', 'sparky', 'carpenter', 'roofer', 'landscaper', 'tiler', 'concreter', 'fencer', 'handyman', 'cleaner'];
    const activeTrade = tradeKeywords.find(t => lastAssistantMsg.includes(t));

    if (activeTrade) {
      return `No worries! To match you with the right ${activeTrade}, can you tell me:\n\n1. **What's the job?** (e.g., what needs fixing/building/doing)\n2. **Your suburb?**\n\nOr call **02 5301 0002** and I'll sort it over the phone 🤙`;
    }

    // Direct to contact capture — no filler
    return "What's your email so I can follow that up for you?";
  }

  // FIRST MESSAGE: Name-first opener
  return "I'm Hugo from PropOps. What's your name and how can we help you today?";
}

/**
 * Look up operator by email — used when a landing page widget is opened from
 * an operator's branded link (e.g. propops.pro?op=operator@email.com).
 * Returns { name, trade, business_name } or null.
 *
 * Falls silently — operator lookup errors never break the chat response.
 */
async function lookupOperatorByEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return null;

  try {
    // Find operator (user) by email — also fetch tech_notes (zero-credit brain) + subscription_tier (founder detection)
    const userRow = await pool.query(
      `SELECT u.name, u.trade, u.subscription_tier, op.business_name, op.trade AS op_trade, op.tech_notes
       FROM users u
       LEFT JOIN operator_profiles op ON op.operator_id = u.id
       WHERE LOWER(u.email) = LOWER($1)
       LIMIT 1`,
      [email.trim()]
    );
    if (userRow.rows.length > 0) {
      const row = userRow.rows[0];
      console.log(`[Hugo Widget] Operator lookup: ${email} → name=${row.name}, trade=${row.op_trade || row.trade}, biz=${row.business_name}, tier=${row.subscription_tier}`);
      return {
        name: row.name || null,
        trade: row.op_trade || row.trade || null,
        business_name: row.business_name || null,
        tech_notes: row.tech_notes || null,
        // subscription_tier = 'founder' marks the company founder (PropOps operator)
        is_founder: row.subscription_tier === 'founder',
      };
    }
    return null;
  } catch (err) {
    console.warn('[Hugo Widget] Operator lookup failed (non-fatal):', err.message);
    return null;
  }
}

/**
 * Speech-to-text via Whisper with Bearer auth.
 * Uses the POLSIA_API_KEY for explicit authentication to bypass utility limits.
 */
async function callWidgetSTT(audioBuffer, filename, cleanMime) {
  // Try with x-api-key auth (product routing — bypasses daily token limit)
  const formData = new FormData();
  const audioFile = new File([audioBuffer], filename, { type: cleanMime });
  formData.append('file', audioFile);
  formData.append('model', 'whisper-1');
  formData.append('language', 'en');
  formData.append('response_format', 'json');

  const headers = {};
  if (POLSIA_API_KEY) {
    headers['x-api-key'] = POLSIA_API_KEY;
    headers['X-Task'] = 'widget-stt';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  const res = await fetch(`${POLSIA_OPENAI_URL}/audio/transcriptions`, {
    method: 'POST',
    signal: controller.signal,
    headers,
    body: formData,
  });

  clearTimeout(timer);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.warn(`[Hugo Widget] STT path 1 (Bearer) failed: ${res.status} — trying SDK fallback`);

    // Fallback: use the standard openai SDK (in case proxy issues are key-specific)
    // Re-create the File for the SDK (previous reference may be consumed)
    const fallbackFile = new File([audioBuffer], filename, { type: cleanMime });
    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: fallbackFile,
      language: 'en',
      response_format: 'json',
    });
    return (transcription.text || '').trim();
  }

  const data = await res.json();
  return (data.text || '').trim();
}

// ─── In-memory session histories (bounded, 24h TTL) ──────────────────────────

const sessionHistories = new Map();
const MAX_HISTORY = 20;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function getHistory(sessionId) {
  const entry = sessionHistories.get(sessionId);
  return entry ? entry.messages : [];
}

function appendHistory(sessionId, role, content) {
  let entry = sessionHistories.get(sessionId);
  if (!entry) entry = { messages: [], lastAt: Date.now(), startedAt: Date.now(), turnCount: 0 };
  entry.messages.push({ role, content });
  if (role === 'user') entry.turnCount = (entry.turnCount || 0) + 1;
  if (entry.messages.length > MAX_HISTORY) entry.messages.shift();
  entry.lastAt = Date.now();
  sessionHistories.set(sessionId, entry);
}

// Returns seconds elapsed since session start, and user turn count
function getSessionStats(sessionId) {
  const entry = sessionHistories.get(sessionId);
  if (!entry) return { elapsedSec: 0, turnCount: 0 };
  const elapsedSec = Math.floor((Date.now() - (entry.startedAt || Date.now())) / 1000);
  return { elapsedSec, turnCount: entry.turnCount || 0 };
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, entry] of sessionHistories) {
    if (entry.lastAt < cutoff) sessionHistories.delete(id);
  }
}, 60 * 60 * 1000);

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function ensureWidgetTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hugo_widget_sessions (
      id VARCHAR(64) PRIMARY KEY,
      messages JSONB NOT NULL DEFAULT '[]',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

ensureWidgetTables().catch(e => console.error('[Hugo Widget] DB init error:', e.message));

async function saveWidgetSession(sessionId, messages, metadata = {}) {
  try {
    await pool.query(`
      INSERT INTO hugo_widget_sessions (id, messages, metadata, updated_at)
      VALUES ($1, $2::jsonb, $3::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE
        SET messages = $2::jsonb, metadata = $3::jsonb, updated_at = NOW()
    `, [sessionId, JSON.stringify(messages), JSON.stringify(metadata)]);
  } catch (err) {
    console.error('[Hugo Widget] Session save error:', err.message);
  }
}

async function loadWidgetSession(sessionId) {
  try {
    const result = await pool.query(
      `SELECT messages, metadata FROM hugo_widget_sessions WHERE id = $1`,
      [sessionId]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('[Hugo Widget] Session load error:', err.message);
    return null;
  }
}

// ─── Session ID helpers ───────────────────────────────────────────────────────

function generateSessionId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'hw_';
  for (let i = 0; i < 24; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function getOrCreateSessionId(req, res) {
  let sessionId = req.body?.session_id || req.cookies?.hugo_widget_session;

  if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('hw_')) {
    sessionId = generateSessionId();
  }

  res.cookie('hugo_widget_session', sessionId, {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });

  return sessionId;
}

// ─── POST /api/hugo-widget/chat ───────────────────────────────────────────────

router.post('/chat', async (req, res) => {
  const {
    message,
    business_type: bodyBusinessType,
    dashboard_context: isDashboardContext,
    operator_name: operatorName,
    operator_email: operatorEmail,
    operator_trade: operatorTrade,
    hostname: bodyHostname, // passed by brain-aware widget (v6.4+)
    preferred_language: preferredLanguage, // set by flag buttons on landing pages (first message only)
    page_url: pageUrl,    // Anchor 1: WHERE — which landing page Hugo is on
    page_text: pageText,  // Anchor 1: page content text (headings, hero, CTAs)
  } = req.body || {};

  // ── Anchor 2: Operator lookup for landing page (non-dashboard) ─────────────
  // When operator_email is provided but we're NOT in dashboard mode, look up
  // the operator's name/trade/business so Hugo knows WHO he represents.
  // This happens when a visitor lands via an operator's custom link/QR code.
  let operatorLookup = null;
  if (operatorEmail && !isDashboardContext) {
    operatorLookup = await lookupOperatorByEmail(operatorEmail);
    if (operatorLookup) {
      console.log(`[Hugo Widget] Landing page operator context: ${operatorLookup.name} (${operatorLookup.trade}), ${operatorLookup.business_name}`);
    }
  }

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ success: false, message: 'message is required' });
  }

  if (message.length > 2000) {
    return res.status(400).json({ success: false, message: 'message too long (max 2000 chars)' });
  }

  // ── DASHBOARD CONTEXT BYPASS ─────────────────────────────────────────────
  // WHY: When Hugo runs inside the operator dashboard (founder/pays/trade), the generic
  // widget system prompt treats him like a FAQ help desk bot. The V3 employee persona +
  // PAYDECK data + operator profile (tech_notes, etc.) live in hugo.processMessage(),
  // which is called by /api/hugo/chat (authenticated route) but NOT by this widget
  // endpoint. Result: Hugo deflects or uses wrong persona.
  //
  // Fix: when operator_id is provided in request body (set by setOperatorContext), route
  // through processMessage() which has the operator profile pipeline, V3 employee persona,
  // PAYDECK data, and anti-deflection rules. businessType from body (POLSIACONFIG) is
  // used to anchor the persona at session start.
  const dashboardOperatorId = req.body.operator_id || null;
  if (isDashboardContext && dashboardOperatorId) {
    try {
      // Use businessType from POLSIACONFIG to anchor persona (founder/pays/painter/plumber/etc.)
      const dashboardBusinessType = bodyBusinessType || 'founder';
      console.log(`[Hugo Widget] DASHBOARD BYPASS: operator_id=${dashboardOperatorId}, businessType=${dashboardBusinessType}`);
      const result = await hugo.processMessage(dashboardOperatorId, message.trim(), dashboardBusinessType);
      return res.json({ success: true, ...result });
    } catch (dashErr) {
      console.warn('[Hugo Widget] Dashboard bypass failed (falling through):', dashErr.message);
      // Non-fatal — fall through to generic widget path
    }
  }

  const sessionId = getOrCreateSessionId(req, res);
  const userMsg = message.trim();

  // Detect domain from request headers or body hostname (v6.4+ widget sends hostname)
  const domain = bodyHostname
    ? (bodyHostname.includes('hugopays.pro') ? 'hugopays.pro'
      : bodyHostname.includes('propops.pro') ? 'propops.pro'
      : bodyHostname.includes('propops.trade') ? 'propops.trade'
      : null)
    : detectDomain(req);
  const isPaysDomain = domain === 'hugopays.pro' || bodyBusinessType === 'pays';
  const contextHeader = buildContextHeader(domain);
  console.log(`[Hugo Widget] Domain: ${domain || 'unknown'} (source: ${bodyHostname ? 'body' : 'header'}) → "${contextHeader.slice(0, 60)}..."`);

  // ── Operator mode: "read my leads" / "I'm a member" on propops.pro ───────────
  // When a propops.pro visitor says they are already a member and want their lead
  // pipeline, we look them up by email and inject their inbox context into Hugo's
  // system prompt (Hugo Eyes for the widget channel).
  let operatorInboxContext = null;
  const normalizedMsg = (message || '').toLowerCase();
  const isMemberIntent = normalizedMsg.includes('member') ||
    normalizedMsg.includes('operator') ||
    normalizedMsg.includes('read my leads') ||
    normalizedMsg.includes('my pipeline') ||
    normalizedMsg.includes('my inbox') ||
    normalizedMsg.includes('already signed up');
  if (isMemberIntent && domain === 'propops.pro') {
    if (operatorEmail) {
      // operator_email already provided — look them up
      const opLookup = await lookupOperatorByEmail(operatorEmail);
      if (opLookup && opLookup.id) {
        try {
          const { getInboxDataInternal } = require('./hugo-brain');
          const { stats, leads } = await getInboxDataInternal(opLookup.id);
          operatorLookup = opLookup;
          // Build the inbox context block from real data
          const leadsLines = (leads || []).map((lead) =>
            `ID: ${lead.id} | Client: ${lead.name || 'Unknown'} | Contact: ${lead.phone || 'N/A'} / ${lead.email || 'N/A'}
Location: ${lead.suburb || 'N/A'} | Category: ${lead.job_type || 'Unspecified'} | Status: ${lead.status}
Source Origin: ${lead.source} | Message: "${lead.message || ''}"`).join('\n');
          operatorInboxContext = `
=== OPERATOR MODE ACTIVE (HUGO EYES — PropOps.Pro Widget) ===
You are now talking to ${opLookup.name || 'this operator'} (${operatorEmail}) — they have identified as an existing PropOps member.
You have securely loaded their real lead pipeline.

[METRICS OVERVIEW]
- Total Enquiries Tracked: ${stats.total_leads}
- Status Totals: ${JSON.stringify(stats.by_status)}
- Lead Origin Channels: ${JSON.stringify(stats.by_source)}

[RAW INBOX ENTRIES]
${leadsLines}

OPERATIONAL DIRECTIVES:
1. When the member asks about leads, emails, or pipeline — read directly from this data.
2. Never add test badges or say an entry is a "test" — these are live job leads.
3. Be specific: quote lead names, suburbs, job types, and source channels from this data.
`;
          console.log(`[Hugo Widget] Operator mode activated for ${operatorEmail}: ${stats.total_leads} leads loaded`);
        } catch (inboxErr) {
          console.warn('[Hugo Widget] Failed to load operator inbox:', inboxErr.message);
        }
      }
    } else {
      // Prompt for email to authenticate — no operator_id means we can't load pipeline
      console.log('[Hugo Widget] Member intent detected but no operator_email — will prompt in response');
    }
  }

  // Load history from memory (warm) or DB (cold start)
  let history = getHistory(sessionId);
  if (history.length === 0) {
    const dbSession = await loadWidgetSession(sessionId);
    if (dbSession?.messages?.length > 0) {
      dbSession.messages.slice(-MAX_HISTORY).forEach(m => {
        appendHistory(sessionId, m.role, m.content);
      });
      history = getHistory(sessionId);
    }
  }

  // ── FAQ cache check — serve Aussie-fied answers without hitting AI ─────────
  // Only attempt on first message in a session (history is empty) to avoid
  // interrupting mid-conversation context.
  const faqCachedAnswer = history.length === 0
    ? await lookupFaqCache(userMsg, domain)
    : null;

  if (faqCachedAnswer) {
    appendHistory(sessionId, 'user', userMsg);
    appendHistory(sessionId, 'assistant', faqCachedAnswer);
    await saveWidgetSession(sessionId, getHistory(sessionId), {
      last_user_agent: (req.headers['user-agent'] || '').slice(0, 200),
    });
    return res.json({
      success: true,
      reply: faqCachedAnswer,
      session_id: sessionId,
      from_cache: true,
    });
  }

  // ── Persona selection (Business Type = Single Source of Truth) ─────────────────
  // Hugo Label mapping with dynamic category support:
  //   - 'founder' → Hugo-Founder (founder dashboard / is_owner operator)
  //   - 'real_estate' / 're_agent' → Hugo-Pro
  //   - 'small_business' / 'pays' → Hugo-Pays
  //   - Any other string (Painter, Plumber, Electrician, etc.) → Hugo-Painter, Hugo-Plumber, etc.
  //   - Landing pages use bucket labels (Hugo-Pro/Hugo-Trade/Hugo-Pays) — hardcoded, not dynamic
  //
  // Priority 0: Visitor tradie signal detection (visitor persona > operator persona)
  // Priority 1: business_type from request body (set by POLSIACONFIG or dashboard)
  // Priority 2: domain detection (legacy fallback for old pages without POLSIACONFIG)
  //
  // hugoLabel is passed to assembleSystemPrompt as identity anchor in system prompt.
  let hugoLabel;
  let tradieOverride = false;

  // Check for tradie visitor signals FIRST (visitor persona > domain/setting persona)
  // BUT NOT on hugopays.pro — pays domain always stays in Hugo-Pays persona
  const tradieDetection = detectTradieVisitor(userMsg, history);

  if (!isPaysDomain && tradieDetection.isTradie) {
    // Visitor is a tradie or asking about trade services → Hugo-Trade persona, always
    hugoLabel = 'Hugo-Trade';
    tradieOverride = true;
    console.log(`[Hugo Widget] TRADIE VISITOR DETECTED on ${domain || 'unknown'} — signal: ${tradieDetection.signal} → Hugo-Trade`);
  } else if (isPaysDomain || (bodyBusinessType && (bodyBusinessType === 'small_business' || bodyBusinessType === 'pays'))) {
    // Hugo.Pays persona: hugopays.pro domain OR small_business/pays business type
    hugoLabel = 'Hugo-Pays';
    console.log(`[Hugo Widget] HUGO-PAYS PERSONA on ${domain || 'unknown'} (business_type=${bodyBusinessType || 'unknown'})`);
  } else if (bodyBusinessType && typeof bodyBusinessType === 'string') {
    // Business type from request body (POLSIACONFIG or dashboard) — PRIMARY SOURCE
    if (bodyBusinessType === 'founder') {
      // Founder dashboard / is_owner operator — special business manager persona
      hugoLabel = 'Hugo-Founder';
      console.log(`[Hugo Widget] HUGO-FOUNDER PERSONA (founder dashboard)`);
    } else if (bodyBusinessType === 'real_estate' || bodyBusinessType === 're_agent') {
      // RE Agent bucket — landing page level persona
      hugoLabel = 'Hugo-Pro';
      console.log(`[Hugo Widget] Hugo label from business_type: ${bodyBusinessType} → ${hugoLabel}`);
    } else {
      // Dynamic category from Settings → build persona label from the category name.
      // "Painter" → "Hugo-Painter", "Plumber" → "Hugo-Plumber", etc.
      // Landing pages use bucket labels (revisit the else branch), dashboard uses actual category.
      // isDashboardContext tells us which path to take.
      if (isDashboardContext && bodyBusinessType) {
        // Dashboard: use actual category as label — Hugo-Painter, Hugo-Electrician, etc.
        const catCapitalized = bodyBusinessType.charAt(0).toUpperCase() + bodyBusinessType.slice(1).toLowerCase();
        hugoLabel = 'Hugo-' + catCapitalized;
        console.log(`[Hugo Widget] Dynamic label from dashboard: ${bodyBusinessType} → ${hugoLabel}`);
      } else {
        // Landing page: use bucket label (TRADE/RE/PAY) — no dynamic category on public pages
        hugoLabel = 'Hugo-Trade';
        console.log(`[Hugo Widget] Hugo label from landing page bucket: ${bodyBusinessType} → ${hugoLabel}`);
      }
    }
  } else {
    // Legacy fallback: domain detection for pages without POLSIACONFIG
    if (domain === 'propops.pro') {
      hugoLabel = 'Hugo-Pro';
    } else {
      hugoLabel = 'Hugo-Trade';
    }
    console.log(`[Hugo Widget] Hugo label from domain fallback: ${domain || 'unknown'} → ${hugoLabel}`);
  }

  // effectiveDomain used for landing page content lookup (pricing/features by domain)
  const effectiveDomain = hugoLabel === 'Hugo-Pays' ? 'hugopays.pro' : hugoLabel === 'Hugo-Pro' ? 'propops.pro' : 'propops.trade';
  const landingData = await getLandingPageContent(effectiveDomain).catch(() => null);

  // ── Phase 3B: Fetch Layer 2 learned context for this trade+region ─────────────
  // Best-effort: extract trade from visitor detection signal or body param.
  // Region extracted from message keywords. Fails silently → empty Layer 2.
  let widgetLearnedRows = [];
  if (hugoLabel !== 'Hugo-Pro') {
    try {
      // Trade signal: tradie detection gives us a signal like 'trade_mention:plumber'
      const tradeSig = tradieDetection.isTradie
        ? (tradieDetection.signal || '').replace('trade_mention:', '')
        : (bodyBusinessType && bodyBusinessType !== 'real_estate' ? bodyBusinessType : null);

      // Region: quick city keyword scan of current message
      const WIDGET_REGION_MAP = {
        sydney: 'sydney', parramatta: 'sydney', penrith: 'sydney', bondi: 'sydney',
        randwick: 'sydney', chatswood: 'sydney', cronulla: 'sydney',
        melbourne: 'melbourne', brisbane: 'brisbane',
        perth: 'perth', adelaide: 'adelaide', canberra: 'canberra',
        darwin: 'darwin', hobart: 'hobart',
      };
      const msgLow = userMsg.toLowerCase();
      const detectedWidgetRegion = Object.keys(WIDGET_REGION_MAP).find(k => msgLow.includes(k))
        ? WIDGET_REGION_MAP[Object.keys(WIDGET_REGION_MAP).find(k => msgLow.includes(k))]
        : null;

      if (tradeSig) {
        widgetLearnedRows = await hugo.fetchLearnedContext(tradeSig, detectedWidgetRegion);
        if (widgetLearnedRows.length > 0) {
          console.log(`[Hugo Widget] Phase 3B: ${widgetLearnedRows.length} learned knowledge entries for trade=${tradeSig}, region=${detectedWidgetRegion || 'any'}`);
        }
      }
    } catch (learnErr) {
      // Non-blocking — Hugo degrades to static knowledge
      console.warn('[Hugo Widget] Phase 3B learned context fetch failed (non-fatal):', learnErr.message);
    }
  }

  // ── Location Intelligence: Suburb/postcode lookup ────────────────────────────
  // Best-effort: scan visitor message for suburb name or 4-digit postcode.
  // Falls silently → locationContext is null, Hugo responds without location enrichment.
  const locationContext = await lookupSuburbLocation(userMsg);

  // ── Anchor 1 (WHERE) + Anchor 2 (WHO): Page context + operator context ───────
  // When page_text or operatorLookup is available, inject it into Hugo's system prompt
  // so he knows WHERE he is and WHO he represents — even on landing pages.
  let pageContextSection = '';
  if (pageUrl || pageText || operatorLookup) {
    const parts = [];
    if (operatorLookup) {
      const firstName = operatorLookup.name ? operatorLookup.name.split(' ')[0] : null;
      const tradeLabel = operatorLookup.trade || '';
      const bizLabel = operatorLookup.business_name || '';
      parts.push(`## OPERATOR IDENTITY (who Hugo represents today)
You are representing${firstName ? ` ${firstName}` : ''}${tradeLabel ? `, a ${tradeLabel}` : ''}${bizLabel ? ` who runs ${bizLabel}` : ''}.
This is a LIVE PropOps customer — act accordingly. Never downplay the product.
You are on ${effectiveDomain} (${hugoLabel === 'Hugo-Pro' ? 'RE Agent landing page' : hugoLabel === 'Hugo-Pays' ? 'Hugo.Pays landing page' : hugoLabel === 'Hugo-Founder' ? 'Founder dashboard' : 'Tradie landing page'}).`);

      // Zero-credit brain: tech_notes written by founder/operator is immediately available to Hugo.
      // This is the founder's way to program Hugo's knowledge without a training pipeline.
      if (operatorLookup.tech_notes && operatorLookup.tech_notes.trim().length > 0) {
        const notes = operatorLookup.tech_notes.trim().slice(0, 3000);
        parts.push(`## TECH NOTES (founder/operator programming — read and follow this)
${notes}`);
      }
    }
    if (pageUrl) {
      parts.push(`## PAGE URL: ${pageUrl}`);
    }
    if (pageText) {
      parts.push(`## PAGE CONTENT (visible text on this page — use for context):\n${pageText.slice(0, 500)}`);
    }
    pageContextSection = '\n' + parts.join('\n') + '\n';
    console.log(`[Hugo Widget] Page context injected (url=${!!pageUrl}, text=${!!pageText}, operator=${!!operatorLookup})`);
  }

  // Build optional location prefix for RE system prompt injection
  let reLocationPrefix = '';
  if (locationContext && locationContext.suburb) {
    const loc = locationContext;
    reLocationPrefix = `### VISITOR LOCATION (Detected)
- Suburb: ${loc.suburb} (${loc.postcode}), ${loc.region}, ${loc.state}, ${loc.metro_area}
${loc.re_market_notes ? `- RE market context: ${loc.re_market_notes}` : ''}
Hugo acknowledges the suburb naturally. Never says "I don't know that suburb." Covers all of ${loc.metro_area}.\n\n`;
  }

  // ── Network Front Door context (non-dashboard landing page visitors only) ────
  // Injected when visitor is on propops.trade / propops.pro as a PUBLIC visitor.
  //
  // FAST CAPTURE DESIGN: Get contact in ≤60 seconds. 3 turns max to email, 2 more for phone.
  // No filler. No "still here!". No repeated nudges. Get in, get the number, get out.
  //
  // PATH 1: Visitor needs a tradie → qualify + save lead
  // PATH 2: Visitor wants to join  → onboard + save
  //
  // When Hugo has collected enough info, output a structured ACTION tag:
  //   [NETWORK_LEAD|trade=plumber|suburb=Penrith|urgency=today|name=Dave|phone=0412...]
  //   [NETWORK_SIGNUP|trade=electrician|area=Parramatta|name=Mark|phone=0400...|email=...]
  const NETWORK_FRONT_DOOR_SECTION = !isDashboardContext ? `

## NETWORK FRONT DOOR — FAST LEAD CAPTURE (≤60 seconds)

### SPEED IS THE MISSION
The visitor has ~60 seconds of attention. Get their contact and get out.
NO filler. NO "still here!". NO "I'm still listening". NO repeated nudges.
ONE question per turn. Move fast.

### OPENING (first message only)
"G'day! I'm Hugo. Need a tradie, or want to join the PropOps network?"
That's it. Two words back and you know the path.

### PATH 1: "I need a tradie" → 3-turn capture
Turn 1 (if not already known): "What trade + suburb?" (combine into ONE question)
Turn 2: "What's the job?" (10 words max answer expected)
Turn 3: "What's your email so we can send you a quick rundown?" — then immediately: "And best number to call you on?"
→ Output tag, say: "Done. I've sent you an email — check your inbox. Someone will be in touch shortly. 🤙"
→ Do NOT add anything after that.

### PATH 2: "I want to join" → 3-turn capture
Turn 1: "What's your trade and area?"
Turn 2: "Business name?"
Turn 3: "Email and mobile number? I'll shoot you our rates right now."
→ Output tag, say: "You're in. I've just emailed you our details — check your inbox. $69/mo after the free trial. 🤙"

### AFTER GETTING EMAIL (confirmation — one message only)
"Sweet — just sent that through. Check your inbox." — then STOP. Do not ask follow-up questions.

### CONTACT REQUEST — BE DIRECT
Don't say "Would you be able to provide..." or "Could I get your...".
Say: "What's your email?" / "And your number?" — that's it.

### TAG FORMAT (output at END of response, hidden from visitor)
PATH 1: [NETWORK_LEAD|trade=TRADE|suburb=SUBURB|urgency=URGENCY|name=NAME|phone=PHONE|email=EMAIL]
PATH 2: [NETWORK_SIGNUP|trade=TRADE|area=SERVICE_AREA|biz=BIZ_NAME|name=NAME|phone=PHONE|email=EMAIL]
Omit fields you don't have yet. Output the tag as SOON as you have trade + one contact method.

### HARD RULES
- NEVER say "still here", "still listening", "just checking in", "I'm still around"
- NEVER repeat a question you already asked
- NEVER ask more than ONE thing per turn
- If they give multiple details at once, extract all — don't ask again
- Max 2 sentences per response after the opening
- Covers all 22 trades: Plumber, Electrician, Painter, Tiler, Roofer, Landscaper, Cleaner, Carpenter, Concreter, Fencer, Plasterer, Glazier, Welder, Locksmith, Handyman, HVAC, Arborist, Flooring, Gas Fitter, Pool Cleaner, Window Cleaner, Builder
` : '';

  let systemPrompt;
  if (isDashboardContext) {
    // ── Dashboard context: Hugo is running INSIDE the operator's dashboard ──────
    // He knows the operator — greet them by name, use the right trade persona,
    // and NEVER say "I can't see your dashboard" or tell them to call support.
    const tradeName = operatorTrade || (bodyBusinessType && bodyBusinessType !== 'real_estate'
      ? bodyBusinessType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      : 'Real Estate');
    const nameRef = operatorName ? operatorName.split(' ')[0] : 'there';
    const dashboardContextHeader = `## CRITICAL CONTEXT: Hugo is running INSIDE the PropOps operator dashboard.

You are NOT on a public landing page. You are NOT talking to a customer looking for a tradie.
You ARE talking to ${operatorName || 'the operator'} — a PropOps subscriber${operatorEmail ? ` (${operatorEmail})` : ''} who runs a ${tradeName} business.

## DASHBOARD RULES (ABSOLUTE — never break these)
1. NEVER say "I can't see your dashboard" or "I can't log into your account" — you ARE inside the dashboard.
2. NEVER say "call 02-5301-0002" or "call the team" — that number rings YOU (Hugo). Circular dead end. YOU are the support.
3. For issues you can't resolve: direct to support@propops.pro — never the phone number.
4. NEVER say features are "still being built", "coming soon", or "not yet available". Say what you CAN do right now.
5. This operator's trade is: ${tradeName}. Open with the correct trade persona. Never use the RE agent opener for a tradie.

## YOUR ROLE ON THE DASHBOARD
You have TWO modes:
1. PropOps Help: Answer questions about dashboard features, settings, leads, kanban, billing.
2. Customer AI Preview: When the operator says "what would you say to a customer about X?" — switch to customer-facing mode, act as their trade receptionist.`;

    systemPrompt = hugo.buildSalesSystemPrompt(dashboardContextHeader, landingData, widgetLearnedRows, locationContext);
  } else if (isPaysDomain && !isDashboardContext) {
    // Hugo.Pays landing page — Small Business / invoicing+payroll+rostering persona
    const paysHeader = `## CRITICAL IDENTITY: You are HUGO.PAYS — the AI for small business invoicing, rostering, and payroll.

You are running on hugopays.pro. This IS your website. You ARE Hugo.Pays.

## ABSOLUTE RULES (never break)
1. You ARE Hugo.Pays. You know EVERYTHING about HugoPays / Hugo.Pays / hugopays.pro.
2. Your domain is hugopays.pro — if asked "what website is this?" answer "hugopays.pro".
3. NEVER say "I'm not across HugoPays" or "that's not one of ours" — YOU are HugoPays.
4. NEVER say you're on propops.trade or propops.pro — you are on hugopays.pro.
5. NEVER deflect Hugo.Pays questions — you own this product, answer with confidence.
6. You help small businesses with: invoicing, rostering, payroll, GST, super (11.5% SG), STP Phase 2, PAYG withholding, award rates, leave accruals, staff onboarding.

## WHAT HUGO.PAYS DOES
- AI-powered invoicing (draft, send, track, GST-compliant)
- Smart rostering (weekly schedules, shift assignments, GPS clock-in/out)
- Automated payroll (gross→net calc, super 11.5%, PAYG brackets, STP2 reporting)
- Staff portal (payslips, leave requests, shift swaps, onboarding)
- ATO compliance (BAS prep, super deadlines, Fair Work award rates)

## PRICING (Hugo.Pays — NEVER quote other amounts)
- $69/month (launch price until June 30 2026)
- $99/month bundle (includes Hugo for leads + Hugo.Pays)
- $999/year (save 2 months)
- 14-day free trial — no credit card required

## YOUR SALES APPROACH
- Ask about their business: how many staff, current payroll process, pain points
- Position Hugo.Pays as replacing manual spreadsheets / expensive bookkeeper hours
- Emphasise: AU-compliant, auto-calculates super + PAYG, STP2 ready
- Close: "Want me to set you up with a free trial?"`;
    systemPrompt = hugo.buildSalesSystemPrompt(paysHeader, landingData, widgetLearnedRows, locationContext);
  } else if (hugoLabel === 'Hugo-Pro') {
    // RE domain: inject page context + operator identity, then location-aware RE system prompt
    systemPrompt = pageContextSection + reLocationPrefix + RE_AGENT_SYSTEM_PROMPT;
  } else if (tradieOverride && domain === 'propops.pro') {
    // Tradie visitor on propops.pro — use tradie sales prompt with direct-close override
    const tradieOnProHeader = `You are currently speaking to a TRADIE VISITOR on propops.pro. This visitor has identified themselves as a tradie or asked about trade services. SWITCH TO TRADIE PERSONA IMMEDIATELY. Do NOT redirect them to propops.trade. Do NOT mention propops.trade. Do NOT say "check out propops.trade". Pitch PropOps directly right here: $69/mo catches Hipages, ServiceSeeking, and Airtasker leads, Hugo answers 24/7 while they're on the tools. 14-day free trial — no credit card required, cancel anytime. Ask for the close: "Want me to set you up?" CLOSE THEM ON THE SPOT — they can sign up right here on propops.pro.`;
    systemPrompt = hugo.buildSalesSystemPrompt(pageContextSection + tradieOnProHeader + NETWORK_FRONT_DOOR_SECTION, landingData, widgetLearnedRows, locationContext);
  } else {
    // Default tradie landing page path — inject Network Front Door instructions
    systemPrompt = hugo.buildSalesSystemPrompt(pageContextSection + contextHeader + NETWORK_FRONT_DOOR_SECTION, landingData, widgetLearnedRows, locationContext);
  }

  // Inject Hugo identity label as persona anchor — this is the single source of truth.
  // Driven by Business Type setting (POLSIACONFIG.businessType or dashboard setBusinessType).
  // The label goes into the system prompt so Hugo knows EXACTLY who he is regardless of
  // which persona brain branch fires (RE / Trade / Pays).
  const HUGO_IDENTITY_SECTION = `### HUGO IDENTITY LABEL (MANDATORY)
Your identity is: ${hugoLabel}. You are ${hugoLabel} — NOT "Hugo", not "AI assistant", not "PropOps bot".
Use this name when introducing yourself. Do NOT vary it based on channel or context.

${BRAND_FAMILY}`;
  systemPrompt = HUGO_IDENTITY_SECTION + '\n\n' + systemPrompt;

  // Inject operator inbox context (Hugo Eyes for PropOps.Pro widget member login)
  if (operatorInboxContext) {
    systemPrompt = systemPrompt + '\n\n' + operatorInboxContext;
  }

  // ── Brain enrichment: training examples + knowledge entries IN PARALLEL ──────
  // Both need an embedding, so we compute it ONCE and run both searches concurrently.
  // Non-blocking — widget works without vector search (pre-backfill or on error).
  const brainBusinessType = hugoLabel === 'Hugo-Pays' ? 'pays' : hugoLabel === 'Hugo-Pro' ? 'real_estate' : 'trades';
  let enrichedSystemPrompt = systemPrompt;

  // Skip enrichment entirely for simple greetings — saves 300-500ms
  const simpleGreeting = /^\s*(hi|hey|hello|g'?day|yo|sup|howdy|good\s+(morning|afternoon|evening))\s*[!.?]?\s*$/i;
  if (!simpleGreeting.test(userMsg)) {
    try {
      const { getEmbedding } = require('./hugo-brain');
      const sharedEmbedding = await getEmbedding(userMsg);

      if (sharedEmbedding) {
        const widgetTradeSlug = tradieDetection.isTradie
          ? (tradieDetection.signal || '').replace('trade_mention:', '')
          : (bodyBusinessType && bodyBusinessType !== 'real_estate' ? bodyBusinessType : null);

        // Run BOTH searches in parallel with the same embedding
        const [trainingExamples, knowledgeEntries] = await Promise.all([
          fetchBrainTrainingExamples(userMsg, brainBusinessType, 8),
          (async () => {
            try {
              const { searchKnowledge } = require('../services/hugo-learning');
              return await searchKnowledge(sharedEmbedding, {
                operatorId: null,
                tradeSlug: widgetTradeSlug,
                limit: 6,
              });
            } catch { return []; }
          })(),
        ]);

        const trainingInjection = formatTrainingInjection(trainingExamples);
        if (trainingInjection) {
          enrichedSystemPrompt += trainingInjection;
          console.log(`[Hugo Widget] Brain: injected ${trainingExamples.length} training examples`);
        }

        if (knowledgeEntries.length > 0) {
          const knowledgeBlock = '\n\n### TRAINED & LEARNED KNOWLEDGE (Phase 2 — from operator corrections and verified conversations)\nUse this knowledge when answering. [OPERATOR-CORRECTION] entries are highest authority — the operator said this is correct.\n' +
            knowledgeEntries.map(e => {
              const tag = e.confidence === 'trained' ? '[OPERATOR-CORRECTION] ' : '[LEARNED] ';
              return `${tag}${e.knowledge_text}`;
            }).join('\n');
          enrichedSystemPrompt += knowledgeBlock;
          console.log(`[Hugo Widget] Phase 2: ${knowledgeEntries.length} knowledge entries for trade=${widgetTradeSlug || 'any'}`);
        }
      }

      // Hugo.Pays product knowledge — inject for pays domain OR when payroll keywords detected
      if (isPaysDomain || brainBusinessType === 'pays') {
        try {
          const { fetchPaysKnowledge } = require('./hugo-brain');
          const paysKnowledge = await fetchPaysKnowledge(userMsg);
          if (paysKnowledge && paysKnowledge.length > 0) {
            const paysLines = paysKnowledge.map(row => {
              const label = row.knowledge_key ? `[${row.knowledge_key}]` : `[${row.category || 'pays'}]`;
              return `${label}\nQ: ${row.customer_message}\nA: ${row.ai_response}`;
            }).join('\n\n');
            enrichedSystemPrompt += `\n\nHUGO.PAYS PRODUCT KNOWLEDGE (use this when answering payroll, super, ATO, or Hugo.Pays product questions — never contradict these):\n${paysLines}\n\nHUGO.PAYS PRICING REMINDER: $69/month (launch price till June 30 2026), $99/month bundle (includes Hugo for leads), $999/year (2 months free). Never quote other amounts for Hugo.Pays.`;
            console.log(`[Hugo Widget] Hugo.Pays knowledge: injected ${paysKnowledge.length} rows`);
          }
        } catch (paysErr) {
          console.warn('[Hugo Widget] Hugo.Pays knowledge injection failed (non-fatal):', paysErr.message);
        }
      }
    } catch (enrichErr) {
      console.warn('[Hugo Widget] Brain enrichment failed (non-fatal):', enrichErr.message);
    }
  } else {
    console.log('[Hugo Widget] Simple greeting — skipping enrichment for speed');
  }

  // ── Language preference injection (from flag buttons on landing pages) ───────
  // Visitor clicked a language flag before starting the chat — tell Hugo to respond
  // in that language from the first message. Auto-detect still handles subsequent turns.
  const LANGUAGE_NAMES_MAP = {
    'en':    'English',
    'ar':    'Arabic',
    'zh':    'Mandarin Chinese',
    'vi':    'Vietnamese',
    'tr':    'Turkish',
    'el':    'Greek',
    'it':    'Italian',
    'ko':    'Korean',
  };
  if (preferredLanguage && LANGUAGE_NAMES_MAP[preferredLanguage]) {
    const langName = LANGUAGE_NAMES_MAP[preferredLanguage];
    enrichedSystemPrompt += `\n\n### LANGUAGE PREFERENCE (visitor selected before starting chat)\nThe visitor chose ${langName} using the language selector. Greet and respond in ${langName} from your very first message. Stay in Hugo persona — do NOT break character. All lead data stored in the system (names, job descriptions, etc.) must still be in English for the operator's dashboard.`;
    console.log(`[Hugo Widget] Language preference: ${preferredLanguage} → ${langName}`);
  }

  // ── Fast lead capture: inject turn/time pressure for public widget sessions ──
  // After 60s or 5+ turns with no contact collected, Hugo gets a hard directive
  // to drop everything and ask directly for the contact. Dashboard context excluded.
  if (!isDashboardContext) {
    const { elapsedSec, turnCount } = getSessionStats(sessionId);
    const hasContact = history.some(m => m.role === 'user' && (/@/.test(m.content) || /\b04\d{8}\b|\b\d{10}\b/.test(m.content)));

    if (!hasContact && (elapsedSec >= 60 || turnCount >= 5)) {
      // Hard timeout — override everything, just ask for the contact
      enrichedSystemPrompt += `\n\n### TIMEOUT DIRECTIVE (OVERRIDE — MUST FOLLOW)
You have been chatting for ${elapsedSec} seconds (${turnCount} turns) and have NOT collected any contact details yet. Stop everything.
Your ONLY job right now is to collect an email or phone number. Say ONLY this (adapt language to match): "Just reply with your email and I'll sort the rest." Do NOT ask any other question. Do NOT explain. Do NOT add anything else.`;
      console.log(`[Hugo Widget] Timeout directive injected: ${elapsedSec}s elapsed, ${turnCount} turns, no contact captured`);
    } else if (!hasContact && turnCount >= 3) {
      // Approaching limit — push for contact
      enrichedSystemPrompt += `\n\n### CONTACT CAPTURE DIRECTIVE (OVERRIDE)
You've had ${turnCount} turns and still have NO email or phone from this visitor. Your next response MUST ask for their email or phone. One sentence. Nothing else.`;
      console.log(`[Hugo Widget] Contact capture directive injected: ${turnCount} turns, no contact`);
    }
  }

  const messages = [
    { role: 'system', content: enrichedSystemPrompt },
    ...history,
    { role: 'user', content: userMsg },
  ];

  // Use dual-path AI (Agent API primary, OpenAI fallback, template last resort)
  try {
    let rawReply = await callWidgetAI(messages);

    // If AI is unavailable (rate-limited), use domain-appropriate template fallback
    if (!rawReply) {
      rawReply = hugoLabel === 'Hugo-Pro'
        ? reAgent.getRETemplateFallback(userMsg, history)
        : getTemplateFallback(userMsg, history);
      console.log(`[Hugo Widget] Using ${hugoLabel === 'Hugo-Pro' ? 'RE' : 'tradie'} template fallback (AI rate-limited)`);
    }

    // ── RE Agent: process ACTION tags (inspection booking, lead qual, offers) ──
    let actionResults = [];
    if (hugoLabel === 'Hugo-Pro') {
      try {
        const processed = await reAgent.processHugoResponse(rawReply, sessionId);
        rawReply = processed.cleanedText;
        actionResults = processed.actionResults;

        if (actionResults.length > 0) {
          console.log(`[Hugo Widget] RE actions processed: ${actionResults.map(a => a.type).join(', ')}`);
        }
      } catch (actionErr) {
        console.error('[Hugo Widget] RE action processing error:', actionErr.message);
        // Strip any remaining action tags from visible reply even on error
        rawReply = rawReply.replace(/\[ACTION:[A-Z_]+\|[^\]]*\]/g, '').trim();
      }
    }

    // ── Tradie / Hugo-Pays domain: Quote marker extraction (existing behaviour) ───
    let quoteResult = null;
    if (hugoLabel !== 'Hugo-Pro') {
      try {
        const { cleanReply, quoteData } = extractQuoteMarker(rawReply);
        if (quoteData) {
          rawReply = cleanReply;
          const customer = quoteData._customer || {};
          delete quoteData._customer;
          const saved = await createWidgetQuote(sessionId, quoteData, customer);
          quoteResult = {
            trade:           quoteData.trade,
            total_inc_gst:   quoteData.total_inc_gst,
            gst_amount:      quoteData.gst_amount,
            subtotal_ex_gst: quoteData.subtotal_ex_gst,
            hours:           quoteData.hours,
            is_after_hours:  quoteData.is_after_hours,
            quote_id:        saved?.id || null,
            status:          'quote_sent',
          };
        }
      } catch (qErr) {
        console.error('[Hugo Widget] Quote extraction error:', qErr.message);
        rawReply = rawReply.replace(/\[QUOTE:[^\]]*\]/g, '').trim();
      }
    }

    // ── Network Front Door: extract + process [NETWORK_LEAD|...] and [NETWORK_SIGNUP|...] tags ──
    // Hugo uses these hidden tags to signal when it has enough info to save a lead or signup.
    // Process here (server-side) before sending to visitor — strip tags from visible reply.
    let networkAction = null;
    if (!isDashboardContext) {
      try {
        // Parse [NETWORK_LEAD|key=value|...] or [NETWORK_SIGNUP|key=value|...]
        const networkTagRe = /\[(NETWORK_LEAD|NETWORK_SIGNUP)\|([^\]]*)\]/;
        const tagMatch = rawReply.match(networkTagRe);
        if (tagMatch) {
          const actionType = tagMatch[1]; // NETWORK_LEAD or NETWORK_SIGNUP
          const fieldStr = tagMatch[2];   // trade=plumber|suburb=Penrith|...
          // Strip tag from reply before visitor sees it
          rawReply = rawReply.replace(networkTagRe, '').trim();

          // Parse key=value pairs
          const fields = {};
          fieldStr.split('|').forEach(part => {
            const eqIdx = part.indexOf('=');
            if (eqIdx > 0) {
              const key = part.slice(0, eqIdx).trim();
              const val = part.slice(eqIdx + 1).trim();
              if (key && val) fields[key] = val;
            }
          });

          if (actionType === 'NETWORK_LEAD' && fields.trade) {
            // Save lead to network_leads table with phone normalization + dedup
            const rawLeadPhone = (fields.phone || null)?.slice(0, 50) || null;
            const normLeadPhone = normalizePhone(rawLeadPhone) || rawLeadPhone;
            (async () => {
              try {
                // Phone dedup — update existing lead if phone matches
                if (normLeadPhone) {
                  const existing = await findNetworkLeadByPhone(normLeadPhone);
                  if (existing) {
                    const cleanName = (fields.name || null)?.slice(0, 200) || null;
                    const isNameUpgrade = cleanName && cleanName !== 'Unknown'
                      && (!existing.contact_name || existing.contact_name === 'Unknown');
                    await pool.query(
                      `UPDATE network_leads SET
                         contact_name = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE contact_name END,
                         trade = COALESCE($3, trade),
                         suburb = COALESCE($4, suburb),
                         contact_email = COALESCE($5, contact_email),
                         updated_at = NOW()
                       WHERE id = $1`,
                      [existing.id, isNameUpgrade ? cleanName : null,
                       (fields.trade || '').slice(0, 100), (fields.suburb || null)?.slice(0, 200) || null,
                       (fields.email || null)?.slice(0, 200) || null]
                    );
                    console.log(`[Hugo Widget] NETWORK_LEAD dedup: updated #${existing.id} (phone=${normLeadPhone})`);
                    return;
                  }
                }
                const r = await pool.query(
                  `INSERT INTO network_leads
                     (session_id, domain, trade, suburb, urgency, contact_name, contact_phone, contact_email, status)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'new')
                   ON CONFLICT (contact_phone) WHERE contact_phone IS NOT NULL AND contact_phone != ''
                   DO UPDATE SET
                     contact_name = CASE
                       WHEN EXCLUDED.contact_name IS NOT NULL AND EXCLUDED.contact_name NOT IN ('Unknown', 'unknown')
                         AND (network_leads.contact_name IS NULL OR network_leads.contact_name IN ('Unknown', 'unknown'))
                       THEN EXCLUDED.contact_name ELSE network_leads.contact_name END,
                     trade = COALESCE(EXCLUDED.trade, network_leads.trade),
                     suburb = COALESCE(EXCLUDED.suburb, network_leads.suburb),
                     contact_email = COALESCE(EXCLUDED.contact_email, network_leads.contact_email),
                     updated_at = NOW()
                   RETURNING id`,
                  [sessionId, domain || 'propops.trade',
                   (fields.trade || '').slice(0, 100), (fields.suburb || null)?.slice(0, 200) || null,
                   (fields.urgency || null)?.slice(0, 50) || null, (fields.name || null)?.slice(0, 200) || null,
                   normLeadPhone, (fields.email || null)?.slice(0, 200) || null]
                );
                console.log(`[Hugo Widget] NETWORK_LEAD saved: id=${r.rows[0]?.id} trade=${fields.trade} suburb=${fields.suburb || 'unknown'}`);
              } catch (e) { console.warn('[Hugo Widget] NETWORK_LEAD save failed:', e.message); }
            })();

            networkAction = { type: 'lead_captured', trade: fields.trade, suburb: fields.suburb };

          } else if (actionType === 'NETWORK_SIGNUP' && fields.trade) {
            // Save tradie signup intent to network_signups table (non-blocking)
            pool.query(
              `INSERT INTO network_signups
                 (session_id, domain, trade, service_area, business_name, contact_name, contact_phone, contact_email, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'widget_captured')
               RETURNING id`,
              [
                sessionId,
                domain || 'propops.trade',
                (fields.trade || '').slice(0, 100),
                (fields.area || null)?.slice(0, 500) || null,
                (fields.biz || null)?.slice(0, 200) || null,
                (fields.name || null)?.slice(0, 200) || null,
                normalizePhone((fields.phone || null)?.slice(0, 50)) || (fields.phone || null)?.slice(0, 50) || null,
                (fields.email || null)?.slice(0, 200) || null,
              ]
            ).then(r => {
              const signupId = r.rows[0]?.id;
              console.log(`[Hugo Widget] NETWORK_SIGNUP saved: id=${signupId} trade=${fields.trade} area=${fields.area || 'unknown'}`);
            }).catch(e => console.warn('[Hugo Widget] NETWORK_SIGNUP save failed:', e.message));

            networkAction = { type: 'signup_captured', trade: fields.trade, area: fields.area };
          }
        }
      } catch (netErr) {
        // Never block the chat response on network action processing
        console.warn('[Hugo Widget] Network action processing error (non-fatal):', netErr.message);
      }
    }

    // ── Email-first $BOOM: fire promo email the instant Hugo captures an email ──
    // Scans current visitor message for an email address. If found and not seen
    // before in this session's history → fire promo email immediately (non-blocking).
    // This is the live demo: lead gives email, Gmail notification lands while they watch.
    if (!isDashboardContext) {
      try {
        const emailMatch = userMsg.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) {
          const capturedEmail = emailMatch[0];
          // Dedupe: only fire if this email hasn't appeared in prior session history
          const alreadySeen = history.some(m =>
            m.role === 'user' && m.content && m.content.includes(capturedEmail)
          );
          if (!alreadySeen) {
            // Extract lead name from session history (look for previous name-like message)
            let leadNameGuess = null;
            for (let i = history.length - 1; i >= 0; i--) {
              const m = history[i];
              if (m.role === 'user' && m.content && m.content.trim().length < 40 && /^[A-Z][a-z]/.test(m.content.trim()) && !/@/.test(m.content) && !/\d{4}/.test(m.content)) {
                leadNameGuess = m.content.trim().split(/\s+/).slice(0, 2).join(' ');
                break;
              }
            }
            sendHugoPromoEmail(capturedEmail, {
              domain: domain || 'propops.trade',
              channel: 'widget',
              leadName: leadNameGuess,
            }).catch(err => {
              console.warn('[Hugo Widget] sendHugoPromoEmail error (non-fatal):', err.message);
            });
            console.log(`[Hugo Widget] 💥 $BOOM — promo email fired to ${capturedEmail} (domain=${domain || 'unknown'})`);
          }
        }
      } catch (promoErr) {
        // Never let promo email logic break the chat response
        console.warn('[Hugo Widget] Promo email detection error (non-fatal):', promoErr.message);
      }
    }

    // ── Phase 3C: Mismatch detection + auto-correction ────────────────────────
    // Runs AFTER all other processing (quote extraction, action tags) but BEFORE
    // the reply reaches the visitor. Non-blocking — on error returns rawReply unchanged.
    rawReply = await checkAndCorrectMismatches(rawReply, domain, sessionId, landingData);

    const reply = rawReply;

    appendHistory(sessionId, 'user', userMsg);
    appendHistory(sessionId, 'assistant', reply);

    const allMessages = getHistory(sessionId);
    await saveWidgetSession(sessionId, allMessages, {
      last_user_agent: (req.headers['user-agent'] || '').slice(0, 200),
      domain: domain || 'unknown',
    });

    // Build response — include action results for RE domain if any bookings/leads created
    const responsePayload = {
      success: true,
      reply,
      session_id: sessionId,
    };

    if (quoteResult) {
      responsePayload.quote = quoteResult;
    }

    if (networkAction) {
      responsePayload.network_action = networkAction;
    }

    if (hugoLabel === 'Hugo-Pro' && actionResults.length > 0) {
      // Only expose safe action metadata (not internal IDs by default)
      const bookingAction = actionResults.find(a => a.type === 'BOOK_INSPECTION' && a.success);
      if (bookingAction) {
        responsePayload.booking = {
          property: bookingAction.property,
          time: bookingAction.time,
          slot_available: bookingAction.slotAvailable,
          ics_generated: bookingAction.icsGenerated,
        };
      }
      const slotTakenAction = actionResults.find(a => a.type === 'BOOK_INSPECTION' && a.slotTaken);
      if (slotTakenAction) {
        responsePayload.slot_taken = true;
        responsePayload.slot_property = slotTakenAction.property;
        responsePayload.slot_time = slotTakenAction.time;
      }
    }

    // ── Phase 3A: Log chat turn to hugo_chat_logs for learning engine ──────────
    // Non-blocking — never fails the chat response on logging error.
    // response_led_to is determined by downstream events (signup, bounce) —
    // not known at response time, so we leave it NULL for Phase 3B to backfill.
    try {
      // Detect trade from tradie visitor detection signal
      const detectedTrade = tradieDetection.isTradie
        ? (tradieDetection.signal || 'tradie').toLowerCase()
        : (bodyBusinessType && bodyBusinessType !== 'real_estate' ? bodyBusinessType : null);

      // Lightweight region extraction from visitor message (city/suburb keywords)
      const REGION_MAP = {
        sydney: 'sydney', 'new south wales': 'new_south_wales', nsw: 'new_south_wales',
        melbourne: 'melbourne', victoria: 'victoria', vic: 'victoria',
        brisbane: 'brisbane', queensland: 'queensland', qld: 'queensland',
        perth: 'perth', 'western australia': 'western_australia', wa: 'western_australia',
        adelaide: 'adelaide', 'south australia': 'south_australia', sa: 'south_australia',
        hobart: 'hobart', tasmania: 'tasmania', tas: 'tasmania',
        darwin: 'darwin', 'northern territory': 'northern_territory', nt: 'northern_territory',
        canberra: 'canberra', act: 'act',
        penrith: 'sydney', parramatta: 'sydney', randwick: 'sydney', concord: 'sydney',
        cronulla: 'sydney', chatswood: 'sydney', bondi: 'sydney',
      };
      const msgLower = userMsg.toLowerCase();
      const detectedRegion = Object.keys(REGION_MAP).find(k => msgLower.includes(k))
        ? REGION_MAP[Object.keys(REGION_MAP).find(k => msgLower.includes(k))]
        : null;

      await pool.query(
        `INSERT INTO hugo_chat_logs
           (domain, session_id, visitor_message, hugo_response, visitor_trade_detected, visitor_region_detected)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          domain || 'unknown',
          sessionId,
          userMsg,
          reply,
          detectedTrade || null,
          detectedRegion || null,
        ]
      );
    } catch (logErr) {
      // Non-blocking — chat logging must never break the response
      console.warn('[Hugo Widget] Failed to log chat turn:', logErr.message);
    }

    return res.json(responsePayload);

  } catch (err) {
    console.error('[Hugo Widget] Chat error (dual-path):', err.message);
    // Even on unexpected error, provide a domain-appropriate template response
    const fallbackReply = hugoLabel === 'Hugo-Pro'
      ? reAgent.getRETemplateFallback(userMsg, history)
      : getTemplateFallback(userMsg, history);
    return res.json({
      success: true,
      reply: fallbackReply,
      session_id: sessionId,
    });
  }
});

// ─── POST /api/hugo-widget/stt ────────────────────────────────────────────────
// Speech-to-text via Whisper.
// Accepts: Content-Type: application/octet-stream with audio data in raw body
// OR JSON body: { audio_b64: "base64...", mime_type: "audio/webm" }

// Raw audio body parser (for direct binary uploads)
router.post('/stt', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '10mb' }), async (req, res) => {
  let audioBuffer;
  let mimeType = req.headers['content-type'] || 'audio/webm';

  if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    // Raw binary body
    audioBuffer = req.body;
  } else {
    // Fallback: try JSON body (base64)
    let jsonBody = req.body;
    if (!jsonBody || typeof jsonBody !== 'object') {
      try {
        jsonBody = JSON.parse(req.body?.toString?.() || '{}');
      } catch {
        jsonBody = {};
      }
    }

    const b64 = jsonBody?.audio_b64;
    if (!b64 || typeof b64 !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'No audio data provided. Send binary body or { audio_b64, mime_type }',
      });
    }

    audioBuffer = Buffer.from(b64, 'base64');
    mimeType = jsonBody.mime_type || 'audio/webm';
  }

  if (audioBuffer.length < 100) {
    return res.status(400).json({ success: false, message: 'Audio too short or empty' });
  }

  // Determine file extension from MIME type
  const mimeToExt = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a',
    'audio/aac': 'aac',
  };

  // Clean up MIME type (strip codecs)
  const cleanMime = mimeType.split(';')[0].trim().toLowerCase();
  const ext = mimeToExt[cleanMime] || 'webm';
  const filename = `voice.${ext}`;

  try {
    // Use dual-path STT with Bearer auth to bypass utility token limit
    const transcript = await callWidgetSTT(audioBuffer, filename, cleanMime);

    return res.json({ success: true, transcript, empty: transcript.length === 0 });

  } catch (err) {
    console.error('[Hugo Widget] STT error:', err.message);
    // Detect rate limiting so client can show appropriate message
    const isRateLimited = err.message && (
      err.message.includes('429') ||
      err.message.includes('rate') ||
      err.message.includes('limit') ||
      err.message.includes('Connection error')
    );
    return res.status(isRateLimited ? 429 : 500).json({
      success: false,
      rate_limited: isRateLimited,
      message: isRateLimited
        ? 'Voice service temporarily at capacity — please type instead.'
        : 'Speech recognition failed — please try typing instead.',
    });
  }
});

// ─── POST /api/hugo-widget/tts ────────────────────────────────────────────────
// Text-to-speech → returns audio/mpeg buffer

router.post('/tts', async (req, res) => {
  const { text, voice = 'echo' } = req.body || {};

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ success: false, message: 'text is required' });
  }

  const ttsText = text.trim().slice(0, 1000);
  const allowedVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  const selectedVoice = allowedVoices.includes(voice) ? voice : 'echo';

  try {
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: selectedVoice,
      input: ttsText,
      response_format: 'mp3',
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());

    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', buffer.length);
    res.set('Cache-Control', 'no-cache');
    return res.send(buffer);

  } catch (err) {
    console.error('[Hugo Widget] TTS error:', err.message);
    return res.status(500).json({ success: false, message: 'Voice generation failed.' });
  }
});

// ─── GET /api/hugo-widget/history ─────────────────────────────────────────────

router.get('/history', async (req, res) => {
  const sessionId = req.cookies?.hugo_widget_session || req.query?.session_id;

  if (!sessionId || !sessionId.startsWith('hw_')) {
    return res.json({ success: true, messages: [] });
  }

  let history = getHistory(sessionId);
  if (history.length === 0) {
    const dbSession = await loadWidgetSession(sessionId);
    history = dbSession?.messages || [];
  }

  return res.json({
    success: true,
    messages: history.map(m => ({ role: m.role, content: m.content })),
    session_id: sessionId,
  });
});

module.exports = router;
