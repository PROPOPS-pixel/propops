/**
 * Hugo Network Service
 *
 * Hugo acts as a broker between operators and tradies in his private network.
 * Operators ask Hugo for a trade; Hugo finds a match and responds naturally.
 * Tradie contact details (name, phone) are NEVER exposed to operators.
 *
 * Flow:
 *   1. Operator types a request ("Need a plumber in Bankstown")
 *   2. Hugo parses trade_type + area from the message
 *   3. Hugo searches hugo_network_members for matching tradies
 *   4. Hugo generates a natural language response (no raw data)
 *   5. Request is logged in hugo_network_requests
 */

const OpenAI = require('openai');
const { Pool } = require('pg');

const openai = new OpenAI();
// Uses OPENAI_BASE_URL + OPENAI_API_KEY env vars automatically (Polsia proxy)

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ─── Parse operator's free-text message ──────────────────────────────────────

async function parseRequest(message) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `Extract structured info from a trade request. Return JSON only, no markdown.
Fields:
- tradeType: one of: plumber, electrician, carpenter, painter, tiler, concreter, roofer, landscaper, cleaner, plasterer, bricklayer, glazier, fencer, locksmith, pest_control, air_conditioning, solar, handyman, flooring, waterproofer, restumper. Pick the closest match.
- area: suburb or area name (empty string if not mentioned)
- urgency: "emergency" | "urgent" | "standard"
- jobDescription: brief description of the job`
      },
      { role: 'user', content: message }
    ],
    max_tokens: 120,
    temperature: 0
  });

  try {
    const raw = completion.choices[0].message.content.trim();
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { tradeType: 'handyman', area: '', urgency: 'standard', jobDescription: message };
  }
}

// ─── Find matching tradies in the network ────────────────────────────────────

async function findNetworkMatches(tradeType, area) {
  const tradeLower = (tradeType || '').toLowerCase().trim();
  const areaLower = (area || '').toLowerCase().trim();

  if (areaLower) {
    const result = await pool.query(
      `SELECT id, name, trade_type, service_areas, suburb, availability, emergency, rating, jobs_completed
       FROM hugo_network_members
       WHERE active = true
         AND availability != 'unavailable'
         AND LOWER(trade_type) = $1
         AND (
           EXISTS (SELECT 1 FROM unnest(service_areas) AS sa WHERE LOWER(sa) LIKE $2)
           OR LOWER(suburb) LIKE $2
         )
       ORDER BY rating DESC, jobs_completed DESC
       LIMIT 5`,
      [tradeLower, `%${areaLower}%`]
    );
    if (result.rows.length > 0) return result.rows;
  }

  // Fallback: trade only, no area filter
  const fallback = await pool.query(
    `SELECT id, name, trade_type, service_areas, suburb, availability, emergency, rating, jobs_completed
     FROM hugo_network_members
     WHERE active = true
       AND availability != 'unavailable'
       AND LOWER(trade_type) = $1
     ORDER BY rating DESC, jobs_completed DESC
     LIMIT 5`,
    [tradeLower]
  );
  return fallback.rows;
}

// ─── Generate Hugo's natural language response ────────────────────────────────

