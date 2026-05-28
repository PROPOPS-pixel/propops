/**
 * Staff Portal routes — employee-facing auth, roster view, GPS clock-in/out, shift swaps.
 *
 * Owns: staff invite acceptance + login, clock events, shift swap requests (staff side).
 * Does NOT own: operator auth, payroll calculations, invoice management, Hugo brain.
 *
 * All /api/staff-portal/* routes use a separate staff JWT (staff_portal_token cookie).
 * Staff only see their OWN data — scoped by staff_id from JWT.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const crypto = require('crypto');
const staffNotify = require('../services/staff-notifications');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── JWT helpers (staff-specific secret suffix) ───────────────────────────────

const JWT_SECRET = (process.env.JWT_SECRET || 'propops-secret-change-in-production') + '-staff';

function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function createStaffJWT(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.${sig}`;
}

function verifyStaffJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    if (sig !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function hashPassword(password) {
  // PBKDF2 — no bcrypt dep required
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const check = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return check === hash;
}

const IS_PROD = process.env.NODE_ENV === 'production' || !!(process.env.APP_URL && !process.env.APP_URL.includes('localhost'));

function staffCookieHeader(token) {
  const base = `staff_portal_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;
  return IS_PROD ? `${base}; Secure` : base;
}

// ─── Middleware: require staff auth ───────────────────────────────────────────

function requireStaffAuth(req, res, next) {
  const header = req.headers['authorization'];
  const cookieToken = req.cookies && req.cookies['staff_portal_token'];
  const token = (header && header.startsWith('Bearer ') ? header.slice(7) : null) || cookieToken;
  if (!token) return res.status(401).json({ success: false, message: 'Not authenticated' });

  const payload = verifyStaffJWT(token);
  if (!payload) return res.status(401).json({ success: false, message: 'Session expired' });

  req.staffId = payload.staff_id;
  req.staffOperatorId = payload.operator_id;
  next();
}

// ─── GET /api/staff-portal/invite-info ───────────────────────────────────────
// Returns staff name for pre-filling invite form (no auth required — token is the auth)

router.get('/invite-info', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ success: false });
  try {
    const result = await pool.query(
      `SELECT s.name, s.email, s.invite_expires_at, s.invite_accepted_at,
              op.business_name
       FROM staff_members s
       LEFT JOIN operator_profiles op ON op.operator_id = s.operator_id
       WHERE s.invite_token = $1`,
      [token]
    );
    const staff = result.rows[0];
    if (!staff) return res.status(404).json({ success: false, message: 'Invalid invite' });
    if (staff.invite_accepted_at) return res.json({ success: false, message: 'Invite already used' });
    if (staff.invite_expires_at && new Date(staff.invite_expires_at) < new Date()) {
      return res.json({ success: false, message: 'Invite expired' });
    }
    res.json({ success: true, name: staff.name, business_name: staff.business_name || null });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ─── POST /api/staff-portal/accept-invite ─────────────────────────────────────
// Staff clicks invite link → validates token → sets password → returns session

router.post('/accept-invite', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 6) {
    return res.status(400).json({ success: false, message: 'Token and password (min 6 chars) required' });
  }
  try {
    const result = await pool.query(
      `SELECT id, operator_id, name, email, invite_expires_at, invite_accepted_at
       FROM staff_members
       WHERE invite_token = $1`,
      [token]
    );
    const staff = result.rows[0];
    if (!staff) return res.status(404).json({ success: false, message: 'Invalid invite link' });
    if (staff.invite_accepted_at) return res.status(400).json({ success: false, message: 'Invite already used. Please contact your employer.' });
    if (staff.invite_expires_at && new Date(staff.invite_expires_at) < new Date()) {
      return res.status(400).json({ success: false, message: 'Invite link has expired. Ask your employer to resend.' });
    }

    const passwordHash = hashPassword(password);
    await pool.query(
      `UPDATE staff_members
       SET portal_password_hash = $1,
           invite_accepted_at = NOW(),
           portal_last_login = NOW()
       WHERE id = $2`,
      [passwordHash, staff.id]
    );

    const jwtToken = createStaffJWT({
      staff_id: staff.id,
      operator_id: staff.operator_id,
      name: staff.name,
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    });

    res.setHeader('Set-Cookie', staffCookieHeader(jwtToken));
    res.json({ success: true, staff: { id: staff.id, name: staff.name, email: staff.email }, token: jwtToken });
  } catch (err) {
    console.error('[StaffPortal] accept-invite error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/staff-portal/login ─────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required' });
  }
  try {
    const result = await pool.query(
      `SELECT id, operator_id, name, email, portal_password_hash, is_active
       FROM staff_members
       WHERE LOWER(email) = LOWER($1)`,
      [email.trim()]
    );
    const staff = result.rows[0];
    if (!staff || !staff.portal_password_hash) {
      // WHY: Operators who land here by mistake get a confusing "invalid password" error.
      // Check if this email belongs to an operator and guide them to the right portal.
      const opCheck = await pool.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [email.trim()]);
      if (opCheck.rows.length > 0) {
        return res.status(401).json({ success: false, message: 'This is the staff portal. As a business operator, please log in at /login and access /pays from there.' });
      }
      return res.status(401).json({ success: false, message: 'Invalid email or password. Have you accepted your invite?' });
    }
    if (!staff.is_active) {
      return res.status(403).json({ success: false, message: 'Your account has been deactivated. Contact your employer.' });
    }
    if (!verifyPassword(password, staff.portal_password_hash)) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    await pool.query(`UPDATE staff_members SET portal_last_login = NOW() WHERE id = $1`, [staff.id]);

    const token = createStaffJWT({
      staff_id: staff.id,
      operator_id: staff.operator_id,
      name: staff.name,
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    });

    res.setHeader('Set-Cookie', staffCookieHeader(token));
    res.json({ success: true, staff: { id: staff.id, name: staff.name, email: staff.email }, token });
  } catch (err) {
    console.error('[StaffPortal] login error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/staff-portal/forgot-password ──────────────────────────────────
// Staff forgot password — look up by email, send magic link via Resend.
// rate-limit: 1 per email per 24h via notification_log.
// Token version increment revokes all previously issued magic links immediately.

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Valid email required' });
  }

  try {
    // Find active staff by email — include token_version for revocation
    const staffResult = await pool.query(
      `SELECT sm.id, sm.name, sm.email, sm.operator_id, sm.portal_password_hash, sm.token_version
       FROM staff_members sm
       WHERE LOWER(sm.email) = LOWER($1) AND sm.is_active = true`,
      [email.trim()]
    );
    const staff = staffResult.rows[0];

    // Always return success to prevent email enumeration — even if not found
    if (!staff || !staff.portal_password_hash) {
      return res.json({ success: true, message: 'If that email is in our system, a login link has been sent.' });
    }

    // Check: already sent magic link in last 24h?
    const recentCheck = await pool.query(
      `SELECT id FROM notification_log
       WHERE operator_id=$1 AND recipient_type='staff' AND recipient_id=$2
         AND notification_type='magic_link' AND sent_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [staff.operator_id, staff.id]
    );
    if (recentCheck.rows.length > 0 && !req.body.force) {
      return res.json({ success: true, message: 'A login link was already sent in the last 24 hours. Check your inbox or wait before requesting another.' });
    }

    // WHY: Increment token_version to revoke ALL previously issued magic links.
    // This prevents access via old forwarded/forwards emails.
    const currentVersion = staff.token_version || 1;
    const newVersion = currentVersion + 1;
    await pool.query(
      `UPDATE staff_members SET token_version = $1 WHERE id = $2`,
      [newVersion, staff.id]
    );

    // WHY: Keep the legacy staff_magic_links DB row for backward compatibility
    // with any code still using the ?magic= format.
    const legacyToken = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO staff_magic_links (staff_id, operator_id, token, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [staff.id, staff.operator_id, legacyToken, expiresAt]
    );

    // Log notification
    await pool.query(
      `INSERT INTO notification_log (operator_id, recipient_type, recipient_id, notification_type, metadata)
       VALUES ($1, 'staff', $2, 'magic_link', $3)`,
      [staff.operator_id, staff.id, JSON.stringify({ token_version: newVersion, reason: 'forgot_password' })]
    );

    // Use JWT-based magic link (the primary format going forward)
    const { generateStaffMagicLink } = require('../db/staff-magic-link');
    const magicUrl = generateStaffMagicLink(staff.id, '/pays/staff', newVersion);

    // Get operator name for email subject
    const opResult = await pool.query(`SELECT name FROM users WHERE id=$1`, [staff.operator_id]);
    const opName = opResult.rows[0]?.name || 'Your employer';

    const { sendEmail } = require('../services/email');
    await sendEmail({
      to: staff.email,
      subject: `${staff.name} — your Hugo.pays login link`,
      text: `Hi ${staff.name},\n\n${opName} has sent you a login link for the Hugo.pays staff portal.\n\nClick here to access your portal: ${magicUrl}\n\nThis link works for 60 days. No password needed.\n\nHugo.pays`,
      html: `<p style="margin:0 0 16px;">Hi ${staff.name},</p>
<p style="margin:0 0 20px;">${opName} has sent you a login link for the Hugo.pays staff portal.</p>
<table cellpadding="0" cellspacing="0"><tr><td style="background:#f59e0b;border-radius:8px;">
  <a href="${magicUrl}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:700;color:#0f172a;text-decoration:none;">Open Staff Portal →</a>
</td></tr></table>
<p style="margin:20px 0 0;font-size:13px;color:#94a3b8;">This link works for 60 days. No password needed.</p>`,
      tag: 'staff_forgot_password',
    });

    res.json({ success: true, message: 'If that email is in our system, a login link has been sent.' });
  } catch (err) {
    console.error('[StaffPortal] forgot-password error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/staff-portal/verify-jwt-token?token=xxx ──────────────────────────
// Verifies a JWT magic link token (from staff-notifications emails).
// Sets the session cookie and returns staff data.
// Used by the staff portal HTML page on load.

router.get('/verify-jwt-token', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ success: false, message: 'Token required' });

  const { verifyStaffMagicLink } = require('../db/staff-magic-link');
  const decoded = verifyStaffMagicLink(token);
  if (!decoded) return res.status(401).json({ success: false, message: 'Token invalid or expired' });

  try {
    // WHY: Include token_version in the SELECT so we can compare it against the JWT payload.
    // If token_version has been incremented since this link was issued, reject the link.
    const staffResult = await pool.query(
      `SELECT id, operator_id, name, email, is_active, token_version FROM staff_members WHERE id = $1`,
      [decoded.staffId]
    );
    const staff = staffResult.rows[0];
    if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });
    if (!staff.is_active) return res.status(403).json({ success: false, message: 'Account deactivated' });

    // Token version revocation: if staff's token_version changed, the link is dead
    const dbVersion = staff.token_version || 1;
    if (decoded.tokenVersion !== dbVersion) {
      return res.status(401).json({ success: false, message: 'This link has been invalidated. Please request a new one.' });
    }

    // Create session JWT (same format as login)
    const sessionToken = createStaffJWT({
      staff_id: staff.id,
      operator_id: staff.operator_id,
      name: staff.name,
      exp: Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60,
    });

    const IS_PROD = process.env.NODE_ENV === 'production' || !!(process.env.APP_URL && !process.env.APP_URL.includes('localhost'));
    const cookieBase = `staff_portal_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 24 * 60 * 60}`;
    res.setHeader('Set-Cookie', IS_PROD ? `${cookieBase}; Secure` : cookieBase);

    const accept = req.headers['accept'] || '';
    if (accept.includes('application/json')) {
      res.json({ success: true, staff: { id: staff.id, name: staff.name, email: staff.email }, token: sessionToken });
    } else {
      res.redirect(decoded.dest || '/pays/staff');
    }
  } catch (err) {
    console.error('[StaffPortal] verify-jwt-token error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/staff-portal/logout ────────────────────────────────────────────

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `staff_portal_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ success: true });
});

// ─── POST /api/staff-portal/boss-preview/:staffId ─────────────────────────────
// Operator impersonates a staff member for testing/support — no password needed.
// Returns a short-lived staff JWT tagged with is_preview=true so the portal can
// show the exit-preview banner.
//
// Auth: operator session (propops_session or relio_session cookie) — NOT staff token.

router.post('/boss-preview/:staffId', async (req, res) => {
  // WHY: Previous implementation manually parsed cookies and used its own JWT validation.
  // This broke because verifySessionToken returns { sub, email } not { userId }.
  // Now uses the same cookie + auth pattern as all other operator-authenticated endpoints.
  const { verifySessionToken } = require('../services/auth');
  const cookieToken = req.cookies && (req.cookies['propops_session'] || req.cookies['relio_session']);
  if (!cookieToken) return res.status(401).json({ success: false, message: 'Not authenticated as operator' });
  const session = verifySessionToken(cookieToken);
  if (!session || !session.sub) return res.status(401).json({ success: false, message: 'Invalid operator session' });
  const operatorId = session.sub;

  const staffId = parseInt(req.params.staffId);
  if (!staffId) return res.status(400).json({ success: false, message: 'Invalid staff ID' });

  try {
    // Verify the staff member belongs to this operator
    const result = await pool.query(
      `SELECT id, operator_id, name, email, role, is_active FROM staff_members WHERE id = $1 AND operator_id = $2`,
      [staffId, operatorId]
    );
    const staff = result.rows[0];
    if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found' });

    // Short-lived preview token: 2 hours, tagged is_preview=true
    const token = createStaffJWT({
      staff_id: staff.id,
      operator_id: staff.operator_id,
      name: staff.name,
      is_preview: true,
      exp: Math.floor(Date.now() / 1000) + 2 * 60 * 60,
    });

    res.json({ success: true, token, staff: { id: staff.id, name: staff.name } });
  } catch (err) {
    console.error('[StaffPortal] boss-preview error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/staff-portal/me ──────────────────────────────────────────────────

router.get('/me', requireStaffAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.name, s.email, s.phone, s.role, s.hourly_rate, s.is_active,
              op.trade_type, op.business_customization, op.business_name
       FROM staff_members s
       LEFT JOIN operator_profiles op ON op.operator_id = s.operator_id
       WHERE s.id = $1 AND s.operator_id = $2`,
      [req.staffId, req.staffOperatorId]
    );
    const staff = result.rows[0];
    if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found' });
    res.json({ success: true, staff });
  } catch (err) {
    console.error('[StaffPortal] /me error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/staff-portal/reminder-pref ─────────────────────────────────────
// Returns this staff member's current reminder preference

router.get('/reminder-pref', requireStaffAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT reminder_hours_before FROM staff_members WHERE id = $1`,
      [req.staffId]
    );
    res.json({ success: true, reminder_hours_before: result.rows[0]?.reminder_hours_before ?? null });
  } catch (err) {
    console.error('[StaffPortal] reminder-pref GET error:', err.message);
    res.status(500).json({ success: false });
  }
});

// ─── POST /api/staff-portal/reminder-pref ────────────────────────────────────
// Staff sets their shift reminder window.
// Body: { reminder_hours_before: 2|14|24|0|null }
//   null  = disable reminders
//   0     = morning-of (7am AEST on shift day)
//   2–72  = N hours before shift start

router.post('/reminder-pref', requireStaffAuth, async (req, res) => {
  const { reminder_hours_before } = req.body;

  // Accept null (disable) or a non-negative integer ≤ 72
  if (reminder_hours_before !== null && reminder_hours_before !== undefined) {
    const v = parseInt(reminder_hours_before, 10);
    if (isNaN(v) || v < 0 || v > 72) {
      return res.status(400).json({ success: false, message: 'reminder_hours_before must be null or an integer 0–72' });
    }
  }

  const value = (reminder_hours_before === null || reminder_hours_before === undefined)
    ? null
    : parseInt(reminder_hours_before, 10);

  try {
    await pool.query(
      `UPDATE staff_members SET reminder_hours_before = $1 WHERE id = $2`,
      [value, req.staffId]
    );
    res.json({ success: true, reminder_hours_before: value });
  } catch (err) {
    console.error('[StaffPortal] reminder-pref POST error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/staff-portal/roster ─────────────────────────────────────────────
// Returns this staff member's upcoming + past shifts

router.get('/roster', requireStaffAuth, async (req, res) => {
  const { start_date, end_date, view } = req.query;
  // Default: next 30 days forward + last 14 days past
  const defaultStart = start_date || new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const defaultEnd = end_date || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  try {
    const result = await pool.query(
      `SELECT r.*,
              ce_in.occurred_at  AS clocked_in_at,
              ce_in.latitude     AS clock_in_lat,
              ce_in.longitude    AS clock_in_lng,
              ce_out.occurred_at AS clocked_out_at
       FROM roster_entries r
       LEFT JOIN LATERAL (
         SELECT occurred_at, latitude, longitude
         FROM staff_clock_events
         WHERE staff_id = $1 AND roster_entry_id = r.id AND event_type = 'clock_in'
         ORDER BY occurred_at DESC LIMIT 1
       ) ce_in ON TRUE
       LEFT JOIN LATERAL (
         SELECT occurred_at
         FROM staff_clock_events
         WHERE staff_id = $1 AND roster_entry_id = r.id AND event_type = 'clock_out'
         ORDER BY occurred_at DESC LIMIT 1
       ) ce_out ON TRUE
       WHERE r.staff_id = $1
         AND r.scheduled_date BETWEEN $2 AND $3
       ORDER BY r.scheduled_date ASC, r.start_time ASC`,
      [req.staffId, defaultStart, defaultEnd]
    );
    res.json({ success: true, roster: result.rows });
  } catch (err) {
    console.error('[StaffPortal] roster error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load roster' });
  }
});

// ─── GET /api/staff-portal/next-shift ─────────────────────────────────────────

router.get('/next-shift', requireStaffAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*
       FROM roster_entries r
       WHERE r.staff_id = $1
         AND r.scheduled_date >= CURRENT_DATE
         AND r.status NOT IN ('cancelled')
       ORDER BY r.scheduled_date ASC, r.start_time ASC
       LIMIT 1`,
      [req.staffId]
    );
    res.json({ success: true, shift: result.rows[0] || null });
  } catch (err) {
    console.error('[StaffPortal] next-shift error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/staff-portal/clock ─────────────────────────────────────────────
// event_type: 'clock_in' | 'clock_out'

router.post('/clock', requireStaffAuth, async (req, res) => {
  const { event_type, latitude, longitude, accuracy_meters, roster_entry_id, notes } = req.body;
  if (!event_type || !['clock_in', 'clock_out'].includes(event_type)) {
    return res.status(400).json({ success: false, message: 'event_type must be clock_in or clock_out' });
  }

  try {
    // If roster_entry_id provided, verify it belongs to this staff member
    if (roster_entry_id) {
      const check = await pool.query(
        `SELECT id FROM roster_entries WHERE id = $1 AND staff_id = $2`,
        [roster_entry_id, req.staffId]
      );
      if (!check.rows[0]) {
        return res.status(400).json({ success: false, message: 'Invalid roster entry' });
      }
    }

    // Check geofence if operator has one configured and GPS is provided
    let geofenceOk = null;
    if (latitude && longitude && roster_entry_id) {
      try {
        const profileResult = await pool.query(
          `SELECT op.base_lat, op.base_lng, op.clockin_geofence_radius_m,
                  re.job_address
           FROM operator_profiles op
           JOIN roster_entries re ON re.operator_id = op.user_id
           WHERE op.user_id = $1 AND re.id = $2`,
          [req.staffOperatorId, roster_entry_id]
        );
        const profile = profileResult.rows[0];
        if (profile?.base_lat && profile?.base_lng && profile?.clockin_geofence_radius_m) {
          const distM = haversineMeters(
            parseFloat(latitude), parseFloat(longitude),
            parseFloat(profile.base_lat), parseFloat(profile.base_lng)
          );
          geofenceOk = distM <= (profile.clockin_geofence_radius_m || 500);
        }
      } catch (_) { /* geofence check is non-blocking */ }
    }

    const result = await pool.query(
      `INSERT INTO staff_clock_events
         (operator_id, staff_id, roster_entry_id, event_type, latitude, longitude, accuracy_meters, geofence_ok, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        req.staffOperatorId, req.staffId,
        roster_entry_id || null,
        event_type,
        latitude ? parseFloat(latitude) : null,
        longitude ? parseFloat(longitude) : null,
        accuracy_meters ? parseFloat(accuracy_meters) : null,
        geofenceOk,
        notes || null,
      ]
    );

    res.json({ success: true, event: result.rows[0], geofence_ok: geofenceOk });
  } catch (err) {
    console.error('[StaffPortal] clock error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to record clock event' });
  }
});

// ─── GET /api/staff-portal/clock-history ──────────────────────────────────────

router.get('/clock-history', requireStaffAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ce.*, re.job_title, re.job_address, re.scheduled_date
       FROM staff_clock_events ce
       LEFT JOIN roster_entries re ON ce.roster_entry_id = re.id
       WHERE ce.staff_id = $1
       ORDER BY ce.occurred_at DESC
       LIMIT 50`,
      [req.staffId]
    );
    res.json({ success: true, events: result.rows });
  } catch (err) {
    console.error('[StaffPortal] clock-history error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/staff-portal/clock-status ───────────────────────────────────────
// Current clock state: are they clocked in right now?

router.get('/clock-status', requireStaffAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT event_type, occurred_at, roster_entry_id
       FROM staff_clock_events
       WHERE staff_id = $1
       ORDER BY occurred_at DESC
       LIMIT 1`,
      [req.staffId]
    );
    const last = result.rows[0];
    const isClockedIn = last?.event_type === 'clock_in';
    res.json({ success: true, clocked_in: isClockedIn, last_event: last || null });
  } catch (err) {
    console.error('[StaffPortal] clock-status error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/staff-portal/swap-requests ──────────────────────────────────────
// Staff's own swap requests

router.get('/swap-requests', requireStaffAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sw.*,
              re.job_title, re.scheduled_date, re.start_time, re.end_time,
              ts.name AS target_staff_name
       FROM staff_shift_swap_requests sw
       JOIN roster_entries re ON sw.roster_entry_id = re.id
       LEFT JOIN staff_members ts ON sw.target_staff_id = ts.id
       WHERE sw.requesting_staff_id = $1
       ORDER BY sw.created_at DESC
       LIMIT 30`,
      [req.staffId]
    );
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    console.error('[StaffPortal] swap-requests error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/staff-portal/swap-requests ─────────────────────────────────────

router.post('/swap-requests', requireStaffAuth, async (req, res) => {
  const { roster_entry_id, target_staff_id, reason } = req.body;
  if (!roster_entry_id) {
    return res.status(400).json({ success: false, message: 'roster_entry_id required' });
  }
  try {
    // Verify shift belongs to this staff member
    const shiftCheck = await pool.query(
      `SELECT id, scheduled_date, operator_id FROM roster_entries
       WHERE id = $1 AND staff_id = $2`,
      [roster_entry_id, req.staffId]
    );
    if (!shiftCheck.rows[0]) {
      return res.status(400).json({ success: false, message: 'Shift not found or not yours' });
    }
    if (shiftCheck.rows[0].scheduled_date < new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ success: false, message: 'Cannot swap a past shift' });
    }

    // If target_staff_id provided, verify they belong to same operator
    if (target_staff_id) {
      const targetCheck = await pool.query(
        `SELECT id FROM staff_members WHERE id = $1 AND operator_id = $2 AND is_active = true`,
        [target_staff_id, req.staffOperatorId]
      );
      if (!targetCheck.rows[0]) {
        return res.status(400).json({ success: false, message: 'Target staff member not found' });
      }
    }

    // Check for existing pending request on this shift
    const existing = await pool.query(
      `SELECT id FROM staff_shift_swap_requests
       WHERE roster_entry_id = $1 AND requesting_staff_id = $2 AND status = 'pending'`,
      [roster_entry_id, req.staffId]
    );
    if (existing.rows[0]) {
      return res.status(400).json({ success: false, message: 'Swap request already pending for this shift' });
    }

    const result = await pool.query(
      `INSERT INTO staff_shift_swap_requests
         (operator_id, requesting_staff_id, roster_entry_id, target_staff_id, reason)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.staffOperatorId, req.staffId, roster_entry_id, target_staff_id || null, reason || null]
    );
    res.json({ success: true, request: result.rows[0] });
  } catch (err) {
    console.error('[StaffPortal] create swap error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create swap request' });
  }
});

// ─── GET /api/staff-portal/available-swaps ────────────────────────────────────
// Shows open swap offers from OTHER staff that this staff member can accept
router.get('/available-swaps', requireStaffAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sw.id, sw.roster_entry_id, sw.requesting_staff_id, sw.reason, sw.created_at,
              rs.name AS requesting_name,
              re.job_title, re.scheduled_date, re.start_time, re.end_time, re.job_address
       FROM staff_shift_swap_requests sw
       JOIN staff_members rs ON sw.requesting_staff_id = rs.id
       JOIN roster_entries re ON sw.roster_entry_id = re.id
       WHERE sw.operator_id = $1
         AND sw.status = 'pending'
         AND sw.target_staff_id IS NULL
         AND sw.requesting_staff_id != $2
         AND re.scheduled_date >= CURRENT_DATE
       ORDER BY re.scheduled_date ASC, re.start_time ASC`,
      [req.staffOperatorId, req.staffId]
    );
    res.json({ success: true, swaps: result.rows });
  } catch (err) {
    console.error('[StaffPortal] available-swaps error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/staff-portal/swap-requests/:id/accept ─────────────────────────
// Staff B volunteers to take a swap — sets target_staff_id, status → accepted_pending_approval
router.post('/swap-requests/:id/accept', requireStaffAuth, async (req, res) => {
  const { id } = req.params;
  try {
    // Find the swap — must be pending with no target, from a different staff member
    const swapResult = await pool.query(
      `SELECT sw.*, re.scheduled_date
       FROM staff_shift_swap_requests sw
       JOIN roster_entries re ON sw.roster_entry_id = re.id
       WHERE sw.id = $1 AND sw.operator_id = $2 AND sw.status = 'pending'
         AND sw.target_staff_id IS NULL AND sw.requesting_staff_id != $3`,
      [id, req.staffOperatorId, req.staffId]
    );
    const swap = swapResult.rows[0];
    if (!swap) {
      return res.status(404).json({ success: false, message: 'Swap not found or already accepted' });
    }
    if (swap.scheduled_date < new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ success: false, message: 'Cannot accept a swap for a past shift' });
    }

    await pool.query(
      `UPDATE staff_shift_swap_requests
       SET target_staff_id = $1, status = 'accepted', updated_at = NOW()
       WHERE id = $2`,
      [req.staffId, id]
    );

    // Fire-and-forget: notify the requesting staff that someone volunteered to take their shift
    pool.query(
      `SELECT s.id, s.name, s.email, op.business_name
       FROM staff_members s
       LEFT JOIN operator_profiles op ON op.operator_id = s.operator_id
       WHERE s.id = $1 AND s.operator_id = $2`,
      [swap.requesting_staff_id, req.staffOperatorId]
    ).then(async reqRes => {
      const reqStaff = reqRes.rows[0];
      if (!reqStaff || !reqStaff.email) return;
      // Target staff (me) for the notification
      const tgtRes = await pool.query(`SELECT id, name, email FROM staff_members WHERE id=$1`, [req.staffId]);
      const tgtStaff = tgtRes.rows[0];
      if (!tgtStaff) return;
      // Roster entry
      const entryRes = await pool.query(`SELECT * FROM roster_entries WHERE id=$1`, [swap.roster_entry_id]);
      const entry = entryRes.rows[0];
      if (!entry) return;
      staffNotify.notifySwapVolunteerAccepted({
        operatorId: req.staffOperatorId,
        requestingStaff: reqStaff,
        targetStaff: tgtStaff,
        bizName: reqStaff.business_name || '',
        entry,
      }).catch(() => {});
    }).catch(() => {});

    res.json({ success: true, message: 'Swap accepted — waiting for boss approval' });
  } catch (err) {
    console.error('[StaffPortal] accept-swap error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to accept swap' });
  }
});

// ─── GET /api/staff-portal/colleagues ─────────────────────────────────────────
// Other active staff on same operator (for swap target picker)

router.get('/colleagues', requireStaffAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, role FROM staff_members
       WHERE operator_id = $1 AND is_active = true AND id != $2
       ORDER BY name ASC`,
      [req.staffOperatorId, req.staffId]
    );
    res.json({ success: true, colleagues: result.rows });
  } catch (err) {
    console.error('[StaffPortal] colleagues error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/staff-portal/notifications ─────────────────────────────────────

router.get('/notifications', requireStaffAuth, async (req, res) => {
  try {
    // Notifications = recent swap approvals/declines + new shifts in last 7 days
    const [swapUpdates, newShifts] = await Promise.all([
      pool.query(
        `SELECT sw.status, sw.operator_note, sw.reviewed_at,
                re.job_title, re.scheduled_date
         FROM staff_shift_swap_requests sw
         JOIN roster_entries re ON sw.roster_entry_id = re.id
         WHERE sw.requesting_staff_id = $1
           AND sw.status != 'pending'
           AND sw.reviewed_at >= NOW() - INTERVAL '7 days'
         ORDER BY sw.reviewed_at DESC`,
        [req.staffId]
      ),
      pool.query(
        `SELECT id, job_title, scheduled_date, start_time
         FROM roster_entries
         WHERE staff_id = $1
           AND created_at >= NOW() - INTERVAL '7 days'
           AND status != 'cancelled'
         ORDER BY created_at DESC`,
        [req.staffId]
      ),
    ]);

    // WHY: node-pg returns DATE columns as JS Date objects. Embedding a Date in a
    // template literal produces "Sun May 17 2026 00:00:00 GMT+0000 (Coordinated Universal Time)".
    // Format dates as readable AEST-friendly strings before building messages.
    function fmtDate(d) {
      if (!d) return '—';
      const dt = d instanceof Date ? d : new Date(d);
      const day = dt.getDate();
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      return `${weekdays[dt.getDay()]} ${day} ${months[dt.getMonth()]}`;
    }
    function fmtTime(t) {
      if (!t) return '';
      const parts = String(t).split(':');
      const h = parseInt(parts[0], 10);
      const m = parts[1] || '00';
      const ampm = h >= 12 ? 'pm' : 'am';
      return `${h % 12 || 12}:${m.slice(0,2)}${ampm}`;
    }

    const notifications = [
      ...swapUpdates.rows.map(r => ({
        type: 'swap_' + r.status,
        message: `Swap request for "${r.job_title || 'shift'}" on ${fmtDate(r.scheduled_date)}: ${r.status}${r.operator_note ? ` — ${r.operator_note}` : ''}`,
        at: r.reviewed_at,
      })),
      ...newShifts.rows.map(r => ({
        type: 'new_shift',
        message: `New shift: "${r.job_title || 'Shift'}" on ${fmtDate(r.scheduled_date)}${r.start_time ? ` at ${fmtTime(r.start_time)}` : ''}`,
        at: r.created_at,
      })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));

    res.json({ success: true, notifications });
  } catch (err) {
    console.error('[StaffPortal] notifications error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/staff-portal/payslips ───────────────────────────────────────────
// Staff's pay run history — gross, PAYG, super, net, period dates

router.get('/payslips', requireStaffAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pe.*,
              s.name as staff_name, s.role, s.hourly_rate, s.tfn_status,
              s.super_fund_name, s.super_usi, s.super_member_number
       FROM payroll_entries pe
       JOIN staff_members s ON pe.staff_id = s.id
       WHERE pe.staff_id = $1 AND pe.operator_id = $2
       ORDER BY pe.period_start DESC
       LIMIT 52`,
      [req.staffId, req.staffOperatorId]
    );
    res.json({ success: true, payslips: result.rows });
  } catch (err) {
    console.error('[StaffPortal] payslips error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load pay slips' });
  }
});

