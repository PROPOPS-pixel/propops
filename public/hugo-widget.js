/**
 * Hugo Widget v6.9 — Business Type = Single Source of Truth (aligned all 10 sites to v=13)
 *
 * Business Type setting drives the persona label (Hugo-Pro / Hugo-Trade / Hugo-Pays).
 * Widget reads window.POLSIACONFIG?.businessType on init — no domain detection.
 * Label is injected as identity anchor in Hugo's system prompt.
 *
 * Greeting: "G'day! I'm Hugo. Do you need a tradie today — or do you want to join the PropOps network?"
 * PATH 1: "I need a tradie" → lead qualification funnel → saved to network_leads
 * PATH 2: "I want to join" → tradie onboarding funnel → saved to network_signups
 *
 * v6.6 — VOICE FIX: never switch voices mid-conversation
 *
 * Drop on any page:
 *   <script src="/hugo-widget.js?v=14"></script>
 *
 * v6.6: VOICE CONSISTENCY FIX
 *   - Landing pages: NEVER fall back to browser speechSynthesis (prevents old-man voice)
 *   - Server TTS timeout increased 5s → 12s (long quotes were timing out)
 *   - Chunked TTS for long responses: splits at sentence boundaries, plays sequentially
 *   - Better text cleaning: strips $, ---, ×, bullet points, "inc GST" → spoken English
 *   - Dashboard still uses browser TTS (lower cost, acceptable voice variation)
 *
 * v6.5: ONE HUGO unification
 *   - Server-side TTS (OpenAI echo voice) for consistent young male voice on all platforms
 *   - Voice conversation mode: mic auto-reactivates after Hugo speaks
 *   - Bigger mic button on mobile (58px, round, easy to tap)
 *   - Same-origin script loading fixes propops.trade CORS issues
 *   - Landing pages use server TTS; dashboard uses browser TTS (lower cost)
 *
 * v6.3: FIXED VAD cutting off mid-sentence on web widget.
 * v6.1: FIXED voice STT → chat handoff bug.
 * v6.0: FIXED avatar overlap.
 *
 * Features:
 *   - Text chat with Hugo AI (single /api/hugo-widget/chat brain)
 *   - Voice input via browser Web Speech API (Chrome, Safari, Edge) — PRIMARY, free
 *   - Server-side STT fallback via Whisper (Firefox, iOS Chrome only)
 *   - Voice output via server-side OpenAI TTS (PRIMARY) + browser speechSynthesis (FALLBACK)
 *   - State machine: IDLE → LISTENING → PROCESSING → SPEAKING
 *   - Voice conversation mode: auto-mic after Hugo speaks
 *   - Watchdog timeouts prevent stuck states
 *   - Session persistence (7-day cookie)
 */
