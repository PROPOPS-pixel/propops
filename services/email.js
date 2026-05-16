/**
 * Email service — sends transactional emails.
 *
 * Provider priority:
 *   1. Resend  — API key from app_settings DB table (key: 'resend_api_key')
 *                OR fallback to RESEND_API_KEY env var
 *   2. Postmark direct (POSTMARK_SERVER_TOKEN env var)
 *   3. Polsia email proxy (POLSIA_API_KEY + POLSIA_EMAIL_URL override)
 *
 * If ALL providers fail, saves to `pending_emails` table for later retry.
 *
 * sendEmail() accepts an optional `from_email` override. Lead-response emails
 * pass the agent's provisioned `leads-xyz@re.propops.pro` address so that
 * replies from leads route back through Resend inbound receiving.
 */

const https = require('https');
const http = require('http');
const { Pool } = require('pg');

const FROM_NAME = 'PropOps';
const FROM_EMAIL = 'noreply@propops.pro';

// ─── DB pool for pending_emails fallback + settings lookup ──────────────────

let _pool = null;
function getPool() {
    if (!_pool && process.env.DATABASE_URL) {
        _pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
            max: 2, // minimal pool — only used for pending email saves + settings
        });
    }
    return _pool;
}

// ─── Settings cache (reads from app_settings table) ─────────────────────────
// Refreshes at most once every 5 minutes to avoid DB hits on every send.

const _settingsCache = {};
const SETTINGS_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getSetting(key) {
    const now = Date.now();
    const cached = _settingsCache[key];
    if (cached && now - cached.ts < SETTINGS_TTL_MS) {
        return cached.value;
    }

    try {
        const pool = getPool();
        if (!pool) return null;
        const result = await pool.query(
            `SELECT value FROM app_settings WHERE key = $1`,
            [key]
        );
        const value = result.rows.length > 0 ? (result.rows[0].value || null) : null;
        _settingsCache[key] = { value, ts: now };
        return value;
    } catch {
        // Table may not exist yet (migration pending) — return null silently
        return null;
    }
}

// ─── Provider 2: Postmark (direct API) ──────────────────────────────────────

async function sendViaPostmark({ to, subject, html, text, tag, reply_to }) {
    const serverToken = process.env.POSTMARK_SERVER_TOKEN;
    if (!serverToken) return null; // not configured — skip

    const postmarkPayload = {
        From: `${FROM_NAME} <${FROM_EMAIL}>`,
        To: to,
        Subject: subject,
        HtmlBody: html,
        TextBody: text || '',
        Tag: tag || 'transactional',
        MessageStream: 'outbound',
    };
    if (reply_to) postmarkPayload.ReplyTo = reply_to;
    const payload = JSON.stringify(postmarkPayload);

    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.postmarkapp.com',
            path: '/email',
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'X-Postmark-Server-Token': serverToken,
            },
        }, (res) => {
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const result = JSON.parse(body);
                        console.log(`[Email] ✅ Postmark — sent to ${to} (MessageID: ${result.MessageID || 'unknown'})`);
                    } catch {
                        console.log(`[Email] ✅ Postmark — sent to ${to}`);
                    }
                    resolve({ ok: true, provider: 'postmark' });
                } else {
                    console.error(`[Email] ❌ Postmark failed for ${to} — HTTP ${res.statusCode}: ${body.slice(0, 300)}`);
                    resolve({ ok: false, provider: 'postmark', status: res.statusCode, reason: body.slice(0, 200) });
                }
            });
        });

        req.on('error', (err) => {
            console.error(`[Email] ❌ Postmark network error for ${to}:`, err.message);
            resolve({ ok: false, provider: 'postmark', reason: err.message });
        });

        req.setTimeout(10000, () => {
            req.destroy();
            console.error(`[Email] ❌ Postmark timeout for ${to}`);
            resolve({ ok: false, provider: 'postmark', reason: 'timeout' });
        });

        req.write(payload);
        req.end();
    });
}

// ─── Provider 1: Resend ─────────────────────────────────────────────────────
// API key loaded from app_settings DB table first, env var as fallback.
// Accepts optional from_email to use an @re.propops.pro address for lead replies.

async function sendViaResend({ to, subject, html, text, reply_to, from_email }) {
    // Prefer DB-stored key; fall back to env var
    const apiKey = (await getSetting('resend_api_key')) || process.env.RESEND_API_KEY;
    if (!apiKey) return null; // not configured — skip

    const fromAddress = from_email
        ? `${FROM_NAME} <${from_email}>`
        : `${FROM_NAME} <${FROM_EMAIL}>`;

    try {
        const { Resend } = require('resend');
        const resend = new Resend(apiKey);

        const resendPayload = {
            from: fromAddress,
            to,
            subject,
            html,
            text,
        };
        if (reply_to) resendPayload.reply_to = reply_to;
        const { data, error } = await resend.emails.send(resendPayload);

        if (error) {
            console.error(`[Email] ❌ Resend error to ${to}:`, error.message || JSON.stringify(error));
            return { ok: false, provider: 'resend', reason: error.message };
        }

        console.log(`[Email] ✅ Resend — sent to ${to} from ${fromAddress} (id: ${data?.id})`);
        return { ok: true, provider: 'resend' };
    } catch (err) {
        console.error(`[Email] ❌ Resend exception to ${to}:`, err.message);
        return { ok: false, provider: 'resend', reason: err.message };
    }
}

// ─── Provider 4: Polsia proxy (tertiary fallback) ────────────────────────────

function makeProxyRequest(endpoint, apiKey, payload) {
    return new Promise((resolve) => {
        const url = new URL(endpoint);
        const lib = url.protocol === 'https:' ? https : http;

        const req = lib.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Authorization': `Bearer ${apiKey}`,
            },
        }, (res) => {
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => {
                resolve({ statusCode: res.statusCode, body });
            });
        });

        req.on('error', (err) => resolve({ statusCode: 0, body: '', error: err.message }));
        req.setTimeout(8000, () => { req.destroy(); resolve({ statusCode: 0, body: '', error: 'timeout' }); });
        req.write(payload);
        req.end();
    });
}

