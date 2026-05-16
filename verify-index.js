const fs = require('fs');
const c = fs.readFileSync('/opt/polsia/workspaces/company-55743/agent-30/exec-2056856/relio-2/public/index.html', 'utf8');
const checks = [
  ['<div class=\"stat-number\">$69</div>', 'stat $69'],
  ['<div class=\"stat-label\">Flat $69/mo AUD. Locked in forever.</div>', 'stat label'],
  ['<strong>$69/mo early bird</strong>', 'form note updated'],
  ['<div class=\"pricing-tier-badge\">30% off', 'pricing badge'],
  ['<span class=\"amount\" style=\"font-size:3rem;\">69</span>', 'pricing $69'],
  ['Locked at $69/mo forever', 'pricing subtext'],
  ['buy.stripe.com/dRmbJ1bqw89v4Jj0pKdby0a', '$69 stripe link'],
  ['Ask Hugo instead', 'Hugo promo'],
  ['propops.trade', 'trades cross-promo'],
  ['One Dashboard. Different themes', 'trades cross-promo headline'],
  ['How much does it cost?', 'FAQ removed'],
  ['That' + String.fromCharCode(39) + 's $3.30/day', 'old subtext removed'],
  ['<span class=\"propops-price\">$69/mo</span>', 'comparison $69'],
  ['before June 30', 'urgency badge'],
  ['>99<', 'NO old $99 in pricing - checking...'],
];
let pass = 0, fail = 0;
for (const [str, label] of checks) {
  const found = c.includes(str);
  const status = found ? 'PASS' : 'FAIL';
  if (!found) {
    console.log(status + ': ' + label);
    console.log('  searching: ' + str.substring(0, 80));
    fail++;
  } else {
    pass++;
  }
}
console.log('\n' + pass + '/' + (pass+fail) + ' checks passed');
// Count remaining $99 references (should be 0 in pricing, could be elsewhere)
const count99 = (c.match(/\b99\b/g) || []).length;
console.log('\nRemaining $99 references in file: ' + count99);