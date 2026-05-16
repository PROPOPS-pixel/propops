/**
 * Lead Referral Service
 *
 * Owns: routing out-of-area leads to covering PropOps operators, creating
 *       hugo_referral_leads records, duplicating lead to receiving operator's
 *       queue, notifying receiving operator by email.
 * Does NOT own: geocoding/haversine (service-area.js), Hugo AI conversation
 *               (routes/hugo-brain.js), referral CRUD API (routes/referrals.js).
 *
 * Main entry: routeOutOfAreaLead(operatorId, leadInfo)
 *   Returns { referred: true, receivingOperatorName, hugoMessage }
 *        OR { referred: false, reason: 'no_coverage', hugoMessage }
 */

'use strict';

const { Pool } = require('pg');
const { sendEmail } = require('./email');
const { findCoveringOperators, geocodeAddress } = require('./service-area');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

const APP_URL = process.env.APP_URL || 'https://propopspro.polsia.app';

// ─── Route an out-of-area lead ────────────────────────────────────────────────
// leadInfo: { name, phone, email, suburb, tradeType, description, leadId? }
// operatorId: the operator whose service area does NOT cover this lead
//
// Returns:
//   { referred: true, receivingOperatorName, receivingOperatorId, hugoMessage }
//   { referred: false, reason: 'no_coverage', hugoMessage }

async function routeOutOfAreaLead(operatorId, leadInfo) {
  const { name, phone, email, suburb, tradeType, description, leadId } = leadInfo;

  // Geocode the lead's suburb for distance-aware matching
  let leadCoords = null;
  if (suburb) {
    leadCoords = await geocodeAddress(suburb).catch(() => null);
  }

  // Find operators who cover this suburb
  let candidates;
  try {
    candidates = await findCoveringOperators(tradeType || null, suburb || '', leadCoords, operatorId);
  } catch (err) {
    console.error('[LeadReferral] findCoveringOperators error:', err.message);
    candidates = [];
  }

  if (candidates.length === 0) {
    // No one covers this suburb — log as unserviced
    await markLeadUnserviced(leadId, suburb);
    console.log(`[LeadReferral] No coverage for suburb="${suburb}" trade="${tradeType}" — unserviced`);
    return {
      referred: false,
      reason: 'no_coverage',
      hugoMessage: suburb
        ? `Sorry, I don't have anyone covering ${suburb} just yet. I've taken your details and I'll personally reach out when we have a ${tradeType || 'tradie'} in your area.`
        : `Sorry, I don't have anyone covering that area right now. Let me take your details and I'll follow up when we do.`,
    };
  }

  const receiver = candidates[0]; // Closest operator first

  // Create referral record
  let referralId;
  try {
    const refResult = await pool.query(
      `INSERT INTO hugo_referral_leads
         (operator_id, receiving_operator_id, lead_id, lead_name, lead_suburb,
          lead_trade_type, lead_description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING id`,
      [operatorId, receiver.operatorId, leadId || null, name || null,
       suburb || null, tradeType || null, description || null]
    );
    referralId = refResult.rows[0].id;
  } catch (err) {
    console.error('[LeadReferral] Failed to create referral record:', err.message);
    // Non-fatal — still duplicate the lead
  }

  // Duplicate lead to receiving operator's queue (source=referral)
  if (leadId) {
    await duplicateLeadToOperator(leadId, receiver.operatorId, operatorId, referralId).catch(err => {
      console.error('[LeadReferral] duplicateLeadToOperator error:', err.message);
    });
  } else {
    // Create a fresh lead record for the receiving operator
    await createReferredLead(receiver.operatorId, leadInfo, operatorId, referralId).catch(err => {
      console.error('[LeadReferral] createReferredLead error:', err.message);
    });
  }

  // Mark original lead as referred
  if (leadId) {
    pool.query(
      `UPDATE operator_widget_leads
       SET referral_status = 'referred', lead_suburb = $1, updated_at = NOW()
       WHERE id = $2`,
      [suburb || null, leadId]
    ).catch(() => {});
  }

  // Email notification to receiving operator (non-blocking)
  sendReferralNotification(receiver, { name, phone, email, suburb, tradeType, description }, referralId).catch(err => {
    console.error('[LeadReferral] sendReferralNotification error (non-fatal):', err.message);
  });

  const distText = receiver.distance_km != null
    ? ` (${Math.round(receiver.distance_km)}km from ${suburb})`
    : '';

  console.log(`[LeadReferral] Referred lead from op=${operatorId} to op=${receiver.operatorId}${distText} suburb="${suburb}"`);

  return {
    referred: true,
    receivingOperatorId: receiver.operatorId,
    receivingOperatorName: receiver.name,
    referralId,
    hugoMessage: `No worries — I know a great ${tradeType || 'tradie'} closer to ${suburb || 'your area'}. Let me get them onto it for you.`,
  };
}

// ─── Mark a lead as unserviced (no coverage) ────────────────────────────────

async function markLeadUnserviced(leadId, suburb) {
  if (!leadId) return;
  await pool.query(
    `UPDATE operator_widget_leads
     SET referral_status = 'unserviced', lead_suburb = $1, updated_at = NOW()
     WHERE id = $2`,
    [suburb || null, leadId]
  ).catch(() => {});
}