// ─── GET /api/staff-portal/super-history ──────────────────────────────────────
// Running super contributions: YTD, all-time, quarterly breakdown + fund info

router.get('/super-history', requireStaffAuth, async (req, res) => {
  try {
    const [history, staff] = await Promise.all([
      pool.query(
        `SELECT
           period_start, period_end,
           amount as gross_pay,
           super_amount,
           status, paid_at,
           -- ATO super quarters: Q1=Jul-Sep, Q2=Oct-Dec, Q3=Jan-Mar, Q4=Apr-Jun
           CASE
             WHEN EXTRACT(MONTH FROM period_start) BETWEEN 7 AND 9  THEN 'Q1 (Jul–Sep)'
             WHEN EXTRACT(MONTH FROM period_start) BETWEEN 10 AND 12 THEN 'Q2 (Oct–Dec)'
             WHEN EXTRACT(MONTH FROM period_start) BETWEEN 1 AND 3  THEN 'Q3 (Jan–Mar)'
             ELSE 'Q4 (Apr–Jun)'
           END as ato_quarter,
           EXTRACT(YEAR FROM period_start) as fin_year_start
         FROM payroll_entries
         WHERE staff_id = $1 AND operator_id = $2
           AND super_amount IS NOT NULL
         ORDER BY period_start DESC`,
        [req.staffId, req.staffOperatorId]
      ),
      pool.query(
        `SELECT super_fund_name, super_usi, super_member_number
         FROM staff_members WHERE id = $1`,
        [req.staffId]
      ),
    ]);

    // YTD: current financial year (Jul 1 to Jun 30)
    const now = new Date();
    const fyStart = now.getMonth() >= 6
      ? new Date(now.getFullYear(), 6, 1)
      : new Date(now.getFullYear() - 1, 6, 1);
    const fyLabel = `FY${fyStart.getFullYear()}-${(fyStart.getFullYear() + 1).toString().slice(2)}`;

    let ytdSuper = 0;
    let allTimeSuper = 0;
    const quarterMap = {};

    history.rows.forEach(row => {
      const rowDate = new Date(row.period_start);
      const amount = parseFloat(row.super_amount || 0);
      allTimeSuper += amount;
      if (rowDate >= fyStart) ytdSuper += amount;

      const key = `${row.ato_quarter} ${row.fin_year_start}`;
      if (!quarterMap[key]) quarterMap[key] = { quarter: row.ato_quarter, year: row.fin_year_start, total: 0, paid: 0, pending: 0 };
      quarterMap[key].total += amount;
      if (row.status === 'paid') quarterMap[key].paid += amount;
      else quarterMap[key].pending += amount;
    });

    const quarters = Object.values(quarterMap).sort((a, b) => {
      if (b.year !== a.year) return b.year - a.year;
      const order = { 'Q1 (Jul–Sep)': 1, 'Q2 (Oct–Dec)': 2, 'Q3 (Jan–Mar)': 3, 'Q4 (Apr–Jun)': 4 };
      return order[b.quarter] - order[a.quarter];
    });

    res.json({
      success: true,
      ytd_super: Math.round(ytdSuper * 100) / 100,
      all_time_super: Math.round(allTimeSuper * 100) / 100,
      fy_label: fyLabel,
      fund: staff.rows[0] || {},
      quarters,
      history: history.rows,
    });
  } catch (err) {
    console.error('[StaffPortal] super-history error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load super history' });
  }
});

