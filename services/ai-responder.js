const OpenAI = require('openai');
const { Pool } = require('pg');
const { getSimilarListing } = require('./listings');

// Uses OPENAI_BASE_URL and OPENAI_API_KEY env vars automatically
const openai = new OpenAI();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

/**
 * Lazily expire grace periods and check if this instance can still generate AI responses.
 *
 * Returns true if at least one user is on an active or trial subscription, OR is within
 * their 7-day grace period after a cancellation/payment failure.
 *
 * As a side effect, this promotes users from payment_failed/cancelled → suspended when
 * their grace_period_ends_at has passed. This avoids needing a separate cron job.
 */
async function checkCanGenerateResponse() {
  try {
    // Lazily suspend users whose grace period has expired
    await pool.query(
      `UPDATE users
       SET subscription_status = 'suspended',
           updated_at          = NOW()
       WHERE grace_period_ends_at IS NOT NULL
         AND grace_period_ends_at < NOW()
         AND subscription_status NOT IN ('active', 'trial', 'suspended')`
    );

    // Check if any user can still receive AI responses:
    //   - active/trial: fully subscribed
    //   - payment_failed/cancelled with grace period still active
    const result = await pool.query(
      `SELECT COUNT(*) AS count FROM users
       WHERE subscription_status IN ('trial', 'active')
          OR (
            subscription_status IN ('payment_failed', 'cancelled')
            AND grace_period_ends_at IS NOT NULL
            AND grace_period_ends_at > NOW()
          )`
    );

    return parseInt(result.rows[0].count, 10) > 0;
  } catch (err) {
    // On DB error, allow responses to continue (fail open) to avoid blocking leads
    console.error('[AI Responder] checkCanGenerateResponse DB error (allowing responses):', err.message);
    return true;
  }
}

/**
 * Fetch the agent's display name, agency name, and business type from the users table.
 * Returns { agentName, agencyName, businessType } — first two may be null if not set.
 *
 * When userId is provided, fetches the specific user's profile (correct for
 * multi-tenant — each lead belongs to a user who has their own sign-off).
 * Falls back to scanning active/trial users only when no userId is available.
 */
async function getAgentProfile(userId) {
  try {
    let result;
    if (userId) {
      // Scoped lookup — use the lead owner's profile for sign-off
      result = await pool.query(
        `SELECT name, agency_name, business_type FROM users WHERE id = $1`,
        [userId]
      );
    } else {
      // Legacy fallback — pick the first active user with a name set
      result = await pool.query(
        `SELECT name, agency_name, business_type
         FROM users
         WHERE subscription_status IN ('trial', 'active')
         ORDER BY
           CASE WHEN name IS NOT NULL AND TRIM(name) != '' THEN 0 ELSE 1 END,
           updated_at DESC NULLS LAST
         LIMIT 1`
      );
    }
    const row = result.rows[0] || {};
    const agentName    = (row.name        && row.name.trim())        ? row.name.trim()        : null;
    // Sanitize agency_name: discard values that look like platform usernames or
    // contain "propops" — these leak internal identifiers into customer-facing
    // sign-offs. The user should set a real business name via Settings.
    let rawAgency = (row.agency_name && row.agency_name.trim()) ? row.agency_name.trim() : null;
    if (rawAgency && /propops/i.test(rawAgency)) rawAgency = null;
    const agencyName   = rawAgency;
    const businessType = row.business_type || 'real_estate';

    console.log(`[AI Responder] Agent profile loaded (userId=${userId || 'any'}): name="${agentName || '(none)'}", agency="${agencyName || '(none)'}", type="${businessType}"`);

    return { agentName, agencyName, businessType };
  } catch (err) {
    console.error('[AI Responder] Failed to fetch agent profile:', err.message);
    return { agentName: null, agencyName: null, businessType: 'real_estate' };
  }
}

/**
 * Build the sign-off string for use in prompts and templates.
 * Priority: "agentName\nagencyName" > "agentName" > "agencyName" > "The team at PropOps"
 */
function buildSignOff(agentName, agencyName) {
  if (agentName && agencyName) return `${agentName}\n${agencyName}`;
  if (agentName)               return agentName;
  if (agencyName)              return agencyName;
  return 'The team at PropOps';
}

// ─── Trade-aware prompt configuration ────────────────────────────────────────
//
// Each business_type gets overrides for identity, tone, sign-off style, and
// urgency language. RE remains fully unchanged. All trade types get a friendly,
// casual Australian tone appropriate for tradesperson communication.

