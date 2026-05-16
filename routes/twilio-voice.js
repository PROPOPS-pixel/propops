/**
 * Twilio Voice Webhook + Hugo Live Voice AI
 *
 * POST /api/webhooks/twilio/voice
 *   - Entry point: Twilio calls this when a call arrives on +61253010002.
 *   - Creates a voice_calls session, looks up the operator, responds with
 *     Hugo's greeting via TwiML <Say voice="Google.en-AU-Neural2-B"> + <Gather input="speech">.
 *
 * POST /api/webhooks/twilio/voice/gather
 *   - Called by Twilio after each <Gather> - delivers the caller's STT transcript.
 *   - Calls OpenAI for AI response, returns <Say>+<Gather> or <Hangup>.
 *
 * POST /api/webhooks/twilio/voice/status
 *   - Twilio status callback for call completion/failure events.
 *   - Finalises the session even if the caller hung up mid-conversation.
 *
 * GET  /api/twilio/vapid-public-key    - returns VAPID public key for push subscription
 * GET  /api/twilio/mappings            - list the authenticated tradie's phone mappings
 * POST /api/twilio/mappings            - add a phone mapping
 * DELETE /api/twilio/mappings/:id      - remove a phone mapping
 *
 * POST /api/push/subscribe             - save a browser push subscription
 * DELETE /api/push/subscribe           - remove push subscription by endpoint
 *
 * VOICE STRATEGY (2026-05-06):
 * All TTS uses Google Cloud Neural2 en-AU-Neural2-B (male, Australian English)
 * via Twilio's native Google TTS integration (no external calls, no streaming).
 * SSML is enabled: <break time="200ms"/> + <prosody rate="medium"> for a
 * confident, natural tradie drawl. Zero external audio files, zero R2 CDN.
 *
 * LATENCY STRATEGY (2026-05-06):
 * Filler + redirect pattern eliminates perceived dead air:
 *   /gather → kick off AI immediately → return filler phrase ("Mmhmm, just noting that")
 *   → Twilio plays filler (~1.5s) → <Redirect> to /think → AI result (usually ready)
 *   → return <Say> + <Gather>. Perceived gap: ~1.5s (was 3-4s).
 * DB writes (transcript, session updates) are fire-and-forget to avoid blocking.
 * AI timeouts reduced from 8s → 5s per path.
 * Gather uses speechModel="phone_call" + enhanced="true" for faster STT.
 *
 * Previous voice: Polly.Russell (Amazon Polly, retired 2026-05-06)
 */

'use strict';

const crypto  = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const { requireAuth } = require('./auth');
const { normalisePhone, getOrCreateVapidKey } = require('../services/missed-call');
const {
  createCallSession,
  getCallSession,
  updateCallSession,
  processVoiceTurn,
  finaliseCall,
} = require('../services/hugo-voice');

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// --- Pool warmup + keepalive: pre-connect to Neon, then ping every 4 min
pool.query('SELECT 1').then(() => {
  console.log('[TwilioVoice] DB pool warmed up');
}).catch(err => {
  console.error('[TwilioVoice] DB pool warmup failed (will retry on first query):', err.message);
});
setInterval(() => {
  pool.query('SELECT 1').catch(err => {
    console.warn('[TwilioVoice] Pool keepalive failed:', err.message);
  });
}, 4 * 60 * 1000);

// --- TwiML constants --------------------------------------------------------

const VOICE         = 'Google.en-AU-Neural2-B';  // Male Australian English (Google Cloud Neural2 via Twilio)
const LANGUAGE      = 'en-AU';
const GATHER_URL    = '/api/webhooks/twilio/voice/gather';
const STATUS_URL    = '/api/webhooks/twilio/voice/status';
const SPEECH_TIMEOUT = 'auto';
const GATHER_TIMEOUT = 10;
const THINK_URL      = '/api/webhooks/twilio/voice/think';

