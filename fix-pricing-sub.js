const fs = require('fs');
const path = '/opt/polsia/workspaces/company-55743/agent-30/exec-2056856/relio-2/public/index.html';
let content = fs.readFileSync(path, 'utf8');

// ASCII apostrophe (U+0027), em-dash (U+2014)
const oldStr = '<p style=\"font-size:0.82rem;color:var(--slate-light);margin-bottom:1.5rem;\">That' + String.fromCharCode(39) + 's $3.30/day \u2014 less than a coffee</p>';
const newStr = '<p style=\"font-size:0.82rem;color:var(--amber-dark);margin-bottom:1.5rem;font-weight:600;\">\u26a1 Locked at $69/mo forever \u2014 goes to $99/mo after June 30</p>';

if (content.includes(oldStr)) {
  content = content.replace(oldStr, newStr);
  console.log('\u2713 pricing subtext fixed');
} else {
  console.log('\u2717 pricing subtext NOT FOUND');
  console.log('Looking for:', JSON.stringify(oldStr));
  console.log('Actual line:');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('coffee')) {
      console.log('Line ' + (i+1) + ':', JSON.stringify(lines[i]));
    }
  }
}

fs.writeFileSync(path, content, 'utf8');