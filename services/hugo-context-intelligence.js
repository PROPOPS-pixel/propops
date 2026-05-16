/**
 * Hugo Context Intelligence Service — lead history analytics for Hugo Brain.
 *
 * Owns: pre-conversation analytics queries that tell Hugo about historical patterns —
 *       hot suburbs, top lead sources, pipeline stage distribution, lead type mix,
 *       job history patterns, and listing cross-match for RE agents.
 * Does NOT own: raw lead fetching (operator-data.js), prompt assembly (hugo-brain.js),
 *               action dispatch (actions-engine.js).
 *
 * Called in parallel with other Layer 0 fetches before every Hugo response.
 * Results cached per operator for 5 minutes to avoid DB hammering.
 * All queries are non-fatal — missing tables or empty results return null gracefully.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5,
});

// ─── Cache (operator_id → { data, fetchedAt }) ───────────────────────────────
const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(operatorId) {
  const entry = _cache.get(operatorId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    _cache.delete(operatorId);
    return null;
  }
  return entry.data;
}

function setCache(operatorId, data) {
  _cache.set(operatorId, { data, fetchedAt: Date.now() });
}

function clearIntelligenceCache(operatorId) {
  _cache.delete(operatorId);
}

// ─── Query 1: Hot suburbs ─────────────────────────────────────────────────────
// Which suburbs appear most in lead history.
async function fetchHotSuburbs(operatorId) {
  try {
    const result = await pool.query(
      `SELECT
         COALESCE(job_location, lead_suburb) AS suburb,
         COUNT(*) AS count
       FROM operator_widget_leads
       WHERE operator_id = $1
         AND COALESCE(job_location, lead_suburb) IS NOT NULL
         AND COALESCE(job_location, lead_suburb) != ''
       GROUP BY suburb
       ORDER BY count DESC
       LIMIT 5`,
      [operatorId]
    );
    return result.rows.filter(r => r.suburb && parseInt(r.count) > 0);
  } catch {
    return [];
  }
}

// ─── Query 2: Source conversion rates ─────────────────────────────────────────
// Which lead sources produce the most qualified/won leads.
async function fetchSourceConversion(operatorId) {
  try {
    // Try general leads table first (has source column)
    const result = await pool.query(
      `SELECT
         source,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status IN ('qualified', 'won', 'booked', 'converted')) AS converted
       FROM leads
       WHERE user_id = $1
         AND source IS NOT NULL
       GROUP BY source
       ORDER BY converted DESC, total DESC
       LIMIT 6`,
      [operatorId]
    );
    if (result.rows.length > 0) return result.rows;
  } catch { /* leads table may not exist — try widget leads */ }

  try {
    // Fallback: widget leads don't have a source column but have job_type
    // Return pipeline stage counts as a proxy for conversion insight
    const result = await pool.query(
      `SELECT
         status,
         COUNT(*) AS total
       FROM operator_widget_leads
       WHERE operator_id = $1
       GROUP BY status
       ORDER BY total DESC`,
      [operatorId]
    );
    return result.rows.map(r => ({ source: r.status, total: r.total, converted: 0, is_stage: true }));
  } catch {
    return [];
  }
}

// ─── Query 3: Pipeline stage distribution ─────────────────────────────────────
// Where leads are stuck in the funnel.
async function fetchPipelineDistribution(operatorId) {
  try {
    const result = await pool.query(
      `SELECT
         status,
         COUNT(*) AS count,
         ROUND(AVG(intent_score)::numeric, 1) AS avg_intent
       FROM operator_widget_leads
       WHERE operator_id = $1
       GROUP BY status
       ORDER BY count DESC`,
      [operatorId]
    );
    return result.rows;
  } catch {
    return [];
  }
}

// ─── Query 4: Lead type mix (RE agents) ──────────────────────────────────────
// Buyer vs Renter vs Landlord distribution.
async function fetchLeadTypeMix(operatorId) {
  try {
    const result = await pool.query(
      `SELECT
         lead_type,
         COUNT(*) AS count,
         COUNT(*) FILTER (WHERE status IN ('qualified', 'won', 'booked', 'converted')) AS converted
       FROM leads
       WHERE user_id = $1
         AND lead_type IS NOT NULL
       GROUP BY lead_type
       ORDER BY count DESC`,
      [operatorId]
    );
    return result.rows;
  } catch {
    return [];
  }
}

// ─── Query 5: Job history patterns (Tradies/Builders) ────────────────────────
// Top job types completed and won conversion rate.
async function fetchJobHistoryPatterns(operatorId) {
  try {
    const result = await pool.query(
      `SELECT
         job_type,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status IN ('won', 'completed', 'booked')) AS won
       FROM operator_widget_leads
       WHERE operator_id = $1
         AND job_type IS NOT NULL
       GROUP BY job_type
       ORDER BY total DESC
       LIMIT 6`,
      [operatorId]
    );
    return result.rows;
  } catch {
    return [];
  }
}

