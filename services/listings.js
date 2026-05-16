/**
 * PropOps Listings Service
 *
 * Manages the agent's listings pool for "similar listing" upsell in AI responses.
 *
 * Flow:
 *   1. Every email intake auto-extracts listing data and upserts into this pool
 *   2. Agents can also add listings manually via the dashboard
 *   3. AI responder queries for a similar listing before each response
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract suburb and state from a property address or description string.
 * Handles formats like:
 *   "45 Bourke Street, Surry Hills NSW 2010"
 *   "3 bedroom house in Surry Hills NSW 2010"
 *   "Surry Hills, NSW"
 */
function extractSuburb(text) {
  if (!text) return { suburb: null, state: null };

  // Pattern: [suburb name] [STATE abbreviation] [optional postcode]
  // e.g. "Surry Hills NSW 2010" or "Bondi Junction VIC 3000"
  const statePattern = /\b([A-Za-z ]{2,30})\s+(NSW|VIC|QLD|SA|WA|TAS|ACT|NT)\b/i;
  const match = text.match(statePattern);
  if (match) {
    let suburb = match[1].trim();
    // Remove street numbers and common street keywords from the beginning
    suburb = suburb.replace(/^\d+\s+/, '');
    suburb = suburb.replace(/\b(Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Court|Ct|Lane|Ln|Place|Pl|Boulevard|Blvd|Terrace|Tce|Way|Crescent|Cres|Circuit|Cct)\s*/i, '').trim();
    // Remove leftover leading/trailing noise
    suburb = suburb.replace(/^,\s*/, '').replace(/,\s*$/, '').trim();
    if (suburb.length >= 2) {
      return { suburb, state: match[2].toUpperCase() };
    }
  }
  return { suburb: null, state: null };
}

/**
 * Detect property type from a text string.
 * Returns lowercase type string or null.
 */
function extractPropertyType(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (/\bapartment\b/.test(lower)) return 'apartment';
  if (/\bunit\b/.test(lower))      return 'unit';
  if (/\btownhouse\b/.test(lower)) return 'townhouse';
  if (/\bvilla\b/.test(lower))     return 'villa';
  if (/\bstudio\b/.test(lower))    return 'studio';
  if (/\bcottage\b/.test(lower))   return 'cottage';
  if (/\bhouse\b/.test(lower))     return 'house';
  if (/\bflat\b/.test(lower))      return 'flat';
  return null;
}

/**
 * Extract property type from a listing URL.
 * Portal URLs often embed the property type in their slug:
 *   REA:    https://www.realestate.com.au/property-townhouse-nsw-...
 *   Domain: https://www.domain.com.au/3-bedroom-apartment-surry-hills-...
 *   Homely: https://www.homely.com.au/homes/surry-hills-nsw-2010/123
 * Returns lowercase type string or null.
 */
function extractPropertyTypeFromUrl(url) {
  if (!url) return null;
  const lower = url.toLowerCase();
  // REA format: /property-{type}-{state}-...
  const reaMatch = lower.match(/property-(apartment|unit|townhouse|villa|studio|cottage|house|flat|land|acreage|rural)-/);
  if (reaMatch) return reaMatch[1];
  // Domain format: /{bedrooms}-bedroom-{type}-{suburb}-...
  const domainMatch = lower.match(/\d+-bedroom-(apartment|unit|townhouse|villa|studio|cottage|house|flat)-/);
  if (domainMatch) return domainMatch[1];
  // Generic: check URL path segments for property type keywords
  const types = ['apartment', 'townhouse', 'unit', 'villa', 'studio', 'cottage', 'house', 'flat'];
  for (const t of types) {
    if (lower.includes(`-${t}-`) || lower.includes(`/${t}/`) || lower.includes(`/${t}-`) || lower.includes(`-${t}/`)) return t;
  }
  return null;
}

/**
 * Extract approximate price (as integer) from text.
 * Handles: "$850,000", "$850k", "$850pw", "850000", etc.
 * Returns null if not found.
 */
