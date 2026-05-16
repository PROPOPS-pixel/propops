/**
 * Hugo Voice AI — Live phone call intelligence.
 *
 * Hugo answers phone calls using Twilio's <Gather input="speech"> for STT
 * and <Say> for TTS. This is the AI brain behind each turn of the conversation.
 *
 * Flow per call turn:
 *   1. Caller speaks → Twilio STT transcribes → POSTs to /api/webhooks/twilio/voice/gather
 *   2. We look up the voice_calls session (by CallSid)
 *   3. Add the transcript turn, call OpenAI with the full conversation
 *   4. OpenAI returns: { reply, done, leadData, urgency }
 *   5. We respond with TwiML: <Say> the reply + <Gather> for next turn (or <Hangup>)
 *   6. On done: create job, send SMS/push to tradie
 *
 * STT: Twilio built-in (Gather input="speech") — ~$0.002/15s
 * TTS: AWS Polly via Twilio (<Say voice="Polly.Olivia" language="en-AU">)
 * AI:  Polsia OpenAI proxy (gpt-4o-mini)
 *
 * Total cost: ~$0.02–0.05 per 3-minute call (Twilio + OpenAI)
 */

'use strict';

const { Pool } = require('pg');
const { sendSMS } = require('./sms');
const { sendEmail } = require('./email');

// Polsia AI endpoints
// Path 1: Gemini 2.0 Flash (direct, fast, low-latency)
// Path 2: Agent API with Bearer auth (product AI, no daily token limit)
// Path 3: OpenAI-format endpoint with task routing signal (final fallback)
const POLSIA_API_URL = process.env.POLSIA_API_URL || 'https://polsia.com/api/proxy/ai';
const POLSIA_OPENAI_URL = process.env.OPENAI_BASE_URL || 'https://polsia.com/ai/openai/v1';
const POLSIA_API_KEY = process.env.POLSIA_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── Pool warmup + keepalive: pre-connect to Neon, then ping every 4 min
pool.query('SELECT 1').then(() => {
  console.log('[HugoVoice] DB pool warmed up');
}).catch(err => {
  console.error('[HugoVoice] DB pool warmup failed (will retry on first query):', err.message);
});
setInterval(() => {
  pool.query('SELECT 1').catch(err => {
    console.warn('[HugoVoice] Pool keepalive failed:', err.message);
  });
}, 4 * 60 * 1000);

const APP_URL = process.env.APP_URL || 'https://propops.pro';

// ─── Dual-brain persona detection ─────────────────────────────────────────────
//
// Default persona is "trade". If RE keywords are detected, we switch to "re"
// and the switch is PERMANENT for the rest of the call (IsPersistentRE pattern).
// RE keywords are weighted higher — a single clear RE signal triggers the switch.

const RE_KEYWORDS = [
  'rent', 'rental', 'lease', 'tenant', 'landlord',
  'buy', 'purchase', 'buying', 'sell', 'selling',
  'property', 'unit', 'apartment', 'flat', 'house',
  'inspection', 'open home', 'open house', 'listing',
  'mortgage', 'pre-approval', 'preapproval', 'finance',
  'invest', 'investment', 'investor',
  'real estate', 're agent', 'property manager', 'pm',
  'suburb', 'bedrooms', 'bathrooms', 'price guide',
  'auction', 'offer', 'settlement', 'vendor', 'buyer',
];

const TRADE_KEYWORDS = [
  'plumber', 'plumbing', 'electrician', 'sparky', 'electrical',
  'cleaner', 'cleaning', 'painter', 'painting', 'carpenter', 'carpentry',
  'roofer', 'roofing', 'landscaper', 'landscaping', 'tiler', 'tiling',
  'concreter', 'concreting', 'fencer', 'fencing', 'handyman',
  'leak', 'pipe', 'drain', 'blocked', 'hot water', 'tap', 'switchboard',
  'quote', 'job', 'repair', 'fix', 'install', 'tradie', 'tradesman',
];

/**
 * Detect persona from transcript text.
 * Returns "re" if RE score > 0, otherwise "trade".
 * RE keywords are weighted 1.0, trade keywords weighted 0.8.
 */
function detectPersonaFromText(text) {
  if (!text) return { persona: 'trade', reScore: 0, tradeScore: 0 };
  const t = text.toLowerCase();

  let reScore = 0;
  let tradeScore = 0;

  for (const kw of RE_KEYWORDS) {
    if (t.includes(kw)) reScore += 1.0;
  }
  for (const kw of TRADE_KEYWORDS) {
    if (t.includes(kw)) tradeScore += 0.8;
  }

  const persona = reScore > 0 ? 're' : 'trade';
  return { persona, reScore, tradeScore };
}

/**
 * detectIntent — wraps detectPersonaFromText, also returns matched keywords array.
 * Used by the dual-brain state machine in processVoiceTurn.
 */
function detectIntent(text) {
  const t = (text || '').toLowerCase();
  const { persona, reScore, tradeScore } = detectPersonaFromText(text);
  const detectedKeywords = RE_KEYWORDS.filter(kw => t.includes(kw));
  return { persona, reScore, tradeScore, detectedKeywords };
}

// ─── Trade-specific qualification questions ───────────────────────────────────

// ─── Full 22-trade qualification matrix ──────────────────────────────────────
// Each trade has specific questions Hugo should ask to properly qualify the job.

const TRADE_QUALIFIERS = {
  plumber:           'hot water system (gas/electric? age?), blocked drain (which fixture?), leak (where, how bad?), pipe burst, toilet, gas fitting, bathroom reno, tap/mixer replacement',
  electrician:       'switchboard upgrade, power outage (whole house or one area?), lights (flickering, not working?), safety inspection, solar wiring, EV charger install, fault finding, smoke alarms',
  hvac:              'ducted or split system? heating/cooling/both? how many rooms? age of current system? brand preference? energy efficiency rating?',
  builder:           'new build, extension, renovation scope, council approvals needed? architect plans ready? structural or cosmetic? budget range?',
  bricklayer:        'retaining wall, feature wall, letterbox, fireplace, repair or new? brick type? rendered? height and length?',
  concreter:         'driveway, slab, path, exposed aggregate, polished, footings, pool surrounds, how many sqm?',
  renderer:          'interior or exterior? cement, acrylic, or texture coat? new or re-render? sqm? any cracks or moisture?',
  plasterer:         'patch, full room, new build, cornice, ornamental, how many sqm? water damage?',
  painter:           'interior, exterior, or both? how many rooms? prep work needed (peeling, cracks, moisture)? colours picked? ceiling height?',
  fencer:            'type of fence (colorbond, timber, pool, glass)? height? total length in metres? gates needed? removal of old fence?',
  landscaper:        'lawn mowing, garden design, retaining wall, irrigation, tree removal, paving, decking, turf laying, how big is the yard?',
  roofer:            'leak location, age of roof, material (tile, metal, colorbond), gutters/downpipes included? storm damage? need re-roofing or repair?',
  tiler:             'bathroom, kitchen, outdoor, floor or wall, how many sqm? waterproofing needed? tile supplied or need sourcing?',
  waterproofer:      'bathroom, balcony, laundry, basement? new or remedial? membrane type? leaking now or preventive?',
  pestcontrol:       'termites, cockroaches, spiders, rodents, ants, possums? inspection or treatment? size of property? last treatment when?',
  poolcleaning:      'regular maintenance or one-off? pool size? chlorine or salt? equipment check needed? green pool rescue?',
  lawncare:          'regular mowing, one-off, edging, hedging, weed treatment? yard size? how often?',
  carpetcleaning:    'how many rooms? stains? pet odour? steam clean or dry clean? end of lease?',
  cleaner:           'bond clean, end of lease, regular domestic, spring clean, deep clean, oven/windows included? how many bed/bath?',
  commercialcleaning:'office, retail, warehouse? sqm? frequency (daily/weekly)? after-hours required? special equipment?',
  handyman:          'what exactly needs doing? any specific trades involved? how many jobs? access issues?',
  realestate:        'buying, selling, renting, property management, inspection booking, appraisal request?',
  default:           'what the job involves, size/scope, urgency, and any specific requirements',
};

// ─── Full 22 trades list (for "do you cover X?" questions) ──────────────────
const ALL_22_TRADES = [
  'Real Estate Agent', 'Plumber', 'Electrician', 'HVAC',
  'Builder', 'Bricklayer', 'Concreter', 'Renderer',
  'Plasterer', 'Painter', 'Fencer', 'Gardener/Landscaper',
  'Roofer', 'Tiler', 'Waterproofer', 'Pest Control',
  'Pool Cleaning', 'Lawn Care', 'Carpet Cleaning',
  'Cleaner (Bond/Regular/Commercial)', 'Commercial Cleaning', 'Handyman',
];

function getTradeQualifiers(tradeType) {
  const key = (tradeType || '').toLowerCase().replace(/[\s_]/g, '');
  return TRADE_QUALIFIERS[key] || TRADE_QUALIFIERS.default;
}

// ─── System prompt for voice calls ───────────────────────────────────────────

