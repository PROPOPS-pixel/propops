/**
 * Landing Page Sync Service
 *
 * Parses PropOps landing pages (from local HTML files) and extracts structured
 * data: pricing, offer terms, services, CTA copy, phone number, and Stripe URLs.
 *
 * Stores results in `landing_page_content` table. On change, logs a diff so
 * Hugo always quotes the exact copy that visitors just read on the page.
 *
 * Runs:
 *  - On every server startup (post-deploy hook)
 *  - Daily at midnight AEST via in-process scheduler
 *  - On demand via POST /api/admin/sync-landing-pages
 */

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ─── DB pool (shared-pool-friendly: accepts external pool or creates one) ─────

let _pool = null;
function getPool() {
  if (_pool) return _pool;
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
  });
  return _pool;
}

// ─── HTML parsing helpers ─────────────────────────────────────────────────────

/**
 * Extract first regex match from HTML, return null if not found.
 */
function extract(html, regex) {
  const m = html.match(regex);
  return m ? m[1].trim() : null;
}

/**
 * Extract all unique regex matches from HTML.
 */
function extractAll(html, regex) {
  const results = [];
  let m;
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  while ((m = re.exec(html)) !== null) {
    const val = m[1].trim();
    if (val && !results.includes(val)) results.push(val);
  }
  return results;
}

/**
 * Strip HTML tags and decode basic entities from a string.
 */
