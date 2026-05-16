const { Pool } = require('pg');
const { sendEmail } = require('./email');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

/**
 * Infer lead type from property_interest text and source portal.
 * Used at both write-time (createLead) and read-time (normalizeLeadContact)
 * to catch leads that the parser/AI missed.
 *
 * @param {string} propertyInterest - cleaned property interest text
 * @param {string} source - lead source (e.g. 'REA', 'Rent.com.au', 'Facebook')
 * @returns {string|null} - 'buyer', 'renter', 'seller', 'landlord', or null
 */
function inferLeadType(propertyInterest, source) {
  const pi = (propertyInterest || '').toLowerCase();

  // Buyer signals — "for sale", "auction", etc. in property text
  if (/\b(for sale|buy|buyer|buyers|auction|purchas\w*|pre[- ]?approv\w*|first home buyer|investment property)\b/.test(pi)) return 'buyer';
  // Renter signals
  if (/\b(for rent|rental|renter|renters|renting|lease|tenant|move[- ]?in)\b/.test(pi)) return 'renter';
  // Seller signals
  if (/\b(sell|selling|appraisal|market value|list my|listing my)\b/.test(pi)) return 'seller';
  // Landlord signals
  if (/\b(landlord|property management|rental management)\b/.test(pi)) return 'landlord';

  // Source-based fallback — portal name strongly implies lead type
  const src = (source || '').toLowerCase();
  if (/rent\.com\.au|rent/i.test(src)) return 'renter';

  return null;
}

/**
 * Validate that a string looks like a real Australian phone number.
 * Returns true for valid phone formats, false for addresses or garbage data.
 *
 * Valid: "0412 345 678", "+61 2 9876 5432", "0298765432", "04 1234 5678"
 * Invalid: "612 HENRY L DRIVE EAST HILLS", "N/A", "not provided", ""
 */
function isValidPhone(phone) {
  if (!phone) return false;
  // Strip common separators to get raw content
  const stripped = phone.replace(/[\s\-\(\)\+]/g, '');
  // Must be all digits after stripping separators
  if (!/^\d+$/.test(stripped)) return false;
  // Australian numbers: 10 digits starting with 0, or 11 digits starting with 61
  if (/^0[2-9]\d{8}$/.test(stripped)) return true;       // 04xx xxx xxx, 02 xxxx xxxx
  if (/^61[2-9]\d{8}$/.test(stripped)) return true;      // +61 4xx xxx xxx
  // Allow 8-digit local numbers (landlines without area code)
  if (/^\d{8}$/.test(stripped)) return true;
  return false;
}

/**
 * Normalize lead contact data on read.
 *
 * Fixes a historical bug where the email parser embedded the lead's actual
 * email and phone inside the `name` field (e.g. "Sarah Mitchell Email:
 * sarah.mitchell@outlook.com.au Mobile: 0438 221 764") while the `email`
 * column stored the forwarder's address.
 *
 * Also validates the phone field — if it contains non-phone data (like a
 * street address), it's nulled out so the UI shows "Not provided" instead
 * of displaying garbage in the phone field.
 *
 * This runs on every read so existing leads display correctly without a
 * data migration.
 */