const TRADE_PROMPT_CONFIG = {
  real_estate: {
    identity:  'PropOps, an AI assistant for an Australian real estate agency',
    purpose:   'respond to property inquiry leads quickly, professionally, and warmly',
    tone:      ['Be friendly but professional. Australian tone — approachable, not stiff.'],
    signOff:   'Warm regards,',
    wordCount: '80–120 words',
    urgency:   null,
  },
  plumber: {
    identity:  'PropOps, the AI assistant for an Australian plumbing business',
    purpose:   'respond to job enquiries quickly and get the customer to confirm a booking or site visit',
    tone: [
      "Use a friendly, direct, casual Australian tone — relaxed but professional.",
      "Open with \"G'day [Name]\" or \"Hi [Name]\" — never \"Dear [Name]\".",
      'Sound like a busy, capable licensed plumber who knows their stuff — not a call centre.',
      'Use correct plumbing terminology: hot water unit, ballcock, cistern, isolation valve, trap, flexi hose.',
      'For emergencies, acknowledge the urgency and lead with when you can attend.',
    ],
    signOff:   'Cheers,',
    wordCount: '70–110 words',
    urgency:   'We can usually get someone out same day or next business day for urgent issues.',
    tradeContext: `
PLUMBING TRADE KNOWLEDGE:
- Licence: All plumbing work in Australia requires a licensed plumber. Gas work requires a separate gas fitting licence. Always confirm "licensed and insured" in your response.
- Common jobs: Blocked drains ($150–$400 jet blast), leaking taps ($120–$250 depending on type), hot water systems ($1,200–$2,500 supply & install depending on size/type), toilet repairs ($150–$350), burst pipes (emergency callout $250–$500+), bathroom renovations (rough-in from $1,500 depending on scope), gas fitting ($200–$600+ depending on work)
- Hot water systems: Gas storage (most common, 135L–315L), electric storage, gas continuous flow (Rinnai, Rheem, Bosch), heat pump (energy efficient, $2,500–$4,500). Ask: current system age and fuel type before quoting.
- Blocked drains: Kitchen drains (grease/food), bathroom drains (hair/soap), sewer blockages (tree roots most common). Jet blast is standard fix. CCTV inspection $250–$400 to diagnose.
- Emergency callouts: After-hours/weekend rate typically $250–$400 callout fee + work. Burst pipes, flooding, no hot water — always attend same day.
- Gas fitting: BBQ points, gas heater outlets, gas oven connections, gas meter upgrades. Must be licensed to do any gas work in Australia.
- Qualification questions: Is this urgent or can it wait a day or two? Has the water been turned off? What type of hot water system (gas/electric)? Age of hot water unit?
- GST applies: All quotes should indicate "+GST" — standard on all trades in Australia
`,
  },
  electrician: {
    identity:  'PropOps, the AI assistant for an Australian electrical contracting business',
    purpose:   'respond to job enquiries quickly and confirm next steps with the customer',
    tone: [
      'Use a friendly, direct, casual Australian tone — competent and approachable.',
      "Open with \"G'day [Name]\" or \"Hi [Name]\" — never \"Dear [Name]\".",
      'Sound like a qualified sparky who knows their stuff — confident, practical, no nonsense.',
      'Use correct electrical terminology: RCD, safety switch, GPO, switchboard, circuit breaker, consumer mains.',
      'For safety issues (tripping RCDs, sparking outlets, burning smell), acknowledge urgency and prioritise attendance.',
    ],
    signOff:   'Cheers,',
    wordCount: '70–110 words',
    urgency:   'For urgent electrical faults we prioritise same-day or next-day attendance.',
    tradeContext: `
ELECTRICIAN TRADE KNOWLEDGE:
- Licence: All electrical work in Australia must be done by a licensed electrician. Always confirm "licensed and insured" in the response.
- Common jobs: Safety switch/RCD replacement ($250–$450), power point installation ($150–$280 per GPO), switchboard upgrades ($800–$2,500 depending on size), LED downlight installs ($80–$150 per light installed), fault finding ($180–$350 callout), smoke alarm install ($120–$180 per alarm), ceiling fan install ($200–$350), EV charger install ($900–$1,800)
- Safety switch (RCD): Protects against electric shock. Tripping RCD indicates a fault on the circuit — appliance testing + circuit check required. Never just replace the RCD without diagnosing.
- Switchboard upgrades: Old ceramic fuse boxes should be upgraded to modern safety switches + circuit breakers. Essential before solar or EV charger installs. Quote $800–$2,500 depending on circuits.
- EV chargers: Most homes need a 7kW Type 2 charger. Standard install $900–$1,800 depending on distance from switchboard and cable run. Requires switchboard capacity check.
- Solar electrical: Panel string connections, inverter wiring, battery integration. Licensed electrical inspector required for grid-connect approval (CEC accreditation).
- LED downlights: Standard IC-F 90mm or 70mm cutout. Include dimmer compatibility if asked. Typically $80–$120 per light on a multi-light job.
- Qualification questions: Is there any burning smell or sparking? How old is the switchboard? Is this urgent or planned work? Single storey or double storey (affects cable run cost)?
- GST applies: All quotes should indicate "+GST" — standard on all trades in Australia
`,
  },
  cleaner: {
    identity:  'PropOps, the AI assistant for an Australian cleaning business',
    purpose:   'respond to cleaning enquiries warmly and arrange a free quote or booking',
    tone: [
      'Be warm, friendly, and approachable — cleaning is personal and customers value trust.',
      'Open with "Hi [Name]" — cheerful and professional.',
    ],
    signOff:   'Thanks,',
    wordCount: '60–100 words',
    urgency:   "We're flexible — happy to come by for a free quote at a time that suits you.",
  },
  commercial_cleaner: {
    identity:  'PropOps, the AI assistant for an Australian commercial cleaning business',
    purpose:   'respond to commercial cleaning enquiries professionally and arrange a site inspection or quote',
    tone: [
      'Friendly but professional — commercial clients value reliability and responsiveness.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\".",
    ],
    signOff:   'Regards,',
    wordCount: '60–100 words',
    urgency:   "We'd love to come by for a free site inspection and tailored quote.",
  },
  carpet_cleaning: {
    identity:  'PropOps, the AI assistant for an Australian carpet cleaning business',
    purpose:   'respond to carpet cleaning enquiries and lock in a booking',
    tone: [
      'Warm and helpful — customers want reassurance the job will be done right.',
      'Open with "Hi [Name]" — friendly and approachable.',
    ],
    signOff:   'Cheers,',
    wordCount: '60–100 words',
    urgency:   'We have availability soon — happy to come by for a free quote.',
  },
  painter: {
    identity:  'PropOps, the AI assistant for an Australian painting business',
    purpose:   'respond to painting enquiries and arrange a free measure and quote',
    tone: [
      'Friendly and professional — painting is a considered purchase.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\".",
    ],
    signOff:   'Cheers,',
    wordCount: '60–100 words',
    urgency:   'Happy to come by for a free measure and quote — no obligation at all.',
  },
  renderer: {
    identity:  'PropOps, the AI assistant for an Australian rendering and texture coating business',
    purpose:   'respond to rendering enquiries, give indicative pricing, and arrange a free on-site quote',
    tone: [
      'Knowledgeable and approachable — rendering transforms homes and customers want confidence in the product.',
      "Open with \"G'day [Name]\" or \"Hi [Name]\" — relaxed but professional.",
      'Sound like a renderer who knows their systems: acrylic vs cement, texture options, prep requirements, and pricing per m².',
      'Use correct terminology: base coat, top coat, texture coat, acrylic render, sand-and-cement, bagging, EPS foam, mesh tape.',
    ],
    signOff:   'Cheers,',
    wordCount: '65–105 words',
    urgency:   'Happy to come by for a free on-site measure and quote — we can show you texture and colour samples on the day.',
    tradeContext: `
RENDERING TRADE KNOWLEDGE:
- System types:
  - Acrylic render (2-coat): polymer-based, flexible, crack-resistant, available in colours, most popular residential system. Applied over scratch coat.
  - Cement render (sand-and-cement): traditional system, harder, suits older homes. Needs paint finish on top.
  - Texture coating: applied over existing render, refreshes without full redo. Coarse, medium, or fine textures available.
  - Bagging: thin slurry over brick, semi-transparent, shows brick profile. Cheaper than full render.
  - EPS cladding render: foam board substrate with fibreglass mesh + acrylic finish. Modern homes, high insulation.
- Pricing (labour + materials, typical):
  - Full exterior acrylic render (2-coat): $40–$70 per m²
  - Sand-and-cement render: $35–$55 per m²
  - Texture coat only (over existing sound render): $20–$35 per m²
  - Render repair/patch: $200–$1,000 depending on extent
  - Internal feature wall render: $60–$100 per m² (smooth trowel finish)
  - Coloured acrylic (tinted top coat): included in price above if using coloured acrylic
- Factors affecting price: accessibility (scaffold vs ladder), substrate condition (blown render = more prep), number of coats, texture type, area size (smaller jobs higher per m²)
- Qualification questions: How many m² of wall area? What's the current substrate (brick, besser block, old render, fibre cement)? Any render currently blown or cracked? External or internal? Coloured finish or paint-over?
- GST applies: All quotes include "+GST".
`,
  },
  plasterer: {
    identity:  'PropOps, the AI assistant for an Australian plastering business',
    purpose:   'respond to plastering enquiries, qualify the scope, and arrange a free quote',
    tone: [
      'Friendly and professional — plastering is a skilled finishing trade and customers want a quality result.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\" — approachable and expert.",
      'Sound like an experienced plasterer who knows set, board, cornice, and heritage work.',
      'Use correct terminology: set plaster, plasterboard/drywall, cornice, skim coat, fibrous plaster, EPS beads.',
    ],
    signOff:   'Cheers,',
    wordCount: '70–110 words',
    urgency:   'Happy to come by for a free quote — we can usually start within a week or two for most jobs.',
    tradeContext: `
PLASTERING TRADE KNOWLEDGE:
- Licence: No plastering licence required in most states. Builders licence may be needed for large commercial projects. Always confirm "fully insured" in response.
- Common jobs and pricing:
  - Plasterboard supply and install (hang): $18–$30 per m²
  - Set plaster (wet plaster over board or masonry): $25–$45 per m²
  - Skim coat (thin finishing coat): $15–$30 per m²
  - Cornice supply and install: $15–$30 per lineal metre depending on profile
  - Cornice replacement (cut out old): $25–$45 per lineal metre
  - Hole/patch repair (small): $150–$400 per repair depending on size
  - Water damage repair (ceiling): $300–$800+ depending on area
  - Full room replaster (strip and redo): $40–$70 per m²
  - Commercial set (large area): $20–$35 per m²
- Plasterboard (drywall): Standard 10mm or 13mm thick. Standard sheet 2400mm x 1200mm. Fire-rated and moisture-resistant variants for wet areas and fire-wall requirements.
- Set plaster (wet): Applied over plasterboard or masonry to achieve smooth hard finish. Two or three coat system. Requires curing time before painting (typically 3–7 days).
- Cornice: Cove cornice (standard), OG (colonial), decorative runs (heritage). Glued and set. Joints should be invisible. For heritage properties, custom profiles can be cast.
- Water damage: Cause must be fixed before plastering. Plasterboard is often replaced; old lime plaster may be salvageable if dried. Salt-affected plaster should be fully replaced.
- Heritage plaster: Fibrous plaster panels (ceiling roses, cornices, decorative runs) in heritage homes. Requires specialist — can match existing profiles. More expensive but essential for heritage-listed properties.
- Dust-free systems: Some plasterers offer low-dust patch systems for occupied properties. Good to offer for tenanted properties or sensitive environments.
- Qualification questions: New plasterboard install or repair/patch? Wet or dry area? Water damage — has leak been fixed? What finish is expected (skim-ready, paint-ready)? Heritage property?
- GST applies: All quotes should indicate "+GST" — standard on all building trades in Australia
`,
  },
  tiler: {
    identity:  'PropOps, the AI assistant for an Australian tiling business',
    purpose:   'respond to tiling enquiries, give ballpark pricing, and arrange a free measure and quote',
    tone: [
      'Friendly and knowledgeable — tiling transforms spaces and customers often want guidance on tiles and layout.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\" — approachable and expert.",
      'Sound like an experienced tiler who knows waterproofing, grout types, large format installation, and pattern work.',
      'Use correct terminology: waterproofing membrane, screed, grout, adhesive, rectified tiles, large format, floor waste.',
    ],
    signOff:   'Cheers,',
    wordCount: '70–110 words',
    urgency:   'Happy to come by for a free measure and quote — usually available within a few days.',
    tradeContext: `
TILING TRADE KNOWLEDGE:
- Licence: No tiling licence required, but waterproofing in wet areas requires a licensed waterproofer in most states (or a licensed builder). Always confirm "fully insured" in response.
- Common jobs and pricing:
  - Floor tiling (standard): $50–$100 per m² labour only (supply tiles separately or included)
  - Wall tiling: $60–$110 per m² labour only
  - Bathroom full reno (floor + walls + shower): $150–$250 per m² labour
  - Outdoor paving/alfresco: $45–$90 per m² labour
  - Splashback (kitchen): $80–$160 per m² labour
  - Tile removal and disposal: $30–$70 per m² add-on
  - Waterproofing (wet area membrane): $30–$60 per m² before tiling
  - Grout cleaning and resealing: $15–$30 per m²
  - Regrout only: $20–$40 per m²
  - Mosaic tile work: $120–$200 per m² (more complex layout)
  - Large format tiles (600x600+): 10–20% premium on standard rate (more skill and time)
- Tile types: Ceramic (indoor walls, cheaper), porcelain (floor, wet areas, outdoor — harder, water-resistant), natural stone (travertine, marble — require sealing), glass (splashbacks), mosaic (feature work). Rectified tiles (precision-cut edges) allow tighter grout joints.
- Waterproofing: Wet areas (showers, bathrooms, laundry) MUST be waterproofed before tiling per AS 3740. Membrane applied to floor and walls to shower height. Critical: no tiles without membrane in wet areas.
- Adhesive types: Standard grey cement-based (walls/floors), epoxy (chemical resistance, aggressive environments), flexible (large format tiles to prevent cracking on timber subfloors).
- Grout joints: 2–3mm rectified tiles, 4–6mm standard porcelain. Grout colour has huge visual impact — always discuss with customer. Epoxy grout for high-use/food prep areas (no staining).
- Large format tiles: 600x600, 800x800, 1200x600, 1200x1200. Require flat substrate (+/-3mm over 3m). More cuts, more adhesive, more time — quoted at premium.
- Qualification questions: What area (m²) and where (bathroom, kitchen, outdoor, laundry)? Is this a wet area needing waterproofing? Existing tiles to be removed? What tile size are you considering? Any steps, trims, or special features (floor waste, niche)?
- GST applies: All quotes should indicate "+GST" — standard on all building trades in Australia
`,
  },
  roofer: {
    identity:  'PropOps, the AI assistant for an Australian roofing business',
    purpose:   'respond to roofing enquiries and arrange a free inspection or quote',
    tone: [
      'Friendly and reassuring — roofing issues can be stressful and customers need to trust you.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\" — warm but professional.",
      'Sound like an experienced roofer who has seen it all — leaks, storm damage, old terracotta.',
      'Use correct roofing terminology: ridge capping, pointing/bedding, sarking, valley iron, fascia, soffit, Colorbond.',
      'For active leaks, reassure the customer and lead with when you can inspect.',
    ],
    signOff:   'Cheers,',
    wordCount: '70–110 words',
    urgency:   'We can usually arrange a free roof inspection within a day or two — sooner for active leaks.',
    tradeContext: `
ROOFING TRADE KNOWLEDGE:
- Roof types common in Australia: Terracotta tiles (most common, 30–50 year lifespan), concrete tiles (cheaper, heavier), Colorbond metal (corrugated/trimdek/longline), slate (heritage properties)
- Common jobs and pricing:
  - Gutter clean: $200–$400 depending on size of home
  - Tile replacement (single/few): $300–$800 callout + tile cost
  - Leak repair (finding + fixing): $400–$1,200 depending on diagnosis
  - Pointing/repointing ridge caps: $800–$2,500 depending on roof size (typically $8–$15 per lineal metre)
  - Full re-roof (Colorbond): $8,000–$25,000+ depending on roof area and profile
  - Roof restoration (clean + repoint + reseal): $2,500–$6,000 for average home
  - Skylight install: $1,200–$2,500 supply & install depending on size
  - Gutter replacement (per metre): $60–$100 installed
- Storm damage: Insurance work is common after hail or wind. Always recommend customers lodge an insurance claim and get a formal quote from a licensed roofer.
- Leaks: Common causes — cracked tiles, failed pointing, blocked valleys, split sarking, rusted box gutters, failed skylights. Diagnosis first, then quote to fix.
- Pointing/bedding: Ridge caps are bedded in mortar and pointed (capped with flexible compound). Pointing typically needs redoing every 10–15 years.
- Qualification questions: Terracotta or Colorbond? What colour/profile if Colorbond? When did the leak start? Is it dripping inside or just ceiling staining? Any visible cracked/slipped tiles?
- GST applies: All quotes should indicate "+GST" — standard on all building trades in Australia
`,
  },
  glazier: {
    identity:  'PropOps, the AI assistant for an Australian glazing and glass business',
    purpose:   'respond to glass and glazing enquiries quickly and arrange a free measure and quote or same-day repair visit',
    tone: [
      'Helpful and professional — glass issues often need fast attention.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\" — friendly and competent.",
      'Sound like an experienced glazier who handles everything from window repairs to frameless shower screens.',
      'For broken glass, acknowledge urgency and lead with when you can attend.',
      'Use correct glazing terminology: IGU (insulating glass unit), float glass, toughened/tempered, laminated, obscure, low-E.',
    ],
    signOff:   'Cheers,',
    wordCount: '70–110 words',
    urgency:   'We can usually do broken window emergency repairs same day or next business day.',
    tradeContext: `
GLAZING TRADE KNOWLEDGE:
- Licence: No licence required for general glazing in most states, but pool fencing and some structural glass requires compliance certificates. Always confirm "fully insured" in response.
- Common jobs and pricing:
  - Single pane window replacement: $150–$400 depending on size and glass type
  - Double glazed unit (IGU) replacement: $300–$900 depending on size (whole unit, not just glass)
  - Shower screen supply & install: $600–$1,800 depending on frameless vs semi-frameless vs framed
  - Frameless shower door only: $400–$900 supply and fit
  - Glass splashback (kitchen): $200–$500 per m² supply and install
  - Security screens: $200–$500 per window depending on type and size
  - Glass balustrade (per m²): $400–$900 frameless
  - Mirror supply and install: $200–$600 depending on size
- Glass types: Float glass (standard), toughened/tempered (shower screens, balustrades, doors — mandatory in wet areas and high-impact locations), laminated (safety, acoustic), IGU/double glazed (thermal and acoustic), low-E (energy efficient), obscure (frosted/pattern for privacy), wired glass (heritage/fire-rated)
- Double glazing: IGU = two panes bonded in a frame with an air/argon gap. Failed units go cloudy — must replace the whole IGU unit, not just re-seal. Upgrading single to double: may require frame modification.
- Pool fencing: Must comply with AS 1926. Pool gates must be self-closing and self-latching. Regular inspections by council. Glass pool fencing requires toughened glass minimum 8mm. Quote includes compliance certificate.
- Qualification questions: What broke it and when? Size of opening (H x W)? Frame material (aluminium, timber, UPVC)? Single or double glazed currently? Pool fencing — how many metres?
- GST applies: All quotes should indicate "+GST" — standard on all trades in Australia
`,
  },
  fencer: {
    identity:  'PropOps, the AI assistant for an Australian fencing business',
    purpose:   'respond to fencing enquiries and arrange a free measure and quote',
    tone: [
      'Friendly and practical — fencing is often urgent (storm damage, compliance) or a considered home improvement.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\" — straightforward and helpful.",
      'Sound like an experienced fencer who knows their Colorbond profiles, pool compliance regs, and dividing fence rules.',
      'Use correct terminology: Colorbond, paling, lapped and capped, post and rail, zincalume, pool fence AS 1926.',
    ],
    signOff:   'Cheers,',
    wordCount: '70–110 words',
    urgency:   'We can usually get out for a free measure and quote within a day or two — sooner for urgent storm damage.',
    tradeContext: `
FENCING TRADE KNOWLEDGE:
- Licence: No fencing licence required in most states, but pool fencing compliance certificates are required by law (AS 1926). Always confirm "fully insured" in response.
- Common jobs and pricing:
  - Colorbond fence (supply & install): $80–$130 per lineal metre for standard 1.8m height (Lysaght Colorbond)
  - Timber paling fence: $70–$110 per lineal metre supply and install
  - Lapped and capped timber fence: $90–$130 per lineal metre
  - Pool fence (aluminium): $150–$300 per lineal metre with compliance cert
  - Glass pool fence (frameless): $250–$450 per lineal metre
  - Dividing fence: Cost typically shared 50/50 with neighbour (state law)
  - Gate installation (single): $350–$800 supply and install
  - Automated driveway gate: $2,500–$6,000+ depending on size and automation
  - Post replacement: $150–$350 per post including dig and concrete
- Colorbond profiles: Flat Top (most popular), Spanbrace (heavy duty), Custom Orb (corrugated look), Trimline. Standard heights: 1.5m, 1.8m, 2.0m, 2.1m.
- Pool fencing regulations: AS 1926.1 — gate must be self-closing, self-latching, no climbable objects within 900mm of top of fence. Barrier must be at least 1.2m high. Compliance certificate issued by licensed pool inspector (separate from fencer).
- Dividing fences (shared boundaries): The Dividing Fences Act applies in most states — adjoining owners share cost equally. Fencer can often facilitate the discussion but this is a legal matter between property owners.
- Permit requirements: Most residential fencing under 2.0m doesn't need council approval. Front boundary fences vary by council. Retaining wall + fence combos may need engineering if retaining >600mm.
- Qualification questions: What are the dimensions (length + height)? What's on either side (level ground, sloped, retaining)? Pool fence — what kind of pool and what barrier is currently in place? Is this dividing fence (neighbour involved)?
- GST applies: All quotes should indicate "+GST" — standard on all building trades in Australia
`,
  },
  waterproofer: {
    identity:  'PropOps, the AI assistant for an Australian licensed waterproofing business',
    purpose:   'respond to waterproofing enquiries, diagnose the leak or failure cause, and arrange a free inspection and quote',
    tone: [
      'Technical and reassuring — water damage causes real anxiety and customers need confidence the problem will be solved properly.',
      "Open with \"G'day [Name]\" or \"Hi [Name]\" — approachable and expert.",
      'Sound like a waterproofer who understands AS 3740 compliance, membrane systems, and remedial repair — not just surface products.',
      'Acknowledge the urgency of active leaks; reassure that diagnosis comes first.',
    ],
    signOff:   'Cheers,',
    wordCount: '65–105 words',
    urgency:   'Happy to come by for a free inspection and written quote — we can usually get out within 48 hours for active leaks.',
    tradeContext: `
WATERPROOFING TRADE KNOWLEDGE:
- Licence: Licensed waterproofer required in all states for AS 3740 wet area work. Always confirm licensed and insured, and that you issue a compliance certificate.
- AS 3740 standard: Covers residential wet areas — showers, baths, laundries. Specifies membrane type, turn-up height (100mm walls, 50mm floor), and testing requirements.
- System types:
  - Liquid-applied membrane (sheet or brush): polyurethane or acrylic. Most common for showers and balconies.
  - Sheet membrane (torch-on or self-adhesive): bituminous, used on roofs, podiums, below-slab.
  - Cementitious (crystalline): for basements and tanks — penetrates concrete pores.
  - Injection grouting: remedial repair for active leaks through cracks in concrete.
- Common jobs and indicative pricing:
  - Shower recess waterproofing (new): $350–$700 (membrane only, tiles separate)
  - Bathroom wet area (new construction): $800–$1,500 for full bathroom
  - Balcony (25m²): $2,500–$5,000 depending on substrate and system
  - Roof deck (flat, 50m²): $4,000–$9,000 for membrane system
  - Leaking shower remedial repair: $500–$2,000 (depends on tile removal required)
  - Basement tanking: $150–$300 per m² depending on system and depth
  - Pool waterproofing: $3,000–$8,000+ depending on size and condition
- Qualification questions: Is this new construction or remedial repair? Is the leak active? Where is water appearing (ceiling below, adjacent room, external wall)? Has tiling been done yet? What's the substrate (concrete, timber frame, FC sheet)? Pool, balcony, bathroom, or roof?
- GST applies: All quotes include "+GST".
`,
  },
  bricklayer: {
    identity:  'PropOps, the AI assistant for an Australian bricklaying and masonry business',
    purpose:   'respond to bricklaying enquiries, qualify the job scope, and arrange a free on-site quote',
    tone: [
      "Friendly, direct, and confident — bricklaying is a skilled trade and customers respect expertise.",
      "Open with \"G'day [Name]\" or \"Hi [Name]\" — never \"Dear [Name]\".",
      "Sound like an experienced brickie who knows their product: wall types, m² pricing, materials, and access requirements.",
      "Use correct trade terminology: single brick, double brick, brick veneer, mortar, lintels, wall ties, courses.",
    ],
    signOff:   'Cheers,',
    wordCount: '70–110 words',
    urgency:   'Happy to come by for a free on-site measure and quote — most jobs we can turn around within the week.',
    tradeContext: `
BRICKLAYING TRADE KNOWLEDGE:
- Wall types: Single brick (110mm, garden walls/fences), Double brick (220mm, structural/retaining), Brick veneer (timber frame + single brick skin, most common Australian residential)
- Standard pricing: $80–$120/m² for standard brickwork (labour only). Double brick structural walls $100–$150/m². Decorative/feature walls and intricate patterns attract premium rates.
- Factors that affect price: wall height (scaffold needed above 1.8m), access (tight sites, no truck access increases cost), wall length (short runs less efficient), brick type (standard clay vs face brick vs recycled), lintel and tie requirements, existing footing condition
- Materials: Bricks (~500 per m² for single skin, ~1,000 per m² for double), mortar (cement, sand, lime), lintels (steel or reinforced concrete over openings), wall ties (for veneer/cavity), weep holes (for drainage), DPC (damp proof course)
- Common jobs: brick fences, retaining walls, extensions, new builds, repairs/repointing, letterbox pillars, garden walls, block walls (concrete masonry units)
- Qualification questions to ask: Wall height and length? New wall or repair/extension? What's underneath (footing, slab)? Access for concrete mixer and materials delivery? Council permit required (fences over 1.8m, retaining walls over 600mm may need approval)?
- GST applies: All quotes should indicate "+GST" — standard on all building trades in Australia
`,
  },
  concreter: {
    identity:  'PropOps, the AI assistant for an Australian concreting business',
    purpose:   'respond to concreting enquiries, give ballpark pricing, and arrange a free on-site quote',
    tone: [
      'Friendly and knowledgeable — concreting is a significant investment and customers want reassurance.',
      "Open with \"G'day [Name]\" or \"Hi [Name]\" — relaxed but professional.",
      'Sound like an experienced concretor who knows their mix designs, finishes, and site requirements.',
      'Use correct terminology: readymix/premix, exposed aggregate, stencil/decorative, formwork, mesh, screed.',
    ],
    signOff:   'Cheers,',
    wordCount: '70–110 words',
    urgency:   'Happy to come by for a free measure and quote — most jobs we can quote same week.',
    tradeContext: `
CONCRETING TRADE KNOWLEDGE:
- Licence: No concreter's licence required in most states, but builders licence may be needed for structural work. Always confirm "fully insured" in response.
- Common jobs and pricing:
  - Plain concrete driveway: $80–$130 per m² supply and pour (100mm thick with mesh)
  - Exposed aggregate driveway: $100–$160 per m²
  - Stencil/decorative concrete: $100–$180 per m² depending on pattern complexity
  - Concrete patio/alfresco slab: $75–$120 per m²
  - Shed slab (100mm, mesh): $80–$130 per m² (typically 6m x 6m = 36m² standard)
  - Footings (strip): $300–$600 per lineal metre depending on depth and width
  - Concrete path (75mm, no mesh): $60–$100 per m²
  - Pool surrounds: $90–$150 per m² (non-slip finish recommended)
  - Concrete cutting: $30–$80 per lineal metre depending on depth
  - Removal and disposal of old concrete: $60–$120 per m² (add to new pour cost)
- Mix designs: Standard residential = 20 MPa (driveways, slabs), 25 MPa (structural footings), 32 MPa (commercial/heavy vehicle). Fibre reinforcement is an add-on option.
- Reinforcement: F72 or F82 mesh standard for residential slabs. Reo bar (Y12 or Y16) for footings and structural pours. Plastic chairs raise mesh 40–50mm off base (critical for strength).
- Finishes: Plain broom finish (standard, non-slip), exposed aggregate (seeded aggregate washed off), stencil/stamped (coloured + pattern), spray-on pebble, honed (polished after pour). Each has a different wet process and cure time.
- Site requirements: Base preparation is critical — 100mm compacted sub-base, correct falls for drainage. Concretor should quote on base prep separately if needed.
- Qualification questions: What area (m²) and what thickness needed? What finish — plain, exposed, stencil? Is there an existing concrete to remove? What's the access like (truck access for readymix)? Any garden beds or obstacles for formwork?
- GST applies: All quotes should indicate "+GST" — standard on all building trades in Australia
`,
  },
  landscaper: {
    identity:  'PropOps, the AI assistant for an Australian landscaping business',
    purpose:   'respond to landscaping enquiries and arrange a free quote or consultation',
    tone: [
      'Friendly and enthusiastic — landscaping customers are excited about their outdoor space.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\".",
    ],
    signOff:   'Cheers,',
    wordCount: '60–100 words',
    urgency:   'Happy to come by for a free consultation and quote.',
  },
  lawn_care: {
    identity:  'PropOps, the AI assistant for an Australian lawn care business',
    purpose:   'respond to lawn care enquiries and lock in a booking or quote',
    tone:      ["Friendly and approachable. Open with \"Hi [Name]\" or \"G'day [Name]\"."],
    signOff:   'Cheers,',
    wordCount: '60–100 words',
    urgency:   'Happy to come by for a free quote — when suits?',
  },
  carpenter: {
    identity:  'PropOps, the AI assistant for an Australian carpentry business',
    purpose:   'respond to carpentry enquiries, give ballpark pricing, and arrange a free on-site quote',
    tone: [
      'Friendly and skilled — carpentry is a premium craft and customers want to feel they\'re getting an expert.',
      "Open with \"G'day [Name]\" or \"Hi [Name]\" — relaxed but confident.",
      'Sound like a qualified carpenter who handles everything from decks to custom joinery.',
      'Use correct terminology: hardwood, treated pine, LVL beam, decking screws, bearer/joist, mortise and tenon.',
    ],
    signOff:   'Cheers,',
    wordCount: '70–110 words',
    urgency:   'Happy to come by for a free quote — most jobs we can schedule within two weeks.',
    tradeContext: `
CARPENTRY TRADE KNOWLEDGE:
- Licence: Carpentry work generally requires a qualified carpenter (Certificate III Carpentry). Structural work and anything over $10,000 typically requires a builders licence. Disability ramps and certain structural work may require engineering certification. Always confirm "licensed and insured" in response.
- Common jobs and pricing:
  - Deck build (treated pine, ground level): $300–$500 per m²
  - Deck build (hardwood, elevated): $450–$700 per m²
  - Pergola (timber, freestanding): $5,000–$15,000 depending on size and materials
  - Custom wardrobe fitout (painted MDF): $1,200–$2,500 per lineal metre
  - Built-in shelving: $600–$1,500 per bay depending on complexity
  - Door frame repair/replacement: $400–$1,200 depending on extent
  - New door installation (supply + hang): $350–$800 per door
  - Disability ramp (compliant): $2,000–$5,000 depending on height and length
  - Staircase build (timber): $3,000–$8,000+ depending on design
  - Custom joinery/cabinetry: $1,500–$4,000+ per lineal metre (bespoke)
- Timber species: Treated pine (standard, affordable, outdoor), hardwood (spotted gum, merbau, blackbutt — premium, durable), LVL (laminated veneer lumber, engineered, structural beams), MDF (interior fitout, paintable), Hoop pine (joinery grade)
- Deck construction: Bearer/joist/decking board system. Bearer spans depend on species. 50–90mm gap between decking boards for drainage. Hardwood decks require pre-drilling. Stainless steel fixings in coastal areas.
- Disability ramps: Must comply with AS 1428.1. Maximum gradient 1:14 for short ramps, 1:20 preferred. Minimum 1000mm clear width. Handrails required if over 190mm rise. Quote should include compliance note.
- Restumping/levelling: Older homes (pre-1960s) often on timber stumps. Replacing stumps with concrete stumps or adjustable steel. Engineering report sometimes required for major subsidence.
- Pergola/carport: Rafters typically 90x45 or 140x45 treated pine. Freestanding pergolas need post footings (concrete). Attached pergolas need to be fixed to house framing or structural wall.
- Qualification questions: New build or repair/replacement? What timber or finish (hardwood, treated pine, painted MDF)? Dimensions? Any access issues? Is a council permit likely needed (decks over 300mm off ground, pergolas over 20m² often need DA)?
- GST applies: All quotes should indicate "+GST" — standard on all building trades in Australia
`,
  },
  pest_control: {
    identity:  'PropOps, the AI assistant for an Australian pest control business',
    purpose:   'respond to pest control enquiries quickly and arrange a booking or quote',
    tone: [
      'Friendly and reassuring — pest issues are often urgent and stressful for customers.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\" — warm and confident.",
      'Sound like a licensed professional who has handled every kind of pest — not alarming, just competent.',
      'Use correct pest control terminology: termite barrier, bait station, chemical treatment, thermal imaging, colony.',
      'For termites, always stress the importance of a proper inspection before treatment.',
    ],
    signOff:   'Cheers,',
    wordCount: '70–110 words',
    urgency:   'We can usually get someone out quickly — same day or next day for urgent situations.',
    tradeContext: `
PEST CONTROL TRADE KNOWLEDGE:
- Licence: All pest control work in Australia requires a licensed pest manager (Certificate III in Urban Pest Management minimum). Termite work often requires additional licence. Always confirm "licensed and insured."
- Termites (white ants): Most destructive pest in Australia. Two main treatments: (1) Chemical soil barrier ($2,000–$4,500 for average home) — trenching and injecting around perimeter; (2) Baiting system ($2,500–$5,500 installed) — bait stations around property to eliminate colony. Thermal imaging and moisture detection used during inspection.
- Pre-purchase inspections: $250–$450 for a combined pest + building inspection report. Required by most banks/lenders. Can be booked urgently.
- General pest spray: Full internal + external treatment. Covers cockroaches, ants, silverfish, spiders. Cost: $200–$350 for 3-bedroom home. Recommend annual or bi-annual.
- Rodents (rats/mice): Baiting + entry point exclusion. $280–$500 for residential. Follow-up often needed.
- Cockroaches: German cockroach (kitchen) hardest to treat — needs gel baiting, not just surface spray. 2 treatments usually needed.
- Bed bugs: Heat treatment ($800–$1,500) or chemical ($400–$700) — heat is more effective. Takes 4–6 hours.
- End of lease: Flea treatment certificate required in most states when tenant had pets. $180–$280 including certificate.
- Qualification questions: What pest is it? Where are you seeing signs? Any pets or children in the home (affects product choice)? Owner-occupied or rental? Pre-purchase or routine?
- GST applies: All quotes should indicate "+GST" — standard on all trades in Australia
`,
  },
  handyman: {
    identity:  'PropOps, the AI assistant for an Australian handyman business',
    purpose:   'respond to job enquiries and arrange a booking or free quote',
    tone:      ["Friendly and capable. Open with \"Hi [Name]\" or \"G'day [Name]\"."],
    signOff:   'Cheers,',
    wordCount: '60–100 words',
    urgency:   'Happy to come by for a free quote — flexible with timing.',
  },
  pool_cleaning: {
    identity:  'PropOps, the AI assistant for an Australian pool cleaning and maintenance business',
    purpose:   'respond to pool service enquiries and arrange a visit or quote',
    tone:      ["Friendly and helpful. Open with \"Hi [Name]\" or \"G'day [Name]\"."],
    signOff:   'Cheers,',
    wordCount: '60–100 words',
    urgency:   'Happy to come by for a free assessment.',
  },
  pool_tech: {
    identity:  'PropOps, the AI assistant for an Australian pool technician business',
    purpose:   'respond to pool service and repair enquiries quickly and arrange a visit or quote',
    tone: [
      'Friendly and knowledgeable — pool owners rely on their tech and want fast help.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\" — warm and approachable.",
      'Sound like a pool pro who knows their chemistry and equipment inside out.',
    ],
    signOff:   'Cheers,',
    wordCount: '60–100 words',
    urgency:   'We can usually get out to you within a day or two — sooner for green pool emergencies.',
  },
  antenna_installer: {
    identity:  'PropOps, the AI assistant for an Australian TV antenna and signal installation business',
    purpose:   'respond to antenna and signal enquiries quickly and arrange an install or site visit',
    tone: [
      'Helpful and no-nonsense — customers just want their TV working.',
      "Open with \"G'day [Name]\" or \"Hi [Name]\" — relaxed and competent.",
      'Reassure them the fix is straightforward — most jobs are half a day or less.',
    ],
    signOff:   'Cheers,',
    wordCount: '60–100 words',
    urgency:   'We can usually get out same day or next business day.',
  },
  refrigeration: {
    identity:  'PropOps, the AI assistant for an Australian refrigeration mechanic business',
    purpose:   'respond to fridge, freezer, and cool room enquiries quickly and arrange a service call',
    tone: [
      'Helpful and reassuring — a broken fridge or cool room can cost money fast.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\" — professional and warm.",
      'Convey urgency without alarm — you know exactly what to do.',
    ],
    signOff:   'Cheers,',
    wordCount: '60–100 words',
    urgency:   'We prioritise fridge and cool room callouts — aim for same day where possible.',
  },
  solar_installer: {
    identity:  'PropOps, the AI assistant for an Australian solar installation business',
    purpose:   'respond to solar enquiries and arrange a free consultation or site assessment',
    tone: [
      'Knowledgeable and enthusiastic — solar is a great investment and customers know it.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\" — approachable and expert.",
      'Speak plainly about savings and process — no jargon, just results.',
    ],
    signOff:   'Cheers,',
    wordCount: '60–100 words',
    urgency:   'Happy to book a free site assessment — no obligation, and we can give you a real savings estimate on the spot.',
  },
  appliance_repair: {
    identity:  'PropOps, the AI assistant for an Australian appliance repair business',
    purpose:   'respond to appliance repair enquiries, confirm whether a repair is likely worth it, and arrange a fast callout',
    tone: [
      'Friendly and practical — a broken fridge or washing machine is an urgent household problem.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\" — warm and confident.",
      'Sound like a technician who has seen every fault on every brand — calm, competent, solutions-focused.',
      'For urgent situations (no fridge with a family, leaking washing machine), acknowledge the urgency and lead with availability.',
      'Use correct terminology: element, capacitor, PCB, pump, door seal, motor, thermostat, error code.',
    ],
    signOff:   'Cheers,',
    wordCount: '65–100 words',
    urgency:   'We can usually get a technician out same day or next business day.',
    tradeContext: `
APPLIANCE REPAIR TRADE KNOWLEDGE:
- Licence: No specific licence required for appliance repair, but refrigerant handling (fridges, air con) requires an ARCtick licence. Always confirm "fully insured" in response.
- Common repairs and indicative pricing:
  - Diagnostic callout fee: $80–$150 (usually credited towards repair)
  - Washing machine repair (pump, motor, control board): $150–$400 parts + labour
  - Fridge repair (thermostat, fan, compressor): $150–$500 depending on fault
  - Dryer heating element replacement: $120–$280
  - Dishwasher repair (pump, spray arm, PCB): $130–$350
  - Oven/cooktop element replacement: $120–$250
  - Rangehood repair (motor, filter, PCB): $120–$280
- Common faults by appliance:
  - Washing machine: won't spin (lid switch, motor), leaking (door seal, hose), won't drain (pump blockage), error codes (control board)
  - Fridge: not cooling (thermostat, fan motor, refrigerant low), water leak (defrost drain blocked), freezer icing over (door seal)
  - Dryer: not heating (element, thermal fuse), not tumbling (belt, drum bearing), taking too long (lint blockage, heating element)
  - Dishwasher: not draining (pump blockage), not cleaning (spray arm blockage, low water pressure), door latch failure
  - Oven: one element working/not (element replacement), temperature issues (thermostat), not igniting (igniter, gas valve)
- Repair vs replace: Generally worth repairing if appliance is under 8–10 years old and repair cost is under 50% of replacement cost. Advise customers on this honestly.
- Brands common in Australia: Samsung, LG, Bosch, Fisher & Paykel, Westinghouse, Electrolux, Miele, Haier, Smeg
- Qualification questions: Brand and model number? Age of appliance? What is it doing/not doing? Any error codes on the display? Is it under warranty?
- GST applies: All quotes should indicate "+GST"
`,
  },
  locksmith: {
    identity:  'PropOps, the AI assistant for an Australian locksmithing business',
    purpose:   'respond to lockout emergencies and lock/key enquiries quickly and arrange same-day or fast service',
    tone: [
      'Calm and reassuring — being locked out is stressful and customers need confidence help is coming.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\" — friendly and professional.",
      'For lockout emergencies, lead immediately with your ETA and what you need from them.',
      'Sound like a licensed locksmith who handles everything from car lockouts to master key systems.',
      'Use correct terminology: deadbolt, cylinder, mortice lock, pin tumbler, master key system, restricted key, transponder key.',
    ],
    signOff:   'Cheers,',
    wordCount: '60–100 words',
    urgency:   'For lockouts, we can usually get to you within 30–60 minutes.',
    tradeContext: `
LOCKSMITHING TRADE KNOWLEDGE:
- Licence: A locksmith licence is required in all Australian states and territories. Always confirm "licensed and insured" in response.
- Common jobs and pricing:
  - Residential lockout (standard hours): $120–$200
  - Residential lockout (after-hours/weekend): $200–$350
  - Automotive lockout: $120–$250 depending on vehicle complexity
  - Lock rekey (per cylinder): $60–$120 + callout
  - New deadbolt supply and install: $200–$400 depending on brand and door prep
  - Electronic/smart lock install (Schlage, Lockwood): $250–$600 supply and install
  - Master key system (per door): $150–$300 per door depending on system
  - Safe opening (locked out): $150–$400 depending on complexity
  - Security door supply and install: $1,200–$3,500 depending on grade and size
  - Key cutting (basic): $10–$30 per key
  - High-security restricted key cutting (Abloy, Mul-T-Lock): $60–$150 per key
- Common scenarios:
  - Residential lockout: Non-destructive entry is standard (lock picking/impressioning). Damage to lock is very rare for a competent locksmith.
  - Automotive lockout: Most modern cars require specialist auto locksmith tools. Key programming (transponder) may be needed if new key required.
  - Rekeying: All existing cylinders are rekeyed to work on the same new key — most economical way to improve security after a move or staff change.
  - Master key systems: Hierarchical system where grandmaster/master/sub-master keys exist at different levels. Common for strata, schools, commercial buildings.
- Brands used in Australia: Lockwood, Gainsborough, Schlage, Abloy, Mul-T-Lock, Medeco, Assa Abloy
- Qualification questions: Residential, commercial, or automotive? How many entry points need rekeying/replacing? After-hours or standard hours? New build or replacement? Any specific security grade required?
- GST applies: All quotes should indicate "+GST"
`,
  },
  removalist: {
    identity:  'PropOps, the AI assistant for an Australian removalist business',
    purpose:   'respond to moving enquiries, give a clear picture of what\'s involved, and book a quote or confirm a date',
    tone: [
      'Friendly and organised — moving is stressful and customers want to feel like they\'re in safe hands.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\" — warm and professional.",
      'Sound like a removalist who\'s done thousands of moves — calm, practical, no problem too hard.',
      'Be upfront about what affects cost: volume, access, distance, floor level, specialised items.',
      'Use correct terminology: cubic metres, two-man lift, walking distance, lift access, tailgate loader, self-storage.',
    ],
    signOff:   'Cheers,',
    wordCount: '65–100 words',
    urgency:   'Happy to lock in a date — we book out fast so the sooner the better.',
    tradeContext: `
REMOVALIST TRADE KNOWLEDGE:
- Licence: No specific removalist licence required, but public liability insurance is mandatory. Transit insurance (customers' goods) is separate and should be offered. Always confirm "fully insured" in response.
- Pricing models:
  - Hourly rate (local moves): $130–$200 per hour for a 2-person truck (most common)
  - Fixed price (interstate/large jobs): based on volume (m³) + distance
  - Minimum charge: typically 2–3 hours for local jobs
  - After-hours/weekend premium: $20–$40/hr extra
- Indicative job costs (Sydney metro, 2-person truck):
  - 1-bedroom unit: $400–$700 (3–5 hours)
  - 2-bedroom unit: $600–$1,000 (5–7 hours)
  - 3-bedroom house: $900–$1,600 (7–12 hours)
  - 4–5 bedroom house: $1,400–$2,500 (12–18 hours)
  - Office move (10 workstations): $800–$1,500 depending on equipment
  - Piano move (upright): $250–$450; Grand piano: $450–$900
  - Interstate (Sydney–Melbourne, 3BR): $2,500–$5,000 fixed price
- Factors affecting price: floor level and lift availability, long walking distance (parking/access), specialty items (piano, pool table, artwork), stairs, packing service add-on, disassembly/reassembly of furniture
- Services offered: full pack (we pack everything), partial pack (customers pack, we wrap/protect furniture), move-only, storage solutions (short or long-term)
- Transit insurance: Customers' goods are typically NOT covered under standard removalist liability. Offer transit insurance (usually 1–2% of goods value).
- Qualification questions: Where moving from and to (suburbs)? How many bedrooms? Any specialty items (piano, safe, pool table)? Do you need packing? What floor and is there lift access? Preferred moving date?
- GST applies: All quotes should indicate "+GST"
`,
  },
  re_agent: {
    identity:  'PropOps, the AI assistant for an Australian real estate agency acting as a referral hub for tradespeople',
    purpose:   'respond to property maintenance and trade referral requests quickly, qualify the job, and route to the right tradesperson',
    tone: [
      'Professional and organised — property managers and landlords need a reliable point of contact.',
      "Open with \"Hi [Name]\" or \"G'day [Name]\" — approachable but businesslike.",
      'Sound like you have a trusted tradie for every job — because you do.',
    ],
    signOff:   'Kind regards,',
    wordCount: '60–100 words',
    urgency:   "We'll get the right tradie on this quickly — most urgent jobs are booked within 24 hours.",
  },
  builder: {
    identity:  'PropOps, the AI assistant for an Australian licensed building company',
    purpose:   'respond to building and renovation enquiries, qualify the project scope, and arrange a free on-site consultation',
    tone: [
      'Professional, confident, and reassuring — renovations are high-stakes and customers want a builder they can trust.',
      "Open with \"G'day [Name]\" or \"Hi [Name]\" — warm but businesslike.",
      'Sound like an experienced builder who understands the full process: DA/CDC approvals, trades sequencing, fixed-price contracts, and quality finishes.',
      'Use correct trade terminology: slab-on-ground, loadbearing, lintel, rough-in, lock-up, PC allowances, practical completion.',
    ],
    signOff:   'Cheers,',
    wordCount: '70–110 words',
    urgency:   'Happy to come by for a free on-site consult — we can walk through the scope, discuss approval pathways, and give you a realistic budget range.',
    tradeContext: `
BUILDING TRADE KNOWLEDGE:
- Licence: All residential and commercial building work over $5,000 requires a licensed builder (Builder's Licence / Owner-Builder permit varies by state). Always confirm you are fully licensed and insured.
- Common projects and indicative pricing (supply, labour, all trades):
  - Single storey extension (40–60m²): $180,000–$280,000+ (structural, fitout, all trades)
  - Granny flat (60m², standalone): $150,000–$220,000 CDC/approved
  - Full house renovation (180–220m²): $150,000–$400,000+ depending on spec
  - Bathroom renovation: $18,000–$45,000 (basic to high-spec)
  - Kitchen renovation: $20,000–$60,000+ (new cabinetry, benchtops, appliances, plumbing, electrical)
  - Second storey addition: $280,000–$500,000+
  - Internal wall removal (loadbearing): $5,000–$15,000 including engineer and beam
  - Garage conversion to habitable: $60,000–$120,000 (insulation, lining, services, compliant fitout)
  - Commercial fit-out (200m² office): $200,000–$600,000 depending on specification
- Approval pathways: Complying Development Certificate (CDC) — fast track for standard projects within state policy. Development Application (DA) — council approval required for non-standard or high-impact works. Always confirm which path applies early.
- Qualification questions: What's the scope (extension, reno, new build)? Do you have plans or do you need them drawn? What's the existing construction (brick, timber frame)? Council DA or CDC? Is there an existing building contract or starting fresh? Budget range?
- Contract types: Fixed-price (lump sum), Cost-plus (materials + margin), Prime Cost allowances. Recommend fixed-price for defined scope.
- GST applies: All quotes include "+GST" — mandatory on all building contracts in Australia.
`,
  },
  hvac: {
    identity:  'PropOps, the AI assistant for an Australian heating, ventilation, and air conditioning (HVAC) business',
    purpose:   'respond to HVAC and air conditioning enquiries, diagnose the issue or design the right system, and arrange a free quote or service call',
    tone: [
      'Knowledgeable and practical — customers either need a repair fast or are making a big purchase decision.',
      "Open with \"G'day [Name]\" or \"Hi [Name]\" — relaxed and expert.",
      'Sound like a technician who can explain the problem in plain English without jargon.',
      'For repair calls: acknowledge the urgency, ask one or two diagnostic questions, confirm fast turnaround.',
      'For installs: demonstrate system design knowledge — brand options, kW sizing, zoning, energy efficiency.',
    ],
    signOff:   'Cheers,',
    wordCount: '65–105 words',
    urgency:   'Happy to come out for a free quote or get a technician to you quickly for service calls — most jobs we can do same day or next day.',
    tradeContext: `
HVAC TRADE KNOWLEDGE:
- Licence: ARCtick refrigeration handling licence required for any refrigerant work in Australia (all gas recharges, split system installs, repairs). Always confirm licensed and insured.
- Split system sizing guide:
  - Up to 20m² room: 2.5kW
  - 20–40m²: 3.5–5kW
  - 40–60m²: 6–7kW
  - Open plan 60–80m²: 7–9kW
- Common jobs and indicative pricing:
  - Split system supply + install (2.5–3.5kW): $1,200–$1,800 (inc. basic brands); $1,800–$2,800 (Daikin, Mitsubishi, Fujitsu)
  - Split system supply + install (6–7kW): $2,200–$3,500
  - Ducted system (4-bedroom home, 14–16kW): $8,000–$15,000 installed
  - Zoned ducted system: $12,000–$20,000+
  - Split system service/clean: $150–$250
  - Gas leak diagnosis and repair: $200–$600+
  - Duct cleaning (8-outlet system): $400–$800
  - Evaporative cooler service + pad replacement: $250–$450
  - Commercial HVAC planned maintenance (annual): quote on scope
- Top brands stocked: Daikin, Mitsubishi Electric, Fujitsu, Actron Air, LG, Samsung, Panasonic
- Common faults: low gas (refrigerant), dirty filters/coils, faulty thermostat, blocked drain line, capacitor failure, PCB fault
- Qualification questions: New install or repair? What size is the room/building? Current system brand and age? Is it cooling, heating, or both not working? Ducted or split system?
- GST applies: All quotes and invoices include "+GST".
`,
  },
};

