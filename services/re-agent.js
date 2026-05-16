/**
 * RE Agent Service — propops.pro
 *
 * Handles the backend logic for Hugo's real estate persona:
 *   1. ACTION tag parsing + validation (prevents hallucinated tags from hitting DB)
 *   2. Buyer lead qualification + intent scoring with temporal decay
 *   3. Inspection slot locking (prevents double-bookings)
 *   4. .ics calendar invite generation (AEST/AEDT timezone, 30-min VALARM)
 *   5. Consent log helpers (AU Spam Act 2003 compliance)
 *   6. Open home RSVP
 *   7. Offer capture
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── ACTION Tag Parser ─────────────────────────────────────────────────────────
//
// Hugo's responses may include structured tags at the end like:
//   [ACTION:BOOK_INSPECTION|property=123 Example St|time=2026-05-12T14:00:00|name=John Smith|phone=0412 345 678]
//
// Strict regex validator — catches hallucinated/malformed tags before DB insert.
// Tags with broken brackets or missing required params are silently dropped.

const ACTION_REGEX = /\[ACTION:([A-Z_]+)\|([^\]]+)\]/g;

/**
 * Parse all ACTION tags from Hugo's raw response text.
 * Returns array of { type, params } objects and the cleaned text (tags stripped).
 *
 * @param {string} responseText
 * @returns {{ cleanedText: string, actions: Array<{type: string, params: Object}> }}
 */
function parseActionTags(responseText) {
  const actions = [];
  let cleanedText = responseText;

  let match;
  const regex = new RegExp(ACTION_REGEX.source, 'g');

  while ((match = regex.exec(responseText)) !== null) {
    const type = match[1];
    const rawParams = match[2];

    // Validate: params must not contain unbalanced brackets
    if (rawParams.includes('[') || rawParams.includes(']')) {
      console.warn(`[RE Agent] Malformed ACTION tag skipped — broken brackets: ${match[0].slice(0, 80)}`);
      continue;
    }

    const params = {};
    for (const pair of rawParams.split('|')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const key = pair.slice(0, eqIdx).trim();
        const val = pair.slice(eqIdx + 1).trim();
        if (key) params[key] = val;
      }
    }

    actions.push({ type, params });
  }

  // Strip all ACTION tags from the visible reply
  cleanedText = responseText.replace(new RegExp(ACTION_REGEX.source, 'g'), '').trim();

  return { cleanedText, actions };
}

// ─── Lead Qualification + Intent Scoring ──────────────────────────────────────

/**
 * Calculate intent score (1–10) from qualification data.
 *
 * Scoring:
 *   +5  Pre-approved
 *   +3  Specific property identified
 *   +2  First home buyer (government incentives = motivated)
 *   +1  Upsizing
 *   +2  0-3 month buying window
 *   -2  6+ month / just-looking window
 *
 * @param {{ property?: string, preApproved?: boolean, buyerType?: string, buyingWindow?: string }} q
 * @returns {{ score: number, category: 'hot'|'warm'|'cool' }}
 */
function calculateIntentScore(q) {
  let score = 0;

  if (q.preApproved) score += 5;
  if (q.property && q.property !== 'unknown' && q.property.length > 3) score += 3;

  switch (q.buyerType) {
    case 'first_home': score += 2; break;
    case 'upsizing':   score += 1; break;
    case 'investor':   score += 1; break;
  }

  switch (q.buyingWindow) {
    case '0-3 months':  score += 2; break;
    case '3-6 months':  score += 0; break;
    case '6+ months':   score -= 2; break;
    case 'just-looking': score -= 2; break;
  }

  score = Math.max(1, Math.min(10, score));

  let category;
  if (score >= 8)      category = 'hot';
  else if (score >= 5) category = 'warm';
  else                 category = 'cool';

  return { score, category };
}

/**
 * Apply temporal decay to a lead's score.
 * Leads that haven't engaged recently are less likely to convert.
 *
 * @param {number} score - Current score
 * @param {Date} lastEngagedAt - Timestamp of last engagement
 * @returns {number} Decayed score (floored at 1)
 */
function applyTemporalDecay(score, lastEngagedAt) {
  const daysSince = (Date.now() - new Date(lastEngagedAt).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince > 90) return Math.max(1, score - 3);
  if (daysSince > 30) return Math.max(1, score - 1);
  return score;
}

// ─── Inspection Slot Locking ───────────────────────────────────────────────────

