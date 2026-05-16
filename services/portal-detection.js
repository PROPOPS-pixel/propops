/**
 * Portal Detection Service
 *
 * Owns: portal sender registry lookups, operator portal connection tracking,
 *       first-forward confirmation flow.
 * Does NOT own: email parsing, lead creation, email sending infrastructure.
 *
 * Zero-config portal onboarding:
 *   Operator forwards ONE email from a portal → Hugo auto-detects the source
 *   and marks that portal as connected. No Gmail filters required.
 */

const { Pool } = require('pg');
const { sendEmail } = require('./email');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── Registry cache (refreshed every 5 minutes) ─────────────────────────────

let _registryCache = null;
let _registryCacheTs = 0;
const REGISTRY_TTL_MS = 5 * 60 * 1000;

/**
 * Load portal sender registry from DB (with TTL cache).
 * Falls back to hardcoded defaults if DB is unavailable.
 */
async function getPortalRegistry() {
  const now = Date.now();
  if (_registryCache && now - _registryCacheTs < REGISTRY_TTL_MS) {
    return _registryCache;
  }

  try {
    const result = await pool.query(
      `SELECT portal_key, portal_name, sender_domain, sender_pattern, parse_method
       FROM portal_sender_registry
       WHERE is_active = true
       ORDER BY display_order ASC`
    );
    _registryCache = result.rows;
    _registryCacheTs = now;
    return _registryCache;
  } catch (err) {
    console.warn('[Portal Detection] DB registry unavailable, using hardcoded fallback:', err.message);
    // Hardcoded fallback so detection works even if migration hasn't run yet
    _registryCache = [
      { portal_key: 'hipages',        portal_name: 'Hipages',        sender_domain: 'hipages.com.au',        parse_method: 'hipages'        },
      { portal_key: 'serviceseeking', portal_name: 'ServiceSeeking', sender_domain: 'serviceseeking.com.au', parse_method: 'serviceseeking' },
      { portal_key: 'airtasker',      portal_name: 'Airtasker',      sender_domain: 'airtasker.com',         parse_method: 'airtasker'      },
      { portal_key: 'oneflare',       portal_name: 'Oneflare',       sender_domain: 'oneflare.com.au',       parse_method: 'generic'        },
      { portal_key: 'bark',           portal_name: 'Bark',           sender_domain: 'bark.com',              parse_method: 'generic'        },
      { portal_key: 'facebook',       portal_name: 'Facebook',       sender_domain: 'facebookmail.com',      parse_method: 'facebook'       },
      { portal_key: 'google',         portal_name: 'Google Business',sender_domain: 'google.com',            parse_method: 'generic'        },
    ];
    _registryCacheTs = now;
    return _registryCache;
  }
}

/** Invalidate registry cache (used after DB write to portal_sender_registry). */
function invalidateRegistryCache() {
  _registryCache = null;
  _registryCacheTs = 0;
}

/**
 * Match a from_address against the portal registry.
 * Returns the matching registry row or null.
 *
 * @param {string} fromAddress - e.g. "leads@hipages.com.au"
 * @returns {{ portal_key, portal_name, sender_domain, parse_method } | null}
 */
async function detectPortalFromSender(fromAddress) {
  if (!fromAddress) return null;
  const fromLower = fromAddress.toLowerCase();
  const registry = await getPortalRegistry();

  for (const entry of registry) {
    // Domain match: from_address contains the sender_domain
    if (fromLower.includes(entry.sender_domain.toLowerCase())) {
      return entry;
    }
    // Optional regex pattern match
    if (entry.sender_pattern) {
      try {
        const re = new RegExp(entry.sender_pattern, 'i');
        if (re.test(fromAddress)) return entry;
      } catch (_) {
        // Bad regex in DB — skip
      }
    }
  }
  return null;
}

/**
 * Check whether this portal is already connected for the operator.
 * Returns true if connected, false if this is the first time.
 */
async function isPortalAlreadyConnected(userId, portalKey) {
  try {
    const result = await pool.query(
      `SELECT id FROM operator_portal_connections WHERE user_id = $1 AND portal_key = $2`,
      [userId, portalKey]
    );
    return result.rows.length > 0;
  } catch (err) {
    console.warn('[Portal Detection] Could not check existing connection:', err.message);
    return false; // assume not connected, so we register it
  }
}

