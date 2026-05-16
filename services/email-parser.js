const OpenAI = require('openai');
const openai = new OpenAI();

/**
 * PropOps Email Parser
 *
 * Extracts lead data from forwarded property inquiry emails.
 * Priority order: REA → Domain → Homely → Rent.com.au → Facebook → Generic AI
 */

// ─── Source Detection ──────────────────────────────────────────────────────────

const SOURCE_PATTERNS = [
  { name: 'REA',            patterns: ['realestate.com.au', 'rea.com.au', 'REA Group'] },
  { name: 'Domain',         patterns: ['domain.com.au', 'Domain.com.au'] },
  { name: 'Homely',         patterns: ['homely.com.au'] },
  { name: 'Rent.com.au',    patterns: ['rent.com.au'] },
  { name: 'Allhomes',       patterns: ['allhomes.com.au'] },
  { name: 'RealCommercial', patterns: ['realcommercial.com.au'] },
  { name: 'Hipages',        patterns: ['hipages.com.au', 'hipages', 'hi pages'] },
  { name: 'ServiceSeeking', patterns: ['serviceseeking.com.au', 'serviceseeking', 'service seeking'] },
  { name: 'Airtasker',      patterns: ['airtasker.com', 'airtasker'] },
  { name: 'Oneflare',       patterns: ['oneflare.com.au', 'oneflare'] },
  { name: 'Facebook',       patterns: ['facebook.com', 'marketplace.facebook', 'Facebook Marketplace'] },
  { name: 'Instagram',      patterns: ['instagram.com'] },
  { name: 'Airbnb',         patterns: ['airbnb.com', 'airbnb'] },
  { name: 'Booking.com',    patterns: ['booking.com'] },
  { name: 'Website',        patterns: ['contact form', 'website enquiry', 'website contact'] },
];

function detectSource(subject = '', body = '', fromEmail = '') {
  const haystack = [subject, body, fromEmail].join(' ').toLowerCase();
  for (const { name, patterns } of SOURCE_PATTERNS) {
    if (patterns.some(p => haystack.includes(p.toLowerCase()))) {
      return name;
    }
  }
  return 'Email';
}

// ─── Lead Type Detection ────────────────────────────────────────────────────────

function detectLeadType(subject = '', body = '', source = '', propertyInterest = '') {
  const text = [subject, body, propertyInterest].join(' ').toLowerCase();
  if (/\b(buy|buyer|buyers|buying|purchase|purchas\w*|pre[- ]?approv\w*|first home buyer|investment property|for sale|auction)\b/.test(text)) return 'buyer';
  if (/\b(rent|renter|renters|renting|lease|tenant|rental|move[- ]?in)\b/.test(text)) return 'renter';
  if (/\b(sell|selling|appraisal|market value|list my|listing my)\b/.test(text)) return 'seller';
  if (/\b(landlord|property management|managing|pm|rental management)\b/.test(text)) return 'landlord';
  // Source-based fallback: portal name strongly implies lead type
  const src = (source || '').toLowerCase();
  if (/rent\.com\.au|rent/i.test(src)) return 'renter';
  return null;
}

// ─── Listing URL Extraction ─────────────────────────────────────────────────────

/**
 * Extract a property listing URL from email body text.
 * Looks for known portal domains: realestate.com.au, domain.com.au, homely.com.au, etc.
 * Returns the first matched URL or null.
 */
function extractListingUrl(body) {
  if (!body) return null;

  // Match URLs containing known portal domains
  const portalUrlPattern = /https?:\/\/(?:www\.)?(?:realestate\.com\.au|domain\.com\.au|homely\.com\.au|rent\.com\.au|allhomes\.com\.au|realcommercial\.com\.au)[^\s"'<>\]]+/gi;
  const matches = body.match(portalUrlPattern);
  if (!matches || matches.length === 0) return null;

  // Prefer property/listing URLs over generic portal URLs
  const listingUrl = matches.find(url =>
    /\/(property|listing|for-sale|for-rent|sold|property-detail|buy|rent|commercial)[-\/]/i.test(url)
  ) || matches[0];

  // Clean up trailing punctuation
  return listingUrl.replace(/[.,;!?)]+$/, '');
}

// ─── Template Parsers ───────────────────────────────────────────────────────────

/**
 * REA (realestate.com.au) inquiry format
 * Example subject: "Enquiry for 45 Example Street, Sydney NSW 2000 - John Smith"
 */