/**
 * Check if an inspection slot is available for a given property + time.
 *
 * @param {string} propertyAddress
 * @param {string|Date} slotTime - ISO8601 or Date object
 * @returns {Promise<boolean>} true = available, false = already booked
 */
async function isSlotAvailable(propertyAddress, slotTime) {
  try {
    const result = await pool.query(
      `SELECT id FROM inspection_slots
       WHERE property_address = $1
         AND slot_time = $2
         AND is_booked = TRUE`,
      [propertyAddress, new Date(slotTime).toISOString()]
    );
    return result.rows.length === 0;
  } catch (err) {
    // Table may not exist yet during rollout — treat as available
    if (err.message.includes('does not exist')) {
      console.warn('[RE Agent] inspection_slots table not found — treating slot as available');
      return true;
    }
    throw err;
  }
}

/**
 * Lock an inspection slot and link it to a lead ID.
 * Uses INSERT ON CONFLICT DO NOTHING for atomic locking — prevents race conditions.
 *
 * @param {string} propertyAddress
 * @param {string|Date} slotTime
 * @param {number|null} leadId
 * @returns {Promise<boolean>} true = locked successfully, false = already taken
 */
async function lockSlot(propertyAddress, slotTime, leadId) {
  try {
    const result = await pool.query(
      `INSERT INTO inspection_slots (property_address, slot_time, is_booked, booked_by_lead_id, booked_at)
       VALUES ($1, $2, TRUE, $3, NOW())
       ON CONFLICT (property_address, slot_time) DO NOTHING`,
      [propertyAddress, new Date(slotTime).toISOString(), leadId || null]
    );
    // rowCount 1 = inserted (locked), 0 = conflict (already booked)
    return result.rowCount === 1;
  } catch (err) {
    if (err.message.includes('does not exist')) {
      console.warn('[RE Agent] inspection_slots table not found — skipping slot lock');
      return true; // Fail open
    }
    throw err;
  }
}

// ─── Lead Persistence ──────────────────────────────────────────────────────────

/**
 * Create or update a re_lead record.
 *
 * @param {Object} data
 * @param {string} data.name
 * @param {string} data.phone
 * @param {string} [data.email]
 * @param {string} [data.propertyAddress]
 * @param {number} [data.intentScore]
 * @param {string} [data.intentCategory]
 * @param {boolean} [data.preApproved]
 * @param {string} [data.buyerType]
 * @param {string} [data.buyingWindow]
 * @param {Object} [data.qualificationData]
 * @param {string} [data.widgetSessionId]
 * @param {boolean} [data.isOpenHome]
 * @returns {Promise<{id: number}>}
 */
async function upsertLead(data) {
  try {
    // Build consent log entry for AU Spam Act 2003 compliance
    const consentEntry = {
      timestamp: new Date().toISOString(),
      channel: data.channel || 'widget',
      action: 'lead_created',
      ip: data.sourceIp || null,
    };

    const result = await pool.query(
      `INSERT INTO re_leads (
        name, phone, email, property_address,
        intent_score, intent_category,
        pre_approved, buyer_type, buying_window,
        qualification_data, widget_session_id, is_open_home,
        source_url, consent_log,
        last_engagement_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6,
        $7, $8, $9,
        $10, $11, $12,
        $13, $14::jsonb,
        NOW(), NOW(), NOW()
      ) RETURNING id`,
      [
        data.name || 'Unknown',
        data.phone || '',
        data.email || null,
        data.propertyAddress || null,
        data.intentScore || null,
        data.intentCategory || null,
        data.preApproved || false,
        data.buyerType || 'unknown',
        data.buyingWindow || 'unknown',
        JSON.stringify(data.qualificationData || {}),
        data.widgetSessionId || null,
        data.isOpenHome || false,
        data.sourceUrl || null,
        JSON.stringify([consentEntry]),
      ]
    );
    return result.rows[0];
  } catch (err) {
    if (err.message.includes('does not exist')) {
      console.warn('[RE Agent] re_leads table not found — skipping lead persistence');
      return { id: null };
    }
    // If new columns don't exist yet, fall back to original insert
    if (err.message.includes('source_url') || err.message.includes('consent_log')) {
      console.warn('[RE Agent] New columns not yet migrated — using fallback insert');
      const fallback = await pool.query(
        `INSERT INTO re_leads (
          name, phone, email, property_address,
          intent_score, intent_category,
          pre_approved, buyer_type, buying_window,
          qualification_data, widget_session_id, is_open_home,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
        RETURNING id`,
        [
          data.name || 'Unknown', data.phone || '', data.email || null,
          data.propertyAddress || null, data.intentScore || null, data.intentCategory || null,
          data.preApproved || false, data.buyerType || 'unknown', data.buyingWindow || 'unknown',
          JSON.stringify(data.qualificationData || {}), data.widgetSessionId || null, data.isOpenHome || false,
        ]
      );
      return fallback.rows[0];
    }
    throw err;
  }
}

