/**
 * Settings routes — notification preferences.
 *
 * GET  /api/settings  — return current user settings
 * PUT  /api/settings  — update notification settings
 */

const express = require('express');
const router  = express.Router();
const { requireAuth } = require('./auth');
const { Pool }        = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── GET /api/settings ────────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.name                                   AS agent_name,
         u.agency_name,
         u.mobile_number,
         u.notification_email,
         COALESCE(u.notify_sms, TRUE)             AS notify_sms,
         COALESCE(u.notify_email_per_lead, TRUE)  AS notify_email_per_lead,
         COALESCE(u.notify_daily_digest, TRUE)    AS notify_daily_digest,
         COALESCE(u.digest_time, '18:00')         AS digest_time,
         COALESCE(u.business_type, 'real_estate') AS business_type,
         op.business_name
       FROM users u
       LEFT JOIN operator_profiles op ON op.operator_id = u.id
       WHERE u.id = $1`,
      [req.userId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Include SMS availability flag so the UI can hide the toggle when SMS isn't configured.
    // SMS requires Twilio credentials — if they're not set, the toggle is misleading.
    const smsAvailable = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);

    res.json({ success: true, settings: result.rows[0], sms_available: smsAvailable });
  } catch (err) {
    console.error('[Settings] GET error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load settings' });
  }
});

// ─── PUT /api/settings ────────────────────────────────────────────────────────

router.put('/', requireAuth, async (req, res) => {
  const {
    agent_name,
    agency_name,
    mobile_number,
    notification_email,
    notify_sms,
    notify_email_per_lead,
    notify_daily_digest,
    digest_time,
    business_type,
    business_name,
  } = req.body;

  // Validate digest_time if provided (HH:MM, 00:00–23:59)
  if (digest_time !== undefined) {
    if (!/^\d{2}:\d{2}$/.test(digest_time)) {
      return res.status(400).json({ success: false, message: 'digest_time must be in HH:MM format' });
    }
    const [h, m] = digest_time.split(':').map(Number);
    if (h > 23 || m > 59) {
      return res.status(400).json({ success: false, message: 'digest_time out of range' });
    }
  }

  // Validate mobile_number if provided (basic sanity, allow empty to clear)
  if (mobile_number !== undefined && mobile_number !== null && mobile_number !== '') {
    const stripped = mobile_number.replace(/[\s\-\(\)]/g, '');
    if (!/^[+\d]{7,15}$/.test(stripped)) {
      return res.status(400).json({ success: false, message: 'Invalid mobile number format' });
    }
  }

  try {
    // Validate business_type if provided — authoritative 26 trades + real_estate + legacy aliases
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
      // Legacy aliases (accepted on save, normalized at simulation time)
      'lawn_care', 'pool_cleaning', 'carpet_cleaning', 'commercial_cleaner', 'bricklayer',
    ];
    if (business_type !== undefined && !validBusinessTypes.includes(business_type)) {
      return res.status(400).json({ success: false, message: 'Invalid business_type' });
    }

    const result = await pool.query(
      `UPDATE users SET
         name                   = CASE WHEN $1::text IS NOT NULL THEN $1 ELSE name END,
         agency_name            = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE agency_name END,
         mobile_number          = COALESCE($3, mobile_number),
         notification_email     = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE notification_email END,
         notify_sms             = COALESCE($5, notify_sms),
         notify_email_per_lead  = COALESCE($6, notify_email_per_lead),
         notify_daily_digest    = COALESCE($7, notify_daily_digest),
         digest_time            = COALESCE($8, digest_time),
         business_type          = COALESCE($10, business_type),
         updated_at             = NOW()
       WHERE id = $9
       RETURNING
         name                                   AS agent_name,
         agency_name,
         mobile_number,
         notification_email,
         COALESCE(notify_sms, TRUE)             AS notify_sms,
         COALESCE(notify_email_per_lead, TRUE)  AS notify_email_per_lead,
         COALESCE(notify_daily_digest, TRUE)    AS notify_daily_digest,
         COALESCE(digest_time, '18:00')         AS digest_time,
         COALESCE(business_type, 'real_estate') AS business_type`,
      [
        agent_name  !== undefined ? (agent_name  || null) : null,
        agency_name !== undefined ? (agency_name || null) : null,
        mobile_number !== undefined ? (mobile_number || null) : null,
        notification_email !== undefined ? (notification_email || null) : null,
        notify_sms             !== undefined ? notify_sms             : null,
        notify_email_per_lead  !== undefined ? notify_email_per_lead  : null,
        notify_daily_digest    !== undefined ? notify_daily_digest    : null,
        digest_time            !== undefined ? digest_time            : null,
        req.userId,
        business_type          !== undefined ? business_type          : null,
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Save business_name to operator_profiles if provided (upsert)
    if (business_name !== undefined) {
      const bn = (business_name || '').trim().slice(0, 255) || null;
      await pool.query(
        `INSERT INTO operator_profiles (operator_id, business_name, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (operator_id) DO UPDATE SET business_name = $2, updated_at = NOW()`,
        [req.userId, bn]
      );
    }

    // Fetch business_name to include in response
    let savedBusinessName = null;
    try {
      const opResult = await pool.query(
        `SELECT business_name FROM operator_profiles WHERE operator_id = $1`,
        [req.userId]
      );
      savedBusinessName = opResult.rows[0]?.business_name || null;
    } catch (_) {}

    console.log(`[Settings] Updated for user ${req.userId}`);
    res.json({ success: true, settings: { ...result.rows[0], business_name: savedBusinessName } });
  } catch (err) {
    console.error('[Settings] PUT error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save settings' });
  }
});

module.exports = router;