function parseREAEmail(body) {
  const result = {};

  // Name — "Name: John Smith" or "From: John Smith"
  const nameMatch = body.match(/(?:^|\n)\s*(?:Name|Enquirer name|Contact name|Full name)\s*:?\s*([^\n]+)/im);
  if (nameMatch) result.name = nameMatch[1].trim();

  // Email
  const emailMatch = body.match(/(?:^|\n)\s*(?:Email|E-mail|Email address)\s*:?\s*([^\s\n]+@[^\s\n]+)/im);
  if (emailMatch) result.email = emailMatch[1].trim();

  // Phone
  const phoneMatch = body.match(/(?:^|\n)\s*(?:Phone|Mobile|Phone number|Contact number)\s*:?\s*([\d\s\+\(\)\-]{8,20})/im);
  if (phoneMatch) result.phone = phoneMatch[1].trim().replace(/\s+/g, ' ');

  // Property
  const propMatch = body.match(/(?:^|\n)\s*(?:Property|Property address|Address|Listing|For)\s*:?\s*([^\n]+)/im);
  if (propMatch) result.property_interest = propMatch[1].trim();

  // Message / enquiry body
  const msgMatch = body.match(/(?:^|\n)\s*(?:Message|Enquiry|Comment|Comments|Notes)\s*:?\s*([\s\S]{10,500}?)(?:\n\n|\n-{3,}|$)/im);
  if (msgMatch) result.notes = msgMatch[1].trim();

  // Listing URL — extract from body
  result.property_listing_url = extractListingUrl(body);

  return result;
}

/**
 * Homely.com.au inquiry format
 * Subject: "You've received an enquiry on Homely — 3 bed house in Bondi NSW 2026"
 * From: enquiries@homely.com.au or no-reply@homely.com.au
 * Typical body:
 *   Enquiry details:
 *   Name: John Smith
 *   Email: john@gmail.com
 *   Phone: 0412 345 678
 *   Message: Hi I'd like to inspect...
 *   For: 45 Example Street, Bondi NSW 2026
 *   View listing: https://www.homely.com.au/homes/...
 */
function parseHomelyEmail(body) {
  const result = {};

  // Name
  const nameMatch = body.match(/(?:^|\n)\s*Name\s*:?\s*([^\n]+)/im);
  if (nameMatch) result.name = nameMatch[1].trim();

  // Email
  const emailMatch = body.match(/(?:^|\n)\s*Email\s*:?\s*([^\s\n]+@[^\s\n]+)/im);
  if (emailMatch) result.email = emailMatch[1].trim();

  // Phone — Homely uses "Phone:" or "Mobile:"
  const phoneMatch = body.match(/(?:^|\n)\s*(?:Phone|Mobile)\s*:?\s*([\d\s\+\(\)\-]{8,20})/im);
  if (phoneMatch) result.phone = phoneMatch[1].trim().replace(/\s+/g, ' ');

  // Property — "For:" label
  const propMatch = body.match(/(?:^|\n)\s*For\s*:?\s*([^\n]+)/im);
  if (propMatch) result.property_interest = propMatch[1].trim();

  // Message
  const msgMatch = body.match(/(?:^|\n)\s*Message\s*:?\s*([\s\S]{5,500}?)(?:\n\n|\nFor:|\nView|\n-{3,}|$)/im);
  if (msgMatch) result.notes = msgMatch[1].trim();

  // Listing URL
  result.property_listing_url = extractListingUrl(body);

  return result;
}

/**
 * Rent.com.au inquiry format
 * Subject: "New rental enquiry — 2 bedroom apartment in Surry Hills NSW 2010"
 * From: noreply@rent.com.au
 * Typical body:
 *   New Rental Enquiry
 *   Name: John Smith
 *   Email Address: john@gmail.com
 *   Phone Number: 0412 345 678
 *   Property: 45 Example Street, Surry Hills NSW 2010
 *   Their message:
 *   Hi, I'd like to apply...
 *   https://www.rent.com.au/property-for-rent/...
 */
function parseRentEmail(body) {
  const result = {};

  // Name
  const nameMatch = body.match(/(?:^|\n)\s*Name\s*:?\s*([^\n]+)/im);
  if (nameMatch) result.name = nameMatch[1].trim();

  // Email — Rent.com.au uses "Email Address:"
  const emailMatch = body.match(/(?:^|\n)\s*(?:Email Address|Email)\s*:?\s*([^\s\n]+@[^\s\n]+)/im);
  if (emailMatch) result.email = emailMatch[1].trim();

  // Phone — Rent.com.au uses "Phone Number:"
  const phoneMatch = body.match(/(?:^|\n)\s*(?:Phone Number|Phone|Mobile)\s*:?\s*([\d\s\+\(\)\-]{8,20})/im);
  if (phoneMatch) result.phone = phoneMatch[1].trim().replace(/\s+/g, ' ');

  // Property
  const propMatch = body.match(/(?:^|\n)\s*(?:Property|Address)\s*:?\s*([^\n]+)/im);
  if (propMatch) result.property_interest = propMatch[1].trim();

  // Message — Rent uses "Their message:" or "Message:" header
  const msgMatch = body.match(/(?:^|\n)\s*(?:Their message|Message)\s*:?\s*\n([\s\S]{5,500}?)(?:\n\n|\nhttps?:|\n-{3,}|$)/im);
  if (msgMatch) result.notes = msgMatch[1].trim();

  // Listing URL
  result.property_listing_url = extractListingUrl(body);

  return result;
}

/**
 * Facebook Marketplace inquiry format
 * Subject: "[Name] sent you a message about [listing]" or "New message on Facebook Marketplace"
 * From: notification@facebookmail.com
 * Note: Facebook emails contain very little structured data — mostly name from subject/body
 * and the message text. No phone/email. AI fallback handles the rest.
 * Typical body:
 *   [Name] sent you a message:
 *   "[message text]"
 *   Reply on Facebook: [link]
 */