function stripTags(str) {
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Landing page parser ──────────────────────────────────────────────────────

/**
 * Parse a PropOps landing page HTML file and return a structured content object.
 *
 * @param {string} domain     - 'propops.trade' | 'propops.pro'
 * @param {string} htmlPath   - absolute path to the HTML file
 * @returns {object}          - structured landing page content
 */
function parseLandingPage(domain, htmlPath) {
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`Landing page not found: ${htmlPath}`);
  }
  const html = fs.readFileSync(htmlPath, 'utf8');

  // ── Pricing ────────────────────────────────────────────────────────────────
  // Early bird monthly price — look for patterns like "$69/mo" or "$69/month"
  const earlyBirdMatch = html.match(/\$(\d+)\/mo(?:nth)?(?:\s+(?:AUD|locked|early))?/i);
  const earlyBirdAmount = earlyBirdMatch ? parseInt(earlyBirdMatch[1], 10) : null;

  // Standard price (usually shown as "then $99/mo" or "regular $99")
  const standardMatch = html.match(/(?:then|regular|standard|after\s+June\s+30)[^\$]*\$(\d+)\/mo/i)
    || html.match(/\$(\d+)\/mo(?:nth)?\s+(?:AUD\s*)?(?:after|standard|regular)/i);
  const standardAmount = standardMatch ? parseInt(standardMatch[1], 10) : 99;

  // Annual price — handles "$999/yr", "$999/year", or split spans like
  // <span class="price-num">999</span> near "year" context
  const annualMatch = html.match(/\$(\d{3,4})\/yr(?:ear)?/i)
    || html.match(/\$(\d{3,4})\s*\/\s*yr/i)
    || html.match(/price-num[^>]*>(\d{3,4})<\/span>\s*<span[^>]*>[^<]*(?:yr|year)/i)
    || html.match(/(\d{3,4})\s*<\/span>\s*<span[^>]*class="[^"]*price[^"]*"[^>]*>\s*\/\s*yr/i);
  const annualAmount = annualMatch ? parseInt(annualMatch[1], 10) : null;

  // Currency — AUD for all PropOps pages
  const currency = 'AUD';

  const pricingDisplay = earlyBirdAmount ? `$${earlyBirdAmount}/month` : `$${standardAmount}/month`;

  // ── Offer terms ────────────────────────────────────────────────────────────
  const trialMatch = html.match(/(\d+)-day\s+free\s+trial/i);
  const trialDays = trialMatch ? parseInt(trialMatch[1], 10) : 14;

  // Lock text — "Locked for life" / "locked in for life" / "locked forever"
  const lockTextMatch = html.match(/(locked\s+(?:in\s+)?for\s+life|locked\s+forever)/i);
  const lockText = lockTextMatch ? lockTextMatch[1].replace(/\s+/g, ' ') : 'Locked for life';

  // Deadline — look for "before June 30" / "June 30, 2026"
  const deadlineMatch = html.match(/(?:before\s+)?([A-Z][a-z]+\s+\d+,?\s+\d{4})/);
  const deadline = deadlineMatch ? deadlineMatch[1].replace(',', '').trim() : null;

  // Cancel policy
  const cancelMatch = html.match(/Cancel\s+any\s*time/i);
  const cancelPolicy = cancelMatch ? 'Cancel anytime' : null;

  // ── Services ───────────────────────────────────────────────────────────────
  // Look for the trade pills section — individual trade items
  const serviceMatches = [];

  // Method 1: look for explicit trade lists in spans/pills.
  // Match class="trade-pill" / "trade pill" / "service-tag" etc.
  // Exclude classes that merely contain "tag" as a substring (e.g. "pwa-tag-title").
  // Valid class patterns: trade-pill, trade_pill, service-pill, job-pill, trade-tag, etc.
  // Excluded: pwa-tag-title, tag-title, any "-tag-" compound that isn't the full class.
  const tradePillRegex = /<(?:span|div|li)[^>]*class="[^"]*\b(?:trade[-_]pill|service[-_]pill|job[-_]pill|trade[-_]tag|service[-_]tag|pill)\b[^"]*"[^>]*>([^<]+)<\/(?:span|div|li)>/gi;
  let pillMatch;
  while ((pillMatch = tradePillRegex.exec(html)) !== null) {
    // Strip HTML tags, emojis, and leading/trailing whitespace
    const rawTrade = stripTags(pillMatch[1]);
    const trade = rawTrade.replace(/[\u{1F000}-\u{1FFFF}]|[\u2600-\u27FF]|[\uFE00-\uFE0F]/gu, '').trim();
    // Skip JS template artifacts, overly long strings, or strings with + signs
    if (trade && trade.length < 40 && !trade.includes('+') && !trade.includes('${') && !serviceMatches.includes(trade)) {
      serviceMatches.push(trade);
    }
  }

  // Method 2: if pills didn't yield enough results, fall back to a domain-appropriate list.
  // - propops.trade: authoritative 22-trade list (keyword-scan the HTML to confirm presence)
  // - propops.pro: RE-specific service list (what the RE agent product covers)
  if (serviceMatches.length < 5) {
    if (domain === 'propops.trade') {
      const knownTrades = [
        'Plumber', 'Electrician', 'Lawn Care', 'Pool Cleaning', 'Carpet Cleaning',
        'Pest Control', 'Commercial Cleaning', 'Bricklayer', 'Concreter', 'Painter',
        'Renderer', 'Tiler', 'Plasterer', 'Roofer', 'Fencer', 'Waterproofer',
        'Builder', 'Locksmith', 'Appliance Repair', 'Removalist', 'General Tradie',
        'Handyman', 'Cleaner', 'Landscaper', 'Carpenter', 'Pool Tech', 'HVAC',
        'Solar Installer', 'Glazier'
      ];
      knownTrades.forEach(trade => {
        const re = new RegExp(`\\b${trade}\\b`, 'i');
        if (re.test(html) && !serviceMatches.includes(trade)) {
          serviceMatches.push(trade);
        }
      });
    } else {
      // propops.pro — RE agent services
      const reServices = [
        'Inspection Booking', 'Buyer Qualification', 'Lead Response',
        'Open Home RSVP', 'Offer Handling', 'Portal Lead Sync',
        'Maintenance Coordination', 'Trade Referrals', 'Rental Appraisals'
      ];
      reServices.forEach(svc => {
        if (!serviceMatches.includes(svc)) serviceMatches.push(svc);
      });
    }
  }

  // ── CTA copy ───────────────────────────────────────────────────────────────
  // Hook: H1 or hero headline
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const hookText = h1Match ? stripTags(h1Match[1]) : null;

  // Dream: look for the dream/value-prop section (contains "Bali" or "admin" phrasing)
  const dreamMatch = html.match(/(['"])[^'"]*(?:Bali|admin|business|autopilot)[^'"]*\1/)
    || html.match(/>[^<]*(?:business open 24\/7|admin while)[^<]*</i);
  const dreamText = dreamMatch ? stripTags(dreamMatch[0]) : null;

  // Closer: the final/closing CTA copy
  const closerMatch = html.match(/<h2[^>]*class="[^"]*(?:closer|final|cta)[^"]*"[^>]*>([\s\S]*?)<\/h2>/i)
    || html.match(/bloody no-brainer[^<]*/i);
  const closerText = closerMatch ? stripTags(closerMatch[0]) : null;

  // ── Phone ──────────────────────────────────────────────────────────────────
  const phoneMatch = html.match(/(?:tel:|📞\s*)?(0[23]\s*[-–]?\s*\d{4}\s*[-–]?\s*\d{4})/);
  const phone = phoneMatch ? phoneMatch[1].replace(/\s/g, '-') : '02-5301-0002';

  // ── Stripe URLs ────────────────────────────────────────────────────────────
  const stripeUrls = extractAll(html, /href="(https:\/\/buy\.stripe\.com\/[^"]+)"/i);

  // Distinguish monthly vs annual by their IDs
  const monthlyStripeUrl = stripeUrls.find(u => u.includes('dRmbJ1bqw89v4Jj0')) || stripeUrls[0] || null;
  const annualStripeUrl  = stripeUrls.find(u => u.includes('9B63cvams0H37Vvf')) || stripeUrls[1] || null;

  // ── Build result ───────────────────────────────────────────────────────────
  return {
    domain,
    pricing: {
      early_bird_monthly: earlyBirdAmount,
      standard_monthly: standardAmount,
      annual: annualAmount,
      currency,
      display: pricingDisplay,
      early_bird_display: earlyBirdAmount ? `$${earlyBirdAmount}/month` : null,
      standard_display: `$${standardAmount}/month`,
      annual_display: annualAmount ? `$${annualAmount}/year` : null,
    },
    offer: {
      trial_days: trialDays,
      lock_text: lockText.charAt(0).toUpperCase() + lockText.slice(1),
      deadline,
      cancel_policy: cancelPolicy,
    },
    services: serviceMatches,
    cta_copy: {
      hook: hookText,
      dream: dreamText,
      closer: closerText,
    },
    phone,
    stripe_urls: {
      monthly: monthlyStripeUrl,
      annual: annualStripeUrl,
    },
    scraped_at: new Date().toISOString(),
  };
}