function extractPrice(text) {
  if (!text) return null;
  // "$850k" or "$1.2m" shorthand
  const shortMatch = text.match(/\$\s*([\d.]+)\s*([km])/i);
  if (shortMatch) {
    const num = parseFloat(shortMatch[1]);
    const unit = shortMatch[2].toLowerCase();
    if (unit === 'k') return Math.round(num * 1000);
    if (unit === 'm') return Math.round(num * 1000000);
  }
  // "$850,000" or "850000"
  const fullMatch = text.match(/\$?\s*([\d]{3,}(?:,\d{3})*)/);
  if (fullMatch) {
    const raw = parseInt(fullMatch[1].replace(/,/g, ''), 10);
    if (raw >= 10000) return raw; // ignore small numbers like bedrooms
  }
  return null;
}

/**
 * Extract a human-readable price string directly from text.
 * Captures rental prices ("$550pw", "$600/week"), sale prices ("$850,000", "$1.2m"),
 * and price guides ("Price guide: $850k-$900k").
 * Returns the matched price text or null.
 */
function extractPriceText(text) {
  if (!text) return null;
  // "Price guide: $850k-$900k" or "Price: $1,200,000"
  const guideMatch = text.match(/(?:price\s*(?:guide)?|rent|asking)\s*[:]\s*(\$[\d,.$]+(?:\s*[-–]\s*\$[\d,.$]+)?(?:\s*(?:pw|p\/w|per\s*week|p\.w\.|pcm|p\/m|per\s*month))?)/i);
  if (guideMatch) return guideMatch[1].trim();
  // "$550pw" or "$550 pw" or "$550/week" or "$600 per week"
  const rentalMatch = text.match(/(\$[\d,]+\s*(?:pw|p\/w|per\s*week|p\.w\.|pcm|p\/m|per\s*month))/i);
  if (rentalMatch) return rentalMatch[1].trim();
  // "$850k-$900k" range
  const rangeMatch = text.match(/(\$[\d,.]+[km]?\s*[-–]\s*\$[\d,.]+[km]?)/i);
  if (rangeMatch) return rangeMatch[1].trim();
  // "$1,200,000" or "$850,000" (standalone large prices)
  const saleMatch = text.match(/(\$[\d,]{6,})/);
  if (saleMatch) return saleMatch[1].trim();
  // "$850k" or "$1.2m"
  const shortMatch = text.match(/(\$[\d.]+\s*[km])\b/i);
  if (shortMatch) return shortMatch[1].trim();
  return null;
}

/**
 * Format a numeric price as a human-readable range string.
 * e.g. 850000 → "$850k-$900k"
 */
function formatPriceRange(raw_price) {
  if (!raw_price) return null;
  if (raw_price < 10000) return null; // pw rent

  const roundTo = raw_price >= 1000000 ? 100000 : 50000;
  const lower = Math.floor(raw_price / roundTo) * roundTo;
  const upper = lower + roundTo;

  const fmt = (n) => n >= 1000000
    ? `$${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}m`
    : `$${(n / 1000).toFixed(0)}k`;

  return `${fmt(lower)}-${fmt(upper)}`;
}

// ─── Core operations ──────────────────────────────────────────────────────────

/**
 * Strip "enquiry for:" prefix from address strings produced by email subject lines.
 * e.g. "enquiry for: 4 Bedroom House, 9 Brighton B..." → "4 Bedroom House, 9 Brighton B..."
 */
function cleanAddress(text) {
  if (!text) return text;
  return text.replace(/^enquiry\s+for\s*:\s*/i, '').trim();
}

/**
 * Auto-add a listing from a parsed email lead.
 * Only stores if we have a listing_url and can extract a suburb.
 * Upserts on listing_url to avoid duplicates.
 *
 * @param {object} lead          — the saved lead row (has property_listing_url, property_interest, etc.)
 * @param {number} rawEmailId    — id of the raw_email record
 * @param {string} emailBodyText — original email body for price extraction
 * @param {number|null} userId   — user_id for multi-tenancy scoping
 * @param {string} emailSubject  — original email subject for property type extraction
 */
