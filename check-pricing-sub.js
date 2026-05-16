const fs = require('fs');
const content = fs.readFileSync('/opt/polsia/workspaces/company-55743/agent-30/exec-2056856/relio-2/public/index.html', 'utf8');
// Find the pricing subtext line
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('That') && lines[i].includes('coffee')) {
    console.log('Line ' + (i+1) + ':', JSON.stringify(lines[i]));
  }
}
// Also search for any instance of the pattern
const patterns = [
  'That\u2019s $3.30/day',  // U+2019
  'That\u0027s $3.30/day',  // ASCII apostrophe
  'That\u2018s $3.30/day',  // U+2018
  'That s $3.30/day',       // no apostrophe
];
for (const p of patterns) {
  console.log(p + ' : ' + (content.includes(p) ? 'FOUND' : 'MISSING'));
}
// Show exact bytes of the line
const idx = content.indexOf('coffee</p>');
if (idx > 0) {
  const start = Math.max(0, idx - 100);
  const snippet = content.substring(start, idx + 10);
  console.log('Snippet around coffee:</p>:', JSON.stringify(snippet));
}