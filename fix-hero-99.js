const fs = require('fs');
const path = 'public/trades.html';
let c = fs.readFileSync(path, 'utf8');

// Fix hero line 1099
const old = 'Hugo does both for <span class=\"price\">$99.</span>';
const replacement = 'Hugo does both for <span class=\"price\">$69.</span>';
if (c.includes(old)) {
  c = c.split(old).join(replacement);
  console.log('✅ Fixed hero line: Hugo does both for $69');
} else {
  // Try with single quotes in HTML
  const idx = c.indexOf('Hugo does both for');
  const actual = c.substring(idx, idx+100);
  console.log('NOT FOUND. Actual:', JSON.stringify(actual));
}

// Also fix the Standard card Stripe link in index.html (it should use $99 link or none)
// Check current Standard card CTA link
const indexContent = fs.readFileSync('public/index.html', 'utf8');
const standardCardIdx = indexContent.indexOf('>Standard</div>');
if (standardCardIdx !== -1) {
  const snippet = indexContent.substring(standardCardIdx - 200, standardCardIdx + 500);
  console.log('\nStandard card context:');
  console.log(snippet.substring(0, 400));
}

// Write the trades fix
fs.writeFileSync(path, c);
console.log('\nFile written.');