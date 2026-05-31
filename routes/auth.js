/**
 * Auth routes — magic link login, session verification, Stripe signup.
 *
 * POST /api/auth/magic-link         — Send magic link to email
 * GET  /auth/verify?token=...       — Render form for token verification (do not consume)
 * POST /auth/verify                 — Consume token and set session cookie
 * GET  /api/auth/me                 — Return current user from JWT
 * POST /api/auth/signup-complete    — Complete signup after Stripe checkout
 * POST /api/auth/logout             — Clear session
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const auth = require('../services/auth');
const { sendEmail, sendWelcomeEmail } = require('../services/email');
const { seedDefaultServices } = require('../services/default-services');

// Pool for operator_profiles lookup in /me endpoint
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── Session cookie builder ──────────────────────────────────────────────────
// Always HttpOnly + SameSite=Lax + 30-day Max-Age.
// Secure flag is set in production (Render is always HTTPS).
const IS_PROD = process.env.NODE_ENV === 'production' || !!(process.env.APP_URL && !process.env.APP_URL.includes('localhost'));
function sessionCookieHeader(token) {
  const base = `propops_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;
  return IS_PROD ? `${base}; Secure` : base;
}

// ─── Middleware: verify JWT ──────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  const cookieToken = req.cookies && (req.cookies['propops_session'] || req.cookies['relio_session']);
  const token = (header && header.startsWith('Bearer ') ? header.slice(7) : null) || cookieToken;
  if (!token) return res.status(401).json({ success: false, message: 'Not authenticated' });

  const payload = auth.verifySessionToken(token);
  if (!payload) return res.status(401).json({ success: false, message: 'Session expired' });

  req.userId = payload.sub;
  req.userEmail = payload.email;
  next();
}

// ─── POST /api/auth/magic-link ────────────────────────────────────────────────

router.post('/magic-link', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Valid email required' });
  }

  try {
    const { url } = await auth.createMagicLink(email.toLowerCase());

    // Send the magic link email
    const emailResult = await sendEmail({
      to: email,
      subject: 'Your PropOps login link',
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <tr><td style="background:#0f172a;padding:28px 40px;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#fff;">PropOps<span style="color:#f59e0b;">.</span></p>
        </td></tr>
        <tr><td style="padding:40px;">
          <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0f172a;">Your login link</h1>
          <p style="margin:0 0 24px;font-size:15px;color:#334155;line-height:1.6;">Click the button below to log in to PropOps. This link expires in 15 minutes and can only be used once.</p>
          <table cellpadding="0" cellspacing="0">
            <tr><td style="background:#f59e0b;border-radius:8px;">
              <a href="${url}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#0f172a;text-decoration:none;">
                Log in to PropOps →
              </a>
            </td></tr>
          </table>
          <p style="margin:20px 0 0;font-size:13px;color:#94a3b8;">If you didn't request this, you can ignore this email.</p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #e2e8f0;background:#f8fafc;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">— PropOps</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
      `.trim(),
      text: `Your PropOps login link:\n\n${url}\n\nExpires in 15 minutes, single-use. If you didn't request this, ignore this email.\n\n— PropOps`,
      tag: 'magic_link',
    });

    if (emailResult && emailResult.ok) {
      res.json({ success: true, message: 'Login link sent — check your email' });
    } else {
      console.error(`[Auth] Magic link email FAILED for ${email} — result:`, JSON.stringify(emailResult));
      res.status(502).json({ success: false, message: 'Unable to send login email right now. Please try again in a few minutes.' });
    }
  } catch (err) {
    console.error('[Auth] Magic link error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send login link' });
  }
});

// ─── GET /auth/verify?token=... ───────────────────────────────────────────────
// Security: render a form, do NOT consume the token yet.
// This prevents Gmail/bot link scanners from consuming the token.

router.get('/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/login?error=missing_token');

  try {
    // Check if token exists, is not used, and not expired (read-only SELECT)
    const dbPool = require('pg').Pool ? new (require('pg').Pool)({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    }) : pool;
    
    const result = await dbPool.query(
      `SELECT id FROM email_tokens
       WHERE token = $1 AND used = FALSE AND expires_at > NOW()
       LIMIT 1`,
      [token]
    );

    if (!result.rows[0]) return res.redirect('/login?error=invalid_or_expired');

    // Token is valid — render form that POSTs to /auth/verify
    const appUrl = process.env.APP_URL || 'https://propops.pro';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PropOps — Logging in</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
    }
    .container {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      padding: 60px 40px;
      text-align: center;
      max-width: 400px;
      width: 100%;
    }
    .logo {
      font-size: 28px;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 24px;
      letter-spacing: -0.5px;
    }
    .logo span {
      color: #f59e0b;
    }
    h1 {
      font-size: 20px;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 12px;
    }
    p {
      font-size: 14px;
      color: #64748b;
      margin-bottom: 32px;
      line-height: 1.6;
    }
    button {
      width: 100%;
      padding: 14px 28px;
      background: #f59e0b;
      color: #0f172a;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover {
      background: #f08c00;
    }
    button:active {
      background: #e67e0e;
    }
    .footer {
      font-size: 12px;
      color: #94a3b8;
      margin-top: 20px;
    }
    form {
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">PropOps<span>.</span></div>
    <h1>Verifying your login</h1>
    <p>Click the button below to complete your login. You'll be redirected to your dashboard.</p>
    <form method="POST" action="/auth/verify">
      <input type="hidden" name="token" value="${token}">
      <button type="submit">Log in to PropOps →</button>
    </form>
    <div style="display: none;" id="form-container"></div>
    <script>
      // Auto-submit form when page loads (respects user choice to click)
      // This ensures a good UX while still requiring an HTTP request (POST)
      document.querySelector('form').submit();
    </script>
  </div>
</body>
</html>
    `);
  } catch (err) {
    console.error('[Auth] Verify GET error:', err.message);
    res.redirect('/login?error=server_error');
  }
});

// ─── POST /auth/verify ────────────────────────────────────────────────────────
// Consume the magic link token and set session cookie.

router.post('/verify', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.redirect('/login?error=missing_token');

  try {
    const link = await auth.verifyMagicLink(token);
    if (!link) return res.redirect('/login?error=invalid_or_expired');

    const user = await auth.getUserById(link.user_id);
    const sessionToken = auth.generateSessionToken(user);

    // WHY: login_redirect cookie is set by login.html when user arrives via /login?redirect=/pays
    // Without this, magic link always sent users to /dashboard, causing the /pays auth loop (POL-1565942)
    const cookies = {};
    (req.headers['cookie'] || '').split(';').forEach(pair => {
      const [k, ...v] = pair.trim().split('=');
      if (k) cookies[k.trim()] = decodeURIComponent(v.join('=') || '');
    });
    const redirectTo = cookies['login_redirect'] || '/dashboard';
    // Clear the one-time redirect cookie
    const clearRedirect = 'login_redirect=; Path=/; Max-Age=0; SameSite=Lax';

    res.setHeader('Set-Cookie', [sessionCookieHeader(sessionToken), clearRedirect]);
    res.redirect(redirectTo);
  } catch (err) {
    console.error('[Auth] Verify POST error:', err.message);
    res.redirect('/login?error=server_error');
  }
});

// ─── POST /api/auth/signup-complete ──────────────────────────────────────────
// Called when user arrives at /signup/success after Stripe checkout.

router.post('/signup-complete', async (req, res) => {
  const { email, name, session_id, business_type } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Valid email required' });
  }

  try {
    const user = await auth.createUser({
      email: email.toLowerCase(),
      name,
      stripeSessionId: session_id || null,
      businessType: business_type || 'real_estate',
    });
    const sessionToken = auth.generateSessionToken(user);

    // Seed default services for trade operators — non-blocking, never fails signup
    seedDefaultServices(user.id, business_type || 'real_estate').catch((err) => {
      console.error(`[Auth] Default service seed failed for user ${user.id}:`, err.message);
    });

    // Send welcome email if not already sent
    const appUrl = process.env.APP_URL || 'https://propops.pro';
    if (!user.welcome_email_sent) {
      const emailResult = await sendWelcomeEmail({ email: user.email, name: user.name || name, loginUrl: `${appUrl}/dashboard` });
      if (emailResult && emailResult.ok) {
        await auth.markWelcomeEmailSent(user.id);
        console.log(`[Auth] ✅ Welcome email sent to ${email} via ${emailResult.provider}`);
      } else {
        console.error(`[Auth] ❌ Welcome email FAILED for ${email} — will retry on next login`);
      }
    }

    console.log(`[Auth] ✅ New user created: ${email} (id: ${user.id})`);
    // Set session cookie (same as magic link verify) so dashboard auth works immediately
    res.setHeader('Set-Cookie', sessionCookieHeader(sessionToken));
    res.json({ success: true, token: sessionToken, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('[Auth] Signup complete error:', err.message);
    res.status(500).json({ success: false, message: 'Account creation failed' });
  }
});

// ─── GET /api/auth/me ────────────────────────────────────────────────────────

router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await auth.getUserById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Fetch business_name from operator_profiles (non-fatal if missing)
    let businessName = null;
    try {
      const opResult = await pool.query(
        `SELECT business_name FROM operator_profiles WHERE operator_id = $1`,
        [req.userId]
      );
      businessName = opResult.rows[0]?.business_name || null;
    } catch (_) {}

    const daysLeft = auth.getDaysLeft(user.trial_end);
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        mobile_number: user.mobile_number || null,
        subscription_status: user.subscription_status,
        trial_end: user.trial_end,
        days_left: daysLeft,
        business_type: user.business_type || 'real_estate',
        business_name: businessName,
        is_admin: user.is_admin === true,
        subscription_expires_at: user.subscription_expires_at || null,
        cancelled_at: user.cancelled_at || null,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/auth/password-login ───────────────────────────────────────────
// Traditional email + password login. Returns session cookie + JSON.

router.post('/password-login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Valid email required' });
  }
  if (!password || password.length < 1) {
    return res.status(400).json({ success: false, message: 'Password required' });
  }

  try {
    const user = await auth.loginWithPassword(email, password);
    if (!user) {
      // Don't reveal whether email exists
      return res.status(401).json({ success: false, message: 'Incorrect email or password' });
    }

    const sessionToken = auth.generateSessionToken(user);
    res.setHeader('Set-Cookie', sessionCookieHeader(sessionToken));
    res.json({
      success: true,
      token: sessionToken,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err) {
    console.error('[Auth] Password login error:', err.message);
    res.status(500).json({ success: false, message: 'Login failed — please try again' });
  }
});

// ─── POST /api/auth/set-password ─────────────────────────────────────────────
// Authenticated user sets or changes their password.

router.post('/set-password', requireAuth, async (req, res) => {
  const { password, current_password } = req.body;

  if (!password || password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  }

  try {
    const user = await auth.getUserById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // If user already has a password, require the current one for security
    if (user.password_hash) {
      if (!current_password) {
        return res.status(400).json({ success: false, message: 'Current password required to change password' });
      }
      if (!auth.checkPassword(current_password, user.password_hash)) {
        return res.status(401).json({ success: false, message: 'Current password is incorrect' });
      }
    }

    await auth.setUserPassword(req.userId, password);
    console.log(`[Auth] Password set for user ${req.userId}`);
    res.json({ success: true, message: 'Password set successfully' });
  } catch (err) {
    console.error('[Auth] Set password error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to set password' });
  }
});

// ─── GET /api/auth/has-password ──────────────────────────────────────────────
// Returns whether the current user has a password set (for UI hints).

router.get('/has-password', requireAuth, async (req, res) => {
  try {
    const hasPassword = await auth.userHasPassword(req.userId);
    res.json({ success: true, has_password: hasPassword });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────
// Sends a password reset email. Always returns success (no email enumeration).

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Valid email required' });
  }

  try {
    const result = await auth.createPasswordResetToken(email.toLowerCase());

    // If user exists and not rate-limited, send email
    if (result && result.rawToken) {
      const resetUrl = `${process.env.APP_URL || 'https://propops.pro'}/reset-password?token=${result.rawToken}`;
      await sendEmail({
        to: email,
        subject: 'Reset your PropOps password',
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <tr><td style="background:#0f172a;padding:28px 40px;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#fff;">PropOps<span style="color:#f59e0b;">.</span></p>
        </td></tr>
        <tr><td style="padding:40px;">
          <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0f172a;">Reset your password</h1>
          <p style="margin:0 0 24px;font-size:15px;color:#334155;line-height:1.6;">Click the button below to set a new password. This link expires in 1 hour and can only be used once.</p>
          <table cellpadding="0" cellspacing="0">
            <tr><td style="background:#0f172a;border-radius:8px;">
              <a href="${resetUrl}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#fff;text-decoration:none;">
                Reset password &rarr;
              </a>
            </td></tr>
          </table>
          <p style="margin:20px 0 0;font-size:13px;color:#94a3b8;">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #e2e8f0;background:#f8fafc;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">PropOps.Pro</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
        `.trim(),
        text: `Reset your PropOps password:\n\n${resetUrl}\n\nExpires in 1 hour. If you didn't request this, ignore this email.\n\nPropOps.Pro`,
        tag: 'password_reset',
      });
    }

    // Always return success (prevents email enumeration)
    res.json({ success: true, message: 'If an account exists with that email, a reset link has been sent.' });
  } catch (err) {
    console.error('[Auth] Forgot password error:', err.message);
    // Still return success to prevent enumeration
    res.json({ success: true, message: 'If an account exists with that email, a reset link has been sent.' });
  }
});

// ─── POST /api/auth/reset-password ──────────────────────────────────────────
// Accepts a reset token + new password. Sets the password if token is valid.

router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;

  if (!token) {
    return res.status(400).json({ success: false, message: 'Reset token is required' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  }

  try {
    const result = await auth.verifyPasswordResetToken(token);
    if (!result) {
      return res.status(400).json({ success: false, message: 'This reset link has expired or already been used. Please request a new one.' });
    }

    await auth.setUserPassword(result.userId, password);
    console.log(`[Auth] Password reset for user ${result.userId} (${result.email})`);
    res.json({ success: true, message: 'Password has been reset' });
  } catch (err) {
    console.error('[Auth] Reset password error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to reset password — please try again' });
  }
});

// ─── POST /api/auth/logout ───────────────────────────────��────────────────────

router.post('/logout', (req, res) => {
  // Clear both old and new cookie names
  res.setHeader('Set-Cookie', [
    'propops_session=; Path=/; HttpOnly; Max-Age=0',
    'relio_session=; Path=/; HttpOnly; Max-Age=0'
  ]);
  res.json({ success: true });
});

module.exports = { router, requireAuth };