async function addListingFromEmail(lead, rawEmailId = null, emailBodyText = '', userId = null, emailSubject = '') {
  const url = lead.property_listing_url;
  if (!url) return null; // Nothing to store without a URL

  // Clean address prefix from email subjects ("enquiry for: ...")
  const propertyText = cleanAddress(lead.property_interest || '');

  // Extract suburb/state from property_interest (e.g. "45 Bourke St, Surry Hills NSW 2010")
  const { suburb, state } = extractSuburb(propertyText);
  // Try property_interest first, then email subject (often has "3 bedroom house"), then email body, then listing URL
  const property_type = extractPropertyType(propertyText)
    || extractPropertyType(emailSubject)
    || extractPropertyType(emailBodyText)
    || extractPropertyTypeFromUrl(url);

  // Try to extract price from email body first, then from property text, then from subject
  const raw_price = extractPrice(emailBodyText) || extractPrice(propertyText) || extractPrice(emailSubject);
  // For price_range: use formatted numeric price if available, otherwise extract text-based price (e.g. "$550pw")
  const price_range = raw_price
    ? formatPriceRange(raw_price)
    : (extractPriceText(emailBodyText) || extractPriceText(emailSubject) || extractPriceText(propertyText) || null);

  try {
    // Upsert — if this URL already exists in the pool, update it (don't duplicate)
    const result = await pool.query(`
      INSERT INTO listings (address, suburb, state, property_type, price_range, raw_price, listing_url, source, source_email_id, user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'email', $8, $9)
      ON CONFLICT (listing_url) WHERE is_active = true
      DO UPDATE SET
        suburb       = COALESCE(EXCLUDED.suburb, listings.suburb),
        state        = COALESCE(EXCLUDED.state, listings.state),
        property_type = COALESCE(EXCLUDED.property_type, listings.property_type),
        price_range  = COALESCE(EXCLUDED.price_range, listings.price_range),
        raw_price    = COALESCE(EXCLUDED.raw_price, listings.raw_price),
        source_email_id = COALESCE(EXCLUDED.source_email_id, listings.source_email_id),
        updated_at   = NOW()
      RETURNING id, listing_url, suburb, property_type
    `, [
      propertyText || null,
      suburb || null,
      state || null,
      property_type || null,
      price_range || null,
      raw_price || null,
      url,
      rawEmailId || null,
      userId || null
    ]);

    const row = result.rows[0];
    if (row) {
      console.log(`[Listings] Auto-added from email: ${row.suburb || '(no suburb)'} ${row.property_type || ''} — ${row.listing_url}`);
    }
    return row || null;
  } catch (err) {
    // Non-fatal — log and continue
    console.error('[Listings] Failed to auto-add listing from email:', err.message);
    return null;
  }
}

/**
 * Manually add a listing (from dashboard form).
 */
async function addListing({ address, suburb, state, property_type, price_range, raw_price, listing_url, user_id }) {
  if (!listing_url) throw new Error('listing_url is required');

  // Parse numeric price if not provided
  if (!raw_price && price_range) {
    raw_price = extractPrice(price_range);
  }

  const result = await pool.query(`
    INSERT INTO listings (address, suburb, state, property_type, price_range, raw_price, listing_url, source, user_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', $8)
    ON CONFLICT (listing_url) WHERE is_active = true
    DO UPDATE SET
      address      = COALESCE(EXCLUDED.address, listings.address),
      suburb       = COALESCE(EXCLUDED.suburb, listings.suburb),
      state        = COALESCE(EXCLUDED.state, listings.state),
      property_type = COALESCE(EXCLUDED.property_type, listings.property_type),
      price_range  = COALESCE(EXCLUDED.price_range, listings.price_range),
      raw_price    = COALESCE(EXCLUDED.raw_price, listings.raw_price),
      source       = 'manual',
      updated_at   = NOW()
    RETURNING *
  `, [address || null, suburb || null, state || null, property_type || null, price_range || null, raw_price || null, listing_url, user_id || null]);

  return result.rows[0];
}

/**
 * Get all active listings ordered by newest first.
 */
