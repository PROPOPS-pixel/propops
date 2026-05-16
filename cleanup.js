const fs = require('fs');
let content = fs.readFileSync('public/propops-trade.html', 'utf8');

console.log('File size:', content.length);

// Find ALL occurrences of trades-grid
const occurrences = [];
let pos = 0;
while ((pos = content.indexOf('<div class=\"trades-grid\">', pos)) !== -1) {
  occurrences.push(pos);
  pos++;
}
console.log('Trades-grid occurrences:', occurrences.length, 'at positions:', occurrences);

// For each occurrence, find the grid's close tag and show what pills are in it
for (let i = 0; i < occurrences.length; i++) {
  const start = occurrences[i];
  // Find the </div> that closes this grid (the one right after the last pill)
  // We need to track depth - grid starts at depth 1
  let scanPos = start + '<div class=\"trades-grid\">'.length;
  let depth = 1;
  let gridClosePos = -1;
  let pillCount = 0;

  while (depth > 0 && scanPos < content.length) {
    const nextOpen = content.indexOf('<div', scanPos);
    const nextClose = content.indexOf('</div>', scanPos);

    if (nextClose === -1) break;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Opening div
      const tag = content.substring(nextOpen, nextOpen + 50);
      if (tag.includes('trade-pill')) {
        // Skip this pill's opening and closing
        pillCount++;
        scanPos = nextOpen + 1;
        // Find this pill's close
        const pillClose = content.indexOf('</div>', scanPos);
        if (pillClose !== -1) scanPos = pillClose + 6;
      } else {
        depth++;
        scanPos = nextOpen + 5;
      }
    } else {
      // Closing div
      depth--;
      if (depth === 0) {
        gridClosePos = nextClose + 6;
      }
      scanPos = nextClose + 6;
    }

    if (scanPos > start + 50000) break;
  }

  const gridSection = content.substring(start, gridClosePos);
  console.log(`\nGrid ${i + 1}: starts at ${start}, closes at ${gridClosePos}`);
  console.log(`  Pill count: ${pillCount}`);
  console.log(`  First pill:`, content.substring(start, start + 200).match(/<div class=\"trade-pill\">([^<]+)<\/div>/));
  console.log(`  Last pill:`, gridSection.match(/<div class=\"trade-pill\">([^<]+)<\/div>/g)?.pop());
}

// Now: I need to find the FIRST trades-grid and replace it with the correct 17-pill version
// Then find and remove the SECOND trades-grid entirely

// Build the correct 17-pill grid
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

const correctGrid = `<div class=\"trades-grid\">\n${pillsHtml}\n        </div>`;

// Replace the FIRST trades-grid
const firstGridStart = occurrences[0];

// Find the first grid's close tag
let scanPos = firstGridStart + '<div class=\"trades-grid\">'.length;
let depth = 1;
let firstGridClose = -1;
while (depth > 0 && scanPos < content.length) {
  const nextOpen = content.indexOf('<div', scanPos);
  const nextClose = content.indexOf('</div>', scanPos);
  if (nextClose === -1) break;
  if (nextOpen !== -1 && nextOpen < nextClose) {
    const tag = content.substring(nextOpen, nextOpen + 50);
    if (tag.includes('trade-pill')) {
      scanPos = nextOpen + 1;
      const pillClose = content.indexOf('</div>', scanPos);
      if (pillClose !== -1) scanPos = pillClose + 6;
    } else {
      depth++;
      scanPos = nextOpen + 5;
    }
  } else {
    depth--;
    if (depth === 0) firstGridClose = nextClose + 6;
    scanPos = nextClose + 6;
  }
  if (scanPos > firstGridStart + 50000) break;
}

console.log('\nFirst grid: from', firstGridStart, 'to', firstGridClose);

// Replace first grid with correct version
content = content.substring(0, firstGridStart) + correctGrid + content.substring(firstGridClose);
console.log('✓ Replaced first grid with 17-pill version');

// Now find and remove the SECOND trades-grid (and any content between the old first grid close and new second grid)
// After the replacement, the second occurrence is at a different position
// Find the second <div class=\"trades-grid\"> in the NEW content
const newOccurrences = [];
pos = 0;
while ((pos = content.indexOf('<div class=\"trades-grid\">', pos)) !== -1) {
  newOccurrences.push(pos);
  pos++;
}
console.log('Trades-grid occurrences after first fix:', newOccurrences.length);

// If there's still a second grid, find and remove it
if (newOccurrences.length > 1) {
  const secondGridStart = newOccurrences[1];
  console.log('Second grid starts at:', secondGridStart);

  // Find second grid's close tag
  scanPos = secondGridStart + '<div class=\"trades-grid\">'.length;
  depth = 1;
  let secondGridClose = -1;
  while (depth > 0 && scanPos < content.length) {
    const nextOpen = content.indexOf('<div', scanPos);
    const nextClose = content.indexOf('</div>', scanPos);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const tag = content.substring(nextOpen, nextOpen + 50);
      if (tag.includes('trade-pill')) {
        scanPos = nextOpen + 1;
        const pillClose = content.indexOf('</div>', scanPos);
        if (pillClose !== -1) scanPos = pillClose + 6;
      } else {
        depth++;
        scanPos = nextOpen + 5;
      }
    } else {
      depth--;
      if (depth === 0) secondGridClose = nextClose + 6;
      scanPos = nextClose + 6;
    }
    if (scanPos > secondGridStart + 50000) break;
  }

  console.log('Second grid: from', secondGridStart, 'to', secondGridClose);

  if (secondGridClose !== -1) {
    // Remove the second grid entirely
    // But first check what's around it - we don't want to break the page structure
    // The grid should be inside a section, between section-header and the section close
    // Find what container the second grid is in

    // Look at what's before the second grid
    const beforeSecond = content.substring(Math.max(0, secondGridStart - 200), secondGridStart);
    console.log('Before second grid:');
    console.log(beforeSecond);

    // Look at what's after the second grid
    const afterSecond = content.substring(secondGridClose, secondGridClose + 200);
    console.log('After second grid:');
    console.log(afterSecond);

    // Check if the second grid is inside a container that ONLY has the grid
    // If so, we can remove the whole container
  }
}

// Save
fs.writeFileSync('public/propops-trade.html', content);
console.log('\n✓ Saved');

// Final check
const final = fs.readFileSync('public/propops-trade.html', 'utf8');
const allPills = (final.match(/class=\"trade-pill\">([^<]+)<\/div>/g) || []).length;
console.log('Final pill count:', allPills, allPills === 17 ? '✓' : '✗');
console.log('Final file size:', final.length);