function parseFacebookEmail(subject, body) {
  const result = {};

  // Name from subject: "[Name] sent you a message about..."
  const subjectNameMatch = subject.match(/^([A-Z][a-z]+(?: [A-Z][a-z]+)+)\s+(?:sent you|messaged you)/i);
  if (subjectNameMatch) result.name = subjectNameMatch[1].trim();

  // Name from body: "[Name] sent you a message:"
  if (!result.name) {
    const bodyNameMatch = body.match(/^([A-Z][a-z]+(?: [A-Z][a-z]+)+)\s+sent you a message/im);
    if (bodyNameMatch) result.name = bodyNameMatch[1].trim();
  }

  // Property/listing — from subject: "about [listing title]"
  const listingMatch = subject.match(/about\s+"?([^"]+)"?\s*$/i);
  if (listingMatch) result.property_interest = listingMatch[1].trim().replace(/[."]+$/, '');

  // Message — extract quoted text between any style of quotes (smart, ASCII, or Unicode)
  const quotedMsg = body.match(/"([^"]{10,500})"/) ||
                    body.match(/\u201C([^\u201C\u201D]{10,500})\u201D/) ||
                    body.match(/sent you a message[^:\n]*[:\s]*\n+([\s\S]{10,400}?)(?:\n\nReply|\n\nView|$)/im);
  if (quotedMsg) result.notes = quotedMsg[1].trim();

  // Extract email from message body (FB prospects often paste their contact details)
  const portalDomains = /facebookmail\.com|facebook\.com|fb\.com|noreply|no-reply|donotreply/i;
  const emailMatches = body.match(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g);
  if (emailMatches) {
    const leadEmail = emailMatches.find(e => !portalDomains.test(e));
    if (leadEmail) result.email = leadEmail;
  }

  // Extract phone — Australian formats (often included in FB marketplace messages)
  const phoneMatch = body.match(/(?:call|reach|phone|mobile|contact)[^\n]*?((?:\+?61|0)[2-9][\s\-]?\d{4}[\s\-]?\d{3,4})/i)
    || body.match(/\b(0[2-9]\d{2}[\s\-]?\d{3}[\s\-]?\d{3})\b/)
    || body.match(/\b(\+?61[\s\-]?[2-9]\d{2}[\s\-]?\d{3}[\s\-]?\d{3})\b/);
  if (phoneMatch) result.phone = phoneMatch[1].trim();

  result.property_listing_url = null; // Facebook links are not property portal URLs

  return result;
}

/**
 * Domain.com.au inquiry format
 * Slightly different field names
 */
function parseDomainEmail(body) {
  const result = {};

  // Name
  const nameMatch = body.match(/(?:^|\n)\s*(?:Name|Enquirer|Contact)\s*:?\s*([^\n]+)/im);
  if (nameMatch) result.name = nameMatch[1].trim();

  // Email
  const emailMatch = body.match(/(?:^|\n)\s*(?:Email)\s*:?\s*([^\s\n]+@[^\s\n]+)/im);
  if (emailMatch) result.email = emailMatch[1].trim();

  // Phone
  const phoneMatch = body.match(/(?:^|\n)\s*(?:Phone|Mobile)\s*:?\s*([\d\s\+\(\)\-]{8,20})/im);
  if (phoneMatch) result.phone = phoneMatch[1].trim();

  // Property of interest — Domain uses "Property enquiry for: ADDRESS" format
  const propMatch = body.match(/(?:^|\n)\s*(?:Property of interest|Property|Listing|Address)\s*:?\s*([^\n]+)/im);
  if (propMatch) {
    result.property_interest = propMatch[1].trim()
      .replace(/^enquiry\s+for\s*:\s*/i, ''); // Strip "enquiry for:" prefix from Domain format
  }

  // Message
  const msgMatch = body.match(/(?:^|\n)\s*(?:Message|Enquiry message|Their message)\s*:?\s*([\s\S]{10,500}?)(?:\n\n|\n-{3,}|$)/im);
  if (msgMatch) result.notes = msgMatch[1].trim();

  // Listing URL — extract from body
  result.property_listing_url = extractListingUrl(body);

  return result;
}

/**
 * Hipages lead notification format
 * From: noreply@hipages.com.au or leads@hipages.com.au
 * Subject: "New Job: Plumbing — Sydney NSW 2000"
 * Body contains: Name, Phone, Suburb, Job Description
 */
