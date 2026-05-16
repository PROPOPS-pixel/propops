const fs = require('fs');
let content = fs.readFileSync('public/propops-trade.html', 'utf8');

console.log('File size before:', content.length);

// Find all <div class=\"trades-grid\"> occurrences
const occurrences = [];
let pos = 0;
while ((pos = content.indexOf('<div class=\"trades-grid\">', pos)) !== -1) {
  occurrences.push(pos);
  pos++;
}
console.log('Trades-grid occurrences:', occurrences.length, 'at', occurrences);

if (occurrences.length < 2) {
  console.log('No duplicate to remove. Checking final state...');
  const pills = (content.match(/class=\"trade-pill\">/g) || []).length;
  console.log('Total pills:', pills);
  process.exit(0);
}

// The second grid starts at occurrences[1]
// We need to remove everything from the second grid's <div class=\"trades-grid\">
// through its containing </section>
//
// Strategy: Find what comes BEFORE the second grid - that's the section-header
// The section that contains the second grid should start with the section-header
// and end with </section>

const secondGridStart = occurrences[1];
console.log('Second grid at:', secondGridStart);

// Find what container the second grid is in
// Look backwards from the second grid start to find the opening <section> of the container
// The container section should contain: section-header + trades-grid + [old pills] + </section>
let containerStart = content.lastIndexOf('<section', secondGridStart);
if (containerStart === -1) containerStart = content.lastIndexOf('<div', secondGridStart);

console.log('Container starts at:', containerStart);

// Find the end of the container - it's the </section> that comes after the second grid
// We need to find the </section> that comes after the second grid's content
// First find where the second grid's content ends

// Find the </section> that comes after the second grid
let scanPos = secondGridStart;
let sectionDepth = 0;
let containerEnd = -1;

while (scanPos < content.length) {
  const nextOpenSection = content.indexOf('<section', scanPos);
  const nextCloseSection = content.indexOf('</section>', scanPos);

  if (nextCloseSection === -1) break;

  if (nextOpenSection !== -1 && nextOpenSection < nextCloseSection) {
    // Opening section
    sectionDepth++;
    scanPos = nextOpenSection + 8;
  } else {
    // Closing section
    sectionDepth--;
    if (sectionDepth < 0 || (containerStart !== -1 && nextCloseSection > secondGridStart)) {
      containerEnd = nextCloseSection + '</section>'.length;
      break;
    }
    scanPos = nextCloseSection + 9;
  }

  if (scanPos > secondGridStart + 20000) break;
}

console.log('Container end (</section>):', containerEnd);

if (containerEnd !== -1 && containerStart !== -1) {
  console.log('\nRemoving container from', containerStart, 'to', containerEnd);
  console.log('Container content (first 200 chars):');
  console.log(content.substring(containerStart, containerStart + 200));
  console.log('...');
  console.log('Container content (last 200 chars):');
  console.log(content.substring(containerEnd - 200, containerEnd));

  // Remove the entire container
  content = content.substring(0, containerStart) + content.substring(containerEnd);
  console.log('\n✓ Removed duplicate section');
} else {
  console.log('\nCould not find container boundaries. Trying alternative...');

  // Alternative: just remove the second <div class=\"trades-grid\"> section
  // Find the second grid start and remove through the next </section>
  const secondGridTag = '<div class=\"trades-grid\">';

  // Find all occurrences of the tag
  const allTagOccurrences = [];
  pos = 0;
  while ((pos = content.indexOf(secondGridTag, pos)) !== -1) {
    allTagOccurrences.push(pos);
    pos++;
  }
  console.log('Tag occurrences:', allTagOccurrences);

  if (allTagOccurrences.length >= 2) {
    const secondStart = allTagOccurrences[1];
    // Find the </section> after this tag
    const afterTag = content.indexOf('</section>', secondStart);
    console.log('</section> after second tag at:', afterTag);

    if (afterTag !== -1) {
      // Check what's between second tag and </section>
      const between = content.substring(secondStart, afterTag);
      console.log('Between second tag and </section>:');
      console.log(between.substring(0, 300));
      const pillCount = (between.match(/class=\"trade-pill\">/g) || []).length;
      console.log('Pills in this section:', pillCount);

      // Remove from second tag to </section>
      content = content.substring(0, secondStart) + content.substring(afterTag + '</section>'.length);
      console.log('✓ Removed second grid section');
    }
  }
}

// Save
fs.writeFileSync('public/propops-trade.html', content);
console.log('\n✓ Saved');

// Final check
const final = fs.readFileSync('public/propops-trade.html', 'utf8');
const totalPills = (final.match(/class=\"trade-pill\">/g) || []).length;
const gridCount = (final.match(/<div class=\"trades-grid\">/g) || []).length;

console.log('\nFinal verification:');
console.log('Total pills:', totalPills, totalPills === 17 ? '✓' : '✗ (expected 17)');
console.log('Total grids:', gridCount, gridCount === 1 ? '✓' : '✗ (expected 1)');
console.log('Has operator selector:', final.includes('b86a5712-80a4-44fb-9d91-ab7a472af8f1') ? '✓' : '✗');
console.log('Has 17+ in pricing:', final.includes('All 17+ supported trades') ? '✓' : '✗');
console.log('Final file size:', final.length);

// Show all pills
const allPillMatches = final.match(/class=\"trade-pill\">([^<]+)<\/div>/g);
if (allPillMatches) {
  console.log('\nAll trade pills:');
  allPillMatches.forEach((m, i) => {
    const name = m.replace('class=\"trade-pill\">', '').replace('</div>', '').trim();
    console.log(`  ${i + 1}. ${name}`);
  });
}