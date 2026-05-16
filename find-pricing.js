const fs = require('fs');
const content = fs.readFileSync('public/index.html', 'utf8');

// Find <!-- PRICING -->
const pricingIdx = content.indexOf('<!-- PRICING -->');
console.log('<!-- PRICING --> at:', pricingIdx);

// Find the section closing before it
const before = content.substring(pricingIdx - 200, pricingIdx);
console.log('\n--- 200 chars before PRICING ---');
console.log(JSON.stringify(before));
console.log('\n--- Actual bytes ---');
// Show the raw bytes before the pricing comment
const chunk = content.substring(pricingIdx - 10, pricingIdx + 200);
console.log(JSON.stringify(chunk));