function parseHipagesEmail(body, subject) {
  const result = {};

  // Name — "Customer name: John Smith" or "Name: John Smith"
  const nameMatch = body.match(/(?:Customer name|Full name|Name)\s*:?\s*([^\n]+)/im);
  if (nameMatch) result.name = nameMatch[1].trim();

  // Phone — "Phone: 0412 345 678" or "Mobile: ..."
  const phoneMatch = body.match(/(?:Phone|Mobile|Contact number)\s*:?\s*([\d\s\+\(\)\-]{8,20})/im);
  if (phoneMatch) result.phone = phoneMatch[1].trim().replace(/\s+/g, ' ');

  // Email
  const portalDomains = /hipages\.com\.au|noreply|no-reply|donotreply/i;
  const emailMatches = body.match(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g);
  if (emailMatches) {
    const leadEmail = emailMatches.find(e => !portalDomains.test(e));
    if (leadEmail) result.email = leadEmail;
  }

  // Job description — "Job description: Fix leaking tap"
  const jobMatch = body.match(/(?:Job description|Description|Job details|Job type|Job)\s*:?\s*([^\n]+)/im);
  if (jobMatch) result.property_interest = jobMatch[1].trim();

  // Suburb / location
  const suburbMatch = body.match(/(?:Suburb|Location|Area|Address)\s*:?\s*([^\n]+)/im);
  if (suburbMatch && !result.property_interest) result.property_interest = suburbMatch[1].trim();

  // Message / notes
  const msgMatch = body.match(/(?:Message|Notes|Additional info|Comments)\s*:?\s*([\s\S]{5,500}?)(?:\n\n|\n-{3,}|$)/im);
  if (msgMatch) result.notes = msgMatch[1].trim();

  // If no property_interest from body, derive from subject ("New Job: Plumbing — Bondi NSW")
  if (!result.property_interest && subject) {
    const subjectJobMatch = subject.match(/(?:New Job|New Lead|Job|Lead)\s*:?\s*(.+)/i);
    if (subjectJobMatch) result.property_interest = subjectJobMatch[1].trim();
  }

  return result;
}

/**
 * ServiceSeeking lead notification format
 * From: noreply@serviceseeking.com.au
 * Subject: "New job — Electrician — Sydney"
 */
function parseServiceSeekingEmail(body, subject) {
  const result = {};

  // Name
  const nameMatch = body.match(/(?:Customer|Name|Client|Contact name)\s*:?\s*([^\n]+)/im);
  if (nameMatch) result.name = nameMatch[1].trim();

  // Phone
  const phoneMatch = body.match(/(?:Phone|Mobile|Contact)\s*:?\s*([\d\s\+\(\)\-]{8,20})/im);
  if (phoneMatch) result.phone = phoneMatch[1].trim().replace(/\s+/g, ' ');

  // Email
  const portalDomains = /serviceseeking\.com\.au|noreply|no-reply|donotreply/i;
  const emailMatches = body.match(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g);
  if (emailMatches) {
    const leadEmail = emailMatches.find(e => !portalDomains.test(e));
    if (leadEmail) result.email = leadEmail;
  }

  // Job description
  const jobMatch = body.match(/(?:Job description|Service required|Description|Job|Service)\s*:?\s*([^\n]+)/im);
  if (jobMatch) result.property_interest = jobMatch[1].trim();

  // Location
  const locMatch = body.match(/(?:Location|Suburb|Area|City)\s*:?\s*([^\n]+)/im);
  if (locMatch && !result.property_interest) result.property_interest = locMatch[1].trim();

  // Message
  const msgMatch = body.match(/(?:Message|Details|Notes)\s*:?\s*([\s\S]{5,500}?)(?:\n\n|\n-{3,}|$)/im);
  if (msgMatch) result.notes = msgMatch[1].trim();

  if (!result.property_interest && subject) {
    const subjectMatch = subject.match(/(?:new job|new lead|job|lead)\s*[-–—:]\s*(.+)/i);
    if (subjectMatch) result.property_interest = subjectMatch[1].trim();
  }

  return result;
}

/**
 * Airtasker lead notification format
 * From: noreply@airtasker.com
 * Subject: "New task posted: Fix tap — Sydney"
 */
function parseAirtaskerEmail(body, subject) {
  const result = {};

  // Name — Airtasker calls them "Poster" or "Task poster"
  const nameMatch = body.match(/(?:Poster|Task poster|Posted by|Customer|Name)\s*:?\s*([^\n]+)/im);
  if (nameMatch) result.name = nameMatch[1].trim();

  // Phone — often not in Airtasker emails, but try
  const phoneMatch = body.match(/(?:Phone|Mobile|Contact number)\s*:?\s*([\d\s\+\(\)\-]{8,20})/im);
  if (phoneMatch) result.phone = phoneMatch[1].trim().replace(/\s+/g, ' ');

  // Email
  const portalDomains = /airtasker\.com|noreply|no-reply|donotreply/i;
  const emailMatches = body.match(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g);
  if (emailMatches) {
    const leadEmail = emailMatches.find(e => !portalDomains.test(e));
    if (leadEmail) result.email = leadEmail;
  }

  // Task description
  const taskMatch = body.match(/(?:Task|Task description|Description|Job)\s*:?\s*([^\n]+)/im);
  if (taskMatch) result.property_interest = taskMatch[1].trim();

  // Location
  const locMatch = body.match(/(?:Location|Suburb|Area)\s*:?\s*([^\n]+)/im);
  if (locMatch && !result.property_interest) result.property_interest = locMatch[1].trim();

  // Budget
  const budgetMatch = body.match(/(?:Budget|Price|Offer)\s*:?\s*(\$[^\n]+)/im);
  if (budgetMatch) result.notes = `Budget: ${budgetMatch[1].trim()}`;

  if (!result.property_interest && subject) {
    const subjectMatch = subject.match(/(?:new task|task posted|task|job)\s*[:\-–—]\s*(.+)/i);
    if (subjectMatch) result.property_interest = subjectMatch[1].trim();
  }

  return result;
}

