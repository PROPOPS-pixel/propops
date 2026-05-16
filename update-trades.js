const fs = require('fs');
let content = fs.readFileSync('public/propops-trade.html', 'utf8');

// 1. Update pricing: 22+ → 17+
content = content.replace('All 22+ supported trades', 'All 17+ supported trades');
console.log('1. Updated 22+ → 17+ in pricing:', content.includes('All 17+ supported trades'));

// 2. Replace trades grid: replace the entire trades-grid div content
const oldStart = '<div class=trades-grid>';
const oldEnd = '</div>\n        </div>\n    </div>\n</section>';

// Find the trades grid section
const tradesGridStart = content.indexOf(oldStart);
const tradesGridEnd = content.indexOf(oldEnd, tradesGridStart);

if (tradesGridStart === -1) {
  console.log('ERROR: Could not find trades grid start');
} else {
  const newTradesGrid = `<div class=trades-grid>
            <div class=trade-pill>🔧 Plumber</div>
            <div class=trade-pill>⚡ Electrician</div>
            <div class=trade-pill>🌿 Lawn Care</div>
            <div class=trade-pill>🏊 Pool Cleaning</div>
            <div class=trade-pill>🧹 Carpet Cleaning</div>
            <div class=trade-pill>🐛 Pest Control</div>
            <div class=trade-pill>🧽 Commercial Cleaning</div>
            <div class=trade-pill>🧱 Bricklayer</div>
            <div class=trade-pill>🪨 Concreter</div>
            <div class=trade-pill>🎨 Painter</div>
            <div class=trade-pill>🏗️ Renderer</div>
            <div class=trade-pill>🛁 Tiler</div>
            <div class=trade-pill>🪞 Plasterer</div>
            <div class=trade-pill>🔩 Roofer</div>
            <div class=trade-pill>🪵 Fencer</div>
            <div class=trade-pill>💧 Waterproofer</div>
            <div class=trade-pill>+ Tradie (general)</div>
        </div>`;

  // Find the exact section (from start of <div class=trades-grid> to the closing </div> of the grid)
  const sectionStart = content.lastIndexOf('<div class=trades-grid>', tradesGridStart);
  const sectionEnd = content.indexOf('</div>\n        </div>\n    </div>\n</section>', tradesGridStart);

  console.log('Grid section found:', sectionStart !== -1, sectionEnd !== -1);

  // Replace just the grid items - we need to find from <div class=trades-grid> to the next </div>
  // Then replace just the inner items
  const gridStart = content.indexOf('<div class=trades-grid>', sectionStart);
  const gridContentEnd = content.indexOf('</div>\n        </div>\n    </div>\n</section>', gridStart);
  const gridEnd = gridContentEnd + '</div>\n        </div>\n    </div>\n</section>'.length;

  console.log('Grid start:', gridStart, 'Grid end:', gridEnd);

  const newSection = `<div class=trades-grid>
            <div class=trade-pill>🔧 Plumber</div>
            <div class=trade-pill>⚡ Electrician</div>
            <div class=trade-pill>🌿 Lawn Care</div>
            <div class=trade-pill>🏊 Pool Cleaning</div>
            <div class=trade-pill>🧹 Carpet Cleaning</div>
            <div class=trade-pill>🐛 Pest Control</div>
            <div class=trade-pill>🧽 Commercial Cleaning</div>
            <div class=trade-pill>🧱 Bricklayer</div>
            <div class=trade-pill>🪨 Concreter</div>
            <div class=trade-pill>🎨 Painter</div>
            <div class=trade-pill>🏗️ Renderer</div>
            <div class=trade-pill>🛁 Tiler</div>
            <div class=trade-pill>🪞 Plasterer</div>
            <div class=trade-pill>🔩 Roofer</div>
            <div class=trade-pill>🪵 Fencer</div>
            <div class=trade-pill>💧 Waterproofer</div>
            <div class=trade-pill>+ Tradie (general)</div>
        </div>
    </div>
</section>`;

  content = content.substring(0, gridStart) + newSection + content.substring(gridEnd);
  console.log('2. Updated trades grid to 17 trades');
}

fs.writeFileSync('public/propops-trade.html', content);
console.log('File saved successfully!');