async function getListings(userId) {
  const userClause = userId ? `AND user_id = $1` : '';
  const params = userId ? [userId] : [];
  const result = await pool.query(`
    SELECT id, address, suburb, state, property_type, price_range, raw_price,
           listing_url, source, created_at
    FROM listings
    WHERE is_active = true ${userClause}
    ORDER BY created_at DESC
  `, params);
  return result.rows;
}

/**
 * Soft-delete a listing.
 */
async function deleteListing(id, userId) {
  const userClause = userId ? `AND user_id = $2` : '';
  const params = userId ? [id, userId] : [id];
  const result = await pool.query(
    `UPDATE listings SET is_active = false, updated_at = NOW() WHERE id = $1 ${userClause} RETURNING id`,
    params
  );
  return result.rows[0] || null;
}

/**
 * Update a listing's fields.
 */
async function updateListing(id, { address, suburb, state, property_type, price_range, raw_price, listing_url }, userId) {
  const userClause = userId ? `AND user_id = $9` : '';
  const params = [address, suburb, state, property_type, price_range, raw_price, listing_url, id];
  if (userId) params.push(userId);
  const result = await pool.query(`
    UPDATE listings
    SET address       = COALESCE($1, address),
        suburb        = COALESCE($2, suburb),
        state         = COALESCE($3, state),
        property_type = COALESCE($4, property_type),
        price_range   = COALESCE($5, price_range),
        raw_price     = COALESCE($6, raw_price),
        listing_url   = COALESCE($7, listing_url),
        updated_at    = NOW()
    WHERE id = $8 AND is_active = true ${userClause}
    RETURNING *
  `, params);
  return result.rows[0] || null;
}

/**
 * Find a similar listing for a given lead.
 * Matching priority:
 *   1. Same suburb + same property type
 *   2. Same suburb (any property type)
 *   3. Same property type (any suburb)
 *
 * Never returns the same listing URL the lead enquired about.
 *
 * @param {object} lead — lead row (property_interest, property_listing_url, lead_type)
 * @returns {object|null} listing row or null if none found
 */
async function getSimilarListing(lead) {
  // Skip for seller/landlord leads — no point recommending another property
  const leadType = (lead.lead_type || '').toLowerCase();
  if (leadType === 'seller' || leadType === 'landlord') return null;

  const { suburb } = extractSuburb(lead.property_interest || '');
  const property_type = extractPropertyType(lead.property_interest || '');
  const exclude_url = lead.property_listing_url || null;
  const userId = lead.user_id || null;

  // Build user clause for all queries
  const userClause = userId ? `AND user_id = $${exclude_url ? 'USER_IDX' : 'USER_IDX'}` : '';

  try {
    // Try suburb + property type first
    if (suburb && property_type) {
      let params = [suburb, property_type];
      let whereExtra = '';
      if (exclude_url) { whereExtra += ` AND listing_url != $${params.length + 1}`; params.push(exclude_url); }
      if (userId) { whereExtra += ` AND user_id = $${params.length + 1}`; params.push(userId); }
      const r1 = await pool.query(`
        SELECT id, address, suburb, state, property_type, price_range, listing_url
        FROM listings
        WHERE is_active = true
          AND LOWER(suburb) = LOWER($1)
          AND property_type = $2
          ${whereExtra}
        ORDER BY created_at DESC
        LIMIT 1
      `, params);
      if (r1.rows.length > 0) {
        console.log(`[Listings] Similar match (suburb+type): ${r1.rows[0].suburb} ${r1.rows[0].property_type}`);
        return r1.rows[0];
      }
    }

    // Try same suburb, any property type
    if (suburb) {
      let params = [suburb];
      let whereExtra = '';
      if (exclude_url) { whereExtra += ` AND listing_url != $${params.length + 1}`; params.push(exclude_url); }
      if (userId) { whereExtra += ` AND user_id = $${params.length + 1}`; params.push(userId); }
      const r2 = await pool.query(`
        SELECT id, address, suburb, state, property_type, price_range, listing_url
        FROM listings
        WHERE is_active = true
          AND LOWER(suburb) = LOWER($1)
          ${whereExtra}
        ORDER BY created_at DESC
        LIMIT 1
      `, params);
      if (r2.rows.length > 0) {
        console.log(`[Listings] Similar match (suburb only): ${r2.rows[0].suburb}`);
        return r2.rows[0];
      }
    }

    // Try same property type, any suburb
    if (property_type) {
      let params = [property_type];
      let whereExtra = '';
      if (exclude_url) { whereExtra += ` AND listing_url != $${params.length + 1}`; params.push(exclude_url); }
      if (userId) { whereExtra += ` AND user_id = $${params.length + 1}`; params.push(userId); }
      const r3 = await pool.query(`
        SELECT id, address, suburb, state, property_type, price_range, listing_url
        FROM listings
        WHERE is_active = true
          AND property_type = $1
          ${whereExtra}
        ORDER BY created_at DESC
        LIMIT 1
      `, params);
      if (r3.rows.length > 0) {
        console.log(`[Listings] Similar match (type only): ${r3.rows[0].property_type}`);
        return r3.rows[0];
      }
    }

    // Last resort — any listing that's not the current one
    let params = [];
    let whereExtra = '';
    if (exclude_url) { whereExtra += ` AND listing_url != $${params.length + 1}`; params.push(exclude_url); }
    if (userId) { whereExtra += ` AND user_id = $${params.length + 1}`; params.push(userId); }
    const r4 = await pool.query(`
      SELECT id, address, suburb, state, property_type, price_range, listing_url
      FROM listings
      WHERE is_active = true
        ${whereExtra}
      ORDER BY created_at DESC
      LIMIT 1
    `, params);

    if (r4.rows.length > 0) {
      console.log(`[Listings] Similar match (fallback any): ${r4.rows[0].listing_url}`);
      return r4.rows[0];
    }

    console.log(`[Listings] No similar listing found for lead`);
    return null;
  } catch (err) {
    console.error('[Listings] getSimilarListing error:', err.message);
    return null;
  }
}

