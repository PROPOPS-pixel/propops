/**
 * Trade Simulation Service
 *
 * Provides trade-specific lead generation for Hugo training simulations.
 * Ensures simulations only generate leads appropriate to the target trade pool
 * (no cross-trade contamination).
 */

// ── Authoritative 26 Trade Categories ─────────────────────────────────────────
// This is the SINGLE SOURCE OF TRUTH for all valid trade types.
// 22 original trades + 4 Batch 5 additions = 26 total.
// Any code that needs to validate a trade type should reference this list.
const AUTHORITATIVE_TRADES = [
  'plumber',            // 1
  'electrician',        // 2
  'roofer',             // 3
  'pest_control',       // 4
  'glazier',            // 5
  'fencer',             // 6
  'concreter',          // 7
  'plasterer',          // 8
  'tiler',              // 9
  'carpenter',          // 10
  'builder',            // 11
  'renderer',           // 12
  'waterproofer',       // 13
  'hvac',               // 14
  'pool_tech',          // 15
  'handyman',           // 16
  'antenna_installer',  // 17
  'refrigeration',      // 18
  'solar_installer',    // 19
  'painter',            // 20
  'cleaner',            // 21
  'landscaper',         // 22
  // Batch 5
  'appliance_repair',   // 23
  'locksmith',          // 24
  'removalist',         // 25
  're_agent',           // 26 — routes to referral network, not direct jobs
  // Batch 6
  'bricklayer',         // 27
];

// ── Legacy alias map ──────────────────────────────────────────────────────────
// Maps legacy/deprecated business_type values (stored in DB) to their
// authoritative trade key. This fixes the routing bug where operators with
// legacy DB values (e.g. "lawn_care") would silently fall back to "handyman".
const TRADE_ALIASES = {
  lawn_care:          'landscaper',
  pool_cleaning:      'pool_tech',
  carpet_cleaning:    'cleaner',
  commercial_cleaner: 'cleaner',
  real_estate:        'real_estate', // separate mode — kept as-is
};

/**
 * Normalize a business_type value to its authoritative trade key.
 * Resolves legacy aliases, logs when a remap occurs.
 * Falls back to 'handyman' ONLY if the value is completely unknown.
 */
function normalizeBusinessType(bt) {
  if (!bt) {
    console.log('[Trade Simulation] ⚠️ No business_type provided, defaulting to handyman');
    return 'handyman';
  }

  const normalized = bt.trim().toLowerCase();

  // Direct match against authoritative list
  if (AUTHORITATIVE_TRADES.includes(normalized)) {
    return normalized;
  }

  // Check alias map
  if (TRADE_ALIASES[normalized]) {
    console.log(`[Trade Simulation] 🔄 Alias remap: '${normalized}' → '${TRADE_ALIASES[normalized]}'`);
    return TRADE_ALIASES[normalized];
  }

  // Unknown type — log loudly and fall back
  console.log(`[Trade Simulation] ❌ UNKNOWN business_type '${bt}' — falling back to handyman. This should be added to AUTHORITATIVE_TRADES or TRADE_ALIASES.`);
  return 'handyman';
}

const SIMULATE_JOB_TYPES = {
  plumber:               ['Blocked drain', 'Leaking tap', 'Hot water system fault', 'Burst pipe', 'Toilet repair', 'Gas fitting', 'Pipe relining', 'Backflow testing', 'Bathroom renovation plumbing', 'Leak detection', 'Hot water unit install', 'Sewer blockage', 'Gas hot water conversion', 'Roof/gutter plumbing', 'Water meter fault', 'Shower recess install', 'Cistern repair', 'Kitchen sink plumbing'],
  electrician:           ['Safety switch tripping', 'Power point installation', 'Switchboard upgrade', 'LED downlight install', 'Fault finding', 'Ceiling fan install', 'Smoke alarm install', 'Data cable run', 'Power outage investigation', 'EV charger install', 'Solar panel electrical', 'Light fitting install', 'Rewiring (partial)', 'Outdoor lighting', 'RCD replacement', 'Underground cable fault', 'Three-phase power upgrade'],
  cleaner:               ['End of lease clean', 'Spring clean', 'Weekly maintenance clean', 'Office clean', 'Carpet clean', 'Window clean', 'Oven clean', 'Pressure wash'],
  landscaper:            ['Lawn mowing + edging', 'Garden design', 'Retaining wall', 'Irrigation system', 'Tree removal', 'Turf laying', 'Mulching', 'Hedge trimming'],
  painter:               ['Interior repaint', 'Exterior repaint', 'Feature wall', 'Deck stain', 'Touch-up repairs', 'Roof paint', 'Garage door paint', 'Fence staining'],
  carpenter:             ['Deck build', 'Pergola construction', 'Door installation', 'Custom shelving', 'Wardrobe build', 'Staircase repair', 'Timber frame repair', 'Disability ramp', 'Restumping/levelling', 'Custom joinery', 'Structural beam repair', 'French door install', 'Bifold door install', 'Outdoor timber decking repair', 'Built-in study fitout'],
  handyman:              ['Flat pack assembly', 'TV wall mount', 'Door repair', 'Shelf install', 'Minor painting', 'Caulking/gap fill', 'Picture hanging', 'General repairs', 'Tap washer replacement', 'Mirror hanging'],
  bricklayer:            ['Brick fence (new)', 'Brick fence repair/repoint', 'Retaining wall (brick)', 'Garden wall build', 'Extension brickwork', 'Letterbox pillar', 'Boundary wall', 'Block wall build', 'Repointing/mortar repair', 'Feature brick wall (interior)'],
  glazier:               ['Window replacement', 'Glass repair', 'Mirror installation', 'Shower screen install', 'Splashback install', 'Double glazing upgrade', 'Security screen install', 'Glass balustrade', 'Frameless shower door', 'Fly screen repair', 'Window reglazing', 'Obscure glass install', 'Bifold door glass', 'Stacker door glass', 'Commercial glazing'],
  concreter:             ['Driveway pour', 'Patio/alfresco slab', 'Exposed aggregate driveway', 'Pool surrounds', 'Footpath/path pour', 'Concrete cutting/removal', 'Footing pour', 'Stencil concrete', 'Shed slab pour', 'Retaining wall footing', 'Decorative concrete', 'Concrete path extension', 'Driveway reseal/coat', 'Crossover pour', 'Concrete repair/patching'],
  renderer:              ['Acrylic render (external)', 'Cement render (external)', 'Texture coating', 'Render repair and patch', 'Coloured render', 'Restore old render', 'Modern render finish', 'Multi-coat render system', 'Feature wall render (internal)', 'Pool surround render', 'Sand and cement render', 'Bagging and paint', 'Render over brick', 'Two-coat acrylic system', 'Render crack repair'],
  plasterer:             ['New plaster walls', 'Plaster repair/patch', 'Cornice install', 'Ceiling plaster', 'Internal renovation plaster', 'Plaster skim coat', 'Ceiling hole repair', 'Water damage plaster repair', 'Drywall install', 'Set plaster (wet areas)', 'Cornice replacement', 'Heritage plaster repair', 'Commercial fit-out plastering', 'Dust-free plaster patch', 'Feature wall plaster'],
  tiler:                 ['Bathroom tile full', 'Kitchen splashback', 'Floor tile (laundry)', 'Outdoor paving', 'Pool coping', 'Tile repair/replacement', 'Grout regrout', 'Shower screed', 'Bathroom floor waterproofing + tile', 'Wall tiling (full bathroom)', 'Mosaic tile work', 'Outdoor entertaining area tiles', 'Grout re-sealing', 'Tile removal + replacement', 'Large format floor tiles'],
  roofer:                ['Roof restoration', 'Leak repair', 'Gutter replacement', 'Tile replacement', 'Metal re-roof (Colorbond)', 'Skylight install', 'Downpipe install', 'Fascia/soffit repair', 'Pointing/repointing', 'Gutter clean', 'Storm damage repair', 'Ridge capping repair', 'Roof inspection', 'Sarking/insulation', 'Valley replacement', 'Hip and ridge rebed', 'Roof painting'],
  fencer:                ['Colorbond fence new', 'Timber paling fence', 'Pool fence compliance', 'Retaining + fence combo', 'Gate install', 'Fence repair', 'Privacy screen', 'Slat fence', 'Glass pool fence', 'Rural fencing', 'Fence painting', 'Lapped and capped fence', 'Post replacement', 'Dividing fence (neighbour dispute)', 'Fence extension (height increase)'],
  waterproofer:          ['Bathroom waterproofing', 'Balcony waterproofing', 'Roof deck waterproofing', 'Planter box waterproofing', 'Shower recess waterproofing', 'Swimming pool waterproofing', 'Tank waterproofing', 'Commercial membrane system', 'Wet area membrane (new build)', 'Leaking shower repair', 'Basement and subfloor tanking', 'External retaining wall waterproofing', 'Terrace waterproofing', 'Podium deck membrane', 'Remedial waterproofing'],
  pool_tech:             ['Weekly pool service', 'Green pool recovery', 'Filter clean/replace', 'Pump repair', 'Acid wash', 'Solar heating repair', 'Valve repair', 'Water balance/testing'],
  pest_control:          ['Termite inspection', 'Termite treatment (chemical barrier)', 'Cockroach treatment', 'Ant treatment', 'Bed bug treatment', 'Rat/mice control', 'Spider treatment', 'Flea treatment', 'General pest spray', 'Possum removal', 'Wasp nest removal', 'Silverfish treatment', 'Pre-purchase pest inspection', 'Bird proofing', 'End of lease pest treatment', 'Borer treatment'],
  antenna_installer:     ['TV antenna install', 'Signal booster install', 'TV point add', 'Antenna repair', 'Digital tuning', 'Wall plate install', 'Amplifier install', 'Mast installation'],
  refrigeration:         ['Fridge repair', 'Freezer repair', 'Cool room service', 'Split system fridge repair', 'Commercial refrigeration', 'Fridge regas', 'Thermostat repair', 'Cold room install'],
  solar_installer:       ['Solar panel install', 'Inverter replacement', 'Battery storage install', 'Solar panel upgrade', 'Energy audit', 'Off-grid system', 'EV charger install', 'Solar system health check'],
  real_estate:           ['New listing maintenance', 'Tenant move-out repairs', 'Pre-sale presentation', 'Landlord upgrade', 'Renovation referral', 'Routine maintenance'],
  appliance_repair:      ['Fridge repair', 'Washing machine repair', 'Dryer repair', 'Dishwasher repair', 'Oven/cooktop repair', 'Rangehood repair', 'Microwave repair', 'Air purifier repair', 'Dishwasher install', 'Washing machine install', 'Dryer not heating', 'Fridge not cooling', 'Oven element replacement', 'Washing machine not spinning'],
  locksmith:             ['Lockout emergency', 'Lock repair', 'Rekey', 'Key cutting', 'Master key system', 'Security door install', 'Safe opening', 'Safe repair', 'Automotive lockout', 'Door lock upgrade', 'Deadbolt install', 'Key duplication', 'Lock cylinder replacement', 'Electronic lock install', 'Garage door lock repair'],
  removalist:            ['House move', 'Office move', 'Furniture removal', 'Storage solution', 'Piano move', 'Interstate move', 'Partial pack/move', 'Auction pickup', 'Furniture delivery', 'Packing service', 'Unpacking service', 'Single item move', 'End of lease move', 'Student move'],
  re_agent:              ['New listing maintenance', 'Tenant move-out', 'Pre-sale presentation', 'Landlord upgrade', 'Renovation referral', 'Routine maintenance', 'New purchase reno', 'Commercial property maintenance'],
  builder:               ['Home extension', 'Full house renovation', 'Bathroom renovation', 'Kitchen renovation', 'Commercial fit-out', 'Structural alterations', 'Granny flat build', 'Project management', 'Garage conversion', 'New home construction', 'Knockdown rebuild', 'Internal wall removal', 'Second storey addition', 'Underpinning and restumping', 'Outdoor entertaining area'],
  hvac:                  ['Ducted AC installation', 'Split system supply and install', 'Split system service and repair', 'Gas heating repair', 'Aircon not cooling', 'Refrigerated cooling system', 'Ventilation system install', 'Commercial HVAC service', 'Duct cleaning', 'Evaporative cooler service', 'Thermostat replacement', 'Zoned climate control', 'AC gas recharge', 'Cassette unit install', 'HVAC planned maintenance'],
};