/**
 * Persist an offer linked to a lead.
 *
 * @param {Object} data
 * @param {number|null} data.leadId
 * @param {string} data.propertyAddress
 * @param {number} data.amount - dollar value
 * @param {string} [data.conditions]
 * @returns {Promise<{id: number}>}
 */
async function createOffer(data) {
  try {
    const result = await pool.query(
      `INSERT INTO re_offers (lead_id, property_address, amount, conditions, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())
       RETURNING id`,
      [
        data.leadId || null,
        data.propertyAddress || 'Unknown',
        Math.round(Number(data.amount) || 0),
        data.conditions || 'unconditional',
      ]
    );
    return result.rows[0];
  } catch (err) {
    if (err.message.includes('does not exist')) {
      console.warn('[RE Agent] re_offers table not found — skipping offer persistence');
      return { id: null };
    }
    throw err;
  }
}

// ─── .ics Calendar Invite Generator ────────────────────────────────────────────
//
// Generates RFC 5545-compliant iCalendar content for inspection bookings.
// - Timezone: Australia/Sydney (handles AEST/AEDT DST automatically)
// - Duration: 45 minutes
// - VALARM: 30-minute display reminder (so buyer doesn't miss inspection)
// - Method: REQUEST (buyer receives invite to accept/decline)

/**
 * Generate a .ics string for a property inspection.
 *
 * @param {Object} invite
 * @param {string} invite.propertyAddress
 * @param {Date|string} invite.inspectionTime - Date in AEST/AEDT
 * @param {string} invite.customerName
 * @param {string} invite.customerEmail
 * @param {string} [invite.agentName]
 * @param {string} [invite.agentEmail]
 * @returns {string} ics content
 */
function generateICalendar(invite) {
  const start = new Date(invite.inspectionTime);
  const end = new Date(start.getTime() + 45 * 60 * 1000);

  // Format date for iCal: YYYYMMDDTHHMMSS (local time with TZID)
  function toIcalLocal(date) {
    // Convert to AEST/AEDT by formatting in Sydney time
    const sydn = date.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour12: false })
      .replace(/\//g, '-');
    // Parse back from "DD/MM/YYYY, HH:MM:SS" → YYYYMMDDTHHMMSS
    const [datePart, timePart] = date.toLocaleString('sv-SE', { timeZone: 'Australia/Sydney' }).split(' ');
    const ds = datePart.replace(/-/g, '');
    const ts = timePart.replace(/:/g, '');
    return `${ds}T${ts}`;
  }

  const uid = `inspection-${Date.now()}-${Math.random().toString(36).slice(2)}@propops.pro`;
  const agentName = invite.agentName || 'PropOps Agent';
  const agentEmail = invite.agentEmail || 'hello@propops.pro';

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PropOps//Hugo RE Agent//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VTIMEZONE',
    'TZID:Australia/Sydney',
    'BEGIN:STANDARD',
    'DTSTART:19710101T030000',
    'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=4',
    'TZOFFSETFROM:+1100',
    'TZOFFSETTO:+1000',
    'TZNAME:AEST',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:19711001T020000',
    'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=10',
    'TZOFFSETFROM:+1000',
    'TZOFFSETTO:+1100',
    'TZNAME:AEDT',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART;TZID=Australia/Sydney:${toIcalLocal(start)}`,
    `DTEND;TZID=Australia/Sydney:${toIcalLocal(end)}`,
    `SUMMARY:Property Inspection - ${invite.propertyAddress}`,
    `DESCRIPTION:Private inspection for ${invite.customerName} with ${agentName}`,
    `LOCATION:${invite.propertyAddress}`,
    `ORGANIZER;CN="${agentName}":mailto:${agentEmail}`,
    `ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE;CN="${invite.customerName}":mailto:${invite.customerEmail || agentEmail}`,
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT30M',
    `DESCRIPTION:Reminder: Property Inspection at ${invite.propertyAddress} with ${agentName}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  return ics;
}

