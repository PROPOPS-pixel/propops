const fs = require('fs');
let content = fs.readFileSync('public/propops-trade.html', 'utf8');

console.log('File size:', content.length);

// Verify pricing update (should already be done)
if (content.includes('All 17+ supported trades')) {
  console.log('✓ Pricing already updated to 17+');
} else {
  content = content.replace('All 22+ supported trades', 'All 17+ supported trades');
  console.log('✓ Updated pricing to 17+');
}

// Find the trades-grid section using the correct pattern with quotes
const gridStart = content.indexOf('<div class=\"trades-grid\">');
console.log('Grid start:', gridStart);

if (gridStart === -1) {
  console.log('ERROR: Could not find trades-grid div');
  process.exit(1);
}

// Find the end of the trades-grid section
// The grid div starts, contains 22 trade-pill divs, then closes with </div>
// Then there's another </div> (for the section-header), then closing section stuff
// Let's find the section that starts with <div class=trades-grid> and ends with the grid closing
// Strategy: find the 22nd </div> after the grid start that closes the grid itself

let searchPos = gridStart;
let divCount = 0;
let gridEnd = -1;

while (divCount < 2 && searchPos < content.length) {
  const nextClose = content.indexOf('</div>', searchPos);
  if (nextClose === -1) break;
  divCount++;
  if (divCount === 2) {
    gridEnd = nextClose + 6; // include the closing tag
  }
  searchPos = nextClose + 6;
}

console.log('Grid end:', gridEnd);
console.log('Grid section length:', gridEnd - gridStart);

// Show what we're replacing
const oldSection = content.substring(gridStart, gridEnd);
console.log('Old section first 200 chars:', JSON.stringify(oldSection.substring(0, 200)));
console.log('Old section last 100 chars:', JSON.stringify(oldSection.substring(oldSection.length - 100)));

// Count trade pills in old section
const pillCount = (oldSection.match(/class=\"trade-pill\"/g) || []).length;
console.log('Trade pills in old section:', pillCount);

// Build new section
const newTrades = [
  '🔧 Plumber',
  '⚡ Electrician',
  '🌿 Lawn Care',
  '🏊 Pool Cleaning',
  '🧹 Carpet Cleaning',
  '🐛 Pest Control',
  '🧽 Commercial Cleaning',
  '🧱 Bricklayer',
  '🪨 Concreter',
  '🎨 Painter',
  '🏗️ Renderer',
  '🛁 Tiler',
  '🪞 Plasterer',
  '🔩 Roofer',
  '🪵 Fencer',
  '💧 Waterproofer',
  '+ Tradie (general)',
];

const newPills = newTrades.map(name => `            <div class=\"trade-pill\">${name}</div>`).join('\n');
const newSection = `<div class=\"trades-grid\">\n${newPills}\n        </div>`;

console.log('New section first 200 chars:', JSON.stringify(newSection.substring(0, 200)));

// Replace
content = content.substring(0, gridStart) + newSection + content.substring(gridEnd);
console.log('✓ Trades grid updated to 17 trades');

// Add operator selector screenshot section after the hero
// Find the closing </section> of the hero section
const heroSectionEnd = content.indexOf('<hr class=\"divider\">', content.indexOf('hero-screenshot-overlay'));
console.log('Hero section ends at:', heroSectionEnd);

// Find the exact </div> for the hero-screenshot-overlay
const overlayClose = content.indexOf('</div>\n</section>', heroSectionEnd - 200);
const heroEnd = overlayClose + 14; // include </div>\n</section>

// Find the next section start (Section 2: MEET HUGO)
const section2Start = content.indexOf('<!-- ─── SECTION 2: MEET HUGO ─── -->');
console.log('Section 2 starts at:', section2Start);

// Build the operator selector section
const operatorSelectorSection = `
</div>
    </div>
</section>

<hr class=\"divider\">

<!-- ─── OPERATOR SELECTOR ─── -->
<section id=\"trade-selector\" style=\"padding: 5rem 0;\">
    <div class=\"container\">
        <div class=\"section-header center\">
            <div class=\"section-eyebrow\">Industry Coverage</div>
            <h2 class=\"section-title\">Works for your trade.</h2>
            <p class=\"section-sub\">Select your trade type when setting up Hugo — tailored responses from day one.</p>
        </div>
        <div class=\"screenshot-block\" style=\"max-width: 900px; margin: 0 auto;\">
            <img src=\"https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_55743/images/b86a5712-80a4-44fb-9d91-ab7a472af8f1.png\"
                 alt=\"Operator type selector — 17 trade categories\" loading=\"eager\">
        </div>
    </div>
</section>

<hr class=\"divider\">

<!-- ─── SECTION 2: MEET HUGO ─── -->
`;

// Find the exact end of hero section
const heroClosing = content.indexOf('<hr class=\"divider\">', content.indexOf('hero-screenshot-overlay'));
const heroSectionClosing = content.lastIndexOf('</section>', heroClosing);
const insertPoint = heroSectionClosing + '</section>'.length;

content = content.substring(0, insertPoint) + '\n\n<hr class=\"divider\">\n\n<!-- ─── OPERATOR SELECTOR ─── -->\n<section id=\"trade-selector\" style=\"padding: 5rem 0;\">\n    <div class=\"container\">\n        <div class=\"section-header center\">\n            <div class=\"section-eyebrow\">Industry Coverage</div>\n            <h2 class=\"section-title\">Works for your trade.</h2>\n            <p class=\"section-sub\">Select your trade type when setting up Hugo — tailored responses from day one.</p>\n        </div>\n        <div class=\"screenshot-block\" style=\"max-width: 900px; margin: 0 auto;\">\n            <img src=\"https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_55743/images/b86a5712-80a4-44fb-9d91-ab7a472af8f1.png\"\n                 alt=\"Operator type selector — 17 trade categories\" loading=\"eager\">\n        </div>\n    </div>\n</section>\n\n<hr class=\"divider\">\n\n' + content.substring(insertPoint);

console.log('✓ Added operator selector section');

fs.writeFileSync('public/propops-trade.html', content);
console.log('✓ File saved!');

// Verify
const finalContent = fs.readFileSync('public/propops-trade.html', 'utf8');
const newPillCount = (finalContent.match(/class=\"trade-pill\"/g) || []).length;
console.log('Final trade pill count:', newPillCount);
console.log('Contains operator selector image:', finalContent.includes('b86a5712-80a4-44fb-9d91-ab7a472af8f1'));
console.log('Contains 17+ trades in pricing:', finalContent.includes('All 17+ supported trades'));