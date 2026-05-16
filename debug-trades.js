const fs = require('fs');
const content = fs.readFileSync('public/propops-trade.html', 'utf8');

// Search for trades-grid with various formats
const patterns = [
  '<div class=trades-grid>',
  '<div class=\"trades-grid\">',
  'trades-grid',
];

for (const p of patterns) {
  const idx = content.indexOf(p);
  console.log(`Pattern ${JSON.stringify(p)}: ${idx !== -1 ? 'FOUND at ' + idx : 'NOT FOUND'}`);
}

// Find all occurrences of 'trade-pill' and show context
let count = 0;
let pos = 0;
while ((pos = content.indexOf('trade-pill', pos)) !== -1) {
  count++;
  const ctx = content.substring(pos, pos + 50);
  if (count <= 3) console.log(`Occurrence ${count} at ${pos}: ${JSON.stringify(ctx)}`);
  pos++;
}
console.log(`Total 'trade-pill' occurrences: ${count}`);

// Look at the pricing section
const pricingIdx = content.indexOf('All 17+ supported trades');
if (pricingIdx !== -1) {
  console.log('Pricing update found at:', pricingIdx);
  console.log('Context:', JSON.stringify(content.substring(pricingIdx - 20, pricingIdx + 50)));
}