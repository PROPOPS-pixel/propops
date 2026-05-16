/**
 * Service Area routes
 *
 * Owns: operator service area CRUD — save/get base address, radius, suburb list.
 * Does NOT own: referral CRUD (routes/referrals.js), geocoding internals (services/service-area.js),
 *               Hugo AI responses (routes/hugo-brain.js).
 *
 * GET  /api/service-area          — get current operator's service area
 * POST /api/service-area          — save/update service area (geocodes base_address)
 * POST /api/service-area/geocode  — preview geocode an address (returns lat/lng for map)
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { requireAuth } = require('./auth');
const { saveServiceArea, getServiceArea, geocodeAddress } = require('../services/service-area');

// ─── GET /api/service-area ────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  try {
    const area = await getServiceArea(req.userId);
    if (!area) {
      return res.json({ success: true, service_area: null });
    }
    res.json({ success: true, service_area: area });
  } catch (err) {
    console.error('[ServiceArea] GET error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load service area' });
  }
});

// ─── POST /api/service-area ───────────────────────────────────────────────────
// Body: { base_address, radius_km, suburbs[] }
// Geocodes base_address → base_lat/base_lng, saves to operator_profiles.

router.post('/', requireAuth, async (req, res) => {
  const { base_address, radius_km, suburbs } = req.body || {};

  if (!base_address && (!suburbs || suburbs.length === 0)) {
    return res.status(400).json({
      success: false,
      message: 'Provide a base address (for radius mode) or a list of suburbs'
    });
  }

  try {
    const saved = await saveServiceArea(req.userId, {
      baseAddress: base_address,
      radiusKm:    radius_km || 25,
      suburbs:     suburbs || [],
    });

    res.json({
      success: true,
      service_area: saved,
      geocoded: saved.geocoded,
      message: saved.geocoded
        ? `Service area saved — ${saved.radius}km radius from geocoded address`
        : saved.suburbs.length > 0
          ? `Service area saved — ${saved.suburbs.length} suburb(s) listed`
          : 'Service area saved (geocoding failed — check address format)',
    });
  } catch (err) {
    console.error('[ServiceArea] POST error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save service area' });
  }
});

// ─── POST /api/service-area/geocode ──────────────────────────────────────────
// Preview geocode an address without saving. Returns { lat, lng } for map preview.

router.post('/geocode', requireAuth, async (req, res) => {
  const { address } = req.body || {};
  if (!address || typeof address !== 'string' || address.trim().length < 3) {
    return res.status(400).json({ success: false, message: 'address is required' });
  }
  try {
    const coords = await geocodeAddress(address.trim());
    if (!coords) {
      return res.json({ success: false, message: 'Address not found — try a more specific address or suburb, state format' });
    }
    res.json({ success: true, lat: coords.lat, lng: coords.lng });
  } catch (err) {
    console.error('[ServiceArea] geocode error:', err.message);
    res.status(500).json({ success: false, message: 'Geocoding failed' });
  }
});

module.exports = router;
