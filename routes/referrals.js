/**
 * Referrals API routes.
 *
 * Owns: CRUD for hugo_referral_leads, service area geocoding for map view.
 * Does NOT own: lead management (routes/leads.js), Hugo network broker (routes/hugo-network.js).
 *
 * GET  /api/referrals/out          — leads this operator referred out
 * GET  /api/referrals/in           — leads referred IN to this operator
 * GET  /api/referrals/stats        — summary stats (counts + conversion rate)
 * POST /api/referrals              — create a referral (Hugo or manual)
 * PUT  /api/referrals/:id/respond  — accept/decline an incoming referral
 * GET  /api/referrals/map-data     — operator service area + lead pins for map view
 * GET  /api/referrals/network-map  — founder only: all operator service areas
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const https = require('https');
const { requireAuth } = require('./auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ─── Geocoding helper (Nominatim — free, no key needed) ───────────────────────

function geocodeSuburb(suburb, state = 'NSW', country = 'Australia') {
  return new Promise((resolve) => {
    const query = encodeURIComponent(`${suburb}, ${state}, ${country}`);
    const opts = {
      hostname: 'nominatim.openstreetmap.org',
      path: `/search?q=${query}&format=json&limit=1`,
      headers: { 'User-Agent': 'PropOps-Hugo/1.0 (support@propops.pro)' }
    };
    const req = https.get(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const arr = JSON.parse(data);
          if (arr.length > 0) {
            resolve({ lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}

// ─── GET /api/referrals/out ───────────────────────────────────────────────────

router.get('/out', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         r.id, r.lead_name, r.lead_suburb, r.lead_trade_type, r.lead_description,
         r.referred_at, r.status, r.response_note, r.responded_at,
         u.name AS receiving_operator_name,
         u.email AS receiving_operator_email
       FROM hugo_referral_leads r
       LEFT JOIN users u ON u.id = r.receiving_operator_id
       WHERE r.operator_id = $1
       ORDER BY r.referred_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ success: true, referrals: result.rows });
  } catch (err) {
    console.error('[Referrals] GET /out error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch referrals' });
  }
});

// ─── GET /api/referrals/in ────────────────────────────────────────────────────

router.get('/in', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         r.id, r.lead_name, r.lead_suburb, r.lead_trade_type, r.lead_description,
         r.referred_at, r.status, r.response_note, r.responded_at,
         u.name AS source_operator_name
       FROM hugo_referral_leads r
       LEFT JOIN users u ON u.id = r.operator_id
       WHERE r.receiving_operator_id = $1
       ORDER BY r.referred_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ success: true, referrals: result.rows });
  } catch (err) {
    console.error('[Referrals] GET /in error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch inbound referrals' });
  }
});

// ─── GET /api/referrals/stats ─────────────────────────────────────────────────

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const [outStats, inStats] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE TRUE) AS total_out,
           COUNT(*) FILTER (WHERE status = 'accepted') AS accepted,
           COUNT(*) FILTER (WHERE status = 'converted') AS converted
         FROM hugo_referral_leads
         WHERE operator_id = $1`,
        [req.userId]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE TRUE) AS total_in,
           COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_in,
           COUNT(*) FILTER (WHERE status = 'converted') AS converted_in,
           COUNT(*) FILTER (WHERE status = 'pending') AS pending_in
         FROM hugo_referral_leads
         WHERE receiving_operator_id = $1`,
        [req.userId]
      )
    ]);

    const out = outStats.rows[0];
    const inRow = inStats.rows[0];
    const convRate = inRow.total_in > 0
      ? Math.round((parseInt(inRow.converted_in) / parseInt(inRow.total_in)) * 100)
      : 0;

    res.json({
      success: true,
      stats: {
        total_referred_out: parseInt(out.total_out),
        total_referred_in: parseInt(inRow.total_in),
        pending_incoming: parseInt(inRow.pending_in),
        conversion_rate: convRate
      }
    });
  } catch (err) {
    console.error('[Referrals] GET /stats error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// ─── POST /api/referrals ──────────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  const { receiving_operator_id, lead_name, lead_suburb, lead_trade_type, lead_description, lead_id, network_request_id } = req.body;
  if (!lead_suburb && !lead_trade_type) {
    return res.status(400).json({ success: false, message: 'lead_suburb or lead_trade_type required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO hugo_referral_leads
         (operator_id, receiving_operator_id, lead_id, lead_name, lead_suburb, lead_trade_type, lead_description, network_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [req.userId, receiving_operator_id || null, lead_id || null, lead_name || null,
       lead_suburb || null, lead_trade_type || null, lead_description || null, network_request_id || null]
    );
    res.json({ success: true, referral_id: result.rows[0].id });
  } catch (err) {
    console.error('[Referrals] POST / error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create referral' });
  }
});

// ─── PUT /api/referrals/:id/respond ──────────────────────────────────────────

router.put('/:id/respond', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid ID' });

  const { status, response_note } = req.body;
  const validStatuses = ['accepted', 'declined', 'converted'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: 'status must be accepted, declined, or converted' });
  }

  try {
    const result = await pool.query(
      `UPDATE hugo_referral_leads
       SET status = $1, response_note = $2, responded_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND receiving_operator_id = $4
       RETURNING id`,
      [status, response_note || null, id, req.userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Referral not found or not yours' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Referrals] PUT /:id/respond error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update referral' });
  }
});

// ─── GET /api/referrals/map-data ─────────────────────────────────────────────
// Returns operator's service area center + radius + recent lead pins for map.

router.get('/map-data', requireAuth, async (req, res) => {
  try {
    // Get operator profile (service area)
    const profileResult = await pool.query(
      `SELECT service_area_suburb, service_radius_km, service_area_lat, service_area_lng, trade_type
       FROM operator_profiles WHERE operator_id = $1`,
      [req.userId]
    );
    const profile = profileResult.rows[0] || {};

    // Geocode if suburb is set but no coords yet
    let lat = parseFloat(profile.service_area_lat) || null;
    let lng = parseFloat(profile.service_area_lng) || null;

    if (profile.service_area_suburb && (!lat || !lng)) {
      const coords = await geocodeSuburb(profile.service_area_suburb);
      if (coords) {
        lat = coords.lat;
        lng = coords.lng;
        // Cache it
        await pool.query(
          `UPDATE operator_profiles SET service_area_lat = $1, service_area_lng = $2, updated_at = NOW()
           WHERE operator_id = $3`,
          [lat, lng, req.userId]
        );
      }
    }

    // Recent leads — colour-coded by location relative to service area
    const leadsResult = await pool.query(
      `SELECT id, name, suburb, status, created_at
       FROM operator_widget_leads
       WHERE operator_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [req.userId]
    );

    // Recent referrals IN (blue pins)
    const referralsInResult = await pool.query(
      `SELECT r.id, r.lead_name, r.lead_suburb, r.referred_at, u.name AS from_operator
       FROM hugo_referral_leads r
       LEFT JOIN users u ON u.id = r.operator_id
       WHERE r.receiving_operator_id = $1
       ORDER BY r.referred_at DESC
       LIMIT 15`,
      [req.userId]
    );

    res.json({
      success: true,
      service_area: {
        suburb: profile.service_area_suburb || null,
        radius_km: parseInt(profile.service_radius_km) || 20,
        lat, lng
      },
      leads: leadsResult.rows,
      referrals_in: referralsInResult.rows
    });
  } catch (err) {
    console.error('[Referrals] GET /map-data error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load map data' });
  }
});

// ─── GET /api/referrals/network-map ──────────────────────────────────────────
// Founder only: all operator service areas + coverage gaps.

router.get('/network-map', requireAuth, async (req, res) => {
  try {
    // Check founder
    const userResult = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
    const user = userResult.rows[0];
    if (!user || !user.is_admin) {
      return res.status(403).json({ success: false, message: 'Founder only' });
    }

    // All operators with geocoded service areas
    // Select BOTH base_lat/base_lng (new) and service_area_lat/service_area_lng (legacy)
    // so we can fall back correctly — saveServiceArea() stores in base_lat/base_lng
    const ops = await pool.query(
      `SELECT u.id, u.name, u.email,
              op.service_area_suburb, op.service_radius_km, op.service_area_lat, op.service_area_lng,
              op.base_lat, op.base_lng, op.base_address, op.service_area_radius_km,
              op.trade_type,
              COUNT(DISTINCT l.id) AS lead_count
       FROM users u
       LEFT JOIN operator_profiles op ON op.operator_id = u.id
       LEFT JOIN operator_widget_leads l ON l.operator_id = u.id
       WHERE u.is_admin = false OR u.is_admin IS NULL
       GROUP BY u.id, u.name, u.email, op.service_area_suburb, op.service_radius_km,
                op.service_area_lat, op.service_area_lng, op.base_lat, op.base_lng,
                op.base_address, op.service_area_radius_km, op.trade_type
       ORDER BY lead_count DESC`
    );

    // Network referral volume
    const referralVolume = await pool.query(
      `SELECT operator_id, COUNT(*) AS out_count FROM hugo_referral_leads GROUP BY operator_id`
    );
    const volumeMap = {};
    referralVolume.rows.forEach(r => { volumeMap[r.operator_id] = parseInt(r.out_count); });

    // Prefer base_lat/base_lng (new), fall back to service_area_lat/service_area_lng (legacy).
    // If neither exists but a suburb name is available, geocode it.
    const operators = await Promise.all(ops.rows.map(async (op) => {
      let lat = parseFloat(op.base_lat) || parseFloat(op.service_area_lat) || null;
      let lng = parseFloat(op.base_lng) || parseFloat(op.service_area_lng) || null;

      // Geocode fallback: use base_address or service_area_suburb
      if (!lat || !lng) {
        const suburb = op.base_address || op.service_area_suburb;
        if (suburb) {
          const coords = await geocodeSuburb(suburb);
          if (coords) { lat = coords.lat; lng = coords.lng; }
        }
      }

      return {
        id: op.id,
        name: op.name,
        trade_type: op.trade_type,
        suburb: op.service_area_suburb,
        radius_km: parseInt(op.service_area_radius_km) || parseInt(op.service_radius_km) || 20,
        lat,
        lng,
        lead_count: parseInt(op.lead_count),
        referrals_out: volumeMap[op.id] || 0
      };
    }));

    res.json({ success: true, operators });
  } catch (err) {
    console.error('[Referrals] GET /network-map error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load network map' });
  }
});

module.exports = router;