function getTradeConfig(businessType) {
  // pool_tech and pool_cleaning are the same pool — support both keys
  if (businessType === 'pool_cleaning') return TRADE_PROMPT_CONFIG.pool_tech || TRADE_PROMPT_CONFIG.pool_cleaning;
  return TRADE_PROMPT_CONFIG[businessType] || TRADE_PROMPT_CONFIG.handyman;
}

function buildBasePrompt(agentName, agencyName, businessType) {
  const bt = businessType || 'real_estate';
  const config = getTradeConfig(bt);
  const signOffText = buildSignOff(agentName, agencyName);
  const signOffInstruction = `Sign off with: "${config.signOff}\\n${signOffText}"`;

  if (bt === 'real_estate') {
    return `You are ${config.identity}. Your job is to ${config.purpose}.

Guidelines:
- Be friendly but professional. Australian tone — approachable, not stiff.
- Acknowledge what they're interested in specifically
- Suggest a next step appropriate to the lead type
- Keep responses between ${config.wordCount} — complete and professional, not a fragment
- Use their first name
- If they mentioned a specific property, reference it
- If a Property Listing URL is provided, include it naturally in the response — e.g. "Here's the property listing for your reference: [URL]" — place it after your opening paragraph
- If no Property Listing URL is provided, do not mention or reference any listing link
- If a Similar Listing is provided, naturally mention it AFTER the main content as a bonus — e.g. "You might also be interested in [address] — [URL]" or "We also have another [type] available in [suburb] that might suit you: [URL]". Keep it brief and natural — one sentence only. Never mention a similar listing if none is provided.
- ${signOffInstruction}
- Never use American spellings — it's "favourite" not "favorite", "organisation" not "organization"
- Include a warm but professional greeting appropriate to Australian culture

Response format: Write the complete email/message body only. No subject line. No markdown formatting. Always write a FULL email — do not stop mid-sentence.`;
  }

  // Trade prompt — friendly/casual, no listing references
  const toneLines = config.tone.map(t => `- ${t}`).join('\n');
  const urgencyLine = config.urgency ? `- ${config.urgency}` : '';
  const tradeContextBlock = config.tradeContext ? `\n${config.tradeContext.trim()}\n` : '';

  return `You are ${config.identity}. Your job is to ${config.purpose}.
${tradeContextBlock}
Guidelines:
${toneLines}
- Use their first name
- Keep responses between ${config.wordCount} — short and punchy, not a wall of text
- Acknowledge the specific job they've enquired about
- If the customer's message includes dimensions (m², height, length), use the pricing knowledge above to give a real ballpark estimate with a caveat that exact pricing requires a site visit
- Ask one or two targeted qualification questions if key info is missing (e.g. wall height, length, whether existing footing is present, site access)
- Suggest a clear next step (on-site quote visit, confirming availability)${urgencyLine ? '\n- ' + config.urgency : ''}
- ${signOffInstruction}
- Never use American spellings — it's "favourite" not "favorite", "organisation" not "organization"
- Do NOT reference property listings, inspections, or real estate terminology

Response format: Write the complete message body only. No subject line. No markdown formatting. Always write a complete, natural message — do not stop mid-sentence.`;
}