/**
 * Generic template parser — broad regexes that catch most inquiry formats
 */
function parseGenericTemplate(body) {
  const result = {};

  // Email (most reliable — find any email address in the body that isn't from a portal)
  const portalDomains = /realestate\.com\.au|domain\.com\.au|homely\.com\.au|rent\.com\.au|allhomes\.com\.au|noreply|no-reply|donotreply/i;
  const emailMatches = body.match(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g);
  if (emailMatches) {
    const leadEmail = emailMatches.find(e => !portalDomains.test(e));
    if (leadEmail) result.email = leadEmail;
  }

  // Phone — Australian formats (handles 04xx xxx xxx, 04xx-xxx-xxx, +614x..., 02 xxxx xxxx etc.)
  // Labeled phone fields first (Phone: 0412 345 678)
  const labeledPhone = body.match(/(?:^|\n|\s)(?:Phone|Mobile|Ph|Tel|M|P)\s*[:\-]?\s*((?:\+?61[\s\-]?)?0[2-9](?:[\s\-]?\d){8})/im);
  // Then any bare Australian number (10 digits with optional spaces/hyphens between groups)
  const barePhone = body.match(/\b((?:\+?61[\s\-]?)?0[2-9](?:[\s\-]?\d){8})\b/);
  const phoneMatch = labeledPhone || barePhone;
  if (phoneMatch) result.phone = phoneMatch[1].trim();

  // Name — labeled field first, then sign-off patterns (Thanks, John Smith / Regards, Jane Doe)
  const labeledName = body.match(/(?:^|\n)\s*(?:Name|Full name|Contact name)\s*:?\s*([A-Z][a-z]+(?: [A-Z][a-z]+)+)/im);
  const signOffName = body.match(/(?:thanks|regards|cheers|best|sincerely|kind regards|warm regards|yours)[,\.\s]+([A-Z][a-z]+(?: [A-Z][a-z]+)+)/im);
  if (labeledName) result.name = labeledName[1].trim();
  else if (signOffName) result.name = signOffName[1].trim();

  // Property from subject or "Property:" label
  const propLabel = body.match(/(?:^|\n)\s*(?:Property|Address|Listing)\s*:?\s*(\d+[^\n]{5,80})/im);
  if (propLabel) result.property_interest = propLabel[1].trim();

  // Listing URL — extract from body
  result.property_listing_url = extractListingUrl(body);

  return result;
}

// ─── HTML → Text ────────────────────────────────────────────────────────────────

function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8203;/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Extract Forwarded Body ────────────────────────────────────────────────────

/**
 * When an agent forwards an email, Gmail/Outlook wraps it like:
 * "---------- Forwarded message ---------\nFrom: noreply@realestate.com.au\n..."
 * We want the inner (original) email body.
 */
function extractForwardedContent(body) {
  // Common forwarded message markers
  const forwardMarkers = [
    /[-_]{3,}\s*(?:Forwarded|Original)\s+(?:message|email)\s*[-_]{3,}/i,
    /From:\s+.+@.+\nSent:/i,
    /Begin forwarded message:/i,
    /On .+ wrote:/i,
  ];

  for (const marker of forwardMarkers) {
    const match = body.match(marker);
    if (match) {
      const afterMarker = body.slice(match.index + match[0].length);
      // Skip the headers (From/Date/To/Subject lines) and get to the body
      const bodyStart = afterMarker.search(/\n\n/);
      if (bodyStart !== -1) {
        return afterMarker.slice(bodyStart).trim();
      }
      return afterMarker.trim();
    }
  }

  return body; // Not forwarded — treat entire body as the inquiry
}

// ─── AI Fallback Parser ─────────────────────────────────────────────────────────

async function parseWithAI(body, subject, fromAddress) {
  const truncatedBody = body.slice(0, 3000); // Keep token cost low

  const prompt = `You are extracting lead data from a real estate inquiry email.

Email Subject: ${subject || '(none)'}
From: ${fromAddress || '(unknown)'}
Body:
---
${truncatedBody}
---

Extract the following fields from this email. Return ONLY valid JSON, no markdown, no explanation:
{
  "name": "prospect's full name or null",
  "email": "prospect's email address or null",
  "phone": "prospect's phone number or null",
  "property_interest": "property address or description they're interested in, or null",
  "property_listing_url": "full URL of the property listing on realestate.com.au, domain.com.au or similar portal, or null",
  "notes": "their message/enquiry text or null",
  "lead_type": "one of: buyer, renter, seller, landlord, or null"
}

Important:
- Extract the PROSPECT's details (the person making the inquiry), NOT the agent's or portal's details
- If a field is not present, use null
- Phone numbers: keep Australian format (e.g. 0412 345 678)
- property_listing_url: only include a full URL starting with https:// from a known property portal
- Return ONLY the JSON object`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0
    });

    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) throw new Error('Empty AI response');

    // Strip any markdown code fences
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(jsonStr);

    return {
      ...parsed,
      _parseMethod: 'ai'
    };
  } catch (err) {
    console.error('[Email Parser] AI parse failed:', err.message);
    return { _parseMethod: 'ai_failed' };
  }
}

