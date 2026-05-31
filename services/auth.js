/**
 * Auth service — user accounts, JWT, magic links.
 *
 * Passwordless by default (magic link). Password auth supported optionally.
 */

const crypto = require('crypto');
const { Pool } = require('pg');

const MAGIC_LINK_EXPIRY_MINUTES = 15;
const JWT_SECRET = process.env.JWT_SECRET || 'REDACTED';
const APP_URL = process.env.APP_URL || 'https://propops.pro';

// ─── DB pool ──────────────────────────────────────────────────────────────────

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

// ─── Simple JWT (no external dep) ───────────────────────────────────────────

function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function createJWT(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.${sig}`;
}

function verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    if (sig !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
    // Check expiry
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── User helpers ──────────────────────────────────────────────────────────────

async function getUserByEmail(email) {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  return result.rows[0] || null;
}

async function getUserById(id) {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function createUser({ email, name, stripeSessionId, businessType }) {
  const pool = getPool();
  const normalizedEmail = email.toLowerCase();

  // Validate business_type — authoritative 26 trades + real_estate + legacy aliases
  const validBusinessTypes = [
    'real_estate',
    // Authoritative 26 trade categories
    'plumber', 'electrician', 'roofer', 'pest_control', 'glazier',
    'fencer', 'concreter', 'plasterer', 'tiler', 'carpenter',
    'builder', 'renderer', 'waterproofer', 'hvac', 'pool_tech',
    'handyman', 'antenna_installer', 'refrigeration', 'solar_installer',
    'painter', 'cleaner', 'landscaper',
    // Batch 5
    'appliance_repair', 'locksmith', 'removalist', 're_agent',
    // Small Business category
    'small_business',
    // Legacy aliases (accepted, normalized at simulation time)
    'lawn_care', 'pool_cleaning', 'carpet_cleaning', 'commercial_cleaner', 'bricklayer',
  ];
  const bt = (businessType && validBusinessTypes.includes(businessType)) ? businessType : 'real_estate';

  // Check if user exists (case-insensitive)
  const existing = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);

  if (existing.rows[0]) {
    // Update existing user — only set business_type if it hasn't been set (don't overwrite existing choice)
    const updated = await pool.query(
      `UPDATE users
       SET name = COALESCE($1, name),
           stripe_session_id = COALESCE($2, stripe_session_id),
           subscription_status = COALESCE(subscription_status, 'trial'),
           trial_start = COALESCE(trial_start, NOW()),
           trial_end = COALESCE(trial_end, NOW() + INTERVAL '14 days'),
           business_type = COALESCE(business_type, $4),
           updated_at = NOW()
       WHERE LOWER(email) = $3
       RETURNING *`,
      [name || null, stripeSessionId || null, normalizedEmail, bt]
    );
    return updated.rows[0];
  }

  // Insert new user with business_type
  const result = await pool.query(
    `INSERT INTO users (email, name, stripe_session_id, subscription_status, trial_start, trial_end, business_type)
     VALUES ($1, $2, $3, 'trial', NOW(), NOW() + INTERVAL '14 days', $4)
     RETURNING *`,
    [normalizedEmail, name || null, stripeSessionId || null, bt]
  );
  return result.rows[0];
}

async function markWelcomeEmailSent(userId) {
  const pool = getPool();
  await pool.query('UPDATE users SET welcome_email_sent = TRUE, updated_at = NOW() WHERE id = $1', [userId]);
}

async function updateLastLogin(userId) {
  const pool = getPool();
  await pool.query('UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1', [userId]);
}

// ─── Trial helpers ─────────────────────────────────────────────────────────────

function getDaysLeft(trialEnd) {
  const diff = new Date(trialEnd) - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

async function getUsersNeedingTrialReminder() {
  const pool = getPool();
  // Users whose trial ends in 3 days, haven't been reminded yet, still in trial
  const result = await pool.query(`
    SELECT * FROM users
    WHERE subscription_status = 'trial'
      AND trial_reminder_sent = FALSE
      AND trial_end BETWEEN NOW() AND NOW() + INTERVAL '3 days'
  `);
  return result.rows;
}

async function markTrialReminderSent(userId) {
  const pool = getPool();
  await pool.query('UPDATE users SET trial_reminder_sent = TRUE, updated_at = NOW() WHERE id = $1', [userId]);
}

async function getExpiredTrialUsers() {
  const pool = getPool();
  const result = await pool.query(`
    SELECT * FROM users
    WHERE subscription_status = 'trial'
      AND trial_end < NOW()
  `);
  return result.rows;
}

async function updateSubscriptionStatus(userId, status) {
  const pool = getPool();
  await pool.query(
    'UPDATE users SET subscription_status = $1, updated_at = NOW() WHERE id = $2',
    [status, userId]
  );
}

// ─── Password auth ───────────────────────────────────────────────���────────────

/**
 * Hash a password using PBKDF2 (Node built-in, no external dep).
 * Format: pbkdf2:100000:<hex-salt>:<hex-hash>
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `pbkdf2:100000:${salt}:${hash}`;
}

/**
 * Verify a plaintext password against a stored hash.
 * Supports the pbkdf2:... format produced by hashPassword().
 */
function checkPassword(password, stored) {
  try {
    const parts = stored.split(':');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const [, iterations, salt, expectedHash] = parts;
    const hash = crypto.pbkdf2Sync(password, salt, parseInt(iterations, 10), 64, 'sha512').toString('hex');
    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));
  } catch {
    return false;
  }
}

async function setUserPassword(userId, password) {
  const pool = getPool();
  const hashed = hashPassword(password);
  await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hashed, userId]);
}

async function loginWithPassword(email, password) {
  const user = await getUserByEmail(email.toLowerCase());
  if (!user || !user.password_hash) return null;
  if (!checkPassword(password, user.password_hash)) return null;
  await updateLastLogin(user.id);
  return user;
}

async function userHasPassword(userId) {
  const pool = getPool();
  const result = await pool.query('SELECT password_hash IS NOT NULL AS has_password FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.has_password === true;
}

// ─── Password reset ─────────────────────────────────────────────────────────

const PASSWORD_RESET_EXPIRY_MINUTES = 60; // 1 hour

/**
 * Create a password reset token for the given email.
 * Returns { rawToken } if user exists, null if not.
 * Raw token goes in the URL; hashed token is stored in DB.
 */
async function createPasswordResetToken(email) {
  const pool = getPool();
  const user = await getUserByEmail(email.toLowerCase());
  if (!user) return null;

  // Rate limit: max 1 reset per 5 minutes per user
  const recent = await pool.query(
    `SELECT id FROM password_reset_tokens
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '5 minutes'
     LIMIT 1`,
    [user.id]
  );
  if (recent.rows.length > 0) {
    // Silently succeed (don't reveal rate limit to prevent enumeration)
    return { rawToken: null, rateLimited: true };
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  // Convert Date to ISO string for consistent TIMESTAMPTZ handling
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_MINUTES * 60 * 1000).toISOString();

  // Invalidate any previous unused tokens for this user
  await pool.query(
    `UPDATE password_reset_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE`,
    [user.id]
  );

  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, tokenHash, expiresAt]
  );

  return { rawToken, userId: user.id };
}

/**
 * Verify a raw reset token and return the user_id if valid.
 * Marks the token as used immediately (single-use).
 */
async function verifyPasswordResetToken(rawToken) {
  const pool = getPool();
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const result = await pool.query(
    `SELECT prt.*, u.email FROM password_reset_tokens prt
     JOIN users u ON u.id = prt.user_id
     WHERE prt.token_hash = $1 AND prt.used = FALSE AND prt.expires_at > NOW()`,
    [tokenHash]
  );

  if (!result.rows[0]) return null;

  const row = result.rows[0];
  // Mark as used immediately
  await pool.query('UPDATE password_reset_tokens SET used = TRUE WHERE id = $1', [row.id]);

  return { userId: row.user_id, email: row.email };
}

// ─── Magic link auth ───────────────────────────────────────────────────────────

async function createMagicLink(email) {
  const pool = getPool();
  const token = crypto.randomBytes(32).toString('hex');
  // Convert Date to ISO string for consistent TIMESTAMPTZ handling
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000).toISOString();

  // Get or create user
  let user = await getUserByEmail(email);
  if (!user) {
    user = await createUser({ email });
  }

  await pool.query(
    `INSERT INTO email_tokens (user_id, email, token, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [user.id, email.toLowerCase(), token, expiresAt]
  );

  return { token, url: `${APP_URL}/auth/verify?token=${token}` };
}

