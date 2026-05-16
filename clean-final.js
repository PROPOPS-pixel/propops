const fs = require('fs');
let content = fs.readFileSync('public/propops-trade.html', 'utf8');

console.log('File size:', content.length);

// The current state is a mess because multiple scripts ran.
// Let me look at the actual content near the trades-grid section to understand the structure.

// Find ALL <div class=\"trades-grid\"> occurrences
let pos = 0;
let count = 0;
while ((pos = content.indexOf('<div class=\"trades-grid\">', pos)) !== -1) {
  count++;
  const ctx = content.substring(pos, pos + 500);
  console.log(`\n=== Trades-grid occurrence ${count} at pos ${pos} ===`);
  console.log('First 400 chars:');
  console.log(ctx.substring(0, 400));
  console.log('...');
  console.log('Last 400 chars:');
  console.log(ctx.substring(ctx.length - 400));
  pos++;
}
console.log('\nTotal trades-grid occurrences:', count);

// Now find what's between the first and second occurrence (if any)
// or look for the structure after the grid

// Also check: what's after the grid's </div>?
const firstGridPos = content.indexOf('<div class=\"trades-grid\">');
if (firstGridPos !== -1) {
  // Find the </div> after this
  const firstDivClose = content.indexOf('</div>', firstGridPos + 30);
  console.log('\nFirst </div> after grid start:', firstDivClose);

  // Look at what's between firstGridPos and firstDivClose+6
  const beforeClose = content.substring(firstGridPos, firstDivClose + 6);
  const pillCount = (beforeClose.match(/class=\"trade-pill\">/g) || []).length;
  console.log('Pills before first </div> after grid start:', pillCount);
}