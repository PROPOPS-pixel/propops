#!/usr/bin/env node
// Fix email-intake.js - update simulate endpoint and add generateTradeFakeEmail

const fs = require('fs');
const path = 'routes/email-intake.js';
let content = fs.readFileSync(path, 'utf8');

// ── 1. Replace the simulate endpoint ─────────────────────────────────────────
const oldSimulateMarker = '/**\n * POST /api/email-intake/simulate';
const simulateStart = content.indexOf(oldSimulateMarker);
if (simulateStart === -1) { console.error('Could not find simulate endpoint'); process.exit(1); }

const generateFakeMarker = '/**\n * Generate a realistic fake property inquiry email';
const simulateEnd = content.indexOf(generateFakeMarker, simulateStart);
if (simulateEnd === -1) { console.error('Could not find generateFakeInquiry marker'); process.exit(1); }

const newSimulateEndpoint = `/**
 * POST /api/email-intake/simulate
 * Fire a trade-specific simulated inquiry email through the pipeline for Hugo training.
 * Accepts body: { business_type?: string, source?: string }
 * - business_type: operator's trade (plumber, bricklayer, etc.). Defaults to user's DB business_type.
 * - source: optional portal source override (hipages, ServiceSeeking, etc.)
 */
router.post('/simulate', requireAuth, async (req, res) => {
  try {
    // Get user's business_type from DB if not provided in body
    let bt = req.body && req.body.business_type;
    if (!bt) {
      const userRow = await pool.query('SELECT business_type FROM users WHERE id = $1', [req.userId]);
      bt = userRow.rows[0]?.business_type || 'plumber';
    }

    // Get active token for this user (fall back to any active token for legacy data)
    const tokenRow = await pool.query(
      \n      \n     \n    );
    if (tokenRow.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'No active intake token. Set up email intake first.' });
    }
    const token = tokenRow.rows[0].token;
    const tokenUserId = tokenRow.rows[0].user_id || req.userId || null;

    // Generate a trade-specific inquiry email
    const fakeEmail = generateTradeFakeEmail(bt);

    // Determine source portal
    const portals = ['hipages', 'ServiceSeeking', 'Oneflare', 'Google Business Profile', 'Facebook', 'manual', 'referral'];
    const source = req.body && req.body.source ? req.body.source : portals[Math.floor(Math.random() * portals.length)];

    // ── Validation gate: ensure job type matches target trade pool ───────────
    const jobTypes = SIMULATE_JOB_TYPES[bt] || SIMULATE_JOB_TYPES['handyman'];
    const validation = validateLeadMatch(bt, fakeEmail.job_type);
    if (!validation.valid) {
      logMismatch(bt, fakeEmail.job_type, validation.reason, source);
      return res.status(400).json({
        success: false,
        message: 'Lead rejected: job type does not match trade pool',
        detail: validation.reason,
      });
    }
    console.log(\n    );

    // Process through the same pipeline as real emails
    return processInboundEmail(token, fakeEmail, { simulated: true, source, business_type: bt, ...fakeEmail }, res, tokenUserId);
  } catch (err) {
    console.error('[Email Intake] Simulate error:', err.message);
    res.status(500).json({ success: false, message: 'Simulation failed: ' + err.message });
  }
});

`;

content = content.substring(0, simulateStart) + newSimulateEndpoint + content.substring(simulateEnd);

// ── 2. Add generateTradeFakeEmail before generateFakeInquiry ───────────────
const generateFakeIdx = content.indexOf(generateFakeMarker);
if (generateFakeIdx === -1) { console.error('Could not find generateFakeInquiry'); process.exit(1); }