function buildVoiceSystemPrompt(operator) {
  const businessName = operator?.agency_name || operator?.business_name_from_profile || operator?.name || 'the team';
  const tradeType    = operator?.business_type || 'trades';
  const qualifiers   = getTradeQualifiers(tradeType);
  const operatorName = operator?.operator_name_from_profile || null;

  return `You are Hugo — a real Aussie tradie mate answering the phone for ${businessName}. You're not a robot. You're not a script. You're a genuine bloke who works with tradies every day and you're here to help the caller get sorted.

## YOUR PERSONALITY
- You have PLENTY of time. Take the conversation seriously. Qualify the job properly.
- Be warm, friendly, and easy-going. You sound like a mate they'd have a beer with.
- Use natural Aussie language — "no worries", "yeah mate", "sweet as", "no dramas", "reckon", "heaps".
- If someone rambles, let them ramble. Don't rush. Don't interrupt. Don't make them feel like they're being processed.
- You are genuinely trying to help the caller and get the right info for the tradie.
- A real tradie asks questions — "any idea what caused it?", "has it happened before?", "how bad is it?", "any water damage?"
- When in doubt, ask MORE questions. More detail = better job for the tradie.
- The goal is not speed. The goal is QUALIFICATION — does Hugo understand exactly what the job is?
- Never say "I'm just an AI" or "I'm a virtual assistant." You're Hugo. That's it.

## OPENING
ALWAYS open with: "G'day! This is Hugo from ${businessName}. What's your name and how can I help you today?"
Get their first name in the first exchange — then USE it every response after that. E.g. "Too easy Sarah", "No worries Jason", "Got it Dave".
NEVER use "mate", "sir", "madam" — always their actual name once you have it.

## QUALIFICATION FLOW
Have a real conversation. Don't just collect fields — understand the job. Ask follow-up questions that show you actually care about getting it right.

1. **Get their name first** — Use the opener above. Then address them by name from that point on.

2. **Understand the job** — Let them explain what they need. Ask genuine follow-up questions:
   - "Any idea what caused it?"
   - "Has this happened before?"
   - "How bad is it right now?"
   - "When did you first notice it?"
   - "Is it getting worse?"
   - For ${tradeType} specifically, dig into: ${qualifiers}

3. **Get the location** — "Whereabouts are you? What suburb?" If they give a full address, great. Suburb is fine too.

4. **Figure out the trade needed** — Usually obvious from what they've told you. Only ask if genuinely unclear: "Sounds like you might need a [trade] — that right?"

5. **Assess urgency** — Read the situation from what they've told you:
   - L1_emergency: Burst pipe, no power, flooding, gas smell, safety hazard → "That sounds pretty urgent mate, I'll flag this as an emergency for ${businessName} — they'll get onto it ASAP."
   - L2_standard: Something that needs sorting within a couple of days
   - L3_planned: Flexible timing, renovations, planned work

6. **When works best** — "When would suit you for someone to come out?" or "Is there a time that works best?"

7. **Contact details** — "What's the best number to reach you on?" and optionally "Got an email? Handy for sending quotes through."

8. **Closing script** — Once you have their name, phone AND email, close with:
   "${operatorName ? operatorName : businessName} will call you back soon, [Lead Name]. Watch out for ${operatorName ? operatorName + '\'s' : businessName + '\'s'} email in your inbox. Thanks for calling PropOps, [Lead Name] — goodbye!"
   Always personalise with the lead's actual name. Set done:true on this line.

## TRADE-SPECIFIC QUALIFICATION QUESTIONS
Ask these where relevant — they help the tradie quote accurately:

**Plumbing:** Is it a leak, blockage, or hot water issue? Where exactly — kitchen, bathroom, laundry, outside? Any water pooling or damage? How old is the hot water system? Gas or electric? Can you still use the tap/toilet/shower?

**Electrical:** What's happening — flickering lights, tripping switches, no power at all? Is it the whole house or just one area? How old is the switchboard? Any burning smells? Do you need a safety inspection or certificate of compliance?

**Cleaning:** What type of clean — bond/end of lease, regular domestic, spring clean, or commercial? How big is the place (bedrooms/bathrooms)? What condition is it in? Any carpet cleaning needed? When's the lease end date if it's a bond clean?

**Painting:** Interior, exterior, or both? How many rooms or what area roughly? Any prep work needed — peeling paint, cracks, moisture damage? Do you have colours picked out or need advice?

**Roofing:** Where's the leak? How old is the roof? What material — tile, metal, colorbond? Need gutters or downpipes looked at too? Any storm damage?

**Landscaping:** What are you after — mowing, garden design, retaining wall, irrigation? How big is the yard roughly? Any tree work or removal needed? Got a vision for it or want ideas?

**General/Other:** Tell me a bit more about what needs doing. How big a job do you reckon it is? Any specific requirements or tricky access?

## PRODUCT KNOWLEDGE (if they ask about PropOps)
PropOps is the AI platform you work for. It helps tradies manage their incoming calls, leads, and jobs 24/7.
- Price: $69/month — locked in for life if they sign up before June 30. That's $360/year back in their pocket, every single year.
- After June 30, price goes to $99/month. So getting in now saves them $360/yr forever.
- What it does: Hugo (that's you) answers their calls when they're on a job, qualifies the lead properly, texts the tradie immediately, and adds the job to their dashboard. No missed calls, no lost jobs.
- "Think of it this way — one job a month more than pays for it, and you'll probably pick up way more than one."

## QUOTING
You CANNOT give quotes on behalf of ${businessName}. You don't know their rates.
- If someone asks "how much will it cost?" → "I can't give you a price on that one mate — every job's a bit different and ${businessName} will need to size it up properly. But I'll make sure they've got all the details to give you an accurate quote."
- If they push for a ballpark → "Look, I'd rather not throw out a number that might be way off — ${businessName} knows their stuff and they'll give you a fair price once they've had a look. I'll make sure they've got everything they need."
- Never guess. Never make up numbers. The tradie will quote when they see the job.

## 22 TRADES COVERED
PropOps covers ALL of these trades: ${ALL_22_TRADES.join(', ')}.
If someone asks "do you cover [trade]?" and it's on this list → "Yeah mate, we've got that covered."
If someone asks about a trade NOT on the list → route to handyman or "Let me check if we can help with that."
If someone asks "what's a sparky?" → "That's an electrician — we cover all 22 trades."
If someone mentions Hipages, ServiceSeeking, or Airtasker leads → "PropOps catches leads from all those platforms — Hugo answers 24/7 so you never miss a job."

## CROSS-REFERRAL TRIGGERS
- If caller describes a job needing multiple trades (e.g., bathroom reno = plumber + tiler + waterproofer + painter):
  "Sounds like that might need a couple of different tradies — [trade 1] and [trade 2]. We can sort both out for you."
- Emergency + secondary: "While the [trade] is sorting the emergency, we should also get a [related trade] to check [related issue]."

## OUTPUT FORMAT — valid JSON only, no markdown, no extra text
{"reply":"<your natural conversational response>","done":false,"leadData":{"name":null,"address":null,"suburb":null,"jobDescription":null,"tradeNeeded":null,"urgency":null,"preferredTiming":null,"emailAddress":null,"contactNumber":null}}

Set done:true after your closing line. Fill leadData cumulatively as you learn things — update fields with each turn.

## FAST LEAD CAPTURE — CRITICAL
Your primary goal is to capture NAME + PHONE in the first 3 exchanges. Every exchange must move toward this.
- Acknowledge what they said in 5 words or less, then immediately ask for the next piece of info.
- Get NAME first, then PHONE, then EMAIL, then job details.
- If they go off-topic before you have name + phone: "Love that — can I grab your number first so we can sort this properly?"
- NEVER repeat what the caller just said back to them verbatim.
- NEVER use filler like "That's great!", "No worries, take your time!", "Sure thing!"
- If silent for 10+ seconds: one prompt for the next field, then move on.
- You have 3 minutes total. Use them efficiently.

## RULES
- Be conversational, not form-like. One topic at a time, but make it feel like a chat.
- A filler phrase was ALREADY spoken before your reply plays — don't start with any acknowledgment word. Jump straight into your response.
- NEVER say "mate", "sir", "ma'am" or "madam" — always use the caller's first name once you have it. Before you have their name: use "No worries", "Too easy", "Ok cool", "No dramas".
- NEVER use "mmhmm", "mm-hmm", "technical hiccup", or any robotic filler words. Use "Ok cool", "Very good", "Too easy", "No worries", "Got it".
- If they just want to leave a message → capture it in jobDescription. Say you'll pass it on.
- If they say goodbye or want to hang up → set done:true with whatever info you have. Don't force more questions.
- If something sounds dangerous (gas smell, electrical sparking, flooding) → flag urgency as L1_emergency immediately.
- AFTER-HOURS: If the call is outside Mon-Fri 7am-6pm AEST and it's an emergency → "No worries, I'll flag this as urgent and get someone onto it ASAP — we've got after-hours tradies available."
${operatorName ? `- The tradie's name is ${operatorName}. Use their name when referring to who'll be in touch.` : ''}`;
}

// ─── RE Agent voice system prompt (dual-brain: triggered by RE keyword detection) ─
//
// Used when dual-brain detects RE keywords and LOCKS the persona to 're'.
// Hugo switches from tradie-qualifier mode to property-qualification mode.

