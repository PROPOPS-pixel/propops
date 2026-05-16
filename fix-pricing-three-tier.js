#!/usr/bin/env node
// Fix pricing: $69 early bird live on both propops.pro and propops.trade
const fs = require('fs');

const indexPath = './public/index.html';
const tradesPath = './public/trades.html';

function apply(content, patterns) {
  for (const [find, replace] of patterns) {
    content = content.split(find).join(replace);
  }
  return content;
}

function applyRegex(content, patterns) {
  for (const [find, replace] of patterns) {
    const re = new RegExp(find, 'g');
    const newContent = content.replace(re, replace);
    if (newContent !== content) {
      console.log(`  ✅ replaced pattern`);
    }
    content = newContent;
  }
  return content;
}

console.log('\n=== FIXING PRICING ON TRADES.HTML ===\n');

let tradesContent = fs.readFileSync(tradesPath, 'utf8');
const tradesOriginalLength = tradesContent.length;

// trades.html: ALL $99 → $69 (trades is early bird pricing page)
const tradesPatterns = [
  // Meta title
  ['PropOps for Tradies — Sack Your Receptionist. Sack Your Bookkeeper. $99/mo.',
   'PropOps for Tradies — Sack Your Receptionist. Sack Your Bookkeeper. $69/mo'],
  // Meta description
  ['$99/mo flat. 14-day free trial. Plumbers, electricians, cleaners + 20 more trades.',
   '$69/mo flat. 14-day free trial. Plumbers, electricians, cleaners + 20 more trades.'],
  // Hero
  ['Hugo does both for <span class=\\\"price\\\">$99.</span>',
   'Hugo does both for <span class=\"price\">$69.</span>'],
  // Comparison table - Monthly cost row
  ['<span class=\"val-amber val-big-price\">$99/mo</span>',
   '<span class=\"val-amber val-big-price\">$69/mo</span>'],
  // Human receptionist row
  ['<span class=\"val-amber\">Hugo: $99</span>',
   '<span class=\"val-amber\">Hugo: $69</span>'],
  // CTA in use-cases section
  ['Start Free Trial — $99/mo',
   'Start Free Trial — $69/mo'],
  // Pricing section heading
  ['$99/mo. Flat.',
   '$69/mo. Flat.'],
  // Pricing section sub text
  ['Receptionist + bookkeeper for $99/mo.',
   'Receptionist + bookkeeper for $69/mo.'],
  // Pricing card amount
  ['<div class=\"price-amount\"><sup>$</sup>99<span class=\"period\">/mo</span></div>',
   '<div class=\"price-amount\"><sup>$</sup>69<span class=\"period\">/mo</span></div>'],
];

tradesContent = apply(tradesContent, tradesPatterns);

// Update badge text from 14-day free trial to early bird
tradesContent = tradesContent.replace(
  '<div class=\"price-badge\">14-day free trial</div>',
  '<div class=\"price-badge\">⚡ $69/mo — locked forever</div>'
);

// Update price card name from Monthly to Early Bird
tradesContent = tradesContent.replace(
  '<div class=\"price-name\">Monthly</div>',
  '<div class=\"price-name\">Early Bird</div>'
);

fs.writeFileSync(tradesPath, tradesContent, 'utf8');
const tradesChanges = tradesContent.length !== tradesOriginalLength;
console.log(`✅ trades.html pricing updated to $69 (early bird)`);

console.log('\n=== FIXING PRICING ON INDEX.HTML ===\n');

let indexContent = fs.readFileSync(indexPath, 'utf8');

// 1. Fix meta description
if (indexContent.includes('From $99/mo AUD')) {
  indexContent = indexContent.split('From $99/mo AUD').join('From $69/mo AUD');
  console.log('✅ index.html meta description updated to $69');
}

// 2. Find the pricing section and update to 3-card layout
// First, update the existing Monthly card to say Early Bird with 3-card grid CSS
// The grid needs CSS: grid-template-columns: repeat(3, 1fr)

// Update the pricing tiers grid opening div to be 3-col
if (indexContent.includes('class=\"pricing-tiers-grid\"')) {
  indexContent = indexContent.split('class=\"pricing-tiers-grid\"').join('class=\"pricing-tiers-grid\" style=\"display:grid;grid-template-columns:repeat(3,1fr);gap:1.5rem;max-width:900px;margin:0 auto;\"');
  console.log('✅ pricing grid CSS updated to 3 columns');
}

// Update badge to say full text
indexContent = indexContent.split('>30% off — before June 30<').join('>30% OFF — BEFORE JUNE 30<');

// Add border/style to Early Bird card
const earlyBirdCardStart = '<div class=\"pricing-tier-card\" style=\"padding:2rem 1.75rem;\">\n                <div class=\"pricing-tier-badge\">30% OFF — BEFORE JUNE 30</div>\n                <div class=\"pricing-tier-name\"';
const earlyBirdCardNew = '<div class=\"pricing-tier-card\" style=\"padding:2rem 1.75rem;border:2px solid var(--amber);box-shadow:0 4px 24px rgba(245,158,11,0.15);\">\n                <div class=\"pricing-tier-badge\">30% OFF — BEFORE JUNE 30</div>\n                <div class=\"pricing-tier-name\"';
if (indexContent.includes(earlyBirdCardStart)) {
  indexContent = indexContent.split(earlyBirdCardStart).join(earlyBirdCardNew);
  console.log('✅ Early Bird card styled with amber border');
}

// Update Monthly name to Early Bird
indexContent = indexContent.split('>Monthly</div>').join('>Early Bird</div>');