// Trade-specific realistic inquiry messages for simulation
const TRADE_INQUIRIES = {
  plumber: [
    (suburb, jobType) => `Hi, I've got a ${jobType.toLowerCase()} at my place in ${suburb}. Water's been backing up in the kitchen sink for the past 2 days and I've tried everything with a plunger. Can you send someone to take a look? Need it sorted ASAP.`,
    (suburb, jobType) => `G'day, we have a ${jobType.toLowerCase()} at our house in ${suburb}. The hot water hasn't been working properly for the last week and the cold tap is running fine. Looking for a licensed plumber to sort it out. Can you give me a quote?`,
    (suburb, jobType) => `Hi there, need a plumber for a ${jobType.toLowerCase()} in ${suburb}. We're selling the house in a month and want to get it sorted before the inspection. Budget around $500. When can you get here?`,
    (suburb, jobType) => `Hello, we have an emergency ${jobType.toLowerCase()} at our property in ${suburb}. Water's leaking from under the sink and we've got water everywhere. Can someone come out today? Happy to pay extra for after-hours callout.`,
    (suburb, jobType) => `Hey, looking to get a ${jobType.toLowerCase()} done at our rental in ${suburb}. Property manager said to arrange it myself and get reimbursed. Can you do it and send me the invoice?`,
    (suburb, jobType) => `Hi, we've got a burst pipe in the laundry wall in ${suburb}. Water is pouring through. We've turned off the mains but need someone urgently. Are you available today?`,
    (suburb, jobType) => `G'day, our hot water system in ${suburb} has completely given out — it's about 12 years old. Looking at either a new gas unit or maybe going electric. Can someone come and give us our options and a price?`,
    (suburb, jobType) => `Hi there, need gas fitting work done in ${suburb}. We're adding a gas BBQ point and a gas heater outlet to our alfresco area. Need a licensed gas fitter. Can you quote?`,
    (suburb, jobType) => `Hello, I've noticed damp patches appearing on the wall in our bathroom in ${suburb}. Suspect there's a leak behind the wall. Can you do leak detection and give me a quote to fix it?`,
    (suburb, jobType) => `Hey, doing a bathroom renovation in ${suburb} and need a plumber to rough-in the new layout — relocating the toilet and adding a double vanity. Can you come and quote on the plumbing roughs?`,
  ],
  electrician: [
    (suburb, jobType) => `Hi, I've got a ${jobType.toLowerCase()} that needs doing at my home in ${suburb}. The safety switch keeps tripping and I've reset it a few times but it keeps going. Can you send someone to check it out?`,
    (suburb, jobType) => `G'day, need an electrician for ${jobType.toLowerCase()} in ${suburb}. We're renovating and need some extra power points installed in the kitchen. How much would that cost?`,
    (suburb, jobType) => `Hi there, the ${jobType.toLowerCase()} at our place in ${suburb} stopped working yesterday. Flickering lights in the lounge room. Need someone licensed to come take a look. Can you book me in?`,
    (suburb, jobType) => `Hello, we need ${jobType.toLowerCase()} at our office in ${suburb}. Emergency lighting isn't working properly and we need it fixed for compliance. Can someone come this week?`,
    (suburb, jobType) => `Hi, looking for a sparky to do a ${jobType.toLowerCase()} in ${suburb}. We're moving into a new place and the switchboard looks old and dangerous. Can you quote us on an upgrade?`,
    (suburb, jobType) => `G'day, I'm building a new deck at my place in ${suburb} and need power run out there — a couple of weatherproof GPOs and some downlights under the pergola. Can you give me a quote?`,
    (suburb, jobType) => `Hi there, we've just bought an EV and need a charger installed at our home in ${suburb}. Just want a standard 7kW wall charger in the garage. How much to supply and install?`,
    (suburb, jobType) => `Hello, power went out in half our house in ${suburb} last night. Main switchboard breaker keeps tripping. I've turned off everything but it keeps going. Need a sparky today if possible.`,
    (suburb, jobType) => `Hi, I need 6 LED downlights installed in our lounge room in ${suburb}. Currently just a single pendant in the middle. Can you quote on supply and install of the fittings?`,
    (suburb, jobType) => `G'day, we're renovating our kitchen in ${suburb} and need the old cloth-wired circuits replaced. Electrician said the old wiring's a fire risk. Can you quote on rewiring the kitchen circuits?`,
  ],
  painter: [
    (suburb, jobType) => `Hi, I need a painter for a ${jobType.toLowerCase()} in ${suburb}. The walls in our living room are looking tired and we want to sell in a few months so need to get it done. Can you give me a quote for a 3-bedroom house?`,
    (suburb, jobType) => `G'day, we want to get a ${jobType.toLowerCase()} done at our place in ${suburb}. The weatherboards are starting to peel and it's letting in moisture. Can you come and assess? We need it done before winter.`,
    (suburb, jobType) => `Hi there, need a painter for a ${jobType.toLowerCase()} in ${suburb}. We've just moved in and the whole interior needs redoing. It's a 4-bedroom home. What's your rate per room and how long would it take?`,
    (suburb, jobType) => `Hello, looking to get a ${jobType.toLowerCase()} done on our deck in ${suburb}. The timber's gone grey and we're going to have a party in 3 weeks. Can you fit us in?`,
    (suburb, jobType) => `Hey, we need a ${jobType.toLowerCase()} at our investment property in ${suburb}. Tenant moved out and we need it looking good for the new tenant. How much to do the whole interior?`,
  ],
  bricklayer: [
    (suburb, jobType) => `Hi, I'm looking to get a brick fence built along my front boundary in ${suburb}. It would be roughly 15m long and about 1.8m high. Just want a standard single brick fence with rendered finish. Can you come out and give me a quote?`,
    (suburb, jobType) => `G'day, I need a retaining wall built at the back of my yard in ${suburb}. The site slopes down about 1.2m over 10 metres. Currently just a timber sleeper wall that's rotting out. Happy for brick or besser block, whichever is better for the job. When can someone come take a look?`,
    (suburb, jobType) => `Hi there, I need a brick letterbox pillar and low front garden wall built at my place in ${suburb}. The wall would be maybe 800mm high and 8m long across the front. Just a feature garden wall, not structural. Can you give me a rough idea of cost?`,
    (suburb, jobType) => `I've got a gap in my side brick fence that needs repairing in ${suburb} — looks like the mortar has crumbled and about 2m of the wall needs repointing, possibly some bricks replaced. Not urgent but want it sorted before it gets worse. Can you quote?`,
    (suburb, jobType) => `Looking for a bricklayer to lay brickwork for a garage extension in ${suburb}. Slab is already down — just need the walls put up. Single skin brick veneer, roughly 6m x 4m footprint so four walls. Standard clay brick. Can you come and look?`,
    (suburb, jobType) => `Hi, we want a brick BBQ built in our alfresco area in ${suburb}. Looking at a freestanding brick structure with a built-in grill, benchtop each side and a pizza oven alcove if possible. Can you design and price something like that?`,
    (suburb, jobType) => `G'day, the mortar on our old double-brick home in ${suburb} needs repointing — it's a 1960s house and the joints are crumbling in a few sections. We're thinking of getting the whole front facade done while we're at it. Can you come and assess and quote?`,
    (suburb, jobType) => `Hi there, we're building a new block wall along our side boundary in ${suburb}. We want a besser block wall about 1.8m high and 18m long, rendered on both sides. Neighbour has already agreed to split the cost. Can you quote on supply and build?`,
    (suburb, jobType) => `Hello, I need a decorative feature wall built in our living room in ${suburb}. Thinking exposed brick or a limewash finish — about 4m wide by 2.7m high. Can you lay new brick over the existing plasterboard wall? Or is there a better way to do it?`,
    (suburb, jobType) => `Hey, our old brick steps at the front of the house in ${suburb} are crumbling — two of the five treads are breaking apart and it's become a safety issue. Can you repair or replace just the damaged treads, keeping the same brick style? Or would a full rebuild be better value?`,
    (suburb, jobType) => `Hi, we need a brick retaining wall at the front of our property in ${suburb} — council has required a structural engineer's report which we now have. The wall is 900mm high and about 12m long. Can you quote based on the engineer's drawings? I can send them through.`,
    (suburb, jobType) => `G'day, I need a garden wall built around a raised garden bed in ${suburb}. It's a raised planter in the backyard — roughly 4m x 2m footprint and 600mm high. Want recycled brick to match the existing house brick. Can you source matching bricks and give us a price?`,
  ],
  carpenter: [
    (suburb, jobType) => `Hi, I need a deck built at my property in ${suburb}. It's a ground-level hardwood deck off the back of the house — roughly 6m x 4m. The old deck has been demolished already. Can you quote on supply and install of a hardwood or treated pine deck?`,
    (suburb, jobType) => `G'day, we want a pergola built over our patio in ${suburb}. Looking at a freestanding timber pergola, about 5m x 4m with a pitched roof. Not sure on roofing material yet — maybe polycarbonate or Colorbond. Can you quote?`,
    (suburb, jobType) => `Hi there, our front door frame in ${suburb} has been damaged — looks like the timber is rotten at the bottom and the door doesn't close properly. Can a carpenter repair the frame or does it need full replacement? We want to keep the original solid timber door.`,
    (suburb, jobType) => `Hello, we need a custom built-in wardrobe in our master bedroom in ${suburb}. Space is 3.2m wide, floor to ceiling. Want a combination of hanging, shelving, and drawers. Can you quote on a painted MDF fitout?`,
    (suburb, jobType) => `Hey, we need a disability ramp installed at a property in ${suburb}. Elderly parent coming to live with us and the front entrance has two steps. Ramp needs to comply with AS 1428.1. Can you design and build a compliant timber ramp?`,
    (suburb, jobType) => `Hi, we need restumping at our house in ${suburb}. The property is an old Queenslander and several timber stumps have rotted. About 12 stumps need replacing. Is this something you'd quote on, or do we need a specialist?`,
    (suburb, jobType) => `G'day, I'm after some custom joinery for a study renovation in ${suburb}. Want a full wall of built-in bookshelves with a built-in desk, all in painted MDF. Study is about 3.5m wide. Can you measure up and quote?`,
    (suburb, jobType) => `Hi there, we have a structural timber beam in our kitchen ceiling in ${suburb} that a pest inspector said has borer damage. About 4m long. Can a carpenter assess whether it needs replacement or can it be treated and reinforced?`,
    (suburb, jobType) => `Hello, I need a bifold door installed at my place in ${suburb}. Currently a large opening between the living room and outdoor area. Opening is 3m wide. Want a 4-panel timber bifold with clear glass panels. Can you supply and install?`,
    (suburb, jobType) => `Hey, several deck boards on our back deck in ${suburb} have rotted through — it's a safety issue. There are about 10 boards over two sections. Can you replace just those boards or does the whole deck need assessing? Deck is treated pine.`,
    (suburb, jobType) => `Hi, we're converting our garage into a home office in ${suburb} and need a carpenter for the internal fitout — stud wall, plasterboard, a built-in desk unit and storage. Can you come and discuss the scope and give us a quote?`,
    (suburb, jobType) => `G'day, I need a custom outdoor kitchen cabinet built on our alfresco in ${suburb}. Weather-resistant timber or hardwood, space for a built-in BBQ, fridge, and sink. About 3m wide overall. Can you quote on supply and build?`,
  ],
  handyman: [
    (suburb, jobType) => `Hi, I need help with a ${jobType.toLowerCase()} at my unit in ${suburb}. I've tried to do it myself but it's beyond me. Can someone come and sort it out?`,
    (suburb, jobType) => `G'day, need a handyman for a ${jobType.toLowerCase()} in ${suburb}. Some general repairs around the house that need doing before I rent it out. Small jobs but want them done properly.`,
    (suburb, jobType) => `Hi there, we have a ${jobType.toLowerCase()} that needs doing in ${suburb}. Can you send someone who's available this week? Happy to pay cash for the work.`,
    (suburb, jobType) => `Hello, I bought some furniture that's flat pack and I need a ${jobType.toLowerCase()} in ${suburb}. Can you come and put it together for me?`,
    (suburb, jobType) => `Hey, need help with ${jobType.toLowerCase()} at my place in ${suburb}. I'm not handy and don't want to make it worse. Can someone come help?`,
  ],
  glazier: [
    (suburb, jobType) => `Hi, I need a glazier for a ${jobType.toLowerCase()} at my place in ${suburb}. One of the bedroom windows has a crack right across it — probably from a stone off the lawn mower. Can you come and replace the pane?`,
    (suburb, jobType) => `G'day, we need a ${jobType.toLowerCase()} done in ${suburb}. Our shower screen has completely shattered — safety glass everywhere. Can someone come today or tomorrow? We've got small kids in the house.`,
    (suburb, jobType) => `Hi there, I'm looking to get a ${jobType.toLowerCase()} installed in ${suburb}. We're doing up the kitchen and want a frameless glass splashback behind the cooktop. What do you charge per m²? The area is roughly 900mm x 900mm.`,
    (suburb, jobType) => `Hello, I need a ${jobType.toLowerCase()} quote in ${suburb}. We have single-pane windows throughout and want to upgrade to double glazing for the noise. It's a 3-bedroom house. What's involved?`,
    (suburb, jobType) => `Hey, our glass balustrade on the deck in ${suburb} has a panel that's cracked. We're having people over next weekend so need it sorted urgently. Can you come and measure up and quote a replacement?`,
    (suburb, jobType) => `Hi, I've got a broken window at my rental in ${suburb}. Tenant says a ball went through it. It's a standard aluminium frame single pane, about 600mm x 900mm. Can you come and replace it quickly?`,
    (suburb, jobType) => `G'day, I need a frameless shower door installed at my property in ${suburb}. We're renovating the ensuite and the shower area is 900mm wide. Can you do frameless or semi-frameless? What's the price difference?`,
    (suburb, jobType) => `Hi there, we need security screens fitted to several windows in our home in ${suburb}. We've had a break-in attempt and want aluminium mesh security screens on all ground floor windows. Can you quote the whole house?`,
    (suburb, jobType) => `Hello, I need a mirror installed in our newly renovated bathroom in ${suburb}. We want a large 1200mm x 900mm frameless mirror above the vanity. Can you supply and install?`,
    (suburb, jobType) => `Hey, our fly screens are all torn and bent in ${suburb}. We've got about 8 windows and 2 sliding doors that need new screens. Can you come and measure and replace them all? Happy to get it all done at once.`,
    (suburb, jobType) => `Hi, I need a ${jobType.toLowerCase()} in ${suburb}. The window in our lounge room is fogged up between the panes — double glazed unit has failed. Can you replace just the glass unit or does the whole frame need to go?`,
    (suburb, jobType) => `G'day, we're looking at getting a glass pool fence installed at our property in ${suburb}. It's about 12 lineal metres around the pool area. Council compliance required. Can you come and measure and quote?`,
  ],
  fencer: [
    (suburb, jobType) => `Hi, I need a new Colorbond fence along my back boundary in ${suburb}. About 25 metres long and I want 1.8m height for privacy. Neighbours have an old timber fence on the other side — do I need to deal with them first? Can you come and quote?`,
    (suburb, jobType) => `G'day, our old timber paling fence in ${suburb} got knocked down in the storm last week. Need it replaced along the whole side — about 15m. Can someone get out here this week? The neighbours are getting antsy.`,
    (suburb, jobType) => `Hi there, we need a pool fence installed at our property in ${suburb}. Just bought the house and the pool barrier doesn't meet compliance — council inspector said we have 30 days to fix it. What does pool fencing compliance involve and can you quote?`,
    (suburb, jobType) => `Hello, need a fence repair in ${suburb}. About 4 Colorbond panels got damaged and one gate post is leaning badly after the storm. Can you assess what needs doing — fix or full section replacement?`,
    (suburb, jobType) => `Hey, we're looking to get a glass pool fence in ${suburb}. We want it frameless to keep the view to the yard. Pool is about 10m x 5m — probably 30 lineal metres of fencing. What do you charge?`,
    (suburb, jobType) => `Hi, we want a timber slat fence installed for privacy along our back deck in ${suburb}. The neighbour's second storey looks straight at us. About 8m long and 2m high. Can you supply and install treated pine slats?`,
    (suburb, jobType) => `G'day, I need a gate installed in my Colorbond fence in ${suburb}. I want a double driveway gate — motorised if possible — in the side fence. The opening is about 2.7m wide. Can you quote on supply, install and automation?`,
    (suburb, jobType) => `Hi there, I'm building a new home in ${suburb} and need a full fencing quote — front boundary, both sides, and the back. Standard Colorbond all round. The block is 600sqm. Can you come out and measure?`,
    (suburb, jobType) => `Hello, we've got a dividing fence issue in ${suburb}. My neighbour and I have agreed to replace the old timber fence but we can't agree on who pays what. If we both commission you together can you do a shared quote for a new Colorbond fence?`,
    (suburb, jobType) => `Hey, need some post replacement on our front timber fence in ${suburb}. Three posts are rotting at the base and the fence is leaning. Can you replace just the posts or will the fence panels need replacing too?`,
    (suburb, jobType) => `Hi, I need a rural fencing quote for a small hobby farm in ${suburb}. Looking at about 200m of plain wire + star pickets around the paddock perimeter. Can you price that up?`,
    (suburb, jobType) => `G'day, we want to increase our fence height for privacy in ${suburb}. Currently have a 1.5m Colorbond fence and want to extend it to 1.8m. Can that be done by adding height extensions to the existing posts?`,
  ],
  landscaper: [
    (suburb, jobType) => `Hi, I need help with ${jobType.toLowerCase()} at my place in ${suburb}. The backyard is a mess after the floods. Can someone come and sort it out?`,
    (suburb, jobType) => `G'day, we're after a ${jobType.toLowerCase()} in ${suburb}. We want a proper garden design, not just turf. Can someone help with the design and installation?`,
    (suburb, jobType) => `Hi there, need a ${jobType.toLowerCase()} for a retaining wall in ${suburb}. The existing timber wall has rotted and we need it replaced. Concrete sleepers preferred.`,
    (suburb, jobType) => `Hello, we need ${jobType.toLowerCase()} every fortnight at our property in ${suburb}. Regular mowing, edging, and blow-around. Can you give us a quote for ongoing maintenance?`,
    (suburb, jobType) => `Hey, we have a large ${jobType.toLowerCase()} that needs doing in ${suburb}. There are several mature trees that need trimming. Can you send someone with the right equipment?`,
  ],
  cleaner: [
    (suburb, jobType) => `Hi, I need a ${jobType.toLowerCase()} at my place in ${suburb}. Moving out next week and need the bond back. Can you fit me in this week?`,
    (suburb, jobType) => `G'day, we're after a ${jobType.toLowerCase()} for our home in ${suburb}. It's a 5-bedroom house and we want everything spotless. Can you do a deep clean?`,
    (suburb, jobType) => `Hi there, need ${jobType.toLowerCase()} done at our office in ${suburb}. About 300sqm of commercial space. How much per visit for weekly cleaning?`,
    (suburb, jobType) => `Hello, we need a ${jobType.toLowerCase()} in ${suburb}. The carpets are filthy and we have a function in 2 weeks. Can you do carpet cleaning and general clean before then?`,
    (suburb, jobType) => `Hey, need a ${jobType.toLowerCase()} for our rental property in ${suburb}. Tenant has moved out and the property manager wants it professional clean before the next tenant moves in.`,
  ],
  tiler: [
    (suburb, jobType) => `Hi, I need a full bathroom renovation tiling quote in ${suburb}. We're gutting the main bathroom — it's about 8m². Want floor to ceiling tiles in the shower and feature wall tiles. Can you come and look at the space?`,
    (suburb, jobType) => `G'day, we're doing a kitchen renovation in ${suburb} and want a glass tile splashback behind the cooktop. Area is roughly 900mm x 900mm. Can you supply and install? Happy for you to suggest a tile that works well.`,
    (suburb, jobType) => `Hi there, the grout in our shower in ${suburb} is black and mouldy — has been for years. Can you regrout the whole shower? It's a standard 900mm x 900mm shower recess. Can we do that without retiling?`,
    (suburb, jobType) => `Hello, we need outdoor paving tiles laid on our alfresco area in ${suburb}. About 40m². Concrete slab is already down. Want a 600x600 travertine-look porcelain tile. Can you supply and lay?`,
    (suburb, jobType) => `Hey, we have a few cracked tiles in the main bathroom in ${suburb} — three floor tiles near the shower and one wall tile. Can you source matching replacements and do the repairs? The existing tiles are white subway tiles.`,
    (suburb, jobType) => `Hi, I need waterproofing and tiling done in a new bathroom in ${suburb}. The wet areas need to be properly waterproofed before tiles go on. Shower is about 6m², floor is 5m². Can you do the waterproofing membrane + tiling as one job?`,
    (suburb, jobType) => `G'day, we want floor tiles in our laundry in ${suburb}. Currently vinyl that's lifting. About 6m² of floor. Want something durable and easy to clean — maybe a matte porcelain tile. Can you rip up the vinyl and tile over the concrete?`,
    (suburb, jobType) => `Hi there, I need a mosaic tile feature done in our new ensuite in ${suburb}. Main tiles are already selected but we want a mosaic strip in the shower as a feature. About 2m long and 300mm wide. Can you do a tile-within-tile inset?`,
    (suburb, jobType) => `Hello, we need to retile the pool coping in ${suburb}. The existing coping tiles are lifting and cracking — safety hazard. Pool is 8m x 4m. What do you use for pool coping? What's the rough cost?`,
    (suburb, jobType) => `Hey, we're doing a full bathroom renovation in ${suburb} and need floor to ceiling tiling throughout — shower, floor, and three walls. Room is 9m². Can you quote on just the tiling, as we have a builder doing the fitout?`,
    (suburb, jobType) => `Hi, the tile sealer on our outdoor patio in ${suburb} has worn off and the tiles are staining. About 25m² of external porcelain pavers. Can you clean and re-seal them? Or would you recommend regrouting first?`,
    (suburb, jobType) => `G'day, we have large format 1200x600 tiles that we bought for our living room floor in ${suburb}. About 45m² of floor area. Can you install these over an existing concrete slab? What prep work is needed for large format tiles?`,
  ],
  concreter: [
    (suburb, jobType) => `Hi, I need a ${jobType.toLowerCase()} done in ${suburb}. Looking to do our front driveway — roughly 45sqm. Currently just grass. Can you come and quote? Interested in either plain or exposed aggregate.`,
    (suburb, jobType) => `G'day, we want to pour a concrete patio at the back of our house in ${suburb}. About 35sqm under a new pergola. Needs to be level with the back door. Can someone come and quote?`,
    (suburb, jobType) => `Hi there, the concrete driveway at my property in ${suburb} is cracking badly and sinking in places — probably 15 years old. Want it broken out and replaced with exposed aggregate. About 50sqm. Can you assess and quote?`,
    (suburb, jobType) => `Hello, we're building a shed in ${suburb} and need a concrete slab — 7m x 5m. Needs to be 100mm thick with mesh. Can you quote on supply and pour including formwork?`,
    (suburb, jobType) => `Hey, I need footings poured for an extension at my place in ${suburb}. Engineer has done the plans — just need a concretor to form up and pour. About 25 lineal metres of strip footing 600mm deep x 400mm wide. Can you price that?`,
    (suburb, jobType) => `Hi, we want a decorative concrete path through our garden in ${suburb}. About 12m long and 1m wide, with a stencilled pattern. Can you do coloured/stencil concrete?`,
    (suburb, jobType) => `G'day, our pool surrounds in ${suburb} need replacing. The old concrete is cracked and slippery. About 30sqm around the pool edge. Looking at exposed aggregate for the non-slip texture. Can you quote?`,
    (suburb, jobType) => `Hi there, I need concrete cutting and removal in ${suburb}. We're putting in a new stormwater drain and need a 600mm wide trench cut through an existing 80mm concrete driveway. About 8m long. Can you do the cut and excavation?`,
    (suburb, jobType) => `Hello, we're putting in a new crossover and driveway in ${suburb}. Council has approved the crossover — just need the concreting done. Crossover is about 3m wide and the driveway to the carport is 15m. Can you quote the whole job?`,
    (suburb, jobType) => `Hey, need a concrete path poured along the side of our house in ${suburb}. About 20m long and 1.2m wide. Currently just dirt and it gets muddy in winter. Can you quote on a standard 75mm concrete path?`,
    (suburb, jobType) => `Hi, we have some concrete repairs needed in ${suburb}. The front steps have heaved and cracked — three steps, about 2m wide. Can you break out the old steps and repour? Or is there a repair option?`,
    (suburb, jobType) => `G'day, we want a stencil concrete driveway in ${suburb}. Old brick pavers are lifting everywhere. Area is about 60sqm. Want a cobblestone stencil pattern in a sandstone colour. Can you quote on supply and lay including removal of the pavers?`,
  ],
  roofer: [
    (suburb, jobType) => `Hi, I've got a ${jobType.toLowerCase()} needed at my place in ${suburb}. There's a leak in the ceiling somewhere and it's coming through when it rains. Can someone come out?`,
    (suburb, jobType) => `G'day, we need a ${jobType.toLowerCase()} done in ${suburb}. Some tiles have cracked in the recent storms. Can someone assess the damage and fix it?`,
    (suburb, jobType) => `Hi there, need to get the ${jobType.toLowerCase()} done at our rental in ${suburb}. Gutters are full of leaves and water is overflowing into the garden. Tenant has raised it with us.`,
    (suburb, jobType) => `Hello, we're looking at a full ${jobType.toLowerCase()} in ${suburb}. The roof is 25 years old and leaking in multiple spots. Can someone come and do a proper inspection and quote?`,
    (suburb, jobType) => `Hey, need a ${jobType.toLowerCase()} in ${suburb}. Re-roofing with Colorbond. It's a 200sqm hip and ridge roof. Can you give us a quote?`,
    (suburb, jobType) => `Hi, we had a massive hail storm hit ${suburb} last week and several tiles have cracked or slipped. Need someone to come up and check the whole roof and repair what's damaged.`,
    (suburb, jobType) => `G'day, the pointing on our terracotta tiled roof in ${suburb} is crumbling — it's been about 15 years since it was done. Need repointing before it causes a leak. Can you quote?`,
    (suburb, jobType) => `Hi there, we want a skylight installed in our hallway in ${suburb} — it's dark and we want natural light. Looking at a 1000x1000 fixed skylight. Can you come and quote on supply and install?`,
    (suburb, jobType) => `Hello, our fascia boards and gutters along the back of our house in ${suburb} are rotting and need replacement. About 12m run. Can you quote on new fascias and quad gutters?`,
    (suburb, jobType) => `Hey, need a full ${jobType.toLowerCase()} on our investment property in ${suburb}. Want to restore the terracotta tiles — clean, repoint, replace broken ones and seal. Can someone come and look?`,
  ],
  renderer: [
    (suburb, jobType) => `Hi, I need ${jobType.toLowerCase()} done at my place in ${suburb}. Want to render the whole exterior — it's a double brick home, about 250m² of wall area. Bricks are original and we want a smooth modern look. Can you come and quote?`,
    (suburb, jobType) => `G'day, we want ${jobType.toLowerCase()} on our new extension in ${suburb}. The extension is rendered but the existing house is face brick — we want the whole exterior to match. About 120m² total. Can you give us options and a price?`,
    (suburb, jobType) => `Hi there, need ${jobType.toLowerCase()} for our external walls in ${suburb}. There's been water damage and the render is cracking badly in several spots. Not sure if it needs a full redo or just targeted repairs. Can you come and assess?`,
    (suburb, jobType) => `Hello, looking for ${jobType.toLowerCase()} in ${suburb}. We want a coloured render on the front of the house — grey tones to match the new aluminium windows. Can you do a coloured acrylic system with a fine texture? What colours can you supply?`,
    (suburb, jobType) => `Hey, we need ${jobType.toLowerCase()} done in ${suburb}. The old cement render is 20+ years old and has blown off in patches. We're thinking of just re-rendering the whole exterior rather than patching. What would that involve?`,
    (suburb, jobType) => `Hi, I've got a feature wall in our lounge room in ${suburb} that needs ${jobType.toLowerCase()}. We want a smooth trowelled finish as a feature — about 4m x 2.8m. Can you do an internal render finish that's ready for paint?`,
    (suburb, jobType) => `G'day, we're doing a full exterior repaint in ${suburb} and the renderer said some areas need re-rendering first. It's cracked around the window frames and along the base of one wall. Can you quote on the render repairs before we paint?`,
    (suburb, jobType) => `Hi there, I need ${jobType.toLowerCase()} on my pool surrounds in ${suburb}. The render around the pool edge is spalling and discoloured. About 40 lineal metres of coping and plinth. Can you waterproof and re-render it?`,
    (suburb, jobType) => `Hello, we're building a new home in ${suburb} and the builder has left the exterior brick for us to finish. We want a two-coat acrylic render system — about 350m². Can you quote on the full job from scratch coat to top coat?`,
    (suburb, jobType) => `Hey, our rendered townhouse in ${suburb} needs the render restored — it hasn't been done in 15 years and there's moss, staining, and some cracks. It's about 180m² of external render. Can you clean, repair, and recoat it?`,
  ],
  plasterer: [
    (suburb, jobType) => `Hi, I need a plasterer in ${suburb}. There's a hole about 300mm wide in the ceiling where the air con was installed by a previous owner — never patched. Can you come and fix it? Want it invisible once painted.`,
    (suburb, jobType) => `G'day, we've had a water leak from the bathroom above that's damaged the ceiling below in ${suburb}. The plaster has bubbled and come away in a section about 1m x 1m. Leak is fixed — just need the plaster work done. Can you quote?`,
    (suburb, jobType) => `Hi there, we've just bought a house in ${suburb} and want to replace all the old cornice before we paint. Standard 75mm cove cornice throughout — about 80 lineal metres total. Can you give me a price?`,
    (suburb, jobType) => `Hello, we're renovating and need a plasterer for the new walls in ${suburb}. Builders have framed up two new rooms and we need the plasterboard hung and set — about 60m² of wall and ceiling. Can you quote on set plaster finish?`,
    (suburb, jobType) => `Hey, need a skim coat over the walls in our lounge room in ${suburb}. The textured finish is old and rough and we want smooth walls before repainting. Room is about 35m² of walls. Can you set coat over the existing plaster?`,
    (suburb, jobType) => `Hi, I have a heritage-style home in ${suburb} with original ornate cornice in the formal rooms. One section about 4m has cracked and fallen away. Can you do heritage plaster repair to match the existing profile?`,
    (suburb, jobType) => `G'day, need dry wall installed in a garage conversion in ${suburb}. We're turning a double garage into a rumpus room — stud frames are up and we need plasterboard linings, set and ready to paint. About 80m² total. Can you quote?`,
    (suburb, jobType) => `Hi there, we're doing a dust-free plaster repair at our investment property in ${suburb} — it's tenanted and we don't want mess. Just a couple of holes from old wall fixings and some hairline cracks. Can you patch these up minimising dust?`,
    (suburb, jobType) => `Hello, the whole kitchen ceiling in our home in ${suburb} needs replastering. The existing surface is uneven and cracked — an old fibrous sheet ceiling. We want it replaced with new plasterboard and set. About 18m². Can you give us a quote?`,
    (suburb, jobType) => `Hey, we need set plaster on the bathroom and laundry walls in ${suburb}. Water damage from an old leak has made the walls rough and patchy. We want a smooth flush finish before tiling. About 12m² total. Can you quote on a set plaster ready for tiles?`,
    (suburb, jobType) => `Hi, doing a commercial office fit-out in ${suburb} and need a plasterer for the internal partition walls — plasterboard both sides, set and sand ready for paint. About 150m² of wall space. Can you quote? Project starts in 2 weeks.`,
    (suburb, jobType) => `G'day, we need plaster repairs in a water-damaged bedroom ceiling in ${suburb}. The roof has been fixed but there's a bulging section of ceiling about 600mm x 800mm that needs cutting out and replastering. Can you come and assess?`,
  ],
  solar_installer: [
    (suburb, jobType) => `Hi, I'm looking at getting ${jobType.toLowerCase()} done at my place in ${suburb}. Want to reduce our electricity bills. Can someone come and do an assessment?`,
    (suburb, jobType) => `G'day, our ${jobType.toLowerCase()} needs replacing in ${suburb}. It's 8 years old and failing. Can you quote on a replacement?`,
    (suburb, jobType) => `Hi there, interested in ${jobType.toLowerCase()} in ${suburb}. Have a 4kW system now but want to add more panels. Can you design an upgrade?`,
    (suburb, jobType) => `Hello, we want ${jobType.toLowerCase()} for our new home in ${suburb}. Building now and want to include solar in the design.`,
    (suburb, jobType) => `Hey, need a ${jobType.toLowerCase()} in ${suburb}. Our battery is dead and we want to add more storage capacity. Can you quote?`,
  ],
  pool_tech: [
    (suburb, jobType) => `Hi, I need ${jobType.toLowerCase()} done at my place in ${suburb}. Pool's gone green and the pump is making a weird noise. Can someone come out ASAP?`,
    (suburb, jobType) => `G'day, we want regular ${jobType.toLowerCase()} at our property in ${suburb}. Weekly service during summer, fortnightly in winter. Can you give us a quote?`,
    (suburb, jobType) => `Hi there, our ${jobType.toLowerCase()} needs doing in ${suburb}. The sand filter needs backwashing and the chlorine levels are all wrong.`,
    (suburb, jobType) => `Hello, need ${jobType.toLowerCase()} in ${suburb}. Pool heating isn't working — solar panels on the roof look old. Can you check it out?`,
    (suburb, jobType) => `Hey, our pool in ${suburb} has gone murky and the acid wash was done 6 months ago. Need another treatment. Can you help?`,
  ],
  pest_control: [
    (suburb, jobType) => `Hi, I need ${jobType.toLowerCase()} done at my place in ${suburb}. Found what looks like termite tracks in the skirting boards in the garage. Can someone come out urgently? We bought the house 6 months ago.`,
    (suburb, jobType) => `G'day, we've got cockroaches everywhere in the kitchen in ${suburb}. Tried the spray from Bunnings but they keep coming back. Need a proper professional treatment. Can you book me in?`,
    (suburb, jobType) => `Hi there, need ${jobType.toLowerCase()} in ${suburb}. Just bought a house and the building inspection found evidence of mice in the roof cavity. Need it sorted before we move in next week.`,
    (suburb, jobType) => `Hello, we have a ${jobType.toLowerCase()} issue in ${suburb}. Our dog brought fleas in from the park and now the whole house is infested — carpets, lounge, everything. Need treatment ASAP.`,
    (suburb, jobType) => `Hey, we need a ${jobType.toLowerCase()} treatment in ${suburb}. Found a couple of redbacks in the garden shed and we have young kids. Can you do a full external spray?`,
    (suburb, jobType) => `Hi, we're renting out our property in ${suburb} and the new tenants have just moved in. As part of our end-of-lease obligations we need a full pest treatment done. Can you issue a certificate?`,
    (suburb, jobType) => `G'day, we have rats getting into the ceiling of our home in ${suburb}. Can hear them at night. Need someone to bait, seal entry points, and sort it out. How much would that cost?`,
    (suburb, jobType) => `Hi there, we're buying a property in ${suburb} and need a pre-purchase pest and termite inspection for the bank. Can you do that quickly? Settlement is in 2 weeks.`,
    (suburb, jobType) => `Hello, got a wasp nest under the eave at the front of our house in ${suburb}. It's enormous and we can't use the front door. Can you come out today or tomorrow?`,
    (suburb, jobType) => `Hey, we've had ants getting into the kitchen and bathroom in our unit in ${suburb} for months. Every spring they come back. Need a proper treatment, not just surface spray. Can you help?`,
  ],
  antenna_installer: [
    (suburb, jobType) => `Hi, I need ${jobType.toLowerCase()} done in ${suburb}. TV signal is terrible — some channels pixelating and others not coming in at all.`,
    (suburb, jobType) => `G'day, need a ${jobType.toLowerCase()} in ${suburb}. Moving into a new area and need the antenna pointed correctly. Can you tune it?`,
    (suburb, jobType) => `Hi there, we want another ${jobType.toLowerCase()} in ${suburb}. TV in the bedroom isn't getting a signal. Can you run a cable?`,
    (suburb, jobType) => `Hello, need ${jobType.toLowerCase()} in ${suburb}. The signal booster we bought isn't working and we're getting no reception.`,
    (suburb, jobType) => `Hey, we need a ${jobType.toLowerCase()} in ${suburb}. TV antenna got damaged in the storm. Can you replace it?`,
  ],
  refrigeration: [
    (suburb, jobType) => `Hi, our fridge in ${suburb} isn't cooling properly. Food is going off. Can someone come and have a look at it?`,
    (suburb, jobType) => `G'day, need ${jobType.toLowerCase()} done in ${suburb}. Walk-in freezer at our cafe is not working and we have stock at risk.`,
    (suburb, jobType) => `Hi there, our ${jobType.toLowerCase()} needs regassing in ${suburb}. It's not cold enough and the compressor is running all the time.`,
    (suburb, jobType) => `Hello, need ${jobType.toLowerCase()} in ${suburb}. Got a cool room for our food storage that's not maintaining temperature.`,
    (suburb, jobType) => `Hey, we have a commercial ${jobType.toLowerCase()} issue in ${suburb}. Several fridges in our restaurant are failing. Can someone come urgently?`,
  ],
  waterproofer: [
    (suburb, jobType) => `Hi, I need ${jobType.toLowerCase()} in ${suburb}. Our upstairs bathroom is leaking through the floor into the room below — there are water stains on the ceiling. The bathroom is about 7m². Do you need to remove tiles to waterproof or can you do it over the top?`,
    (suburb, jobType) => `G'day, we're renovating our bathroom in ${suburb} and need a full ${jobType.toLowerCase()} before the tiles go in. It's a new shower recess and the wet area is about 5m². Builder says we need an AS 3740 compliant membrane. Can you do that and issue a certificate?`,
    (suburb, jobType) => `Hi there, we have a leaking balcony in ${suburb}. Water is getting into the room below during rain. The balcony is about 12m². Not sure if it's the membrane or the drainage. Can you come and assess and quote?`,
    (suburb, jobType) => `Hello, need ${jobType.toLowerCase()} in ${suburb}. Our basement floods every time it rains heavily — water is coming through the walls, not the floor. It's a double garage under a split-level house. Can you do subfloor tanking or external waterproofing? What's your recommended approach?`,
    (suburb, jobType) => `Hey, we have a leaking shower in ${suburb} that's been dripping into the hallway for months. The grout is crumbling and the seal around the base is gone. Can you repair the waterproofing without retiling? Or does it need to be a full redo?`,
    (suburb, jobType) => `Hi, our swimming pool in ${suburb} is losing water — about 5mm per day, which is more than evaporation. We want it inspected and waterproofed. It's a 10m x 4m tiled concrete pool about 15 years old. Can you quote on leak detection and sealing?`,
    (suburb, jobType) => `G'day, I need ${jobType.toLowerCase()} for a planter box on our rooftop terrace in ${suburb}. It's a raised garden bed built into the terrace — about 8m long and 600mm wide. It's been leaking into the apartment below. Can you waterproof the box?`,
    (suburb, jobType) => `Hi there, we have a commercial job in ${suburb} — a roof terrace on a 3-storey building that's leaking into the office below. The terrace is about 80m². We need a full membrane system installed. Do you do commercial waterproofing at that scale?`,
    (suburb, jobType) => `Hello, we're building a new home in ${suburb} and need ${jobType.toLowerCase()} in all wet areas before tiling — main bathroom, ensuite, laundry, and powder room. Total wet area is about 25m². What's your approach to new construction waterproofing?`,
    (suburb, jobType) => `Hey, our retaining wall in ${suburb} has water weeping through the face of it and the garden behind is saturated. The wall is brick, about 15m long and 1.2m high. Can you waterproof the back face and install proper drainage?`,
  ],
  real_estate: [
    (suburb, jobType) => `Hi, I manage a rental property in ${suburb} and need a tradie for ${jobType.toLowerCase()}. Tenant has just moved out and the property needs to be ready for the next tenant ASAP. Can you quote and get it done this week?`,
    (suburb, jobType) => `G'day, I'm a property manager and we need ${jobType.toLowerCase()} at one of our rentals in ${suburb}. Landlord has approved the work. Can you give me a quote and an availability date?`,
    (suburb, jobType) => `Hi there, I have a property in ${suburb} going to auction in 3 weeks and I need ${jobType.toLowerCase()} done before the open homes start. What's your turnaround?`,
    (suburb, jobType) => `Hello, this is regarding a ${jobType.toLowerCase()} at a tenanted property in ${suburb}. The tenant has raised the issue and we need a licensed tradesperson to attend. Can you confirm availability?`,
    (suburb, jobType) => `Hey, managing a portfolio of properties and we need ${jobType.toLowerCase()} at a property in ${suburb}. Routine maintenance — nothing major. Can you give us a rate card?`,
  ],
  appliance_repair: [
    (suburb, jobType) => `Hi, our ${jobType.toLowerCase()} has stopped working at our home in ${suburb}. It's only 4 years old — I'd rather repair than replace. Can someone come out and diagnose it? How much would a callout cost?`,
    (suburb, jobType) => `G'day, need someone to look at a ${jobType.toLowerCase()} in ${suburb}. It's making a loud grinding noise and not doing the job properly. Brand is Samsung. Is it worth repairing or should we replace it?`,
    (suburb, jobType) => `Hi there, our ${jobType.toLowerCase()} in ${suburb} broke down this morning and we've got a family of five. Really need it sorted quickly. Can you come today or tomorrow?`,
    (suburb, jobType) => `Hello, I have a ${jobType.toLowerCase()} issue at my rental in ${suburb}. Tenant has reported it's not working and I need to get it sorted before the weekend. Can you come and assess?`,
    (suburb, jobType) => `Hey, the ${jobType.toLowerCase()} at our place in ${suburb} has completely died — won't turn on at all. It's a Bosch, about 6 years old. Is it worth a repair quote or is it end of life?`,
    (suburb, jobType) => `Hi, we've had a ${jobType.toLowerCase()} fault in ${suburb}. The error code on the display is E4 and it stopped mid-cycle. Can someone diagnose it? We need it working again ASAP — it's our only fridge.`,
    (suburb, jobType) => `G'day, need a repair quote for a ${jobType.toLowerCase()} in ${suburb}. Water is leaking onto the kitchen floor — looks like it's coming from under the machine. Not sure if it's a hose or the seal. Can you come and check?`,
    (suburb, jobType) => `Hi there, our ${jobType.toLowerCase()} in ${suburb} is not heating properly. Takes twice as long as it used to and things are still damp. Is this usually a heating element issue? Can you diagnose and fix?`,
    (suburb, jobType) => `Hello, I've just moved into a place in ${suburb} and the ${jobType.toLowerCase()} that was left here isn't working. Don't know the history. Can someone come out, diagnose it, and tell me if it's repairable?`,
    (suburb, jobType) => `Hey, our ${jobType.toLowerCase()} in ${suburb} keeps tripping the safety switch when we turn it on. Something's clearly wrong electrically. Can a repair tech come out and check it safely? LG brand.`,
  ],
  locksmith: [
    (suburb, jobType) => `Hi, I'm locked out of my house in ${suburb} — left my keys inside and the spare key is at my sister's in another suburb. Can you get here in the next hour? Happy to pay urgent callout.`,
    (suburb, jobType) => `G'day, need a locksmith for ${jobType.toLowerCase()} in ${suburb}. We've just had a break-in attempt — they didn't get in but the lock is damaged. Want to upgrade the whole front door lock to something more secure. Can you come and quote?`,
    (suburb, jobType) => `Hi there, looking for a locksmith in ${suburb}. We're moving into a new house and I want to rekey all the locks — don't know how many copies of the keys were made by the previous owners. How much to rekey a 3-bedroom home?`,
    (suburb, jobType) => `Hello, I need ${jobType.toLowerCase()} done in ${suburb}. Our strata title has decided to implement a master key system for the building. 24 units. Can you design and install a master key system and supply copies for the owners corporation?`,
    (suburb, jobType) => `Hey, locked out of my car in ${suburb}. Keys locked in the boot. I'm a member of NRMA but they're 2 hours away. Can you come sooner? What's the charge for an automotive lockout?`,
    (suburb, jobType) => `Hi, I need a ${jobType.toLowerCase()} at my business premises in ${suburb}. We've had a staff member leave on bad terms and I need the locks changed on the front and back doors. How quickly can you come?`,
    (suburb, jobType) => `G'day, need key cutting in ${suburb}. I have the original key but need 4 copies made — one for each family member. Can you do this from the original key?`,
    (suburb, jobType) => `Hi there, I have a safe at my home in ${suburb} and I've forgotten the combination. It's an older dial safe, not electronic. Can a locksmith open it without damaging it? I have proof of ownership.`,
    (suburb, jobType) => `Hello, we're building a new home in ${suburb} and need a security door installed on the front entrance. Looking for something solid — steel mesh, good quality deadbolt. Can you supply and install and give us a few options?`,
    (suburb, jobType) => `Hey, need a deadbolt installed at my unit in ${suburb}. The existing door lock feels flimsy — just a basic knob lock. Want to add a proper deadbolt for security. Can you come and quote on what's possible with this door?`,
  ],
  removalist: [
    (suburb, jobType) => `Hi, we need a ${jobType.toLowerCase()} from ${suburb} to Parramatta. 3-bedroom house, lots of furniture. We'd want help with packing too if possible. What's your hourly rate and do you have trucks available next Saturday?`,
    (suburb, jobType) => `G'day, need a ${jobType.toLowerCase()} in ${suburb}. We're downsizing — moving from a 4-bedroom to a 2-bedroom unit. About half the furniture is going into storage and the rest is moving. Can you manage both the move and the storage drop-off?`,
    (suburb, jobType) => `Hi there, looking for a removalist for an ${jobType.toLowerCase()} from ${suburb}. Small office — just workstations, filing cabinets, and server rack. About 10 staff. Need to be done on a weekend to avoid downtime. Can you quote?`,
    (suburb, jobType) => `Hello, I need a single item moved — a grand piano from ${suburb} to Randwick. It's a full-size Steinway. I know this is specialised. Do you have piano specialists or is this a job you'd pass on?`,
    (suburb, jobType) => `Hey, we're doing an interstate move from ${suburb} to Brisbane. 3-bedroom house worth of furniture. We'd pack ourselves but need loading, transport, and unloading. What's the process and rough cost for interstate?`,
    (suburb, jobType) => `Hi, need removalists for a partial move in ${suburb}. We're not moving house — just need to move furniture from one room to another as part of a renovation. About 6 large pieces. Can you do a small half-day job?`,
    (suburb, jobType) => `G'day, I have some unwanted furniture in ${suburb} that I need removed and disposed of — not a house move, just getting rid of an old sofa, fridge, and a few boxes of stuff. Can you do furniture removal and disposal?`,
    (suburb, jobType) => `Hi there, I bought some furniture at an auction in ${suburb} and need it picked up and delivered to my home in Chatswood. It's a sideboard and two armchairs. Can you quote on an auction pickup and delivery?`,
    (suburb, jobType) => `Hello, we need a ${jobType.toLowerCase()} in ${suburb}. We're end of lease and need to be out by Friday. 2-bedroom apartment — don't have much furniture but we're under time pressure. Can you do a weekday move?`,
    (suburb, jobType) => `Hey, need packing help for our move from ${suburb}. We have 3 young kids and just can't manage the packing on top of everything else. Can you do a full pack service as well as the move? What's included in a full pack?`,
  ],
  re_agent: [
    (suburb, jobType) => `Hi, I'm a property manager in ${suburb} and I need tradies for ${jobType.toLowerCase()}. Tenant has vacated and the landlord wants the property rent-ready by next week. Can you coordinate the trades needed — cleaner, painter, carpet clean?`,
    (suburb, jobType) => `G'day, I manage several properties in the ${suburb} area and I'm looking for a reliable trades coordinator for ${jobType.toLowerCase()}. We need someone who can handle multiple jobs across our portfolio. Can we set up a rate card?`,
    (suburb, jobType) => `Hi there, I have a property listing in ${suburb} going live in 2 weeks and need ${jobType.toLowerCase()} done before the photography. Mainly painting touch-ups, a garden tidy, and steam cleaning. Can you pull together a quote for the full scope?`,
    (suburb, jobType) => `Hello, I represent a landlord in ${suburb} who wants to upgrade the property between tenancies — new flooring, fresh paint, update the kitchen benchtop. This is a ${jobType.toLowerCase()}. Can you manage the trades and give me a total project cost?`,
    (suburb, jobType) => `Hey, I've got a routine maintenance job at a rental in ${suburb} — ${jobType.toLowerCase()}. Tenant has lodged a maintenance request and the landlord has approved the work. Need a plumber and electrician. Can you coordinate and invoice the one job?`,
    (suburb, jobType) => `Hi, a tenant just moved out of our property in ${suburb} and there's significant repair work needed — ${jobType.toLowerCase()}. Walls need patching, a door frame is damaged, and the yard is a mess. Can you assess and coordinate the trades?`,
    (suburb, jobType) => `G'day, I'm a buyer's agent in ${suburb} and my client has just purchased a home and wants a ${jobType.toLowerCase()} before they move in — new kitchen, bathrooms refreshed, and a paint throughout. Can you project manage and source the trades?`,
    (suburb, jobType) => `Hi there, we manage a commercial property in ${suburb} that needs ${jobType.toLowerCase()}. It's a 300m² office suite between tenants. Needs carpet replacement, repainting, and electrical check. Can you coordinate all trades and provide one invoice?`,
  ],
  builder: [
    (suburb, jobType) => `Hi, we're looking to do a ${jobType.toLowerCase()} at our home in ${suburb}. We want to add a 40m² bedroom and living space off the back of the house. Single storey, slab-on-ground. We have plans drafted but need a licensed builder to quote and build. When can someone come out?`,
    (suburb, jobType) => `G'day, we want a ${jobType.toLowerCase()} done on our property in ${suburb}. The kitchen and bathrooms are 30 years old and need gutting and rebuilding. It's a 3-bedroom brick veneer home. Looking for a builder who can manage the whole project — demo, plumbing, electrical, tiling. Are you a full-service builder?`,
    (suburb, jobType) => `Hi there, we're planning a ${jobType.toLowerCase()} in ${suburb}. We want to convert our double garage into a self-contained granny flat for my parents — about 50m². Needs a kitchen, bathroom, living and bedroom. Does it need a DA or can we go complying development?`,
    (suburb, jobType) => `Hello, I need a quote for a ${jobType.toLowerCase()} at my place in ${suburb}. We want to do the whole house — new kitchen, two bathrooms, laundry, repaint, new flooring throughout. House is 180m², circa 1995. We'd want a fixed-price contract and a realistic timeline. Can you help?`,
    (suburb, jobType) => `Hey, looking for a builder for a ${jobType.toLowerCase()} in ${suburb}. We want to add a second storey — 3 bedrooms, a bathroom, and a study. Ground floor is brick, we'd expect a timber frame second storey. We have rough plans — can you help finalise them and give us a build cost?`,
    (suburb, jobType) => `Hi, we need a ${jobType.toLowerCase()} at our investment property in ${suburb}. It's a commercial tenancy — the new tenant wants the space fit out to their spec. About 200m² of office space, 3 private offices, kitchenette, and bathrooms. Can you manage the full commercial fit-out?`,
    (suburb, jobType) => `G'day, I need a builder for structural alterations at my place in ${suburb}. We want to remove the wall between the kitchen and lounge room. It may be load-bearing — we need an engineer's report and the builder to carry out the work including beam install. Can you manage that whole process?`,
    (suburb, jobType) => `Hi there, we want to build a granny flat in our backyard in ${suburb}. The block is 650m² so we should be fine under NSW CDC rules. We want a 60m² 1-bedroom standalone unit. Can you manage DA or CDC approval, construction, and all connections?`,
    (suburb, jobType) => `Hello, I'm after a project manager / builder for a renovation in ${suburb}. We have trades lined up — plumber, electrician, tiler — but we need someone to coordinate the project, manage sequencing, and handle the building permit. Are you comfortable taking on a PM-only role?`,
    (suburb, jobType) => `Hey, we're doing a kitchen renovation in ${suburb} and need a builder to do the structural and rough-in work — relocating one wall, new openings for windows, new plumbing rough-ins. Cabinetmaker is handling the joinery. Can you quote on the building work only?`,
  ],
  hvac: [
    (suburb, jobType) => `Hi, I need ${jobType.toLowerCase()} at my home in ${suburb}. We want a ducted system for the whole house — 4 bedrooms, living, lounge, and kitchen. Double brick construction. Looking at a quality brand like Daikin or Actron Air. Can you come and design the system and give us a quote?`,
    (suburb, jobType) => `G'day, our existing split system in ${suburb} isn't cooling properly — it's running constantly but the room is still warm. It's a 5kW Fujitsu about 8 years old. Can someone come and diagnose it? Could be gas, could be a filter issue — not sure.`,
    (suburb, jobType) => `Hi there, need ${jobType.toLowerCase()} done at our place in ${suburb}. We want a 6.5kW split system supplied and installed in the main bedroom. Happy for any of the top brands. What's your supply and install price?`,
    (suburb, jobType) => `Hello, our ducted gas heating in ${suburb} isn't working. The system turns on but the fan runs cold — no heat coming through the vents. It's about 12 years old. Can someone come and diagnose? We're heading into winter so it's urgent.`,
    (suburb, jobType) => `Hey, the aircon at our office in ${suburb} has stopped cooling. It's a cassette unit in the ceiling — Mitsubishi, about 3 years old. All the other units in the building are fine. Can someone come and fix it? We have about 20 staff who are boiling.`,
    (suburb, jobType) => `Hi, we want a refrigerated ducted system installed at our new home in ${suburb}. It's a 300m² two-storey house. We want reverse cycle refrigerated (not evaporative) — zoned so we can control upstairs and downstairs separately. Can you design and quote the system?`,
    (suburb, jobType) => `G'day, I need ventilation installed in our commercial kitchen in ${suburb}. The exhaust hood above the commercial stove needs to be connected to a proper rangehood and extraction system with make-up air. About 3m of stainless hood. Do you do commercial kitchen ventilation?`,
    (suburb, jobType) => `Hi there, we have a commercial building in ${suburb} with a centralised HVAC system that needs its annual service. It's a 4-storey office building with about 12 fan coil units. Do you hold commercial refrigeration and HVAC licences? Can you quote on annual maintenance?`,
    (suburb, jobType) => `Hello, we need the ducts cleaned at our home in ${suburb}. The system is 8 years old and we've never had it done. It's a ducted system with 8 outlets. We've noticed dust blowing out when the system starts. Can you do a duct clean with a before/after inspection?`,
    (suburb, jobType) => `Hey, our evaporative cooler in ${suburb} has been sitting unused all winter and now it's making a grinding noise. The pads haven't been replaced for 2 years either. Can you service it, replace the pads, and check the pump before summer hits?`,
  ],
};

