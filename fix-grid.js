const fs = require('fs');
let content = fs.readFileSync('public/propops-trade.html', 'utf8');

console.log('File size before:', content.length);

// 1. Verify pricing is updated
if (content.includes('All 17+ supported trades')) {
  console.log('✓ Pricing already updated');
} else {
  content = content.replace('All 22+ supported trades', 'All 17+ supported trades');
  console.log('✓ Pricing updated to 17+');
}

// 2. Find and replace the entire trades-grid section
// The trades-grid div starts with <div class=\"trades-grid\"> and ends when we close it
// We need to find: <div class=\"trades-grid\"> + all contents + </div>

const gridDivStart = '<div class=\"trades-grid\">';
const gridStartIdx = content.indexOf(gridDivStart);
console.log('Grid div starts at:', gridStartIdx);

if (gridStartIdx === -1) {
  console.log('ERROR: Could not find trades-grid div');
  process.exit(1);
}

// We need to find the matching </div> for the grid - not just any </div>
// Strategy: find the 22nd occurrence of <div class=\"trade-pill\"> after gridStart, then find the next </div>
// OR: scan through and find the </div> that closes the trades-grid div

// Since we know the old grid had exactly 22 trade-pill divs, let's find the grid end by:
// 1. Find the grid start
// 2. Search for </div> after the 22nd trade-pill close tag

let searchPos = gridStartIdx + gridDivStart.length;
let pillCloseCount = 0;
let gridEndIdx = -1;

// Count closing tags after trade-pill opening tags
// When we see a <div class=\"trade-pill\">...</div>, that's one pill
// We need to find the </div> that closes the GRID div, which comes AFTER the last pill

// Alternative approach: find the grid start, then scan for the grid's closing </div>
// by tracking the nesting level. Grid div starts at gridStartIdx.
// We need to find the </div> at nesting level 0 (the grid div's own close tag)

let depth = 1; // we're inside the grid div
searchPos = gridStartIdx + gridDivStart.length;

while (depth > 0 && searchPos < content.length) {
  const nextOpenDiv = content.indexOf('<div', searchPos);
  const nextCloseDiv = content.indexOf('</div>', searchPos);

  if (nextCloseDiv === -1) break;

  if (nextOpenDiv !== -1 && nextOpenDiv < nextCloseDiv) {
    // An opening div inside the grid
    // But check if it's a trade-pill (which we know we'll close within)
    const nextTag = content.substring(nextOpenDiv, nextOpenDiv + 50);
    if (nextTag.includes('trade-pill')) {
      // This is a pill - find its closing </div>
      searchPos = nextOpenDiv + 1;
      // Find the closing </div> for this pill
      const pillClose = content.indexOf('</div>', searchPos);
      if (pillClose !== -1) {
        searchPos = pillClose + 6;
      }
    } else {
      // Some other div - increment depth
      depth++;
      searchPos = nextOpenDiv + 5;
    }
  } else {
    // A closing div
    depth--;
    if (depth === 0) {
      gridEndIdx = nextCloseDiv + 6; // include the </div> tag
    } else {
      searchPos = nextCloseDiv + 6;
    }
  }
}

console.log('Grid ends at:', gridEndIdx);
const oldGrid = content.substring(gridStartIdx, gridEndIdx);
console.log('Old grid length:', oldGrid.length);

// Count pills in old grid to verify
const oldPillCount = (oldGrid.match(/class=\"trade-pill\">/g) || []).length;
console.log('Old grid pill count:', oldPillCount);

// Build new grid with 17 trades
const newTrades = [
  { icon: '🔧', name: 'Plumber' },
  { icon: '⚡', name: 'Electrician' },
  { icon: '🌿', name: 'Lawn Care' },
  { icon: '🏊', name: 'Pool Cleaning' },
  { icon: '🧹', name: 'Carpet Cleaning' },
  { icon: '🐛', name: 'Pest Control' },
  { icon: '🧽', name: 'Commercial Cleaning' },
  { icon: '🧱', name: 'Bricklayer' },
  { icon: '🪨', name: 'Concreter' },
  { icon: '🎨', name: 'Painter' },
  { icon: '🏗️', name: 'Renderer' },
  { icon: '🛁', name: 'Tiler' },
  { icon: '🪞', name: 'Plasterer' },
  { icon: '🔩', name: 'Roofer' },
  { icon: '🪵', name: 'Fencer' },
  { icon: '💧', name: 'Waterproofer' },
  { icon: '+', name: 'Tradie (general)' },
];

const pillsHtml = newTrades.map(t =>
  `            <div class=\"trade-pill\">${t.icon} ${t.name}</div>`
).join('\n');

const newGrid = `<div class=\"trades-grid\">\n${pillsHtml}\n        </div>`;
console.log('New grid pill count:', newTrades.length);

// Replace
content = content.substring(0, gridStartIdx) + newGrid + content.substring(gridEndIdx);
console.log('✓ Trades grid replaced with 17 trades');

// 3. Add operator selector screenshot after the hero
// Find the end of the hero section (the section with id=hero)
// The hero section ends with </section>
// After the hero section, find the <hr class=\"divider\"> and then the next section

const heroSectionEnd = content.indexOf('<hr class=\"divider\">', content.indexOf('id=\"hero\"'));
console.log('Hero divider at:', heroSectionEnd);

// Find the section closing tag for the hero
const heroSectionClose = content.indexOf('</section>', heroSectionEnd);
const insertAt = heroSectionClose + '</section>'.length;
console.log('Insert operator selector section after:', insertAt);

const operatorSection = `

<hr class=\"divider\">

<!-- ─── OPERATOR SELECTOR ─── -->
<section id=\"trade-selector\" style=\"padding: 5rem 0; background: var(--dark2);\">
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

`;

content = content.substring(0, insertAt) + operatorSection + content.substring(insertAt);
console.log('✓ Operator selector section added');

// Save
fs.writeFileSync('public/propops-trade.html', content);
console.log('✓ File saved!');

// Verify
const finalContent = fs.readFileSync('public/propops-trade.html', 'utf8');
const finalPillMatches = finalContent.match(/class=\"trade-pill\">([^<]+)<\/div>/g);
const totalPills = (finalPillMatches || []).length;
console.log('\nFinal verification:');
console.log('Total trade pills:', totalPills, totalPills === 17 ? '✓' : '✗ (expected 17)');
console.log('Has operator selector image:', finalContent.includes('b86a5712-80a4-44fb-9d91-ab7a472af8f1') ? '✓' : '✗');
console.log('Has 17+ in pricing:', finalContent.includes('All 17+ supported trades') ? '✓' : '✗');

// Show all pills
if (finalPillMatches) {
  console.log('\nAll trade pills:');
  finalPillMatches.forEach((m, i) => console.log(`  ${i + 1}. ${m.replace('class=\"trade-pill\">', '').replace('</div>', '')}`));
}

console.log('\nFile size after:', finalContent.length);