async function sendViaPolsiaProxy({ to, subject, html, text, tag, reply_to }) {
    const apiKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
    if (!apiKey) {
        console.warn('[Email] No POLSIA_API_KEY — skipping proxy');
        return { ok: false, provider: 'polsia_proxy', reason: 'no_api_key' };
    }

    const baseUrl = process.env.POLSIA_R2_BASE_URL || 'https://polsia.com';

    // Support POLSIA_EMAIL_URL override — platform team can set this when endpoint is fixed
    const endpoints = process.env.POLSIA_EMAIL_URL
        ? [process.env.POLSIA_EMAIL_URL]
        : [
            `${baseUrl}/api/proxy/email/send`,
            `${baseUrl}/email/send`,
            `${baseUrl}/api/email/send`,
            `${baseUrl}/api/v1/email/send`,
          ];

    // Transactional tags that should bypass cold outreach rate limits
    const TRANSACTIONAL_TAGS = ['magic_link', 'transactional', 'welcome', 'trial_reminder', 'waitlist_confirmation', 'password_reset', 'lead_response', 'lead_alert', 'daily_digest'];
    const emailTag = tag || 'transactional';
    const isTransactional = TRANSACTIONAL_TAGS.includes(emailTag);

    const proxyData = {
        to,
        subject,
        html_body: html,
        body: text || subject,
        text_body: text || '',
        from_name: FROM_NAME,
        from_email: FROM_EMAIL,
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        tag: emailTag,
        // Tell Polsia proxy this is transactional, not cold outreach
        email_type: isTransactional ? 'transactional' : 'outreach',
        category: isTransactional ? 'transactional' : 'marketing',
        transactional: isTransactional,
    };
    if (reply_to) proxyData.reply_to = reply_to;
    const payload = JSON.stringify(proxyData);

    for (const endpoint of endpoints) {
        const resp = await makeProxyRequest(endpoint, apiKey, payload);

        if (resp.statusCode >= 200 && resp.statusCode < 300) {
            console.log(`[Email] ✅ Polsia proxy — sent to ${to} via ${endpoint}`);
            return { ok: true, provider: 'polsia_proxy' };
        }

        // 404 = endpoint doesn't exist, try next
        if (resp.statusCode === 404) {
            console.warn(`[Email] Polsia proxy 404 at ${endpoint} — trying next`);
            continue;
        }

        // Other errors — log and try next
        console.error(`[Email] ❌ Polsia proxy failed at ${endpoint} — HTTP ${resp.statusCode}: ${(resp.body || resp.error || '').slice(0, 150)}`);
    }

    return { ok: false, provider: 'polsia_proxy', reason: 'all_endpoints_returned_error' };
}

// ─── Pending email persistence ──────────────────────────────────────────────