// ─── ACTION Handler — processes parsed ACTION tags ──────────────────────────────

/**
 * Process a single ACTION tag from Hugo's response.
 * Persists to DB, generates calendar invites, triggers notifications.
 *
 * @param {{ type: string, params: Object }} action
 * @param {string} sessionId - Widget session ID for lead linkage
 * @returns {Promise<Object>} result with action type + outcome
 */
async function processAction(action, sessionId) {
  const { type, params } = action;
  console.log(`[RE Agent] Processing ACTION:${type}`, params);

  switch (type) {
    case 'BOOK_INSPECTION': {
      const { property, time, name, phone } = params;

      if (!property || !name || !phone) {
        console.warn('[RE Agent] BOOK_INSPECTION missing required fields — skipping');
        return { type, skipped: true, reason: 'missing_fields' };
      }

      // Check slot availability
      let slotAvailable = true;
      if (time) {
        slotAvailable = await isSlotAvailable(property, time);
      }

      if (!slotAvailable) {
        return { type, success: false, slotTaken: true, property, time };
      }

      // Create lead record
      const lead = await upsertLead({
        name,
        phone,
        propertyAddress: property,
        widgetSessionId: sessionId,
        intentScore: 7,
        intentCategory: 'warm',
        buyingWindow: '0-3 months',
      });

      // Lock the slot
      if (time && lead.id) {
        await lockSlot(property, time, lead.id);
      }

      // Generate .ics
      let icsContent = null;
      if (time) {
        try {
          icsContent = generateICalendar({
            propertyAddress: property,
            inspectionTime: time,
            customerName: name,
            customerEmail: null, // Phone-only at this point
            agentName: 'PropOps Agent',
            agentEmail: 'hello@propops.pro',
          });
        } catch (err) {
          console.warn('[RE Agent] ICS generation failed:', err.message);
        }
      }

      console.log(`[RE Agent] Inspection booked — Lead #${lead.id}, Property: ${property}, Time: ${time}`);
      return { type, success: true, leadId: lead.id, property, time, slotAvailable, icsGenerated: !!icsContent };
    }

    case 'QUALIFY_LEAD': {
      const { property, pre_approval, buyer_type, buying_window, score: rawScore } = params;

      const preApproved = pre_approval === 'yes';
      const { score, category } = calculateIntentScore({
        property,
        preApproved,
        buyerType: buyer_type,
        buyingWindow: buying_window,
      });

      const lead = await upsertLead({
        name: params.name || 'Unknown',
        phone: params.phone || '',
        propertyAddress: property,
        preApproved,
        buyerType: buyer_type || 'unknown',
        buyingWindow: buying_window || 'unknown',
        intentScore: score,
        intentCategory: category,
        widgetSessionId: sessionId,
        qualificationData: params,
      });

      console.log(`[RE Agent] Lead qualified — Score: ${score} (${category}), Lead #${lead.id}`);
      return { type, success: true, leadId: lead.id, score, category };
    }

    case 'LOG_OFFER': {
      const { property, amount, conditions } = params;

      if (!property || !amount) {
        console.warn('[RE Agent] LOG_OFFER missing required fields — skipping');
        return { type, skipped: true, reason: 'missing_fields' };
      }

      // Create lead (minimal) then attach offer
      const lead = await upsertLead({
        name: params.name || 'Unknown',
        phone: params.phone || '',
        propertyAddress: property,
        widgetSessionId: sessionId,
        intentScore: 9,
        intentCategory: 'hot',
      });

      const offer = await createOffer({
        leadId: lead.id,
        propertyAddress: property,
        amount: Number(String(amount).replace(/[^0-9.]/g, '')),
        conditions: conditions || 'unconditional',
      });

      console.log(`[RE Agent] Offer logged — $${amount} on ${property}, Offer #${offer.id}`);
      return { type, success: true, offerId: offer.id, leadId: lead.id, property, amount };
    }

    case 'OPEN_HOME_RSVP': {
      const { property, name, phone, attendees } = params;

      if (!property || !name || !phone) {
        console.warn('[RE Agent] OPEN_HOME_RSVP missing required fields — skipping');
        return { type, skipped: true, reason: 'missing_fields' };
      }

      const lead = await upsertLead({
        name,
        phone,
        propertyAddress: property,
        widgetSessionId: sessionId,
        isOpenHome: true,
        intentScore: 5,
        intentCategory: 'warm',
        qualificationData: { attendees: attendees || '1' },
      });

      console.log(`[RE Agent] Open home RSVP — Lead #${lead.id}, ${attendees || 1} attendee(s), ${property}`);
      return { type, success: true, leadId: lead.id, property, attendees };
    }

    default:
      console.warn(`[RE Agent] Unknown ACTION type: ${type}`);
      return { type, skipped: true, reason: 'unknown_type' };
  }
}