const LEAD_TYPE_INSTRUCTIONS = {
  buyer: `This is a BUYER lead. Tailor your response to:
- Acknowledge their property search goals and budget if mentioned
- Ask 1-2 qualifying questions about budget range, pre-approval status, and purchase timeline
- Mention you can send them a tailored property shortlist
- Suggest booking an inspection or a discovery call`,

  renter: `This is a RENTER lead. Tailor your response to:
- Acknowledge what they're looking to rent and any requirements mentioned
- Ask about their preferred move-in date, lease term preference, and rental budget
- Mention current availability and that you can send matching listings
- Offer to book inspection times at their convenience`,

  seller: `This is a SELLER lead. Tailor your response to:
- Acknowledge their interest in selling and the property if mentioned
- Mention that the market is active and that timing can make a big difference
- Offer a free market appraisal and comparable sales report
- Ask about their ideal selling timeline and whether they've had the property appraised recently`,

  landlord: `This is a LANDLORD lead. Tailor your response to:
- Acknowledge their property and interest in property management services
- Highlight that you handle everything — tenant screening, inspections, rent collection, maintenance
- Mention the rental yield potential in the current market
- Offer a free rental appraisal and a no-obligation management proposal`
};

// Job-type context for trade enquiries — used instead of LEAD_TYPE_INSTRUCTIONS for non-RE
const TRADE_JOB_INSTRUCTIONS = `This is a trade job enquiry. Tailor your response to:
- Acknowledge the specific job or problem they've described
- Confirm you service their area (suburb) if mentioned
- Propose a clear next step: arrange a site visit, confirm a time, or ask one quick clarifying question if needed
- Keep it conversational and action-oriented — don't pad with unnecessary details`;