// ─── GET /api/staff-portal/tax-summary ────────────────────────────────────────
// YTD PAYG withheld, tax bracket info, EOFY summary

router.get('/tax-summary', requireStaffAuth, async (req, res) => {
  try {
    const [payroll, staffResult] = await Promise.all([
      pool.query(
        `SELECT period_start, period_end, amount as gross_pay, tax_withheld, super_amount, net_pay, hours_worked
         FROM payroll_entries
         WHERE staff_id = $1 AND operator_id = $2
         ORDER BY period_start DESC`,
        [req.staffId, req.staffOperatorId]
      ),
      pool.query(
        `SELECT hourly_rate, tfn_status FROM staff_members WHERE id = $1`,
        [req.staffId]
      ),
    ]);

    // Current financial year
    const now = new Date();
    const fyStart = now.getMonth() >= 6
      ? new Date(now.getFullYear(), 6, 1)
      : new Date(now.getFullYear() - 1, 6, 1);
    const fyLabel = `FY${fyStart.getFullYear()}-${(fyStart.getFullYear() + 1).toString().slice(2)}`;

    let ytdGross = 0, ytdTax = 0, ytdSuper = 0, ytdNet = 0;
    let allGross = 0, allTax = 0;

    payroll.rows.forEach(row => {
      const rowDate = new Date(row.period_start);
      const gross = parseFloat(row.gross_pay || 0);
      const tax   = parseFloat(row.tax_withheld || 0);
      const spr   = parseFloat(row.super_amount || 0);
      const net   = parseFloat(row.net_pay || 0);
      allGross += gross; allTax += tax;
      if (rowDate >= fyStart) { ytdGross += gross; ytdTax += tax; ytdSuper += spr; ytdNet += net; }
    });

    // Determine tax bracket from annualised YTD
    const elapsedWeeks = Math.max(1, Math.ceil((now - fyStart) / (7 * 86400000)));
    const annualised = ytdGross * (52 / elapsedWeeks);
    let bracket = '', marginalRate = 0;
    if (annualised <= 18200)       { bracket = '$0 – $18,200 (Nil)';                 marginalRate = 0; }
    else if (annualised <= 45000)  { bracket = '$18,201 – $45,000 (19%)';            marginalRate = 19; }
    else if (annualised <= 120000) { bracket = '$45,001 – $120,000 (32.5%)';         marginalRate = 32.5; }
    else if (annualised <= 180000) { bracket = '$120,001 – $180,000 (37%)';          marginalRate = 37; }
    else                           { bracket = '$180,001+ (45%)';                    marginalRate = 45; }

    res.json({
      success: true,
      fy_label: fyLabel,
      fy_start: fyStart.toISOString().slice(0, 10),
      ytd: {
        gross: Math.round(ytdGross * 100) / 100,
        tax_withheld: Math.round(ytdTax * 100) / 100,
        super: Math.round(ytdSuper * 100) / 100,
        net: Math.round(ytdNet * 100) / 100,
      },
      all_time: {
        gross: Math.round(allGross * 100) / 100,
        tax_withheld: Math.round(allTax * 100) / 100,
      },
      tax_bracket: bracket,
      marginal_rate: marginalRate,
      annualised_income: Math.round(annualised * 100) / 100,
      tfn_status: staffResult.rows[0]?.tfn_status || 'provided',
    });
  } catch (err) {
    console.error('[StaffPortal] tax-summary error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load tax summary' });
  }
});