// ─── Query 6: Active listings (RE agents) ────────────────────────────────────
// Returns operator's active property listings for suburb cross-matching.
async function fetchActiveListings(operatorId) {
  try {
    const result = await pool.query(
      `SELECT
         address, suburb, state, property_type, bedrooms, price_display,
         status, listing_type
       FROM listings
       WHERE operator_id = $1
         AND status IN ('active', 'for_sale', 'for_rent', 'available')
       ORDER BY created_at DESC
       LIMIT 10`,
      [operatorId]
    );
    return result.rows;
  } catch {
    // Try leads table listing data if listings table doesn't exist
    try {
      const fallback = await pool.query(
        `SELECT address, suburb, property_type, lead_type, status, created_at
         FROM leads
         WHERE user_id = $1
           AND (lead_type = 'Listing' OR lead_type = 'Property' OR lead_type = 'listing')
         ORDER BY created_at DESC
         LIMIT 5`,
        [operatorId]
      );
      return fallback.rows;
    } catch {
      return [];
    }
  }
}

// ─── Query 7: High-intent unclosed leads ─────────────────────────────────────
// Leads with high intent that haven't progressed — Hugo should push these.
async function fetchHighIntentUnqualified(operatorId) {
  try {
    const result = await pool.query(
      `SELECT
         lead_name, job_type, job_location, intent_score,
         status, created_at
       FROM operator_widget_leads
       WHERE operator_id = $1
         AND intent_score >= 7
         AND status NOT IN ('qualified', 'won', 'booked', 'converted', 'closed')
       ORDER BY intent_score DESC, created_at DESC
       LIMIT 5`,
      [operatorId]
    );
    return result.rows;
  } catch {
    return [];
  }
}

// ─── Main: fetch all intelligence queries in parallel ─────────────────────────
/**
 * Fetch lead history intelligence for Hugo.
 * All queries run in parallel — budget < 500ms.
 *
 * @param {string} operatorId - UUID of the operator
 * @param {string} [businessType] - 'real_estate' or 'trades' (determines which queries to run)
 * @returns {Promise<Object>} structured intelligence context
 */
async function fetchContextIntelligence(operatorId, businessType) {
  if (!operatorId) return null;

  const cached = getCached(operatorId);
  if (cached) return cached;

  const isRE = businessType === 'real_estate';

  const [hotSuburbs, sourceConversion, pipelineDistribution, leadTypeMix, jobPatterns, activeListings, highIntentLeads] = await Promise.all([
    fetchHotSuburbs(operatorId),
    fetchSourceConversion(operatorId),
    fetchPipelineDistribution(operatorId),
    isRE ? fetchLeadTypeMix(operatorId) : Promise.resolve([]),
    !isRE ? fetchJobHistoryPatterns(operatorId) : Promise.resolve([]),
    isRE ? fetchActiveListings(operatorId) : Promise.resolve([]),
    fetchHighIntentUnqualified(operatorId),
  ]);

  const data = {
    hotSuburbs,
    sourceConversion,
    pipelineDistribution,
    leadTypeMix,
    jobPatterns,
    activeListings,
    highIntentLeads,
    businessType: isRE ? 'real_estate' : 'trades',
  };

  setCache(operatorId, data);
  return data;
}

// ─── Format intelligence as Hugo prompt layer ─────────────────────────────────
/**
 * Converts intelligence data into a concise system prompt segment.
 * Hugo reads this to understand pipeline patterns and make smarter responses.
 *
 * @param {Object} intelligence - result of fetchContextIntelligence()
 * @param {string|null} [currentLeadSuburb] - suburb from current lead (for listing cross-match)
 * @returns {string} prompt segment, or '' if no useful data
 */
