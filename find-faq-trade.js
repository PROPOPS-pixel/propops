const fs = require('fs');
const content = fs.readFileSync('/opt/polsia/workspaces/company-55743/agent-30/exec-2056856/relio-2/public/propops-trade.html', 'utf8');

// Search for Q&A patterns
const patterns = [
  '<section id=\"faq\"',
  '<section id=\"q&a\"',
  '<section id=\"questions\"',
  'class=\"faq',
  '<details',
  'accordion',
  'Q&A',
  'question-answer',
];
for (const p of patterns) {
  const idx = content.indexOf(p);
  if (idx >= 0) {
    console.log('Found: ' + p + ' at ' + idx);
    // Show context
    console.log('  Context: ' + content.substring(idx-20, idx+200).trim());
  }
}

// Find what's between pricing and footer
const pricingEnd = content.indexOf('id=\"pricing\"') >= 0 ? content.indexOf('id=\"pricing\"') : -1;
console.log('\nPricing section around:');
if (pricingEnd >= 0) {
  // Show from pricing to 3000 chars after
  const chunk = content.substring(pricingEnd + 20, pricingEnd + 3500);
  console.log(chunk);
}