// ─── GET /api/staff-portal/leave ──────────────────────────────────────────────
// Leave balances (NES accruals) + leave request history

router.get('/leave', requireStaffAuth, async (req, res) => {
  try {
    const [staffResult, leaveRequests, payrollResult] = await Promise.all([
      pool.query(`SELECT created_at, hourly_rate FROM staff_members WHERE id = $1`, [req.staffId]),
      pool.query(
        `SELECT * FROM staff_leave_requests WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [req.staffId]
      ),
      pool.query(
        `SELECT SUM(hours_worked) as total_hours_worked,
                MIN(period_start) as earliest_pay_date
         FROM payroll_entries WHERE staff_id = $1 AND operator_id = $2`,
        [req.staffId, req.staffOperatorId]
      ),
    ]);

    const staff = staffResult.rows[0];
    const startDate = staff?.created_at ? new Date(staff.created_at) : new Date();
    const now = new Date();
    const yearsEmployed = (now - startDate) / (365.25 * 86400000);

    // NES (National Employment Standards) leave accruals:
    // Annual leave: 4 weeks per year = 152 hours per year for 38hr workers
    // Sick/personal leave: 10 days per year = 76 hours for 38hr workers
    const ANNUAL_ACCRUAL_RATE_PER_YEAR = 152; // hours
    const SICK_ACCRUAL_RATE_PER_YEAR = 76;    // hours

    // Leave taken (sum approved requests)
    let annualTaken = 0, sickTaken = 0, personalTaken = 0;
    leaveRequests.rows.filter(r => r.status === 'approved').forEach(r => {
      const hrs = parseFloat(r.days_requested || 0) * 7.6; // 7.6hr/day
      if (r.leave_type === 'annual')   annualTaken += hrs;
      if (r.leave_type === 'sick')     sickTaken += hrs;
      if (r.leave_type === 'personal') personalTaken += hrs;
    });

    const annualAccrued   = Math.round(yearsEmployed * ANNUAL_ACCRUAL_RATE_PER_YEAR * 100) / 100;
    const sickAccrued     = Math.round(yearsEmployed * SICK_ACCRUAL_RATE_PER_YEAR * 100) / 100;
    const annualBalance   = Math.max(0, Math.round((annualAccrued - annualTaken) * 100) / 100);
    const sickBalance     = Math.max(0, Math.round((sickAccrued - sickTaken) * 100) / 100);
    const personalBalance = Math.max(0, Math.round((sickAccrued - personalTaken) * 100) / 100); // personal shares pool with sick (NES)

    res.json({
      success: true,
      balances: {
        annual: {
          accrued_hours: annualAccrued,
          taken_hours: annualTaken,
          balance_hours: annualBalance,
          balance_days: Math.round(annualBalance / 7.6 * 10) / 10,
        },
        sick: {
          accrued_hours: sickAccrued,
          taken_hours: sickTaken,
          balance_hours: sickBalance,
          balance_days: Math.round(sickBalance / 7.6 * 10) / 10,
        },
        personal: {
          accrued_hours: sickAccrued,
          taken_hours: personalTaken,
          balance_hours: personalBalance,
          balance_days: Math.round(personalBalance / 7.6 * 10) / 10,
        },
      },
      years_employed: Math.round(yearsEmployed * 10) / 10,
      requests: leaveRequests.rows,
    });
  } catch (err) {
    console.error('[StaffPortal] leave error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load leave balances' });
  }
});

// ─── POST /api/staff-portal/leave ─────────────────────────────────────────────
// Submit a leave request

router.post('/leave', requireStaffAuth, async (req, res) => {
  const { leave_type, start_date, end_date, reason } = req.body;
  const VALID_TYPES = ['annual', 'sick', 'personal'];
  if (!leave_type || !VALID_TYPES.includes(leave_type)) {
    return res.status(400).json({ success: false, message: 'leave_type must be annual, sick, or personal' });
  }
  if (!start_date || !end_date) {
    return res.status(400).json({ success: false, message: 'start_date and end_date required' });
  }
  if (start_date > end_date) {
    return res.status(400).json({ success: false, message: 'start_date must be before end_date' });
  }

  // Calculate business days (Mon–Fri) between dates
  const start = new Date(start_date + 'T12:00:00');
  const end   = new Date(end_date   + 'T12:00:00');
  let days = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) days++;
    cur.setDate(cur.getDate() + 1);
  }
  if (days < 0.5) days = 0.5; // minimum half day

  try {
    const result = await pool.query(
      `INSERT INTO staff_leave_requests
         (operator_id, staff_id, leave_type, start_date, end_date, days_requested, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.staffOperatorId, req.staffId, leave_type, start_date, end_date, days, reason || null]
    );
    res.json({ success: true, request: result.rows[0], days_requested: days });
  } catch (err) {
    console.error('[StaffPortal] create leave request error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to submit leave request' });
  }
});

// ─── GET /api/staff-portal/onboarding ─────────────────────────────────────────
// Fetch staff onboarding status + stored data

router.get('/onboarding', requireStaffAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT so.*
       FROM staff_onboarding so
       WHERE so.staff_id = $1 AND so.operator_id = $2`,
      [req.staffId, req.staffOperatorId]
    );
    res.json({ success: true, onboarding: result.rows[0] || null });
  } catch (err) {
    console.error('[StaffPortal] onboarding fetch error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/staff-portal/onboarding/tfn ────────────────────────────────────

router.post('/onboarding/tfn', requireStaffAuth, async (req, res) => {
  const { tfn, is_resident, claim_tax_free } = req.body;
  if (!tfn || !tfn.replace(/\s/g, '').match(/^\d{8,9}$/)) {
    return res.status(400).json({ success: false, message: 'Valid TFN (8-9 digits) required' });
  }
  try {
    await pool.query(
      `INSERT INTO staff_onboarding (operator_id, staff_id, tfn, tfn_declared_at, is_resident, claim_tax_free)
       VALUES ($1, $2, $3, NOW(), $4, $5)
       ON CONFLICT (staff_id) DO UPDATE
         SET tfn = EXCLUDED.tfn,
             tfn_declared_at = NOW(),
             is_resident = EXCLUDED.is_resident,
             claim_tax_free = EXCLUDED.claim_tax_free,
             updated_at = NOW()`,
      [req.staffOperatorId, req.staffId, tfn.replace(/\s/g, ''), is_resident !== false, claim_tax_free !== false]
    );
    // Mark TFN as provided on staff_members
    await pool.query(
      `UPDATE staff_members SET tfn_status = 'provided' WHERE id = $1`,
      [req.staffId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[StaffPortal] onboarding/tfn error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save TFN declaration' });
  }
});

// ─── POST /api/staff-portal/onboarding/super ──────────────────────────────────

router.post('/onboarding/super', requireStaffAuth, async (req, res) => {
  const { super_fund_name, super_usi, super_member_number } = req.body;
  if (!super_fund_name) {
    return res.status(400).json({ success: false, message: 'Super fund name required' });
  }
  try {
    await pool.query(
      `INSERT INTO staff_onboarding (operator_id, staff_id, super_fund_name, super_usi, super_member_number, super_submitted_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (staff_id) DO UPDATE
         SET super_fund_name = EXCLUDED.super_fund_name,
             super_usi = EXCLUDED.super_usi,
             super_member_number = EXCLUDED.super_member_number,
             super_submitted_at = NOW(),
             updated_at = NOW()`,
      [req.staffOperatorId, req.staffId, super_fund_name, super_usi || null, super_member_number || null]
    );
    // Sync to staff_members for quick access
    await pool.query(
      `UPDATE staff_members
       SET super_fund_name = $1, super_usi = $2, super_member_number = $3
       WHERE id = $4`,
      [super_fund_name, super_usi || null, super_member_number || null, req.staffId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[StaffPortal] onboarding/super error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save super details' });
  }
});

// ─── POST /api/staff-portal/onboarding/bank ───────────────────────────────────

router.post('/onboarding/bank', requireStaffAuth, async (req, res) => {
  const { bank_bsb, bank_account, bank_account_name } = req.body;
  if (!bank_bsb || !bank_account || !bank_account_name) {
    return res.status(400).json({ success: false, message: 'BSB, account number, and account name required' });
  }
  const cleanBsb = bank_bsb.replace(/[-\s]/g, '');
  if (!cleanBsb.match(/^\d{6}$/)) {
    return res.status(400).json({ success: false, message: 'BSB must be 6 digits (e.g. 063-000)' });
  }
  try {
    await pool.query(
      `INSERT INTO staff_onboarding (operator_id, staff_id, bank_bsb, bank_account, bank_account_name, bank_submitted_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (staff_id) DO UPDATE
         SET bank_bsb = EXCLUDED.bank_bsb,
             bank_account = EXCLUDED.bank_account,
             bank_account_name = EXCLUDED.bank_account_name,
             bank_submitted_at = NOW(),
             updated_at = NOW()`,
      [req.staffOperatorId, req.staffId, cleanBsb, bank_account.replace(/\s/g, ''), bank_account_name]
    );
    await pool.query(
      `UPDATE staff_members
       SET bank_bsb = $1, bank_account = $2, bank_account_name = $3
       WHERE id = $4`,
      [cleanBsb, bank_account.replace(/\s/g, ''), bank_account_name, req.staffId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[StaffPortal] onboarding/bank error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save bank details' });
  }
});

// ─── POST /api/staff-portal/onboarding/emergency ──────────────────────────────

router.post('/onboarding/emergency', requireStaffAuth, async (req, res) => {
  const { emergency_name, emergency_phone, emergency_relation } = req.body;
  if (!emergency_name || !emergency_phone) {
    return res.status(400).json({ success: false, message: 'Emergency contact name and phone required' });
  }
  try {
    await pool.query(
      `INSERT INTO staff_onboarding (operator_id, staff_id, emergency_name, emergency_phone, emergency_relation, emergency_submitted_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (staff_id) DO UPDATE
         SET emergency_name = EXCLUDED.emergency_name,
             emergency_phone = EXCLUDED.emergency_phone,
             emergency_relation = EXCLUDED.emergency_relation,
             emergency_submitted_at = NOW(),
             updated_at = NOW()`,
      [req.staffOperatorId, req.staffId, emergency_name, emergency_phone, emergency_relation || null]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[StaffPortal] onboarding/emergency error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save emergency contact' });
  }
});

// ─── POST /api/staff-portal/onboarding/complete ───────────────────────────────
// Mark onboarding complete once all 4 sections done

router.post('/onboarding/complete', requireStaffAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tfn_declared_at, super_submitted_at, bank_submitted_at, emergency_submitted_at
       FROM staff_onboarding WHERE staff_id = $1`,
      [req.staffId]
    );
    const ob = result.rows[0];
    if (!ob || !ob.tfn_declared_at || !ob.super_submitted_at || !ob.bank_submitted_at || !ob.emergency_submitted_at) {
      return res.status(400).json({ success: false, message: 'Please complete all 4 onboarding sections first' });
    }
    await pool.query(
      `UPDATE staff_onboarding SET completed_at = NOW(), updated_at = NOW() WHERE staff_id = $1`,
      [req.staffId]
    );
    await pool.query(
      `UPDATE staff_members SET onboarding_completed = true WHERE id = $1`,
      [req.staffId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[StaffPortal] onboarding/complete error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/staff-portal/week-view ──────────────────────────────────────────
// Returns the logged-in staff member's 7-day roster grid (Mon–Sun).
// Scoped to only THIS staff member — no other workers' data.
// Query param: week_start (YYYY-MM-DD Monday). Defaults to current Monday.

router.get('/week-view', requireStaffAuth, async (req, res) => {
  try {
    let weekStart;
    if (req.query.week_start) {
      weekStart = new Date(req.query.week_start + 'T00:00:00Z');
    } else {
      const now = new Date();
      const dow = now.getUTCDay();
      const daysToMon = dow === 0 ? -6 : 1 - dow;
      weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMon));
    }
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);

    const wStartStr = weekStart.toISOString().split('T')[0];
    const wEndStr   = weekEnd.toISOString().split('T')[0];

    const [staffResult, shiftResult, swapResult] = await Promise.all([
      pool.query(
        `SELECT id, name, hourly_rate, tfn_status FROM staff_members WHERE id = $1 AND operator_id = $2`,
        [req.staffId, req.staffOperatorId]
      ),
      pool.query(
        `SELECT * FROM roster_entries
         WHERE staff_id = $1 AND operator_id = $2
           AND scheduled_date >= $3 AND scheduled_date <= $4
           AND status != 'cancelled'
         ORDER BY scheduled_date ASC, start_time ASC`,
        [req.staffId, req.staffOperatorId, wStartStr, wEndStr]
      ),
      pool.query(
        `SELECT roster_entry_id FROM staff_shift_swap_requests
         WHERE requesting_staff_id = $1 AND status = 'pending'`,
        [req.staffId]
      ),
    ]);

    const staffMember = staffResult.rows[0];
    if (!staffMember) return res.status(404).json({ success: false, message: 'Staff member not found' });

    const swapOfferedIds = new Set(swapResult.rows.map(s => s.roster_entry_id));

    // Build 7-element shifts array indexed 0=Mon…6=Sun
    function dayIndex(dateStr) {
      const ds = String(dateStr).split('T')[0];
      const [sy, sm, sd] = wStartStr.split('-').map(Number);
      const [dy, dm, dd] = ds.split('-').map(Number);
      const startDays = new Date(Date.UTC(sy, sm - 1, sd)).getTime() / 86400000;
      const dateDays  = new Date(Date.UTC(dy, dm - 1, dd)).getTime() / 86400000;
      return Math.round(dateDays - startDays);
    }

    const shifts = Array.from({length: 7}, () => []);
    let totalHours = 0;

    shiftResult.rows.forEach(r => {
      let dateStr;
      if (r.scheduled_date instanceof Date) {
        dateStr = r.scheduled_date.getFullYear() + '-' + String(r.scheduled_date.getMonth()+1).padStart(2,'0') + '-' + String(r.scheduled_date.getDate()).padStart(2,'0');
      } else {
        dateStr = String(r.scheduled_date).split('T')[0];
      }
      const idx = dayIndex(dateStr);
      if (idx >= 0 && idx <= 6) {
        let hrs = 0;
        if (r.start_time && r.end_time) {
          const sp = String(r.start_time).split(':').map(Number);
          const ep = String(r.end_time).split(':').map(Number);
          let mins = ep[0] * 60 + (ep[1]||0) - sp[0] * 60 - (sp[1]||0);
          // WHY: If end < start (e.g. 09:00 to 05:00), assume 12h offset
          if (mins <= 0) mins += 12 * 60;
          hrs = mins / 60;
        }
        totalHours += hrs;
        shifts[idx].push({ ...r, swap_offered: swapOfferedIds.has(r.id) });
      }
    });

    res.json({
      success: true,
      week_start: wStartStr,
      week_end: wEndStr,
      staff: {
        id: staffMember.id,
        name: staffMember.name,
        hourly_rate: staffMember.hourly_rate,
        tfn_status: staffMember.tfn_status,
      },
      shifts,
      total_hours: Math.round(totalHours * 100) / 100,
    });
  } catch (err) {
    console.error('[StaffPortal] week-view error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load week view' });
  }
});

// ─── Haversine distance helper ────────────────────────────────────────────────

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── FEATURE 3 (staff side): Submit Leave Request ─────────────────────────────

router.post('/leave-request', requireStaffAuth, async (req, res) => {
  const { leave_type, start_date, end_date, days_requested, reason } = req.body;
  const validTypes = ['annual', 'sick', 'carers', 'personal'];
  if (!validTypes.includes(leave_type)) {
    return res.status(400).json({ success: false, message: 'leave_type must be annual, sick, carers, or personal' });
  }
  if (!start_date || !end_date) {
    return res.status(400).json({ success: false, message: 'start_date and end_date required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO staff_leave_requests (operator_id, staff_id, leave_type, start_date, end_date, days_requested, reason, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
      [req.staffOperatorId, req.staffId, leave_type, start_date, end_date, days_requested || null, reason || null]
    );
    res.json({ success: true, request: result.rows[0] });
  } catch (err) {
    console.error('[StaffPortal] leave-request error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to submit leave request' });
  }
});

// GET /api/staff-portal/my-leave — staff's own leave requests
router.get('/my-leave', requireStaffAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM staff_leave_requests WHERE staff_id=$1 ORDER BY created_at DESC`,
      [req.staffId]
    );
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    console.error('[StaffPortal] my-leave error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load leave requests' });
  }
});

// ─── FEATURE 4 (staff side): Propose Shift Swap ──────────────────────────────
// Staff proposes a swap for one of their own shifts (by roster_entry_id)

router.post('/propose-swap', requireStaffAuth, async (req, res) => {
  const { roster_entry_id, target_staff_id } = req.body;
  if (!roster_entry_id) return res.status(400).json({ success: false, message: 'roster_entry_id required' });
  try {
    // Confirm the shift belongs to this staff member
    const entryResult = await pool.query(
      `SELECT * FROM roster_entries WHERE id=$1 AND staff_id=$2 AND operator_id=$3 AND status != 'cancelled'`,
      [roster_entry_id, req.staffId, req.staffOperatorId]
    );
    const entry = entryResult.rows[0];
    if (!entry) return res.status(404).json({ success: false, message: 'Shift not found' });

    // Check for existing pending swap
    const existCheck = await pool.query(
      `SELECT id FROM staff_shift_swap_requests WHERE roster_entry_id=$1 AND status='pending'`,
      [roster_entry_id]
    );
    if (existCheck.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'Swap already pending for this shift' });
    }

    await pool.query(
      `INSERT INTO staff_shift_swap_requests (operator_id, roster_entry_id, requesting_staff_id, target_staff_id, status)
       VALUES ($1,$2,$3,$4,'pending')`,
      [req.staffOperatorId, roster_entry_id, req.staffId, target_staff_id || null]
    );
    res.json({ success: true, message: 'Swap request submitted — awaiting boss approval' });
  } catch (err) {
    console.error('[StaffPortal] propose-swap error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to submit swap request' });
  }
});

module.exports = router;
