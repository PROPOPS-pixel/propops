/**
 * SMS service — sends SMS via Twilio REST API.
 *
 * Required env vars:
 *   TWILIO_ACCOUNT_SID           — Twilio account SID
 *   TWILIO_AUTH_TOKEN            — Twilio auth token
 *   TWILIO_MESSAGING_SERVICE_SID — Twilio Messaging Service SID (preferred, supports alphanumeric sender)
 *   TWILIO_FROM_NUMBER           — Fallback Twilio number in E.164 format
 *
 * Priority: TWILIO_MESSAGING_SERVICE_SID > TWILIO_FROM_NUMBER
 * When Messaging Service SID is set, Twilio routes through the Messaging Service,
 * which can use an alphanumeric sender ID (e.g. "PropOps") — no phone number required.
 *
 * All sends are non-throwing — errors are logged, never propagated.
 * Recipient numbers: AU +614XXXXXXXX format; other E.164 formats passed through as-is.
 * Trial accounts: SMS can only be sent to verified numbers in Twilio console.
 */

const https = require('https');

/**
 * Normalise a phone number to E.164 format (+61XXXXXXXXX for AU).
 * Accepts: 04XX XXX XXX, +61 4XX XXX XXX, 61-4XX-XXX-XXX, etc.
 * Returns null if it can't be normalised.
 */
function normaliseAustralianNumber(raw) {
  if (!raw) return null;
  // Strip all non-digit chars except leading +
  let digits = raw.replace(/[^\d+]/g, '');
  // Strip leading +
  const hadPlus = digits.startsWith('+');
  if (hadPlus) digits = digits.slice(1);

  // Already E.164 AU: 61 followed by 9 digits (e.g. 614XXXXXXXX)
  if (/^614\d{8}$/.test(digits)) return `+${digits}`;

  // AU local: 04XXXXXXXX (10 digits starting with 04)
  if (/^04\d{8}$/.test(digits)) return `+61${digits.slice(1)}`;

  // AU local without leading 0: 4XXXXXXXX (9 digits starting with 4)
  if (/^4\d{8}$/.test(digits)) return `+61${digits}`;

  // Already international (non-AU): pass through if looks valid
  if ((hadPlus || digits.length >= 10) && /^\d{7,15}$/.test(digits)) return `+${digits}`;

  return null;
}

/**
 * Send an SMS message via Twilio.
 * @param {object} opts
 * @param {string} opts.to   - Recipient number (will be normalised to E.164)
 * @param {string} opts.body - Message text (keep <160 chars for 1 segment)
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function sendSMS({ to, body }) {
  console.log(`[SMS] sendSms called for: ${to}`);
  const sid          = process.env.TWILIO_ACCOUNT_SID;
  const token        = process.env.TWILIO_AUTH_TOKEN;
  const messagingSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const fromNumber   = process.env.TWILIO_FROM_NUMBER;

  // Prefer Messaging Service SID (supports alphanumeric sender ID), fall back to phone number
  // These are mutually exclusive in the Twilio API — MessagingServiceSid OR From, never both
  if (!sid || !token) {
    console.warn('[SMS] Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing) — skipping');
    return { ok: false, reason: 'not_configured' };
  }
  if (!messagingSid && !fromNumber) {
    console.warn('[SMS] Twilio not configured (neither TWILIO_MESSAGING_SERVICE_SID nor TWILIO_FROM_NUMBER set) — skipping');
    return { ok: false, reason: 'not_configured' };
  }

  const toNormalized = normaliseAustralianNumber(to);
  if (!toNormalized) {
    console.warn(`[SMS] Invalid/unrecognised phone number: "${to}" — skipping`);
    return { ok: false, reason: 'invalid_number' };
  }

  const params = new URLSearchParams({ To: toNormalized, Body: body });
  if (messagingSid) {
    params.append('MessagingServiceSid', messagingSid);
  } else {
    params.append('From', fromNumber);
  }
  const paramsStr = params.toString();
  const auth      = Buffer.from(`${sid}:${token}`).toString('base64');

  // Debug: log exact Twilio API request params (body is truncated to avoid log bloat)
  console.log(`[SMS] >>> Twilio API request: To=${toNormalized}, Body=${(body || '').slice(0, 80)}${(body || '').length > 80 ? '...' : ''}, MessagingServiceSid=${messagingSid || '(none)'}, From=${messagingSid ? '(n/a)' : fromNumber || '(none)'}`);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${sid}/Messages.json`,
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(paramsStr),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          console.log(`[SMS] <<< Twilio response: statusCode=${res.statusCode}, body=${data.slice(0, 800)}`);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              console.log(`[SMS] ✅ Sent to ${toNormalized} (SID: ${parsed.sid || 'unknown'}, status: ${parsed.status || 'unknown'})`);
            } catch {
              console.log(`[SMS] ✅ Sent to ${toNormalized}`);
            }
            resolve({ ok: true });
          } else {
            const errMsg = data.slice(0, 500);
            console.error(`[SMS] ❌ Twilio HTTP ${res.statusCode} for ${toNormalized}: ${errMsg}`);
            const err = new Error(`Twilio HTTP ${res.statusCode}: ${errMsg}`);
            err.statusCode = res.statusCode;
            err.detail = errMsg;
            err.to = toNormalized;
            reject(err);
          }
        });
      }
    );

    req.on('error', (err) => {
      console.error(`[SMS] ❌ Network error for ${toNormalized}:`, err.message);
      const e = new Error(`SMS network error: ${err.message}`);
      e.to = toNormalized;
      reject(e);
    });

    req.setTimeout(8000, () => {
      req.destroy();
      console.error(`[SMS] ❌ Timeout for ${toNormalized}`);
      const e = new Error(`SMS timeout after 8s for ${toNormalized}`);
      e.to = toNormalized;
      reject(e);
    });

    req.write(paramsStr);
    req.end();
  });
}

module.exports = { sendSMS, normaliseAustralianNumber };