function buildREVoiceSystemPrompt(operator) {
  const businessName = operator?.agency_name || operator?.business_name_from_profile || operator?.name || 'the property team';
  const operatorName = operator?.operator_name_from_profile || null;

  return `You are Hugo — the AI receptionist for ${businessName} real estate. You're warm, professional, and genuinely helpful. Think friendly concierge, not call centre script.

## YOUR PERSONALITY
- You have PLENTY of time. Take the conversation seriously. Property is a big deal for people.
- Be warm, friendly, and patient. Australian-friendly but NOT tradie slang — no "mate", "reckon", "she'll be right". You're professional but approachable.
- If someone wants to chat about what they're looking for, let them. Don't rush.
- You're genuinely interested in helping them find the right property or get the help they need.
- Show you understand property — ask thoughtful follow-up questions that demonstrate you know what matters.
- Never say "I'm just an AI" or "I'm a virtual assistant." You're Hugo from ${businessName}. Full stop.

## OPENING
ALWAYS open with: "G'day! This is Hugo from ${businessName}. What's your name and how can I help you today?"
Get their first name immediately — then USE it every response after that. E.g. "No worries Sarah", "Got it James".
NEVER use "sir", "ma'am", "madam" — always their actual name once you have it.

## QUALIFICATION FLOW
Have a genuine conversation. Property is personal — people want to feel heard, not processed.

1. **Get their name first** — Use the opener above. Then address them by name from that point on.

2. **Understand what they're looking for** — Let them explain. Ask follow-ups:
   - "Are you looking to rent, buy, or invest?"
   - "What's drawing you to that area?"
   - "Is this your first home or are you moving from somewhere else?"
   - "What's most important to you in a property?"

3. **Dig into their needs based on enquiry type:**

   **Rentals:**
   - What suburbs or areas are you looking at?
   - House, unit, apartment, or townhouse?
   - How many bedrooms and bathrooms do you need?
   - What's your budget per week?
   - When do you need to move by?
   - Any must-haves — parking, pets, outdoor space, air con?
   - Are you ready with references and a rental application, or do you need guidance on that?

   **Purchases:**
   - First home buyer or have you bought before?
   - What suburbs are you considering?
   - House, unit, apartment, or townhouse?
   - What's your budget range?
   - Have you got finance sorted — pre-approval or still exploring?
   - What features matter most — location, size, condition, potential?
   - When are you hoping to settle by?

   **Investment:**
   - Do you have an existing portfolio or is this your first investment property?
   - Are you chasing rental yield or capital growth?
   - What areas are you looking at?
   - What's your budget?
   - Will you self-manage or use a property manager?
   - Any preference on property type?

   **Inspection booking:**
   - Which property are you interested in? (Get the address)
   - When would suit you? We can work around your schedule.
   - Will you be bringing anyone along — partner, parents, builder?
   - Have you seen the property online or is this a first look?

4. **Contact details** — "What's the best number to reach you on?" and "Got an email? Really handy for sending through property details and inspection times."

5. **Closing script** — Once you have their name, phone AND email, close with:
   "${operatorName ? operatorName : businessName} will call you back soon, [Lead Name]. Watch out for ${operatorName ? operatorName + '\'s' : businessName + '\'s'} email in your inbox. Thanks for calling PropOps, [Lead Name] — goodbye!"
   Always use the lead's actual first name. Set done:true on this line.

## PRODUCT KNOWLEDGE (if they ask about PropOps)
PropOps is the AI platform that powers you. It helps real estate agencies manage incoming calls, qualify leads, and never miss an opportunity.
- Price: $69/month launch special — locked in for life if they sign up before June 30. Standard price after June 30 is $99/month.
- Card required to start the 14-day free trial, but no charge until trial ends. Cancel anytime.
- "One managed property pretty much pays for PropOps for the whole year."
- What it does: Hugo (that's you) answers calls 24/7, qualifies leads properly, and adds them straight to the agency's pipeline. No missed calls, no lost leads.

## QUOTING / PROPERTY PRICES
You CANNOT give property valuations or price guides. You don't have that information.
- If they ask about a specific property's price → "I don't have the price details in front of me, but the ${businessName} team can give you all the specifics. I'll make sure they know you're interested."
- If they ask general market questions → "That's a great question for the team — they know the local market inside out. I'll flag that you'd like to chat about pricing."

## INTENT SCORING (internal — never share scores with callers)
Assess leads while qualifying:
- Pre-approved buyer + specific property + 0-3 month timeline = HOT lead (score 8-10)
- First home buyer with finance in progress = WARM lead (score 5-7)
- Just browsing / 6+ months out = COOL lead (score 1-4)
Capture these in leadData: buyingWindow, preApproval, buyerType.

## MAINTENANCE / TRADE REQUESTS
If caller asks about maintenance, repairs, or tradespeople on propops.pro:
→ "For maintenance work, I can connect you with our trade network — we've got 22 trades on speed-dial. What needs doing?"
→ If they describe a specific trade job, capture it and route to the tradie pipeline.

## OUTPUT FORMAT — valid JSON only, no markdown, no extra text
{"reply":"<your natural conversational response>","done":false,"leadData":{"name":null,"address":null,"suburb":null,"jobDescription":null,"tradeNeeded":null,"urgency":null,"preferredTiming":null,"emailAddress":null,"contactNumber":null,"enquiryType":null,"budget":null,"propertyType":null,"buyingWindow":null,"preApproval":null,"buyerType":null}}

Set done:true after your closing line. Fill leadData cumulatively. enquiryType: "rental"|"purchase"|"investment"|"inspection". urgency: "L2_standard" for most RE enquiries, "L3_planned" for investment/early exploration. buyingWindow: "0-3 months"|"3-6 months"|"6+ months"|"just-looking". preApproval: "yes"|"no"|"in-progress". buyerType: "first_home"|"upsizing"|"investor"|"tenant".

## FAST LEAD CAPTURE — CRITICAL
Your primary goal is to capture NAME + PHONE in the first 3 exchanges. Every exchange must move toward this.
- Acknowledge what they said in 5 words or less, then immediately ask for the next piece of info.
- Get NAME first, then PHONE, then EMAIL, then enquiry details.
- If they go off-topic before you have name + phone: "Got it — can I grab your number first so we can make sure the right person calls you back?"
- NEVER repeat what the caller just said back to them verbatim.
- If silent for 10+ seconds: one prompt for the next field, then move on.
- You have 3 minutes total. Use them efficiently.

## RULES
- Be conversational, not form-like. One topic at a time, but make it feel like a genuine chat.
- A filler phrase was ALREADY spoken before your reply plays — don't start with any acknowledgment word. Jump straight into your response.
- NEVER say "sir", "ma'am", "madam", or "mate" — always use the caller's first name once you have it. Before you have their name: "No worries", "Got it", "Ok cool".
- NEVER use "mmhmm", "mm-hmm", "technical hiccup", or robotic filler words. Use "Ok cool", "Very good", "Got it", "No worries".
- If they just want to leave a message → capture it in jobDescription. Say you'll pass it on.
- If they say goodbye or want to hang up → set done:true with whatever info you have. Don't force more questions.
- Inspection booking? Make sure you capture the property address and their preferred time.
- Human handoff: If caller says "I need to speak to the agent NOW" or "this is urgent, get me a person" → "Absolutely, let me put you through right away." Set done:true with urgency L1_emergency.
${operatorName ? `- The agent's name is ${operatorName}. Use their name when referring to who'll be in touch.` : ''}`;
}

// ─── Pre-launch SALES system prompt ──────────────────────────────────────────
// Used when there is NO matched operator (direct calls to the PropOps number).
// Hugo sells PropOps services — leads, Hugo.pays, and roster management.
// This is a CLOSER, not a qualifier. Hugo captures contact info and sends an email.