async function generateHugoResponse({ jobDescription, matches, area, tradeType, urgency }) {
  const hasMatches = matches && matches.length > 0;

  const matchSummary = hasMatches
    ? matches.slice(0, 3).map(m => {
        const avail = m.availability === 'available' ? 'available' : 'can be checked';
        const emerg = m.emergency ? ', handles emergencies' : '';
        return `- Rated ${m.rating}/5 (${m.jobs_completed} jobs done), based in ${m.suburb || 'your area'}${emerg}, ${avail}`;
      }).join('\n')
    : null;

  const systemPrompt = `You are Hugo, a trade network broker for PropOps.Pro. You connect property operators with tradies from your private network.

Rules you MUST follow:
- NEVER share tradie names, phone numbers, or any contact details
- You are the intermediary — you handle all outreach on behalf of the operator
- Use a friendly, confident, Australian tone
- Keep responses to 2–4 sentences
- If you have matches: confirm you have people in the network and you'll make contact
- If no matches: explain you are reaching out to your wider contacts`;

  const userContent = hasMatches
    ? `Operator request: "${jobDescription}"
Trade needed: ${tradeType}, Area: ${area || 'not specified'}, Urgency: ${urgency}
Network matches found (${matches.length}):
${matchSummary}

Write a natural response to the operator. Confirm you have ${matches.length} ${tradeType}${matches.length > 1 ? 's' : ''} in the network for that area. Say you will reach out and get back to them. Do not name anyone.`
    : `Operator request: "${jobDescription}"
Trade needed: ${tradeType}, Area: ${area || 'not specified'}, Urgency: ${urgency}
No exact matches in current network for this area.

Write a natural response. Tell the operator you don't have an exact match right now but you're reaching out to your wider ${tradeType} contacts and will update them shortly.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    max_tokens: 220,
    temperature: 0.7
  });

  return completion.choices[0].message.content.trim();
}

// ─── Save a new network request ───────────────────────────────────────────────

async function saveRequest(operatorId, { tradeType, area, jobDescription, urgency }) {
  const result = await pool.query(
    `INSERT INTO hugo_network_requests
       (operator_id, trade_type, area, job_description, urgency, status, operator_messages, hugo_messages)
     VALUES ($1, $2, $3, $4, $5, 'searching', '[]', '[]')
     RETURNING id`,
    [operatorId, tradeType || null, area || null, jobDescription || null, urgency || 'standard']
  );
  return result.rows[0].id;
}

async function updateRequest(requestId, { status, matchedMemberId, hugoResponse, tradeType, area }) {
  await pool.query(
    `UPDATE hugo_network_requests
     SET status = $1,
         matched_member_id = $2,
         hugo_response = $3,
         trade_type = COALESCE($4, trade_type),
         area = COALESCE($5, area),
         updated_at = NOW()
     WHERE id = $6`,
    [status, matchedMemberId || null, hugoResponse, tradeType || null, area || null, requestId]
  );
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function processNetworkRequest(operatorId, { message }) {
  // Parse trade + area from operator's message
  const parsed = await parseRequest(message);
  const { tradeType, area, urgency, jobDescription } = parsed;

  // Find matches in the network
  const matches = await findNetworkMatches(tradeType, area);

  // Generate Hugo's response
  const hugoResponse = await generateHugoResponse({
    jobDescription: jobDescription || message,
    matches,
    area,
    tradeType,
    urgency
  });

  // Log the request
  const requestId = await saveRequest(operatorId, {
    tradeType,
    area,
    jobDescription: message,
    urgency
  });

  const status = matches.length > 0 ? 'matched' : 'searching';
  await updateRequest(requestId, {
    status,
    matchedMemberId: matches.length > 0 ? matches[0].id : null,
    hugoResponse,
    tradeType,
    area
  });

  return {
    requestId,
    response: hugoResponse,
    status,
    matchCount: matches.length
  };
}

// ─── Get request history for an operator ─────────────────────────────────────

async function getRequestHistory(operatorId, limit = 15) {
  const result = await pool.query(
    `SELECT id, trade_type, area, job_description, status, hugo_response, created_at
     FROM hugo_network_requests
     WHERE operator_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [operatorId, limit]
  );
  return result.rows;
}

// ─── Get status of a specific request ────────────────────────────────────────

async function getRequestStatus(requestId, operatorId) {
  const result = await pool.query(
    `SELECT id, trade_type, area, job_description, status, hugo_response, created_at
     FROM hugo_network_requests
     WHERE id = $1 AND operator_id = $2`,
    [requestId, operatorId]
  );
  return result.rows[0] || null;
}

module.exports = {
  processNetworkRequest,
  getRequestHistory,
  getRequestStatus
};