function normalizeLeadContact(lead) {
  if (!lead) return lead;

  // ── Strip "enquiry for:" prefix from property_interest on read ──
  // Fixes legacy data where the prefix leaked through from Domain.com.au emails
  if (lead.property_interest) {
    lead.property_interest = lead.property_interest
      .replace(/^(?:enquiry|inquiry)\s+for\s*:\s*/i, '')
      .trim();
  }

  // ── Validate phone field — reject non-phone data (e.g. street addresses) ──
  // Fixes bug where AI parser or legacy code stored addresses in the phone column.
  // "612 HENRY L DRIVE EAST HILLS" is an address, not a phone number.
  if (lead.phone && !isValidPhone(lead.phone)) {
    lead.phone = null;
  }

  // ── Retroactively infer lead_type for old leads that have null ──
  // Catches leads created before lead_type detection was added/fixed.
  if (!lead.lead_type && lead.property_interest) {
    lead.lead_type = inferLeadType(lead.property_interest, lead.source);
  }

  if (!lead.name) return lead;

  // Detect embedded "Email: ..." in the name field
  const embeddedEmail = lead.name.match(/\bEmail\s*:?\s*([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/i);
  // Detect embedded "Mobile: ..." or "Phone: ..." in the name field
  const embeddedPhone = lead.name.match(/\b(?:Mobile|Phone|Ph|Tel)\s*:?\s*((?:\+?61[\s\-]?)?0[2-9](?:[\s\-]?\d){8})/i);

  if (!embeddedEmail && !embeddedPhone) return lead; // name is clean

  // If name has an embedded email, it's the lead's real email — prefer it
  if (embeddedEmail) {
    lead.email = embeddedEmail[1];
  }

  // If name has an embedded phone and lead.phone is missing, extract it
  if (embeddedPhone && !lead.phone) {
    lead.phone = embeddedPhone[1].trim().replace(/\s+/g, ' ');
  }

  // Clean the name — remove embedded Email/Phone fields
  lead.name = lead.name
    .replace(/\s*(?:Email|E-mail)\s*:?\s*[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/gi, '')
    .replace(/\s*(?:Mobile|Phone|Ph|Tel|Contact number|Phone number)\s*:?\s*(?:\+?61[\s\-]?)?0[2-9](?:[\s\-]?\d){8}/gi, '')
    .trim();

  return lead;
}

/**
 * Create a new lead
 */
async function createLead({ name, email, phone, property_interest, property_listing_url, lead_type, source, notes, metadata, user_id }) {
  const validLeadTypes = ['buyer', 'renter', 'seller', 'landlord'];
  const normalizedLeadType = lead_type && validLeadTypes.includes(lead_type.toLowerCase())
    ? lead_type.toLowerCase()
    : null;

  // ── Clean "enquiry for:" prefix at write time ──────────────────────────────
  // Belt-and-suspenders: the parser should already strip this, but in case it
  // leaks through (Domain.com.au emails use "Property enquiry for: ADDRESS"),
  // clean it here before INSERT so the DB never stores the prefix.
  const cleanedPropertyInterest = property_interest
    ? property_interest.replace(/^(?:enquiry|inquiry)\s+for\s*:\s*/i, '').trim() || null
    : null;

  // ── Infer lead_type from property_interest + source when missing ───────────
  // If the parser/AI didn't detect lead type, use clear signals in the property text.
  let finalLeadType = normalizedLeadType;
  if (!finalLeadType && cleanedPropertyInterest) {
    finalLeadType = inferLeadType(cleanedPropertyInterest, source);
  }

  // ── Validate phone at write time — reject non-phone data ────────────────
  // Prevents AI parser from storing addresses (e.g. "612 HENRY L DRIVE") as phone.
  const validatedPhone = (phone && isValidPhone(phone)) ? phone : null;

  const result = await pool.query(
    `INSERT INTO leads (name, email, phone, property_interest, property_listing_url, lead_type, source, notes, metadata, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [name, email || null, validatedPhone, cleanedPropertyInterest, property_listing_url || null, finalLeadType, source || 'website', notes || null, metadata || {}, user_id || null]
  );
  return result.rows[0];
}

/**
 * Update specific fields on a lead (property_listing_url, notes, etc.)
 */
async function updateLead(id, fields) {
  const allowed = ['property_listing_url', 'property_interest', 'notes', 'name', 'email', 'phone', 'lead_type', 'source'];
  const updates = [];
  const values = [];
  let paramIndex = 1;

  // Validate phone field if being updated — reject non-phone data
  if ('phone' in fields && fields.phone && !isValidPhone(fields.phone)) {
    fields.phone = null;
  }

  for (const key of allowed) {
    if (key in fields) {
      updates.push(`${key} = $${paramIndex++}`);
      values.push(fields[key] !== undefined ? fields[key] : null);
    }
  }

  if (updates.length === 0) return null;

  updates.push(`updated_at = NOW()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE leads SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result.rows[0];
}

/**
 * Get all leads with optional filters
 * @param {Object} options - Filter options
 * @param {string} options.status - Filter by status
 * @param {string} options.source - Filter by source
 * @param {string} options.lead_type - Filter by lead type
 * @param {string} options.search - Search in name, email, phone, property
 * @param {number} options.limit - Max results
 * @param {number} options.offset - Pagination offset
 * @param {boolean} options.include_simulated - Include test leads (default: true)
 */
async function getLeads({ status, source, lead_type, search, limit = 50, offset = 0, include_simulated = true, userId } = {}) {
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  // Always scope by user if provided
  if (userId) {
    conditions.push(`l.user_id = $${paramIndex++}`);
    params.push(userId);
  }

  // Exclude simulated leads (both flagged and legacy) unless explicitly included
  if (!include_simulated) {
    conditions.push(`(
      (l.metadata->>'is_simulated' IS NULL OR l.metadata->>'is_simulated' != 'true')
      AND l.id NOT IN (
        SELECT parsed_lead_id FROM raw_emails
        WHERE raw_payload->>'simulated' = 'true'
          AND parsed_lead_id IS NOT NULL
      )
    )`);
  }

  if (status) {
    conditions.push(`l.status = $${paramIndex++}`);
    params.push(status);
  }
  if (source) {
    conditions.push(`l.source = $${paramIndex++}`);
    params.push(source);
  }
  if (lead_type) {
    conditions.push(`l.lead_type = $${paramIndex++}`);
    params.push(lead_type.toLowerCase());
  }
  if (search) {
    conditions.push(`(l.name ILIKE $${paramIndex} OR l.email ILIKE $${paramIndex} OR l.phone ILIKE $${paramIndex} OR l.property_interest ILIKE $${paramIndex})`);
    params.push(`%${search}%`);
    paramIndex++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM leads l ${where}`,
    params
  );

  const result = await pool.query(
    `SELECT l.*,
      (SELECT COUNT(*) FROM lead_responses lr WHERE lr.lead_id = l.id) as response_count,
      (SELECT lr.created_at FROM lead_responses lr WHERE lr.lead_id = l.id ORDER BY lr.created_at DESC LIMIT 1) as last_response_at,
      CASE
        WHEN l.metadata->>'is_simulated' = 'true' THEN true
        WHEN EXISTS (SELECT 1 FROM raw_emails re WHERE re.parsed_lead_id = l.id AND re.raw_payload->>'simulated' = 'true') THEN true
        ELSE false
      END as is_simulated
     FROM leads l
     ${where}
     ORDER BY l.created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
    [...params, limit, offset]
  );

  return {
    leads: result.rows.map(normalizeLeadContact),
    total: parseInt(countResult.rows[0].count),
    limit,
    offset
  };
}

/**
 * Get a single lead with its responses, activities, and original inquiry email
 */
async function getLeadById(id) {
  const leadResult = await pool.query('SELECT * FROM leads WHERE id = $1', [id]);
  if (leadResult.rows.length === 0) return null;

  const lead = leadResult.rows[0];

  const responsesResult = await pool.query(
    'SELECT * FROM lead_responses WHERE lead_id = $1 ORDER BY created_at DESC',
    [id]
  );

  const activitiesResult = await pool.query(
    'SELECT * FROM lead_activities WHERE lead_id = $1 ORDER BY created_at DESC',
    [id]
  );

  // Fetch the original inquiry email (raw_emails linked to this lead)
  const rawEmailResult = await pool.query(
    'SELECT id, from_address, subject, body_text, body_html, source_detected, received_at FROM raw_emails WHERE parsed_lead_id = $1 ORDER BY received_at ASC LIMIT 1',
    [id]
  );

  return normalizeLeadContact({
    ...lead,
    responses: responsesResult.rows,
    activities: activitiesResult.rows,
    raw_email: rawEmailResult.rows.length > 0 ? rawEmailResult.rows[0] : null
  });
}

/**
 * Update lead status
 */
async function updateLeadStatus(id, status) {
  const result = await pool.query(
    `UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [status, id]
  );
  return result.rows[0];
}

/**
 * Save an AI response for a lead
 */
async function saveLeadResponse(leadId, { response_text, response_type, channel, ai_model, ai_cost_usd }) {
  const result = await pool.query(
    `INSERT INTO lead_responses (lead_id, response_text, response_type, channel, ai_model, ai_cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [leadId, response_text, response_type || 'initial', channel || 'email', ai_model, ai_cost_usd]
  );
  return result.rows[0];
}

/**
 * Log a lead activity
 */
async function logActivity(leadId, activityType, description, metadata = {}) {
  const result = await pool.query(
    `INSERT INTO lead_activities (lead_id, activity_type, description, metadata)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [leadId, activityType, description, metadata]
  );
  return result.rows[0];
}

/**
 * Get dashboard stats
 */
async function getDashboardStats(userId, { include_simulated = true } = {}) {
  // include_simulated defaults to true (match getLeads default behavior).
  // When false, exclude simulated/test leads so pipeline counters match real data.
  const simulatedFilter = include_simulated
    ? '' // no filter — include all leads
    : `AND (l.metadata->>'is_simulated' IS DISTINCT FROM 'true')`;

  const baseFilter = include_simulated
    ? ''
    : ` AND (metadata->>'is_simulated' IS DISTINCT FROM 'true')`;
  const userClause = userId
    ? `WHERE user_id = $1${baseFilter}`
    : `WHERE 1=1${baseFilter}`;
  const userParams = userId ? [userId] : [];

  const result = await pool.query(`
    SELECT
      COUNT(*) as total_leads,
      COUNT(*) FILTER (WHERE status = 'new') as new_leads,
      COUNT(*) FILTER (WHERE status = 'contacted') as contacted,
      COUNT(*) FILTER (WHERE status = 'qualified') as qualified,
      COUNT(*) FILTER (WHERE status = 'viewing_booked') as viewing_booked,
      COUNT(*) FILTER (WHERE status = 'won') as won,
      COUNT(*) FILTER (WHERE status = 'lost') as lost,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') as last_24h,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as last_7d
    FROM leads
    ${userClause}
  `, userParams);

  const joinClause = userId
    ? `WHERE lr.response_type = 'initial' AND l.user_id = $1${simulatedFilter}`
    : `WHERE lr.response_type = 'initial'${simulatedFilter}`;
  const responseStats = await pool.query(`
    SELECT
      COUNT(*) as total_responses,
      COALESCE(SUM(ai_cost_usd), 0) as total_ai_cost,
      ROUND(AVG(EXTRACT(EPOCH FROM (lr.created_at - l.created_at)))::numeric, 1) as avg_response_time_seconds
    FROM lead_responses lr
    JOIN leads l ON l.id = lr.lead_id
    ${joinClause}
  `, userParams);

  return {
    pipeline: result.rows[0],
    responses: responseStats.rows[0]
  };
}

/**
 * Get the active intake token's forwarding_email (e.g. leads-abc@re.propops.pro).
 * Used as the From + Reply-To address on outbound lead responses so replies
 * route back through Resend inbound receiving.
 * Returns null if not configured (email will use default FROM_EMAIL).
 */
async function getIntakeForwardingEmail(userId) {
  try {
    // Try to find the forwarding email for this specific user first
    if (userId) {
      const result = await pool.query(
        `SELECT forwarding_email FROM intake_tokens
         WHERE is_active = true AND forwarding_email IS NOT NULL AND user_id = $1
         ORDER BY created_at ASC LIMIT 1`,
        [userId]
      );
      if (result.rows.length > 0) return result.rows[0].forwarding_email;
    }
    // Fallback: any active token (supports legacy single-tenant data)
    const fallback = await pool.query(
      `SELECT forwarding_email FROM intake_tokens
       WHERE is_active = true AND forwarding_email IS NOT NULL
       ORDER BY created_at ASC LIMIT 1`
    );
    return fallback.rows.length > 0 ? fallback.rows[0].forwarding_email : null;
  } catch {
    return null;
  }
}

/**
 * Send the AI-generated response to the lead via email.
 * Uses the agent's provisioned leads-xyz@re.propops.pro as From + Reply-To
 * so replies from leads route back through Resend inbound receiving.
 * Updates lead_responses.sent_at on success.
 * Returns { ok, provider } or { ok: false, reason }.
 */
async function sendResponseToLead(lead, responseRow) {
  if (!lead.email) {
    console.warn(`[Leads] Cannot email lead #${lead.id} — no email address`);
    return { ok: false, reason: 'no_email' };
  }

  // Use agent's intake address as From + Reply-To so lead replies come back via Resend
  const forwardingEmail = await getIntakeForwardingEmail(lead.user_id || null);

  const firstName = lead.name ? lead.name.split(' ')[0] : 'there';
  const propertyRef = lead.property_interest
    ? `your enquiry about ${lead.property_interest}`
    : 'your property enquiry';

  const subject = lead.property_interest
    ? `Re: ${lead.property_interest}`
    : 'Re: Your property enquiry';

  // Convert plain text response to HTML (preserve line breaks)
  const responseHtml = responseRow.response_text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;color:#0f172a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <tr><td style="padding:32px 40px;">
          <p style="margin:0;font-size:15px;color:#334155;line-height:1.7;">
            ${responseHtml}
          </p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #e2e8f0;background:#f8fafc;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">This email was sent by PropOps on behalf of your local agent.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = responseRow.response_text;

  try {
    const emailOpts = {
      to: lead.email,
      subject,
      html,
      text,
      tag: 'lead_response',
    };

    // If we have a provisioned intake address, use it as From + Reply-To
    // so lead replies arrive back through Resend inbound on propops.pro.
    if (forwardingEmail) {
      emailOpts.from_email = forwardingEmail;
      emailOpts.reply_to  = forwardingEmail;
    }

    const result = await sendEmail(emailOpts);

    if (result && result.ok) {
      // Mark the response as actually sent
      await pool.query(
        `UPDATE lead_responses SET sent_at = NOW() WHERE id = $1`,
        [responseRow.id]
      );
      console.log(`[Leads] ✅ Email sent to lead #${lead.id} (${lead.email}) via ${result.provider}`);
      return result;
    } else {
      console.error(`[Leads] ❌ Email to lead #${lead.id} (${lead.email}) failed — queued: ${result?.queued || false}`);
      return result || { ok: false, reason: 'send_failed' };
    }
  } catch (err) {
    console.error(`[Leads] ❌ Email send error for lead #${lead.id}:`, err.message);
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  createLead,
  updateLead,
  getLeads,
  getLeadById,
  updateLeadStatus,
  saveLeadResponse,
  sendResponseToLead,
  logActivity,
  getDashboardStats
};
