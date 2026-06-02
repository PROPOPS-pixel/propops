/**
 * Gmail OAuth routes — one-time brain activation link.
 *
 * Setup router (mounted at /setup):
 *   GET /setup/gmail       — redirect to Google OAuth consent
 *   GET /setup/gmail/success — show "Hugo's brain is open" confirmation page
 *
 * Callback router (mounted at /api/auth/callback):
 *   GET /api/auth/callback/google — exchange code for tokens, save, redirect to success
 */

const express = require('express');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send'
].join(' ');

const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
// ─── Shared token exchange logic ───────────────────────────────────────────

async function exchangeAndSaveTokens(code) {
  const { google } = require('googleapis');
  const pool = require('../db');

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );

  const { tokens } = await oauth2.getToken(code);

  const expires_at = tokens.expiry_date
    ? new Date(tokens.expiry_date)
    : null;

  await pool.query(`
    INSERT INTO gmail_oauth_tokens (connected_email, access_token, refresh_token, token_type, expires_at, scope, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (connected_email) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      token_type = EXCLUDED.token_type,
      expires_at = EXCLUDED.expires_at,
      scope = EXCLUDED.scope,
      updated_at = NOW()
  `, [
    'hugopropops@gmail.com',
    tokens.access_token,
    tokens.refresh_token,
    tokens.token_type || 'Bearer',
    expires_at,
    tokens.scope || SCOPES
  ]);

  console.log('[Gmail OAuth] Token saved for hugopropops@gmail.com');
}

// ─── Setup router — /setup/gmail, /setup/gmail/success ────────────────────

const setupRouter = express.Router();

setupRouter.get('/gmail', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.send(`
      <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Gmail Not Configured</title></head>
      <body style="font-family:system-ui;max-width:600px;margin:60px auto;padding:0 20px;text-align:center;">
        <h2>☁️ Gmail OAuth not configured</h2>
        <p>Set these env vars in your Render dashboard, then visit this page again:</p>
        <ul style="text-align:left;display:inline-block;font-family:monospace;background:#f4f4f4;padding:16px 24px;border-radius:8px;list-style:none;">
          <li>GOOGLE_CLIENT_ID</li>
          <li>GOOGLE_CLIENT_SECRET</li>
          <li>GOOGLE_REDIRECT_URI=${REDIRECT_URI}</li>
        </ul>
      </body></html>
    `);
  }

  const { google } = require('googleapis');
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // forces refresh_token (offline access)
  });

  res.redirect(authUrl);
});

setupRouter.get('/gmail/success', (req, res) => {
  const { error } = req.query;
  const connectedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'long', timeStyle: 'short' });

  if (error) {
    return res.send(`
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Setup Failed</title>
        <style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0;}.card{background:#1e293b;border-radius:20px;padding:56px 48px;max-width:520px;width:100%;text-align:center;box-shadow:0 24px 64px rgba(0,0,0,0.4);}.icon{font-size:60px;margin-bottom:24px;display:block;}.card h1{font-size:28px;font-weight:800;color:#fff;margin-bottom:8px;letter-spacing:-0.5px;}.err{background:#7f1d1d;color:#fecaca;padding:16px;border-radius:8px;margin:24px 0;font-size:14px;}.card a{display:inline-block;background:#f59e0b;color:#0f172a;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:16px;margin-top:16px;}.card a:hover{background:#d97706;}</style>
      </head><body><div class="card"><div class="icon">❌</div><h1>Setup Failed</h1><div class="err">${error}</div><a href="/setup/gmail">Try Again →</a></div></body></html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Hubo's Gmail Brain — ACTIVE</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .card { background: #1e293b; border-radius: 20px; padding: 56px 48px; max-width: 520px; width: 100%; text-align: center; box-shadow: 0 24px 64px rgba(0,0,0,0.4); }
        .brain { font-size: 80px; margin-bottom: 24px; display: block; animation: pulse 2s ease-in-out infinite; }
        @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        h1 { font-size: 28px; font-weight: 800; color: #fff; margin-bottom: 8px; letter-spacing: -0.5px; }
        .subtitle { color: #f59e0b; font-size: 16px; font-weight: 600; margin-bottom: 32px; }
        .email-badge { display: inline-flex; align-items: center; gap: 8px; background: rgba(16,185,129,0.1); border: 1px solid #10b981; border-radius: 100px; padding: 8px 20px; margin-bottom: 32px; }
        .email-badge .dot { width: 8px; height: 8px; background: #10b981; border-radius: 50%; animation: blink 2s ease-in-out infinite; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .email-badge span { font-size: 14px; color: #10b981; font-weight: 600; }
        .abilities { background: #0f172a; border-radius: 12px; padding: 24px; margin-bottom: 32px; text-align: left; }
        .abilities h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; color: #64748b; margin-bottom: 16px; }
        .ability { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; font-size: 15px; color: #cbd5e1; }
        .ability:last-child { margin-bottom: 0; }
        a.dashboard { display: inline-block; background: #f59e0b; color: #0f172a; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 700; font-size: 16px; }
        a.dashboard:hover { background: #d97706; }
        .timestamp { font-size: 12px; color: #475569; margin-top: 16px; }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="brain">🧠</span>
        <h1>Hugo's Gmail Brain</h1>
        <div class="subtitle">ACTIVE</div>
        <div class="email-badge"><div class="dot"></div><span>hugopropops@gmail.com</span></div>
        <div class="abilities">
          <h3>Hugo can now:</h3>
          <div class="ability">📥 Read incoming portal lead emails (Hipages, Airtasker, etc.)</div>
          <div class="ability">📊 Monitor Gmail inbox for new customer enquiries</div>
          <div class="ability">📤 Send emails from hugopropops@gmail.com on your behalf</div>
          <div class="ability">🔄 Auto-refresh tokens — stays connected indefinitely</div>
        </div>
        <a href="/founder" class="dashboard">Open Founder Dashboard →</a>
        <div class="timestamp">Connected at ${connectedAt} (AEST)</div>
      </div>
    </body>
    </html>
  `);
});

// ─── Callback router — /api/auth/callback/google ───────────────────────────

const callbackRouter = express.Router();

callbackRouter.get('/google', async (req, res) => {
  console.log('CALLBACK DEBUG:', { hasReq: !!req, reqType: typeof req, hasQuery: req ? !!req.query : 'no req', queryValue: req ? req.query : 'no req', fullUrl: req ? req.originalUrl : 'no req' });
  const { code, error } = req.query;

  if (error) {
    console.error('[Gmail OAuth] User denied or error:', error);
    return res.redirect('/setup/gmail/success?error=' + encodeURIComponent('Access denied or cancelled.'));
  }

  if (!code) {
    return res.redirect('/setup/gmail');
  }

  try {
    await exchangeAndSaveTokens(code);
    res.redirect('/setup/gmail/success');
  } catch (err) {
    console.error('[Gmail OAuth] Callback error:', err.message);
    res.redirect('/setup/gmail/success?error=' + encodeURIComponent(err.message));
  }
});

module.exports = { setupRouter, callbackRouter };
