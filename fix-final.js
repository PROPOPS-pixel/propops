const fs = require('fs');
let content = fs.readFileSync('public/propops-trade.html', 'utf8');

// Strategy: find the grid div, then track depth manually
// Open divs add 1 to depth, close divs subtract 1
// When depth returns to 0, we've closed the grid div

const gridDivTag = '<div class=\"trades-grid\">';
const gridStart = content.indexOf(gridDivTag);
console.log('Grid div starts at:', gridStart);

if (gridStart === -1) {
  console.log('ERROR: no grid found');
  process.exit(1);
}

const afterGridStart = gridStart + gridDivTag.length;
let pos = afterGridStart;
let depth = 1;
let gridClosePos = -1;

console.log('Scanning for grid close...');
while (depth > 0 && pos < content.length) {
  const nextOpenDiv = content.indexOf('<div', pos);
  const nextCloseDiv = content.indexOf('</div>', pos);

  if (nextCloseDiv === -1) {
    console.log('ERROR: no closing div found');
    break;
  }

  // Check if next tag is a close div (no open div before it, or open div is further)
  const nextOpenBeforeClose = nextOpenDiv !== -1 && nextOpenDiv < nextCloseDiv;

  if (nextOpenBeforeClose) {
    // Next is an opening div - check what kind
    const tag = content.substring(nextOpenDiv, nextOpenDiv + 60);
    // Count <div in the tag string to skip multiple opens
    const divCount = (tag.match(/<div/g) || []).length;
    if (divCount > 1) {
      // Multiple divs in one tag (unlikely in our case but handle it)
      depth += divCount;
      pos = nextOpenDiv + 5;
    } else if (tag.includes('trade-pill')) {
      // This is a trade-pill div
      // Skip to its close
      pos = nextCloseDiv + 6; // after </div>
    } else {
      // Some other div inside the grid
      depth++;
      pos = nextOpenDiv + 5;
    }
  } else {
    // Next is a closing div
    depth--;
    if (depth === 0) {
      gridClosePos = nextCloseDiv + 6; // include the </div>
      console.log('Grid close found at:', gridClosePos);
    } else {
      pos = nextCloseDiv + 6;
    }
  }

  if (pos > gridStart + 50000) {
    console.log('ERROR: scan took too long, pos =', pos);
    break;
  }
}

console.log('Final depth:', depth);
console.log('Grid section: ', gridStart, 'to', gridClosePos);
console.log('Grid section length:', gridClosePos - gridStart);

// Count pills in this section
const gridContent = content.substring(gridStart, gridClosePos);
const pillCount = (gridContent.match(/class=\"trade-pill\">/g) || []).length;
console.log('Pills in grid:', pillCount);

// Show what the grid section looks like (first and last 200 chars)
console.log('\nGrid first 300 chars:');
console.log(gridContent.substring(0, 300));
console.log('\nGrid last 200 chars:');
console.log(gridContent.substring(gridContent.length - 200));

// Now REPLACE the grid section with the 17 new trades
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

// Replace the grid section
content = content.substring(0, gridStart) + newGrid + content.substring(gridClosePos);
console.log('\n✓ Grid replaced with 17 trades');

// Save
fs.writeFileSync('public/propops-trade.html', content);
console.log('✓ File saved!');

// Verify
const finalContent = fs.readFileSync('public/propops-trade.html', 'utf8');
const allPillMatches = finalContent.match(/class=\"trade-pill\">([^<]+)<\/div>/g);
const totalPills = (allPillMatches || []).length;
console.log('\nFinal verification:');
console.log('Total trade pills:', totalPills, totalPills === 17 ? '✓' : '✗');
console.log('Has operator selector:', finalContent.includes('b86a5712-80a4-44fb-9d91-ab7a472af8f1') ? '✓' : '✗');
console.log('Has 17+ in pricing:', finalContent.includes('All 17+ supported trades') ? '✓' : '✗');
if (allPillMatches) {
  console.log('\nAll trade pills:');
  allPillMatches.forEach((m, i) => {
    const name = m.replace('class=\"trade-pill\">', '').replace('</div>', '').trim();
    console.log(`  ${i + 1}. ${name}`);
  });
}