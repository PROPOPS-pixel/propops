/**
 * Default services by trade category.
 *
 * Owns: trade-to-service seed data for new operator onboarding.
 * Does NOT own: listings CRUD, dashboard rendering, Hugo context.
 *
 * Used by auth signup-complete to pre-populate a new operator's services
 * so their dashboard is never empty on first login.
 */

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Default services per trade type.
// Each entry: { name, description } — name goes to listings.address, description to listings.suburb.
// Keep to 6–10 per trade: enough to feel populated, not overwhelming.
const TRADE_DEFAULTS = {
  builder: [
    { name: 'Bathroom renovation', description: 'Full bathroom strip and refit' },
    { name: 'Kitchen renovation', description: 'Cabinetry, benchtops, appliances' },
    { name: 'Knockdown rebuild', description: 'Demolish and build new home' },
    { name: 'Extensions & additions', description: 'Room additions and house extensions' },
    { name: 'Retaining walls', description: 'Timber, concrete or block retaining' },
    { name: 'Decks & pergolas', description: 'Timber and composite deck builds' },
    { name: 'Commercial fit-out', description: 'Office and retail fitouts' },
    { name: 'Granny flats', description: 'Secondary dwelling construction' },
    { name: 'Structural repairs', description: 'Underpinning, crack repairs, restumping' },
  ],
  plumber: [
    { name: 'Hot water system install', description: 'Gas, electric and heat pump systems' },
    { name: 'Leak detection & repair', description: 'Pipe leaks, burst pipes, joint failures' },
    { name: 'Blocked drains', description: 'Drain clearing and CCTV inspection' },
    { name: 'Tap & fixture replacement', description: 'Mixer taps, basins, toilets, cisterns' },
    { name: 'Gas fitting', description: 'Gas appliance connections and pipework' },
    { name: 'Bathroom renovation plumbing', description: 'Rough-in and final fit-off' },
    { name: 'Backflow prevention', description: 'Testing and device installation' },
    { name: 'Water pressure issues', description: 'Pressure regulation and boosting' },
  ],
  electrician: [
    { name: 'Switchboard upgrades', description: 'Safety switch, RCD and meter board upgrades' },
    { name: 'Power point installation', description: 'GPOs, USB outlets, outdoor power' },
    { name: 'LED lighting installation', description: 'Downlights, pendant lights, outdoor lighting' },
    { name: 'Fault finding & repairs', description: 'Tripping circuits, dead outlets, wiring faults' },
    { name: 'Air conditioning wiring', description: 'Split system and ducted AC circuits' },
    { name: 'Solar panel installation', description: 'Grid-connect and off-grid solar systems' },
    { name: 'EV charger installation', description: 'Home and commercial EV charging points' },
    { name: 'Smoke alarm compliance', description: 'Installation and interconnection to code' },
  ],
  roofer: [
    { name: 'Roof replacement', description: 'Colorbond, terracotta and concrete tile' },
    { name: 'Roof repairs', description: 'Broken tiles, ridge capping, flashing leaks' },
    { name: 'Gutter replacement', description: 'Colorbond and aluminium gutters and downpipes' },
    { name: 'Gutter guard installation', description: 'Mesh and foam gutter protection systems' },
    { name: 'Leak investigation', description: 'Roof leak diagnosis and repair' },
    { name: 'Fascia & barge boards', description: 'Timber and aluminium fascia replacement' },
    { name: 'Skylights', description: 'Supply and install Velux and fixed skylights' },
    { name: 'Roof restoration', description: 'Clean, re-bed, re-point and paint tiles' },
  ],
  pest_control: [
    { name: 'General pest treatment', description: 'Cockroaches, ants, spiders, silverfish' },
    { name: 'Termite inspection', description: 'Visual and thermal camera inspection' },
    { name: 'Termite treatment', description: 'Baiting systems and chemical barriers' },
    { name: 'Rodent control', description: 'Rats and mice — baiting and exclusion' },
    { name: 'Pre-purchase inspection', description: 'Timber pest inspection report' },
    { name: 'Bed bug treatment', description: 'Heat and chemical treatments' },
    { name: 'Wasps & bees', description: 'Nest removal and prevention' },
  ],
  glazier: [
    { name: 'Window glass replacement', description: 'Single and double glazed units' },
    { name: 'Shower screens', description: 'Framed, semi-framed and frameless' },
    { name: 'Mirror installation', description: 'Bathroom and wardrobe mirrors' },
    { name: 'Splashback installation', description: 'Glass splashbacks cut to size and fitted' },
    { name: 'Emergency glass repair', description: '24/7 broken window boarding and replacement' },
    { name: 'Pool fencing', description: 'Frameless and semi-frameless glass pool fencing' },
    { name: 'Sliding door glass', description: 'Replacement panels and door overhaul' },
  ],
  fencer: [
    { name: 'Colorbond fencing', description: 'Standard and slat Colorbond fence install' },
    { name: 'Timber paling fence', description: 'New timber paling and post install' },
    { name: 'Pool fencing', description: 'Glass and aluminium pool fence to code' },
    { name: 'Retaining walls', description: 'Sleeper and block retaining walls' },
    { name: 'Fence repairs', description: 'Post replacement, paling repair, re-rail' },
    { name: 'Aluminium slat fencing', description: 'Privacy slat and decorative aluminium' },
    { name: 'Gates & automation', description: 'Sliding and swing gates with motors' },
  ],
  concreter: [
    { name: 'Driveways', description: 'Exposed aggregate, plain and coloured concrete' },
    { name: 'Pathways', description: 'Front paths, garden paths, footpaths' },
    { name: 'Concrete slabs', description: 'Shed, carport, house and garage slabs' },
    { name: 'Pool surrounds', description: 'Pebbled and brushed concrete pool areas' },
    { name: 'Concrete cutting & coring', description: 'Expansion joints, penetrations, repairs' },
    { name: 'Resurfacing', description: 'Overlay and resurface tired concrete' },
    { name: 'Concrete stairs', description: 'External stairs and landings' },
  ],
  plasterer: [
    { name: 'Plasterboard installation', description: 'Ceilings, walls, partitions' },
    { name: 'Cornice installation', description: 'Ornate and standard plaster cornice' },
    { name: 'Rendering', description: 'Cement and acrylic render exterior' },
    { name: 'Patching & repairs', description: 'Holes, cracks, water damage repairs' },
    { name: 'Texture coating', description: 'Dulux Texture and similar applied finishes' },
    { name: 'Wet area set', description: 'Bathroom and laundry waterproof plaster set' },
    { name: 'Renovation plastering', description: 'Strip and reboard, full room reno' },
  ],
  tiler: [
    { name: 'Bathroom tiling', description: 'Floor and wall tiles, full bathrooms' },
    { name: 'Kitchen splashbacks', description: 'Tile splashback supply and install' },
    { name: 'Floor tiling', description: 'Porcelain, ceramic and natural stone floors' },
    { name: 'Outdoor paving', description: 'Tiles and pavers for alfresco and pool areas' },
    { name: 'Tile repairs', description: 'Cracked, loose and re-grouting' },
    { name: 'Shower waterproofing', description: 'Wet area membrane and tile system' },
    { name: 'Laundry tiling', description: 'Laundry floor and wall tile' },
  ],
  carpenter: [
    { name: 'Decking', description: 'Timber and composite deck construction' },
    { name: 'Pergolas & carports', description: 'Timber framed outdoor structures' },
    { name: 'Door installation', description: 'Internal and external doors and frames' },
    { name: 'Kitchen cabinetry', description: 'Flat-pack assembly and custom joinery install' },
    { name: 'Skirting & architraves', description: 'Timber mouldings and trim' },
    { name: 'Staircase construction', description: 'Timber stairs, handrails, balustrades' },
    { name: 'Shed & cubby builds', description: 'Garden sheds, cubby houses, studios' },
    { name: 'Fence & gate repairs', description: 'Timber fence posts, pickets, gates' },
  ],
  renderer: [
    { name: 'Cement rendering', description: 'Traditional sand and cement render' },
    { name: 'Acrylic rendering', description: 'Acrylic texture coat render systems' },
    { name: 'Texture coating', description: 'Applied texture finishes for exterior walls' },
    { name: 'Render repairs', description: 'Crack repairs, patch and match' },
    { name: 'Hebel rendering', description: 'Autoclaved aerated concrete systems' },
    { name: 'Painted render finishes', description: 'Render plus paint system' },
  ],
  waterproofer: [
    { name: 'Shower waterproofing', description: 'Bathroom wet area membrane systems' },
    { name: 'Balcony waterproofing', description: 'Deck membrane and remediation' },
    { name: 'Below-slab waterproofing', description: 'Tanking and sub-surface drainage' },
    { name: 'Roof waterproofing', description: 'Flat roof membrane and coating' },
    { name: 'Wet area inspections', description: 'Pre-tile waterproofing compliance inspection' },
    { name: 'Leak remediation', description: 'Identify and fix internal water ingress' },
  ],
  hvac: [
    { name: 'Split system install', description: 'Supply and install reverse-cycle split systems' },
    { name: 'Ducted air conditioning', description: 'Full ducted system supply and installation' },
    { name: 'AC servicing & maintenance', description: 'Filter clean, gas check, performance test' },
    { name: 'AC repairs', description: 'Fault diagnosis and part replacement' },
    { name: 'Evaporative cooling', description: 'Evaporative system supply and install' },
    { name: 'Ventilation systems', description: 'Exhaust fans, kitchen rangehoods, HRV' },
    { name: 'Commercial HVAC', description: 'Commercial cooling and heating systems' },
  ],
  pool_tech: [
    { name: 'Pool cleaning & maintenance', description: 'Weekly and fortnightly service visits' },
    { name: 'Water testing & balancing', description: 'Chemical balance and water quality reports' },
    { name: 'Pool equipment repair', description: 'Pumps, filters, chlorinators, heaters' },
    { name: 'Pool equipment upgrade', description: 'Variable speed pumps, LED lights, automation' },
    { name: 'Green pool treatments', description: 'Algae and green water remediation' },
    { name: 'Pool inspections', description: 'Pre-purchase and compliance pool inspection' },
    { name: 'Pool opening & closing', description: 'Seasonal commissioning and decommissioning' },
  ],
  handyman: [
    { name: 'Flat-pack furniture assembly', description: 'IKEA and flat-pack assembly service' },
    { name: 'Picture & mirror hanging', description: 'Wall art, mirrors, TV brackets' },
    { name: 'Minor repairs & maintenance', description: 'Doors, windows, catches, handles' },
    { name: 'Painting touch-ups', description: 'Interior spot repairs and touch-up painting' },
    { name: 'Tile & grout repairs', description: 'Cracked tiles, re-grouting, silicone' },
    { name: 'Garden maintenance', description: 'Lawn mowing, edging, pruning, rubbish removal' },
    { name: 'Pressure washing', description: 'Driveways, paths, decks, walls' },
    { name: 'Gutter cleaning', description: 'Leaf and debris removal from gutters' },
  ],
  antenna_installer: [
    { name: 'TV antenna installation', description: 'New rooftop and attic antenna systems' },
    { name: 'Antenna repairs', description: 'Fault diagnosis and antenna alignment' },
    { name: 'Antenna upgrades', description: 'Digital antenna upgrades for better reception' },
    { name: 'TV wall mounting', description: 'TV bracket supply and installation' },
    { name: 'Data cabling', description: 'Cat6 ethernet points and structured cabling' },
    { name: 'CCTV installation', description: 'Home and small business CCTV systems' },
    { name: 'Satellite dish installation', description: 'Foxtel and VAST satellite dishes' },
  ],
  refrigeration: [
    { name: 'Commercial refrigeration service', description: 'Cool rooms, display fridges, freezers' },
    { name: 'Refrigeration repairs', description: 'Compressor, gas, controls diagnostics and repair' },
    { name: 'Cool room installation', description: 'New cool room supply and fit-out' },
    { name: 'Cool room maintenance', description: 'Preventive maintenance schedules' },
    { name: 'Air conditioning service', description: 'Split system and ducted AC service' },
    { name: 'Gas leak detection', description: 'Refrigerant leak finding and repair' },
  ],
  solar_installer: [
    { name: 'Solar panel installation', description: 'Grid-connect residential solar systems' },
    { name: 'Battery storage', description: 'Tesla Powerwall and other battery installs' },
    { name: 'Solar system upgrades', description: 'Panel and inverter upgrades and additions' },
    { name: 'Solar servicing & monitoring', description: 'Annual service, fault diagnosis, monitoring setup' },
    { name: 'Commercial solar', description: 'Commercial rooftop and carport solar' },
    { name: 'Off-grid solar', description: 'Standalone power systems' },
    { name: 'EV charger install', description: 'Solar-linked EV charging points' },
  ],
  painter: [
    { name: 'Interior painting', description: 'Walls, ceilings, trim and feature walls' },
    { name: 'Exterior painting', description: 'Full exterior repaint including prep' },
    { name: 'Roof painting', description: 'Tile and metal roof repaint' },
    { name: 'Deck & fence painting', description: 'Timber decks, fences and pergolas' },
    { name: 'Commercial painting', description: 'Office, retail and industrial painting' },
    { name: 'Render painting', description: 'Rendered walls and texture coating systems' },
    { name: 'Wallpaper removal', description: 'Strip, prep and repaint or repaper' },
  ],
  cleaner: [
    { name: 'Regular home cleaning', description: 'Weekly and fortnightly home cleaning' },
    { name: 'End of lease cleaning', description: 'Bond clean to real estate standard' },
    { name: 'Spring cleaning', description: 'Deep clean including oven, windows, tracks' },
    { name: 'Office cleaning', description: 'Commercial office regular cleaning' },
    { name: 'Carpet steam cleaning', description: 'Truck-mount carpet hot water extraction' },
    { name: 'Window cleaning', description: 'Internal and external window cleaning' },
    { name: 'Post-construction cleaning', description: 'Builder\'s clean after renovation' },
    { name: 'Pressure washing', description: 'Driveways, paths, decks and exteriors' },
  ],
  landscaper: [
    { name: 'Garden design & install', description: 'Planting design and full garden makeover' },
    { name: 'Lawn laying', description: 'Turf supply and installation' },
    { name: 'Retaining walls', description: 'Sleeper and block retaining' },
    { name: 'Irrigation systems', description: 'Drip and pop-up irrigation design and install' },
    { name: 'Paving & pathways', description: 'Brick, bluestone and concrete paving' },
    { name: 'Regular maintenance', description: 'Mowing, edging, pruning, weed control' },
    { name: 'Tree removal', description: 'Tree lopping, stump grinding and removal' },
    { name: 'Mulching & soil prep', description: 'Bulk mulch supply and spreading' },
  ],
  appliance_repair: [
    { name: 'Washing machine repair', description: 'All brands — fault diagnosis and parts' },
    { name: 'Dishwasher repair', description: 'Pump, seal, electronics diagnostics' },
    { name: 'Oven & stove repair', description: 'Gas and electric, elements and controls' },
    { name: 'Dryer repair', description: 'Heating element, drum belt and sensor repairs' },
    { name: 'Fridge & freezer repair', description: 'Compressor, thermostat, seal replacement' },
    { name: 'Microwave repair', description: 'Magnetron, door switches, electronics' },
    { name: 'Appliance installation', description: 'Dishwasher and washing machine connect and install' },
  ],
  locksmith: [
    { name: 'Emergency lockout service', description: '24/7 home and car lockouts' },
    { name: 'Lock replacement', description: 'Deadbolt and knobset replacement' },
    { name: 'Lock rekeying', description: 'Rekey locks to new keys after moving' },
    { name: 'Safe opening & servicing', description: 'Lost combination, damaged safe opening' },
    { name: 'Master key systems', description: 'Commercial master key design and installation' },
    { name: 'Security door installation', description: 'Steel security screen doors and grilles' },
    { name: 'CCTV & alarm integration', description: 'Electronic access and alarm systems' },
  ],
  removalist: [
    { name: 'Local home moves', description: 'Residential moves within the metro area' },
    { name: 'Interstate moves', description: 'Long-distance furniture removals' },
    { name: 'Office relocations', description: 'Commercial and office moves' },
    { name: 'Furniture delivery', description: 'Single item and flat-pack delivery' },
    { name: 'Piano & heavy item moving', description: 'Specialty heavy item relocation' },
    { name: 'Packing services', description: 'Full and partial packing with materials' },
    { name: 'Storage solutions', description: 'Short and long-term furniture storage' },
  ],
};