// RE Agent routing context — for property managers/landlords sending work to tradies
const RE_AGENT_JOB_INSTRUCTIONS = `This is a property maintenance or trade referral request from a real estate contact (landlord, property manager, or tenant). Tailor your response to:
- Acknowledge the specific maintenance job or trade needed
- Confirm you can source the right tradesperson for the job
- Ask one quick clarifying question if the scope is unclear (e.g. urgency, access, property type)
- Reassure them the job will be handled promptly with a trusted local tradie
- Keep it professional and efficient — these contacts value reliability above all`;

function getSystemPrompt(leadType, agentName, agencyName, businessType) {
  const bt = businessType || 'real_estate';
  const base = buildBasePrompt(agentName, agencyName, bt);

  if (bt === 'real_estate') {
    const typeKey = leadType ? leadType.toLowerCase() : null;
    const typeInstruction = LEAD_TYPE_INSTRUCTIONS[typeKey] ||
      `Ask 1-2 qualifying questions (budget range, timeline, pre-approval status) and suggest a next step (inspection, call, property list).`;
    return `${base}\n\nLEAD TYPE CONTEXT:\n${typeInstruction}`;
  }

  // RE Agent pool — property maintenance routing context
  if (bt === 're_agent') {
    return `${base}\n\nJOB ENQUIRY CONTEXT:\n${RE_AGENT_JOB_INSTRUCTIONS}`;
  }

  // All other trade operators — use generic job enquiry context
  return `${base}\n\nJOB ENQUIRY CONTEXT:\n${TRADE_JOB_INSTRUCTIONS}`;
}

