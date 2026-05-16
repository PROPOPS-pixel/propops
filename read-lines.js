const fs = require('fs');
const lines = fs.readFileSync('/opt/polsia/workspaces/company-55743/agent-30/exec-2056856/relio-2/public/index.html', 'utf8').split('\n');
for (const i of [2721, 3338, 2881, 2882, 3190, 3153, 3157, 3168]) {
  console.log('Line ' + i + ': ' + JSON.stringify(lines[i-1]));
}