const newTradeFn = `/**
 * Generate a trade-specific inquiry email for Hugo training simulations.
 * Returns a formatted email object compatible with processInboundEmail pipeline.
 * Includes job_type for validation gate checking.
 */
function generateTradeFakeEmail(businessType) {
  const jobTypes = SIMULATE_JOB_TYPES[businessType] || SIMULATE_JOB_TYPES['handyman'];
  const jobType = jobTypes[Math.floor(Math.random() * jobTypes.length)];

  const firstNames = ['James', 'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'William', 'Sophia',
    'Benjamin', 'Isabella', 'Lucas', 'Mia', 'Henry', 'Charlotte', 'Alexander', 'Amelia'];
  const lastNames = ['Smith', 'Jones', 'Williams', 'Taylor', 'Brown', 'Wilson', 'Evans',
    'Thomas', 'Roberts', 'Johnson', 'White', 'Harris', 'Martin', 'Thompson', 'Garcia'];
  const emailDomains = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com.au', 'icloud.com'];
  const suburbData = [
    { suburb: 'Surry Hills', state: 'NSW', postcode: '2010' },
    { suburb: 'Bondi', state: 'NSW', postcode: '2026' },
    { suburb: 'Newtown', state: 'NSW', postcode: '2042' },
    { suburb: 'Manly', state: 'NSW', postcode: '2095' },
    { suburb: 'Paddington', state: 'NSW', postcode: '2021' },
    { suburb: 'Glebe', state: 'NSW', postcode: '2037' },
    { suburb: 'Mosman', state: 'NSW', postcode: '2088' },
    { suburb: 'Balmain', state: 'NSW', postcode: '2041' },
    { suburb: 'Chatswood', state: 'NSW', postcode: '2067' },
    { suburb: 'Parramatta', state: 'NSW', postcode: '2150' },
    { suburb: 'Castle Hill', state: 'NSW', postcode: '2154' },
    { suburb: 'St Kilda', state: 'VIC', postcode: '3182' },
    { suburb: 'Fitzroy', state: 'VIC', postcode: '3065' },
    { suburb: 'Richmond', state: 'VIC', postcode: '3121' },
    { suburb: 'New Farm', state: 'QLD', postcode: '4005' },
    { suburb: 'Fortitude Valley', state: 'QLD', postcode: '4006' },
    { suburb: 'Subiaco', state: 'WA', postcode: '6008' },
    { suburb: 'Fremantle', state: 'WA', postcode: '6160' },
  ];

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randPhone = () => \n  const firstName = pick(firstNames);
  const lastName = pick(lastNames);
  const name = firstName + ' ' + lastName;
  const email = firstName.toLowerCase() + '.' + lastName.toLowerCase() + randInt(1, 99) + '@' + pick(emailDomains);
  const phone = randPhone();
  const location = pick(suburbData);
  const streetNum = randInt(1, 120);
  const streetNames = ['Bourke', 'Riley', 'Oxford', 'George', 'King', 'Pacific', 'Military', 'Darling', 'Victoria', 'Park'];
  const streetAddress = streetNum + ' ' + pick(streetNames) + ' Street, ' + location.suburb + ' ' + location.state + ' ' + location.postcode;

  const tradeMessages = {
    plumber: [
      'Hi, I have a ' + jobType.toLowerCase() + ' at my place in ' + location.suburb + '. Water\\'s been backing up for a couple of days. Can someone come and have a look?',
      'G\\'day, we have a ' + jobType.toLowerCase() + ' at our property in ' + location.suburb + '. Looking for a licensed plumber to sort it out.',
      'Hi there, we need a ' + jobType.toLowerCase() + ' done at our house in ' + location.suburb + '. We\\'re selling soon and want it sorted before the inspection.',
    ],
    electrician: [
      'Hi, I\\'ve got a ' + jobType.toLowerCase() + ' that needs doing at my home in ' + location.suburb + '. The safety switch keeps tripping.',
      'G\\'day, need an electrician for ' + jobType.toLowerCase() + ' in ' + location.suburb + '. We\\'re renovating and need extra power points installed.',
      'Hi there, the ' + jobType.toLowerCase() + ' at our place in ' + location.suburb + ' stopped working. Can someone licensed come and take a look?',
    ],
    painter: [
      'Hi, I need a painter for a ' + jobType.toLowerCase() + ' in ' + location.suburb + '. The walls are looking tired and we\\'re selling in a few months. Can you quote?',
      'G\\'day, we want a ' + jobType.toLowerCase() + ' done at our place in ' + location.suburb + '. The weatherboards are peeling. Can you come and assess?',
      'Hi there, need a painter for a ' + jobType.toLowerCase() + ' in ' + location.suburb + '. We\\'ve just moved in and the whole interior needs redoing.',
    ],
    bricklayer: [
      'Hi, I\\'m looking to get a ' + jobType.toLowerCase() + ' built along my boundary in ' + location.suburb + '. Can you come out and give me a quote?',
      'G\\'day, I need a ' + jobType.toLowerCase() + ' at the back of my yard in ' + location.suburb + '. When can someone come take a look?',
      'Hi there, I need a ' + jobType.toLowerCase() + ' at my place in ' + location.suburb + '. Not urgent but want it sorted. Can you quote?',
    ],
    handyman: [
      'Hi, I need help with a ' + jobType.toLowerCase() + ' at my unit in ' + location.suburb + '. I\\'ve tried to do it myself but it\\'s beyond me.',
      'G\\'day, need a handyman for a ' + jobType.toLowerCase() + ' in ' + location.suburb + '. Some general repairs that need doing.',
    ],
    fencer: [
      'Hi, I need a new ' + jobType.toLowerCase() + ' in ' + location.suburb + '. About 20m long. Want something that looks good and provides privacy.',
      'G\\'day, our ' + jobType.toLowerCase() + ' in ' + location.suburb + ' got knocked down in the storm. Need it replaced.',
    ],
    landscaper: [
      'Hi, I need help with ' + jobType.toLowerCase() + ' at my place in ' + location.suburb + '. The backyard is a mess. Can someone sort it out?',
      'G\\'day, we\\'re after ' + jobType.toLowerCase() + ' in ' + location.suburb + '. We want a proper design, not just turf.',
    ],
    cleaner: [
      'Hi, I need a ' + jobType.toLowerCase() + ' at my place in ' + location.suburb + '. Moving out next week and need the bond back.',
      'G\\'day, we want a ' + jobType.toLowerCase() + ' for our home in ' + location.suburb + '. Deep clean needed.',
    ],
    tiler: [
      'Hi, I need a ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. The tiles in our bathroom are cracked and the grout is black.',
      'G\\'day, we want a ' + jobType.toLowerCase() + ' in our kitchen in ' + location.suburb + '. Can you supply and install?',
    ],
    concreter: [
      'Hi, I need a ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. Looking to do our front driveway, about 40sqm.',
      'G\\'day, we want ' + jobType.toLowerCase() + ' in ' + location.suburb + '. Can someone design and pour it?',
    ],
    roofer: [
      'Hi, I\\'ve got a ' + jobType.toLowerCase() + ' needed at my place in ' + location.suburb + '. There\\'s a leak coming through when it rains.',
      'G\\'day, we need a ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. Some tiles cracked in the storms.',
    ],
    renderer: [
      'Hi, I need a ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. Want to render the whole exterior.',
      'G\\'day, we want ' + jobType.toLowerCase() + ' in ' + location.suburb + '. Can someone come and quote?',
    ],
    plasterer: [
      'Hi, I need a ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. There\\'s a hole in the ceiling.',
      'G\\'day, we want ' + jobType.toLowerCase() + ' done in ' + location.suburb + ' after the renovation.',
    ],
    solar_installer: [
      'Hi, I\\'m looking at getting ' + jobType.toLowerCase() + ' done at my place in ' + location.suburb + '. Want to reduce our electricity bills.',
      'G\\'day, our ' + jobType.toLowerCase() + ' needs replacing in ' + location.suburb + '. Can you quote on a replacement?',
    ],
    pool_tech: [
      'Hi, I need ' + jobType.toLowerCase() + ' done at my place in ' + location.suburb + '. Pool\\'s gone green and the pump is making a weird noise.',
      'G\\'day, we want regular ' + jobType.toLowerCase() + ' at our property in ' + location.suburb + '.',
    ],
    pest_control: [
      'Hi, I need ' + jobType.toLowerCase() + ' done at my place in ' + location.suburb + '. Found some issues and need it sorted.',
      'G\\'day, we\\'ve got ' + jobType.toLowerCase() + ' at our home in ' + location.suburb + '. Need a professional.',
    ],
    antenna_installer: [
      'Hi, I need ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. TV signal is terrible.',
      'G\\'day, need ' + jobType.toLowerCase() + ' in ' + location.suburb + '. Moving into a new area and need the antenna sorted.',
    ],
    refrigeration: [
      'Hi, our fridge in ' + location.suburb + ' isn\\'t cooling properly. Can someone come and have a look?',
      'G\\'day, need ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. Walk-in freezer at our cafe is not working.',
    ],
    waterproofer: [
      'Hi, I need ' + jobType.toLowerCase() + ' done in ' + location.suburb + '. Our bathroom is leaking through to the ceiling below.',
      'G\\'day, we\\'re renovating our bathroom in ' + location.suburb + ' and need ' + jobType.toLowerCase() + ' before tiles go in.',
    ],
  };

  const messages = tradeMessages[businessType] || [
    'Hi, I need help with ' + jobType.toLowerCase() + ' at my property in ' + location.suburb + '. Can someone come and have a look?',
    'G\\'day, need someone for a ' + jobType.toLowerCase() + ' in ' + location.suburb + '. How much would you charge?',
    'Hi there, looking for a tradie to do ' + jobType.toLowerCase() + ' in ' + location.suburb + '. Can you give me a quote?',
  ];
  const message = messages[Math.floor(Math.random() * messages.length)];

  const subject = 'Enquiry — ' + jobType + ' — ' + location.suburb + ' ' + location.state;
  const bodyText = 'New enquiry from ' + name + '.\\n\\nContact details:\\nName: ' + name + '\\nEmail: ' + email + '\\nPhone: ' + phone + '\\n\\nProperty address: ' + streetAddress + '\\n\\nJob type: ' + jobType + '\\n\\nMessage:\\n' + message + '\\n\\n---\\nThis enquiry was submitted via propops.pro';

  const bodyHtml = '<html><body><h2>New Enquiry — ' + jobType + '</h2><p><strong>Name:</strong> ' + name + '<br><strong>Email:</strong> ' + email + '<br><strong>Phone:</strong> ' + phone + '</p><p><strong>Address:</strong> ' + streetAddress + '</p><p><strong>Job type:</strong> ' + jobType + '</p><hr><p><strong>Message:</strong></p><p>' + message + '</p><hr><p style=\\'color:#999;font-size:12px\\'>Submitted via propops.pro</p></body></html>';

  return {
    subject,
    body_text: bodyText,
    body_html: bodyHtml,
    from_address: email,
    to_address: 'leads-' + Date.now() + '@propops.pro',
    job_type: jobType,
  };
}

`;

content = content.substring(0, generateFakeIdx) + newTradeFn + content.substring(generateFakeIdx);

fs.writeFileSync(path, content);
console.log('Done! Updated email-intake.js');