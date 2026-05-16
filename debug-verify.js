const fs = require('fs');
const c = fs.readFileSync('/opt/polsia/workspaces/company-55743/agent-30/exec-2056856/relio-2/public/index.html', 'utf8');

console.log('Total file length:', c.length);
console.log('Contains How much:', c.includes('How much does it cost?'));
console.log('Contains That...:', c.includes('That\u0027s $3.30'));

// Find how much in context
const idx1 = c.indexOf('How much does it cost?');
console.log('idx of How much:', idx1);
if (idx1 >= 0) console.log('Context:', c.substring(idx1-50, idx1+80));

// Find That's $3.30
const idx2 = c.indexOf('That\u0027s $3.30');
console.log('idx of That...:', idx2);
if (idx2 >= 0) console.log('Context:', c.substring(idx2-20, idx2+60));

// Search for '99' in pricing section
const pricingIdx = c.indexOf('pricing-tier-price');
console.log('Pricing section starts at:', pricingIdx);
if (pricingIdx >= 0) {
  const pricingSlice = c.substring(pricingIdx, pricingIdx+500);
  console.log('Pricing content:', pricingSlice);
}

// Count all $99 references
const regex99 = /\b99\b/g;
const matches = c.match(regex99) || [];
console.log('\nAll $99 refs (' + matches.length + '):');
let i = 0;
let pos = 0;
while ((pos = c.indexOf('$99', pos)) !== -1 && i < 20) {
  console.log('  pos ' + pos + ': ' + JSON.stringify(c.substring(pos, pos+30)));
  pos += 1;
  i++;
}