const fs = require('fs');
const content = fs.readFileSync('/opt/polsia/workspaces/company-55743/agent-30/exec-2056856/relio-2/public/index.html', 'utf8');
const line3160 = content.split('\n')[3159]; // 0-indexed
console.log('Line 3160 bytes:', JSON.stringify(line3160.substring(0, 80)));
// Check form note lines
const formNoteLines = content.split('\n').filter(l => l.includes('form-note') && l.includes('99'));
console.log('Form note lines:', formNoteLines.map(l => JSON.stringify(l.trim())));