(function () {
  'use strict';

  const BASE_URL = (function () {
    const s = document.currentScript;
    if (s && s.src) return s.src.replace(/\/hugo-widget\.js(\?.*)?$/, '');
    return 'https://propops.pro';
  })();

  const API = {
    chat: BASE_URL + '/api/hugo-widget/chat',
    tts: BASE_URL + '/api/hugo-widget/tts',
  };

  // ─── State ──────────────────────────────────────────────────────────────────
  let isOpen = false;
  let sessionId = null;
  let isTTSEnabled = true;
  let isWaiting = false;
  let hasGreeted = false;
  let _widgetBusinessType = null; // set by dashboard via window.HugoWidget.setBusinessType()

  // ─── Hugo label mapping (Business Type → persona label) ────────────────────
  // Business Type is the SINGLE SOURCE OF TRUTH — no domain detection.
  // Injected as identity anchor in Hugo's system prompt.
  //
  // Mapping:
  //   'founder' → Hugo-Founder (founder/owner operator)
  //   'real_estate' / 're_agent' → Hugo-Pro (RE Agent bucket)
  //   'small_business' / 'pays' → Hugo-Pays (SB bucket)
  //   DYNAMIC CATEGORY (dashboard only): "Painter" → "Hugo-Painter", "Plumber" → "Hugo-Plumber"
  //     — comes from Settings → Business Type on operator dashboards
  //     — landing pages use bucket labels (Hugo-Trade), NOT dynamic — _isDashboard gates this
  //
  // Landing page POLSIACONFIG uses BUCKET values (real_estate / trade / pays).
  // Dashboard POLSIACONFIG uses ACTUAL CATEGORY names (Painter / Plumber / Electrician).
  function getHugoLabel(bt) {
    if (bt === 'founder') return 'Hugo-Founder';
    if (bt === 'real_estate' || bt === 're_agent') return 'Hugo-Pro';
    if (bt === 'small_business' || bt === 'pays') return 'Hugo-Pays';
    if (bt && typeof bt === 'string' && bt.length > 0 && bt.length < 40) {
      // Dynamic category: "Painter" → "Hugo-Painter", "Plumber" → "Hugo-Plumber"
      // ONLY apply to dashboard (_isDashboard=true). Landing pages use bucket labels.
      // Guard by checking _isDashboard since getHugoLabel doesn't take that param.
      if (_isDashboard) {
        var catCapitalized = bt.charAt(0).toUpperCase() + bt.slice(1).toLowerCase();
        return 'Hugo-' + catCapitalized;
      }
    }
    return 'Hugo-Trade'; // landing page or unknown bucket → Hugo-Trade
  }
  function getHugoLabelFromDomain() {
    var h = window.location.hostname || '';
    if (h.includes('hugopays.pro')) return 'Hugo-Pays';
    if (h === 'propops.pro' || h === 'www.propops.pro') return 'Hugo-Pro';
    return 'Hugo-Trade';
  }
  // Dashboard operator context — set by window.HugoWidget.setOperatorContext()
  // Injected into every chat call so Hugo knows WHO he's talking to on the dashboard.
  let _operatorName = null;
  let _operatorEmail = null;
  let _operatorTrade = null;
  let _operatorId = null; // operator_id for backend profile lookup (tech_notes, etc.)
  // Flag: are we running inside the operator dashboard?
  let _isDashboard = false;
  // Voice conversation mode — true when user's last input was via mic
  // When true, auto-reactivate mic after Hugo finishes speaking
  let _voiceConversationMode = false;
  // Server TTS audio element — stored so we can stop it on demand
  let _serverTTSAudio = null;

  // ─── Activity tracking for mic fallback gating ─────────────────────────────
  // Prevents "click the mic" prompt from firing during active user engagement.
  let _lastActivityAt = 0;       // timestamp of any user interaction (typing, sending, voice)
  let _lastMessageSentAt = 0;    // timestamp of last sent message
  let _micFallbackShown = false;  // only show mic fallback ONCE per widget open
  let _micFallbackTimer = null;   // idle timer reference
  var MIC_FALLBACK_IDLE_MS = 60000; // 60 seconds of inactivity before prompting

  // ─── Channel awareness: suppress browser TTS during active phone calls ─────
  // Prevents audio collision when caller has both phone + web widget open.
  window.HugoCallActive = false;
  var _callCheckInterval = null;

  function startCallActivePolling() {
    if (_callCheckInterval) return;
    checkCallActive(); // immediate first check
    _callCheckInterval = setInterval(checkCallActive, 10000); // poll every 10s
  }

  function checkCallActive() {
    fetch(BASE_URL + '/api/twilio/active-call', { credentials: 'include' })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        var wasActive = window.HugoCallActive;
        window.HugoCallActive = !!(data && data.active);
        if (window.HugoCallActive && !wasActive) {
          hwLog('CHANNEL', 'Phone call detected — suppressing browser TTS');
          // Stop any currently playing browser TTS
          if (window.speechSynthesis) window.speechSynthesis.cancel();
        } else if (!window.HugoCallActive && wasActive) {
          hwLog('CHANNEL', 'Phone call ended — browser TTS re-enabled');
        }
      })
      .catch(function() {
        // Network error — assume no call active (safe default)
        window.HugoCallActive = false;
      });
  }

  // ─── Activity tracking & mic fallback ───────────────────────────────────────
  // Records user activity to prevent mic fallback from spamming during engagement.
  function recordActivity() {
    _lastActivityAt = Date.now();
    // Every activity resets the idle timer
    resetMicFallbackTimer();
  }

  function resetMicFallbackTimer() {
    if (_micFallbackTimer) {
      clearTimeout(_micFallbackTimer);
      _micFallbackTimer = null;
    }
    // Only schedule mic fallback if widget is open, hasn't shown yet, and user has greeted
    if (isOpen && !_micFallbackShown && hasGreeted) {
      _micFallbackTimer = setTimeout(maybeShowMicFallback, MIC_FALLBACK_IDLE_MS);
    }
  }

  function maybeShowMicFallback() {
    _micFallbackTimer = null;

    // Guard 1: Widget must be open
    if (!isOpen) return;

    // Guard 2: Only show once per widget session
    if (_micFallbackShown) return;

    // Guard 3: User must NOT be actively typing (input has focus or has content)
    var input = document.getElementById('hw-input');
    if (input && (document.activeElement === input || (input.value && input.value.trim().length > 0))) {
      // User is typing — reschedule, don't show
      hwLog('MIC-FALLBACK', 'Suppressed — user is typing');
      resetMicFallbackTimer();
      return;
    }

    // Guard 4: User must NOT have sent a message in the last 30 seconds
    if (Date.now() - _lastMessageSentAt < 30000) {
      hwLog('MIC-FALLBACK', 'Suppressed — message sent recently');
      resetMicFallbackTimer();
      return;
    }

    // Guard 5: Must be truly idle (60s since last activity)
    if (Date.now() - _lastActivityAt < MIC_FALLBACK_IDLE_MS) {
      hwLog('MIC-FALLBACK', 'Suppressed — recent activity detected');
      resetMicFallbackTimer();
      return;
    }

    // Guard 6: Hugo must not be speaking or waiting for response
    if (HugoVoice.isSpeaking || HugoVoice.isListening || isWaiting) {
      hwLog('MIC-FALLBACK', 'Suppressed — Hugo busy (speaking/listening/waiting)');
      resetMicFallbackTimer();
      return;
    }

    // All guards passed — show the mic fallback once
    _micFallbackShown = true;
    hwLog('MIC-FALLBACK', 'Showing mic prompt (idle 60s+, no typing, no recent messages)');
    addMessage('hugo', "You can also click the mic button to talk to me \u2014 sometimes it's easier than typing! \ud83c\udf99\ufe0f");
  }

  function stopMicFallbackTimer() {
    if (_micFallbackTimer) {
      clearTimeout(_micFallbackTimer);
      _micFallbackTimer = null;
    }
  }

  // ─── Debug logging ─────────────────────────────────────────────────────────
  function hwLog(area, msg, data) {
    const prefix = '[Hugo Widget][' + area + ']';
    if (data !== undefined) {
      console.log(prefix, msg, data);
    } else {
      console.log(prefix, msg);
    }
  }

  // ─── Styles ─────────────────────────────────────────────────────────────────
  const STYLES = `
    #hugo-widget-btn {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 68px;
      height: 68px;
      border-radius: 50%;
      background: #0d1117;
      color: #f1f5f9;
      border: 2.5px solid rgba(240,165,0,0.5);
      cursor: pointer;
      z-index: 2147483000;
      box-shadow: 0 4px 20px rgba(0,0,0,0.45), 0 0 0 0 rgba(240,165,0,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
      font-family: sans-serif;
      padding: 0;
      overflow: hidden;
    }
    #hugo-widget-btn:hover {
      transform: translateY(-2px) scale(1.06);
      box-shadow: 0 6px 28px rgba(0,0,0,0.55), 0 0 0 4px rgba(240,165,0,0.18);
      border-color: rgba(240,165,0,0.8);
    }
    #hugo-widget-btn .hw-chat-icon {
      width: 100%; height: 100%;
      display: flex; align-items: center; justify-content: center;
    }
    #hugo-widget-btn .hw-chat-icon img {
      width: 100%; height: 100%;
      object-fit: cover; border-radius: 50%;
      pointer-events: none;
    }
    #hugo-widget-btn svg { pointer-events: none; }
    #hugo-widget-btn .hw-close-icon { display: none; }
    #hugo-widget-btn.hw-open .hw-chat-icon { display: none; }
    #hugo-widget-btn.hw-open .hw-close-icon { display: flex; align-items: center; justify-content: center; }

    #hugo-widget-pulse {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 68px;
      height: 68px;
      border-radius: 50%;
      background: rgba(240,165,0,0.25);
      z-index: 2147482999;
      animation: hw-pulse 2.5s ease-out infinite;
      pointer-events: none;
    }
    @keyframes hw-pulse {
      0% { transform: scale(1); opacity: 0.8; }
      70% { transform: scale(1.6); opacity: 0; }
      100% { transform: scale(1); opacity: 0; }
    }

    /* ─── Speech bubble greeting ─── */
    #hugo-widget-bubble {
      position: fixed;
      bottom: 100px;
      right: 24px;
      background: #0d1117;
      color: #f1f5f9;
      border: 1.5px solid rgba(240,165,0,0.35);
      border-radius: 14px;
      padding: 12px 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      line-height: 1.4;
      max-width: 220px;
      z-index: 2147483002;
      box-shadow: 0 8px 30px rgba(0,0,0,0.4), 0 0 0 1px rgba(240,165,0,0.06);
      cursor: pointer;
      animation: hw-bubble-in 0.4s cubic-bezier(0.16,1,0.3,1);
      display: none;
    }
    #hugo-widget-bubble::after {
      content: '';
      position: absolute;
      bottom: -8px;
      right: 26px;
      width: 14px;
      height: 14px;
      background: #0d1117;
      border-right: 1.5px solid rgba(240,165,0,0.35);
      border-bottom: 1.5px solid rgba(240,165,0,0.35);
      transform: rotate(45deg);
    }
    #hugo-widget-bubble .hw-bubble-close {
      position: absolute;
      top: 6px;
      right: 8px;
      background: none;
      border: none;
      color: #64748b;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 2px;
    }
    #hugo-widget-bubble .hw-bubble-close:hover { color: #94a3b8; }
    #hugo-widget-bubble .hw-bubble-name {
      font-weight: 700;
      color: #f0a500;
      font-size: 13px;
      margin-bottom: 4px;
    }
    @keyframes hw-bubble-in {
      from { opacity: 0; transform: translateY(10px) scale(0.95); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    @media (max-width: 480px) {
      #hugo-widget-bubble {
        right: 16px;
        bottom: 92px;
        max-width: 200px;
      }
    }

    #hugo-widget-panel {
      position: fixed;
      bottom: 96px;
      right: 24px;
      width: 380px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 120px);
      background: #0d1117;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px;
      z-index: 2147483001;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(240,165,0,0.08);
      display: none;
      flex-direction: column;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      animation: hw-slideup 0.22s cubic-bezier(0.16,1,0.3,1);
    }
    #hugo-widget-panel.hw-visible {
      display: flex;
    }
    @keyframes hw-slideup {
      from { opacity: 0; transform: translateY(16px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    /* Header */
    .hw-header {
      padding: 16px 18px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      display: flex;
      align-items: center;
      gap: 12px;
      background: #0d1117;
    }
    .hw-avatar {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      overflow: hidden;
      flex-shrink: 0;
      border: 1px solid rgba(240,165,0,0.3);
    }
    .hw-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .hw-header-text { flex: 1; }
    .hw-header-name {
      color: #f1f5f9;
      font-weight: 700;
      font-size: 15px;
      line-height: 1.2;
    }
    .hw-header-status {
      color: #64748b;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 5px;
      margin-top: 2px;
    }
    .hw-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #22c55e;
      flex-shrink: 0;
    }
    .hw-tts-toggle {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 6px 8px;
      color: #64748b;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      transition: all 0.15s;
      flex-shrink: 0;
    }
    .hw-tts-toggle:hover { color: #94a3b8; background: rgba(255,255,255,0.08); }
    .hw-tts-toggle.hw-active { color: #f0a500; border-color: rgba(240,165,0,0.3); background: rgba(240,165,0,0.08); }

    /* Messages */
    .hw-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.08) transparent;
    }
    .hw-messages::-webkit-scrollbar { width: 4px; }
    .hw-messages::-webkit-scrollbar-track { background: transparent; }
    .hw-messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

    .hw-msg {
      max-width: 88%;
      padding: 10px 14px;
      border-radius: 14px;
      font-size: 14px;
      line-height: 1.5;
      word-break: break-word;
    }
    .hw-msg-hugo {
      background: #1a2035;
      color: #e2e8f0;
      border-bottom-left-radius: 4px;
      align-self: flex-start;
    }
    .hw-msg-user {
      background: linear-gradient(135deg, #f0a500, #d97706);
      color: #0a0e1a;
      border-bottom-right-radius: 4px;
      align-self: flex-end;
      font-weight: 500;
    }
    .hw-msg-voice {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .hw-msg-voice::before {
      content: '🎤';
      font-size: 12px;
      opacity: 0.7;
    }

    /* Typing indicator */
    .hw-typing {
      align-self: flex-start;
      background: #1a2035;
      border-radius: 14px 14px 14px 4px;
      padding: 10px 14px;
      display: flex;
      gap: 5px;
      align-items: center;
    }
    .hw-dot {
      width: 7px;
      height: 7px;
      background: #64748b;
      border-radius: 50%;
      animation: hw-bounce 1.3s ease infinite;
    }
    .hw-dot:nth-child(2) { animation-delay: 0.2s; }
    .hw-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes hw-bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-5px); }
    }

    /* Input area */
    .hw-input-area {
      padding: 12px 14px 14px;
      border-top: 1px solid rgba(255,255,255,0.06);
      background: #0d1117;
      position: relative;
      z-index: 10;
    }
    .hw-input-row {
      display: flex !important;
      gap: 8px;
      align-items: center;
      position: relative;
      z-index: 11;
    }
    .hw-textarea {
      flex: 1;
      min-width: 0;
      background: #1a2035;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      color: #e2e8f0;
      font-size: 14px;
      font-family: inherit;
      padding: 10px 12px;
      resize: none;
      min-height: 44px;
      max-height: 120px;
      line-height: 1.4;
      outline: none;
      transition: border-color 0.15s;
    }
    .hw-textarea:focus { border-color: rgba(240,165,0,0.4); box-shadow: 0 0 0 2px rgba(240,165,0,0.1); }
    .hw-textarea::placeholder { color: #64748b; }

    .hw-btn {
      width: 46px;
      height: 46px;
      min-width: 46px;
      min-height: 46px;
      border-radius: 12px;
      border: none;
      cursor: pointer;
      display: flex !important;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.15s;
      font-size: 20px;
      visibility: visible !important;
      opacity: 1 !important;
    }
    .hw-send-btn {
      background: linear-gradient(135deg, #f0a500, #e89b00) !important;
      color: #0a0e1a !important;
      box-shadow: 0 3px 12px rgba(240,165,0,0.45), 0 0 0 2px rgba(240,165,0,0.15);
      border: 2px solid #f0a500 !important;
    }
    .hw-send-btn:hover { filter: brightness(1.15); transform: scale(1.08); box-shadow: 0 4px 16px rgba(240,165,0,0.6); }
    .hw-send-btn:disabled { opacity: 0.4; cursor: not-allowed; filter: none; transform: none; box-shadow: none; }

    .hw-mic-btn {
      background: rgba(240,165,0,0.15) !important;
      border: 2px solid #f0a500 !important;
      color: #f0a500 !important;
    }
    .hw-mic-btn:hover { background: rgba(240,165,0,0.25) !important; color: #fbbf24 !important; border-color: #fbbf24 !important; }
    .hw-mic-btn.hw-recording {
      background: rgba(239,68,68,0.2);
      border-color: rgba(239,68,68,0.5);
      color: #ef4444;
      animation: hw-pulse-red 1s ease infinite;
    }
    @keyframes hw-pulse-red {
      0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.4); }
      50% { box-shadow: 0 0 0 8px rgba(239,68,68,0); }
    }
    .hw-mic-btn.hw-speaking {
      background: rgba(240,165,0,0.15);
      border-color: rgba(240,165,0,0.4);
      color: #f0a500;
    }

    /* Voice banner */
    .hw-voice-banner {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: rgba(239,68,68,0.1);
      border-top: 1px solid rgba(239,68,68,0.15);
      font-size: 12px;
      color: #fca5a5;
    }
    .hw-voice-banner.hw-active { display: flex; }
    .hw-voice-banner svg { flex-shrink: 0; animation: hw-wave 1.2s ease infinite; }
    @keyframes hw-wave {
      0%, 100% { transform: scaleY(1); }
      50% { transform: scaleY(1.4); }
    }

    /* Playing indicator */
    .hw-playing-banner {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: rgba(240,165,0,0.08);
      border-top: 1px solid rgba(240,165,0,0.12);
      font-size: 12px;
      color: #fbbf24;
      cursor: pointer;
    }
    .hw-playing-banner.hw-active { display: flex; }
    .hw-stop-audio {
      margin-left: auto;
      font-size: 10px;
      text-decoration: underline;
      opacity: 0.7;
    }

    /* Powered by */
    .hw-footer {
      padding: 6px 14px 8px;
      text-align: center;
      font-size: 11px;
      color: #334155;
      border-top: 1px solid rgba(255,255,255,0.04);
    }
    .hw-footer a { color: #475569; text-decoration: none; }
    .hw-footer a:hover { color: #64748b; }

    /* HIDE FAB completely when panel is open — eliminates avatar overlap */
    #hugo-widget-btn.hw-open {
      display: none !important;
    }

    /* Panel close button (inside header) */
    .hw-close-btn {
      width: 32px;
      height: 32px;
      min-width: 32px;
      border-radius: 8px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      color: #94a3b8;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.15s;
      margin-left: 8px;
    }
    .hw-close-btn:hover { background: rgba(255,255,255,0.1); color: #e2e8f0; }

    /* Mobile overrides */
    @media (max-width: 480px) {
      #hugo-widget-panel {
        bottom: 0;
        right: 0;
        left: 0;
        width: 100%;
        max-width: 100%;
        border-radius: 20px 20px 0 0;
        max-height: 85vh;
      }
      #hugo-widget-btn {
        bottom: 16px;
        right: 16px;
      }
      #hugo-widget-pulse {
        bottom: 16px;
        right: 16px;
      }
      .hw-btn {
        width: 54px;
        height: 54px;
        min-width: 54px;
        min-height: 54px;
        font-size: 24px;
      }
      /* Bigger mic button on mobile — easier to tap */
      .hw-mic-btn {
        width: 58px !important;
        height: 58px !important;
        min-width: 58px !important;
        min-height: 58px !important;
        border-radius: 50% !important;
      }
    }
  `;

  // ─── Icons ──────────────────────────────────────────────────────────────────
  const HUGO_AVATAR_URL = 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_55743/images/97f2968e-b619-4377-b000-46e047b8393c.png';
  const ICON_CHAT = `<img src="${HUGO_AVATAR_URL}" alt="Hugo" />`;

  const ICON_CLOSE = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none">
    <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`;

  const ICON_SEND = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none">
    <path d="M22 2L11 13M22 2L15 22 11 13 2 9l20-7z" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  const ICON_MIC = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none">
    <rect x="9" y="2" width="6" height="12" rx="3" stroke="currentColor" stroke-width="2.2" fill="none"/>
    <path d="M5 10a7 7 0 0014 0" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M12 19v3M9 22h6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
  </svg>`;

  const ICON_STOP = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="2"/>
  </svg>`;

  const ICON_SPEAKER = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M11 5L6 9H2v6h4l5 4V5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`;

  const ICON_SPEAKER_OFF = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  // ═══════════════════════════════════════════════════════════════════════════════
  // HUGO VOICE MODULE v5.2
  // State machine: IDLE → LISTENING → PROCESSING → SPEAKING
  // v5.2: Browser-native SpeechRecognition is ALWAYS primary on Chrome/Edge/Safari.
  //       Server Whisper fallback ONLY for Firefox/browsers without Web Speech API.
  //       Removed permanent server-mode switch on transient network errors.
  // ═══════════════════════════════════════════════════════════════════════════════

  const HugoVoice = {
    // --- STATE FLAGS ---
    isListening: false,
    isSpeaking: false,
    recognition: null,
    watchdog: null,
    useServerSTT: false,    // ONLY true for browsers without SpeechRecognition (Firefox)
    mediaRecorder: null,
    audioChunks: [],
    _errorShown: false,
    _networkRetries: 0,     // v5.2: track network errors, don't permanently switch

    // --- CONFIG ---
    config: {
      lang: 'en-AU',
      voicePreference: ['James', 'Lee', 'Gordon', 'Daniel', 'Russell'],
      sttTimeout: 15000,       // v6.3: increased from 8s — continuous mode needs more time
      silenceTimeout: 2000,    // v6.3: 2s silence before ending (was ~1s browser default)
      serverSttTimeout: 12000,
      ttsGuard: 3000,
      maxNetworkRetries: 3   // v5.2: only fall back to server after 3 consecutive network errors
    },
    _silenceTimer: null,       // v6.3: custom silence detection timer
    _finalTranscript: '',      // v6.3: accumulated transcript from continuous recognition

    init: function() {
      var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        hwLog('STT', '[Hugo Widget] Using: server Whisper STT (browser SpeechRecognition not available)');
        this.useServerSTT = true;
      } else {
        // v5.2: ALWAYS use browser-native STT on Chrome/Edge/Safari — free, no tokens
        hwLog('STT', '[Hugo Widget] Using: browser-native STT (free, no token usage)');
        this.useServerSTT = false;
      }
      hwLog('VOICE', 'Voice Module v5.2 initialized. useServerSTT=' + this.useServerSTT);
      this.setupTTS();
    },

    // --- SPEECH TO TEXT (STT) — Browser Native ---
    toggleMic: function() {
      hwLog('MIC', 'toggleMic called. isListening=' + this.isListening + ', isSpeaking=' + this.isSpeaking + ', useServerSTT=' + this.useServerSTT);

      if (this.isListening) {
        this.stopMic();
        return;
      }

      // If Hugo is speaking, interrupt
      if (this.isSpeaking) this.stopSpeech();

      // v6.1: ALWAYS prefer browser-native STT. Only use server for browsers that
      // genuinely lack SpeechRecognition (Firefox, iOS). Never auto-switch to server
      // mode because server STT depends on Whisper API quota that may be exhausted.
      var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        // Browser has native STT — always use it regardless of previous errors
        this.useServerSTT = false;
        hwLog('STT', 'Activating: browser-native STT (always preferred)');
        this._startBrowserSTT();
      } else {
        hwLog('STT', 'Activating: server Whisper STT (browser has no Speech API)');
        this._startServerSTT();
      }
    },

    // v6.3: Clear the custom silence timer
    _clearSilenceTimer: function() {
      if (this._silenceTimer) {
        clearTimeout(this._silenceTimer);
        this._silenceTimer = null;
      }
    },

    // v6.3: Reset silence timer — called on every new speech result
    _resetSilenceTimer: function() {
      var self = this;
      self._clearSilenceTimer();
      self._silenceTimer = setTimeout(function() {
        hwLog('STT', 'Silence timeout (2s) — ending recognition');
        self._finishBrowserSTT();
      }, self.config.silenceTimeout);
    },

    // v6.3: Finish recognition — collect transcript and send
    _finishBrowserSTT: function() {
      this._clearSilenceTimer();
      this.clearWatchdog();

      // Stop recognition (triggers onend)
      if (this.recognition) {
        try { this.recognition.stop(); } catch (e) {}
      }

      var transcript = (this._finalTranscript || '').trim();
      hwLog('STT', 'Final transcript: "' + transcript + '"');
      this._finalTranscript = '';
      this.setVoiceState('isListening', false);

      if (transcript.length > 0) {
        if (window.sendHugoMessage) window.sendHugoMessage(transcript);
      } else {
        addMessage('hugo', "Didn't catch that \u2014 try speaking louder or closer to the mic!");
      }
    },

    _startBrowserSTT: function() {
      var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        // Genuine absence (Firefox, etc.) — use server mode
        hwLog('STT', 'Browser SpeechRecognition genuinely unavailable — using server STT');
        this.useServerSTT = true;
        this._startServerSTT();
        return;
      }

      // v6.3: Reset accumulated transcript
      this._finalTranscript = '';
      this._clearSilenceTimer();

      // v5.2: Fresh instance every time (eliminates Chrome reuse bug)
      this.recognition = new SpeechRecognition();
      // v6.3: continuous + interimResults = custom VAD with 2s silence threshold
      // Previously continuous=false caused browser's default ~1s VAD to cut off mid-sentence
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = this.config.lang;

      var self = this;
      var _sttHandled = false; // v6.3: prevent double-send from onend + silence timer

      this.recognition.onstart = function() {
        hwLog('STT', 'Browser STT active (continuous mode, 2s silence threshold) — listening...');
        self._networkRetries = 0; // Reset on successful start
        _sttHandled = false;
        self.setVoiceState('isListening', true);
        // v6.3: Watchdog is now a safety net for total session (15s), not silence detection
        self.startWatchdog(self.config.sttTimeout, function() {
          hwLog('STT', 'Watchdog fired (15s total) — forcing end');
          self._finishBrowserSTT();
        });
      };

      this.recognition.onresult = function(event) {
        // v6.3: Accumulate final results, track interim for silence detection
        var interim = '';
        var final = '';
        for (var i = 0; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            final += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }
        self._finalTranscript = final;
        hwLog('STT', 'Result — final: "' + final.trim() + '" | interim: "' + interim.trim() + '"');

        // v6.3: Every speech result resets the 2s silence timer
        // When user pauses for 2s, _finishBrowserSTT fires and sends the transcript
        self._resetSilenceTimer();
      };

      this.recognition.onerror = function(event) {
        hwLog('STT', 'Browser STT error: ' + event.error);
        self._clearSilenceTimer();

        // v6.3: In continuous mode, no-speech just means silence — not a hard error.
        // The silence timer handles this. Only abort on real errors.
        if (event.error === 'no-speech') {
          // If we have accumulated transcript, send it
          if ((self._finalTranscript || '').trim().length > 0) {
            self._finishBrowserSTT();
            return;
          }
          self.stopMic();
          addMessage('hugo', "Didn't hear anything \u2014 try again, speak a bit louder or closer to the mic!");
          return;
        }

        _sttHandled = true;
        self.stopMic();
        if (event.error === 'not-allowed' || event.error === 'permission-denied') {
          addMessage('hugo', "Mic access blocked \u2014 check the lock icon in your address bar, allow microphone, then try again. Or just type below!");
        } else if (event.error === 'network') {
          // v6.1: NEVER switch to server mode — server STT is less reliable (rate limits).
          self._networkRetries++;
          hwLog('STT', 'Network error count: ' + self._networkRetries + ' (staying in browser-native mode)');
          addMessage('hugo', "Voice hiccup \u2014 click the mic again to retry!");
        } else if (event.error === 'aborted') {
          // Aborted by user or programmatic stop — don't show error if we already handled it
          if (!_sttHandled && (self._finalTranscript || '').trim().length > 0) {
            self._finishBrowserSTT();
          }
        } else {
          addMessage('hugo', "Voice didn't come through \u2014 give it another go or type your message below!");
        }
      };

      this.recognition.onend = function() {
        hwLog('STT', 'Browser STT onend fired. handled=' + _sttHandled);
        self._clearSilenceTimer();
        self.clearWatchdog();

        // v6.3: If recognition ended naturally (e.g. browser decided to stop)
        // and we haven't handled the transcript yet, send it now
        if (!_sttHandled) {
          var transcript = (self._finalTranscript || '').trim();
          self._finalTranscript = '';
          self.setVoiceState('isListening', false);
          if (transcript.length > 0) {
            _sttHandled = true;
            hwLog('STT', 'onend — sending accumulated transcript: "' + transcript + '"');
            if (window.sendHugoMessage) window.sendHugoMessage(transcript);
          } else {
            self.setVoiceState('isListening', false);
          }
        } else {
          self.setVoiceState('isListening', false);
        }
      };

      try {
        this.recognition.start();
        hwLog('STT', 'Browser recognition.start() called (continuous mode, 2s silence VAD)');
      } catch (e) {
        hwLog('STT', 'Browser recognition start error: ' + e.message);
        addMessage('hugo', "Voice didn't start \u2014 click mic again or type below!");
        this.resetAll();
      }
    },

    // --- SPEECH TO TEXT (STT) — Server-side Whisper Fallback ---
    // ONLY used for Firefox or after maxNetworkRetries consecutive failures
    _startServerSTT: function() {
      var self = this;

      // Check MediaRecorder + getUserMedia support
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
        if (!this._errorShown) {
          this._errorShown = true;
          addMessage('hugo', "Voice input isn't available in your browser \u2014 no worries, just type below and I'll sort you out!");
          var micBtn = document.getElementById('hugo-mic-btn');
          if (micBtn) { micBtn.style.opacity = '0.3'; micBtn.title = 'Voice not supported'; }
        }
        return;
      }

      // Request microphone access
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
        self.audioChunks = [];
        self.setVoiceState('isListening', true);

        // Determine best supported MIME type
        var mimeType = 'audio/webm';
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
          mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4';
        } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
          mimeType = 'audio/ogg;codecs=opus';
        }

        self.mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });

        self.mediaRecorder.ondataavailable = function(event) {
          if (event.data.size > 0) self.audioChunks.push(event.data);
        };

        self.mediaRecorder.onstop = function() {
          // Stop all tracks
          stream.getTracks().forEach(function(t) { t.stop(); });

          if (self.audioChunks.length === 0) {
            self.setVoiceState('isListening', false);
            return;
          }

          var blob = new Blob(self.audioChunks, { type: mimeType.split(';')[0] });
          self.audioChunks = [];

          if (blob.size < 100) {
            self.setVoiceState('isListening', false);
            addMessage('hugo', "Didn't hear anything \u2014 try speaking a bit louder!");
            return;
          }

          // Send to server for Whisper transcription
          hwLog('STT', 'Sending ' + blob.size + ' bytes to server for transcription');
          self._sendAudioToServer(blob, mimeType.split(';')[0]);
        };

        self.mediaRecorder.start();
        hwLog('STT', 'Server STT: MediaRecorder started (' + mimeType + ')');

        // Auto-stop after timeout
        self.startWatchdog(self.config.serverSttTimeout, function() {
          self.stopMic();
        });

      }).catch(function(err) {
        hwLog('STT', 'Microphone access error: ' + err.message);
        self.setVoiceState('isListening', false);
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          addMessage('hugo', "Mic access blocked \u2014 check the lock icon in your address bar, allow microphone, then try again. Or just type below!");
        } else {
          if (!self._errorShown) {
            self._errorShown = true;
            addMessage('hugo', "Couldn't access your microphone \u2014 no worries, just type below!");
          }
        }
      });
    },

    _sendAudioToServer: function(blob, mimeType) {
      var self = this;
      self.setVoiceState('isListening', false);

      // Show processing state
      var bannerText = document.getElementById('hw-voice-banner-text');
      if (bannerText) bannerText.textContent = 'Processing voice\u2026';
      var voiceBanner = document.getElementById('hw-voice-banner');
      if (voiceBanner) voiceBanner.classList.add('hw-active');

      fetch(BASE_URL + '/api/hugo-widget/stt', {
        method: 'POST',
        headers: { 'Content-Type': mimeType },
        body: blob,
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (voiceBanner) voiceBanner.classList.remove('hw-active');
        if (data.success && data.transcript && data.transcript.trim().length > 0) {
          hwLog('STT', 'Server transcript: "' + data.transcript + '"');
          if (window.sendHugoMessage) window.sendHugoMessage(data.transcript.trim());
        } else {
          // v6.1: Server returned empty or error — show clear message
          hwLog('STT', 'Server STT returned empty/error: ' + JSON.stringify(data));
          if (data.rate_limited) {
            addMessage('hugo', "Voice is temporarily unavailable \u2014 please type your message below and I'll sort you out!");
          } else {
            addMessage('hugo', "Didn't catch that \u2014 try speaking louder or type your message below!");
          }
        }
      })
      .catch(function(err) {
        if (voiceBanner) voiceBanner.classList.remove('hw-active');
        hwLog('STT', 'Server STT network error: ' + err.message);
        addMessage('hugo', "Voice is temporarily unavailable \u2014 please type your message below and I'll sort you out!");
      });
    },

    // v6.1: Show clear feedback when server STT fails (kept for backwards compatibility)
    _switchBackToBrowserSTT: function() {
      var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        hwLog('STT', 'Browser-native STT available — user can retry with mic');
        this.useServerSTT = false;
        addMessage('hugo', "Didn't catch that \u2014 click the mic and try again!");
      } else {
        addMessage('hugo', "Voice isn't available right now \u2014 please type your message below and I'll sort you out!");
      }
    },

    stopMic: function() {
      // v6.3: Clear silence timer
      this._clearSilenceTimer();
      this._finalTranscript = '';
      // Stop browser recognition
      if (this.recognition) {
        try { this.recognition.abort(); } catch (e) {}
      }
      // Stop MediaRecorder (server STT)
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        try { this.mediaRecorder.stop(); } catch (e) {}
      }
      this.setVoiceState('isListening', false);
      this.clearWatchdog();
    },

    // --- TEXT TO SPEECH (TTS) ---
    // v6.4: Server-side TTS (OpenAI) is PRIMARY for consistent young voice.
    // Browser speechSynthesis is FALLBACK only (varies wildly by platform).
    setupTTS: function() {
      if (window.speechSynthesis && speechSynthesis.onvoiceschanged !== undefined) {
        var self = this;
        speechSynthesis.onvoiceschanged = function() { self.getAussieVoice(); };
      }
      var self = this;
      setTimeout(function() { self.getAussieVoice(); }, 500);
    },

    getAussieVoice: function() {
      if (!window.speechSynthesis) return null;
      var voices = speechSynthesis.getVoices();
      if (!voices || voices.length === 0) return null;

      var prefs = this.config.voicePreference;

      var match = voices.find(function(v) {
        return prefs.some(function(name) { return v.name.includes(name); }) && v.lang.includes('en');
      });
      if (match) return match;

      match = voices.find(function(v) {
        return v.lang === 'en-AU' && v.name.toLowerCase().includes('male');
      });
      if (match) return match;

      match = voices.find(function(v) { return v.lang.startsWith('en-AU'); });
      if (match) return match;

      match = voices.find(function(v) {
        return v.lang.includes('en') && v.name.toLowerCase().includes('male');
      });
      if (match) return match;

      match = voices.find(function(v) { return v.lang.startsWith('en'); });
      if (match) return match;

      return voices[0] || null;
    },

    // v6.6: Server-side TTS via OpenAI — consistent young male voice on all platforms
    // On landing pages: NEVER falls back to browser speechSynthesis (prevents voice change)
    // On error: silently ends speaking state instead of switching voices mid-conversation
    _speakServer: function(clean) {
      var self = this;
      self.setVoiceState('isSpeaking', true);
      var estimatedDuration = (clean.length / 10) * 1000 + 8000;
      self.startWatchdog(estimatedDuration, function() { self.stopSpeech(); self._maybeAutoMic(); });

      var controller = new AbortController();
      // v6.6: increased timeout from 5s → 12s — long quote responses need more time
      var timer = setTimeout(function() { controller.abort(); }, 12000);

      fetch(API.tts, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify({ text: clean, voice: 'echo' }),
      })
      .then(function(res) {
        clearTimeout(timer);
        if (!res.ok) throw new Error('TTS server returned ' + res.status);
        return res.blob();
      })
      .then(function(blob) {
        var url = URL.createObjectURL(blob);
        var audio = new Audio(url);
        _serverTTSAudio = audio;
        audio.onended = function() {
          URL.revokeObjectURL(url);
          _serverTTSAudio = null;
          self.setVoiceState('isSpeaking', false);
          self.clearWatchdog();
          self._maybeAutoMic();
        };
        audio.onerror = function() {
          URL.revokeObjectURL(url);
          _serverTTSAudio = null;
          self.setVoiceState('isSpeaking', false);
          self.clearWatchdog();
          // v6.7: NEVER fall back to browser TTS on landing pages OR pays dashboard
          // Browser TTS sounds robotic — silent failure is better than voice change
          var canFallbackBrowser = _isDashboard && _widgetBusinessType !== 'pays';
          if (canFallbackBrowser) {
            hwLog('TTS', 'Server audio playback failed — falling back to browser (non-pays dashboard)');
            self._speakBrowser(clean);
          } else {
            hwLog('TTS', 'Server audio playback failed — silent (no browser fallback)');
            self._maybeAutoMic();
          }
        };
        audio.play().catch(function() {
          URL.revokeObjectURL(url);
          _serverTTSAudio = null;
          self.setVoiceState('isSpeaking', false);
          self.clearWatchdog();
          var canFallbackBrowser = _isDashboard && _widgetBusinessType !== 'pays';
          if (canFallbackBrowser) {
            hwLog('TTS', 'Autoplay blocked — falling back to browser TTS (non-pays dashboard)');
            self._speakBrowser(clean);
          } else {
            hwLog('TTS', 'Autoplay blocked — silent (no browser fallback)');
            self._maybeAutoMic();
          }
        });
        hwLog('TTS', 'Playing server TTS audio (voice: echo, len=' + clean.length + ')');
      })
      .catch(function(err) {
        clearTimeout(timer);
        self.setVoiceState('isSpeaking', false);
        self.clearWatchdog();
        var canFallbackBrowser = _isDashboard && _widgetBusinessType !== 'pays';
        if (canFallbackBrowser) {
          hwLog('TTS', 'Server TTS failed: ' + err.message + ' — falling back to browser (non-pays dashboard)');
          self._speakBrowser(clean);
        } else {
          hwLog('TTS', 'Server TTS failed: ' + err.message + ' — silent (no browser fallback)');
          self._maybeAutoMic();
        }
      });
    },

    // v6.6: Chunked server TTS for long responses (>400 chars)
    // Splits text at sentence boundaries, fetches each chunk as server TTS,
    // plays them sequentially with the SAME OpenAI echo voice — no voice change.
    _speakServerChunked: function(fullText) {
      var self = this;
      // Split at sentence boundaries (. ! ?) keeping chunks under ~400 chars
      var sentences = fullText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [fullText];
      var chunks = [];
      var current = '';
      for (var i = 0; i < sentences.length; i++) {
        var s = sentences[i].trim();
        if (!s) continue;
        if ((current + ' ' + s).length > 400 && current.length > 0) {
          chunks.push(current.trim());
          current = s;
        } else {
          current = current ? current + ' ' + s : s;
        }
      }
      if (current.trim()) chunks.push(current.trim());
      if (chunks.length === 0) return;

      hwLog('TTS', 'Chunked TTS: ' + chunks.length + ' chunks from ' + fullText.length + ' chars');

      self.setVoiceState('isSpeaking', true);
      var totalEstimate = (fullText.length / 10) * 1000 + 10000;
      self.startWatchdog(totalEstimate, function() { self.stopSpeech(); self._maybeAutoMic(); });

      // Fetch ALL chunks in parallel for speed, then play sequentially
      var audioPromises = chunks.map(function(chunk) {
        return fetch(API.tts, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ text: chunk, voice: 'echo' }),
        }).then(function(res) {
          if (!res.ok) throw new Error('TTS chunk returned ' + res.status);
          return res.blob();
        }).catch(function(err) {
          hwLog('TTS', 'Chunk fetch failed: ' + err.message);
          return null; // Skip failed chunks — don't break the chain
        });
      });

      Promise.all(audioPromises).then(function(blobs) {
        // Filter out failed chunks
        var validBlobs = blobs.filter(function(b) { return b !== null; });
        if (validBlobs.length === 0) {
          hwLog('TTS', 'All TTS chunks failed — silent (no browser fallback)');
          self.setVoiceState('isSpeaking', false);
          self.clearWatchdog();
          self._maybeAutoMic();
          return;
        }

        // Play blobs sequentially
        var idx = 0;
        function playNext() {
          if (idx >= validBlobs.length || !self.isSpeaking) {
            // All done or interrupted
            self.setVoiceState('isSpeaking', false);
            self.clearWatchdog();
            self._maybeAutoMic();
            return;
          }
          var url = URL.createObjectURL(validBlobs[idx]);
          var audio = new Audio(url);
          _serverTTSAudio = audio;
          audio.onended = function() {
            URL.revokeObjectURL(url);
            _serverTTSAudio = null;
            idx++;
            playNext();
          };
          audio.onerror = function() {
            URL.revokeObjectURL(url);
            _serverTTSAudio = null;
            idx++;
            playNext(); // Skip errored chunk, continue with next
          };
          audio.play().catch(function() {
            URL.revokeObjectURL(url);
            _serverTTSAudio = null;
            // Autoplay blocked on first chunk = can't play anything
            if (idx === 0) {
              hwLog('TTS', 'Autoplay blocked on first chunk — silent (no browser fallback)');
              self.setVoiceState('isSpeaking', false);
              self.clearWatchdog();
              self._maybeAutoMic();
            } else {
              idx++;
              playNext();
            }
          });
          hwLog('TTS', 'Playing chunk ' + (idx + 1) + '/' + validBlobs.length);
        }
        playNext();
      });
    },

    // Browser speechSynthesis fallback — used when server TTS is unavailable
    _speakBrowser: function(clean) {
      if (!window.speechSynthesis) { this._maybeAutoMic(); return; }
      var self = this;
      var utterance = new SpeechSynthesisUtterance(clean);
      var voice = this.getAussieVoice();
      if (voice) utterance.voice = voice;
      utterance.lang = this.config.lang;
      utterance.rate = 1.08;
      utterance.pitch = 1.15; // Slightly higher pitch for younger sound

      utterance.onstart = function() {
        self.setVoiceState('isSpeaking', true);
        var estimatedDuration = (clean.length / 15) * 1000 + self.config.ttsGuard;
        self.startWatchdog(estimatedDuration, function() { self.stopSpeech(); self._maybeAutoMic(); });
      };
      utterance.onend = function() { self.stopSpeech(); self._maybeAutoMic(); };
      utterance.onerror = function() { self.stopSpeech(); self._maybeAutoMic(); };

      hwLog('TTS', 'Browser TTS with: ' + (voice ? voice.name : 'Default'));
      window.speechSynthesis.speak(utterance);
    },

    // v6.6: Clean text for TTS — strips markdown, special chars, emojis
    // so the TTS engine gets plain spoken English without artifacts.
    _cleanForTTS: function(text) {
      return text
        .replace(/\*\*(.+?)\*\*/g, '$1')       // bold markdown
        .replace(/^---+$/gm, '')                // horizontal rules
        .replace(/^-\s+/gm, ', ')              // bullet points → comma pause
        .replace(/\n/g, '. ')                   // newlines → sentence breaks
        .replace(/\$\s?(\d[\d,.]*)/g, '$1 dollars')  // "$2,211" → "2211 dollars"
        .replace(/×/g, ' by ')                  // multiplication sign
        .replace(/inc\.?\s*GST/gi, 'including GST')  // "inc GST" → "including GST"
        .replace(/ex\.?\s*GST/gi, 'excluding GST')
        .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')  // emojis
        .replace(/[#*_~`|>]/g, '')              // remaining markdown chars
        .replace(/\s+/g, ' ')
        .trim();
    },

    speak: function(text) {
      if (!text || !isTTSEnabled) return;
      // Channel awareness: suppress TTS during active phone calls
      if (window.HugoCallActive) {
        hwLog('TTS', 'Suppressed — phone call active');
        return;
      }
      this.stopSpeech();

      var clean = this._cleanForTTS(text);
      if (clean.length === 0) return;

      // v6.7: Use server-side TTS everywhere EXCEPT non-pays dashboards.
      // WHY: browser speechSynthesis produces a robotic "old man voice" that operators
      // hate. Server TTS (OpenAI echo) is consistent and natural. The cost tradeoff
      // is worth it for pays dashboard where voice is a primary interaction mode.
      // Non-pays dashboards still use browser TTS to keep costs low.
      var useServerTTS = !_isDashboard || _widgetBusinessType === 'pays';
      if (useServerTTS) {
        // Server TTS: consistent young male voice (OpenAI echo) on all platforms
        // For long responses, chunk into segments and play sequentially
        if (clean.length > 400) {
          this._speakServerChunked(clean);
        } else {
          this._speakServer(clean);
        }
      } else {
        this._speakBrowser(clean.slice(0, 400));
      }
    },

    // v6.4: Auto-reactivate mic after Hugo finishes speaking (voice conversation mode)
    _maybeAutoMic: function() {
      if (!_voiceConversationMode || !isOpen || isWaiting) return;
      if (this.isListening) return; // Already listening
      var self = this;
      // Short delay prevents audio feedback loop
      setTimeout(function() {
        if (!_voiceConversationMode || !isOpen || isWaiting || self.isListening || self.isSpeaking) return;
        hwLog('MIC', 'Auto-reactivating mic (voice conversation mode)');
        self.toggleMic();
      }, 600);
    },

    stopSpeech: function() {
      // Stop server-side TTS audio
      if (_serverTTSAudio) {
        try { _serverTTSAudio.pause(); _serverTTSAudio.currentTime = 0; } catch(e) {}
        _serverTTSAudio = null;
      }
      // Stop browser TTS
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      this.setVoiceState('isSpeaking', false);
      this.clearWatchdog();
    },

    // --- UTILITIES ---
    setVoiceState: function(flag, value) {
      this[flag] = value;
      hwLog('STATE', flag.toUpperCase() + ': ' + value);

      // Update UI elements
      var micBtn = document.getElementById('hugo-mic-btn');
      var voiceBanner = document.getElementById('hw-voice-banner');
      var playingBanner = document.getElementById('hw-playing-banner');

      if (micBtn) {
        micBtn.classList.toggle('hw-recording', this.isListening);
        micBtn.classList.toggle('hw-speaking', this.isSpeaking);
      }
      if (voiceBanner) {
        voiceBanner.classList.toggle('hw-active', this.isListening);
      }
      if (playingBanner) {
        playingBanner.classList.toggle('hw-active', this.isSpeaking);
      }
    },

    startWatchdog: function(ms, callback) {
      this.clearWatchdog();
      this.watchdog = setTimeout(function() {
        hwLog('WATCHDOG', 'Force resetting stuck state after ' + ms + 'ms');
        callback();
      }, ms);
    },

    clearWatchdog: function() {
      if (this.watchdog) {
        clearTimeout(this.watchdog);
        this.watchdog = null;
      }
    },

    resetAll: function() {
      this._clearSilenceTimer();
      this._finalTranscript = '';
      this.stopMic();
      this.stopSpeech();
      this.clearWatchdog();
      hwLog('STATE', 'ALL RESET');
    }
  };

  // ─── Build DOM ───────────────────────────────────────────────────────────────
  function buildWidget() {
    // Inject styles
    const styleEl = document.createElement('style');
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);

    // Pulse ring (behind button)
    const pulse = document.createElement('div');
    pulse.id = 'hugo-widget-pulse';
    document.body.appendChild(pulse);

    // FAB button
    const btn = document.createElement('button');
    btn.id = 'hugo-widget-btn';
    btn.setAttribute('aria-label', 'Chat with Hugo');
    btn.innerHTML = `<span class="hw-chat-icon">${ICON_CHAT}</span><span class="hw-close-icon">${ICON_CLOSE}</span>`;
    btn.onclick = toggleWidget;
    document.body.appendChild(btn);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'hugo-widget-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Hugo chat');
    panel.innerHTML = buildPanelHTML();
    document.body.appendChild(panel);

    // Wire up events
    document.getElementById('hw-send').onclick = function (e) { e.preventDefault(); sendMessage(); };
    document.getElementById('hugo-mic-btn').onclick = function () { recordActivity(); _micFallbackShown = true; _voiceConversationMode = true; HugoVoice.toggleMic(); };
    document.getElementById('hw-tts-toggle').onclick = toggleTTS;
    document.getElementById('hw-panel-close').onclick = function () { toggleWidget(); };

    const textarea = document.getElementById('hw-input');
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
      _voiceConversationMode = false; // User is typing — exit voice mode
      recordActivity();
    });
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
      recordActivity(); // Track typing activity
    });
    textarea.addEventListener('focus', () => {
      recordActivity(); // Track input focus
    });

    // Stop audio on banner click
    document.getElementById('hw-playing-banner').onclick = function () { HugoVoice.stopSpeech(); };

    // Speech bubble greeting — shows after 3s, auto-hides after 12s
    setTimeout(() => {
      if (isOpen) return; // Don't show if chat already open
      // Domain-aware greeting text
      const hostname = window.location.hostname || '';
      let bubbleText = "G\u2019day! Need a tradie \u2014 or want to join the network? I\u2019m Hugo \ud83e\udd19";
      if (hostname.includes('propops.pro') && !hostname.includes('hugopays')) {
        bubbleText = "G\u2019day! Need help with property management or inspections? I\u2019m Hugo \ud83e\udd19";
      } else if (hostname.includes('hugopays.pro')) {
        bubbleText = "G\u2019day! Need help with invoicing, rostering, or payroll? I\u2019m Hugo \ud83e\udd19";
      }
      // propops.trade keeps the default tradie copy above
      const bubble = document.createElement('div');
      bubble.id = 'hugo-widget-bubble';
      bubble.innerHTML = `
        <button class="hw-bubble-close" aria-label="Dismiss">&times;</button>
        <div class="hw-bubble-name">Hugo</div>
        <div>${bubbleText}</div>
      `;
      bubble.addEventListener('click', (e) => {
        if (e.target.classList.contains('hw-bubble-close')) {
          bubble.style.display = 'none';
          return;
        }
        bubble.style.display = 'none';
        if (!isOpen) toggleWidget();
      });
      document.body.appendChild(bubble);
      bubble.style.display = 'block';
      // Auto-hide after 12s
      setTimeout(() => { if (bubble && !isOpen) bubble.style.display = 'none'; }, 12000);
    }, 3000);
  }

  function buildPanelHTML() {
    return `
      <div class="hw-header">
        <div class="hw-avatar"><img src="${HUGO_AVATAR_URL}" alt="Hugo" /></div>
        <div class="hw-header-text">
          <div class="hw-header-name">Hugo</div>
          <div class="hw-header-status">
            <span class="hw-status-dot"></span>
            <span>AI Receptionist · PropOps</span>
          </div>
        </div>
        <button class="hw-tts-toggle hw-active" id="hw-tts-toggle" title="Toggle voice" aria-label="Toggle voice output">
          ${ICON_SPEAKER}
        </button>
        <button class="hw-close-btn" id="hw-panel-close" title="Close" aria-label="Close chat">
          ${ICON_CLOSE}
        </button>
      </div>

      <div class="hw-messages" id="hw-messages" role="log" aria-live="polite">
      </div>

      <div class="hw-voice-banner" id="hw-voice-banner">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="#ef4444">
          <rect x="2" y="8" width="3" height="8" rx="1"/>
          <rect x="7" y="4" width="3" height="16" rx="1"/>
          <rect x="12" y="6" width="3" height="12" rx="1"/>
          <rect x="17" y="9" width="3" height="6" rx="1"/>
        </svg>
        <span id="hw-voice-banner-text">Listening\u2026 speak now</span>
      </div>

      <div class="hw-playing-banner" id="hw-playing-banner">
        ${ICON_SPEAKER}
        <span>Hugo is speaking\u2026</span>
        <span class="hw-stop-audio">stop</span>
      </div>

      <div class="hw-input-area">
        <div class="hw-input-row">
          <button class="hw-btn hw-mic-btn" id="hugo-mic-btn" title="Voice input" aria-label="Voice input">
            ${ICON_MIC}
          </button>
          <textarea
            class="hw-textarea"
            id="hw-input"
            placeholder="Ask Hugo anything\u2026"
            rows="1"
            aria-label="Message Hugo"
          ></textarea>
          <button class="hw-btn hw-send-btn" id="hw-send" title="Send" aria-label="Send message">
            ${ICON_SEND}
          </button>
        </div>
      </div>

      <div class="hw-footer">
        Powered by <a href="https://propops.pro" target="_blank" rel="noopener">PropOps Hugo</a>
      </div>
    `;
  }

  // ─── Toggle widget ───────────────────────────────────────────────────────────
  function toggleWidget() {
    isOpen = !isOpen;
    const panel = document.getElementById('hugo-widget-panel');
    const btn = document.getElementById('hugo-widget-btn');
    const pulse = document.getElementById('hugo-widget-pulse');

    if (isOpen) {
      panel.classList.add('hw-visible');
      btn.classList.add('hw-open');
      if (pulse) pulse.style.display = 'none';
      // Hide speech bubble when chat opens
      const bubble = document.getElementById('hugo-widget-bubble');
      if (bubble) bubble.style.display = 'none';
      document.getElementById('hw-input').focus();

      // Reset mic fallback state on each open
      _micFallbackShown = false;
      recordActivity(); // Widget open counts as activity

      if (!hasGreeted) {
        hasGreeted = true;
        // Small delay for animation
        setTimeout(sendGreeting, 300);
      }
    } else {
      panel.classList.remove('hw-visible');
      btn.classList.remove('hw-open');
      // Re-show FAB when panel closes (CSS display:none is via .hw-open class)
      if (pulse) pulse.style.display = 'block';
      HugoVoice.resetAll();
      stopMicFallbackTimer(); // Cancel mic fallback when widget closes
    }
  }

  // Expose globally so landing pages can call openHugoChat() → __hugoToggleWidget()
  window.__hugoToggleWidget = function () {
    if (!isOpen) toggleWidget();
  };

  // ─── Greeting ────────────────────────────────────────────────────────────────
  function sendGreeting() {
    var msg, spokenMsg;
    // Determine Hugo's label: POLSIACONFIG businessType first, domain fallback second.
    // Label must match the persona brain Hugo fires (Hugo-Pro / Hugo-Trade / Hugo-Pays).
    var hugoLabel;
    if (_widgetBusinessType) {
      hugoLabel = getHugoLabel(_widgetBusinessType);
    } else {
      hugoLabel = getHugoLabelFromDomain();
    }

    // Dashboard greeting: trade-specific, knows the operator context
    if (_isDashboard) {
      var tradeLabel = _operatorTrade || (_widgetBusinessType && _widgetBusinessType !== 'real_estate' ? _widgetBusinessType.replace(/_/g, ' ') : null);
      var operatorFirstName = _operatorName ? _operatorName.split(' ')[0] : null;
      if (hugoLabel === 'Hugo-Founder') {
        // Founder dashboard — operations manager mode
        var founderGreet = operatorFirstName ? "G'day " + operatorFirstName + "!" : "G'day!";
        msg = founderGreet + " I\u2019m " + hugoLabel + " \u2014 your PropOps operations manager. What\u2019s on the agenda today? \ud83e\udd81";
        spokenMsg = founderGreet + " I'm " + hugoLabel + ", your PropOps operations manager. What's on the agenda today?";
      } else if (hugoLabel === 'Hugo-Pays') {
        // PAYS dashboard — payroll/rostering/invoicing persona.
        // Hugo is staff who showed up for work — greets the boss by name.
        var paysGreet = operatorFirstName ? "G'day " + operatorFirstName + "!" : "G'day boss!";
        msg = paysGreet + " I\u2019m " + hugoLabel + " \u2014 your payroll brain. Ask me about staff, rosters, pay runs, invoices, super, or PAYG. I pull real data \u2014 no guessing. What do you need? \ud83d\udcbc";
        spokenMsg = paysGreet + " I'm " + hugoLabel + ", your payroll brain. Ask me about staff, rosters, pay runs, or invoices. What do you need?";
      } else if (tradeLabel && _widgetBusinessType !== 'real_estate' && _widgetBusinessType !== 're_agent') {
        // Dynamic trade dashboard (Painter, Plumber, Electrician, etc.) — label matches Settings Category
        tradeLabel = tradeLabel.charAt(0).toUpperCase() + tradeLabel.slice(1).toLowerCase();
        var nameGreet = operatorFirstName ? "G'day " + operatorFirstName + "!" : "G'day!";
        msg = nameGreet + " I\u2019m " + hugoLabel + " \u2014 your PropOps AI for " + tradeLabel + ". I can help with dashboard questions, walk you through setup, or show you what I'd say to your customers. What do you need? \ud83e\udd19";
        spokenMsg = nameGreet + " I'm " + hugoLabel + ", your PropOps AI for " + tradeLabel + ". How can I help?";
      } else {
        // RE agent dashboard
        var nameGreet2 = operatorFirstName ? "G'day " + operatorFirstName + "!" : "G'day!";
        msg = nameGreet2 + " I\u2019m " + hugoLabel + " \u2014 your PropOps AI. Need help with your dashboard, property enquiries, or want to see what I'd say to a customer? Just ask. \ud83e\udd19";
        spokenMsg = nameGreet2 + " I'm " + hugoLabel + ", your PropOps AI. How can I help?";
      }
    } else {
      // Public widget (landing pages) — persona matches Business Type setting.
      // Hugo opens with the two-path fork: need a tradie, or want to join?
      if (hugoLabel === 'Hugo-Pro') {
        // RE agent landing page (propops.pro with RE business type)
        msg = "G'day! I'm " + hugoLabel + " \u2014 PropOps' AI for real estate. Need help with property management, buyer enquiries, or inspections? Just tell me what you need and I'll sort it out. \ud83e\udd19";
        spokenMsg = "G'day! I'm " + hugoLabel + ", PropOps' AI for real estate. Need help with property management, buyer enquiries, or inspections? Just tell me what you need and I'll sort it out.";
      } else if (hugoLabel === 'Hugo-Pays') {
        // Hugo.Pays landing page — invoicing, rostering & payroll persona
        msg = "G\u2019day! I\u2019m " + hugoLabel + " \u2014 your AI for invoicing, rostering, and payroll. Got questions about GST invoices, staff scheduling, payment chasing, or pay runs? Fire away. \ud83d\udcb0";
        spokenMsg = "G'day! I'm " + hugoLabel + ", your AI for invoicing, rostering, and payroll. Got questions about invoices, staff scheduling, or pay runs? Fire away.";
      } else {
        // Hugo-Trade — Network Front Door for tradie landing pages
        msg = "G\u2019day! I\u2019m " + hugoLabel + ". Do you need a tradie today \u2014 or do you want to join the PropOps network? \ud83e\udd19";
        spokenMsg = "G'day! I'm " + hugoLabel + ". Do you need a tradie today — or do you want to join the PropOps network?";
      }
    }
    addMessage('hugo', msg);
    recordActivity(); // Greeting counts as activity — don't show mic fallback immediately
    // Speak greeting with Hugo's voice (browser TTS via state machine)
    HugoVoice.speak(spokenMsg);
  }

  // ─── Messages ────────────────────────────────────────────────────────────────
  function addMessage(role, text, isVoice) {
    const container = document.getElementById('hw-messages');
    const div = document.createElement('div');
    div.className = `hw-msg hw-msg-${role}` + (isVoice && role === 'user' ? ' hw-msg-voice' : '');

    // Strip internal formatting tokens, then convert markdown-style bold and newlines
    const cleaned = text.replace(/\[ACTIONS?:[^\]]*\]/gi, '').replace(/\[ACTIONS?\]/gi, '').trim();
    const safe = escapeHTML(cleaned)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    div.innerHTML = safe;

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  }

  function escapeHTML(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showTyping() {
    const container = document.getElementById('hw-messages');
    const div = document.createElement('div');
    div.className = 'hw-typing';
    div.id = 'hw-typing';
    div.innerHTML = '<div class="hw-dot"></div><div class="hw-dot"></div><div class="hw-dot"></div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function hideTyping() {
    const el = document.getElementById('hw-typing');
    if (el) el.remove();
  }

  // ─── Send message (with retry on 429/500) ───────────────────────────────────
  async function sendMessage(text, isVoice) {
    const textarea = document.getElementById('hw-input');
    const msg = (text || textarea.value || '').trim();
    if (!msg || isWaiting) return;

    if (!text) {
      textarea.value = '';
      textarea.style.height = 'auto';
    }

    addMessage('user', msg, !!isVoice);
    setWaiting(true);
    showTyping();
    _lastMessageSentAt = Date.now();
    recordActivity(); // Track message send
    hwLog('Chat', 'Sending message: ' + msg.slice(0, 50));

    const MAX_RETRIES = 2;
    let lastErr = null;
    let lastRes = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const body = { message: msg };
        if (sessionId) body.session_id = sessionId;
        if (_widgetBusinessType) body.business_type = _widgetBusinessType;
        // Pass hostname for brain service domain-aware routing
        body.hostname = window.location.hostname;

        // ── Anchor 1: Landing page WHERE ─────────────────────────────────────────
        // Tell Hugo which page he's on so he knows his persona + product context.
        body.page_url = window.location.href;
        // Extract meaningful visible text: heading, hero, CTAs. Keep it short.
        body.page_text = (function () {
          var parts = [];
          var h1 = document.querySelector('h1');
          if (h1 && h1.innerText) parts.push(h1.innerText.trim().slice(0, 200));
          var hero = document.querySelector('.hero, #hero, .hero-section, [class*="hero"]');
          if (hero && hero.innerText) {
            var heroText = hero.innerText.trim().replace(/\n+/g, ' ').slice(0, 300);
            if (heroText) parts.push(heroText);
          }
          var ctas = document.querySelectorAll('a[href*="signup"], a[href*="sign-up"], a[href*="trial"], a[href*="start"], .cta-btn, .cta-button, button[class*="cta"]');
          ctas.forEach(function (a) {
            var t = (a.innerText || a.textContent || '').trim().slice(0, 80);
            if (t && t.length > 3 && t.length < 80) parts.push(t);
          });
          return parts.slice(0, 5).join(' | ');
        })();

        // ── Anchor 2: Dashboard WHO (operator context) ───────────────────────────
        // setOperatorContext() called by dashboard — always send operator_email + operator_id
        // so Hugo knows who he represents AND can fetch operator profile (tech_notes, etc.).
        if (_operatorEmail) body.operator_email = _operatorEmail;
        if (_operatorName) body.operator_name = _operatorName;
        if (_operatorTrade) body.operator_trade = _operatorTrade;
        if (_operatorId) body.operator_id = _operatorId;

        // Pass visitor's preferred language (set by flag buttons on landing pages) — first message only
        if (!sessionId && window._hugoPreferredLang) {
          body.preferred_language = window._hugoPreferredLang;
        }
        // Inject dashboard flag so Hugo knows he's inside the dashboard (vs landing page)
        if (_isDashboard) {
          body.dashboard_context = true;
        }

        if (attempt > 0) {
          hwLog('Chat', 'Retry attempt ' + attempt + ' after backoff');
          await new Promise(r => setTimeout(r, 1500 * attempt));
        }

        const res = await fetch(API.chat, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });

        lastRes = res;

        // If 429 or 500/502/503, retry
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES - 1) {
          hwLog('Chat', 'Got status ' + res.status + ', will retry');
          continue;
        }

        const data = await res.json();

        hideTyping();

        if (data.success) {
          sessionId = data.session_id || sessionId;
          addMessage('hugo', data.reply);
          hwLog('Chat', 'Reply received, length=' + data.reply.length);
          recordActivity(); // AI reply = active conversation, reset idle timer
          // Speak the AI response via v4.0 state machine
          HugoVoice.speak(data.reply);
        } else if (res.status === 429) {
          addMessage('hugo', "I'm a bit overloaded right now \u2014 give me a minute and try again. I promise I'm worth the wait!");
        } else {
          hwLog('Chat', 'Error response: ' + (data.message || 'unknown'));
          addMessage('hugo', "Had a quick hiccup \u2014 give it another go in a sec!");
        }
        setWaiting(false);
        return;
      } catch (err) {
        lastErr = err;
        hwLog('Chat', 'Fetch error (attempt ' + attempt + '): ' + err.message);
        if (attempt < MAX_RETRIES - 1) continue;
      }
    }

    // All retries exhausted
    hideTyping();
    if (lastRes && lastRes.status === 429) {
      addMessage('hugo', "I'm a bit overloaded right now \u2014 give me a minute and try again. I promise I'm worth the wait!");
    } else {
      addMessage('hugo', "Connection's being dodgy \u2014 check your internet and try again in a tick.");
    }
    setWaiting(false);
  }

  // Expose sendMessage globally so HugoVoice STT can trigger chat
  window.sendHugoMessage = function (transcript) {
    if (transcript && transcript.trim().length > 0) {
      sendMessage(transcript.trim(), true);
    }
  };

  function setWaiting(val) {
    isWaiting = val;
    const sendBtn = document.getElementById('hw-send');
    if (sendBtn) sendBtn.disabled = val;

    // Safety guard: if stuck in waiting state for >12s, force reset
    // This prevents the widget from permanently blocking input after an error
    if (val) {
      if (window._hugoWaitingTimeout) clearTimeout(window._hugoWaitingTimeout);
      window._hugoWaitingTimeout = setTimeout(function () {
        if (isWaiting) {
          console.log('[Hugo][State] WARNING: Stuck in waiting — forcing reset');
          isWaiting = false;
          if (sendBtn) sendBtn.disabled = false;
          HugoVoice.isSpeaking = false;
          HugoVoice.isListening = false;
        }
      }, 12000);
    } else {
      if (window._hugoWaitingTimeout) {
        clearTimeout(window._hugoWaitingTimeout);
        window._hugoWaitingTimeout = null;
      }
    }
  }

  // ─── TTS Toggle ─────────────────────────────────────────────────────────────
  function toggleTTS() {
    isTTSEnabled = !isTTSEnabled;
    HugoVoice.stopSpeech();
    const btn = document.getElementById('hw-tts-toggle');
    if (btn) {
      btn.classList.toggle('hw-active', isTTSEnabled);
      btn.innerHTML = isTTSEnabled ? ICON_SPEAKER : ICON_SPEAKER_OFF;
      btn.title = isTTSEnabled ? 'Voice on \u2014 click to mute' : 'Voice off \u2014 click to unmute';
    }
  }

  // ─── Init ────────────────────────────────────────────────────────────────────
  function init() {
    hwLog('INIT', '=== Hugo Widget v6.7 starting (Business Type = single source of truth) ===');
    hwLog('INIT', 'SpeechRecognition available: ' + !!(window.SpeechRecognition || window.webkitSpeechRecognition));
    hwLog('INIT', 'MediaRecorder available: ' + !!window.MediaRecorder);
    hwLog('INIT', 'speechSynthesis available: ' + !!window.speechSynthesis);
    hwLog('INIT', 'Secure context (HTTPS): ' + window.isSecureContext);
    hwLog('INIT', 'Location: ' + window.location.origin + window.location.pathname);

    // Read Business Type from window.POLSIACONFIG (set by dashboard/Settings).
    // This is the SINGLE SOURCE OF TRUTH — no domain detection fallback.
    // Dashboard sets window.POLSIACONFIG = { businessType: 'plumber', ... }
    // so Hugo fires as Hugo-Trade for tradies, Hugo-Pro for RE agents, Hugo-Pays for small biz.
    if (window.POLSIACONFIG && window.POLSIACONFIG.businessType) {
      _widgetBusinessType = window.POLSIACONFIG.businessType;
      hwLog('CONFIG', 'Business type from window.POLSIACONFIG: ' + _widgetBusinessType + ' → label: ' + getHugoLabel(_widgetBusinessType));
    } else {
      // Fallback: derive from domain for backwards compat (old landing pages without POLSIACONFIG).
      // This path will be deprecated once all pages set POLSIACONFIG.
      var domainLabel = getHugoLabelFromDomain();
      hwLog('CONFIG', 'No POLSIACONFIG — deriving from domain: ' + domainLabel);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        buildWidget();
        HugoVoice.init();
        startCallActivePolling();
      });
    } else {
      buildWidget();
      HugoVoice.init();
      startCallActivePolling();
    }
    hwLog('INIT', '=== Widget ready ===');
  }

  // ─── Public API ─────────────────────────────────────────────────────────────
  // window.HugoWidget.setBusinessType(bt) — called by dashboard after initMode()
  // to pass the operator's actual business type so Hugo uses the right persona.
  window.HugoWidget = {
    setBusinessType: function(bt) {
      _widgetBusinessType = bt || null;
      hwLog('CONFIG', 'Business type set to: ' + (_widgetBusinessType || 'default'));
      // Always clear session when business type changes — ensures persona anchors at
      // session start and doesn't flip mid-conversation. Clears on first call AND re-set.
      if (sessionId) {
        sessionId = null;
        hasGreeted = false;
        const container = document.getElementById('hw-messages');
        if (container) container.innerHTML = '';
        hwLog('CONFIG', 'Session cleared on business type change');
      }
    },
    // setOperatorContext — called by dashboard after loadCurrentUser() and initMode()
    // Injects operator name, email, trade, and ID into Hugo's context so he knows who he's
    // talking to when running inside the dashboard (not on a landing page).
    setOperatorContext: function(name, email, trade, operatorId) {
      _operatorName = name || null;
      _operatorEmail = email || null;
      _operatorTrade = trade || null;
      _operatorId = operatorId || null;
      _isDashboard = true;
      hwLog('CONFIG', 'Operator context set — name:' + (_operatorName || 'none') + ', trade:' + (_operatorTrade || 'none') + ', id:' + (_operatorId || 'none'));
      // Clear session so next open starts with dashboard-aware context
      if (sessionId) {
        sessionId = null;
        hasGreeted = false;
        const container = document.getElementById('hw-messages');
        if (container) container.innerHTML = '';
        hwLog('CONFIG', 'Session cleared on operator context set');
      }
    },
    clearHistory: function() {
      sessionId = null;
      hasGreeted = false;
      const container = document.getElementById('hw-messages');
      if (container) container.innerHTML = '';
      hwLog('CONFIG', 'History cleared');
    },
  };

  init();

})();