/**
 * Process all ACTION tags in a Hugo response.
 * Returns cleaned text (tags stripped) and array of action results.
 *
 * @param {string} rawText - Hugo's full response
 * @param {string} sessionId - Widget session ID
 * @returns {Promise<{ cleanedText: string, actionResults: Array }>}
 */
async function processHugoResponse(rawText, sessionId) {
  const { cleanedText, actions } = parseActionTags(rawText);

  const actionResults = [];
  for (const action of actions) {
    try {
      const result = await processAction(action, sessionId);
      actionResults.push(result);
    } catch (err) {
      console.error(`[RE Agent] Error processing ACTION:${action.type}:`, err.message);
      actionResults.push({ type: action.type, error: err.message });
    }
  }

  return { cleanedText, actionResults };
}

// ─── Template fallback for propops.pro (RE domain) ────────────────────────────
//
// Used when AI is rate-limited. RE-specific, never uses tradie slang.

function getRETemplateFallback(userMsg, history) {
  const msg = (userMsg || '').toLowerCase().trim();
  const isContinuation = Array.isArray(history) && history.length > 0;

  // Greetings
  if (!isContinuation && (msg.match(/^\s*hi\s*[!.]?\s*$/) || msg.includes('hello') || msg.includes('g\'day') || msg.includes('hey'))) {
    return "G'day! I'm Hugo with PropOps. Are you looking to buy, sell, or rent?";
  }

  // Inspection request
  if (msg.includes('inspect') || msg.includes('look at') || msg.includes('view') || msg.includes('see the property') || msg.includes('book')) {
    if (isContinuation) {
      return "Happy to organise that. Which property are you looking at — do you have the address?";
    }
    return "I can book you in for an inspection. Which property are you interested in?";
  }

  // Pre-approval / finance
  if (msg.includes('pre-approval') || msg.includes('pre approval') || msg.includes('finance') || msg.includes('bank') || msg.includes('loan') || msg.includes('mortgage')) {
    return "Good question — getting pre-approval sorted before you inspect is worth doing. Most lenders turn it around in a few days. Have you started that process yet?";
  }

  // Offer / price
  if (msg.includes('offer') || msg.includes('how much') || msg.includes('price') || msg.includes('worth') || msg.includes('value')) {
    return "Happy to help with that. Which property are you thinking about? I can walk you through recent sales in the area and what a competitive offer looks like.";
  }

  // Open home
  if (msg.includes('open home') || msg.includes('open house') || msg.includes('saturday') || msg.includes('sunday')) {
    return "I can get you on the list for the open home. Can I grab your name and best contact number?";
  }

  // Buy / sell / rent
  if (msg.includes('buy') || msg.includes('purchase')) {
    return "Great — buying is a big move. Have you got a particular suburb or property type in mind? And are you pre-approved with your bank yet?";
  }
  if (msg.includes('sell') || msg.includes('selling') || msg.includes('list')) {
    return "Happy to help with a sale. The first step is usually a free appraisal — I can organise one at a time that suits you. What's the property address?";
  }
  if (msg.includes('rent') || msg.includes('tenant') || msg.includes('lease')) {
    return "Looking to rent? Tell me what you're after — suburb, number of bedrooms, budget — and I'll see what's available.";
  }

  // Thanks / bye
  if (msg.includes('thank') || msg.includes('cheers') || msg.includes('bye')) {
    return "No worries at all! If you have any more questions about the property market, I'm here. Good luck with your search.";
  }

  // Default first message
  if (!isContinuation) {
    return "G'day! I'm Hugo with PropOps — I can help you book a property inspection, answer questions about listings, or get you set up for an open home. What are you after?";
  }

  // Continuation default
  return "No worries — happy to help. Could you give me a bit more detail about what you're after? Which property has caught your eye?";
}

module.exports = {
  parseActionTags,
  processHugoResponse,
  calculateIntentScore,
  applyTemporalDecay,
  isSlotAvailable,
  lockSlot,
  upsertLead,
  createOffer,
  generateICalendar,
  getRETemplateFallback,
};
