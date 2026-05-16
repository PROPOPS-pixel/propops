/**
 * Phone-based magic link authentication.
 *
 * POST /api/auth/phone-magic-link  — Send SMS with one-time login link
 * GET  /auth/verify-phone          — Verify token → create/login user → set session cookie
 *
 * Flow:
 *   1. User enters phone number on landing page
 *   2. POST /api/auth/phone-magic-link → normalises number, rate-limits, sends SMS
 *   3. SMS contains: "Your PropOps link: https://propops.pro/auth/verify-phone?token=xxx"
 *   4. GET /auth/verify-phone?token=xxx → verifies token, creates user if new (14-day trial),
 *      sets propops_session cookie, redirects to /dashboard
 *
 * After signup the PWA start_url=/ detects the session cookie and renders the dashboard.
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { Pool } = require('pg');
const { sendSMS, normaliseAustralianNumber } = require('../services/sms');
const auth = require('../services/auth');

const DEFAULT_APP_URL = process.env.APP_URL || 'https://propops.pro';
const IS_PROD    = process.env.NODE_ENV === 'production' ||
                   !!(process.env.APP_URL && !process.env.APP_URL.includes('localhost'));
const TOKEN_TTL  = 15 * 60 * 1000; // 15 minutes in ms
const COOLDOWN   = 30 * 1000;       // 30-second re-send cooldown per number

/**
 * Determine the base URL for magic links based on the incoming request hostname.
 * propops.trade requests get propops.trade links (cookie domain stays correct).
 * All others fall back to the canonical APP_URL.
 */
function getBaseUrl(req) {
  const host = req.hostname || '';
  if (host === 'propops.trade' || host === 'www.propops.trade') {
    return 'https://propops.trade';
  }
  return DEFAULT_APP_URL;
}

let _pool = null;
function getPool() {
  if (!_pool && process.env.DATABASE_URL) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  }
  return _pool;
}

function sessionCookieHeader(token) {
  const base = `propops_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;
  return IS_PROD ? `${base}; Secure` : base;
}

// ─── POST /api/auth/phone-magic-link ─────────────────────────────────────────

router.post('/phone-magic-link', async (req, res) => {
  const rawPhone = (req.body.phone || '').trim();
  if (!rawPhone) {
    return res.status(400).json({ success: false, message: 'Phone number required' });
  }

  const phone = normaliseAustralianNumber(rawPhone);
  if (!phone) {
    return res.status(400).json({
      success: false,
      message: 'Enter a valid Australian mobile number (e.g. 0412 345 678)',
    });
  }

  const pool = getPool();
  if (!pool) {
    return res.status(503).json({ success: false, message: 'Database unavailable' });
  }

  try {
    // Rate limit: 1 SMS per phone per 30 seconds
    const recent = await pool.query(
      `SELECT id FROM phone_magic_links
       WHERE phone = $1 AND created_at > NOW() - INTERVAL '30 seconds'
       LIMIT 1`,
      [phone]
    );
    if (recent.rows.length > 0) {
      return res.status(429).json({
        success: false,
        message: 'Already sent — check your texts. Wait 30 seconds to resend.',
      });
    }

    // Generate token + expiry
    const token    = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL);

    await pool.query(
      `INSERT INTO phone_magic_links (phone, token, expires_at) VALUES ($1, $2, $3)`,
      [phone, token, expiresAt]
    );

    const baseUrl = getBaseUrl(req);
    const url  = `${baseUrl}/auth/verify-phone?token=${token}`;
    const body = `Your PropOps login link (expires 15 min):\n${url}\n\nDon't share this link.`;

    const smsResult = await sendSMS({ to: phone, body }).catch(err => ({
      ok: false,
      reason: err.message,
    }));

    if (!smsResult.ok) {
      // If Twilio isn't configured (dev) — still succeed so testing doesn't break
      const notConfigured = smsResult.reason === 'not_configured';
      if (!notConfigured) {
        console.error(`[phone-auth] SMS send failed for ${phone}: ${smsResult.reason}`);
        return res.status(500).json({
          success: false,
          message: 'Failed to send SMS — please try again or use a different number.',
        });
      }
      // Dev mode: log the link so engineers can test without Twilio
      console.log(`[phone-auth] DEV MODE — no Twilio configured. Magic link: ${url}`);
    }

    return res.json({
      success: true,
      message: `Link sent to ${phone.replace(/(\+61)(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4')}`,
    });
  } catch (err) {
    console.error('[phone-auth] Error in phone-magic-link:', err);
    return res.status(500).json({ success: false, message: 'Server error — please try again' });
  }
});