// --- Multilingual voice map -------------------------------------------------
// Priority languages for Australia (Twilio BCP-47 → Google Neural2 voice name).
// Fallback for detected language is ALWAYS English (en-AU).
// Twilio supports Google Cloud Neural2 voices where the locale prefix matches.
const LANGUAGE_VOICE_MAP = {
  'en-AU': { voice: 'Google.en-AU-Neural2-B', language: 'en-AU' }, // default
  'zh':    { voice: 'Google.cmn-CN-Wavenet-B', language: 'cmn-CN' }, // Mandarin
  'zh-TW': { voice: 'Google.cmn-TW-Wavenet-B', language: 'cmn-TW' }, // Cantonese/TW Mandarin
  'vi':    { voice: 'Google.vi-VN-Wavenet-B', language: 'vi-VN' },   // Vietnamese
  'ar':    { voice: 'Google.ar-XA-Wavenet-B', language: 'ar-XA' },   // Arabic
  'hi':    { voice: 'Google.hi-IN-Wavenet-B', language: 'hi-IN' },   // Hindi
  'el':    { voice: 'Google.el-GR-Wavenet-B', language: 'el-GR' },   // Greek
  'it':    { voice: 'Google.it-IT-Wavenet-B', language: 'it-IT' },   // Italian
  'ko':    { voice: 'Google.ko-KR-Wavenet-B', language: 'ko-KR' },   // Korean
  'fil':   { voice: 'Google.fil-PH-Wavenet-B', language: 'fil-PH' }, // Filipino
  'es':    { voice: 'Google.es-ES-Wavenet-B', language: 'es-ES' },   // Spanish
  'pt':    { voice: 'Google.pt-BR-Wavenet-B', language: 'pt-BR' },   // Portuguese
  'fr':    { voice: 'Google.fr-FR-Wavenet-B', language: 'fr-FR' },   // French
  'de':    { voice: 'Google.de-DE-Wavenet-B', language: 'de-DE' },   // German
  'ja':    { voice: 'Google.ja-JP-Wavenet-B', language: 'ja-JP' },   // Japanese
};
const DEFAULT_VOICE_CONFIG = LANGUAGE_VOICE_MAP['en-AU'];

/**
 * Detect the language of a transcript turn using a simple heuristic on Unicode ranges.
 * Returns a BCP-47 key for LANGUAGE_VOICE_MAP lookup (or null = keep current).
 * Runs synchronously — no external API call.
 */
function detectLanguageFromText(text) {
  if (!text || text.length < 3) return null;

  // CJK Unified Ideographs (Mandarin/Cantonese characters)
  if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(text)) return 'zh';
  // Arabic script
  if (/[\u0600-\u06FF\u0750-\u077F]/.test(text)) return 'ar';
  // Devanagari script (Hindi)
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  // Greek script
  if (/[\u0370-\u03FF]/.test(text)) return 'el';
  // Korean Hangul
  if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(text)) return 'ko';
  // Japanese Hiragana/Katakana
  if (/[\u3040-\u30FF]/.test(text)) return 'ja';
  // Vietnamese has unique diacritics — look for common sequences
  if (/[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(text)) return 'vi';
  // Filipino – Latin-based; detect via common words
  if (/\b(ako|nag|mga|ang|ng|po|opo|kumusta|salamat|paano|kayo)\b/i.test(text)) return 'fil';
  // Italian – common words
  if (/\b(ciao|grazie|prego|buongiorno|buonasera|come|stai|hai|sono|dove|quanto|cosa)\b/i.test(text)) return 'it';
  // Greek already handled via script above

  return null; // stays English
}

/**
 * Resolve the TwiML voice/language config for a call based on stored detected language.
 * @param {string|null} detectedLang - Language key from LANGUAGE_VOICE_MAP (or null)
 * @returns {{ voice: string, language: string }}
 */
function resolveVoiceConfig(detectedLang) {
  if (!detectedLang) return DEFAULT_VOICE_CONFIG;
  return LANGUAGE_VOICE_MAP[detectedLang] || DEFAULT_VOICE_CONFIG;
}

// --- Call statistics for diagnostic endpoint ---------------------------------
let _callStats = { total: 0, gathers: 0, noSpeech: 0, exitKeywords: 0, aiSuccess: 0, aiErrors: 0, lastCallAt: null };

