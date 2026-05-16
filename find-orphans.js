const fs = require('fs');
let content = fs.readFileSync('public/propops-trade.html', 'utf8');

console.log('File size before:', content.length);

// Find the grid
const gridStart = content.indexOf('<div class=\"trades-grid\">');
const gridEnd = content.indexOf('</div>\n    </div>\n</section>', gridStart) + '</div>\n    </div>\n</section>'.length;
const gridSection = content.substring(gridStart, gridEnd);

const gridPills = (gridSection.match(/class=\"trade-pill\">/g) || []).length;
console.log('Grid pills:', gridPills, gridPills === 17 ? '✓' : '✗');

// Find orphaned pills - they appear after the grid
const afterGrid = content.substring(gridEnd);
const orphanPills = (afterGrid.match(/class=\"trade-pill\">/g) || []).length;
console.log('Orphaned pills after grid:', orphanPills);

if (orphanPills > 0) {
  // Find where the orphans start
  const orphanStart = content.indexOf('            <div class=\"trade-pill\">🔧 Plumber</div>', gridEnd);
  const orphanEnd = content.indexOf('</section>', orphanStart);

  // More specifically, the orphaned pills are:
  // 🧹 Cleaner, 🏗️ Builder, 🎨 Painter, 🌿 Landscaper, ❄️ HVAC...
  // They start after </section> closes the pricing section
  // Let me find the </section> that closes the pricing section and look after it

  const pricingSectionClose = content.indexOf('</section>', gridEnd);
  console.log('Pricing section closes at:', pricingSectionClose);

  // Find the divider after pricing
  const nextDivider = content.indexOf('<hr class=\"divider\">', pricingSectionClose);
  console.log('Next divider at:', nextDivider);

  // The orphaned pills should be between pricing </section> and the footer
  // Let's check what's between grid end and the next section
  const betweenGridAndNext = content.substring(gridEnd, nextDivider);
  console.log('Between grid and next divider:');
  console.log(betweenGridAndNext.substring(0, 200));

  const orphanedPillCount = (betweenGridAndNext.match(/class=\"trade-pill\">/g) || []).length;
  console.log('Orphaned pills in this range:', orphanedPillCount);
}

// Actually let me find ALL trade-pill occurrences in the file
const allPills = [];
let pos = 0;
while ((pos = content.indexOf('class=\"trade-pill\">', pos)) !== -1) {
  const end = content.indexOf('</div>', pos);
  const pillText = content.substring(pos + 'class=\"trade-pill\">'.length, end);
  allPills.push({ pos, text: pillText });
  pos++;
}

console.log('\nAll trade pills with positions:');
allPills.forEach((p, i) => console.log(`${i + 1}. pos=${p.pos}: ${p.text}`));
console.log('Total:', allPills.length);

// The first 17 are in the grid. The rest are orphaned.
// Find the last pill in the grid (pill 17) and the first orphan pill
const gridEndIdx = content.indexOf('</div>\n    </div>\n</section>', gridStart) + '</div>\n    </div>\n</section>'.length;
console.log('Grid ends at:', gridEndIdx);

const orphanedPills = allPills.filter(p => p.pos > gridEndIdx);
console.log('\nOrphaned pills:', orphanedPills.length);
if (orphanedPills.length > 0) {
  const firstOrphan = orphanedPills[0].pos;
  const lastOrphanEnd = orphanedPills[orphanedPills.length - 1].pos + orphanedPills[orphanedPills.length - 1].text.length + '</div>'.length;
  console.log('First orphan at:', firstOrphan, 'Last orphan ends at:', lastOrphanEnd);

  // Show what's between grid end and first orphan
  const between = content.substring(gridEndIdx, firstOrphan);
  console.log('Between grid end and first orphan:');
  console.log(JSON.stringify(between));

  // We need to remove from after </div> of the grid (which is gridEndIdx)
  // to the </section> that follows the orphaned pills

  // Find the </section> after the last orphan
  const sectionAfterOrphans = content.indexOf('</section>', lastOrphanEnd);
  console.log('Section after orphans at:', sectionAfterOrphans);

  // Also find the <hr class=divider> before the footer
  const footerDivider = content.indexOf('<hr class=\"divider\">', sectionAfterOrphans);
  console.log('Footer divider at:', footerDivider);

  // The orphans + their surrounding container need to be removed
  // The orphaned pills are inside <div class=trades-grid>...</div> which is inside some container
  // Find the container start
  const orphanContainerStart = content.lastIndexOf('<div class=\"section-header', firstOrphan);
  const orphanContainerEnd = sectionAfterOrphans + '</section>'.length;
  console.log('Orphan container from:', orphanContainerStart, 'to:', orphanContainerEnd);

  const orphanContainer = content.substring(orphanContainerStart, orphanContainerEnd);
  console.log('Orphan container content:');
  console.log(orphanContainer.substring(0, 300));
  console.log('...');
  console.log(orphanContainer.substring(orphanContainer.length - 200));

  // Check if this container contains ONLY orphaned pills (no other content)
  const hasOtherContent = orphanContainer.replace(/<div class=\"trade-pill\">[^<]+<\/div>/g, '').replace(/\n/g, '').replace(/<[^>]+>/g, '').trim();
  console.log('Has other content besides pills:', hasOtherContent.length > 0 ? hasOtherContent.substring(0, 100) : 'NO');
}