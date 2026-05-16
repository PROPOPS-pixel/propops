/**
 * Service Area Service
 *
 * Owns: geocoding (Nominatim → free, no key), haversine distance, suburb
 *       matching, operator service area CRUD, lead location detection.
 * Does NOT own: referral routing (lead-referral.js), dashboard UI, Hugo AI responses.
 */

'use strict';

const https = require('https');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── Geocoding via Nominatim (OpenStreetMap — free, no key) ──────────────────
// Returns { lat, lng } or null. Timeout: 5s.

async function geocodeAddress(address, defaultState = 'NSW', defaultCountry = 'Australia') {
  return new Promise((resolve) => {
    const query = encodeURIComponent(`${address}, ${defaultCountry}`);
    const opts = {
      hostname: 'nominatim.openstreetmap.org',
      path: `/search?q=${query}&format=json&limit=1&countrycodes=au`,
      headers: {
        'User-Agent': 'PropOps-Hugo/1.0 (support@propops.pro)',
        'Accept-Language': 'en-AU',
      },
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

// ─── Haversine distance (km) ──────────────────────────────────────────────────
// Returns distance in km between two lat/lng pairs.

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg) {
  return deg * (Math.PI / 180);
}

// ─── Suburb normalisation ─────────────────────────────────────────────────────
// Case-insensitive, strip punctuation, trim whitespace.

function normaliseSuburb(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Check if a suburb is in an operator's service area ──────────────────────
// profile: { base_lat, base_lng, service_area_suburbs (array), service_area_radius_km }
// leadSuburb: string (unnormalised)
// leadCoords: { lat, lng } | null (geocoded lead location, may be null if unavailable)
// Returns { inArea: bool, reason: string }

function isInServiceArea(profile, leadSuburb, leadCoords) {
  const normLead = normaliseSuburb(leadSuburb);
  if (!normLead) return { inArea: false, reason: 'no_suburb' };

  // Explicit suburb list takes precedence
  const suburbs = profile.service_area_suburbs || [];
  if (suburbs.length > 0) {
    const hit = suburbs.some(s => normaliseSuburb(s) === normLead);
    return { inArea: hit, reason: hit ? 'suburb_list_match' : 'suburb_list_miss' };
  }

  // Radius check — requires both the operator base and lead coords
  const baseLat = parseFloat(profile.base_lat);
  const baseLng = parseFloat(profile.base_lng);
  const radius  = parseInt(profile.service_area_radius_km) || 25;

  if (!baseLat || !baseLng) return { inArea: false, reason: 'no_base_coords' };
  if (!leadCoords) return { inArea: false, reason: 'no_lead_coords' };

  const dist = haversineKm(baseLat, baseLng, leadCoords.lat, leadCoords.lng);
  const inArea = dist <= radius;
  return {
    inArea,
    reason: inArea ? `within_${Math.round(dist)}km_of_${radius}km_radius` : `outside_${Math.round(dist)}km_exceeds_${radius}km_radius`,
  };
}

// ─── Save service area for an operator ───────────────────────────────────────
// opts: { baseAddress, radiusKm, suburbs[] }
// Geocodes baseAddress, saves to operator_profiles.

async function saveServiceArea(operatorId, opts) {
  const { baseAddress, radiusKm, suburbs } = opts;

  let baseLat = null;
  let baseLng = null;

  if (baseAddress) {
    const coords = await geocodeAddress(baseAddress);
    if (coords) {
      baseLat = coords.lat;
      baseLng = coords.lng;
    }
  }

  const radius = Math.max(1, Math.min(500, parseInt(radiusKm) || 25));
  const suburbArr = Array.isArray(suburbs)
    ? suburbs.map(s => s.trim()).filter(Boolean)
    : [];

  await pool.query(
    `UPDATE operator_profiles
     SET base_address           = $1,
         base_lat               = $2,
         base_lng               = $3,
         service_area_radius_km = $4,
         service_area_suburbs   = $5,
         updated_at             = NOW()
     WHERE operator_id = $6`,
    [baseAddress || null, baseLat, baseLng, radius, suburbArr.length > 0 ? suburbArr : null, operatorId]
  );

  return { baseLat, baseLng, radius, suburbs: suburbArr, geocoded: !!(baseLat && baseLng) };
}

// ─── Get service area for an operator ────────────────────────────────────────

async function getServiceArea(operatorId) {
  const result = await pool.query(
    `SELECT base_address, base_lat, base_lng,
            service_area_radius_km, service_area_suburbs,
            service_area_suburb, service_radius_km, trade_type
     FROM operator_profiles
     WHERE operator_id = $1`,
    [operatorId]
  );
  if (!result.rows[0]) return null;

  const row = result.rows[0];
  return {
    base_address:           row.base_address,
    base_lat:               row.base_lat ? parseFloat(row.base_lat) : null,
    base_lng:               row.base_lng ? parseFloat(row.base_lng) : null,
    service_area_radius_km: row.service_area_radius_km || row.service_radius_km || 25,
    service_area_suburbs:   row.service_area_suburbs || [],
    // Legacy fallback display
    legacy_suburb:          row.service_area_suburb,
    trade_type:             row.trade_type,
  };
}

// ─── Geocode a lead suburb and cache on the lead record ──────────────────────
// Returns { lat, lng } | null

async function geocodeAndCacheLeadSuburb(leadId, suburb) {
  const coords = await geocodeAddress(suburb);
  if (coords && leadId) {
    pool.query(
      `UPDATE operator_widget_leads
       SET lead_suburb = $1, lead_lat = $2, lead_lng = $3, updated_at = NOW()
       WHERE id = $4`,
      [suburb, coords.lat, coords.lng, leadId]
    ).catch(() => {});
  }
  return coords;
}

// ─── Find operators who cover a given suburb/coords ──────────────────────────
// Used by referral routing to find who can take the lead.
// tradeType: string | null (filter by trade if provided)
// leadSuburb: string
// leadCoords: { lat, lng } | null
// Returns array of { operatorId, name, email, distance_km } sorted by distance.

async function findCoveringOperators(tradeType, leadSuburb, leadCoords, excludeOperatorId) {
  const normLead = normaliseSuburb(leadSuburb);

  // Fetch all active operators with service area configured for this trade
  const query = tradeType
    ? `SELECT u.id, u.name, u.email, u.subscription_status,
              op.base_lat, op.base_lng, op.service_area_radius_km,
              op.service_area_suburbs, op.service_area_suburb, op.service_radius_km
       FROM operator_profiles op
       JOIN users u ON u.id = op.operator_id
       WHERE (op.trade_type = $1 OR $1 IS NULL)
         AND u.id != $2
         AND u.subscription_status IN ('active', 'trial')
         AND (op.base_lat IS NOT NULL OR op.service_area_suburbs IS NOT NULL
              OR op.service_area_suburb IS NOT NULL)`
    : `SELECT u.id, u.name, u.email, u.subscription_status,
              op.base_lat, op.base_lng, op.service_area_radius_km,
              op.service_area_suburbs, op.service_area_suburb, op.service_radius_km
       FROM operator_profiles op
       JOIN users u ON u.id = op.operator_id
       WHERE u.id != $2
         AND u.subscription_status IN ('active', 'trial')
         AND (op.base_lat IS NOT NULL OR op.service_area_suburbs IS NOT NULL
              OR op.service_area_suburb IS NOT NULL)`;

  const result = await pool.query(query, [tradeType || null, excludeOperatorId || 0]);
  const candidates = [];

  for (const row of result.rows) {
    const profile = {
      base_lat:               row.base_lat,
      base_lng:               row.base_lng,
      service_area_radius_km: row.service_area_radius_km || row.service_radius_km || 25,
      service_area_suburbs:   row.service_area_suburbs || (row.service_area_suburb ? [row.service_area_suburb] : []),
    };

    const check = isInServiceArea(profile, leadSuburb, leadCoords);
    if (!check.inArea) continue;

    let distKm = null;
    if (leadCoords && row.base_lat && row.base_lng) {
      distKm = haversineKm(parseFloat(row.base_lat), parseFloat(row.base_lng), leadCoords.lat, leadCoords.lng);
    }

    candidates.push({
      operatorId: row.id,
      name:       row.name,
      email:      row.email,
      distance_km: distKm,
    });
  }

  // Sort by distance (closest first). Operators without coords sort last.
  candidates.sort((a, b) => {
    if (a.distance_km === null && b.distance_km === null) return 0;
    if (a.distance_km === null) return 1;
    if (b.distance_km === null) return -1;
    return a.distance_km - b.distance_km;
  });

  return candidates;
}

module.exports = {
  geocodeAddress,
  haversineKm,
  normaliseSuburb,
  isInServiceArea,
  saveServiceArea,
  getServiceArea,
  geocodeAndCacheLeadSuburb,
  findCoveringOperators,
};