// ─── Phone Validation ───────────────────────────────────────────────────────────

/**
 * Quick validation that a string looks like a phone number (not an address).
 * Used to reject AI hallucinations like "612 HENRY L DRIVE EAST HILLS".
 * Only allows digits, spaces, hyphens, plus, parens after trimming.
 */
function isLikelyPhone(value) {
  if (!value) return false;
  const trimmed = value.trim();
  // Reject if it contains letters (addresses have letters, phones don't)
  if (/[a-zA-Z]/.test(trimmed)) return false;
  // Must have at least 8 digits
  const digitCount = (trimmed.match(/\d/g) || []).length;
  if (digitCount < 8 || digitCount > 15) return false;
  // Must only contain digits, spaces, hyphens, plus, parens, dots
  if (!/^[\d\s\-\+\(\)\.]+$/.test(trimmed)) return false;
  return true;
}

// ─── Completeness Score ────────────────────────────────────────────────────────

function score(result) {
  let s = 0;
  if (result.name) s += 3;
  if (result.email) s += 3;
  if (result.phone) s += 2;
  if (result.property_interest) s += 1;
  if (result.notes) s += 1;
  return s;
}

// ─── Main Parser ───────────────────────────────────────────────────────────────

/**
 * Parse an incoming email and extract lead data.
 *
 * @param {object} emailData
 * @param {string} emailData.subject
 * @param {string} emailData.body_text  - Plain text body
 * @param {string} [emailData.body_html] - HTML body (fallback)
 * @param {string} [emailData.from_address] - Sender email
 * @returns {object} { lead: {name, email, phone, property_interest, lead_type, source, notes}, confidence: 0-10, parseMethod: string }
 */
/**
 * Extract name from "Name <email>" or "Name (email)" format in from address
 */
function extractNameFromFromAddress(fromAddress) {
  if (!fromAddress) return null;

  // Match "Name <email>" or "Name (email)" patterns
  const displayNameMatch = fromAddress.match(/^([^<(\r\n]+)\s*[<(]/);
  if (displayNameMatch) {
    const name = displayNameMatch[1].trim();
    // Validate it looks like a name (2-3 words, capitalized)
    if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}$/.test(name)) {
      return name;
    }
  }
  return null;
}

/**
 * Extract phone number from any text (subject, from address, etc.)
 */
function extractPhoneFromText(text) {
  if (!text) return null;

  // Australian phone patterns
  const phonePatterns = [
    /\b(0[2-9]\d{1}[\s\-]?\d{3}[\s\-]?\d{3})\b/,  // 02/04xx xxx xxx
    /\b(\+?61[\s\-]?[2-9]\d{2}[\s\-]?\d{3}[\s\-]?\d{3})\b/,  // +61
    /\b(\d{10})\b/,  // 10 digits no separators
  ];

  for (const pattern of phonePatterns) {
    const match = text.match(pattern);
    if (match) return match[1].replace(/\s+/g, ' ').trim();
  }
  return null;
}