async function verifyMagicLink(token) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT ml.*, u.email, u.name, u.id as user_id
     FROM email_tokens ml
     JOIN users u ON u.id = ml.user_id
     WHERE ml.token = $1 AND ml.used = FALSE AND ml.expires_at > NOW()`,
    [token]
  );

  if (!result.rows[0]) return null;

  const link = result.rows[0];
  await pool.query('UPDATE email_tokens SET used = TRUE WHERE id = $1', [link.id]);
  await updateLastLogin(link.user_id);

  return link;
}

// ─── Session token (30-day JWT) ───────────────────────────────────────────────

function generateSessionToken(user) {
  const exp = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60); // 30 days
  return createJWT({ sub: user.id, email: user.email, exp });
}

function verifySessionToken(token) {
  return verifyJWT(token);
}

/**
 * Extract user id (sub claim) from a session JWT.
 * Returns null if the token is invalid or expired.
 */
function getUserIdFromToken(token) {
  const payload = verifyJWT(token);
  return payload ? payload.sub : null;
}

module.exports = {
  getUserByEmail,
  getUserById,
  createUser,
  markWelcomeEmailSent,
  updateLastLogin,
  getDaysLeft,
  getUsersNeedingTrialReminder,
  markTrialReminderSent,
  getExpiredTrialUsers,
  updateSubscriptionStatus,
  // Password auth
  hashPassword,
  checkPassword,
  setUserPassword,
  loginWithPassword,
  userHasPassword,
  // Password reset
  createPasswordResetToken,
  verifyPasswordResetToken,
  // Magic link auth
  createMagicLink,
  verifyMagicLink,
  // Session
  generateSessionToken,
  verifySessionToken,
  getUserIdFromToken,
};