/**
 * Check if the response appears to be complete (not truncated mid-sentence).
 *
 * A valid response may end with a sign-off block like:
 *   Warm regards,
 *   Gassin maddin
 *   Gassin123
 *
 * So we strip trailing sign-off lines before checking for sentence-ending
 * punctuation in the email body itself.
 *
 * Since the Similar Listing feature, responses may end with a URL before
 * the sign-off. URLs are valid endings (not truncation).
 */
function isResponseComplete(text) {
  if (!text || text.length < 80) return false;
  const trimmed = text.trim();

  // Strip a trailing sign-off block (salutation line + 1-3 name/agency/title lines)
  // Common salutations: "Warm regards,", "Kind regards,", "Best regards,",
  // "Cheers,", "Thanks,", "Many thanks,", "Best wishes,"
  // Supports up to 3 trailing lines after the salutation (name, agency, title)
  const signOffPattern = /\n\s*(warm regards|kind regards|best regards|regards|cheers|thanks|many thanks|best wishes|sincerely|best),?\s*(\n[^\n]+){1,3}\s*$/i;
  const bodyOnly = trimmed.replace(signOffPattern, '').trim();

  // Check the body (or the full text if no sign-off was stripped)
  const textToCheck = bodyOnly || trimmed;

  // A valid response can end with:
  // 1. Sentence-ending punctuation (.!?)
  // 2. A URL (from similar listing upsell)
  const endsWithPunctuation = /[.!?]$/.test(textToCheck);
  const endsWithUrl = /https?:\/\/[^\s]+$/.test(textToCheck);
  const sentenceCount = (textToCheck.match(/[.!?]/g) || []).length;

  return (endsWithPunctuation || endsWithUrl) && sentenceCount >= 2;
}