function formatIntelligencePrompt(intelligence, currentLeadSuburb) {
  if (!intelligence) return '';

  const parts = [];

  // Hot suburbs — where most leads come from
  if (intelligence.hotSuburbs && intelligence.hotSuburbs.length > 0) {
    const topSuburbs = intelligence.hotSuburbs
      .map(s => `${s.suburb} (${s.count})`)
      .join(', ');
    parts.push(`HIGH-DEMAND SUBURBS: ${topSuburbs} — mention these naturally when relevant, e.g. "I see you're in Mosman — we've had strong demand there"`);
  }

  // Pipeline distribution — where leads get stuck
  if (intelligence.pipelineDistribution && intelligence.pipelineDistribution.length > 0) {
    const pipeline = intelligence.pipelineDistribution;
    const contacted = pipeline.find(s => s.status === 'contacted' || s.status === 'new');
    const qualified = pipeline.find(s => s.status === 'qualified');
    const total = pipeline.reduce((sum, s) => sum + parseInt(s.count), 0);

    if (total > 0) {
      const contactedCount = parseInt(contacted?.count || 0);
      const qualifiedCount = parseInt(qualified?.count || 0);

      if (contactedCount > qualifiedCount && contactedCount > 0) {
        parts.push(`PIPELINE INSIGHT: ${contactedCount} leads contacted but only ${qualifiedCount} qualified — Hugo should actively push leads toward qualification (ask budget, timeline, location)`);
      }
    }
  }

  // Source conversion — which sources work best
  if (intelligence.sourceConversion && intelligence.sourceConversion.length > 0 && !intelligence.sourceConversion[0].is_stage) {
    const topSource = intelligence.sourceConversion[0];
    if (topSource && topSource.source && parseInt(topSource.converted) > 0) {
      parts.push(`TOP CONVERTING SOURCE: ${topSource.source} (${topSource.converted}/${topSource.total} converted) — when a lead mentions this source, treat as higher intent`);
    }
  }

  // Lead type mix (RE agents) — adjust qualification approach
  if (intelligence.leadTypeMix && intelligence.leadTypeMix.length > 0) {
    const leadTypes = intelligence.leadTypeMix
      .slice(0, 3)
      .map(t => `${t.lead_type}: ${t.count}`);
    if (leadTypes.length > 0) {
      parts.push(`LEAD TYPE MIX: ${leadTypes.join(', ')} — Buyer → push inspection booking; Renter → push viewing; Landlord → connect for appraisal`);
    }
  }

  // Job patterns (Tradies) — top job types
  if (intelligence.jobPatterns && intelligence.jobPatterns.length > 0) {
    const topJobs = intelligence.jobPatterns
      .filter(j => parseInt(j.total) >= 1)
      .slice(0, 4)
      .map(j => j.job_type)
      .join(', ');
    if (topJobs) {
      parts.push(`TOP JOB TYPES HANDLED: ${topJobs} — when new leads mention these, respond with confidence ("We do a lot of ${intelligence.jobPatterns[0]?.job_type} work")`);
    }
  }

  // Active listings cross-match (RE agents)
  if (intelligence.activeListings && intelligence.activeListings.length > 0) {
    if (currentLeadSuburb) {
      const suburbLower = currentLeadSuburb.toLowerCase();
      const matchingListings = intelligence.activeListings.filter(l =>
        l.suburb && l.suburb.toLowerCase().includes(suburbLower)
      );

      if (matchingListings.length > 0) {
        const listingDetails = matchingListings.slice(0, 2).map(l => {
          const parts = [l.address || l.suburb];
          if (l.bedrooms) parts.push(`${l.bedrooms}br`);
          if (l.property_type) parts.push(l.property_type);
          if (l.price_display) parts.push(l.price_display);
          if (l.listing_type) parts.push(l.listing_type);
          return parts.join(' ');
        }).join('; ');
        parts.push(`LISTING MATCH: Lead is asking about ${currentLeadSuburb} — you have ${matchingListings.length} active listing(s) there: ${listingDetails}. Mention these naturally.`);
      }
    }

    if (intelligence.activeListings.length > 0) {
      const listingCount = intelligence.activeListings.length;
      const suburbs = [...new Set(intelligence.activeListings.map(l => l.suburb).filter(Boolean))].slice(0, 4);
      if (suburbs.length > 0) {
        parts.push(`ACTIVE LISTINGS: ${listingCount} listing(s) across ${suburbs.join(', ')} — if a lead mentions any of these suburbs, mention the relevant listing`);
      }
    }
  }

  // High-intent unclosed leads — Hugo should prioritise pushing these
  if (intelligence.highIntentLeads && intelligence.highIntentLeads.length > 0) {
    const lead = intelligence.highIntentLeads[0]; // most urgent
    const others = intelligence.highIntentLeads.length - 1;
    parts.push(`HIGH-INTENT UNCLOSED: ${lead.lead_name || 'Lead'} (intent ${lead.intent_score}/10, ${lead.job_type || 'job'}, ${lead.status}) — ${others > 0 ? `+${others} more. ` : ''}If operator asks about pipeline, highlight these — they need follow-up`);
  }

  if (parts.length === 0) return '';

  return `LEAD INTELLIGENCE (use naturally, don't lecture — integrate into conversation):
${parts.join('\n')}`;
}

module.exports = {
  fetchContextIntelligence,
  formatIntelligencePrompt,
  clearIntelligenceCache,
};
