/**
 * Network Leads & Tradie Signups — Hugo Widget Network Front Door.
 *
 * Owns: capturing public leads (PATH 1) and tradie sign-up intent (PATH 2).
 * Does NOT own: operator auth, billing, matching logic (future).
 *
 * POST /api/network-leads/lead      — save a qualified public lead from Hugo chat
 * POST /api/network-leads/signup    — save a tradie sign-up intent from Hugo chat
 * GET  /api/network-leads/stats     — founder-only: lead + signup counts by trade/suburb
 * GET  /api/network-leads/eagle-eye          — founder-only: geocoded leads + signups for live map
 * GET  /api/network-leads/eagle-eye-operator  — operator-scoped: leads/signups/operators within service radius
 */

const express = require('express');
const router = express.Router();
const https = require('https');
const { requireAuth } = require('./auth');
const  pool  = require('../db/index');
const { normalizePhone, findNetworkLeadByPhone } = require('../db/phone');

// ─── Australian suburb → lat/lng lookup (common suburbs, no API needed) ───────
// Covers Sydney, Melbourne, Brisbane, Perth, Adelaide, Gold Coast, Canberra.
// Unknown suburbs fall back to Nominatim geocoding with a 5-second timeout.
const AU_SUBURB_COORDS = {
  // Sydney Metro
  'sydney': [-33.8688, 151.2093], 'cbd': [-33.8688, 151.2093],
  'parramatta': [-33.8150, 151.0011], 'penrith': [-33.7508, 150.6942],
  'blacktown': [-33.7670, 150.9058], 'liverpool': [-33.9214, 150.9228],
  'campbelltown': [-34.0669, 150.8143], 'bankstown': [-33.9200, 151.0330],
  'hurstville': [-33.9669, 151.1019], 'sutherland': [-34.0306, 151.0547],
  'hornsby': [-33.7025, 151.0990], 'ryde': [-33.8155, 151.1020],
  'manly': [-33.7967, 151.2874], 'bondi': [-33.8914, 151.2743],
  'newtown': [-33.8969, 151.1778], 'surry hills': [-33.8884, 151.2119],
  'chatswood': [-33.7975, 151.1799], 'epping': [-33.7720, 151.0808],
  'castle hill': [-33.7326, 150.9847], 'baulkham hills': [-33.7556, 150.9891],
  'kirrawee': [-34.0289, 151.0731], 'caringbah': [-34.0386, 151.1239],
  'miranda': [-34.0349, 151.1016], 'cronulla': [-34.0547, 151.1519],
  'rockdale': [-33.9500, 151.1361], 'mascot': [-33.9245, 151.1885],
  'burwood': [-33.8768, 151.1033], 'auburn': [-33.8496, 151.0298],
  'fairfield': [-33.8737, 150.9560], 'cabramatta': [-33.8943, 150.9491],
  'strathfield': [-33.8724, 151.0838], 'kogarah': [-33.9637, 151.1326],
  'mosman': [-33.8264, 151.2433], 'neutral bay': [-33.8336, 151.2198],
  // Melbourne Metro
  'melbourne': [-37.8136, 144.9631], 'richmond': [-37.8182, 144.9990],
  'st kilda': [-37.8679, 144.9817], 'south yarra': [-37.8380, 144.9950],
  'fitzroy': [-37.8001, 144.9783], 'collingwood': [-37.8038, 144.9849],
  'brunswick': [-37.7708, 144.9602], 'footscray': [-37.8001, 144.8975],
  'box hill': [-37.8197, 145.1222], 'glen waverley': [-37.8780, 145.1605],
  'dandenong': [-37.9875, 145.2154], 'frankston': [-38.1435, 145.1266],
  'ringwood': [-37.8118, 145.2277], 'epping': [-37.6467, 145.0291],
  'sunshine': [-37.7845, 144.8307], 'hoppers crossing': [-37.8867, 144.6995],
  'werribee': [-37.8994, 144.6583], 'craigieburn': [-37.5987, 144.9408],
  'berwick': [-38.0337, 145.3484], 'pakenham': [-38.0706, 145.4873],
  // Brisbane Metro
  'brisbane': [-27.4698, 153.0251], 'south brisbane': [-27.4775, 153.0178],
  'fortitude valley': [-27.4567, 153.0331], 'woolloongabba': [-27.4939, 153.0311],
  'west end': [-27.4831, 153.0025], 'newstead': [-27.4447, 153.0429],
  'chermside': [-27.3879, 153.0287], 'carindale': [-27.5029, 153.0978],
  'springwood': [-27.6073, 153.0978], 'ipswich': [-27.6132, 152.7618],
  'logan central': [-27.6384, 153.1080], 'redcliffe': [-27.2307, 153.1044],
  // Gold Coast
  'gold coast': [-28.0167, 153.4000], 'surfers paradise': [-28.0022, 153.4299],
  'broadbeach': [-28.0330, 153.4320], 'robina': [-28.0763, 153.3768],
  // Perth Metro
  'perth': [-31.9505, 115.8605], 'fremantle': [-32.0569, 115.7439],
  'joondalup': [-31.7453, 115.7669], 'rockingham': [-32.2784, 115.7317],
  'mandurah': [-32.5297, 115.7220], 'midland': [-31.8897, 116.0044],
  // Adelaide
  'adelaide': [-34.9285, 138.6007], 'glenelg': [-34.9825, 138.5169],
  'elizabeth': [-34.7147, 138.6763], 'salisbury': [-34.7638, 138.6396],
  // Canberra
  'canberra': [-35.2809, 149.1300], 'tuggeranong': [-35.4244, 149.0688],
  'belconnen': [-35.2356, 149.0671], 'woden': [-35.3447, 149.0866],
  // NSW Regional
  'wollongong': [-34.4248, 150.8931], 'newcastle': [-32.9283, 151.7817],
  'maitland': [-32.7340, 151.5570], 'gosford': [-33.4257, 151.3416],
  'wagga wagga': [-35.1082, 147.3598], 'tamworth': [-31.0927, 150.9318],
  'albury': [-36.0737, 146.9135], 'orange': [-33.2832, 149.1001],
  'bathurst': [-33.4169, 149.5772], 'dubbo': [-32.2569, 148.6011],
  // VIC Regional
  'geelong': [-38.1499, 144.3617], 'ballarat': [-37.5622, 143.8503],
  'bendigo': [-36.7570, 144.2794], 'shepparton': [-36.3797, 145.3997],
  'warrnambool': [-38.3834, 142.4904],
  // QLD Regional
  'townsville': [-19.2590, 146.8169], 'cairns': [-16.9186, 145.7781],
  'toowoomba': [-27.5598, 151.9507], 'sunshine coast': [-26.6500, 153.0667],
};

