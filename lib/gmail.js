/**
 * Gmail API integration — read and send via OAuth2 stored refresh_token.
 * Uses Hugopropops@gmail.com as the sender identity.
 *
 * Exports:
 *   getGmailClient()           — returns authenticated googleapis gmail client
 *   readEmails(query, max)     — search Gmail, return message list
 *   sendEmail(to, subject, body) — send HTML email from hugopropops@gmail.com
 *   getRecentLeads()           — search inbox for portal lead notifications
 *   isConnected()              — returns true if tokens exist in DB
 */

const { pool } = require('../db');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send'
];

// ─── Token storage ───────────────────────────────────────────────────────────

async function getStoredTokens() {
  const result = await pool.query(
    `SELECT * FROM gmail_oauth_tokens ORDER BY id DESC LIMIT 1`
  );
  return result.rows[0] || null;
}

async function saveTokens({ access_token, refresh_token, token_type, expires_in, scope }) {
  const expires_at = expires_in
    ? new Date(Date.now() + expires_in * 1000)
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
  `, ['hugopropops@gmail.com', access_token, refresh_token, token_type || 'Bearer', expires_at, scope]);
}

// ─── OAuth2 token refresh ─────────────────────────────────────────────────────

async function refreshAccessToken(refresh_token) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token,
    grant_type: 'refresh_token'
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token refresh failed: ${err}`);
  }

  return response.json();
}

// ─── Authenticated Gmail client ──────────────────────────────────────────────

async function getGmailClient() {
  // Lazy-load googleapis to avoid requiring it until Gmail is set up
  const { google } = require('googleapis');
  const tokens = await getStoredTokens();

  if (!tokens?.refresh_token) {
    throw new Error('Gmail not connected. Visit /setup/gmail to authorize.');
  }

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  // Refresh token if needed
  if (!tokens.expires_at || new Date(tokens.expires_at) <= new Date()) {
    const newTokens = await refreshAccessToken(tokens.refresh_token);
    await saveTokens({
      access_token: newTokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: newTokens.token_type || 'Bearer',
      expires_in: newTokens.expires_in,
      scope: tokens.scope
    });
    oauth2.setCredentials({ access_token: newTokens.access_token, refresh_token: tokens.refresh_token });
  } else {
    oauth2.setCredentials({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
  }

  return google.gmail({ version: 'v1', auth: oauth2 });
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function isConnected() {
  const tokens = await getStoredTokens();
  return !!(tokens?.refresh_token);
}

async function readEmails(query = 'is:inbox', maxResults = 20) {
  const gmail = await getGmailClient();
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults
  });

  const messages = listRes.data.messages || [];

  const withDetails = await Promise.all(
    messages.slice(0, 10).map(async (m) => {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
      const headers = msg.data.payload.headers;
      const get = (name) => headers.find(h => h.name === name)?.value || '';
      return {
        id: m.id,
        from: get('From'),
        subject: get('Subject'),
        date: get('Date'),
        snippet: msg.data.snippet
      };
    })
  );

  return withDetails;
}

async function sendEmail(to, subject, body) {
  const gmail = await getGmailClient();

  // Construct RFC 2822 message
  const fromEncoded = 'Hugo PropOps <hugopropops@gmail.com>';
  const toEncoded = to;
  const boundary = 'B吉尔_' + Math.random().toString(36).slice(2);

  const raw = [
    `From: ${fromEncoded}`,
    `To: ${toEncoded}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset="UTF-8"`,
    ``,
    body
  ].join('\r\n');

  const encoded = Buffer.from(raw).toString('base64url');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded }
  });

  return res.data;
}

async function getRecentLeads() {
  // Search for portal lead notification patterns
  const portals = ['hipages', 'serviceseeking', 'airtasker', 'oneflare', 'bark', 'facebook', 'google'];
  const queries = portals.map(p => `from:${p} OR subject:${p}`).join(' OR ');
  return readEmails(queries, 20);
}

module.exports = { isConnected, readEmails, sendEmail, getRecentLeads };