async function parseEmailForLead({ subject = '', body_text = '', body_html = '', from_address = '' }) {
  // Prefer text body, fall back to HTML→text
  let body = body_text || htmlToText(body_html);

  const source = detectSource(subject, body, from_address);

  // ── Handle no-body case: extract data from subject + from_address ──
  // This handles Resend inbound webhooks where body is not included
  if (!body) {
    console.log('[Email Parser] No body found — extracting from subject and from_address');

    const result = {};
    let parseMethod = 'no_body_fallback';

    // Use from_address as email (if it's not a known portal/notification domain)
    if (from_address) {
      const emailMatch = from_address.match(/<([^>]+)>/) || from_address.match(/^([^\s<]+@[^\s>]+)/);
      if (emailMatch) {
        const email = emailMatch[1];
        const nonProspectDomains = /realestate\.com\.au|domain\.com\.au|homely\.com\.au|rent\.com\.au|allhomes\.com\.au|facebookmail\.com|noreply|no-reply|donotreply|google\.com/i;
        if (!nonProspectDomains.test(email) && !email.includes('noreply')) {
          result.email = email;
        }
      }

      // Try to extract display name from "Name <email>" format
      const displayName = extractNameFromFromAddress(from_address);
      if (displayName) result.name = displayName;
    }

    // Extract property from subject: "Property Inquiry - 42 Ocean Street, Bondi"
    if (subject) {
      const subjectPropDash = subject.match(/(?:inquiry|enquiry|interest|question)\s*[-–—]\s*(\d+[^-\n]{5,80})/i);
      const subjectPropColon = subject.match(/(?:for|:|re:)\s+(.{5,80}?)(?:\s+-\s+.+)?$/i);
      if (subjectPropDash) {
        result.property_interest = subjectPropDash[1].trim();
      } else if (subjectPropColon) {
        result.property_interest = subjectPropColon[1].trim();
      }

      // Try to extract phone from subject if present
      const subjectPhone = extractPhoneFromText(subject);
      if (subjectPhone) result.phone = subjectPhone;

      // Try to extract name from subject if it's in "Name: message" format
      const subjectName = subject.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+sent you/i);
      if (subjectName) result.name = result.name || subjectName[1].trim();
    }

    // Run AI extraction if we still don't have minimum data
    const hasData = result.name || result.email || result.phone;
    if (!hasData || !result.property_interest) {
      console.log('[Email Parser] No-body fallback: running AI extraction...');
      try {
        const aiResult = await parseWithAI('', subject, from_address);
        if (aiResult.name) result.name = result.name || aiResult.name;
        if (aiResult.email) result.email = result.email || aiResult.email;
        if (aiResult.phone && isLikelyPhone(aiResult.phone)) result.phone = result.phone || aiResult.phone;
        if (aiResult.property_interest) result.property_interest = result.property_interest || aiResult.property_interest;
        if (aiResult.lead_type) result.lead_type = aiResult.lead_type;
        parseMethod = 'ai_no_body';
      } catch (aiErr) {
        console.log('[Email Parser] AI fallback failed:', aiErr.message);
      }
    }

    result.lead_type = result.lead_type || detectLeadType(subject, '', source) || null;

    const confidence = score(result);

    // ── More lenient minimum data check for no-body case ──
    // When there's no body, we often only have email from from_address.
    // Allow lead creation with just email/phone + property (name optional).
    const hasMinimumData = !!(result.email || result.phone) && !!result.property_interest;

    return {
      lead: hasMinimumData ? {
        name: result.name || null,  // Name may be null in no-body case - will show as "(name unknown)" in UI
        email: result.email || null,
        phone: result.phone || null,
        property_interest: result.property_interest || null,
        property_listing_url: null,
        lead_type: result.lead_type || null,
        source,
        notes: null
      } : null,
      rawExtracted: result,
      confidence,
      parseMethod,
      source,
      hasMinimumData
    };
  }

  // ── Normal path: body exists ──

  // Extract the actual inquiry content (strips forwarding wrapper)
  const inquiryBody = extractForwardedContent(body);

  // Try template parsers in priority order
  let result = {};
  let parseMethod = 'generic';

  if (source === 'REA') {
    result = parseREAEmail(inquiryBody);
    parseMethod = 'rea_template';
  } else if (source === 'Domain') {
    result = parseDomainEmail(inquiryBody);
    parseMethod = 'domain_template';
  } else if (source === 'Homely') {
    result = parseHomelyEmail(inquiryBody);
    parseMethod = 'homely_template';
  } else if (source === 'Rent.com.au') {
    result = parseRentEmail(inquiryBody);
    parseMethod = 'rent_template';
  } else if (source === 'Facebook' || source === 'Instagram') {
    result = parseFacebookEmail(subject, inquiryBody);
    parseMethod = 'facebook_template';
  } else if (source === 'Hipages') {
    result = parseHipagesEmail(inquiryBody, subject);
    parseMethod = 'hipages_template';
  } else if (source === 'ServiceSeeking') {
    result = parseServiceSeekingEmail(inquiryBody, subject);
    parseMethod = 'serviceseeking_template';
  } else if (source === 'Airtasker') {
    result = parseAirtaskerEmail(inquiryBody, subject);
    parseMethod = 'airtasker_template';
  } else {
    // Generic template for all other sources (Allhomes, RealCommercial, Oneflare, Website, Email, etc.)
    result = parseGenericTemplate(inquiryBody);
    parseMethod = 'generic_template';
  }

  // ── Broad fallback extraction ──────────────────────────────────────────────
  // Real portal emails forwarded through Gmail often have HTML that converts to
  // text with fields on the SAME LINE (no newlines between Name/Email/Phone).
  // The template parsers require (?:^|\n) before labels, so they miss mid-line
  // fields. This fallback catches those cases.
  if (!result.email) {
    const portalDomains = /realestate\.com\.au|domain\.com\.au|homely\.com\.au|rent\.com\.au|allhomes\.com\.au|facebookmail\.com|noreply|no-reply|donotreply/i;
    // Try labeled email first (mid-line): "Email: foo@bar.com" or "Email foo@bar.com"
    const labeledEmail = inquiryBody.match(/(?:Email|E-mail|Email address)\s*:?\s*([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/i);
    if (labeledEmail && !portalDomains.test(labeledEmail[1])) {
      result.email = labeledEmail[1].trim();
    } else {
      // Find ANY email in the body that isn't from a portal/notification domain
      const emailMatches = inquiryBody.match(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g);
      if (emailMatches) {
        const leadEmail = emailMatches.find(e => !portalDomains.test(e));
        if (leadEmail) result.email = leadEmail;
      }
    }
  }

  if (!result.phone) {
    // Try labeled phone (mid-line): "Mobile: 0412 345 678" or "Phone: 0412 345 678"
    const labeledPhone = inquiryBody.match(/(?:Phone|Mobile|Ph|Tel|Contact number|Phone number)\s*:?\s*((?:\+?61[\s\-]?)?0[2-9](?:[\s\-]?\d){8})/i);
    const barePhone = inquiryBody.match(/\b((?:\+?61[\s\-]?)?0[2-9](?:[\s\-]?\d){8})\b/);
    const phoneMatch = labeledPhone || barePhone;
    if (phoneMatch) result.phone = phoneMatch[1].trim().replace(/\s+/g, ' ');
  }

  // Clean name — remove embedded Email/Phone that got captured by the name regex
  if (result.name) {
    result.name = result.name
      .replace(/\s*(?:Email|E-mail)\s*:?\s*[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/gi, '')
      .replace(/\s*(?:Mobile|Phone|Ph|Tel|Contact number|Phone number)\s*:?\s*(?:\+?61[\s\-]?)?0[2-9](?:[\s\-]?\d){8}/gi, '')
      .trim();
  }

  // If template extraction is weak (score < 5), run AI extraction
  let finalResult = result;
  if (score(result) < 5) {
    console.log(`[Email Parser] Template score ${score(result)}/10, running AI extraction...`);
    const aiResult = await parseWithAI(inquiryBody, subject, from_address);
    // Validate AI phone result — AI sometimes returns street addresses as phone numbers
    // (e.g. "612 HENRY L DRIVE EAST HILLS" when address starts with digits)
    const aiPhone = isLikelyPhone(aiResult.phone) ? aiResult.phone : null;
    // Merge: prefer AI result where it has data, keep template result as backup
    finalResult = {
      name: aiResult.name || result.name || null,
      email: aiResult.email || result.email || null,
      phone: aiPhone || result.phone || null,
      property_interest: aiResult.property_interest || result.property_interest || null,
      property_listing_url: result.property_listing_url || aiResult.property_listing_url || null,
      notes: aiResult.notes || result.notes || null,
      lead_type: aiResult.lead_type || detectLeadType(subject, body, source, aiResult.property_interest || result.property_interest || '') || null,
    };
    parseMethod = aiResult._parseMethod === 'ai' ? 'ai' : `${parseMethod}+ai_failed`;
  } else {
    finalResult.lead_type = finalResult.lead_type || detectLeadType(subject, body, source, finalResult.property_interest || '') || null;
  }

  // For direct emails (not from a portal), use from_address as the prospect's email fallback.
  // When someone emails the leads address directly, they ARE the prospect.
  // BUT: for portal-sourced emails (REA, Domain, etc.), from_address is the FORWARDER
  // (e.g. the real estate agent who forwarded the inquiry), NOT the lead.
  const portalSources = ['REA', 'Domain', 'Homely', 'Rent.com.au', 'Allhomes', 'RealCommercial', 'Facebook', 'Instagram', 'Airbnb', 'Booking.com', 'Hipages', 'ServiceSeeking', 'Airtasker', 'Oneflare'];
  if (!finalResult.email && from_address && !portalSources.includes(source)) {
    const nonProspectDomains = /realestate\.com\.au|domain\.com\.au|homely\.com\.au|rent\.com\.au|allhomes\.com\.au|facebookmail\.com|noreply|no-reply|donotreply/i;
    if (!nonProspectDomains.test(from_address)) {
      finalResult.email = from_address;
    }
  }

  // Extract property from subject as last resort
  if (!finalResult.property_interest && subject) {
    // "Enquiry for 45 Example St" or "New enquiry: 45 Example St"
    const subjectPropColon = subject.match(/(?:for|:|re:)\s+(.{5,80}?)(?:\s+-\s+.+)?$/i);
    // "Property Inquiry - 42 Ocean Street, Bondi" (inquiry/enquiry/interest followed by dash+address)
    const subjectPropDash = subject.match(/(?:inquiry|enquiry|interest|question)\s*[-–]\s*(\d+[^-\n]{5,80})/i);
    const subjectProp = subjectPropDash || subjectPropColon;
    if (subjectProp) finalResult.property_interest = subjectProp[1].trim();
  }

  // Extract property from body as last resort — "listing for X" or "property at X"
  if (!finalResult.property_interest) {
    const bodyPropPattern = body.match(/(?:listing|property)\s+(?:at|for)\s+(\d+[^\n.,!?]{5,80})/i);
    if (bodyPropPattern) finalResult.property_interest = bodyPropPattern[1].trim();
  }

  // ── Global "enquiry for:" cleanup ──────────────────────────────────────────
  // Strip "enquiry for:" prefix from property_interest regardless of parser
  if (finalResult.property_interest) {
    finalResult.property_interest = finalResult.property_interest
      .replace(/^(?:enquiry|inquiry)\s+for\s*:\s*/i, '')
      .trim();
  }

  // ── Use property_interest text for lead type if still undetected ──────────
  if (!finalResult.lead_type && finalResult.property_interest) {
    finalResult.lead_type = detectLeadType(finalResult.property_interest, '', source);
  }

  const confidence = score(finalResult);
  const hasMinimumData = !!(finalResult.name && (finalResult.email || finalResult.phone));

  return {
    lead: hasMinimumData ? {
      name: finalResult.name,
      email: finalResult.email || null,
      phone: finalResult.phone || null,
      property_interest: finalResult.property_interest || null,
      property_listing_url: finalResult.property_listing_url || null,
      lead_type: finalResult.lead_type || null,
      source,
      notes: finalResult.notes || null
    } : null,
    rawExtracted: finalResult,
    confidence,
    parseMethod,
    source,
    hasMinimumData
  };
}

module.exports = { parseEmailForLead, detectSource };