// In-memory geocode cache: suburb_text → {lat, lng} or null
const _geocodeCache = new Map();

// Geocode a suburb string to lat/lng using lookup table first, then Nominatim
async function geocodeText(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (_geocodeCache.has(key)) return _geocodeCache.get(key);

  // Lookup first word or phrase in known table
  const coords = AU_SUBURB_COORDS[key] || AU_SUBURB_COORDS[key.split(',')[0].trim()];
  if (coords) {
    const result = { lat: coords[0], lng: coords[1] };
    _geocodeCache.set(key, result);
    return result;
  }

  // Nominatim fallback — rate limit: 1 req/s, 5s timeout
  const result = await new Promise((resolve) => {
    const query = encodeURIComponent(`${raw.split(',')[0].trim()}, Australia`);
    const opts = {
      hostname: 'nominatim.openstreetmap.org',
      path: `/search?q=${query}&format=json&limit=1&countrycodes=au`,
      headers: { 'User-Agent': 'PropOps-Hugo/1.0 (support@propops.pro)' }
    };
    const req = https.get(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const arr = JSON.parse(data);
          if (arr.length > 0) {
            resolve({ lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) });
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });

  _geocodeCache.set(key, result);
  return result;
}

// ─── Auto-create tables if migration hasn't run yet ───────────────────────────
// Belt-and-suspenders so the widget never fails in prod due to missing tables.
async function ensureNetworkTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS network_leads (
      id              SERIAL PRIMARY KEY,
      session_id      VARCHAR(64),
      domain          VARCHAR(64),
      trade           VARCHAR(100),
      suburb          VARCHAR(200),
      job_description TEXT,
      urgency         VARCHAR(50),
      contact_name    VARCHAR(200),
      contact_phone   VARCHAR(50),
      contact_email   VARCHAR(200),
      status          VARCHAR(50) NOT NULL DEFAULT 'new',
      assigned_operator_id INTEGER,
      metadata        JSONB NOT NULL DEFAULT '{}',
      created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS network_signups (
      id              SERIAL PRIMARY KEY,
      session_id      VARCHAR(64),
      domain          VARCHAR(64),
      trade           VARCHAR(100) NOT NULL,
      service_area    TEXT,
      business_name   VARCHAR(200),
      contact_name    VARCHAR(200),
      contact_phone   VARCHAR(50),
      contact_email   VARCHAR(200),
      status          VARCHAR(50) NOT NULL DEFAULT 'widget_captured',
      linked_user_id  INTEGER,
      metadata        JSONB NOT NULL DEFAULT '{}',
      created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

ensureNetworkTables().catch(e => console.error('[NetworkLeads] DB init error:', e.message));

// ─── Validation helpers ───────────────────────────────────────────────────────

const VALID_URGENCY = ['today', 'this_week', 'getting_quotes'];
const MAX_TEXT = 2000;

function sanitize(s, maxLen) {
  if (typeof s !== 'string') return null;
  return s.trim().slice(0, maxLen || 500) || null;
}

// ─── POST /api/network-leads/lead ─────────────────────────────────────────────
// Hugo calls this when it has collected enough info from a "I need a tradie" visitor.
// Minimum viable: trade + suburb. Contact details optional (some visitors drop off).

router.post('/lead', async (req, res) => {
  const {
    session_id,
    domain,
    trade,
    suburb,
    job_description,
    urgency,
    contact_name,
    contact_phone,
    contact_email,
  } = req.body || {};

  // trade is required — without it we can't route the lead
  if (!trade || typeof trade !== 'string' || !trade.trim()) {
    return res.status(400).json({ success: false, message: 'trade is required' });
  }

  const cleanTrade    = sanitize(trade, 100);
  const cleanSuburb   = sanitize(suburb, 200);
  const cleanJob      = sanitize(job_description, MAX_TEXT);
  const cleanUrgency  = VALID_URGENCY.includes(urgency) ? urgency : null;
  const cleanName     = sanitize(contact_name, 200);
  const rawPhone      = sanitize(contact_phone, 50);
  const cleanPhone    = normalizePhone(rawPhone) || rawPhone;
  const cleanEmail    = sanitize(contact_email, 200);
  const cleanSession  = sanitize(session_id, 64);
  const cleanDomain   = domain === 'propops.pro' ? 'propops.pro' : 'propops.trade';

  try {
    // Phone dedup — if this phone already exists, update instead of inserting
    if (cleanPhone) {
      const existingLead = await findNetworkLeadByPhone(cleanPhone);
      if (existingLead) {
        const isNameUpgrade = cleanName && cleanName !== 'Unknown'
          && (!existingLead.contact_name || existingLead.contact_name === 'Unknown');
        const isTradeUpgrade = cleanTrade && cleanTrade !== 'UNKNOWN'
          && (!existingLead.trade || existingLead.trade === 'UNKNOWN');

        await pool.query(
          `UPDATE network_leads SET
             contact_name = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE contact_name END,
             trade = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE trade END,
             suburb = COALESCE($4, suburb),
             job_description = COALESCE($5, job_description),
             urgency = COALESCE($6, urgency),
             contact_email = COALESCE($7, contact_email),
             updated_at = NOW()
           WHERE id = $1`,
          [
            existingLead.id,
            isNameUpgrade ? cleanName : null,
            isTradeUpgrade ? cleanTrade : null,
            cleanSuburb,
            cleanJob,
            cleanUrgency,
            cleanEmail,
          ]
        );
        console.log(`[NetworkLeads] Phone dedup: updated lead #${existingLead.id} (phone=${cleanPhone})`);
        return res.json({
          success: true,
          lead_id: existingLead.id,
          status: existingLead.status,
          message: cleanSuburb
            ? `Lead updated. Looking for a ${cleanTrade} in ${cleanSuburb}.`
            : `Lead updated. Looking for a ${cleanTrade}.`,
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO network_leads
         (session_id, domain, trade, suburb, job_description, urgency,
          contact_name, contact_phone, contact_email, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'new')
       ON CONFLICT (contact_phone) WHERE contact_phone IS NOT NULL AND contact_phone != ''
       DO UPDATE SET
         contact_name = CASE
           WHEN EXCLUDED.contact_name IS NOT NULL AND EXCLUDED.contact_name NOT IN ('Unknown', 'unknown')
             AND (network_leads.contact_name IS NULL OR network_leads.contact_name IN ('Unknown', 'unknown'))
           THEN EXCLUDED.contact_name ELSE network_leads.contact_name END,
         trade = COALESCE(EXCLUDED.trade, network_leads.trade),
         suburb = COALESCE(EXCLUDED.suburb, network_leads.suburb),
         contact_email = COALESCE(EXCLUDED.contact_email, network_leads.contact_email),
         updated_at = NOW()
       RETURNING id, status`,
      [cleanSession, cleanDomain, cleanTrade, cleanSuburb, cleanJob,
       cleanUrgency, cleanName, cleanPhone, cleanEmail]
    );

    const lead = result.rows[0];
    console.log(`[NetworkLeads] Lead captured: id=${lead.id} trade=${cleanTrade} suburb=${cleanSuburb || 'unknown'} domain=${cleanDomain}`);

    // Fire-and-forget: match to nearest operator + notify — never blocks response
    _matchAndNotifyLead({
      id: lead.id, trade: cleanTrade, suburb: cleanSuburb,
      job_description: cleanJob, urgency: cleanUrgency,
      contact_name: cleanName, contact_phone: cleanPhone, contact_email: cleanEmail,
    }).catch(err => console.error('[NetworkLeads] Match+notify error:', err.message));

    return res.json({
      success: true,
      lead_id: lead.id,
      status: lead.status,
      message: cleanSuburb
        ? `Lead saved. Looking for a ${cleanTrade} in ${cleanSuburb}.`
        : `Lead saved. Looking for a ${cleanTrade}.`,
    });

  } catch (err) {
    console.error('[NetworkLeads] Lead save error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to save lead' });
  }
});

// ─── Lead matching + operator notification (async, post-save) ─────────────────
// Finds the best available operator for this trade, assigns the lead, and sends
// an instant notification. All errors are swallowed — never affects response path.

async function _matchAndNotifyLead(lead) {
  try {
    // Find an active operator who handles this trade
    // Priority: operator with matching business_type/trade_type + active/trial subscription
    // If suburb is provided, we pick the first matching operator — full geo matching is future work
    const matchResult = await pool.query(
      `SELECT u.id
       FROM users u
       LEFT JOIN operator_profiles op ON op.operator_id = u.id
       WHERE u.subscription_status IN ('trial', 'active')
         AND (
           LOWER(op.trade_type) = LOWER($1)
           OR LOWER(u.business_type) = LOWER($1)
         )
         AND COALESCE(u.notify_email_per_lead, TRUE) = TRUE
       ORDER BY u.created_at ASC
       LIMIT 1`,
      [lead.trade]
    );

    if (matchResult.rows.length === 0) {
      // No operator found for this trade — lead stays as 'new'
      return;
    }

    const operatorId = matchResult.rows[0].id;

    // Assign operator + mark matched
    await pool.query(
      `UPDATE network_leads
       SET assigned_operator_id = $1, status = 'matched', updated_at = NOW()
       WHERE id = $2`,
      [operatorId, lead.id]
    );

    // Send instant alert
    const { sendOperatorLeadAlert } = require('../services/operator-notifications');
    await sendOperatorLeadAlert({ ...lead, assigned_operator_id: operatorId });
  } catch (err) {
    console.error(`[NetworkLeads] _matchAndNotifyLead error for lead ${lead.id}:`, err.message);
  }
}

// ─── POST /api/network-leads/signup ──────────────────────────────────────────
// Hugo calls this when a tradie visitor has expressed intent to join.
// Minimum viable: trade. Business name + contact details optional (collected conversationally).

router.post('/signup', async (req, res) => {
  const {
    session_id,
    domain,
    trade,
    service_area,
    business_name,
    contact_name,
    contact_phone,
    contact_email,
  } = req.body || {};

  if (!trade || typeof trade !== 'string' || !trade.trim()) {
    return res.status(400).json({ success: false, message: 'trade is required' });
  }

  const cleanTrade    = sanitize(trade, 100);
  const cleanArea     = sanitize(service_area, 500);
  const cleanBiz      = sanitize(business_name, 200);
  const cleanName     = sanitize(contact_name, 200);
  const cleanPhone    = normalizePhone(sanitize(contact_phone, 50)) || sanitize(contact_phone, 50);
  const cleanEmail    = sanitize(contact_email, 200);
  const cleanSession  = sanitize(session_id, 64);
  const cleanDomain   = domain === 'propops.pro' ? 'propops.pro' : 'propops.trade';

  try {
    const result = await pool.query(
      `INSERT INTO network_signups
         (session_id, domain, trade, service_area, business_name,
          contact_name, contact_phone, contact_email, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'widget_captured')
       RETURNING id, status`,
      [cleanSession, cleanDomain, cleanTrade, cleanArea, cleanBiz,
       cleanName, cleanPhone, cleanEmail]
    );

    const signup = result.rows[0];
    console.log(`[NetworkLeads] Tradie signup captured: id=${signup.id} trade=${cleanTrade} area=${cleanArea || 'unknown'} email=${cleanEmail || 'none'}`);

    return res.json({
      success: true,
      signup_id: signup.id,
      status: signup.status,
      trial_days: 14,
      message: `${cleanTrade} signup captured. 14-day free trial starts on full signup.`,
    });

  } catch (err) {
    console.error('[NetworkLeads] Signup save error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to save signup' });
  }
});

// ─── GET /api/network-leads/stats ─────────────────────────────────────────────
// Founder-only quick stats: counts by trade, by suburb, by status.
// Auth: founder_token query param or cookie (same pattern as /api/founder routes).

router.get('/stats', async (req, res) => {
  // Simple founder auth gate — token checked against env var
  const founderToken = req.query.token || req.cookies?.propops_founder_token;
  if (!founderToken || founderToken !== process.env.FOUNDER_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const [leadsTotal, signupsTotal, leadsByTrade, signupsByTrade, recentLeads] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM network_leads`),
      pool.query(`SELECT COUNT(*) AS total FROM network_signups`),
      pool.query(`SELECT trade, COUNT(*) AS count FROM network_leads GROUP BY trade ORDER BY count DESC LIMIT 10`),
      pool.query(`SELECT trade, COUNT(*) AS count FROM network_signups GROUP BY trade ORDER BY count DESC LIMIT 10`),
      pool.query(
        `SELECT id, trade, suburb, urgency, contact_email, status, created_at
         FROM network_leads ORDER BY created_at DESC LIMIT 20`
      ),
    ]);

    return res.json({
      success: true,
      leads: {
        total: parseInt(leadsTotal.rows[0].total, 10),
        by_trade: leadsByTrade.rows,
        recent: recentLeads.rows,
      },
      signups: {
        total: parseInt(signupsTotal.rows[0].total, 10),
        by_trade: signupsByTrade.rows,
      },
    });
  } catch (err) {
    console.error('[NetworkLeads] Stats error:', err.message);
    return res.status(500).json({ success: false, message: 'Stats unavailable' });
  }
});

// ─── GET /api/network-leads/eagle-eye ────────────────────────────────────────
// Founder-only: geocoded network_leads (blue dots) + network_signups (green pins)
// for the Eagle's Eye live map. Returns up to 200 of each, newest first.
// Auth: session cookie (requireAuth) + is_admin check.

router.get('/eagle-eye', requireAuth, async (req, res) => {
  try {
    // Founder gate
    const userResult = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
    const user = userResult.rows[0];
    if (!user || !user.is_admin) {
      return res.status(403).json({ success: false, message: 'Founder only' });
    }

    const [leadsResult, signupsResult] = await Promise.all([
      pool.query(
        `SELECT id, trade, suburb, urgency, status, created_at
         FROM network_leads ORDER BY created_at DESC LIMIT 200`
      ),
      pool.query(
        `SELECT id, trade, service_area, business_name, status, created_at
         FROM network_signups ORDER BY created_at DESC LIMIT 200`
      ),
    ]);

    // Geocode in parallel — skip rows with no suburb/area
    const leads = await Promise.all(
      leadsResult.rows.map(async (row) => {
        const coords = await geocodeText(row.suburb);
        return {
          id: row.id,
          trade: row.trade,
          suburb: row.suburb,
          urgency: row.urgency,
          status: row.status,
          created_at: row.created_at,
          lat: coords ? coords.lat : null,
          lng: coords ? coords.lng : null,
        };
      })
    );

    const signups = await Promise.all(
      signupsResult.rows.map(async (row) => {
        const area = row.service_area ? row.service_area.split(',')[0].trim() : null;
        const coords = await geocodeText(area);
        return {
          id: row.id,
          trade: row.trade,
          service_area: row.service_area,
          business_name: row.business_name,
          status: row.status,
          created_at: row.created_at,
          lat: coords ? coords.lat : null,
          lng: coords ? coords.lng : null,
        };
      })
    );

    return res.json({
      success: true,
      leads,
      signups,
      counts: {
        leads_total: leads.length,
        signups_total: signups.length,
        leads_mapped: leads.filter(l => l.lat).length,
        signups_mapped: signups.filter(s => s.lat).length,
      }
    });
  } catch (err) {
    console.error('[NetworkLeads] Eagle-Eye error:', err.message);
    return res.status(500).json({ success: false, message: 'Eagle-Eye data unavailable' });
  }
});

// ─── GET /api/network-leads/eagle-eye-operator ──────────────────────────────
// Operator-scoped Eagle's Eye: network leads + signups + nearby operators,
// all filtered by haversine distance from the operator's base address.
// Auth: session cookie (requireAuth) — any logged-in operator.

// Haversine distance in km between two lat/lng pairs
function haversineKm(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

router.get('/eagle-eye-operator', requireAuth, async (req, res) => {
  try {
    // Get operator's base location + service radius
    const profileResult = await pool.query(
      `SELECT base_lat, base_lng, base_address,
              service_area_radius_km, service_radius_km,
              service_area_lat, service_area_lng,
              service_area_suburb, trade_type
       FROM operator_profiles WHERE operator_id = $1`,
      [req.userId]
    );
    const profile = profileResult.rows[0] || {};

    // Prefer new base_lat/base_lng, fall back to legacy service_area_lat/lng
    let baseLat = parseFloat(profile.base_lat) || parseFloat(profile.service_area_lat) || null;
    let baseLng = parseFloat(profile.base_lng) || parseFloat(profile.service_area_lng) || null;

    // If no coords but have a suburb, try geocoding it
    if (!baseLat || !baseLng) {
      const suburb = profile.base_address || profile.service_area_suburb;
      if (suburb) {
        const coords = await geocodeText(suburb);
        if (coords) {
          baseLat = coords.lat;
          baseLng = coords.lng;
        }
      }
    }

    const radiusKm = parseInt(profile.service_area_radius_km) || parseInt(profile.service_radius_km) || 25;

    // No location set — return empty with a hint
    if (!baseLat || !baseLng) {
      return res.json({
        success: true,
        no_location: true,
        message: 'Set your base address in Service Area settings to see your Eagle\'s Eye view.',
        base: { lat: null, lng: null, radius_km: radiusKm, suburb: profile.service_area_suburb || null },
        leads: [],
        signups: [],
        nearby_operators: [],
        counts: { leads_total: 0, signups_total: 0, leads_in_area: 0, signups_in_area: 0, nearby_operators: 0 }
      });
    }

    // Fetch all recent network leads + signups (same as founder, but we'll filter by distance)
    const [leadsResult, signupsResult] = await Promise.all([
      pool.query(
        `SELECT id, trade, suburb, urgency, status, created_at
         FROM network_leads ORDER BY created_at DESC LIMIT 500`
      ),
      pool.query(
        `SELECT id, trade, service_area, business_name, status, created_at
         FROM network_signups ORDER BY created_at DESC LIMIT 500`
      ),
    ]);

    // Geocode + filter leads by distance
    const searchRadius = radiusKm * 1.5; // Show leads slightly beyond operator's radius
    const leads = [];
    for (const row of leadsResult.rows) {
      const coords = await geocodeText(row.suburb);
      if (!coords) continue;
      const dist = haversineKm(baseLat, baseLng, coords.lat, coords.lng);
      if (dist <= searchRadius) {
        leads.push({
          id: row.id, trade: row.trade, suburb: row.suburb,
          urgency: row.urgency, status: row.status,
          created_at: row.created_at,
          lat: coords.lat, lng: coords.lng, distance_km: Math.round(dist)
        });
      }
    }

    // Geocode + filter signups by distance
    const signups = [];
    for (const row of signupsResult.rows) {
      const area = row.service_area ? row.service_area.split(',')[0].trim() : null;
      const coords = await geocodeText(area);
      if (!coords) continue;
      const dist = haversineKm(baseLat, baseLng, coords.lat, coords.lng);
      if (dist <= searchRadius) {
        signups.push({
          id: row.id, trade: row.trade, service_area: row.service_area,
          business_name: row.business_name, status: row.status,
          created_at: row.created_at,
          lat: coords.lat, lng: coords.lng, distance_km: Math.round(dist)
        });
      }
    }

    // Nearby operators (within 3x radius, exclude self)
    const opsResult = await pool.query(
      `SELECT u.id, u.name, op.trade_type,
              op.base_lat, op.base_lng, op.service_area_lat, op.service_area_lng,
              op.service_area_radius_km, op.service_radius_km,
              op.service_area_suburb
       FROM users u
       LEFT JOIN operator_profiles op ON op.operator_id = u.id
       WHERE u.id != $1 AND (u.is_admin = false OR u.is_admin IS NULL)`,
      [req.userId]
    );

    const nearbyOps = [];
    for (const op of opsResult.rows) {
      const opLat = parseFloat(op.base_lat) || parseFloat(op.service_area_lat) || null;
      const opLng = parseFloat(op.base_lng) || parseFloat(op.service_area_lng) || null;
      if (!opLat || !opLng) continue;
      const dist = haversineKm(baseLat, baseLng, opLat, opLng);
      if (dist <= radiusKm * 3) {
        nearbyOps.push({
          id: op.id,
          name: op.name,
          trade_type: op.trade_type,
          radius_km: parseInt(op.service_area_radius_km) || parseInt(op.service_radius_km) || 20,
          lat: opLat, lng: opLng,
          distance_km: Math.round(dist)
        });
      }
    }

    return res.json({
      success: true,
      base: {
        lat: baseLat, lng: baseLng,
        radius_km: radiusKm,
        suburb: profile.base_address || profile.service_area_suburb || null,
        trade_type: profile.trade_type || null
      },
      leads,
      signups,
      nearby_operators: nearbyOps,
      counts: {
        leads_total: leads.length,
        signups_total: signups.length,
        leads_in_area: leads.filter(l => l.distance_km <= radiusKm).length,
        signups_in_area: signups.filter(s => s.distance_km <= radiusKm).length,
        nearby_operators: nearbyOps.length
      }
    });
  } catch (err) {
    console.error('[NetworkLeads] Eagle-Eye-Operator error:', err.message);
    return res.status(500).json({ success: false, message: 'Eagle-Eye data unavailable' });
  }
});

module.exports = router;
