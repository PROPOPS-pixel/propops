const fs = require('fs');
const content = fs.readFileSync('public/propops-trade.html', 'utf8');

// Check the trades-grid section
const gridStart = content.indexOf('<div class=\"trades-grid\">');
console.log('Grid start:', gridStart);

if (gridStart !== -1) {
  // Show the next 500 chars after grid start
  console.log('Grid content (next 600 chars):');
  console.log(content.substring(gridStart, gridStart + 600));
  console.log('---');
}

// Count trade pills
const pillMatches = content.match(/class=\"trade-pill\">([^<]+)<\/div>/g);
console.log('\nAll trade pills:');
if (pillMatches) {
  pillMatches.forEach((m, i) => {
    console.log(`${i + 1}. ${m}`);
  });
  console.log('Total:', pillMatches.length);
}

// Check for operator selector
const hasOperatorSelector = content.includes('b86a5712-80a4-44fb-9d91-ab7a472af8f1');
console.log('\nHas operator selector image:', hasOperatorSelector);

// Find the section
const selectorSection = content.indexOf('id=\"trade-selector\"');
console.log('Operator selector section at:', selectorSection);

if (selectorSection !== -1) {
  console.log('Section content:');
  console.log(content.substring(selectorSection - 100, selectorSection + 300));
}