// 3. Add Standard $99 card between Early Bird and Annual
// Find the Annual card and insert Standard before it
const annualCardMarker = '<!-- Annual -->';
if (indexContent.includes(annualCardMarker)) {
  const standardCardHTML = `<!-- Standard -->
            <div class=\"pricing-tier-card\" style=\"padding:2rem 1.75rem;\">
                <div class=\"pricing-tier-badge\" style=\"background:var(--blue-bg);color:var(--blue);border-color:rgba(37,99,235,0.3);\">MOST POPULAR</div>
                <div class=\"pricing-tier-name\" style=\"font-size:1.15rem;margin-bottom:0.75rem;\">Standard</div>
                <div class=\"pricing-tier-price\">
                    <span class=\"currency\">$</span><span class=\"amount\" style=\"font-size:3rem;\">99</span><span class=\"period\">/mo</span>
                </div>
                <div class=\"pricing-tier-currency\" style=\"margin-bottom:0.5rem;\">AUD</div>
                <p style=\"font-size:0.82rem;color:var(--slate-mid);margin-bottom:1.5rem;\">&nbsp;</p>
                <ul style=\"list-style:none;text-align:left;margin-bottom:1.75rem;display:flex;flex-direction:column;gap:0.5rem;\">
                    <li style=\"font-size:0.875rem;color:var(--slate-mid);display:flex;gap:0.5rem;align-items:flex-start;\"><span style=\"color:var(--green);font-weight:700;flex-shrink:0;\">✓</span> AI response in &lt;3 seconds</li>
                    <li style=\"font-size:0.875rem;color:var(--slate-mid);display:flex;gap:0.5rem;align-items:flex-start;\"><span style=\"color:var(--green);font-weight:700;flex-shrink:0;\">✓</span> All portals (REA, Domain, email)</li>
                    <li style=\"font-size:0.875rem;color:var(--slate-mid);display:flex;gap:0.5rem;align-items:flex-start;\"><span style=\"color:var(--green);font-weight:700;flex-shrink:0;\">✓</span> Cross-sell on every lead response</li>
                    <li style=\"font-size:0.875rem;color:var(--slate-mid);display:flex;gap:0.5rem;align-items:flex-start;\"><span style=\"color:var(--green);font-weight:700;flex-shrink:0;\">✓</span> Instant push notifications</li>
                    <li style=\"font-size:0.875rem;color:var(--slate-mid);display:flex;gap:0.5rem;align-items:flex-start;\"><span style=\"color:var(--green);font-weight:700;flex-shrink:0;\">✓</span> Edit &amp; Resend on every AI reply</li>
                </ul>
                <a href=\"https://buy.stripe.com/9B63cvams0H37VvfkEdby09\" class=\"pricing-tier-cta\" target=\"_blank\" rel=\"noopener\">Start Free Trial</a>
            </div>

            `;
  indexContent = indexContent.split(annualCardMarker).join(standardCardHTML + annualCardMarker);
  console.log('✅ Added Standard $99 card to index.html');
}

fs.writeFileSync(indexPath, indexContent, 'utf8');

// 4. Move pricing to top of index.html — insert after hero section
// Find the current pricing position and the hero section end
let indexFinal = fs.readFileSync(indexPath, 'utf8');

// Find what comes BEFORE the pricing section (it's after the operator section)
// Look for the section before PRICING
const pricingSectionStart = '<!-- PRICING -->';
const pricingSectionEnd = '<!-- SOCIAL PROOF -->';

if (indexFinal.includes(pricingSectionStart) && indexFinal.includes(pricingSectionEnd)) {
  const heroEndMarker = '</section>\n\n<!-- PRICING -->';
  if (indexFinal.includes(heroEndMarker)) {
    // Move the entire pricing section to right after the hero
    // Extract pricing section
    const startIdx = indexFinal.indexOf('<section class=\"pricing-section\"');
    const endIdx = indexFinal.indexOf('</section>\n\n<!-- SOCIAL PROOF -->');
    if (startIdx !== -1 && endIdx !== -1) {
      const pricingSection = indexFinal.substring(startIdx, endIdx + '</section>'.length);

      // Remove it from current location
      let afterRemove = indexFinal.substring(0, startIdx) + indexFinal.substring(endIdx + '</section>'.length);

      // Insert right after the operator section (before PRICING comment)
      const insertPoint = afterRemove.indexOf('\n\n<!-- PRICING -->');
      if (insertPoint !== -1) {
        const before = afterRemove.substring(0, insertPoint);
        const after = afterRemove.substring(insertPoint);
        indexFinal = before + '\n' + pricingSection + after;
        fs.writeFileSync(indexPath, indexFinal, 'utf8');
        console.log('✅ Moved pricing section to top of page (after hero)');
      }
    }
  }
}

// Verify changes
console.log('\n=== VERIFICATION ===');
const tradesVerify = fs.readFileSync(tradesPath, 'utf8');
const indexVerify = fs.readFileSync(indexPath, 'utf8');

console.log('\ntrades.html remaining $99 references (excluding z-index):');
const trades99 = tradesVerify.match(/\b99\b/g);
console.log('  Count:', trades99 ? trades99.length : 0);
if (trades99) {
  const lines = tradesVerify.split('\n');
  trades99.forEach(() => {
    const idx = tradesVerify.indexOf('99');
    const lineNo = tradesVerify.substring(0, idx).split('\n').length;
    console.log(`  Line ~${lineNo}: ${lines[lineNo-1]?.trim()}`);
  });
}

console.log('\nindex.html remaining $99 references:');
const index99 = indexVerify.match(/\b99\b/g);
console.log('  Count:', index99 ? index99.length : 0);

console.log('\n✅ All pricing changes applied.');