// ─── GET /auth/verify-phone?token=... ────────────────────────────────────────

router.get('/verify-phone', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.redirect(`/login?error=${encodeURIComponent('Missing token')}`);
  }

  const pool = getPool();
  if (!pool) {
    return res.redirect(`/login?error=${encodeURIComponent('Database unavailable')}`);
  }

  try {
    // Find valid, unused token
    const result = await pool.query(
      `SELECT * FROM phone_magic_links
       WHERE token = $1 AND used = FALSE AND expires_at > NOW()
       LIMIT 1`,
      [token]
    );

    if (!result.rows[0]) {
      return res.redirect(`/login?error=${encodeURIComponent('Link expired or already used')}`);
    }

    const link = result.rows[0];

    // Mark token used immediately (single-use)
    await pool.query(`UPDATE phone_magic_links SET used = TRUE WHERE id = $1`, [link.id]);

    // Find or create user by phone number
    let userRow = await pool.query(
      `SELECT * FROM users WHERE phone = $1 LIMIT 1`,
      [link.phone]
    );

    let user;
    if (userRow.rows[0]) {
      user = userRow.rows[0];
      // Update last login
      await pool.query(`UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1`, [user.id]);
    } else {
      // New user — phone number as identity, 14-day trial starts now
      // Use phone as synthetic email key so the rest of the app (which is email-indexed) keeps working
      const syntheticEmail = `${link.phone.replace(/\+/, '')}@phone.propops.pro`;

      // Check if a user with this synthetic email exists (shouldn't, but be safe)
      const emailCheck = await pool.query(
        `SELECT * FROM users WHERE email = $1 LIMIT 1`,
        [syntheticEmail]
      );

      if (emailCheck.rows[0]) {
        user = emailCheck.rows[0];
        // Stamp phone if missing
        if (!user.phone) {
          await pool.query(`UPDATE users SET phone = $1, updated_at = NOW() WHERE id = $2`, [link.phone, user.id]);
          user.phone = link.phone;
        }
        await pool.query(`UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1`, [user.id]);
      } else {
        const insertResult = await pool.query(
          `INSERT INTO users
             (email, phone, subscription_status, trial_start, trial_end, business_type)
           VALUES ($1, $2, 'trial', NOW(), NOW() + INTERVAL '14 days', 'real_estate')
           RETURNING *`,
          [syntheticEmail, link.phone]
        );
        user = insertResult.rows[0];

        // Fire-and-forget: welcome SMS
        const welcomeBody = `Welcome to PropOps! Your 14-day free trial has started.\n\nOpen the app: ${DEFAULT_APP_URL}/dashboard\n\nReply STOP to unsubscribe.`;
        sendSMS({ to: link.phone, body: welcomeBody }).catch(() => {});
      }
    }

    // Generate 30-day session token
    const sessionToken = auth.generateSessionToken(user);

    res
      .setHeader('Set-Cookie', sessionCookieHeader(sessionToken))
      .redirect('/dashboard');
  } catch (err) {
    console.error('[phone-auth] Error in verify-phone:', err);
    return res.redirect(`/login?error=${encodeURIComponent('Verification failed — please try again')}`);
  }
});

module.exports = { router };