// --- In-flight AI tasks: gather kicks off AI immediately, /think awaits it ---
const _pendingAI = new Map(); // callSid → Promise<{ reply, done }>
// Cleanup stale entries every 60s (calls that never hit /think)
setInterval(() => {
  const staleMs = 30_000;
  for (const [sid, entry] of _pendingAI) {
    if (Date.now() - entry.ts > staleMs) _pendingAI.delete(sid);
  }
}, 60_000);

// Filler phrases — short, natural, Australian. Buys ~1.5s while AI processes.
// NOTE: "Mmhmm" removed — too robotic/filler-sounding. Use natural Aussie alternatives.
const FILLERS = [
  "Ok cool, just noting that down.",
  "Yep, got it.",
  "No worries, one sec.",
  "Very good, bear with me.",
  "Too easy, just one moment.",
];
function pickFiller() {
  return FILLERS[Math.floor(Math.random() * FILLERS.length)];
}

// --- In-flight dedup: track CallSids to ignore Twilio retries
const _handledCallSids = new Set();
setInterval(() => { _handledCallSids.clear(); }, 5 * 60 * 1000);

// --- Static greeting texts ---------------------------------------------------
// Default greeting starts in Trade persona — dual-brain switches to RE on first RE signal.

const GREETING_TEXT = "G'day! I'm Hugo, powered by PropOps. What's your name and what do you do?";
const NO_SPEECH_TEXT = "Sorry, I didn't quite catch that. What can I help you with?";
const GOODBYE_TEXT = "Cheers for calling PropOps! Check out propops.pro to get Hugo working for your business. Have a good one!";

// --- XML escaping for TwiML content ------------------------------------------

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- TwiML builders (all synchronous, no external API calls) -----------------

/**
 * Wrap text in SSML for Google Neural2 voice.
 * Adds <prosody rate="medium"> for confident tradie drawl +
 * <break time="200ms"/> after sentences for natural pacing.
 */
function toSsml(text) {
  // Add a brief pause after sentence-ending punctuation for more natural delivery
  const paced = escapeXml(text).replace(/([.?!])\s+/g, '$1<break time="200ms"/> ');
  return `<speak><prosody rate="medium">${paced}</prosody></speak>`;
}

/**
 * Build TwiML that says greeting text inside a <Gather> for STT.
 * Uses Google.en-AU-Neural2-B (male Australian) via Twilio's native integration.
 * SSML enabled for natural prosody and pacing.
 * @param {string} text
 * @param {string} callSid
 * @param {{ voice: string, language: string }} [vc] - voice config (defaults to en-AU)
 */
function twimlSayGather(text, callSid, vc) {
  const v = vc || DEFAULT_VOICE_CONFIG;
  const actionUrl = `${GATHER_URL}?callSid=${encodeURIComponent(callSid)}`;
  const ssml = toSsml(text);
  // Gather accepts multiple languages for STT — always include en-AU as fallback
  const gatherLangs = v.language !== 'en-AU' ? `${v.language} en-AU` : v.language;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${actionUrl}" method="POST"
          speechTimeout="${SPEECH_TIMEOUT}" timeout="${GATHER_TIMEOUT}"
          language="${gatherLangs}" speechModel="phone_call" enhanced="true">
    <Say voice="${v.voice}" language="${v.language}">${ssml}</Say>
  </Gather>
  <Redirect method="POST">${actionUrl}&amp;noSpeech=true</Redirect>
</Response>`;
}

/**
 * Build TwiML that says a message and hangs up.
 * @param {string} text
 * @param {{ voice: string, language: string }} [vc] - voice config (defaults to en-AU)
 */
function twimlSayHangup(text, vc) {
  const v = vc || DEFAULT_VOICE_CONFIG;
  const ssml = toSsml(text);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${v.voice}" language="${v.language}">${ssml}</Say>
  <Pause length="1"/>
  <Hangup/>
</Response>`;
}

/**
 * Build TwiML that says a short filler phrase then redirects to /think.
 * The filler plays while AI is already processing in the background —
 * by the time the redirect fires, the response is (usually) ready.
 * @param {string} fillerText
 * @param {string} callSid
 * @param {{ voice: string, language: string }} [vc] - voice config (defaults to en-AU)
 */