/**
 * Register (or update) a portal connection for an operator.
 * On first connect: creates the record and returns isNew=true.
 * On subsequent emails: increments counters and returns isNew=false.
 *
 * @returns {{ isNew: boolean }}
 */
async function registerPortalConnection(userId, portalEntry, rawEmailId = null) {
  try {
    const result = await pool.query(
      `INSERT INTO operator_portal_connections
         (user_id, portal_key, portal_name, first_email_id, emails_count, last_email_at)
       VALUES ($1, $2, $3, $4, 1, NOW())
       ON CONFLICT (user_id, portal_key) DO UPDATE SET
         emails_count = operator_portal_connections.emails_count + 1,
         last_email_at = NOW()
       RETURNING (xmax = 0) AS is_new`,
      [userId, portalEntry.portal_key, portalEntry.portal_name, rawEmailId]
    );
    const isNew = result.rows[0]?.is_new || false;
    return { isNew };
  } catch (err) {
    console.error('[Portal Detection] Failed to register portal connection:', err.message);
    return { isNew: false };
  }
}

/**
 * Increment lead count for a portal connection.
 */
async function incrementPortalLeadCount(userId, portalKey) {
  try {
    await pool.query(
      `UPDATE operator_portal_connections SET leads_count = leads_count + 1
       WHERE user_id = $1 AND portal_key = $2`,
      [userId, portalKey]
    );
  } catch (err) {
    console.warn('[Portal Detection] Could not increment lead count:', err.message);
  }
}

/**
 * Send a confirmation email to the operator when a new portal is connected.
 *
 * If the email also contained a real lead, confirmWithLead=true signals that
 * the confirmation should mention the lead was processed too.
 */
async function sendPortalConnectionConfirmation(operatorEmail, operatorName, portalName, confirmWithLead = false) {
  if (!operatorEmail) return;

  const firstName = (operatorName || '').split(' ')[0] || 'there';
  const leadLine = confirmWithLead
    ? `<p style="margin:12px 0;color:#1e293b;">That email also had a <strong>live lead</strong> in it — Hugo has already picked it up and it's in your pipeline. 🎯</p>`
    : '';

  const html = `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
  <div style="background:#0f172a;padding:24px 28px;">
    <p style="margin:0;font-size:22px;font-weight:700;color:#f59e0b;">✅ ${portalName} connected</p>
  </div>
  <div style="padding:24px 28px;">
    <p style="margin:0 0 12px;color:#1e293b;font-size:15px;">G'day ${firstName},</p>
    <p style="margin:0 0 12px;color:#1e293b;">Hugo's locked in on <strong>${portalName}</strong>. From now on, every lead email from ${portalName} that lands in your inbox — just forward it and Hugo handles the rest.</p>
    ${leadLine}
    <p style="margin:12px 0;color:#64748b;font-size:13px;">Using other portals? Forward one email from each (Hipages, ServiceSeeking, Airtasker, Oneflare, Bark) and Hugo will connect them all.</p>
    <div style="margin-top:20px;padding:14px 18px;background:#f8fafc;border-radius:8px;border-left:3px solid #f59e0b;">
      <p style="margin:0;font-size:12px;color:#64748b;">🔒 <strong>Privacy note:</strong> Only emails you forward reach Hugo. Your personal emails are never touched.</p>
    </div>
  </div>
</div>`.trim();

  const text = `G'day ${firstName},\n\n${portalName} is now connected. Every lead email from ${portalName} you forward will be automatically captured.\n\n${confirmWithLead ? 'That email also had a live lead — Hugo picked it up.\n\n' : ''}Using other portals? Forward one email from each and Hugo will connect them all.\n\n🔒 Privacy: Only emails you forward reach Hugo. Your personal emails are never touched.`;

  try {
    await sendEmail({
      to: operatorEmail,
      subject: `✅ ${portalName} connected — Hugo is watching`,
      html,
      text,
      tag: 'transactional',
    });
    console.log(`[Portal Detection] Connection confirmation sent to ${operatorEmail} for ${portalName}`);
  } catch (err) {
    console.warn(`[Portal Detection] Could not send connection confirmation email: ${err.message}`);
  }
}

/**
 * Send an "unrecognised sender" email when a forwarded email doesn't match any portal.
 */