// ─── DB upsert ────────────────────────────────────────────────────────────────

/**
 * Upsert a parsed content object into landing_page_content.
 * Saves previous snapshot for diff detection.
 * Returns { domain, changed, diff } — diff is array of changed keys.
 */
async function upsertContent(pool, parsed) {
  const { domain, ...rest } = parsed;

  // Fetch current row
  const existing = await pool.query(
    `SELECT content FROM landing_page_content WHERE domain = $1`,
    [domain]
  );

  const prevContent = existing.rows.length > 0 ? existing.rows[0].content : null;

  // Diff: compare serialised versions of key fields
  const diff = [];
  if (prevContent) {
    const keys = ['pricing', 'offer', 'services', 'phone', 'stripe_urls'];
    for (const key of keys) {
      const oldVal = JSON.stringify(prevContent[key]);
      const newVal = JSON.stringify(rest[key]);
      if (oldVal !== newVal) {
        diff.push({ key, old: prevContent[key], new: rest[key] });
      }
    }
  }

  // Upsert
  await pool.query(`
    INSERT INTO landing_page_content (domain, content, prev_content, scraped_at, updated_at)
    VALUES ($1, $2, $3, NOW(), NOW())
    ON CONFLICT (domain) DO UPDATE SET
      prev_content = landing_page_content.content,
      content      = EXCLUDED.content,
      scraped_at   = NOW(),
      updated_at   = NOW()
  `, [domain, JSON.stringify(rest), prevContent ? JSON.stringify(prevContent) : null]);

  return { domain, changed: diff.length > 0, diff, prevContent };
}

// ─── Main sync function ───────────────────────────────────────────────────────

const LANDING_PAGES = [
  {
    domain: 'propops.trade',
    file: path.join(__dirname, '..', 'public', 'propops-trade.html'),
  },
  {
    domain: 'propops.pro',
    file: path.join(__dirname, '..', 'public', 'index.html'),
  },
];

/**
 * Sync all landing pages. Returns array of result objects.
 * Safe to call at startup — won't crash the server if it fails.
 */
async function syncLandingPages(injectedPool) {
  const pool = injectedPool || getPool();
  const results = [];

  for (const { domain, file } of LANDING_PAGES) {
    try {
      const parsed   = parseLandingPage(domain, file);
      const result   = await upsertContent(pool, parsed);

      if (result.changed) {
        console.log(`[LandingSync] ${domain} CHANGED:`);
        result.diff.forEach(d => {
          console.log(`  ${d.key}: ${JSON.stringify(d.old)} → ${JSON.stringify(d.new)}`);
        });
      } else {
        console.log(`[LandingSync] ${domain} — no changes`);
      }

      results.push({ domain, ok: true, changed: result.changed, diff: result.diff, content: parsed });
    } catch (err) {
      console.error(`[LandingSync] Failed to sync ${domain}: ${err.message}`);
      results.push({ domain, ok: false, error: err.message });
    }
  }

  return results;
}

// ─── getLandingPageContent — used by Hugo prompt injection ───────────────────

/**
 * Fetch latest landing page content for a given domain.
 * Returns the parsed JSONB content object or null if not yet synced.
 *
 * @param {string} domain - 'propops.trade' | 'propops.pro'
 * @param {object} [injectedPool] - optional pg Pool (for testing)
 */
async function getLandingPageContent(domain, injectedPool) {
  const pool = injectedPool || getPool();
  try {
    const row = await pool.query(
      `SELECT content FROM landing_page_content WHERE domain = $1`,
      [domain]
    );
    return row.rows.length > 0 ? row.rows[0].content : null;
  } catch (err) {
    console.error(`[LandingSync] getLandingPageContent(${domain}) failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  syncLandingPages,
  getLandingPageContent,
  parseLandingPage, // exported for testing
};