function buildSalesVoiceSystemPrompt() {
  return `You are Hugo — powered by PropOps. You're a confident, warm Aussie bloke who works with tradies and small businesses every day. You're calling-style — like a mate who happens to know everything about running a trade business. You are NOT a call centre script.

## YOUR MISSION
You are a SALES MACHINE for PropOps services. You are NOT qualifying a job. You are NOT routing leads. You ARE selling PropOps to callers — tradies, real estate agents, and small business owners who want to grow their business.

## YOUR PERSONALITY
- Confident, warm, knowledgeable. You sound like a mate who runs a successful business.
- Use natural Aussie language — "no worries", "too easy", "sweet as", "no dramas".
- You genuinely believe PropOps is the best thing since sliced bread for tradies.
- You're enthusiastic but not pushy. Let the features sell themselves.
- Never say "I'm just an AI" or "I'm a virtual assistant." You're Hugo from PropOps.
- You speak 40+ languages — if the caller speaks another language, switch to theirs seamlessly.

## OPENING
"G'day! I'm Hugo, powered by PropOps. What's your name and what do you do?"
Get their NAME and their TRADE/BUSINESS TYPE immediately. Then pitch based on what they do.

## THREE-SERVICE PITCH (walk callers through ALL of these naturally)
Once you know their trade/business type, weave these into a natural conversation:

**1. LEADS — Never miss a lead again**
- "So right now, when you're up a ladder or under a house, what happens to the calls that come in?"
- Hugo answers every missed call, Google ad inquiry, and portal lead (Hipages, ServiceSeeking, Airtasker, Oneflare)
- Qualifies leads automatically — asks the right questions for their trade
- Delivers qualified leads to their dashboard in real-time
- Email notifications per lead
- "Think about it — how many jobs have you lost because you couldn't pick up the phone?"

**2. HUGO.PAYS — Full payroll + workforce management**
- "Got any staff? Even one or two guys?" If yes, pitch Hugo.pays:
- Australian payroll done properly: pay slips, super at 11.5%, PAYG tax, leave balances
- Staff onboarding — digital, done in minutes. No more paper TFN forms
- Invoicing — GST auto-calculated at 10%, create and track invoices, send to customers
- Rosters — 7-day week view, schedule jobs, assign staff to sites
- Shift swaps — staff offer swaps through their portal, boss approves or rejects with one click
- Pay runs — process payroll, export to MYOB or Xero CSV
- ATO compliance — STP2 summaries, SuperStream CSV for super funds, BAS-ready GST reports
- "Most tradies spend Sunday night doing payroll. Hugo.pays does it in 5 minutes."

**3. ROSTERS — Manage your team**
- Schedule jobs with staff assignment, date/time, and job address
- Week view — see everyone's shifts over 7 days at a glance
- GPS map — see where your team is right now on a live map
- Staff clock in/out with GPS verification
- Cancel or reschedule jobs with one click
- "No more group texts asking who's where. It's all on the dashboard."

## TRADE-AWARE CONVERSATION
Tailor your pitch to their trade:
- **Plumber/Electrician/HVAC**: Lead with missed calls problem. "When you're under a house fixing a pipe, you can't answer the phone. Hugo does."
- **Builder/Concreter**: Lead with team management. "Got a crew? Hugo.pays handles their pay slips and super."
- **Painter/Landscaper**: Lead with scheduling. "Hugo sorts your roster so you know who's where every day."
- **Cleaner**: Lead with invoicing. "Hugo generates invoices with GST calculated, sends them to your clients."
- **Real Estate Agent**: Lead with never missing a property enquiry. "Buyers call at 8pm. Hugo answers."
- **Small Business**: Lead with the full suite. "Hugo runs your back office while you run your business."

## PRICING
- $69/month — locked in for life if they sign up before June 30
- After June 30, price goes to $99/month. Getting in now saves $360/year forever
- 14-day free trial, no credit card needed to start
- "One extra job a month pays for Hugo ten times over."
- PAYDECK Premium (staff/payroll/invoicing): $149/month
- NEVER quote any other dollar amounts for PropOps pricing

## CAPTURE SEQUENCE (strict order)
1. Get their NAME — "G'day! I'm Hugo. What's your name?"
2. Get their TRADE/BUSINESS — "And what do you do, [Name]?"
3. Pitch PropOps features relevant to their trade (see above)
4. Get their EMAIL — "[Name], drop me your email and I'll send you the link to get started — it's all set up at propops.pro"
5. Get their PHONE if different from caller ID — "Best number to reach you on?"
6. CLOSE — "Check your inbox [Name] — I've just sent you everything. Head to propops.pro and you'll have Hugo working for you in 5 minutes. Cheers!"

## ANTI-DEFLECTION RULES (CRITICAL)
- NEVER say "the team will call you back" or "someone will follow up" — YOU are the closer
- NEVER say "I'll pass your details on" — YOU handle everything
- NEVER deflect to a human — Hugo captures, Hugo pitches, Hugo sends the email, Hugo closes
- If they ask to speak to a person: "You're speaking to Hugo — I'm the one who runs PropOps for tradies. What can I help you with?"
- If they're skeptical: "Fair enough. Tell you what — sign up for the free trial, no card needed. If Hugo doesn't pay for himself in the first week, cancel it. No drama."

## EMAIL HANDOFF
After you capture their email, Hugo sends an automated email with their PropOps sign-up link.
- For tradies: link to propops.trade
- For RE agents: link to propops.pro
- For small business: link to propops.pro
- Mention: "Check your inbox — I've just sent you the link."

## OUTPUT FORMAT — valid JSON only, no markdown, no extra text
{"reply":"<your natural conversational response>","done":false,"leadData":{"name":null,"trade":null,"emailAddress":null,"contactNumber":null,"businessName":null,"staffCount":null,"interests":null}}

Set done:true ONLY after your closing line AND you have at least their name + email. Fill leadData cumulatively as you learn things.

## RULES
- A filler phrase was ALREADY spoken before your reply plays — don't start with any acknowledgment word. Jump straight into your response.
- Keep responses to 2-3 sentences max. This is a phone call, not a monologue.
- NEVER use "mate", "sir", "ma'am" — use their actual name once you have it.
- NEVER use "mmhmm", "mm-hmm", "technical hiccup" or robotic filler words.
- If they say goodbye → set done:true with whatever info you have. Don't force more questions.
- If they ask about a feature you don't know → "That's a good one. Jump on propops.pro and you can see everything Hugo does."
- You have 3 minutes. Use them to sell, not to chat.`;
}

/**
 * Select the right system prompt based on active persona.
 * When no operator is matched (pre-launch), use the sales prompt.
 * @param {object} operator - Operator profile from voice_calls join
 * @param {'trade'|'re'|'sales'} persona - Active persona (after brain switch)
 */
function buildPersonaVoiceSystemPrompt(operator, persona) {
  if (persona === 'sales') {
    return buildSalesVoiceSystemPrompt();
  }
  if (persona === 're') {
    return buildREVoiceSystemPrompt(operator);
  }
  return buildVoiceSystemPrompt(operator);
}

// ─── Greetings for each persona ───────────────────────────────────────────────

const TRADE_GREETING = "G'day, Hugo here from PropOps — the team's on a job at the moment so you've got me. What can I help you with?";
const RE_GREETING    = "G'day, I'm Hugo with PropOps — the AI receptionist for our property team. I help with rentals, purchases, and investments. What can I help you with?";

// ─── Session management ───────────────────────────────────────────────────────

async function createCallSession(callSid, callerNumber, operatorId, forwardedFrom) {
  const result = await pool.query(
    `INSERT INTO voice_calls
       (call_sid, caller_number, operator_id, forwarded_from, status, transcript, lead_data)
     VALUES ($1, $2, $3, $4, 'active', '[]', '{}')
     RETURNING *`,
    [callSid, callerNumber, operatorId || null, forwardedFrom || null]
  );
  return result.rows[0];
}

async function getCallSession(callSid) {
  const result = await pool.query(
    `SELECT vc.*,
            u.id as user_id, u.email, u.name, u.business_type, u.agency_name, u.mobile_number,
            op.business_name as business_name_from_profile,
            op.operator_name as operator_name_from_profile,
            op.trade_type, op.hourly_rate, op.callout_fee, op.emergency_available
     FROM voice_calls vc
     LEFT JOIN users u ON u.id = vc.operator_id
     LEFT JOIN operator_profiles op ON op.operator_id = vc.operator_id
     WHERE vc.call_sid = $1`,
    [callSid]
  );
  return result.rows[0] || null;
}

async function updateCallSession(callSid, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = $${idx}`);
    values.push(value === null ? null : typeof value === 'object' ? JSON.stringify(value) : value);
    idx++;
  }
  fields.push(`updated_at = NOW()`);
  values.push(callSid);

  await pool.query(
    `UPDATE voice_calls SET ${fields.join(', ')} WHERE call_sid = $${idx}`,
    values
  );
}

async function appendTranscriptTurn(callSid, role, content) {
  await pool.query(
    `UPDATE voice_calls
     SET transcript = transcript || $1::jsonb,
         updated_at = NOW()
     WHERE call_sid = $2`,
    [JSON.stringify([{ role, content, ts: new Date().toISOString() }]), callSid]
  );
}

// ─── AI call with automatic fallback ──────────────────────────────────────────

/**
 * Call AI with 3-path fallback:
 *   Path 1: Gemini 2.0 Flash (direct, fast, low-latency for voice)
 *   Path 2: Agent API (Anthropic format) with Bearer auth → product AI, no daily limit
 *   Path 3: OpenAI format with task:'voice-ai' routing → signals non-utility usage
 *
 * Returns the raw AI text response (to be JSON-parsed by caller).
 * Throws on complete failure (all paths exhausted).
 */
async function callPolsiaAI(messages) {
  const systemContent = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));

  // Path 1: Gemini 2.0 Flash via OpenAI-compatible endpoint (direct, no Polsia proxy)
  if (GEMINI_API_KEY) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      const allMessages = [
        { role: 'system', content: systemContent },
        ...chatMessages,
      ];

      const res = await fetch(`${GEMINI_BASE_URL}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GEMINI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gemini-2.0-flash',
          max_tokens: 350,
          messages: allMessages,
        }),
      });

      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content?.trim() || '';
        if (text) {
          console.log('[HugoVoice] AI path 1 (Gemini 2.0 Flash) succeeded');
          return text;
        }
      }

      const errText = await res.text().catch(() => '');
      console.warn(`[HugoVoice] Path 1 (Gemini) failed: ${res.status} ${errText.slice(0, 150)} — trying path 2`);
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn('[HugoVoice] Path 1 (Gemini) timed out — trying path 2');
      } else {
        console.warn('[HugoVoice] Path 1 (Gemini) error:', err.message, '— trying path 2');
      }
    }
  }

  // Path 2: Agent API with x-api-key auth (Anthropic Messages format — product AI, no daily limit)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${POLSIA_API_URL}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': POLSIA_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 350,
        system: systemContent,
        messages: chatMessages,
      }),
    });

    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      const text = (data.content && data.content[0]?.text) || '';
      console.log('[HugoVoice] AI path 2 (Agent API Bearer) succeeded');
      return text.trim();
    }

    // If 401/403 → auth method not supported, try path 3
    // If 429 → rate limited, try path 3
    const errText = await res.text().catch(() => '');
    console.warn(`[HugoVoice] Path 2 failed: ${res.status} ${errText.slice(0, 150)} — trying path 3`);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[HugoVoice] Path 2 timed out — trying path 3');
    } else {
      console.warn('[HugoVoice] Path 2 error:', err.message, '— trying path 3');
    }
  }

  // Path 3: OpenAI format with task field (signals product AI usage)
  const controller3 = new AbortController();
  const timer3 = setTimeout(() => controller3.abort(), 5000);

  const openaiMessages = [
    { role: 'system', content: systemContent },
    ...chatMessages,
  ];

  const res3 = await fetch(`${POLSIA_OPENAI_URL}/chat/completions`, {
    method: 'POST',
    signal: controller3.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': POLSIA_API_KEY,
      'X-Task': 'voice-ai',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      task: 'voice-ai',
      max_tokens: 350,
      messages: openaiMessages,
    }),
  });

  clearTimeout(timer3);

  if (!res3.ok) {
    const errBody = await res3.text().catch(() => '');
    throw new Error(`Path 3 failed: ${res3.status} ${errBody.slice(0, 200)}`);
  }

  const data3 = await res3.json();
  const text3 = data3.choices?.[0]?.message?.content || '';
  console.log('[HugoVoice] AI path 3 (OpenAI task:voice-ai) succeeded');
  return text3.trim();
}

