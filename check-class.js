const fs = require('fs');
const content = fs.readFileSync('public/propops-trade.html', 'utf8');
const idx = content.indexOf('trade-pill');
if (idx === -1) {
  console.log('NOT FOUND - checking with different approach');
  const match = content.match(/class=trade-pill[^>]*>/);
  if (match) console.log('Found:', JSON.stringify(match[0]));
  else console.log('Also not found with attr-only match');
} else {
  console.log('Sample from file:', JSON.stringify(content.substring(idx, idx + 40)));
}