function twimlFillerRedirect(fillerText, callSid, vc) {
  const v = vc || DEFAULT_VOICE_CONFIG;
  const thinkUrl = `${THINK_URL}?callSid=${encodeURIComponent(callSid)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${v.voice}" language="${v.language}">${escapeXml(fillerText)}</Say>
  <Redirect method="POST">${thinkUrl}</Redirect>
</Response>`;
}

/**
 * Build TwiML for no-speech detected - prompt again, then goodbye on second silence.
 * @param {string} callSid
 * @param {{ voice: string, language: string }} [vc] - voice config (defaults to en-AU)
 */
function twimlNoSpeech(callSid, vc) {
  const v = vc || DEFAULT_VOICE_CONFIG;
  const actionUrl = `${GATHER_URL}?callSid=${encodeURIComponent(callSid)}`;
  const noSpeechSsml = toSsml(NO_SPEECH_TEXT);
  const goodbyeSsml = toSsml(GOODBYE_TEXT);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${actionUrl}" method="POST"
          speechTimeout="${SPEECH_TIMEOUT}" timeout="${GATHER_TIMEOUT}"
          language="${v.language}" speechModel="phone_call" enhanced="true">
    <Say voice="${v.voice}" language="${v.language}">${noSpeechSsml}</Say>
  </Gather>
  <Say voice="${v.voice}" language="${v.language}">${goodbyeSsml}</Say>
  <Hangup/>
</Response>`;
}

// --- Twilio signature validation ---------------------------------------------

function validateTwilioSignature(authToken, signature, url, params) {
  if (!authToken || !signature) return false;

  const sortedKeys = Object.keys(params || {}).sort();
  let str = url;
  for (const key of sortedKeys) {
    str += key + (params[key] ?? '');
  }

  const expected = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(str, 'utf-8'))
    .digest('base64');

  try {
    const expBuf = Buffer.from(expected);
    const sigBuf = Buffer.from(signature);
    if (expBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(expBuf, sigBuf);
  } catch {
    return false;
  }
}

function checkTwilioSignature(req, res) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const skipValidation = process.env.TWILIO_SKIP_VALIDATION === 'true';

  if (skipValidation || !authToken) return true;

  const signature = req.headers['x-twilio-signature'];
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host  = req.headers['x-forwarded-host'] || req.get('host');

  // Twilio includes query parameters in the URL when computing signatures for POST requests.
  const fullUrl = `${proto}://${host}${req.originalUrl}`;

  if (!validateTwilioSignature(authToken, signature, fullUrl, req.body)) {
    console.warn('[TwilioVoice] Signature validation failed for', req.originalUrl);
    res.status(403).type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>`);
    return false;
  }
  return true;
}

// --- Operator lookup ---------------------------------------------------------

async function findOperatorByPhone(forwardedFromRaw) {
  const phone = normalisePhone(forwardedFromRaw);
  if (!phone) return null;

  try {
    const result = await pool.query(
      `SELECT u.*,
              op.business_name as business_name_from_profile,
              op.operator_name as operator_name_from_profile,
              op.trade_type, op.hourly_rate, op.callout_fee, op.emergency_available
       FROM tradie_phone_mappings tpm
       JOIN users u ON u.id = tpm.user_id
       LEFT JOIN operator_profiles op ON op.operator_id = u.id
       WHERE tpm.tradie_phone = $1
       LIMIT 1`,
      [phone]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('[TwilioVoice] findOperatorByPhone error:', err.message);
    return null;
  }
}

function getGreeting(operator) {
  const businessName = operator?.agency_name
    || operator?.business_name_from_profile
    || operator?.name
    || 'the team';
  return `G'day, this is Hugo from ${businessName}. The team's on a job right now, thanks for calling. How can I help?`;
}

function getUnmatchedGreeting() {
  return GREETING_TEXT;
}

// --- Legacy TTS endpoint (kept for backward compat, returns 410 Gone) --------

router.get('/tts/:id.mp3', (req, res) => {
  res.status(410).send('TTS audio endpoint retired - using Google Neural2 TTS');
});

// --- GET /api/twilio/voice-diagnostics - Debug endpoint for phone system ------
// Returns real-time stats on call processing to help diagnose issues.
router.get('/twilio/voice-diagnostics', async (req, res) => {
  try {
    // Recent call count from DB
    const recentCalls = await pool.query(
      `SELECT COUNT(*) as count, MAX(created_at) as last_call
       FROM voice_calls WHERE created_at > NOW() - INTERVAL '24 hours'`
    );
    const activeCalls = await pool.query(
      `SELECT call_sid, status, created_at, updated_at
       FROM voice_calls WHERE status = 'active'
         AND updated_at > NOW() - INTERVAL '30 minutes'
       ORDER BY created_at DESC LIMIT 5`
    );

    res.json({
      success: true,
      stats: _callStats,
      recent_24h: recentCalls.rows[0],
      active_calls: activeCalls.rows,
      config: {
        voice: VOICE,
        language: LANGUAGE,
        speech_timeout: SPEECH_TIMEOUT,
        gather_timeout: GATHER_TIMEOUT,
        gather_url: GATHER_URL,
        think_url: THINK_URL,
        twilio_auth_token_set: !!process.env.TWILIO_AUTH_TOKEN,
        twilio_skip_validation: process.env.TWILIO_SKIP_VALIDATION === 'true',
        gemini_key_set: !!process.env.GEMINI_API_KEY,
        polsia_api_key_set: !!process.env.POLSIA_API_KEY,
      },
      twiml_sample: twimlSayGather('Test greeting — this is what Twilio receives.', 'test-sid'),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- POST /api/webhooks/twilio/voice - Initial call entry --------------------

router.post('/webhooks/twilio/voice', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    if (!checkTwilioSignature(req, res)) return;

    const callerNumber  = req.body.From          || '';
    const twilioTo      = req.body.To            || '';
    const forwardedFrom = req.body.ForwardedFrom || req.body.OriginalCallTo || req.body.Diversion || '';
    const callSid       = req.body.CallSid       || `unknown-${Date.now()}`;

    // DEDUP: ignore Twilio retries
    if (_handledCallSids.has(callSid)) {
      console.log(`[TwilioVoice] Duplicate webhook for CallSid=${callSid}, returning cached greeting`);
      res.type('text/xml');
      return res.send(twimlSayGather(GREETING_TEXT, callSid));
    }
    _handledCallSids.add(callSid);

    console.log(`[TwilioVoice] Incoming call: CallSid=${callSid}, From=${callerNumber}, To=${twilioTo}, ForwardedFrom=${forwardedFrom}`);
    _callStats.total++;
    _callStats.lastCallAt = new Date().toISOString();

    // Operator lookup: race against 300ms timeout so we never delay the call.
    // When ForwardedFrom is present (call was forwarded from tradie's own number),
    // look up which operator it belongs to and personalise the greeting.
    let resolvedOperator = null;
    if (forwardedFrom) {
      try {
        resolvedOperator = await Promise.race([
          findOperatorByPhone(forwardedFrom),
          new Promise(resolve => setTimeout(() => resolve(null), 300)),
        ]);
        if (resolvedOperator) {
          console.log(`[TwilioVoice] Operator resolved: ${resolvedOperator.id} via ForwardedFrom="${forwardedFrom}"`);
        } else {
          console.log(`[TwilioVoice] No operator mapping for ForwardedFrom="${forwardedFrom}" — using PropOps default`);
        }
      } catch (err) {
        console.error('[TwilioVoice] Operator lookup error (non-fatal):', err.message);
      }
    }

    // Choose greeting: personalised for matched operator, generic PropOps for direct/unmatched calls
    const greetingText = resolvedOperator ? getGreeting(resolvedOperator) : getUnmatchedGreeting();
    const greetingTwiml = twimlSayGather(greetingText, callSid);
    console.log(`[TwilioVoice] Returning greeting (operator=${resolvedOperator?.id || 'none'}, ${greetingTwiml.length} bytes) for CallSid=${callSid}`);
    res.type('text/xml');
    res.send(greetingTwiml);

    // Background: session creation (fire-and-forget — operator already resolved above)
    setImmediate(async () => {
      try {
        await pool.query(
          `INSERT INTO voice_calls
             (call_sid, caller_number, operator_id, forwarded_from, status, transcript, lead_data)
           VALUES ($1, $2, $3, $4, 'active', '[]', '{}')
           ON CONFLICT (call_sid) DO UPDATE SET
             operator_id = COALESCE(EXCLUDED.operator_id, voice_calls.operator_id),
             updated_at = NOW()`,
          [callSid, normalisePhone(callerNumber), resolvedOperator?.id || null, forwardedFrom || null]
        );
      } catch (err) {
        console.error('[TwilioVoice] createCallSession error:', err.message);
      }
    });
  } catch (err) {
    console.error('[TwilioVoice] Incoming handler crashed:', err.message, err.stack);
    // Return valid TwiML even on crash - never let Twilio get an error
    res.type('text/xml');
    res.send(twimlSayHangup("Sorry about that. Give us a call back in just a moment and we'll get you sorted."));
  }
});

// --- POST /api/webhooks/twilio/voice/gather - STT result + AI response -------

router.post('/webhooks/twilio/voice/gather', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    if (!checkTwilioSignature(req, res)) return;

    const callSid      = req.query.callSid || req.body.CallSid || '';
    const noSpeech     = req.query.noSpeech === 'true';
    const speechResult = (req.body.SpeechResult || '').trim();

    console.log(`[TwilioVoice] Gather: CallSid=${callSid}, Speech="${speechResult.slice(0, 100)}", NoSpeech=${noSpeech}, BodyKeys=${Object.keys(req.body || {}).join(',')}`);
    _callStats.gathers++;

    res.type('text/xml');

    // --- Language detection ---
    // Detect the caller's language from the transcript on the first non-English turn.
    // Pull any previously detected lang from the pending entry or session (best-effort, non-blocking).
    let detectedLang = null;
    const existingEntry = _pendingAI.get(callSid);
    if (existingEntry && existingEntry.detectedLang) {
      detectedLang = existingEntry.detectedLang; // carry forward from prior turn
    } else {
      detectedLang = detectLanguageFromText(speechResult);
    }
    const voiceConfig = resolveVoiceConfig(detectedLang);
    if (detectedLang && detectedLang !== 'en-AU') {
      console.log(`[TwilioVoice] Language detected: "${detectedLang}" for CallSid=${callSid} — using voice "${voiceConfig.voice}"`);
    }

    // Handle no speech detected
    if (noSpeech || !speechResult) {
      _callStats.noSpeech++;
      console.log(`[TwilioVoice] No speech detected for CallSid=${callSid} — prompting again`);
      return res.send(twimlNoSpeech(callSid, voiceConfig));
    }

    // Check for exit keywords — fast path, no AI needed
    const lowerSpeech = speechResult.toLowerCase();
    if (/^(bye|goodbye|thanks bye|cheers|that'?s? all|no thanks)/.test(lowerSpeech)) {
      _callStats.exitKeywords++;
      finaliseCall(callSid).catch(err => {
        console.error('[TwilioVoice] finaliseCall error:', err.message);
      });
      return res.send(twimlSayHangup(
        "Cheers! Head to propops.pro to get started — Hugo's ready when you are. Have a good one!",
        voiceConfig
      ));
    }

    // --- Filler + redirect pattern ---
    // Kick off AI processing NOW (don't wait for it).
    // Return a short filler phrase so the caller hears acknowledgment in ~0.8s.
    // <Redirect> fires after the filler plays (~1.5s later) → /think awaits the AI result.
    // Pass fillerText to processVoiceTurn so the AI knows what was already spoken
    // and won't repeat the acknowledgment (prevents TTS vs text collision).
    // Pass detectedLang so the voice system prompt can instruct Hugo to respond in that language.
    const filler = pickFiller();
    const aiPromise = processVoiceTurn(callSid, speechResult, { fillerText: filler, detectedLang });
    // Prevent unhandled rejection crash if processVoiceTurn throws before /think attaches .catch()
    aiPromise.catch(err => {
      console.error(`[TwilioVoice] Background AI promise rejected for CallSid=${callSid}:`, err.message);
    });
    // Store speech + detected language alongside promise so /think can use the right voice
    _pendingAI.set(callSid, { promise: aiPromise, ts: Date.now(), speechResult, filler, detectedLang, voiceConfig });

    console.log(`[TwilioVoice] Returning filler "${filler}" for CallSid=${callSid}, AI processing in background`);
    return res.send(twimlFillerRedirect(filler, callSid, voiceConfig));

  } catch (err) {
    console.error('[TwilioVoice] Gather handler error:', err.message, err.stack);
    // Graceful fallback - never return an application error
    const callSid = req.query?.callSid || req.body?.CallSid || '';
    res.type('text/xml');
    return res.send(twimlSayGather(
      "Just a moment — could you say that again for me?",
      callSid
    ));
  }
});

// --- POST /api/webhooks/twilio/voice/think - Awaits AI result after filler ---

router.post('/webhooks/twilio/voice/think', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    if (!checkTwilioSignature(req, res)) return;

    const callSid = req.query.callSid || req.body.CallSid || '';
    res.type('text/xml');

    const entry = _pendingAI.get(callSid);
    if (!entry) {
      // No pending AI task — likely hit a different Render instance.
      // Retrieve the last speech from DB transcript and re-process the turn.
      console.warn(`[TwilioVoice] /think called with no pending AI for CallSid=${callSid} — re-processing turn`);
      try {
        const reResult = await processVoiceTurn(callSid, '', { fillerText: 'filler already played' });
        if (reResult.done) {
          finaliseCall(callSid).catch(e => console.error('[TwilioVoice] finaliseCall error:', e.message));
          return res.send(twimlSayHangup(reResult.reply));
        }
        return res.send(twimlSayGather(reResult.reply, callSid));
      } catch (reErr) {
        console.error(`[TwilioVoice] /think re-process failed for CallSid=${callSid}:`, reErr.message);
        return res.send(twimlSayGather(
          "Sorry, could you repeat that?",
          callSid
        ));
      }
    }

    // Carry the voice config through from /gather so the reply is in the right language
    const vc = entry.voiceConfig || DEFAULT_VOICE_CONFIG;

    // Await the AI result (it's been processing since /gather fired)
    // Add a safety timeout so we never hang the request
    let result;
    try {
      result = await Promise.race([
        entry.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('think_timeout')), 10_000)),
      ]);
    } catch (err) {
      console.error(`[TwilioVoice] /think AI await failed for CallSid=${callSid}:`, err.message);
      _pendingAI.delete(callSid);
      // Instead of giving up, try re-processing the turn with the stored speech
      try {
        const speech = entry.speechResult || '';
        console.log(`[TwilioVoice] /think retrying processVoiceTurn for CallSid=${callSid} with speech="${speech.slice(0, 50)}"`);
        const retryResult = await processVoiceTurn(callSid, speech, { fillerText: entry.filler || '', detectedLang: entry.detectedLang });
        if (retryResult.done) {
          finaliseCall(callSid).catch(e => console.error('[TwilioVoice] finaliseCall error:', e.message));
          return res.send(twimlSayHangup(retryResult.reply, vc));
        }
        return res.send(twimlSayGather(retryResult.reply, callSid, vc));
      } catch (retryErr) {
        console.error(`[TwilioVoice] /think retry also failed for CallSid=${callSid}:`, retryErr.message);
        return res.send(twimlSayGather(
          "One sec — could you repeat that for me?",
          callSid,
          vc
        ));
      }
    }

    _pendingAI.delete(callSid);

    const { reply, done, leadData: resultLeadData } = result;

    // Update voice config if the AI result carried a new detected language
    // (processVoiceTurn may detect language from the transcript independently)
    const finalLang = resultLeadData?._detectedLang || entry.detectedLang;
    const finalVc = resolveVoiceConfig(finalLang) || vc;

    if (done) {
      finaliseCall(callSid).catch(err => {
        console.error('[TwilioVoice] finaliseCall error:', err.message);
      });
      return res.send(twimlSayHangup(reply, finalVc));
    }

    // Continue conversation
    return res.send(twimlSayGather(reply, callSid, finalVc));

  } catch (err) {
    console.error('[TwilioVoice] /think handler error:', err.message, err.stack);
    const callSid = req.query?.callSid || req.body?.CallSid || '';
    _pendingAI.delete(callSid);
    res.type('text/xml');
    return res.send(twimlSayGather(
      "Just a moment — could you say that again?",
      callSid
    ));
  }
});

// --- POST /api/webhooks/twilio/voice/status - Call status updates ------------

router.post('/webhooks/twilio/voice/status', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const callSid    = req.body.CallSid    || '';
    const callStatus = req.body.CallStatus || '';

    console.log(`[TwilioVoice] Status update: CallSid=${callSid}, Status=${callStatus}`);

    if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(callStatus)) {
      try {
        const session = await getCallSession(callSid);
        if (session && session.status === 'active') {
          await finaliseCall(callSid);
        }
      } catch (err) {
        console.error('[TwilioVoice] status callback finaliseCall error:', err.message);
      }
    }

    res.sendStatus(204);
  } catch (err) {
    console.error('[TwilioVoice] Status handler error:', err.message);
    res.sendStatus(204); // Always 204 for status callbacks
  }
});

// --- GET /api/twilio/active-call - Check if there's an active voice call -----
// Used by the Hugo widget to detect active phone calls and suppress browser TTS
// to prevent audio collision (TTS vs text output on same session).

router.get('/twilio/active-call', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT call_sid FROM voice_calls
       WHERE status = 'active'
         AND updated_at > NOW() - INTERVAL '5 minutes'
       LIMIT 1`
    );
    res.json({
      success: true,
      active: result.rows.length > 0,
    });
  } catch (err) {
    console.error('[TwilioVoice] active-call check error:', err.message);
    res.json({ success: true, active: false });
  }
});

