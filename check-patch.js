const fs = require('fs');
const path = '/opt/polsia/workspaces/company-55743/agent-30/exec-2056856/relio-2/public/index.html';
const content = fs.readFileSync(path, 'utf8');

// Check which patterns exist
const checks = [
  '<div class=stat-number>$99</div>',
  '<div class=stat-number>',
  '<div class=\"stat-number\">$99</div>',
  '<div class=\"stat-label\">Flat $99/mo AUD. No surprises.</div>',
  '<p class=form-note>14-day free trial \u00b7 $99/mo AUD \u00b7 No payment until day 15</p>',
  '<p class=\"form-note\">14-day free trial &middot; $99/mo AUD &middot; No payment until day 15</p>',
  '<div class=\"pricing-tier-badge\">14-day free trial</div>',
  '<span class=\"currency\">$</span><span class=\"amount\" style=\"font-size:3rem;\">99</span><span class=\"period\">/mo</span>',
  '<a href=\"https://buy.stripe.com/8x23cvfGMcpLcbL3BWdby08\" class=\"pricing-tier-cta\"',
  '<span class=\"propops-price\">$99/mo</span>',
  '<p style=\"font-size:0.82rem;color:var(--slate-light);margin-bottom:1.5rem;\">That\u2019s $3.30/day \u2014 less than a coffee</p>',
  '<p style=font-size:0.82rem;color:var(--slate-light);margin-bottom:1.5rem;>That\u2019s $3.30/day \u2014 less than a coffee</p>',
  '<details class=faq-item>',
  '<details class=\"faq-item\">',
];

for (const check of checks) {
  const found = content.includes(check);
  console.log((found ? 'FOUND  ' : 'MISSING') + ' ' + JSON.stringify(check));
}