// ─── Duplicate an existing lead to a receiving operator ──────────────────────

async function duplicateLeadToOperator(originalLeadId, receivingOperatorId, fromOperatorId, referralId) {
  const orig = await pool.query(
    `SELECT name, phone, email, message, suburb, status, source, job_type,
            intent_score, rough_quote, lead_suburb, lead_lat, lead_lng
     FROM operator_widget_leads WHERE id = $1`,
    [originalLeadId]
  );
  if (!orig.rows[0]) return;

  const lead = orig.rows[0];
  await pool.query(
    `INSERT INTO operator_widget_leads
       (operator_id, name, phone, email, message, suburb, status, source, job_type,
        intent_score, rough_quote, lead_suburb, lead_lat, lead_lng, referral_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'new', 'referral', $7, $8, $9, $10, $11, $12, 'in_area')`,
    [receivingOperatorId, lead.name, lead.phone, lead.email, lead.message,
     lead.suburb || lead.lead_suburb, lead.job_type, lead.intent_score, lead.rough_quote,
     lead.lead_suburb, lead.lead_lat, lead.lead_lng]
  );
}

// ─── Create a fresh referral lead for receiving operator ─────────────────────

async function createReferredLead(receivingOperatorId, leadInfo, fromOperatorId, referralId) {
  const { name, phone, email, suburb, tradeType, description } = leadInfo;
  await pool.query(
    `INSERT INTO operator_widget_leads
       (operator_id, name, phone, email, message, suburb, status, source,
        job_type, lead_suburb, referral_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'new', 'referral', $7, $8, 'in_area')`,
    [receivingOperatorId, name || null, phone || null, email || null,
     description || null, suburb || null, tradeType || null, suburb || null]
  );
}

// ─── Email the receiving operator ────────────────────────────────────────────

async function sendReferralNotification(receiver, leadInfo, referralId) {
  const { name, phone, email, suburb, tradeType, description } = leadInfo;
  const dashUrl = `${APP_URL}/dashboard`;

  const html = `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
  <h2 style="color:#f0a500">🤝 Hugo referred a lead your way</h2>
  <p>Hi ${receiver.name},</p>
  <p>A lead came in for a <strong>${tradeType || 'trade job'}</strong> in <strong>${suburb || 'your area'}</strong> — Hugo matched it to you because you cover that suburb.</p>

  <table style="width:100%;border-collapse:collapse;margin:1rem 0">
    ${name ? `<tr><td style="padding:6px 0;color:#666">Name</td><td><strong>${name}</strong></td></tr>` : ''}
    ${suburb ? `<tr><td style="padding:6px 0;color:#666">Suburb</td><td><strong>${suburb}</strong></td></tr>` : ''}
    ${tradeType ? `<tr><td style="padding:6px 0;color:#666">Trade</td><td><strong>${tradeType}</strong></td></tr>` : ''}
    ${description ? `<tr><td style="padding:6px 0;color:#666">Details</td><td>${description}</td></tr>` : ''}
    ${phone ? `<tr><td style="padding:6px 0;color:#666">Phone</td><td><a href="tel:${phone}">${phone}</a></td></tr>` : ''}
    ${email ? `<tr><td style="padding:6px 0;color:#666">Email</td><td><a href="mailto:${email}">${email}</a></td></tr>` : ''}
  </table>

  <a href="${dashUrl}" style="display:inline-block;background:#f0a500;color:#000;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:bold">View in Dashboard →</a>

  <p style="margin-top:1.5rem;font-size:0.85rem;color:#666">
    You can accept or decline this referral from your Referrals panel.
  </p>
</div>`;

  await sendEmail({
    to:      receiver.email,
    subject: `📬 New lead referral — ${tradeType || 'trade job'} in ${suburb || 'your area'}`,
    html,
  });
}

// ─── Check if a lead's suburb is inside an operator's service area ────────────
// Convenience wrapper used by Hugo Brain during qualification.
// Returns: { inArea, suburb, coords, reason }

async function checkLeadLocation(operatorId, suburb) {
  if (!suburb) return { inArea: true, suburb: null, coords: null, reason: 'no_suburb_provided' };

  const { getServiceArea, isInServiceArea, geocodeAddress: geocode } = require('./service-area');

  const profile = await getServiceArea(operatorId);
  if (!profile) return { inArea: true, suburb, coords: null, reason: 'no_profile' };

  // If no service area configured, assume in-area (don't block leads)
  const hasArea = profile.base_lat || (profile.service_area_suburbs && profile.service_area_suburbs.length > 0) || profile.legacy_suburb;
  if (!hasArea) return { inArea: true, suburb, coords: null, reason: 'no_service_area_configured' };

  // Geocode the lead's suburb
  const coords = await geocode(suburb).catch(() => null);
  const result = isInServiceArea(profile, suburb, coords);

  return { ...result, suburb, coords, profile };
}

module.exports = {
  routeOutOfAreaLead,
  checkLeadLocation,
  markLeadUnserviced,
};