// Fallback for trades without specific messages
const GENERIC_INQUIRIES = [
  (suburb, jobType) => `Hi, I need help with ${jobType.toLowerCase()} at my property in ${suburb}. Can you come and have a look?`,
  (suburb, jobType) => `G'day, need someone for a ${jobType.toLowerCase()} in ${suburb}. How much would you charge for that kind of work?`,
  (suburb, jobType) => `Hi there, looking for a tradie to do a ${jobType.toLowerCase()} in ${suburb}. Can you give me a quote?`,
  (suburb, jobType) => `Hello, we need ${jobType.toLowerCase()} at our place in ${suburb}. When are you available?`,
  (suburb, jobType) => `Hey, need a ${jobType.toLowerCase()} in ${suburb}. Can you come and assess the job first?`,
];

const SUBURBS = [
  'Surry Hills', 'Newtown', 'Paddington', 'Bondi', 'Manly', 'Parramatta', 'Chatswood', 'Cronulla',
  'Mosman', 'Castle Hill', 'Balmain', 'Hornsby', 'Penrith', 'Liverpool', 'Hurstville', 'Randwick',
  'St Kilda', 'Fitzroy', 'Richmond', 'Hawthorn', 'Glen Waverley', 'Dandenong', 'Frankston', 'Essendon',
  'New Farm', 'Fortitude Valley', 'Toowong', 'Nundah', 'Eight Mile Plains', 'Aspley', 'Indooroopilly',
  'Glenelg', 'Norwood', 'Prospect', 'Tea Tree Gully', 'Morphett Vale',
  'Subiaco', 'Fremantle', 'Joondalup', 'Rockingham', 'Armadale',
];