/**
 * Count active listings.
 */
async function getListingCount(userId) {
  try {
    const userClause = userId ? `AND user_id = $1` : '';
    const params = userId ? [userId] : [];
    const result = await pool.query(`SELECT COUNT(*) FROM listings WHERE is_active = true ${userClause}`, params);
    return parseInt(result.rows[0].count, 10);
  } catch {
    return 0;
  }
}

/**
 * One-time backfill: populate property_type from listing URLs for existing rows that are missing it.
 * Safe to run multiple times — only updates rows where property_type IS NULL and URL yields a match.
 * Runs at startup, non-blocking.
 */
async function backfillPropertyTypeFromUrls() {
  try {
    const result = await pool.query(
      `SELECT id, listing_url, address FROM listings WHERE is_active = true AND property_type IS NULL AND listing_url IS NOT NULL`
    );
    if (result.rows.length === 0) {
      console.log('[Listings] Backfill: no listings with missing property_type');
      return;
    }
    let updated = 0;
    for (const row of result.rows) {
      const urlType = extractPropertyTypeFromUrl(row.listing_url);
      const textType = extractPropertyType(row.address);
      const propType = urlType || textType;
      if (propType) {
        await pool.query(
          `UPDATE listings SET property_type = $1, updated_at = NOW() WHERE id = $2`,
          [propType, row.id]
        );
        updated++;
      }
    }
    if (updated > 0) {
      console.log(`[Listings] Backfill: updated property_type for ${updated}/${result.rows.length} listings from URLs`);
    }
  } catch (err) {
    console.error('[Listings] Backfill error:', err.message);
  }
}

// Run backfill on module load (non-blocking)
backfillPropertyTypeFromUrls();

module.exports = {
  addListingFromEmail,
  addListing,
  getListings,
  deleteListing,
  updateListing,
  getSimilarListing,
  getListingCount,
  extractSuburb,
  extractPropertyType,
  extractPropertyTypeFromUrl,
  extractPrice,
  extractPriceText,
  formatPriceRange,
  cleanAddress,
  backfillPropertyTypeFromUrls,
};