/**
 * Generate a professional template response when AI is unavailable.
 * Adapts tone and style based on business_type.
 */
function generateTemplateResponse(lead, agentName, agencyName, similarListing, businessType) {
  const firstName = lead.name ? lead.name.split(' ')[0] : 'there';
  const signOff = buildSignOff(agentName, agencyName);
  const bt = businessType || 'real_estate';
  const config = getTradeConfig(bt);

  // ── RE Agent fallback template ───────────────────────────────────────────
  if (bt === 're_agent') {
    const jobRef    = lead.job_type || lead.property_interest || 'the maintenance job';
    const suburbRef = lead.suburb ? ` at ${lead.suburb}` : '';

    return `Hi ${firstName},

Thanks for reaching out about ${jobRef}${suburbRef}. We'll get the right tradie on this for you straight away.

Can you confirm the urgency and any access details we need to know? We'll have someone in touch shortly.

${config.signOff}
${signOff}`;
  }

  // ── Trade fallback template ──────────────────────────────────────────────
  if (bt !== 'real_estate') {
    const jobRef   = lead.job_type || lead.property_interest || 'your enquiry';
    const suburbRef = lead.suburb ? ` in ${lead.suburb}` : '';

    return `Hi ${firstName},

Thanks for getting in touch about ${jobRef}${suburbRef}. We'd love to help out.

Can you let us know when you're available for us to come by and take a look? We'll get back to you with a quote once we've seen the job.

${config.signOff}
${signOff}`;
  }

  // ── Real estate fallback templates (unchanged) ───────────────────────────
  const propertyRef = lead.property_interest
    ? `your enquiry about ${lead.property_interest}`
    : 'your property enquiry';
  const leadType = lead.lead_type ? lead.lead_type.toLowerCase() : null;
  const listingLine = lead.property_listing_url
    ? `\nHere's the property listing for your reference: ${lead.property_listing_url}\n`
    : '';

  // Build similar listing upsell line
  let similarLine = '';
  if (similarListing) {
    const simDesc = similarListing.address
      || (similarListing.suburb ? `${similarListing.suburb}${similarListing.state ? ', ' + similarListing.state : ''}` : null)
      || 'another property';
    const simType = similarListing.property_type ? ` ${similarListing.property_type}` : '';
    similarLine = `\nYou might also be interested in this${simType} we have available${simDesc !== 'another property' ? ` in ${simDesc}` : ''}: ${similarListing.listing_url}\n`;
  }

  if (leadType === 'seller') {
    return `Hi ${firstName},

Thanks for reaching out about selling your property. We'd love to help you achieve the best possible outcome in the current market.

To get started, it would be helpful to know your ideal selling timeline and whether you've had a recent appraisal done. Our team can provide a free, no-obligation market appraisal and a comparable sales report for your area.

We'll be in touch shortly to arrange a time that suits you. Feel free to call us anytime if you'd like to chat sooner.

Warm regards,
${signOff}`;
  }

  if (leadType === 'landlord') {
    return `Hi ${firstName},

Thanks for reaching out about property management services. We'd love to take the stress out of managing your investment property.

Our team handles everything from tenant screening and inspections to rent collection and maintenance. We'd be happy to provide a free rental appraisal and a no-obligation management proposal so you can see exactly what we offer.

We'll be in touch shortly to discuss your property. Feel free to call us anytime if you'd prefer to chat sooner.

Warm regards,
${signOff}`;
  }

  if (leadType === 'renter') {
    return `Hi ${firstName},

Thanks for reaching out about ${propertyRef}. We'd love to help you find the perfect rental property.
${listingLine}
To match you with the right listings, it would be helpful to know your preferred move-in date and lease term. We have some great options available right now and can arrange inspection times at your convenience.
${similarLine}
We'll be in touch shortly with some suitable listings. Feel free to call us anytime if you'd like to chat sooner.

Warm regards,
${signOff}`;
  }

  // Default / buyer template
  return `Hi ${firstName},

Thanks for reaching out to us about ${propertyRef}. We'd love to help you find the perfect property.
${listingLine}
To get started, it would be helpful to know a bit more — what's your preferred timeline for moving, and have you been pre-approved for finance? This helps us shortlist the best options for you.
${similarLine}
We'll be in touch shortly to arrange an inspection or send through a tailored property list. Feel free to call us anytime if you'd like to chat sooner.

Warm regards,
${signOff}`;
}

/** Pause execution for `ms` milliseconds */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Detect proxy evaluation metadata that leaked into the response */
function looksLikeMetadata(text) {
  const patterns = [
    /word count:/i,
    /^\s*\*\s*\*/m,
    /^words:/i,
    /\(Good\)/i,
    /\(Bad\)/i,
    /^rating:/im,
    /^score:/im,
    /^evaluation:/im,
    /^quality:/im,
    /^assessment:/im,
  ];
  return patterns.some(p => p.test(text));
}

/**
 * Attempt a single AI call. Returns the trimmed response text or throws.
 * Uses streaming to avoid proxy truncation of non-streaming responses.
 */
