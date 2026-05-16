const fs = require('fs');
const c = fs.readFileSync('/opt/polsia/workspaces/company-55743/agent-30/exec-2056856/relio-2/public/index.html', 'utf8');
const l = c.split('\n');
console.log('Line 3160:', JSON.stringify(l[3159]));
// Also show a few bytes around the apostrophe
const idx = l[3159].indexOf('That');
if (idx >= 0) {
  console.log('Around That:', JSON.stringify(l[3159].substring(idx, idx+15)));
}