async function savePendingEmail({ to, subject, html, text, tag, error }) {
    try {
        const pool = getPool();
        if (!pool) {
            console.error('[Email] Cannot save pending email — no DATABASE_URL configured');
            return;
        }
        await pool.query(
            `INSERT INTO pending_emails (recipient, subject, html_body, text_body, tag, last_error)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [to, subject, html, text || '', tag || 'transactional', error || 'Unknown']
        );
        console.log(`[Email] 📥 Saved to pending_emails for ${to} — will be sent when provider is configured`);
    } catch (err) {
        // Table might not exist yet (migration pending) — log but don't crash
        if (err.message?.includes('does not exist')) {
            console.error(`[Email] pending_emails table not yet created — email to ${to} lost. Run migrations.`);
        } else {
            console.error(`[Email] Failed to save pending email for ${to}:`, err.message);
        }
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Send an email via the best available provider.
 * Provider order: Resend (DB key) → Postmark → Polsia proxy.
 * If ALL fail, saves to pending_emails table.
 *
 * @param {string}  to           - Recipient address
 * @param {string}  subject      - Email subject
 * @param {string}  html         - HTML body
 * @param {string}  [text]       - Plain-text body
 * @param {string}  [tag]        - Provider tag (for analytics)
 * @param {string}  [reply_to]   - Reply-To header override
 * @param {string}  [from_email] - Sender address override (e.g. leads-xyz@re.propops.pro)
 *                                 Must be on a Resend-verified domain when using Resend.
 */
async function sendEmail({ to, subject, html, text, tag, reply_to, from_email }) {
    // Determine which providers are available
    const resendDbKey = await getSetting('resend_api_key');
    const resendEnvKey = process.env.RESEND_API_KEY;
    const hasResend = !!(resendDbKey || resendEnvKey);

    const available = [];
    if (hasResend) available.push('Resend');
    if (process.env.POSTMARK_SERVER_TOKEN) available.push('Postmark');
    if (process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN) available.push('Polsia-proxy');
    if (process.env.POLSIA_EMAIL_URL) available.push(`Custom(${process.env.POLSIA_EMAIL_URL})`);

    const fromLabel = from_email || FROM_EMAIL;
    console.log(`[Email] Sending to ${to} | From: ${fromLabel} | Subject: "${subject}" | Reply-To: ${reply_to || '(default)'} | Providers: [${available.join(', ') || 'NONE'}]`);

    if (available.length === 0) {
        console.error('[Email] ⚠️  NO EMAIL PROVIDERS CONFIGURED. Add resend_api_key to app_settings or set RESEND_API_KEY env var.');
        await savePendingEmail({ to, subject, html, text, tag, error: 'No providers configured' });
        return { ok: false, queued: true };
    }

    // Provider 1: Resend (DB key or env var)
    if (hasResend) {
        const result = await sendViaResend({ to, subject, html, text, reply_to, from_email });
        if (result && result.ok) return result;
        console.warn('[Email] Resend failed — trying next provider');
    }

    // Provider 2: Postmark
    if (process.env.POSTMARK_SERVER_TOKEN) {
        const result = await sendViaPostmark({ to, subject, html, text, tag, reply_to });
        if (result && result.ok) return result;
        console.warn('[Email] Postmark failed — trying next provider');
    }

    // Provider 3: Polsia proxy (tries multiple endpoints)
    const proxyResult = await sendViaPolsiaProxy({ to, subject, html, text, tag, reply_to });
    if (proxyResult && proxyResult.ok) return proxyResult;

    // ALL FAILED — persist for retry
    console.error(`[Email] ⚠️  ALL PROVIDERS FAILED for ${to}`);
    console.error(`[Email] ⚠️  Fix: add resend_api_key to app_settings table or set RESEND_API_KEY env var`);

    await savePendingEmail({
        to, subject, html, text, tag,
        error: `All providers failed. Tried: ${available.join(', ')}`
    });

    return { ok: false, queued: true };
}

/**
 * Send a welcome/confirmation email to a new waitlist signup.
 */
async function sendWaitlistConfirmation(email) {
    const subject = "You're on the PropOps waitlist!";

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're on the PropOps waitlist</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;color:#0f172a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:#0f172a;padding:28px 40px;">
              <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">PropOps</p>
              <p style="margin:4px 0 0;font-size:13px;color:#94a3b8;">AI-powered property operations for real estate agents</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#0f172a;line-height:1.3;">
                You're on the list!
              </h1>
              <p style="margin:0 0 20px;font-size:16px;color:#334155;line-height:1.6;">
                Thanks for signing up for early access to PropOps. We're onboarding agents one by one to make sure everyone gets a great experience.
              </p>
              <p style="margin:0 0 28px;font-size:16px;color:#334155;line-height:1.6;">
                While you wait, here's what PropOps will do for your business:
              </p>

              <!-- Feature list -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr>
                  <td style="padding:12px 16px;background:#f8fafc;border-radius:8px;margin-bottom:8px;border-left:3px solid #f59e0b;">
                    <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">Respond in seconds</p>
                    <p style="margin:4px 0 0;font-size:13px;color:#64748b;">Your next inquiry gets a personalised AI reply before you even see the notification</p>
                  </td>
                </tr>
                <tr><td style="height:8px;"></td></tr>
                <tr>
                  <td style="padding:12px 16px;background:#f8fafc;border-radius:8px;border-left:3px solid #f59e0b;">
                    <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">Works with every portal</p>
                    <p style="margin:4px 0 0;font-size:13px;color:#64748b;">REA, Domain, Homely — PropOps handles leads from all of them automatically</p>
                  </td>
                </tr>
                <tr><td style="height:8px;"></td></tr>
                <tr>
                  <td style="padding:12px 16px;background:#f8fafc;border-radius:8px;border-left:3px solid #f59e0b;">
                    <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">Close more deals</p>
                    <p style="margin:4px 0 0;font-size:13px;color:#64748b;">Agents responding within 5 minutes are 21x more likely to qualify a lead</p>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 28px;font-size:14px;color:#64748b;line-height:1.6;">
                We'll email you at <strong>${email}</strong> as soon as your spot opens up. In the meantime, reply to this email if you have questions.
              </p>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#0f172a;border-radius:8px;">
                    <a href="https://propops.pro" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:-0.2px;">
                      Visit PropOps
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #e2e8f0;background:#f8fafc;">
              <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
                You're receiving this because you signed up at propops.pro.<br>
                PropOps — AI-powered property operations for real estate agents
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    const text = `You're on the PropOps waitlist!

Thanks for signing up for early access. We're onboarding agents one by one and will email you at ${email} as soon as your spot opens up.

What PropOps does:
- Responds to property inquiries in seconds (before you even see them)
- Works with REA, Domain, Homely and every portal
- Helps you qualify leads and close more deals

Visit us at https://propops.pro

Questions? Just reply to this email.

— The PropOps Team`;

    return sendEmail({ to: email, subject, html, text, tag: 'waitlist_confirmation', reply_to: FROM_EMAIL });
}

/**
 * Get count of unsent pending emails (for monitoring).
 */
async function getPendingEmailCount() {
    try {
        const pool = getPool();
        if (!pool) return 0;
        const result = await pool.query(`SELECT COUNT(*) as count FROM pending_emails WHERE status = 'pending'`);
        return parseInt(result.rows[0].count, 10);
    } catch {
        return 0;
    }
}

/**
 * Send welcome email immediately after a user starts their free trial.
 * Massive sales pitch + full onboarding package.
 * Personalized with agent name.
 */
async function sendWelcomeEmail({ email, name, daysLeft = 14, loginUrl }) {
    const firstName = name ? name.split(' ')[0] : 'there';
    const dashboardUrl = loginUrl || 'https://propops.pro/dashboard';
    const subscribeUrl = (process.env.STRIPE_SUBSCRIPTION_URL || 'https://buy.stripe.com/dRmbJ1bqw89v4Jj0pKdby0a')
        + '?prefilled_email=' + encodeURIComponent(email);
    const subject = `${firstName}, you just made the smartest move of your career`;

    // ─── Reusable HTML snippets ────────────────────────────────────────────────

    // A divider line between sections
    const divider = `<tr><td style="padding:0 40px;"><div style="height:1px;background:#e2e8f0;"></div></td></tr><tr><td style="height:32px;"></td></tr>`;

    // A section heading
    const sectionHeading = (emoji, title) =>
        `<tr><td style="padding:0 40px 16px;"><p style="margin:0;font-size:17px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">${emoji}&nbsp; ${title}</p></td></tr>`;

    // A body paragraph
    const para = (text) =>
        `<tr><td style="padding:0 40px 14px;"><p style="margin:0;font-size:15px;color:#334155;line-height:1.7;">${text}</p></td></tr>`;

    // A stat box (3 per row on desktop, stacked on mobile)
    const statBox = (number, label, sublabel) =>
        `<td width="33%" style="padding:14px 10px;text-align:center;background:#f8fafc;border-radius:8px;">
           <p style="margin:0;font-size:26px;font-weight:800;color:#0f172a;letter-spacing:-1px;">${number}</p>
           <p style="margin:4px 0 0;font-size:12px;font-weight:600;color:#0f172a;">${label}</p>
           <p style="margin:2px 0 0;font-size:11px;color:#64748b;">${sublabel}</p>
         </td>`;

    // A feature row
    const featureRow = (icon, title, desc) =>
        `<tr>
           <td style="padding:12px 16px;background:#f8fafc;border-radius:8px;border-left:3px solid #f59e0b;">
             <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">${icon} ${title}</p>
             <p style="margin:4px 0 0;font-size:13px;color:#64748b;">${desc}</p>
           </td>
         </tr><tr><td style="height:8px;"></td></tr>`;

    // A numbered step
    const stepRow = (num, color, title, desc) =>
        `<tr>
           <td style="padding:14px 18px;background:#f8fafc;border-radius:8px;border-left:4px solid ${color};">
             <p style="margin:0;font-size:13px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:0.5px;">Step ${num}</p>
             <p style="margin:4px 0 2px;font-size:14px;font-weight:600;color:#0f172a;">${title}</p>
             <p style="margin:0;font-size:13px;color:#64748b;">${desc}</p>
           </td>
         </tr><tr><td style="height:8px;"></td></tr>`;

    // A comparison row
    const compRow = (competitor, them, us) =>
        `<tr>
           <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;">
             <table width="100%" cellpadding="0" cellspacing="0">
               <tr>
                 <td width="30%" style="font-size:13px;font-weight:600;color:#0f172a;">${competitor}</td>
                 <td width="35%" style="font-size:13px;color:#94a3b8;padding:0 8px;">${them}</td>
                 <td width="35%" style="font-size:13px;font-weight:600;color:#059669;">${us}</td>
               </tr>
             </table>
           </td>
         </tr>`;

    // A timeline day row
    const timelineRow = (period, action, highlight) =>
        `<tr>
           <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;">
             <table width="100%" cellpadding="0" cellspacing="0">
               <tr>
                 <td width="22%" style="font-size:12px;font-weight:700;color:${highlight ? '#f59e0b' : '#64748b'};vertical-align:top;">${period}</td>
                 <td style="font-size:13px;color:#334155;line-height:1.5;">${action}</td>
               </tr>
             </table>
           </td>
         </tr>`;

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to PropOps, ${firstName}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;-webkit-font-smoothing:antialiased;">

  <!-- Outer wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr>
      <td align="center">

        <!-- Email card — max 600px -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- ═══════════════════════════════════════════════ HEADER -->
          <tr>
            <td style="background:#0f172a;padding:28px 40px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="margin:0;font-size:24px;font-weight:800;color:#ffffff;letter-spacing:-0.8px;">
                      PropOps<span style="color:#f59e0b;">.</span>
                    </p>
                    <p style="margin:4px 0 0;font-size:13px;color:#94a3b8;">AI-powered lead response for real estate agents</p>
                  </td>
                  <td align="right" style="vertical-align:middle;">
                    <span style="background:#f59e0b;color:#0f172a;font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px;letter-spacing:0.3px;">FREE TRIAL</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ═══════════════════════════════════════════════ HERO -->
          <tr>
            <td style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);padding:40px 40px 36px;">
              <h1 style="margin:0 0 14px;font-size:28px;font-weight:800;color:#ffffff;line-height:1.25;letter-spacing:-0.8px;">
                You just made the<br>smartest move of your career.
              </h1>
              <p style="margin:0 0 24px;font-size:16px;color:#cbd5e1;line-height:1.65;">
                While other agents are still typing replies at 10pm, PropOps is about to handle yours — in seconds, 24/7, in your name.
              </p>
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#f59e0b;border-radius:8px;">
                    <a href="${dashboardUrl}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#0f172a;text-decoration:none;letter-spacing:-0.2px;">
                      Go to your dashboard →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ═══════════════════════════════════════════════ TRIAL BANNER -->
          <tr>
            <td style="padding:0;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#fef3c7;padding:14px 40px;border-bottom:2px solid #f59e0b;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td>
                          <p style="margin:0;font-size:14px;font-weight:700;color:#0f172a;">⚡ Your ${daysLeft}-day free trial is live.</p>
                          <p style="margin:3px 0 0;font-size:13px;color:#78716c;">From $69/month after trial. Cancel any time, no contracts, no lock-in.</p>
                        </td>
                        <td align="right" style="white-space:nowrap;">
                          <p style="margin:0;font-size:22px;font-weight:800;color:#f59e0b;letter-spacing:-1px;">${daysLeft}</p>
                          <p style="margin:0;font-size:10px;color:#78716c;font-weight:600;text-transform:uppercase;">days left</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- spacer -->
          <tr><td style="height:36px;"></td></tr>

          <!-- ═══════════════════════════════════════════════ WHAT IS PROPOPS -->
          ${sectionHeading('🤖', 'What PropOps does')}
          ${para(`PropOps is an AI lead-response engine built specifically for real estate agents. The moment an inquiry lands from REA, Domain, Homely — or any portal — PropOps reads it, classifies the lead type, and sends a <strong>personalised, qualifying response in your name within 3 seconds</strong>. It works 24/7: nights, weekends, public holidays.`)}
          ${para(`You get every lead into your pipeline automatically. You never miss a deal because you were in a meeting, on another call, or asleep.`)}

          ${divider}

          <!-- ═══════════════════════════════════════════════ THE PROBLEM -->
          ${sectionHeading('🔥', 'The problem it solves')}
          ${para(`Here's the brutal truth about online real estate leads:`)}

          <!-- Pain stats -->
          <tr>
            <td style="padding:0 40px 20px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  ${statBox('70%', 'of your day', 'wasted on admin')}
                  <td width="10px"></td>
                  ${statBox('15+ hrs', 'avg response time', 'for online inquiries')}
                  <td width="10px"></td>
                  ${statBox('80%', 'of leads go cold', 'before first contact')}
                </tr>
              </table>
            </td>
          </tr>

          ${para(`The agent who responds first wins. Not the best agent — the <strong>fastest</strong> one. Right now your competitors who have automated responses are getting to leads while you're still writing your first reply.`)}
          ${para(`PropOps fixes this permanently. Your response time goes from hours to <strong>3 seconds</strong>. Every time.`)}

          ${divider}

          <!-- ═══════════════════════════════════════════════ HOW IT WORKS -->
          ${sectionHeading('⚙️', 'How it works — step by step')}

          <tr>
            <td style="padding:0 40px 20px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                ${stepRow(1, '#2563eb', 'Forward your inquiry emails', 'Set up email forwarding from REA, Domain, and Homely to your unique PropOps inbox — takes under 2 minutes.')}
                ${stepRow(2, '#f59e0b', 'PropOps reads every inquiry', 'Every forwarded email is parsed automatically. PropOps extracts the lead\'s name, property interest, and intent — even from messy portal formats.')}
                ${stepRow(3, '#8b5cf6', 'AI classifies the lead', 'PropOps tags every lead: Buyer, Seller, Renter, or Landlord — so your pipeline is always organised with zero effort.')}
                ${stepRow(4, '#059669', 'Personalised reply sent in your name', 'A qualifying response — using your name and signed off as you — lands in the lead\'s inbox within seconds. They think you replied instantly.')}
                ${stepRow(5, '#0f172a', 'Lead tracked in your pipeline', 'Every lead is logged in your dashboard automatically: status, lead type, the AI response sent, and full activity history. Your CRM, done.')}
              </table>
            </td>
          </tr>

          ${divider}

          <!-- ═══════════════════════════════════════════════ STATS -->
          ${sectionHeading('📊', 'Stats that matter')}

          <!-- Big stat callout -->
          <tr>
            <td style="padding:0 40px 16px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#0f172a;border-radius:10px;padding:20px 24px;">
                    <p style="margin:0;font-size:36px;font-weight:800;color:#f59e0b;letter-spacing:-2px;">21×</p>
                    <p style="margin:4px 0 0;font-size:15px;font-weight:700;color:#ffffff;">more likely to convert</p>
                    <p style="margin:4px 0 0;font-size:13px;color:#94a3b8;">Leads contacted within 5 minutes are 21× more likely to become clients vs. a 15-hour response time.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:0 40px 20px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                ${statBox('3 sec', 'Response time', 'from inquiry to reply')}
                <td width="10px"></td>
                ${statBox('24/7', 'Always on', 'nights, weekends, holidays')}
                <td width="10px"></td>
                ${statBox('0', 'Missed leads', 'ever, once set up')}
              </table>
            </td>
          </tr>

          ${divider}

          <!-- ═══════════════════════════════════════════════ FEATURES -->
          ${sectionHeading('✅', 'Everything in your plan')}

          <tr>
            <td style="padding:0 40px 20px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                ${featureRow('⚡', 'AI lead response engine', 'Personalised replies in your name, sent within 3 seconds of every inquiry.')}
                ${featureRow('📋', 'Lead pipeline & CRM', 'Every lead logged automatically with status, lead type, and full activity history.')}
                ${featureRow('🏷️', 'Lead type tagging', 'Automatically classifies every inquiry: Buyer, Renter, Seller, or Landlord.')}
                ${featureRow('📄', 'Compliance document generation', 'Auto-generate agency agreements and disclosure docs — ready to send in one click.')}
                ${featureRow('👤', 'Responses signed with YOUR name', 'Leads receive replies that sound like you wrote them. Your brand, your voice.')}
                ${featureRow('🔄', 'Works with every portal', 'REA, Domain, Homely — if it sends an email, PropOps handles it.')}
                ${featureRow('📊', 'Daily digest', 'Morning summary of all leads received, responded to, and pipeline updates.')}
              </table>
            </td>
          </tr>

          ${divider}

          <!-- ═══════════════════════════════════════════════ SETUP -->
          ${sectionHeading('🚀', 'Get live in 5 minutes')}
          ${para(`Three things to do right now:`)}

          <tr>
            <td style="padding:0 40px 8px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border:2px solid #f59e0b;border-radius:10px;overflow:hidden;">
                <tr>
                  <td style="padding:16px 20px;border-bottom:1px solid #fef3c7;background:#fffbeb;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="32px" style="vertical-align:top;">
                          <span style="background:#0f172a;color:#f59e0b;font-size:12px;font-weight:800;width:24px;height:24px;border-radius:50%;display:inline-block;text-align:center;line-height:24px;">1</span>
                        </td>
                        <td style="padding-left:12px;">
                          <p style="margin:0;font-size:14px;font-weight:700;color:#0f172a;">Log in to your dashboard</p>
                          <p style="margin:4px 0 6px;font-size:13px;color:#64748b;">Your leads, pipeline, and response settings are all here.</p>
                          <a href="${dashboardUrl}" style="font-size:13px;color:#2563eb;font-weight:600;text-decoration:none;">${dashboardUrl} →</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 20px;border-bottom:1px solid #fef3c7;background:#fffbeb;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="32px" style="vertical-align:top;">
                          <span style="background:#f59e0b;color:#0f172a;font-size:12px;font-weight:800;width:24px;height:24px;border-radius:50%;display:inline-block;text-align:center;line-height:24px;">2</span>
                        </td>
                        <td style="padding-left:12px;">
                          <p style="margin:0;font-size:14px;font-weight:700;color:#0f172a;">Set up email forwarding from REA &amp; Domain</p>
                          <p style="margin:4px 0 0;font-size:13px;color:#64748b;">In your dashboard, find your unique PropOps intake address. Then add it as a forward destination in REA and Domain settings. Takes 2 minutes. Full instructions inside.</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 20px;background:#fffbeb;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="32px" style="vertical-align:top;">
                          <span style="background:#059669;color:#ffffff;font-size:12px;font-weight:800;width:24px;height:24px;border-radius:50%;display:inline-block;text-align:center;line-height:24px;">3</span>
                        </td>
                        <td style="padding-left:12px;">
                          <p style="margin:0;font-size:14px;font-weight:700;color:#0f172a;">Propops handles everything from here</p>
                          <p style="margin:4px 0 0;font-size:13px;color:#64748b;">Your next inquiry gets an AI reply within seconds — before you've even seen the email. Watch it happen live in your dashboard.</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr><td style="height:24px;"></td></tr>

          <!-- Primary CTA -->
          <tr>
            <td style="padding:0 40px 32px;" align="center">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#f59e0b;border-radius:10px;box-shadow:0 4px 14px rgba(245,158,11,0.4);">
                    <a href="${dashboardUrl}" style="display:inline-block;padding:16px 36px;font-size:16px;font-weight:800;color:#0f172a;text-decoration:none;letter-spacing:-0.3px;">
                      Set up forwarding now →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${divider}

          <!-- ═══════════════════════════════════════════════ COMPETITIVE -->
          ${sectionHeading('🏆', 'How PropOps stacks up')}

          <tr>
            <td style="padding:0 40px 20px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
                <tr>
                  <td style="padding:10px 14px;background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="30%" style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;"></td>
                        <td width="35%" style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;padding:0 8px;">Competitors</td>
                        <td width="35%" style="font-size:11px;font-weight:700;color:#059669;text-transform:uppercase;letter-spacing:0.5px;">PropOps</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                ${compRow('Rex / Agentbox', 'Give you more tools to manage', 'Does the work for you')}
                ${compRow('RITA', 'Prospects for new leads', 'Responds AND qualifies instantly')}
                ${compRow('Manual CRM', 'You type every response', 'AI replies in seconds, 24/7')}
                ${compRow('Price', '$200–$500/month', 'From $69/month')}
                ${compRow('Built for', 'Large franchises & teams', 'Solo agents &amp; small teams')}
                ${compRow('Setup time', 'Days to weeks', '5 minutes')}
              </table>
            </td>
          </tr>

          ${para(`The difference: everyone else gives you a more organised inbox. PropOps gives you time back. <strong>Big difference.</strong>`)}

          ${divider}

          <!-- ═══════════════════════════════════════════════ PRICING -->
          ${sectionHeading('💰', 'Pricing — completely transparent')}

          <tr>
            <td style="padding:0 40px 20px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border-radius:12px;overflow:hidden;">
                <tr>
                  <td style="padding:24px 28px;">
                    <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#f59e0b;text-transform:uppercase;letter-spacing:0.5px;">What you get</p>
                    <p style="margin:0 0 16px;font-size:32px;font-weight:800;color:#ffffff;letter-spacing:-1.5px;">$69<span style="font-size:16px;font-weight:400;color:#94a3b8;">/month</span></p>
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr><td style="padding:5px 0;font-size:13px;color:#cbd5e1;">✓&nbsp; Unlimited AI lead responses</td></tr>
                      <tr><td style="padding:5px 0;font-size:13px;color:#cbd5e1;">✓&nbsp; Lead pipeline &amp; CRM</td></tr>
                      <tr><td style="padding:5px 0;font-size:13px;color:#cbd5e1;">✓&nbsp; Auto lead type tagging</td></tr>
                      <tr><td style="padding:5px 0;font-size:13px;color:#cbd5e1;">✓&nbsp; Compliance document generation</td></tr>
                      <tr><td style="padding:5px 0;font-size:13px;color:#cbd5e1;">✓&nbsp; REA, Domain, Homely — all portals</td></tr>
                      <tr><td style="padding:5px 0;font-size:13px;color:#cbd5e1;">✓&nbsp; 24/7 — never off, never on holiday</td></tr>
                    </table>
                    <table cellpadding="0" cellspacing="0" style="margin-top:20px;">
                      <tr>
                        <td style="background:#f59e0b;border-radius:8px;">
                          <a href="${subscribeUrl}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:700;color:#0f172a;text-decoration:none;">
                            Subscribe after trial →
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${para(`You're on your free trial now. No card will be charged until Day ${daysLeft}. Cancel any time — no notice period, no lock-in, no drama.`)}
          ${para(`<strong>One missed commission pays for PropOps for 2+ years.</strong> Think about that.`)}

          ${divider}

          <!-- ═══════════════════════════════════════════════ TIMELINE -->
          ${sectionHeading('📅', 'What to expect in your first 14 days')}

          <tr>
            <td style="padding:0 40px 20px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
                ${timelineRow('Day 1', 'Set up email forwarding (2 min). Your first AI-generated reply lands in a lead\'s inbox before you finish reading this email.', true)}
                ${timelineRow('Days 2–3', 'See every new inquiry auto-classified and responded to in your dashboard. Zero effort.', false)}
                ${timelineRow('Week 1', 'Your pipeline fills up automatically. You stop typing replies and start focusing on actual conversations with qualified leads.', false)}
                ${timelineRow('Week 2', 'You\'ve reclaimed hours of your week. You\'ve responded to every lead faster than any competitor. You\'ve probably already won a deal you would have missed.', false)}
                ${timelineRow('Day 14', 'Trial ends. You have a choice: keep the unfair advantage from $69/month, or go back to the old way. Up to you.', true)}
              </table>
            </td>
          </tr>

          ${divider}

          <!-- ═══════════════════════════════════════════════ SUPPORT -->
          ${sectionHeading('💬', 'Need help? We\'ve got you.')}
          ${para(`Setting up email forwarding takes 2 minutes but we know every portal is different. If you hit a snag:`)}

          <tr>
            <td style="padding:0 40px 20px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:10px 16px;background:#f8fafc;border-radius:8px;border-left:3px solid #2563eb;">
                    <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">📧 Reply to this email</p>
                    <p style="margin:4px 0 0;font-size:13px;color:#64748b;">Fastest way to get help. We respond quickly — we use our own tools.</p>
                  </td>
                </tr>
                <tr><td style="height:8px;"></td></tr>
                <tr>
                  <td style="padding:10px 16px;background:#f8fafc;border-radius:8px;border-left:3px solid #059669;">
                    <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;">🖥️ In-dashboard help form</p>
                    <p style="margin:4px 0 0;font-size:13px;color:#64748b;">Use the help button in the top-right corner of your dashboard any time.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${para(`<strong>${firstName}, you're in good company.</strong> PropOps is built by agents, for agents. Everything we build is designed around one goal: winning more deals with less work.`)}

          ${divider}

          <!-- ═══════════════════════════════════════════════ CLOSING CTA -->
          <tr>
            <td style="padding:0 40px 36px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#fef3c7 0%,#fffbeb 100%);border-radius:12px;border:2px solid #f59e0b;overflow:hidden;">
                <tr>
                  <td style="padding:28px 28px;">
                    <h2 style="margin:0 0 10px;font-size:20px;font-weight:800;color:#0f172a;letter-spacing:-0.5px;">
                      Set up email forwarding now.
                    </h2>
                    <p style="margin:0 0 20px;font-size:14px;color:#78716c;line-height:1.6;">
                      Let PropOps handle your next inquiry before you finish your morning coffee. That's the whole pitch.
                    </p>
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="background:#0f172a;border-radius:8px;">
                          <a href="${dashboardUrl}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#f59e0b;text-decoration:none;letter-spacing:-0.2px;">
                            Go to PropOps Dashboard →
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ═══════════════════════════════════════════════ FOOTER -->
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #e2e8f0;background:#f8fafc;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#0f172a;">PropOps<span style="color:#f59e0b;">.</span></p>
                    <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
                      Never miss a lead again.<br>
                      You received this because you signed up at propops.pro.
                    </p>
                  </td>
                  <td align="right" style="vertical-align:top;">
                    <p style="margin:0;font-size:12px;color:#cbd5e1;">
                      <a href="https://propops.pro" style="color:#94a3b8;text-decoration:none;">propops.pro</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
        <!-- end card -->

      </td>
    </tr>
  </table>

</body>
</html>
    `.trim();

    const text = `${firstName}, you just made the smartest move of your career.

While other agents are still typing replies at 10pm, PropOps is about to handle yours — in seconds, 24/7, in your name.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ YOUR ${daysLeft}-DAY FREE TRIAL IS LIVE
From $69/month after trial. Cancel any time.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WHAT PROPOPS DOES
PropOps is an AI lead-response engine for real estate agents. The moment an inquiry lands from REA, Domain, or Homely, PropOps reads it, classifies the lead, and sends a personalised qualifying response in YOUR name within 3 seconds. 24/7.

THE PROBLEM WE SOLVE
- 70% of your day wasted on admin
- Average response time to online inquiries: 15+ hours
- 80% of leads go cold before first contact
- Leads contacted within 5 minutes are 21× more likely to convert

HOW IT WORKS
1. Forward inquiry emails from REA/Domain/Homely to your PropOps inbox
2. PropOps reads every inquiry automatically
3. AI classifies the lead (Buyer, Seller, Renter, Landlord)
4. Personalised qualifying response sent in YOUR name within seconds
5. Lead tracked in your pipeline automatically

KEY STATS
- Response time: 3 seconds
- Availability: 24/7 — nights, weekends, holidays
- Missed leads: 0 (once set up)
- 21× more likely to convert vs 15-hour response

WHAT'S INCLUDED
✓ AI lead response engine — unlimited responses
✓ Lead pipeline & CRM
✓ Auto lead type tagging (Buyer/Renter/Seller/Landlord)
✓ Compliance document generation
✓ Responses signed with YOUR name
✓ Works with REA, Domain, Homely, and all portals
✓ Daily digest of lead activity

GET LIVE IN 5 MINUTES
Step 1: Log in to your dashboard → ${dashboardUrl}
Step 2: Find your unique PropOps intake address (in Email Intake section)
Step 3: Add it as a forward destination in REA and Domain settings
That's it. PropOps handles everything from here.

HOW WE COMPARE
vs Rex/Agentbox: They give you more tools. PropOps does the work.
vs RITA: RITA prospects. PropOps responds AND qualifies.
vs Manual CRM: You type. PropOps doesn't.
Price: From $69/mo vs $200–500 for traditional CRMs
Built for: Solo agents and small teams (not large franchises)

PRICING
From $69/month — everything included
- Free trial: ${daysLeft} days (active now)
- Cancel any time — no notice, no lock-in
- Subscribe → ${subscribeUrl}

One missed commission pays for PropOps for 2+ years.

YOUR FIRST 14 DAYS
Day 1: Set up forwarding. First AI reply within minutes.
Days 2-3: Watch every inquiry auto-classified and responded to.
Week 1: Pipeline fills automatically. You stop typing. You start closing.
Week 2: Hours reclaimed. Every lead answered faster than any competitor.
Day 14: Keep the unfair advantage from $69/mo, or go back to the old way.

SUPPORT
→ Reply to this email (fastest)
→ Dashboard help button (top-right corner)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Set up email forwarding now and let PropOps handle your next inquiry before you finish your morning coffee.

${dashboardUrl}

— PropOps
propops.pro`;

    return sendEmail({ to: email, subject, html, text, tag: 'welcome', reply_to: FROM_EMAIL });
}

/**
 * Send a trial expiry reminder email 3 days before trial ends.
 */
async function sendTrialReminderEmail({ email, name, daysLeft }) {
    const firstName = name ? name.split(' ')[0] : 'there';
    const subject = `Your PropOps trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — subscribe to keep going`;
    const subscribeUrl = (process.env.STRIPE_SUBSCRIPTION_URL || 'https://buy.stripe.com/dRmbJ1bqw89v4Jj0pKdby0a')
      + '?prefilled_email=' + encodeURIComponent(email);

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;color:#0f172a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#0f172a;padding:28px 40px;">
              <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">PropOps<span style="color:#f59e0b;">.</span></p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0f172a;">
                Your trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}, ${firstName}
              </h1>
              <p style="margin:0 0 20px;font-size:15px;color:#334155;line-height:1.6;">
                Your free trial wraps up soon. Subscribe now to keep PropOps responding to your leads 24/7.
              </p>

              <!-- Subscribe CTA -->
              <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td style="background:#f59e0b;border-radius:8px;">
                    <a href="${subscribeUrl}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#0f172a;text-decoration:none;">
                      Subscribe — from $69/month →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 20px;font-size:14px;color:#64748b;line-height:1.6;">
                From $69/month — less than a single lost commission. Cancel anytime, no contracts.
              </p>

              <p style="margin:0 0 24px;font-size:14px;color:#64748b;line-height:1.6;">
                Not ready to subscribe? No worries — your access will pause when the trial ends. You can subscribe anytime later to pick up where you left off.
              </p>

              <!-- Dashboard link -->
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#0f172a;border-radius:8px;">
                    <a href="https://propops.pro/dashboard" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">
                      Go to dashboard
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #e2e8f0;background:#f8fafc;">
              <p style="margin:0;font-size:13px;color:#0f172a;font-weight:600;">— PropOps</p>
              <p style="margin:8px 0 0;font-size:12px;color:#94a3b8;">PropOps — Never miss a lead again.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    const text = `Your trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}, ${firstName}.

Subscribe now to keep PropOps responding to your leads: ${subscribeUrl}

From $69/month — less than a single lost commission. Cancel anytime.

Not ready? No worries — your access will pause and you can subscribe anytime later.

Dashboard: https://propops.pro/dashboard

— PropOps`;

    return sendEmail({ to: email, subject, html, text, tag: 'trial_reminder', reply_to: FROM_EMAIL });
}

// ─── Cold Outreach Email Sequence ───────────────────────────────────────────
// 3-email sequential 12-day campaign targeting independent real estate agents.
// Primary CTA: propops.pro free trial.
// Secondary CTA: YouTube demo video.
const YOUTUBE_DEMO_URL = 'https://www.youtube.com/watch?v=tA-sM_BB88o';
const FREE_TRIAL_URL = 'https://propops.pro';

/**
 * Cold outreach email #1 — Day 1 (Intro).
 * First touch. Short hook on instant lead response. Free trial primary CTA,
 * YouTube demo secondary.
 */
async function sendColdOutreachEmail1({ email, name, agency }) {
    const firstName = name ? name.split(' ')[0] : 'there';
    const agencyLine = agency ? ` at ${agency}` : '';
    const subject = `${firstName}, your leads are going cold`;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;color:#0f172a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:#0f172a;padding:24px 40px;">
              <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">PropOps<span style="color:#f59e0b;">.</span></p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
                Hi ${firstName},
              </p>
              <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
                Quick one — agents${agencyLine} typically miss 3–5 leads a week because they can't respond fast enough. By the time you see the inquiry, the buyer's already talking to someone else.
              </p>
              <!-- The Full Loop callout -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;background:#0f172a;border-radius:10px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#f59e0b;">The Full Loop</p>
                    <p style="margin:0;font-size:14px;color:#e2e8f0;line-height:1.7;"><strong style="color:#ffffff;">PropOps catches the lead instantly, responds in seconds, then follows up automatically</strong> so nothing falls through the cracks. The agent just picks up the phone when it's time to close.</p>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
                <strong>That's PropOps.</strong> It reads every inquiry from REA, Domain and Homely the moment it arrives, fires a personalised response in your name — under 3 seconds, 24/7 — then keeps following up so nothing falls through the cracks.
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#334155;line-height:1.6;">
                Stop missing leads. Make more money with less effort. Takes 2 minutes to set up. Free 14-day trial, no card required upfront.
              </p>
              <!-- Dashboard screenshot -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td style="border-radius:10px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.10);border:1px solid #e2e8f0;">
                    <img src="https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_55743/images/8d4c8b28-494e-4561-a934-7ff500662153.png" alt="PropOps dashboard — 14 leads, 7s avg response" width="480" style="display:block;width:100%;height:auto;" />
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0 0;font-size:12px;color:#94a3b8;text-align:center;">Your AI-powered lead pipeline — every inquiry gets a response in seconds</td>
                </tr>
              </table>
              <!-- Primary CTA -->
              <table cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
                <tr>
                  <td style="background:#f59e0b;border-radius:8px;">
                    <a href="${FREE_TRIAL_URL}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#0f172a;text-decoration:none;">
                      Start free trial →
                    </a>
                  </td>
                </tr>
              </table>
              <!-- Secondary CTA -->
              <p style="margin:0 0 4px;font-size:13px;color:#64748b;">
                Want to see it in action first?
                <a href="${YOUTUBE_DEMO_URL}" style="color:#2563eb;text-decoration:none;font-weight:600;">Watch the 2-minute demo →</a>
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #e2e8f0;background:#f8fafc;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                PropOps — AI lead response for real estate agents. <a href="${FREE_TRIAL_URL}" style="color:#94a3b8;">propops.pro</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    const text = `Hi ${firstName},

Agents${agencyLine} typically miss 3–5 leads a week because they can't respond fast enough. By the time you see the inquiry, the buyer's already talking to someone else.

THE FULL LOOP
PropOps catches the lead instantly, responds in seconds, then follows up automatically — so nothing falls through the cracks. The agent just picks up the phone when it's time to close.

Stop missing leads. Make more money with less effort. PropOps reads every inquiry from REA, Domain and Homely the moment it arrives and sends a personalised response in your name — in under 3 seconds, 24/7.

Takes 2 minutes to set up. Free 14-day trial, no card required upfront.

Start free trial: ${FREE_TRIAL_URL}

Want to see it in action first? Watch the 2-minute demo: ${YOUTUBE_DEMO_URL}

— PropOps
propops.pro`;

    return sendEmail({ to: email, subject, html, text, tag: 'cold_outreach_1', reply_to: FROM_EMAIL });
}

/**
 * Cold outreach email #2 — Day 5 (Follow-up).
 * Addresses the "I'll look at this later" objection. Shows concrete numbers.
 * YouTube demo more prominent here as a low-commitment next step.
 */
async function sendColdOutreachEmail2({ email, name, agency }) {
    const firstName = name ? name.split(' ')[0] : 'there';
    const subject = `Re: your leads — still worth 2 minutes`;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;color:#0f172a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:#0f172a;padding:24px 40px;">
              <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">PropOps<span style="color:#f59e0b;">.</span></p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
                Hey ${firstName},
              </p>
              <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
                Sent you a note earlier this week about PropOps. Figured I'd follow up with one number that usually lands:
              </p>
              <!-- Stat callout -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;background:#fefce8;border-left:4px solid #f59e0b;border-radius:4px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <p style="margin:0;font-size:18px;font-weight:700;color:#0f172a;">78% of buyers choose the first agent to respond.</p>
                    <p style="margin:6px 0 0;font-size:13px;color:#64748b;">PropOps makes you that agent — even at 11pm on a Sunday.</p>
                  </td>
                </tr>
              </table>
              <!-- Dashboard screenshot -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
                <tr>
                  <td style="border-radius:10px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.10);border:1px solid #e2e8f0;">
                    <img src="https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_55743/images/8d4c8b28-494e-4561-a934-7ff500662153.png" alt="PropOps dashboard — 14 leads, 7s avg response, AI responded on 11" width="480" style="display:block;width:100%;height:auto;" />
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0 0;font-size:12px;color:#94a3b8;text-align:center;">Real dashboard. Real leads. Real response times.</td>
                </tr>
              </table>
              <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
                Setup is 2 minutes: forward your REA and Domain inquiry emails to your PropOps address, and every new lead gets a personalised reply in seconds. That's it.
              </p>
              <!-- Full Loop benefit list -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
                <tr><td style="padding:8px 16px;background:#f8fafc;border-left:3px solid #f59e0b;border-radius:0 6px 6px 0;margin-bottom:6px;">
                  <p style="margin:0;font-size:13px;color:#0f172a;"><strong>Stop missing leads</strong> — instant AI response, even at 2am Sunday</p>
                </td></tr>
                <tr><td style="height:6px;"></td></tr>
                <tr><td style="padding:8px 16px;background:#f8fafc;border-left:3px solid #f59e0b;border-radius:0 6px 6px 0;margin-bottom:6px;">
                  <p style="margin:0;font-size:13px;color:#0f172a;"><strong>Make more money with less effort</strong> — PropOps handles the admin, you handle the close</p>
                </td></tr>
                <tr><td style="height:6px;"></td></tr>
                <tr><td style="padding:8px 16px;background:#f8fafc;border-left:3px solid #f59e0b;border-radius:0 6px 6px 0;">
                  <p style="margin:0;font-size:13px;color:#0f172a;"><strong>Automated follow-up, nothing falls through</strong> — texts, emails, pipeline tracking all automatic</p>
                </td></tr>
              </table>
              <p style="margin:0 0 28px;font-size:15px;color:#334155;line-height:1.6;">
                If you'd rather see it working before committing — that's fair. The demo video covers the whole thing in 2 minutes.
              </p>
              <!-- Secondary CTA — demo video (prominent here) -->
              <table cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
                <tr>
                  <td style="background:#0f172a;border-radius:8px;">
                    <a href="${YOUTUBE_DEMO_URL}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">
                      Watch the 2-minute demo →
                    </a>
                  </td>
                </tr>
              </table>
              <!-- Primary CTA -->
              <p style="margin:0 0 4px;font-size:13px;color:#64748b;">
                Ready to try it?
                <a href="${FREE_TRIAL_URL}" style="color:#2563eb;text-decoration:none;font-weight:600;">Start your free 14-day trial →</a>
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #e2e8f0;background:#f8fafc;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                PropOps — AI lead response for real estate agents. <a href="${FREE_TRIAL_URL}" style="color:#94a3b8;">propops.pro</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    const text = `Hey ${firstName},

Sent you a note earlier this week about PropOps. One number that usually lands:

78% of buyers choose the first agent to respond.
PropOps makes you that agent — even at 11pm on a Sunday.

Setup is 2 minutes: forward your REA and Domain inquiry emails to your PropOps address, and every new lead gets a personalised reply in seconds.

The full loop:
- Stop missing leads — instant AI response, even at 2am Sunday
- Make more money with less effort — PropOps handles the admin, you handle the close
- Automated follow-up, nothing falls through — texts, emails, pipeline tracking all automatic

If you'd rather see it first — the demo covers the whole thing in 2 minutes:
${YOUTUBE_DEMO_URL}

Ready to try it? Start your free 14-day trial: ${FREE_TRIAL_URL}

— PropOps
propops.pro`;

    return sendEmail({ to: email, subject, html, text, tag: 'cold_outreach_2', reply_to: FROM_EMAIL });
}

/**
 * Cold outreach email #3 — Day 12 (Value Demo / Final).
 * Last touch. ROI focus — one missed commission framing. Free trial primary CTA,
 * YouTube secondary. Low-pressure close.
 */
async function sendColdOutreachEmail3({ email, name, agency }) {
    const firstName = name ? name.split(' ')[0] : 'there';
    const subject = `Last one from me, ${firstName}`;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;color:#0f172a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:#0f172a;padding:24px 40px;">
              <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">PropOps<span style="color:#f59e0b;">.</span></p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
                ${firstName},
              </p>
              <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
                Last note from me — won't keep chasing.
              </p>
              <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
                PropOps costs from $69/month. <strong>One missed commission costs $5,000–$15,000.</strong> The maths aren't complicated.
              </p>
              <!-- Full Loop summary -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1.5px solid #f59e0b;border-radius:10px;overflow:hidden;">
                <tr>
                  <td style="padding:18px 20px;background:#fef3c7;">
                    <p style="margin:0 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#d97706;">The Full Loop</p>
                    <p style="margin:0 0 12px;font-size:14px;font-weight:600;color:#0f172a;line-height:1.5;">Catch every lead. Respond in seconds. Follow up automatically. Your only job is to close.</p>
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr><td style="padding:4px 0;font-size:13px;color:#334155;">✓ &nbsp;Stop missing leads — AI replies 24/7, before you see the email</td></tr>
                      <tr><td style="padding:4px 0;font-size:13px;color:#334155;">✓ &nbsp;Make more money with less effort — PropOps does the admin</td></tr>
                      <tr><td style="padding:4px 0;font-size:13px;color:#334155;">✓ &nbsp;Nothing falls through the cracks — automated follow-up, texts &amp; emails</td></tr>
                      <tr><td style="padding:4px 0;font-size:13px;color:#334155;">✓ &nbsp;Pick up the phone and close — that's your only job</td></tr>
                    </table>
                  </td>
                </tr>
              </table>
              <!-- Dashboard screenshot -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
                <tr>
                  <td style="border-radius:10px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.10);border:1px solid #e2e8f0;">
                    <img src="https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_55743/images/8d4c8b28-494e-4561-a934-7ff500662153.png" alt="PropOps dashboard — 14 leads, 7s avg response, AI responded on 11" width="480" style="display:block;width:100%;height:auto;" />
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0 0;font-size:12px;color:#94a3b8;text-align:center;">14 leads. 7s avg response. AI responded on 11. This is what it looks like.</td>
                </tr>
              </table>
              <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
                If the timing's just not right, no worries — you can always come back to it at <a href="${FREE_TRIAL_URL}" style="color:#2563eb;text-decoration:none;">propops.pro</a>.
              </p>
              <p style="margin:0 0 28px;font-size:15px;color:#334155;line-height:1.6;">
                If you want to see how it actually works before committing, the 2-minute demo shows the full picture:
              </p>
              <!-- Secondary CTA — YouTube demo -->
              <table cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
                <tr>
                  <td style="background:#0f172a;border-radius:8px;">
                    <a href="${YOUTUBE_DEMO_URL}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">
                      Watch how it works →
                    </a>
                  </td>
                </tr>
              </table>
              <!-- Primary CTA -->
              <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td style="background:#f59e0b;border-radius:8px;">
                    <a href="${FREE_TRIAL_URL}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#0f172a;text-decoration:none;">
                      Start free trial →
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0;font-size:13px;color:#64748b;">
                14 days free. No card required upfront. Cancel anytime.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #e2e8f0;background:#f8fafc;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                PropOps — AI lead response for real estate agents. <a href="${FREE_TRIAL_URL}" style="color:#94a3b8;">propops.pro</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    const text = `${firstName},

Last note from me — won't keep chasing.

PropOps costs from $69/month. One missed commission costs $5,000–$15,000. The maths aren't complicated.

THE FULL LOOP
Catch every lead. Respond in seconds. Follow up automatically. Your only job is to close.

✓ Stop missing leads — AI replies 24/7, before you see the email
✓ Make more money with less effort — PropOps does the admin
✓ Nothing falls through the cracks — automated follow-up, texts & emails
✓ Pick up the phone and close — that's your only job

If timing's not right, no worries — you can always come back: ${FREE_TRIAL_URL}

Want to see how it works first? Watch the 2-minute demo: ${YOUTUBE_DEMO_URL}

Or jump straight into the free trial: ${FREE_TRIAL_URL}

14 days free. No card required upfront. Cancel anytime.

— PropOps
propops.pro`;

    return sendEmail({ to: email, subject, html, text, tag: 'cold_outreach_3', reply_to: FROM_EMAIL });
}

/**
 * Retry all pending emails. Called by /api/admin/retry-emails endpoint.
 * Returns { sent, failed, total }.
 */
async function retryPendingEmails() {
    const pool = getPool();
    if (!pool) return { sent: 0, failed: 0, total: 0 };

    try {
        const result = await pool.query(
            `SELECT id, recipient, subject, html_body, text_body, tag
             FROM pending_emails
             WHERE status = 'pending'
             ORDER BY created_at ASC
             LIMIT 20`
        );

        let sent = 0;
        let failed = 0;

        for (const row of result.rows) {
            const emailResult = await sendEmail({
                to: row.recipient,
                subject: row.subject,
                html: row.html_body,
                text: row.text_body,
                tag: row.tag,
            });

            if (emailResult && emailResult.ok) {
                await pool.query(
                    `UPDATE pending_emails SET status = 'sent', last_error = $1 WHERE id = $2`,
                    [`Retried and sent via ${emailResult.provider}`, row.id]
                );
                sent++;
                console.log(`[Email] ✅ Retry successful for ${row.recipient} (pending_emails #${row.id})`);
            } else {
                await pool.query(
                    `UPDATE pending_emails SET last_error = 'Retry failed — still no provider' WHERE id = $1`,
                    [row.id]
                );
                failed++;
            }
        }

        return { sent, failed, total: result.rows.length };
    } catch (err) {
        console.error('[Email] Retry error:', err.message);
        return { sent: 0, failed: 0, total: 0, error: err.message };
    }
}

module.exports = { sendEmail, sendWaitlistConfirmation, sendWelcomeEmail, sendTrialReminderEmail, getPendingEmailCount, retryPendingEmails, sendColdOutreachEmail1, sendColdOutreachEmail2, sendColdOutreachEmail3 };