const TEST_NAMES = [
  'James Wilson', 'Sarah Chen', 'Michael Brown', 'Emma Davis', 'Liam Johnson', 'Olivia Smith',
  'Noah Taylor', 'Ava Martinez', 'Blake Henderson', 'Zoe Nguyen', 'Ethan Murphy', 'Chloe Thompson',
  'Jack Robertson', 'Mia Kowalski', 'Callum Fraser', 'Priya Sharma', "Daniel O'Brien", 'Hannah Lee',
  'Tom Caruso', 'Jessica Patel', 'Ryan Fitzgerald', 'Lucy Marsh', 'Nathan Vo', 'Grace Anderson',
];

const TRADE_PORTALS = {
  pool_tech:             ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral'],
  pest_control:          ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral'],
  antenna_installer:     ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Airtasker', 'manual', 'referral'],
  refrigeration:         ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral'],
  solar_installer:       ['hipages', 'SolarQuotes', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral'],
  handyman:              ['hipages', 'Airtasker', 'ServiceSeeking', 'Oneflare', 'Facebook', 'manual', 'referral'],
  glazier:               ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral', 'word of mouth'],
  bricklayer:            ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral', 'word of mouth'],
  concreter:             ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral'],
  renderer:              ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral'],
  plasterer:             ['hipages', 'ServiceSeeking', 'Oneflare', 'Airtasker', 'Facebook', 'manual', 'referral'],
  tiler:                 ['hipages', 'ServiceSeeking', 'Oneflare', 'Airtasker', 'Google Business Profile', 'Facebook', 'manual', 'referral'],
  roofer:                ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral'],
  fencer:                ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral'],
  waterproofer:          ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Airtasker', 'manual', 'referral'],
  builder:               ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Facebook', 'BuilderCracker', 'manual', 'referral', 'word of mouth'],
  hvac:                  ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Airtasker', 'Facebook', 'manual', 'referral'],
  appliance_repair:      ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral', 'word of mouth'],
  locksmith:             ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral'],
  removalist:            ['hipages', 'ServiceSeeking', 'Oneflare', 'Airtasker', 'Facebook', 'Google Business Profile', 'manual', 'referral'],
  re_agent:              ['referral', 'manual', 'word of mouth', 'hipages', 'ServiceSeeking', 'Google Business Profile'],
};
const DEFAULT_PORTALS = ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral'];

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Check if a job type matches the target trade.
 * Returns { valid: boolean, reason?: string }
 */
function validateLeadMatch(businessType, jobType) {
  const bt = normalizeBusinessType(businessType);
  const allowedTypes = SIMULATE_JOB_TYPES[bt] || SIMULATE_JOB_TYPES['handyman'];
  const normalizedJobType = (jobType || '').trim().toLowerCase();

  if (!allowedTypes.some(t => t.toLowerCase() === normalizedJobType)) {
    return {
      valid: false,
      reason: `Job type '${jobType}' not in ${businessType} pool. Allowed: ${allowedTypes.join(', ')}`,
    };
  }

  return { valid: true };
}

/**
 * Log a rejected lead mismatch.
 * @param {string} businessType - Target trade pool
 * @param {string} jobType - The mismatched job type
 * @param {string} reason - Why it was rejected
 * @param {string} source - Where the lead came from
 */
function logMismatch(businessType, jobType, reason, source = 'unknown') {
  console.log(`[Trade Simulation] ❌ REJECTED — business_type=${businessType}, job_type='${jobType}', source='${source}', reason='${reason}'`);
}

// ── Lead generation ──────────────────────────────────────────────────────────

function getJobTypes(businessType) {
  const bt = normalizeBusinessType(businessType);
  return SIMULATE_JOB_TYPES[bt] || SIMULATE_JOB_TYPES['handyman'];
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randPhone() {
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  return `04${randInt(10, 99)} ${randInt(100, 999)} ${randInt(100, 999)}`;
}

function generateCustomer() {
  const name = pick(TEST_NAMES);
  const firstName = name.split(' ')[0];
  const lastName = name.split(' ')[1] || 'Smith';
  return {
    name,
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
    phone: randPhone(),
  };
}

/**
 * Generate a trade-specific simulated lead.
 * Returns { businessType, jobType, description, customer, suburb, source }
 */
function generateTradeLead(businessType) {
  const bt = normalizeBusinessType(businessType);
  const jobTypes = getJobTypes(bt);
  const jobType = pick(jobTypes);
  const suburb = pick(SUBURBS);
  const customer = generateCustomer();
  const portals = TRADE_PORTALS[bt] || DEFAULT_PORTALS;
  const source = pick(portals);

  // Generate a realistic trade-specific inquiry message
  const inquiries = TRADE_INQUIRIES[bt] || GENERIC_INQUIRIES;
  const templateFn = pick(inquiries);
  const description = templateFn(suburb, jobType);

  console.log(`[Trade Simulation] ✅ Generated lead: input='${businessType}', resolved='${bt}', job_type='${jobType}', suburb='${suburb}', source='${source}'`);

  return {
    businessType: bt,
    jobType,
    description,
    customer,
    suburb,
    source,
  };
}

module.exports = {
  AUTHORITATIVE_TRADES,
  TRADE_ALIASES,
  SIMULATE_JOB_TYPES,
  TRADE_PORTALS,
  DEFAULT_PORTALS,
  TEST_NAMES,
  SUBURBS,
  normalizeBusinessType,
  getJobTypes,
  generateTradeLead,
  generateCustomer,
  validateLeadMatch,
  logMismatch,
};