async function sendUnrecognisedPortalEmail(operatorEmail, operatorName, fromDomain) {
  if (!operatorEmail) return;

  const firstName = (operatorName || '').split(' ')[0] || 'there';

  const html = `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
  <div style="background:#0f172a;padding:24px 28px;">
    <p style="margin:0;font-size:22px;font-weight:700;color:#f59e0b;">🤔 Unknown portal</p>
  </div>
  <div style="padding:24px 28px;">
    <p style="margin:0 0 12px;color:#1e293b;font-size:15px;">G'day ${firstName},</p>
    <p style="margin:0 0 12px;color:#1e293b;">Got your forwarded email${fromDomain ? ` from <strong>${fromDomain}</strong>` : ''}, but Hugo doesn't recognise this portal yet.</p>
    <p style="margin:0 0 12px;color:#64748b;">Hugo works with: Hipages, ServiceSeeking, Airtasker, Oneflare, Bark, Facebook, and Google Business. If you're using a different portal, reply to this email and let us know — we'll add it.</p>
    <div style="margin-top:20px;padding:14px 18px;background:#f8fafc;border-radius:8px;border-left:3px solid #f59e0b;">
      <p style="margin:0;font-size:12px;color:#64748b;">🔒 <strong>Privacy note:</strong> Only emails you forward reach Hugo. Your personal emails are never touched.</p>
    </div>
  </div>
</div>`.trim();

  const text = `G'day ${firstName},\n\nGot your forwarded email${fromDomain ? ` from ${fromDomain}` : ''}, but Hugo doesn't recognise this portal yet.\n\nHugo works with: Hipages, ServiceSeeking, Airtasker, Oneflare, Bark, Facebook, and Google Business. If you're using a different portal, reply and let us know.\n\n🔒 Privacy: Only emails you forward reach Hugo. Your personal emails are never touched.`;

  try {
    await sendEmail({
      to: operatorEmail,
      subject: `🤔 Unrecognised portal — let us know which one`,
      html,
      text,
      tag: 'transactional',
    });
    console.log(`[Portal Detection] Unrecognised portal email sent to ${operatorEmail}`);
  } catch (err) {
    console.warn(`[Portal Detection] Could not send unrecognised portal email: ${err.message}`);
  }
}

/**
 * Get all connected portals for an operator (for the Integrations panel).
 * This is the authoritative source post-migration — falls back to raw_emails inference.
 */
async function getOperatorPortalStatuses(userId, intakeToken) {
  const registry = await getPortalRegistry();

  // Primary: operator_portal_connections table
  let connections = [];
  try {
    const result = await pool.query(
      `SELECT portal_key, portal_name, emails_count, leads_count, connected_at, last_email_at
       FROM operator_portal_connections WHERE user_id = $1`,
      [userId]
    );
    connections = result.rows;
  } catch (err) {
    console.warn('[Portal Detection] Could not read operator_portal_connections:', err.message);
  }
  const connectionMap = {};
  connections.forEach(c => { connectionMap[c.portal_key] = c; });

  // Fallback: infer from raw_emails (pre-migration data)
  let rawEmailRows = [];
  if (intakeToken) {
    try {
      const result = await pool.query(
        `SELECT source_detected, from_address FROM raw_emails
         WHERE token = $1 AND received_at >= NOW() - INTERVAL '90 days'`,
        [intakeToken]
      );
      rawEmailRows = result.rows;
    } catch (_) {}
  }

  return registry.map(entry => {
    const conn = connectionMap[entry.portal_key];
    if (conn) {
      return {
        key: entry.portal_key,
        name: entry.portal_name,
        connected: true,
        emails_count: conn.emails_count,
        leads_count: conn.leads_count,
        connected_at: conn.connected_at,
        last_email_at: conn.last_email_at,
      };
    }

    // Fallback inference from raw_emails
    const connectedViaRaw = rawEmailRows.some(row => {
      const srcLower = (row.source_detected || '').toLowerCase();
      const fromLower = (row.from_address || '').toLowerCase();
      return srcLower.includes(entry.portal_key) || fromLower.includes(entry.sender_domain);
    });

    return {
      key: entry.portal_key,
      name: entry.portal_name,
      connected: connectedViaRaw,
      emails_count: 0,
      leads_count: 0,
      connected_at: null,
      last_email_at: null,
    };
  });
}

module.exports = {
  detectPortalFromSender,
  isPortalAlreadyConnected,
  registerPortalConnection,
  incrementPortalLeadCount,
  sendPortalConnectionConfirmation,
  sendUnrecognisedPortalEmail,
  getOperatorPortalStatuses,
  invalidateRegistryCache,
};