// Aliases for trade keys used in signup flow
const TRADE_ALIASES = {
  re_agent: null,         // Real estate — no trade services
  real_estate: null,      // Real estate — no trade services
  pool_tech: 'pool_tech',
  pest_control: 'pest_control',
  solar_installer: 'solar_installer',
  appliance_repair: 'appliance_repair',
  antenna_installer: 'antenna_installer',
};

/**
 * Return canonical trade key for a given business_type string.
 * Returns null for real estate operators (no trade services to seed).
 */
function resolveTradeKey(businessType) {
  if (!businessType) return null;
  const key = businessType.toLowerCase().trim();
  // Explicit aliases first
  if (key in TRADE_ALIASES) return TRADE_ALIASES[key];
  // Direct match to TRADE_DEFAULTS
  if (TRADE_DEFAULTS[key]) return key;
  return null;
}

/**
 * Seed default services into the listings table for a new operator.
 * Safe to call multiple times — uses ON CONFLICT DO NOTHING on listing_url.
 * Only seeds if the operator has no existing services.
 *
 * @param {number} userId      — operator user_id
 * @param {string} businessType — trade category from signup (e.g. 'builder', 'plumber')
 * @returns {number} count of services inserted
 */
async function seedDefaultServices(userId, businessType) {
  const tradeKey = resolveTradeKey(businessType);
  if (!tradeKey) {
    console.log(`[DefaultServices] No defaults for business_type="${businessType}" — skipping seed`);
    return 0;
  }

  const defaults = TRADE_DEFAULTS[tradeKey];
  if (!defaults || defaults.length === 0) return 0;

  // Only seed if user has no existing services — don't stomp manual additions
  const existing = await pool.query(
    `SELECT COUNT(*) FROM listings WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
  if (parseInt(existing.rows[0].count, 10) > 0) {
    console.log(`[DefaultServices] User ${userId} already has services — skipping seed`);
    return 0;
  }

  let inserted = 0;
  for (const svc of defaults) {
    // Slug-style URL: unique per trade+service, stable across re-runs
    const slug = svc.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const placeholderUrl = `https://propops.trade/services/${tradeKey}/${slug}`;

    await pool.query(
      `INSERT INTO listings (address, suburb, source, listing_url, user_id, is_active)
       VALUES ($1, $2, 'default', $3, $4, true)
       ON CONFLICT (listing_url) WHERE is_active = true DO NOTHING`,
      [svc.name, svc.description, placeholderUrl, userId]
    );
    inserted++;
  }

  console.log(`[DefaultServices] Seeded ${inserted} default services for ${tradeKey} (user ${userId})`);
  return inserted;
}

module.exports = { seedDefaultServices, TRADE_DEFAULTS, resolveTradeKey };
