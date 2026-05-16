/**
 * Listings API — /api/listings
 * Manages the agent's listings pool for "similar listing" upsell in AI lead responses.
 *
 * Routes:
 *   GET    /api/listings          — list all active listings
 *   POST   /api/listings          — add a listing manually
 *   PATCH  /api/listings/:id      — update a listing
 *   DELETE /api/listings/:id      — soft-delete a listing
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('./auth');
const listingsService = require('../services/listings');

/**
 * GET /api/listings
 * Returns all active listings, newest first.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const listings = await listingsService.getListings(req.userId);
    res.json({ success: true, listings, count: listings.length });
  } catch (err) {
    console.error('[Listings API] GET error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch listings' });
  }
});

/**
 * POST /api/listings
 * Add a listing manually.
 *
 * Body: { listing_url (required), address, suburb, state, property_type, price_range }
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { listing_url, address, suburb, state, property_type, price_range } = req.body;

    if (!listing_url || !listing_url.trim()) {
      return res.status(400).json({ success: false, message: 'listing_url is required' });
    }

    // Basic URL validation
    try { new URL(listing_url); } catch {
      return res.status(400).json({ success: false, message: 'listing_url must be a valid URL' });
    }

    // Extract raw_price from price_range if provided
    const raw_price = price_range ? listingsService.extractPrice(price_range) : null;

    const listing = await listingsService.addListing({
      listing_url: listing_url.trim(),
      address: address?.trim() || null,
      suburb: suburb?.trim() || null,
      state: state?.trim()?.toUpperCase() || null,
      property_type: property_type?.trim()?.toLowerCase() || null,
      price_range: price_range?.trim() || null,
      raw_price: raw_price || null,
      user_id: req.userId || null,
    });

    res.status(201).json({ success: true, listing, message: 'Listing added' });
  } catch (err) {
    console.error('[Listings API] POST error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to add listing' });
  }
});

/**
 * PATCH /api/listings/:id
 * Update a listing's fields. All fields optional.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { listing_url, address, suburb, state, property_type, price_range } = req.body;

    if (listing_url) {
      try { new URL(listing_url); } catch {
        return res.status(400).json({ success: false, message: 'listing_url must be a valid URL' });
      }
    }

    const raw_price = price_range ? listingsService.extractPrice(price_range) : undefined;

    const listing = await listingsService.updateListing(id, {
      listing_url: listing_url?.trim() || undefined,
      address: address?.trim() || undefined,
      suburb: suburb?.trim() || undefined,
      state: state?.trim()?.toUpperCase() || undefined,
      property_type: property_type?.trim()?.toLowerCase() || undefined,
      price_range: price_range?.trim() || undefined,
      raw_price: raw_price || undefined,
    }, req.userId);

    if (!listing) {
      return res.status(404).json({ success: false, message: 'Listing not found' });
    }

    res.json({ success: true, listing });
  } catch (err) {
    console.error('[Listings API] PATCH error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update listing' });
  }
});

/**
 * DELETE /api/listings/:id
 * Soft-delete a listing (sets is_active = false).
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const listing = await listingsService.deleteListing(id, req.userId);

    if (!listing) {
      return res.status(404).json({ success: false, message: 'Listing not found' });
    }

    res.json({ success: true, message: 'Listing removed' });
  } catch (err) {
    console.error('[Listings API] DELETE error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete listing' });
  }
});

module.exports = router;
