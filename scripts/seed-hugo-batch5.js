/**
 * Hugo Training Data — Batch 5/5
 *
 * Seeds training records for: Appliance Repair, Locksmith, Removalist, RE Agent pool.
 * Completes the 22-trade framework.
 *
 * Run: node scripts/seed-hugo-batch5.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ── Training records — each entry: { business_type, customer_message, ai_response } ────

const BATCH_5_RECORDS = [

  // ════════════════════════════════════════════════════════════════════════
  // APPLIANCE REPAIR — 12 records
  // ════════════════════════════════════════════════════════════════════════
  {
    business_type: 'appliance_repair',
    customer_message: `Hi, our Samsung fridge in Bondi has stopped cooling overnight. Everything in the freezer is defrosted. It's 5 years old. Can someone come out today? We've got kids at home and no way to store food.`,
    ai_response: `Hi Sarah,\n\nThat's a stressful situation — I'll get someone out to you today. A fridge stopping cooling suddenly usually points to a faulty thermostat, fan motor, or in some cases a refrigerant issue. All of these are repairable.\n\nCan you confirm your address in Bondi and whether there are any error codes or unusual noises? That helps our tech come prepared with the right parts. Standard callout is $120 + parts — credited against the repair.\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'appliance_repair',
    customer_message: `G'day, my Bosch washing machine in Chatswood is leaking water onto the laundry floor. It's 4 years old. Leak seems to come from the door area. Is it the seal?`,
    ai_response: `G'day Michael,\n\nSounds like the door seal (door boot gasket) — very common on front loaders, especially around the 3–5 year mark. Usually a straightforward fix: seal replacement runs $180–$280 parts and labour.\n\nI'll send a technician to Chatswood to confirm the fault and replace it on the spot if we have the Bosch part in the van. Can you let me know your availability? We can usually get out same day or next business day.\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'appliance_repair',
    customer_message: `Hi there, our Westinghouse dryer in Parramatta is running but not heating at all. Clothes come out still damp. It's 6 years old. Worth repairing or should we replace?`,
    ai_response: `Hi Emma,\n\nNot heating on a dryer is almost always a heating element or thermal fuse — both are relatively cheap fixes. At 6 years old it's absolutely worth repairing rather than replacing.\n\nElement replacement in Parramatta runs $150–$250 parts and labour. I'll send a tech out to confirm the fault and carry out the repair in one visit. What days work for you this week?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'appliance_repair',
    customer_message: `Hello, our dishwasher in Manly won't drain — there's still standing water in the bottom at the end of the cycle. Fisher & Paykel, about 7 years old.`,
    ai_response: `Hi there,\n\nStanding water at the end of the cycle usually means a blocked or failing drain pump — very fixable. Sometimes it's just a debris blockage in the pump filter, which takes 20 minutes to clear. If it's the pump itself, parts and labour typically run $180–$320.\n\nAt 7 years old it's well worth repairing. I'll book a technician in Manly — can you do this week? They'll diagnose and fix in one visit where possible.\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'appliance_repair',
    customer_message: `Hey, the oven at our rental in Hurstville has an element that's completely burnt out — I can see it's broken. Tenant has reported it. LG range cooker. Can you replace the element?`,
    ai_response: `Hi,\n\nBurnt-out bake element is a quick fix — usually done in under an hour. LG range elements run $80–$150 for the part, plus $80–$120 labour, so you're looking at $160–$270 all up.\n\nI'll get a tech out to the Hurstville rental. If you can confirm the LG model number (usually on a sticker inside the oven door frame), we can source the correct element in advance and do it in one visit. When does the tenant need it done by?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'appliance_repair',
    customer_message: `Hi, our rangehood in Newtown is making a very loud rattling noise when we turn it on. It's a Smeg 900mm, about 3 years old. Is this a motor issue?`,
    ai_response: `Hi there,\n\nA rattling rangehood is usually the motor bearings wearing out, or occasionally a loose fan blade. At 3 years old Smeg may still be under warranty — worth checking your purchase documents first.\n\nIf it's out of warranty, a motor replacement typically runs $180–$300 parts and labour. I'll send a tech to Newtown to diagnose it — they can confirm whether it's the motor or something simpler. What times suit you?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'appliance_repair',
    customer_message: `G'day, my air purifier in Randwick is throwing an E3 error code and has shut down completely. It's a Dyson HP07. Still under 2 years old. Can this be fixed?`,
    ai_response: `G'day,\n\nOn a Dyson HP07 the E3 code is a temperature sensor or airflow error — Dyson are known to repair these under their 2-year warranty at no cost.\n\nBefore booking a technician, I'd recommend calling Dyson direct on 1800 239 766 and quoting the error code. If they won't cover it or the warranty's expired, we can take a look in Randwick — callout is $120 which is credited against the repair. What's easiest for you?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'appliance_repair',
    customer_message: `Hi there, the washing machine in my unit in Cronulla won't start at all. It's a 3-year-old LG front loader. Power is fine — the machine just beeps and does nothing. Error code tE is showing.`,
    ai_response: `Hi,\n\nThe tE code on an LG front loader is a thermistor (temperature sensor) fault — a known issue on this model. It's a straightforward repair: thermistor replacement runs $130–$200 parts and labour.\n\nI'll book a technician in Cronulla for this week. Can you confirm the full model number (it'll be on the door frame sticker)? That lets us bring the exact part and get it done in one visit.\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'appliance_repair',
    customer_message: `Hello, our Miele dishwasher in Mosman is displaying an F78 fault and won't run. It's 8 years old. I don't want to replace it — Miele's are built to last. Can you diagnose?`,
    ai_response: `Hi there,\n\nAbsolutely — Miele are engineered to last 20 years and F78 is typically a circulation pump or control board issue, both of which are repairable. Parts availability on Miele is excellent in Australia.\n\nI'll send a Miele-experienced technician to Mosman for a diagnostic callout ($130, credited against repair). Pump replacement on an 8-year-old Miele runs $280–$450 parts and labour — well worth it vs a new machine. When are you available?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'appliance_repair',
    customer_message: `Hey, our Electrolux dryer in Castle Hill keeps tripping the safety switch when we turn it on. There's a burning smell. We've stopped using it. Can someone check it safely?`,
    ai_response: `Hi,\n\nStop using it immediately — you're right to be cautious. A burning smell with a tripping safety switch means there's an electrical fault, likely a failed motor, shorted element, or wiring issue. This needs a proper electrical diagnosis before it's used again.\n\nI'll send a tech to Castle Hill urgently — they'll fault-find safely and confirm what needs replacing. Callout is $120 credited against the repair. Can you do tomorrow morning?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'appliance_repair',
    customer_message: `Hi, I need a new washing machine installed at my place in Paddington. I've bought a Samsung 9kg front loader. Just need connection to existing plumbing and power. Can you install it?`,
    ai_response: `Hi,\n\nHappy to install it for you in Paddington. For a standard washing machine install — connecting to existing water inlets, drain hose, and power point — it takes about 45 minutes. Supply your machine, we do the rest.\n\nInstallation runs $140–$180 and we'll also test a full cycle before we leave to confirm it's all working. We can take the old machine away for an extra $60 if needed. When suits you for the install?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'appliance_repair',
    customer_message: `G'day, our microwave in Balmain door hinge has snapped and the door won't close properly — so it won't run. It's a Panasonic 1200W, about 5 years old. Is a door hinge worth replacing or is it a throwaway repair?`,
    ai_response: `G'day,\n\nDoor hinge replacement on a Panasonic microwave is absolutely worth doing — the part itself is $30–$60 and labour is $80–$120, so you're looking at $110–$180 total. Way cheaper than a new unit.\n\nI'll send a tech to Balmain to assess and carry out the repair. If you can grab the model number from the back or inside the door frame, we can confirm parts availability first. Available this week?\n\nCheers,\nThe PropOps Team`,
  },

  // ════════════════════════════════════════════════════════════════════════
  // LOCKSMITH — 12 records
  // ════════════════════════════════════════════════════════════════════════
  {
    business_type: 'locksmith',
    customer_message: `Hi, I'm locked out of my house in Surry Hills. Left my keys inside when I went out to get coffee. No spare key nearby. Can you get here quickly?`,
    ai_response: `Hi,\n\nNot a problem — we can get a locksmith to Surry Hills within 30–45 minutes. We'll get you back in non-destructively (no damage to the lock) and be out of your way quickly.\n\nStandard residential lockout during business hours is $140. Can you confirm the street address and we'll get someone moving right now? Also — do you have any other entry points open, like a back door or window?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'locksmith',
    customer_message: `G'day, I need all the locks rekeyed at my new house in Fitzroy. Just moved in last week and want to make sure no one else has keys. It's got 3 exterior doors. How much would that be?`,
    ai_response: `G'day James,\n\nSmart move — rekeying after a purchase is the most cost-effective security upgrade you can make. For 3 exterior door cylinders in Fitzroy, rekeying runs $60–$90 per cylinder plus a standard callout ($80), so all up around $260–$350 depending on the lock types.\n\nWe'll rekey all three to a single new key so you only carry one. Can you confirm the lock brands (Lockwood, Gainsborough, etc.) or just send through a photo? We can book you in this week.\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'locksmith',
    customer_message: `Hi there, I manage a strata complex in Chatswood with 18 units. We need a master key system installed — one key that opens all common areas and the individual unit keys for residents. Can you design and quote this?`,
    ai_response: `Hi,\n\nAbsolutely — master key systems for strata buildings are our bread and butter. For 18 units in Chatswood we'd design a 3-level hierarchy: grandmaster (building manager), common area sub-master (cleaners, caretaker), and individual unit keys.\n\nI'll come out for a free site assessment and produce a written specification and quote. Typical cost for an 18-unit block is $4,500–$7,500 supply and install using a restricted key system (Abloy or Mul-T-Lock) so keys can't be copied without authorisation. When can I arrange a site visit?\n\nKind regards,\nThe PropOps Team`,
  },
  {
    business_type: 'locksmith',
    customer_message: `Hello, I've locked my keys in my car at a Westfield carpark in Penrith. It's a 2020 Toyota RAV4. I can't get it open. Can you come out?`,
    ai_response: `Hi,\n\nWe can get an auto locksmith to Penrith Westfield within 45–60 minutes. A 2020 RAV4 uses a standard mechanical lock entry — we can open it non-destructively without any damage to the vehicle.\n\nAutomotive lockout in Penrith is $160 during business hours ($220 after hours). Once you're in, we can also cut you a spare key on the spot if you'd like one.\n\nCan you confirm which Westfield entrance you're near and we'll get moving now?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'locksmith',
    customer_message: `Hey, we've had a staff member leave our business in Newtown unexpectedly. I need the office locks changed on the front and back door today if possible. Can you come?`,
    ai_response: `Hi,\n\nYep — we can prioritise this and get to Newtown today. Changing both front and back door cylinders is a 1–2 hour job. We'll supply new Lockwood (or equivalent) deadbolt cylinders and cut you fresh keys for all staff.\n\nTwo cylinder replacements in Newtown runs $320–$450 depending on the lock grade and number of key copies needed. If you want a higher security option, we can upgrade to a restricted key system at the same time.\n\nWhat time works — can we come this afternoon?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'locksmith',
    customer_message: `Hi, I need a deadbolt installed on my front door in Hornsby. The current lock is just a knob lock and I want proper security. Can you supply and install a good quality deadbolt?`,
    ai_response: `Hi Noah,\n\nGood call — a deadbolt is a significant security upgrade over a knob lock alone. I'd recommend a Lockwood 001 or Gainsborough G series deadbolt — solid Australian brands that are licenced locksmiths' go-to for residential security.\n\nSupply and install a quality deadbolt in Hornsby runs $220–$350 including keying. We can also key it to match your existing door lock so you only carry one key. Happy to come by this week — when suits you?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'locksmith',
    customer_message: `G'day, I have an old combination safe at my property in Randwick that I've forgotten the code for. It belonged to my father. I have proof it's mine. Can a locksmith open it without destroying it?`,
    ai_response: `G'day,\n\nYes — most older dial combination safes can be opened without drilling, depending on the model. Safe cracking (manipulation) is a specialist skill and far preferable to drilling.\n\nBring proof of ownership to the appointment (rates notice or will documentation is fine) and we'll assess in Randwick. Manipulation opening runs $200–$400 depending on the safe model and complexity. Once opened we can also reset it to a new combination if you want.\n\nWhen can we arrange it?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'locksmith',
    customer_message: `Hi there, we want to install a smart electronic lock on our front door in Balmain. Looking at an August or Schlage Encode. Can you install it and connect it to our wifi?`,
    ai_response: `Hi,\n\nHappy to help — we install smart locks regularly and the August and Schlage Encode are both good options for Australian homes. The Schlage Encode is slightly more robust for Australian climate conditions.\n\nInstallation in Balmain runs $180–$250 depending on the door prep required (some older doors need a deadbolt plate fitted first). We'll also walk you through the app setup so you're confident using it.\n\nCan you send through a photo of your current front door lock? That helps us confirm compatibility before we book in.\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'locksmith',
    customer_message: `Hello, I need a security door installed at the front of my home in Castle Hill. Looking for something solid — steel mesh, proper frame. Can you supply and install and what are my options?`,
    ai_response: `Hi,\n\nSecurity doors are a great investment — we supply and install Crimsafe, Amplimesh, and Diamond Grille in Castle Hill, all with multi-point deadlocking systems.\n\nCrimsafe Ultra is our top recommendation — stainless steel 316 mesh, triple-lock, virtually uncuttable. Standard single door supply and install runs $1,400–$2,200 depending on door size and frame condition.\n\nI'll come by for a free measure and quote and bring samples. Most installs take 2–3 hours once parts are ordered. When suits you for a measure-up?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'locksmith',
    customer_message: `Hey, I need 4 spare keys cut for my house in Mosman — front door is a Lockwood 001 deadbolt. Can you just cut keys without needing to come to the property?`,
    ai_response: `Hi,\n\nFor a standard Lockwood 001 we can cut keys at our shop — just bring in one of your existing keys and we'll copy it on the spot. Cost is $20–$30 per key, so 4 copies runs $80–$120.\n\nIf your key has "do not duplicate" stamped on it, we'll need the original registered key card to authorise copies — worth checking before you come in.\n\nWe're in Mosman — drop in any time during business hours and we'll have the copies ready in 10 minutes.\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'locksmith',
    customer_message: `Hi, I've been locked out of my unit in St Kilda at 10pm on a Saturday night. Got back from dinner and can't find my keys. Can you come out after hours?`,
    ai_response: `Hi,\n\nYep — we do after-hours lockouts in St Kilda. I can get a locksmith to you within 45–60 minutes. Saturday night after-hours callout is $250, and that gets you back in non-destructively.\n\nJust confirm your address and whether it's an apartment with a lobby (security entry we need access for) or a direct-entry unit. We'll get moving right now.\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'locksmith',
    customer_message: `G'day, the lock on my front door in Hawthorn has been playing up — stiff to turn and the key sometimes gets stuck. It's a 15-year-old Gainsborough deadbolt. Repair or replace?`,
    ai_response: `G'day,\n\nStiff lock and key jamming is usually worn internals in the cylinder — after 15 years that's completely normal. The question is whether to repin/lubricate or replace the cylinder.\n\nFor a 15-year-old lock, I'd lean towards replacing the cylinder — a new Gainsborough or Lockwood cylinder runs $80–$120 supply and install, and you get a fresh key and smooth operation guaranteed. Repin is only worth it if the deadbolt housing is in good shape.\n\nCan I come by Hawthorn this week to take a look and quote?\n\nCheers,\nThe PropOps Team`,
  },

  // ════════════════════════════════════════════════════════════════════════
  // REMOVALIST — 12 records
  // ════════════════════════════════════════════════════════════════════════
  {
    business_type: 'removalist',
    customer_message: `Hi, we need removalists to move our 3-bedroom house from Bondi to Parramatta next month. Lots of furniture including a couple of heavy pieces. How much would it cost and do you do packing?`,
    ai_response: `Hi Sarah,\n\nBondi to Parramatta with a 3-bedroom house — that's typically a full-day job (8–12 hours) with a 2-person crew and truck. All-up cost runs $900–$1,400 depending on how much you have.\n\nYes, we offer full packing service — we supply all boxes and materials and pack everything for you. A pack + move for a 3-bedder adds $400–$600 to the base move cost.\n\nWould you like to lock in a free quote? I'll send you a checklist so we can price it accurately. When's the target moving date?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'removalist',
    customer_message: `G'day, we're moving from Fitzroy to a new place in Hawthorn — about 2km away. 2-bedroom apartment. Not much furniture but a few heavy pieces. Can you give me a rough price?`,
    ai_response: `G'day Michael,\n\nFitzroy to Hawthorn is a nice short move — a 2-bedroom apartment typically takes 3–5 hours with a 2-person crew. Based on that, you're looking at $400–$700 all up.\n\nTo give you an accurate quote I'd want to know: how many floors/are there lifts at both ends? Any specialty items (piano, pool table, artworks)? We can also do a quick 10-minute video walkthrough if that's easier than filling out a form.\n\nHappy to lock in a date — when are you moving?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'removalist',
    customer_message: `Hi there, I need interstate removalists from Sydney to Brisbane. 4-bedroom house worth of furniture. We'll pack ourselves. What's the process and how do you price an interstate move?`,
    ai_response: `Hi Emma,\n\nSydney to Brisbane is one of our most common interstate routes. For a 4-bedroom house packed by yourselves, we're looking at 30–45m³ of volume, which prices at $3,500–$5,500 on a shared or dedicated truck depending on your preferred transit timeline.\n\nThe process: we provide a cubic metre estimate based on a walkthrough or inventory list, load day is confirmed 2–3 weeks ahead, transit takes 1–2 days. Dedicated truck is fastest but shared load (slightly slower) saves 30–40%.\n\nShall I schedule a free assessment to lock in an accurate quote?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'removalist',
    customer_message: `Hello, I need a grand piano moved from my home in Mosman to a music school in Surry Hills. It's a full-size Steinway Model B. I know this requires specialists.`,
    ai_response: `Hi,\n\nAbsolutely — we do piano moves regularly and a Steinway Model B is a full 211cm concert grand, so this is a specialist lift requiring a piano board, proper strapping, and often a team of 3-4.\n\nMosman to Surry Hills for a full grand piano runs $600–$900, which includes specialty wrapping, piano skid board, and careful placement at the destination. We'll need to assess both properties for access — stairways, lifts, and floor surface all affect the plan.\n\nCan I arrange a site inspection at both addresses?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'removalist',
    customer_message: `Hey, I'm a student moving out of my share house in Newtown to a studio in Glebe. I just have a bed, desk, bookshelf, and about 10 boxes. What would a small move like that cost?`,
    ai_response: `Hi,\n\nNewtown to Glebe with that volume is a 1.5–2 hour job for our 2-person minimum crew. Cost runs $260–$350 for a small move like that.\n\nOne quick question — is there parking access at both ends, and are either properties above ground floor with stairs? That's the main thing that affects timing on a small move.\n\nHappy to fit you in — weekday moves are cheaper than weekends and we often have mid-week availability on short notice. What date are you looking at?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'removalist',
    customer_message: `Hi, our office in Parramatta is relocating to a new space in North Sydney. About 12 workstations, filing cabinets, a server rack, and some lounge furniture. Needs to happen on a Saturday. Can you quote?`,
    ai_response: `Hi,\n\nOffice relocations are our specialty — and doing it on a Saturday to avoid business interruption is the right call. For 12 workstations with filing and a server rack, we'd send a 3-person team with a medium truck. Parramatta to North Sydney on a Saturday would run $1,200–$1,800 for the full day.\n\nFor the server rack we'll want to confirm dimensions and weight, and coordinate with your IT team for disconnection/reconnection. We also offer post-move furniture set-up to get the new space operational same day.\n\nShall I put together a formal quote? Can we arrange a walkthrough of the current space?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'removalist',
    customer_message: `G'day, I just need some furniture removed from my house in Randwick — old couch, double bed frame, chest of drawers, and a fridge. Just getting rid of it all. Can you do a pickup and disposal?`,
    ai_response: `G'day,\n\nHappy to help with a furniture removal and disposal in Randwick. For those 4 items — couch, bed frame, chest of drawers, and fridge — it's a 1-hour job with a 2-person crew and a small truck.\n\nCost for pickup and responsible disposal runs $250–$350. The fridge is disposed of at an approved e-waste facility (no landfill dump fees). We can usually fit you in within 1–2 days.\n\nWhat days this week work? And is there easy truck access at the property?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'removalist',
    customer_message: `Hi there, I bought a large sideboard and two armchairs at an auction in Surry Hills last weekend. Need them picked up and delivered to my house in Chatswood. The auction house closes at 5pm. Can you do an auction pickup?`,
    ai_response: `Hi,\n\nNo problem — auction pickups are a regular job for us. Surry Hills to Chatswood with those 3 pieces is a 2–3 hour round trip. Cost runs $280–$380 for the job including pickup and in-home delivery to your desired room.\n\nImportant: let the auction house know we're collecting on your behalf (they'll need your buyer number). Can you confirm the auction house address and access hours? We can usually schedule within 1–2 days.\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'removalist',
    customer_message: `Hello, we're end of lease in Cronulla and need to be out by Friday. 2-bedroom unit on the 3rd floor — there's a lift. We've packed everything already. Can you move us to Caringbah on short notice?`,
    ai_response: `Hi Olivia,\n\nYes — we can fit you in before Friday. Cronulla to Caringbah with a pre-packed 2-bedder and lift access is a 4–6 hour job. Cost runs $550–$850 depending on volume.\n\nWith short notice we'd need to confirm tomorrow for Friday — can you send through an inventory of the main furniture pieces so we can allocate the right truck size? Also, is there lift access at the Caringbah end too?\n\nLet's lock it in now.\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'removalist',
    customer_message: `Hey, we're moving from a 5-bedroom house in Castle Hill to a smaller 3-bedroom place in Hornsby. We're downsizing so some furniture is going into a storage unit in Cherrybrook. Can you manage the split destination?`,
    ai_response: `Hi,\n\nSplit-destination moves are no problem — we do them regularly for downsizers. Castle Hill to Hornsby + storage drop-off in Cherrybrook works as a single job where we load everything, deliver the keep-items to Hornsby, then take the storage items to Cherrybrook.\n\nFor a 5-bedroom house it's typically a full-day crew of 3 with a large truck. Cost runs $1,500–$2,500 depending on how much is going to each location.\n\nShall I arrange a free in-home assessment to build an accurate quote?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'removalist',
    customer_message: `Hi, I need a full pack service for our house move in Essendon next week. We have 3 young kids and no time to pack. 4-bedroom house. Can you pack everything?`,
    ai_response: `Hi,\n\nAbsolutely — a full professional pack is exactly the right call for a busy family. We supply all boxes, packing paper, tape, and specialty wrapping for fragile items. For a 4-bedroom home the pack typically takes 6–8 hours with a 2-person team the day before the move.\n\nFull pack + move for a 4-bedder in Essendon runs $2,000–$3,000 depending on volume. We also offer an unpack service at the destination if you'd like to walk into a fully set-up home.\n\nCan we schedule a quote visit this week?\n\nCheers,\nThe PropOps Team`,
  },
  {
    business_type: 'removalist',
    customer_message: `G'day, my mum is moving from a retirement village in Glen Waverley to a smaller unit in Dandenong. She doesn't have much — bedroom furniture, a few boxes, a small dining set. Very fragile items. She's anxious about the move.`,
    ai_response: `G'day,\n\nWe'll take great care of your mum's move — this is exactly the kind of job we pride ourselves on. A small move from Glen Waverley to Dandenong with careful wrapping of fragile items typically takes 3–4 hours with a 2-person crew.\n\nCost runs $350–$550, and our team will take all the time needed to wrap and protect her belongings. We're happy to introduce ourselves to your mum and keep the process calm and unhurried.\n\nWhen is she looking to move? We'll make sure she feels completely comfortable on the day.\n\nCheers,\nThe PropOps Team`,
  },

  // ════════════════════════════════════════════════════════════════════════
  // RE AGENT — 10 records
  // ════════════════════════════════════════════════════════════════════════
  {
    business_type: 're_agent',
    customer_message: `Hi, I'm a property manager in Newtown and I need tradespeople for a tenant move-out at one of our rentals. Tenant just vacated — the property needs a professional clean, carpet steam clean, and a couple of small painting touch-ups. Can you coordinate this?`,
    ai_response: `Hi,\n\nHappy to coordinate this for you. Tenant move-out turnarounds are a regular job for us — we can organise the professional clean, carpet steam clean, and painting touch-ups as a single job with one invoice back to you.\n\nFor a Newtown rental can you let me know how many bedrooms and confirm any specific issues flagged in the exit condition report? That helps me price and schedule accurately. We typically turn these around within 3–4 business days of instruction.\n\nKind regards,\nThe PropOps Team`,
  },
  {
    business_type: 're_agent',
    customer_message: `G'day, I'm a selling agent in Paddington with a vendor going to auction in 3 weeks. The property needs pre-sale presentation work — freshening up the paint inside, some garden tidy-up, and professional styling photography. Can you line up the trades?`,
    ai_response: `G'day,\n\n3 weeks is a tight but workable window for pre-sale presentation. We can coordinate interior paint touch-up (1–2 days), garden tidy (half-day), and connect you with a property stylist for photography prep.\n\nTo keep your auction timeline on track I'd want to get trades in for a walk-through this week. Can you let me know access arrangements for the Paddington property? I'll compile a scope and costings by end of week.\n\nKind regards,\nThe PropOps Team`,
  },
  {
    business_type: 're_agent',
    customer_message: `Hi there, I manage a portfolio of 35 properties across the northern suburbs and I need a reliable trades coordinator I can call on for routine maintenance — plumbing, electrical, handyman. Can we set up a working arrangement?`,
    ai_response: `Hi,\n\nA portfolio of 35 properties is exactly the scale we work with regularly. We can act as your single point of contact for all routine maintenance — you log the job, we coordinate the right trade, attend within the agreed SLA, and send you one consolidated invoice.\n\nFor ongoing arrangements we typically offer preferred response times (4-hour for urgent, 24-hour for routine) and a rate card so you know costs upfront. Can we arrange a 20-minute call this week to outline the scope?\n\nKind regards,\nThe PropOps Team`,
  },
  {
    business_type: 're_agent',
    customer_message: `Hello, I have a landlord in Surry Hills who wants to upgrade the property between tenancies — new flooring, fresh paint throughout, and update the kitchen benchtop. Can you project manage the whole thing?`,
    ai_response: `Hi,\n\nHappy to take this on as a full project management engagement. Between-tenancy upgrades are a smart time to do them — no occupied property disruptions and all trades can work concurrently.\n\nFor a Surry Hills property I'd want to do a site visit to scope the flooring area, paint extent, and kitchen benchtop size — that lets me put together an accurate fixed-price proposal. Typical all-in cost for new flooring + paint throughout + kitchen benchtop runs $12,000–$22,000 depending on specification.\n\nCan I arrange a walk-through this week?\n\nKind regards,\nThe PropOps Team`,
  },
  {
    business_type: 're_agent',
    customer_message: `Hey, I'm a PM and one of my tenants has reported a leaking tap and a broken light fitting at a property in Randwick. Two separate trades. Landlord has approved the work. Can you send a plumber and electrician?`,
    ai_response: `Hi,\n\nNo problem — we can coordinate both. A leaking tap and a broken light fitting are quick jobs that don't need separate callouts if we schedule them together.\n\nI'll send a combined plumber and electrician visit to the Randwick property, minimising disruption to the tenant. We'll confirm access with the tenant directly if you provide their contact details, or coordinate through you — whichever works.\n\nOne invoice back to you once both jobs are done. Can you confirm the property address and tenant availability?\n\nKind regards,\nThe PropOps Team`,
  },
  {
    business_type: 're_agent',
    customer_message: `Hi, I've just bought a home in Hawthorn and I want a full renovation done before I move in — new kitchen, both bathrooms freshened up, and paint throughout. I don't want to manage individual trades. Can you project manage?`,
    ai_response: `Hi,\n\nAbsolutely — a new-purchase renovation is best managed under a single coordinator who handles sequencing, trades, and quality control. You get a start date, a completion date, and one point of contact.\n\nFor a Hawthorn home with new kitchen, bathroom refreshes, and full repaint, realistic budget range is $40,000–$90,000 depending on specification. Scope and timeline solidify after a site visit.\n\nCan I come by the property this week for a walk-through? I'll produce a detailed scope and budget within a few days of the visit.\n\nKind regards,\nThe PropOps Team`,
  },
  {
    business_type: 're_agent',
    customer_message: `G'day, I manage a commercial property in Parramatta — a 250m² office suite. The current tenant is vacating and the landlord wants it presented well for the next tenant. Carpet replacement, fresh paint, and an electrical check. Can you manage this?`,
    ai_response: `G'day,\n\nCommercial property make-goods are a regular engagement for us. For a 250m² office suite in Parramatta the scope sounds straightforward — carpet, paint, and an electrical compliance check before new tenancy.\n\nTypical cost for a job this scale: carpet supply and lay $7,000–$12,000, commercial repaint $6,000–$10,000, electrical inspection and compliance certificate $600–$1,200. All trades coordinated as one job.\n\nI'll need a site access time to do a proper walkthrough and produce the quote. When is the property available?\n\nKind regards,\nThe PropOps Team`,
  },
  {
    business_type: 're_agent',
    customer_message: `Hi there, my landlord client in Mosman wants to do an upgrade on their rental — new bathroom vanity, kitchen refresh, and fresh carpet. They want it done properly before finding a new tenant. Can you coordinate trades and give one total price?`,
    ai_response: `Hi,\n\nHappy to coordinate this as a single project. A Mosman rental upgrade — new vanity, kitchen refresh, and carpet — is typically a 5–7 day job from start to finish with concurrent trades.\n\nI'll produce one scope document covering all three areas with a single fixed price for your landlord to approve. Rough range for this scope is $15,000–$28,000 depending on the specification they choose.\n\nCan I arrange a site visit this week? I'll bring a couple of vanity and carpet samples so we can make decisions on the day.\n\nKind regards,\nThe PropOps Team`,
  },
  {
    business_type: 're_agent',
    customer_message: `Hello, I'm a buyers agent in Bondi and my client just purchased a property that needs some renovation before they move in — mainly a kitchen renovation and updating the bathrooms. They want it managed properly. Can you oversee the project?`,
    ai_response: `Hi,\n\nGreat timing to renovate before move-in — it avoids the disruption and maximises the finished result. Kitchen renovation and bathroom updates in Bondi is a project we handle regularly.\n\nFor project management I'll walk the property, scope the works, produce a detailed budget, manage the trades, and handle all site coordination. Your client gets weekly progress updates and a single invoice.\n\nKitchen reno + 2 bathroom updates in Bondi typically runs $45,000–$80,000 depending on spec. Can we arrange a site visit with your client this week?\n\nKind regards,\nThe PropOps Team`,
  },
  {
    business_type: 're_agent',
    customer_message: `Hey, one of my tenants in Chatswood has flagged that the rangehood is broken, there's a crack in the shower tile, and the back gate won't close properly. Three different trades. Landlord is happy to proceed. Can you manage all three?`,
    ai_response: `Hi,\n\nNo problem — three small jobs like this are our bread and butter. I'll coordinate a rangehood tech (appliance repair), a tiler for the cracked shower tile, and a carpenter or handyman for the gate.\n\nWe'll schedule them to attend at the same time or back-to-back to minimise tenant disruption, and you'll receive one invoice for all three.\n\nCan you confirm the Chatswood property address and tenant contact details for access? I'll have all three jobs scoped and scheduled within 24 hours.\n\nKind regards,\nThe PropOps Team`,
  },
];

async function run() {
  // Find the first active/trial user for this app instance
  const userResult = await pool.query(
    `SELECT id FROM users
     WHERE subscription_status IN ('trial', 'active')
     ORDER BY created_at ASC
     LIMIT 1`
  );

  if (!userResult.rows.length) {
    console.error('[Batch 5] No active/trial user found — check DB connection or user status');
    process.exit(1);
  }

  const agentId = userResult.rows[0].id;
  console.log(`[Batch 5] Using agent_id=${agentId}`);

  let inserted = 0;
  let skipped = 0;

  for (const record of BATCH_5_RECORDS) {
    try {
      const result = await pool.query(
        `INSERT INTO hugo_training_data
           (agent_id, business_type, conversation_type, customer_message, ai_response, is_simulation)
         VALUES ($1, $2, 'inbound_inquiry', $3, $4, TRUE)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [agentId, record.business_type, record.customer_message, record.ai_response]
      );

      if (result.rows.length > 0) {
        inserted++;
        console.log(`  ✅ [${record.business_type}] id=${result.rows[0].id}`);
      } else {
        skipped++;
        console.log(`  ⏭  [${record.business_type}] duplicate skipped`);
      }
    } catch (err) {
      console.error(`  ❌ [${record.business_type}] Error:`, err.message);
    }
  }

  console.log(`\n[Batch 5] Done — inserted=${inserted}, skipped=${skipped}, total=${BATCH_5_RECORDS.length}`);

  // Verify final training data count
  const countResult = await pool.query(
    `SELECT business_type, COUNT(*) AS count
     FROM hugo_training_data
     GROUP BY business_type
     ORDER BY business_type`
  );
  console.log('\n[Batch 5] Training data totals by trade:');
  for (const row of countResult.rows) {
    console.log(`  ${row.business_type}: ${row.count} records`);
  }

  await pool.end();
}

run().catch(err => {
  console.error('[Batch 5] Fatal error:', err);
  process.exit(1);
});
