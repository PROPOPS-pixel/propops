const fs = require('fs');
const path = '/opt/polsia/workspaces/company-55743/agent-30/exec-2056856/relio-2/public/propops-trade.html';
let content = fs.readFileSync(path, 'utf8');

const OLD_STRIPE = 'https://buy.stripe.com/8x23cvfGMcpLcbL3BWdby08';
const NEW_STRIPE = 'https://buy.stripe.com/dRmbJ1bqw89v4Jj0pKdby0a';

// 1. Replace all old Stripe links with new $69 link
let count = 0;
while (content.includes(OLD_STRIPE)) {
  content = content.replace(OLD_STRIPE, NEW_STRIPE);
  count++;
}
console.log('\u2713 Stripe links updated: ' + count + ' occurrences');

// 2. Find and replace FAQ section with Hugo promo
// Need to find the FAQ section. Based on the Grep output, there's no FAQ in propops-trade.html
// Let me check for a Q&A or FAQ section
const faqPatterns = [
  'FAQ',
  'Frequently asked',
  'question',
];
let hasFaq = false;
for (const p of faqPatterns) {
  if (content.includes(p)) {
    console.log('Found FAQ pattern: ' + p);
    hasFaq = true;
  }
}

// Check for the pricing section structure
const pricingIdx = content.indexOf('id=\"pricing\"');
if (pricingIdx >= 0) {
  console.log('Pricing section found at:', pricingIdx);
  // Check what's after pricing
  const afterPricing = content.substring(pricingIdx, pricingIdx + 2000);
  console.log('After pricing snippet:', afterPricing.substring(0, 500));
}

// Find what's between pricing and footer/footer
const lastSectionIdx = content.lastIndexOf('</section>');
const footerIdx = content.indexOf('<footer');
console.log('Last section ends at:', lastSectionIdx);
console.log('Footer starts at:', footerIdx);
if (lastSectionIdx >= 0 && footerIdx >= 0) {
  const betweenSections = content.substring(lastSectionIdx, footerIdx);
  console.log('Between last section and footer (' + betweenSections.length + ' chars):');
  console.log(betweenSections.substring(0, 300));
}

fs.writeFileSync(path, content, 'utf8');