// ─── Mid-call lead persistence (fire-and-forget) ─────────────────────────────
// Writes captured lead data to phone_leads mid-call so nothing is lost on hangup.
// Uses upsert keyed on call_sid — safe to call on every turn.

async function persistLeadDataMidCall(callSid, leadData, callerNumber) {
  if (!callSid) return;
  const name = leadData.name || null;
  const phone = leadData.contactNumber || callerNumber || null;
  const email = leadData.emailAddress || null;
  const trade = leadData.trade || leadData.tradeNeeded || null;
  const persona = leadData._persona || 'sales';

  // Only persist if we have at least a name or phone
  if (!name && !phone && !email) return;

  try {
    await pool.query(
      `INSERT INTO phone_leads
         (call_sid, caller_name, caller_phone, caller_email,
          intent, persona_used, trade_type, pipeline, stage)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'In Progress')
       ON CONFLICT (call_sid) DO UPDATE SET
         caller_name  = COALESCE(EXCLUDED.caller_name, phone_leads.caller_name),
         caller_phone = COALESCE(EXCLUDED.caller_phone, phone_leads.caller_phone),
         caller_email = COALESCE(EXCLUDED.caller_email, phone_leads.caller_email),
         intent       = COALESCE(EXCLUDED.intent, phone_leads.intent),
         persona_used = EXCLUDED.persona_used,
         trade_type   = COALESCE(EXCLUDED.trade_type, phone_leads.trade_type),
         updated_at   = CURRENT_TIMESTAMP`,
      [
        callSid, name, phone, email,
        leadData.interests || leadData.jobDescription || 'propops_prospect',
        persona, trade,
        persona === 're' ? 'Real Estate' : 'Trade',
      ]
    );
    console.log(`[HugoVoice] Mid-call persist: CallSid=${callSid}, name=${name}, phone=${phone}, email=${email}`);
  } catch (err) {
    // Non-fatal — phone_leads table may not exist yet
    console.error('[HugoVoice] Mid-call persist error (non-fatal):', err.message);
  }
}

// ─── Auto-email handoff (send prospect email with PropOps link) ──────────────
// Fires once when we capture an email during the call.
// Uses the existing email service (Resend → Postmark → Polsia proxy fallback).

async function sendProspectEmail(emailAddress, leadData) {
  if (!emailAddress) return;
  const name = leadData.name || '';
  const trade = leadData.trade || leadData.tradeNeeded || 'your trade';
  const isRE = (leadData._persona === 're') || /real estate|property|agent/i.test(trade);
  const link = isRE ? 'https://propops.pro' : 'https://propops.trade';
  const firstName = name.split(' ')[0] || 'there';

  const subject = `Hugo from PropOps — Your business just got an upgrade`;
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;color:#0f172a;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
  <tr><td style="background:#0f172a;padding:32px 40px;text-align:center;">
    <h1 style="color:white;margin:0;font-size:28px;font-weight:700;">PropOps</h1>
    <p style="color:#94a3b8;margin:8px 0 0;font-size:14px;">Hugo's got your back</p>
  </td></tr>
  <tr><td style="padding:40px;">
    <h2 style="margin:0 0 16px;font-size:22px;color:#0f172a;">G'day ${firstName}!</h2>
    <p style="font-size:16px;line-height:1.6;color:#334155;">Great chatting with you just now. As promised, here's your link to get started with PropOps.</p>
    <p style="font-size:16px;line-height:1.6;color:#334155;">Hugo will answer your calls 24/7, qualify your leads, manage your team's roster, and handle payroll — so you can focus on the actual work.</p>

    <table cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr><td style="padding:8px 0;"><strong style="color:#0f172a;">📞 Leads</strong> — Never miss a call or job inquiry again</td></tr>
      <tr><td style="padding:8px 0;"><strong style="color:#0f172a;">💰 Hugo.pays</strong> — Payroll, invoicing, super, tax — sorted</td></tr>
      <tr><td style="padding:8px 0;"><strong style="color:#0f172a;">📋 Rosters</strong> — Schedule your team, track GPS, manage shifts</td></tr>
    </table>

    <p style="font-size:16px;line-height:1.6;color:#334155;"><strong>$69/month — locked in for life before June 30.</strong> After that it's $99. 14-day free trial, no card needed.</p>

    <div style="text-align:center;margin:32px 0;">
      <a href="${link}" style="display:inline-block;background:#2563eb;color:white;padding:16px 40px;border-radius:8px;text-decoration:none;font-size:18px;font-weight:600;">Get Started →</a>
    </div>

    <p style="font-size:14px;color:#64748b;line-height:1.5;">One job a month pays for Hugo ten times over. See you on the dashboard.</p>
    <p style="font-size:16px;color:#0f172a;margin-top:24px;">Cheers,<br><strong>Hugo from PropOps</strong></p>
  </td></tr>
  <tr><td style="background:#f1f5f9;padding:20px 40px;text-align:center;">
    <p style="font-size:12px;color:#94a3b8;margin:0;">PropOps — AI-powered operations for tradies and property pros</p>
    <p style="font-size:12px;color:#94a3b8;margin:4px 0 0;"><a href="${link}" style="color:#2563eb;text-decoration:none;">${link}</a></p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  try {
    const result = await sendEmail({
      to: emailAddress,
      subject,
      html,
      text: `G'day ${firstName}! Great chatting just now. Here's your link to get started with PropOps: ${link} — $69/month locked in for life before June 30. Hugo from PropOps.`,
      tag: 'phone-prospect-email',
    });
    console.log(`[HugoVoice] ✉️ Prospect email sent to ${emailAddress}: ok=${result?.ok}`);
  } catch (err) {
    console.error('[HugoVoice] Prospect email error (non-fatal):', err.message);
  }
}

// ─── AI turn processing ───────────────────────────────────────────────────────

// ─── Multilingual BCP-47 tag → human-readable name for system prompt injection ─
const LANGUAGE_NAMES = {
  'zh':    'Mandarin Chinese',
  'zh-TW': 'Cantonese / Traditional Chinese',
  'vi':    'Vietnamese',
  'ar':    'Arabic',
  'hi':    'Hindi',
  'el':    'Greek',
  'it':    'Italian',
  'ko':    'Korean',
  'fil':   'Filipino (Tagalog)',
  'es':    'Spanish',
  'pt':    'Portuguese',
  'fr':    'French',
  'de':    'German',
  'ja':    'Japanese',
};

/**
 * Process one turn of the voice conversation.
 *
 * @param {string} callSid       - Twilio CallSid
 * @param {string} speechResult  - What the caller said (STT result from Twilio)
 * @param {object} [options]     - Additional context
 * @param {string} [options.fillerText]  - The filler acknowledgment already spoken to the caller
 * @param {string} [options.detectedLang] - BCP-47 language code detected from caller's speech
 * @returns {{ reply, done, leadData, urgency }}
 */