// --- GET /api/twilio/vapid-public-key ----------------------------------------

router.get('/twilio/vapid-public-key', async (req, res) => {
  try {
    const publicKey = await getOrCreateVapidKey('vapid_public_key');
    if (!publicKey) {
      return res.status(503).json({ success: false, message: 'VAPID keys not available' });
    }
    res.json({ success: true, publicKey });
  } catch (err) {
    console.error('[Twilio] vapid-public-key error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to retrieve VAPID key' });
  }
});

// --- GET /api/twilio/mappings ------------------------------------------------

router.get('/twilio/mappings', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, tradie_phone, label, created_at
       FROM tradie_phone_mappings
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ success: true, mappings: result.rows });
  } catch (err) {
    console.error('[Twilio] GET mappings error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load mappings' });
  }
});

// --- POST /api/twilio/mappings -----------------------------------------------

router.post('/twilio/mappings', requireAuth, async (req, res) => {
  const { tradie_phone, label } = req.body || {};

  if (!tradie_phone) {
    return res.status(400).json({ success: false, message: 'tradie_phone is required' });
  }

  const normalised = normalisePhone(tradie_phone);
  if (!normalised) {
    return res.status(400).json({ success: false, message: 'Invalid phone number format' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO tradie_phone_mappings (user_id, tradie_phone, label)
       VALUES ($1, $2, $3)
       ON CONFLICT (tradie_phone)
         DO UPDATE SET label = EXCLUDED.label
       RETURNING *`,
      [req.userId, normalised, label || null]
    );
    res.status(201).json({ success: true, mapping: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'That phone number is already mapped to another account',
      });
    }
    console.error('[Twilio] POST mappings error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create mapping' });
  }
});

// --- DELETE /api/twilio/mappings/:id -----------------------------------------

router.delete('/twilio/mappings/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM tradie_phone_mappings
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, req.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Mapping not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Twilio] DELETE mappings error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete mapping' });
  }
});

// --- POST /api/push/subscribe ------------------------------------------------

router.post('/push/subscribe', requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body || {};

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({
      success: false,
      message: 'endpoint, keys.p256dh, and keys.auth are required',
    });
  }

  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE
         SET p256dh = EXCLUDED.p256dh,
             auth   = EXCLUDED.auth,
             user_id = EXCLUDED.user_id`,
      [req.userId, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[Push] subscribe error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save subscription' });
  }
});

// --- DELETE /api/push/subscribe ----------------------------------------------

router.delete('/push/subscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};

  if (!endpoint) {
    return res.status(400).json({ success: false, message: 'endpoint is required' });
  }

  try {
    await pool.query(
      `DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`,
      [endpoint, req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[Push] unsubscribe error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to remove subscription' });
  }
});

module.exports = router;