async function callAI(messages, attempt) {
  // Use streaming — the proxy may truncate non-streaming responses but
  // pass through stream chunks correctly (different code path).
  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    max_tokens: 600,
    temperature: 0.7 + (attempt - 1) * 0.05, // slight variation per retry
    stream: true,
  });

  let content = '';
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) content += delta;
  }
  return content.trim();
}

function buildUserMessage(lead, similarListing = null) {
  const parts = [`New lead inquiry received:`];

  if (lead.name) parts.push(`Name: ${lead.name}`);
  if (lead.email) parts.push(`Email: ${lead.email}`);
  if (lead.phone) parts.push(`Phone: ${lead.phone}`);
  if (lead.lead_type) parts.push(`Lead Type: ${lead.lead_type.charAt(0).toUpperCase() + lead.lead_type.slice(1)}`);
  if (lead.property_interest) parts.push(`Property Interest: ${lead.property_interest}`);
  if (lead.property_listing_url) parts.push(`Property Listing URL: ${lead.property_listing_url}`);
  if (lead.source) parts.push(`Source: ${lead.source}`);
  if (lead.notes) parts.push(`Additional Notes: ${lead.notes}`);

  // Inject similar listing context if available
  if (similarListing) {
    const simDesc = [
      similarListing.address || `${similarListing.suburb || ''} ${similarListing.state || ''}`.trim() || 'another property',
      similarListing.property_type ? `(${similarListing.property_type})` : '',
      similarListing.price_range ? `— ${similarListing.price_range}` : '',
    ].filter(Boolean).join(' ');
    parts.push(`\nSimilar Listing Available: ${simDesc} — ${similarListing.listing_url}`);
    parts.push(`(Mention this naturally near the end of your response as an additional option for the lead)`);
  }

  parts.push(`\nGenerate a personalized response to this lead. Be specific to their property interest and lead type if provided.`);

  return parts.join('\n');
}

/**
 * Build the user message for a trade job enquiry.
 * Maps job fields to the format expected by the AI prompt.
 */
function buildJobUserMessage(job) {
  const parts = [`New job enquiry received:`];

  if (job.customer_name)    parts.push(`Name: ${job.customer_name}`);
  if (job.customer_email)   parts.push(`Email: ${job.customer_email}`);
  if (job.customer_phone)   parts.push(`Phone: ${job.customer_phone}`);
  if (job.job_type)         parts.push(`Job Type: ${job.job_type}`);
  if (job.suburb)           parts.push(`Suburb: ${job.suburb}`);
  if (job.source)           parts.push(`Enquiry Source: ${job.source}`);
  if (job.job_description)  parts.push(`Customer Message: ${job.job_description}`);

  parts.push(`\nGenerate a personalised response to this job enquiry. Be specific to the job type and suburb if provided.`);

  return parts.join('\n');
}

/**
 * Generate a personalized AI response for a lead inquiry.
 * Retries up to 3 times with streaming before falling back to template.
 * Automatically fetches the agent's name and business_type from the users table.
 */
async function generateLeadResponse(lead) {
  // Gate: skip AI responses if subscription is suspended or grace period has expired
  const canGenerate = await checkCanGenerateResponse();
  if (!canGenerate) {
    console.warn('[AI Responder] Subscription suspended — skipping AI response for lead', lead.id);
    throw new Error('Subscription suspended — AI lead responses are disabled');
  }

  const { agentName, agencyName, businessType } = await getAgentProfile(lead.user_id);

  // Fetch a similar listing from the pool (non-blocking — null if none found or error)
  // Only relevant for RE operators
  let similarListing = null;
  if (businessType === 'real_estate') {
    try {
      similarListing = await getSimilarListing(lead);
      if (similarListing) {
        console.log(`[AI Responder] Similar listing found: ${similarListing.suburb || 'unknown suburb'} — ${similarListing.listing_url}`);
      }
    } catch (err) {
      console.warn('[AI Responder] getSimilarListing failed (non-fatal):', err.message);
    }
  }

  const userMessage = buildUserMessage(lead, similarListing);
  const systemPrompt = getSystemPrompt(lead.lead_type, agentName, agencyName, businessType);

  const MAX_ATTEMPTS = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // On retries, reinforce the prompt to request a complete email
      const userMsg = attempt > 1
        ? userMessage + '\n\nIMPORTANT: Write the COMPLETE email response from greeting through sign-off. Do not stop after the greeting line.'
        : userMessage;

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ];

      const responseText = await callAI(messages, attempt);

      console.log(`[AI Responder] Attempt ${attempt}: received ${responseText.length} chars`);

      // --- Validation ---

      // 1. Length check
      if (!responseText || responseText.length < 80) {
        lastError = new Error(`Response too short (${responseText?.length || 0} chars): "${responseText}"`);
        console.warn(`[AI Responder] Attempt ${attempt} rejected — ${lastError.message}`);
        if (attempt < MAX_ATTEMPTS) { await sleep(400 * attempt); continue; }
        throw lastError;
      }

      // 2. Metadata / evaluation output check
      if (looksLikeMetadata(responseText)) {
        lastError = new Error(`Metadata detected: "${responseText.substring(0, 120)}"`);
        console.warn(`[AI Responder] Attempt ${attempt} rejected — ${lastError.message}`);
        if (attempt < MAX_ATTEMPTS) { await sleep(400 * attempt); continue; }
        throw lastError;
      }

      // 3. Completeness check (ends with punctuation, ≥2 sentences)
      if (!isResponseComplete(responseText)) {
        lastError = new Error(`Truncated: "${responseText.substring(0, 150)}"`);
        console.warn(`[AI Responder] Attempt ${attempt} rejected — ${lastError.message}`);
        if (attempt < MAX_ATTEMPTS) { await sleep(400 * attempt); continue; }
        throw lastError;
      }

      // --- Success ---
      // Estimate tokens from char count (streaming doesn't always return usage)
      const estInputTokens = Math.ceil((systemPrompt.length + userMsg.length) / 4);
      const estOutputTokens = Math.ceil(responseText.length / 4);
      const totalCost = (estInputTokens * 0.00000015) + (estOutputTokens * 0.0000006);

      console.log(`[AI Responder] Success on attempt ${attempt}: ${responseText.length} chars, ~${estOutputTokens} tokens, lead_type: ${lead.lead_type || 'unspecified'}, business_type: ${businessType}, agent: ${buildSignOff(agentName, agencyName)}`);

      return {
        responseText,
        model: 'gpt-4o-mini',
        costUsd: totalCost,
        tokens: { input: estInputTokens, output: estOutputTokens },
      };

    } catch (error) {
      lastError = error;
      console.warn(`[AI Responder] Attempt ${attempt} failed: ${error.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(400 * attempt);
        continue;
      }
    }
  }

  // All attempts exhausted — fall back to professional template
  console.error(`[AI Responder] All ${MAX_ATTEMPTS} attempts failed (last: ${lastError?.message}). Using template fallback.`);
  const templateText = generateTemplateResponse(lead, agentName, agencyName, similarListing, businessType);
  return {
    responseText: templateText,
    model: 'template-fallback',
    costUsd: 0,
    tokens: { input: 0, output: 0 },
  };
}

/**
 * Generate a personalized AI response for a trade job enquiry.
 * Called from POST /api/jobs/simulate (and can be used for any job).
 * Fetches the agent's profile using job.agent_id.
 */
async function generateJobResponse(job) {
  const { agentName, agencyName, businessType } = await getAgentProfile(job.agent_id);

  // Use the job's business_type if available (most reliable), fall back to profile
  const bt = job.business_type || businessType || 'plumber';

  const userMessage = buildJobUserMessage(job);
  const systemPrompt = getSystemPrompt(null, agentName, agencyName, bt);

  const MAX_ATTEMPTS = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const userMsg = attempt > 1
        ? userMessage + '\n\nIMPORTANT: Write the COMPLETE message from greeting through sign-off. Do not stop early.'
        : userMessage;

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ];

      const responseText = await callAI(messages, attempt);

      console.log(`[AI Responder] Job attempt ${attempt}: received ${responseText.length} chars`);

      // Length check
      if (!responseText || responseText.length < 60) {
        lastError = new Error(`Response too short (${responseText?.length || 0} chars)`);
        if (attempt < MAX_ATTEMPTS) { await sleep(400 * attempt); continue; }
        throw lastError;
      }

      // Metadata check
      if (looksLikeMetadata(responseText)) {
        lastError = new Error(`Metadata detected`);
        if (attempt < MAX_ATTEMPTS) { await sleep(400 * attempt); continue; }
        throw lastError;
      }

      // Completeness check
      if (!isResponseComplete(responseText)) {
        lastError = new Error(`Truncated response`);
        if (attempt < MAX_ATTEMPTS) { await sleep(400 * attempt); continue; }
        throw lastError;
      }

      const estInputTokens = Math.ceil((systemPrompt.length + userMsg.length) / 4);
      const estOutputTokens = Math.ceil(responseText.length / 4);
      const totalCost = (estInputTokens * 0.00000015) + (estOutputTokens * 0.0000006);

      console.log(`[AI Responder] Job response success: ${responseText.length} chars, business_type: ${bt}, agent: ${buildSignOff(agentName, agencyName)}`);

      return {
        responseText,
        model: 'gpt-4o-mini',
        costUsd: totalCost,
        tokens: { input: estInputTokens, output: estOutputTokens },
      };

    } catch (error) {
      lastError = error;
      console.warn(`[AI Responder] Job attempt ${attempt} failed: ${error.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(400 * attempt);
        continue;
      }
    }
  }

  // Fall back to trade template
  console.error(`[AI Responder] All ${MAX_ATTEMPTS} job attempts failed. Using template fallback.`);
  const templateText = generateTemplateResponse(
    { name: job.customer_name, job_type: job.job_type, suburb: job.suburb },
    agentName, agencyName, null, bt
  );
  return {
    responseText: templateText,
    model: 'template-fallback',
    costUsd: 0,
    tokens: { input: 0, output: 0 },
  };
}

module.exports = { generateLeadResponse, generateJobResponse };