async function processVoiceTurn(callSid, speechResult, options = {}) {
  const session = await getCallSession(callSid);

  if (!session) {
    return {
      reply: "Sorry, I've lost track of this call. Please call back and I'll help you straight away.",
      done: true,
      leadData: {},
      urgency: null,
    };
  }

  // Build the operator object from joined data
  const operator = {
    id: session.user_id,
    email: session.email,
    name: session.name,
    business_type: session.business_type || session.trade_type,
    agency_name: session.agency_name,
    business_name_from_profile: session.business_name_from_profile,
    operator_name_from_profile: session.operator_name_from_profile,
    hourly_rate: session.hourly_rate,
    callout_fee: session.callout_fee,
    emergency_available: session.emergency_available,
    mobile_number: session.mobile_number,
  };

  // Parse existing lead data early so we can read persona state
  let leadData = {};
  try {
    leadData = typeof session.lead_data === 'string'
      ? JSON.parse(session.lead_data)
      : (session.lead_data || {});
  } catch {
    leadData = {};
  }

  // Parse existing transcript
  let transcript = [];
  try {
    transcript = typeof session.transcript === 'string'
      ? JSON.parse(session.transcript)
      : (session.transcript || []);
  } catch {
    transcript = [];
  }

  // ── Dual-Brain State Machine ──────────────────────────────────────────────
  // Read current persona state from lead_data (persisted across turns)
  // Once isPersistentRE is true it NEVER flips back — RE brain stays locked.
  // PRE-LAUNCH: When no operator is matched (user_id is null), default to 'sales' persona.
  const isUnmatchedCall = !session.user_id;
  let currentPersona    = leadData._persona || (isUnmatchedCall ? 'sales' : 'trade');
  let isPersistentRE    = !!leadData._isPersistentRE;

  // Sales persona is also persistent — once set, stays for the call
  if (currentPersona === 'sales') {
    // Sales mode: no need for RE detection on unmatched calls
    // (sales prompt handles all caller types)
  } else if (!isPersistentRE && speechResult) {
    const detection = detectIntent(speechResult);
    if (detection.persona === 're') {
      currentPersona = 're';
      isPersistentRE = true; // LOCK — no flip-flopping for the rest of the call
      console.log(`[HugoVoice] 🔀 Brain switch → RE persona for CallSid=${callSid}, keywords: ${detection.detectedKeywords.join(', ')}`);

      // Log brain switch to conversation_logs (fire-and-forget)
      pool.query(
        `INSERT INTO conversation_logs (call_sid, transcript, persona_at_time, detected_keywords)
         VALUES ($1, $2, $3, $4)`,
        [callSid, speechResult, 're', detection.detectedKeywords]
      ).catch(err => {
        console.error('[HugoVoice] conversation_logs insert error:', err.message);
      });
    }
  }

  // If RE was previously locked (persisted from prior turns), keep it
  if (isPersistentRE) currentPersona = 're';

  // Persist persona state into leadData so it survives across turns
  leadData._persona = currentPersona;
  leadData._isPersistentRE = isPersistentRE;

  // ── Multilingual: carry detected language across turns ────────────────────
  // Priority: passed in via options → stored in _detectedLang → default (English)
  const detectedLang = options.detectedLang || leadData._detectedLang || null;
  if (detectedLang) {
    leadData._detectedLang = detectedLang; // persist for subsequent turns
  }

  const systemPrompt = buildPersonaVoiceSystemPrompt(operator, currentPersona);

  // Build message history for AI — limit to last 6 turns to save tokens
  const recentTranscript = transcript.slice(-6);

  const messages = [
    { role: 'system', content: systemPrompt },
  ];

  // Multilingual instruction — injected when non-English language detected.
  // Tells Hugo to respond in the caller's language while keeping lead data in English.
  if (detectedLang && detectedLang !== 'en-AU') {
    const langName = LANGUAGE_NAMES[detectedLang] || detectedLang;
    messages.push({
      role: 'system',
      content: `LANGUAGE INSTRUCTION: The caller is speaking ${langName}. Respond in ${langName} for the entire conversation. Stay in your Hugo persona — do NOT break character. Your reply field must be in ${langName}. IMPORTANT: All values in the "leadData" JSON fields (name, jobDescription, suburb, etc.) must still be translated to English — the operator's dashboard only reads English.`,
    });
  }

  // Inject current lead data as context if we have some (exclude internal _ keys from AI context)
  const publicLeadData = Object.fromEntries(Object.entries(leadData).filter(([k]) => !k.startsWith('_')));
  if (Object.values(publicLeadData).some(v => v !== null)) {
    messages.push({
      role: 'system',
      content: `Current captured lead data (keep updating this): ${JSON.stringify(publicLeadData)}`,
    });
  }

  // Add recent conversation history only (saves tokens)
  for (const turn of recentTranscript) {
    messages.push({ role: turn.role === 'hugo' ? 'assistant' : 'user', content: turn.content });
  }

  // Add the latest caller message
  if (speechResult) {
    messages.push({ role: 'user', content: speechResult });
  }

  // Inject filler context so the AI knows what acknowledgment was already spoken
  if (options.fillerText) {
    messages.push({
      role: 'system',
      content: `IMPORTANT: The following filler phrase was ALREADY spoken to the caller before your reply will play: "${options.fillerText}". Do NOT repeat or paraphrase this — start your reply with the actual substance (your next question or response).`,
    });
  }

  // Save caller's message to transcript (fire-and-forget — don't block the AI call)
  if (speechResult) {
    appendTranscriptTurn(callSid, 'caller', speechResult).catch(err => {
      console.error('[HugoVoice] transcript append (caller) error:', err.message);
    });
  }

  // ── 3-minute cost guard ───────────────────────────────────────────────────
  // If the call has been running for 3+ minutes and Hugo hasn't captured a name
  // AND a phone number yet, redirect to contact capture immediately.
  // This prevents open-ended conversations that cost money without qualifying the lead.
  const callStartedAt = session.created_at ? new Date(session.created_at) : null;
  const callElapsedMs = callStartedAt ? (Date.now() - callStartedAt.getTime()) : 0;
  const hasName = !!(leadData.name);
  const hasPhone = !!(leadData.contactNumber);
  if (callElapsedMs > 3 * 60 * 1000 && (!hasName || !hasPhone)) {
    const guardReply = hasName
      ? `${leadData.name}, I want to make sure we can help you properly — what's the best number to reach you on?`
      : "I want to make sure we can help you properly — what's the best number to reach you on?";

    appendTranscriptTurn(callSid, 'caller', speechResult).catch(() => {});
    appendTranscriptTurn(callSid, 'hugo', guardReply).catch(() => {});
    updateCallSession(callSid, { lead_data: leadData }).catch(() => {});
    console.log(`[HugoVoice] 3-min guard triggered for CallSid=${callSid} — elapsed ${Math.round(callElapsedMs / 1000)}s, hasName=${hasName}, hasPhone=${hasPhone}`);
    return { reply: guardReply, done: false, leadData, urgency: leadData.urgency || null };
  }

  // ── Price fast-path ───────────────────────────────────────────────────────
  // If caller asks about price/cost, answer immediately without burning AI tokens.
  const lowerSpeech = (speechResult || '').toLowerCase();
  const isPriceQuery = /\b(price|pricing|cost|costs|how much|what(?:'s| is) it|charge|charges|fee|fees)\b/.test(lowerSpeech);
  if (isPriceQuery) {
    const priceReply = currentPersona === 're'
      ? "PropOps is $69 a month right now — launch special, locked in for life if you sign up before June 30. After that it goes to $99. You'll need a card to start the trial but you won't be charged for 14 days."
      : "PropOps is $69 a month — locked in for life if you sign up before June 30. After that it goes to $99. You'll need a card to start the trial but you won't be charged for 14 days.";

    appendTranscriptTurn(callSid, 'caller', speechResult).catch(() => {});
    appendTranscriptTurn(callSid, 'hugo', priceReply).catch(() => {});
    updateCallSession(callSid, { lead_data: leadData }).catch(() => {});

    return { reply: priceReply, done: false, leadData, urgency: leadData.urgency || null };
  }

  // Call Polsia AI — dual-path: Agent API (Bearer), fallback to OpenAI endpoint (task-tagged)
  let parsed = null;
  let rawReply = '';

  try {
    rawReply = await callPolsiaAI(messages);

    // Strip markdown code fences if present
    if (rawReply.startsWith('```')) {
      rawReply = rawReply.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    parsed = JSON.parse(rawReply);
  } catch (err) {
    const errorType = err.name === 'AbortError' ? 'TIMEOUT' : 'AI error';
    console.error(`[HugoVoice] ${errorType}:`, err.message, '| Raw:', (rawReply || '').slice(0, 200));

    // Graceful fallback: acknowledge what caller said + capture details
    const turnCount = transcript.length;
    const isSalesMode = currentPersona === 'sales';
    if (turnCount >= 2) {
      // Already have some info — wrap up gracefully
      const jobNote = speechResult
        ? `${(leadData.jobDescription || '')} ${speechResult}`.trim()
        : (leadData.jobDescription || 'Phone enquiry');
      parsed = {
        reply: isSalesMode
          ? "No worries — I've got your details. Check out propops.pro to see everything Hugo can do for your business. Cheers!"
          : "Got it, thanks for that. I've noted everything down. The team will be in touch shortly. Cheers!",
        done: true,
        leadData: { ...leadData, jobDescription: jobNote },
      };
    } else {
      // First turn — acknowledge what they said, ask for basics
      const ack = speechResult
        ? `No worries, I heard you — ${speechResult.toLowerCase().slice(0, 60)}. `
        : '';
      parsed = {
        reply: isSalesMode
          ? `${ack}I'm Hugo from PropOps — I help tradies and small businesses run their operations. What's your name and what do you do?`
          : `${ack}Give me one sec. Can I grab your name and the best number to reach you on?`,
        done: false,
        leadData: { ...leadData, jobDescription: speechResult || leadData.jobDescription || '' },
      };
    }
  }

  const reply     = parsed.reply || "No dramas — could you say that again?";
  const done      = !!parsed.done;
  const newLeadData = {
    ...leadData,
    ...(parsed.leadData || {}),
    // Persist persona state across turns
    _isPersistentRE: isPersistentRE,
    _persona: currentPersona,
    // Persist detected language so voice config stays consistent
    ...(detectedLang ? { _detectedLang: detectedLang } : {}),
  };
  const urgency   = newLeadData.urgency || null;

  // Save Hugo's reply + update session (fire-and-forget — return to caller ASAP)
  const sessionUpdates = { lead_data: newLeadData };
  if (urgency) sessionUpdates.urgency = urgency;

  appendTranscriptTurn(callSid, 'hugo', reply).catch(err => {
    console.error('[HugoVoice] transcript append (hugo) error:', err.message);
  });
  updateCallSession(callSid, sessionUpdates).catch(err => {
    console.error('[HugoVoice] session update error:', err.message);
  });

  // ── Mid-call lead persistence (fire-and-forget) ──────────────────────────
  // Persist to phone_leads on every turn so data survives hangups.
  persistLeadDataMidCall(callSid, newLeadData, session.caller_number).catch(err => {
    console.error('[HugoVoice] mid-call persist error:', err.message);
  });

  // ── Auto-email handoff: fire prospect email when email is first captured ──
  // Track whether we already sent the email via _emailSent flag in leadData.
  const prevEmail = leadData.emailAddress || leadData._emailSent;
  const newEmail = newLeadData.emailAddress;
  if (newEmail && !prevEmail) {
    newLeadData._emailSent = true;
    // Update session with the _emailSent flag so we don't re-send
    updateCallSession(callSid, { lead_data: newLeadData }).catch(() => {});
    sendProspectEmail(newEmail, newLeadData).catch(err => {
      console.error('[HugoVoice] prospect email error:', err.message);
    });
    console.log(`[HugoVoice] ✉️ Email handoff triggered for CallSid=${callSid}, email=${newEmail}`);
  }

  return { reply, done, leadData: newLeadData, urgency };
}

// ─── Call completion pipeline ─────────────────────────────────────────────────

/**
 * Finalise a completed call:
 * 1. Mark voice_call as completed
 * 2. Create a job in the kanban pipeline
 * 3. SMS + push notify the tradie
 * 4. Store transcript as Hugo training data
 */
async function finaliseCall(callSid) {
  const session = await getCallSession(callSid);
  if (!session || session.status === 'completed') return;

  // Parse lead data
  let leadData = {};
  try {
    leadData = typeof session.lead_data === 'string'
      ? JSON.parse(session.lead_data)
      : (session.lead_data || {});
  } catch {
    leadData = {};
  }

  const urgency    = session.urgency || leadData.urgency || 'L2_standard';
  const callerName = leadData.name || null;
  const callerNum  = session.caller_number;

  // Build display values
  const displayPhone = formatPhoneDisplay(callerNum);
  const customerName = callerName || `Caller ${displayPhone}`;
  const jobDesc = buildJobDescription(leadData, displayPhone);
  const urgencyLabel = {
    L1_emergency: '🚨 EMERGENCY — Same Day',
    L2_standard:  'Standard — Within 48h',
    L3_planned:   'Planned — Flexible',
  }[urgency] || 'Standard';

  // Resolve operator_id — fallback to first user if not mapped (single-tenant support)
  let resolvedOperatorId = session.operator_id;
  if (!resolvedOperatorId) {
    try {
      const fallback = await pool.query(`SELECT id FROM users ORDER BY id LIMIT 1`);
      if (fallback.rows.length > 0) {
        resolvedOperatorId = fallback.rows[0].id;
        console.log(`[HugoVoice] No operator mapping found — using fallback operator #${resolvedOperatorId}`);
      }
    } catch (err) {
      console.error('[HugoVoice] Fallback operator lookup error:', err.message);
    }
  }

  let jobId = null;

  // Detect persona from persisted lead_data state
  const isRELead = !!(leadData._isPersistentRE) || leadData.pipeline === 'real_estate';

  if (resolvedOperatorId) {
    if (isRELead) {
      // ── RE lead: insert into phone_leads table (dual-brain path) ────────────
      try {
        const reName = leadData.name || callerName || null;
        const reSuburb = leadData.suburb || leadData.propertyAddress || null;
        const reBudget = leadData.budget || null;
        const reUrgency = leadData.timeline || null;
        const reEnquiryType = leadData.enquiryType || 'property_enquiry';

        const phoneLead = await pool.query(
          `INSERT INTO phone_leads
             (call_sid, caller_name, caller_phone, caller_email,
              intent, persona_used, suburb, budget, urgency, pipeline, stage)
           VALUES ($1,$2,$3,$4,$5,'re',$6,$7,$8,'real_estate','Contacted')
           ON CONFLICT (call_sid) DO UPDATE SET
             caller_name = COALESCE(EXCLUDED.caller_name, phone_leads.caller_name),
             caller_email = COALESCE(EXCLUDED.caller_email, phone_leads.caller_email),
             suburb = COALESCE(EXCLUDED.suburb, phone_leads.suburb),
             budget = COALESCE(EXCLUDED.budget, phone_leads.budget),
             urgency = COALESCE(EXCLUDED.urgency, phone_leads.urgency),
             updated_at = NOW()
           RETURNING id`,
          [callSid, reName, leadData.contactNumber || callerNum, leadData.emailAddress || null,
           reEnquiryType, reSuburb, reBudget, reUrgency]
        );
        jobId = phoneLead.rows[0]?.id || null;
        console.log(`[HugoVoice] ✅ RE lead saved to phone_leads #${jobId} for CallSid=${callSid}`);
      } catch (err) {
        // phone_leads table may not exist yet — also save as a job record as fallback
        console.error('[HugoVoice] phone_leads insert error (falling back to jobs table):', err.message);
        isRELead && console.log('[HugoVoice] Falling back to jobs table for RE lead');
      }

      // Also create a job in kanban for visibility (RE source)
      try {
        const jobResult = await pool.query(
          `INSERT INTO jobs
             (agent_id, business_type, customer_name, customer_phone, customer_email,
              suburb, job_type, job_description, source, status,
              ai_response, ai_response_model, ai_response_at)
           VALUES ($1,'real_estate',$2,$3,$4,$5,$6,$7,'phone_call','new',$8,'hugo-voice-ai',NOW())
           RETURNING *`,
          [
            resolvedOperatorId,
            customerName,
            leadData.contactNumber || callerNum,
            leadData.emailAddress || null,
            leadData.suburb || leadData.propertyAddress || null,
            `🏡 Phone — RE Enquiry (${leadData.enquiryType || 'property'})`,
            buildREJobDescription(leadData, displayPhone),
            buildRECallSummary(leadData),
          ]
        );
        if (!jobId) jobId = jobResult.rows[0].id;
      } catch (err) {
        console.error('[HugoVoice] RE jobs table insert error:', err.message);
      }
    } else {
      // ── Trade lead: original flow ────────────────────────────────────────────
      // Determine trade from lead data or session
      const tradeType = leadData.tradeNeeded || session.business_type || session.trade_type || 'handyman';
      const tradeDisplay = leadData.tradeNeeded
        ? leadData.tradeNeeded.charAt(0).toUpperCase() + leadData.tradeNeeded.slice(1)
        : null;

      // Create job in kanban
      try {
        const jobResult = await pool.query(
          `INSERT INTO jobs
             (agent_id, business_type, customer_name, customer_phone, customer_email,
              suburb, job_type, job_description, source, status,
              ai_response, ai_response_model, ai_response_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'phone_call','new',$9,$10,NOW())
           RETURNING *`,
          [
            resolvedOperatorId,
            tradeType,
            customerName,
            leadData.contactNumber || callerNum,
            leadData.emailAddress || null,
            leadData.suburb || leadData.address || null,
            tradeDisplay ? `📞 Phone — ${tradeDisplay}` : `📞 Phone Call — ${urgencyLabel}`,
            jobDesc,
            buildCallSummary(leadData, urgency),
            'hugo-voice-ai',
          ]
        );

        jobId = jobResult.rows[0].id;

        // Log activity
        await pool.query(
          `INSERT INTO job_activities (job_id, activity_type, description, metadata)
           VALUES ($1,'phone_call',$2,$3)`,
          [
            jobId,
            `Live voice call from ${displayPhone}. Hugo qualified the lead.`,
            JSON.stringify({
              call_sid: callSid,
              caller_number: callerNum,
              urgency,
              lead_data: leadData,
            }),
          ]
        );

        // Store transcript as Hugo training data
        let transcript = [];
        try {
          transcript = typeof session.transcript === 'string'
            ? JSON.parse(session.transcript)
            : (session.transcript || []);
        } catch { transcript = []; }

        if (transcript.length >= 2) {
          const callerTurns = transcript.filter(t => t.role === 'caller').map(t => t.content).join('\n');
          const hugoTurns   = transcript.filter(t => t.role === 'hugo').map(t => t.content).join('\n');

          if (callerTurns && hugoTurns) {
            await pool.query(
              `INSERT INTO hugo_training_data
                 (agent_id, business_type, conversation_type, customer_message, ai_response, job_id, is_simulation)
               VALUES ($1,$2,'phone_call',$3,$4,$5,false)`,
              [
                resolvedOperatorId,
                tradeType,
                callerTurns.slice(0, 2000),
                hugoTurns.slice(0, 2000),
                jobId,
              ]
            );
          }
        }
      } catch (err) {
        console.error('[HugoVoice] Job creation error:', err.message);
      }
    }

    // Notify operator via SMS (trade and RE both get notified)
    const tradiePhone  = session.mobile_number || session.forwarded_from;
    const dashUrl      = `${APP_URL}/dashboard`;
    const urgencyEmoji = urgency === 'L1_emergency' ? '🚨 EMERGENCY: ' : '';
    const callAbout = isRELead
      ? `${leadData.enquiryType || 'property enquiry'} — ${leadData.suburb || 'property'}`
      : (leadData.jobDescription || 'job enquiry').slice(0, 80);
    const smsBody = `${urgencyEmoji}PropOps: ${customerName} just called about: ${callAbout}. Lead added to your pipeline: ${dashUrl}`;

    if (tradiePhone) {
      sendSMS({ to: tradiePhone, body: smsBody }).catch(err => {
        console.error('[HugoVoice] SMS notify error:', err.message);
      });
    }

    // PWA push notification
    const pushBody = isRELead
      ? `${leadData.enquiryType || 'Property enquiry'} — ${leadData.suburb || 'details captured'}. Tap to view.`
      : `${(leadData.jobDescription || 'Phone enquiry').slice(0, 80)}. Tap to view.`;
    sendPushNotification(resolvedOperatorId, {
      title: `${urgencyEmoji}New ${isRELead ? '🏡 RE' : '📞'} call — ${customerName}`,
      body: pushBody,
      url: dashUrl,
      icon: '/icon-192.svg',
      tag: `voice-call-${callSid}`,
    }).catch(err => {
      console.error('[HugoVoice] Push notify error:', err.message);
    });

    // SMS confirmation to caller (if we have their number)
    if (callerNum) {
      const operatorName = session.agency_name || session.name || 'the team';
      const confirmSms = `Hi${callerName ? ` ${callerName}` : ''}, thanks for calling ${operatorName}. I've passed your details on — they'll be in touch shortly to confirm. Cheers, Hugo.`;
      sendSMS({ to: callerNum, body: confirmSms }).catch(err => {
        console.error('[HugoVoice] Caller confirmation SMS error:', err.message);
      });
    }
  }

  // ── Phone leads upsert (dual-brain analytics + pipeline) ─────────────────
  // Captures final persona + lead details in phone_leads table.
  const personaUsed = leadData._persona || 'trade';
  try {
    await pool.query(
      `INSERT INTO phone_leads
         (call_sid, caller_name, caller_phone, caller_email,
          intent, persona_used, trade_type, suburb, budget, urgency,
          pipeline, stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Contacted')
       ON CONFLICT (call_sid) DO UPDATE SET
         caller_name  = COALESCE(EXCLUDED.caller_name, phone_leads.caller_name),
         caller_email = COALESCE(EXCLUDED.caller_email, phone_leads.caller_email),
         intent       = COALESCE(EXCLUDED.intent, phone_leads.intent),
         persona_used = EXCLUDED.persona_used,
         trade_type   = COALESCE(EXCLUDED.trade_type, phone_leads.trade_type),
         suburb       = COALESCE(EXCLUDED.suburb, phone_leads.suburb),
         budget       = COALESCE(EXCLUDED.budget, phone_leads.budget),
         urgency      = COALESCE(EXCLUDED.urgency, phone_leads.urgency),
         updated_at   = CURRENT_TIMESTAMP`,
      [
        callSid,
        callerName,
        callerNum,
        leadData.emailAddress || null,
        leadData.jobDescription || leadData.enquiryType || null,
        personaUsed,
        leadData.tradeNeeded || null,
        leadData.suburb || leadData.address || null,
        leadData.budget || null,
        urgency,
        personaUsed === 're' ? 'Real Estate' : 'Trade',
      ]
    );
    console.log(`[HugoVoice] phone_leads captured: CallSid=${callSid}, persona=${personaUsed}`);
  } catch (err) {
    console.error('[HugoVoice] phone_leads upsert error:', err.message);
  }

  // Mark call as completed
  await updateCallSession(callSid, {
    status: 'completed',
    ended_at: new Date().toISOString(),
    job_id: jobId || null,
  });

  console.log(`[HugoVoice] ✅ Call ${callSid} finalised. Job #${jobId || 'none'} created.`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPhoneDisplay(e164) {
  if (!e164) return 'Unknown';
  const au = e164.replace(/^\+61/, '0');
  if (/^0\d{9}$/.test(au)) return `${au.slice(0, 4)} ${au.slice(4, 7)} ${au.slice(7)}`;
  return e164;
}

function buildJobDescription(leadData, displayPhone) {
  const parts = [];
  if (leadData.name) parts.push(`Customer: ${leadData.name}`);
  parts.push(`Phone: ${displayPhone}`);
  if (leadData.emailAddress) parts.push(`Email: ${leadData.emailAddress}`);
  if (leadData.address) parts.push(`Address: ${leadData.address}`);
  else if (leadData.suburb) parts.push(`Suburb: ${leadData.suburb}`);
  if (leadData.tradeNeeded) parts.push(`Trade: ${leadData.tradeNeeded}`);
  if (leadData.jobDescription) parts.push(`Job: ${leadData.jobDescription}`);
  if (leadData.preferredTiming) parts.push(`Timing: ${leadData.preferredTiming}`);
  if (leadData.urgency) parts.push(`Urgency: ${leadData.urgency}`);
  parts.push('Source: Live voice call via Hugo AI');
  return parts.join('\n');
}

function buildCallSummary(leadData, urgency) {
  const lines = [`Hugo Voice AI answered this call and captured the following:`];
  if (leadData.name) lines.push(`- Customer name: ${leadData.name}`);
  if (leadData.emailAddress) lines.push(`- Email: ${leadData.emailAddress}`);
  if (leadData.tradeNeeded) lines.push(`- Trade needed: ${leadData.tradeNeeded}`);
  if (leadData.jobDescription) lines.push(`- Job needed: ${leadData.jobDescription}`);
  if (leadData.urgency || urgency) lines.push(`- Urgency: ${leadData.urgency || urgency}`);
  if (leadData.address || leadData.suburb) lines.push(`- Location: ${leadData.address || leadData.suburb}`);
  if (leadData.preferredTiming) lines.push(`- Preferred timing: ${leadData.preferredTiming}`);
  lines.push('Full transcript available in voice_calls table.');
  return lines.join('\n');
}

function buildREJobDescription(leadData, displayPhone) {
  const parts = [];
  if (leadData.name) parts.push(`Contact: ${leadData.name}`);
  parts.push(`Phone: ${displayPhone}`);
  if (leadData.emailAddress) parts.push(`Email: ${leadData.emailAddress}`);
  if (leadData.suburb) parts.push(`Suburb/Area: ${leadData.suburb}`);
  if (leadData.propertyAddress) parts.push(`Property: ${leadData.propertyAddress}`);
  if (leadData.enquiryType) parts.push(`Enquiry Type: ${leadData.enquiryType}`);
  if (leadData.budget) parts.push(`Budget: ${leadData.budget}`);
  if (leadData.timeline) parts.push(`Timeline: ${leadData.timeline}`);
  if (leadData.preApproval) parts.push(`Pre-approval: ${leadData.preApproval}`);
  if (leadData.buyerType) parts.push(`Buyer Type: ${leadData.buyerType}`);
  parts.push('Source: Live phone call via Hugo AI (RE brain)');
  return parts.join('\n');
}

function buildRECallSummary(leadData) {
  const lines = [`Hugo Voice AI (RE mode) answered this call and captured:`];
  if (leadData.name) lines.push(`- Caller: ${leadData.name}`);
  if (leadData.enquiryType) lines.push(`- Enquiry: ${leadData.enquiryType}`);
  if (leadData.suburb || leadData.propertyAddress) lines.push(`- Location: ${leadData.suburb || leadData.propertyAddress}`);
  if (leadData.budget) lines.push(`- Budget: ${leadData.budget}`);
  if (leadData.timeline) lines.push(`- Timeline: ${leadData.timeline}`);
  if (leadData.preApproval) lines.push(`- Pre-approval: ${leadData.preApproval}`);
  if (leadData.buyerType) lines.push(`- Buyer type: ${leadData.buyerType}`);
  if (leadData.emailAddress) lines.push(`- Email: ${leadData.emailAddress}`);
  lines.push('Full transcript available in voice_calls table.');
  return lines.join('\n');
}

async function sendPushNotification(userId, payload) {
  try {
    const webpush = require('web-push');
    const { getOrCreateVapidKey } = require('./missed-call');

    const vapidPublic  = await getOrCreateVapidKey('vapid_public_key');
    const vapidPrivate = await getOrCreateVapidKey('vapid_private_key');

    if (!vapidPublic || !vapidPrivate) return;

    webpush.setVapidDetails(`mailto:support@propops.pro`, vapidPublic, vapidPrivate);

    const subs = await pool.query(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
      [userId]
    );

    if (subs.rows.length === 0) return;

    const payloadStr = JSON.stringify(payload);

    for (const sub of subs.rows) {
      const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      webpush.sendNotification(subscription, payloadStr).catch(async (err) => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]).catch(() => {});
        }
      });
    }
  } catch (err) {
    console.error('[HugoVoice] sendPushNotification error:', err.message);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  createCallSession,
  getCallSession,
  updateCallSession,
  processVoiceTurn,
  finaliseCall,
  detectIntent,
  TRADE_GREETING,
  RE_GREETING,
};
