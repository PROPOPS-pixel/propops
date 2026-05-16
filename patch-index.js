// Script to apply all index.html changes
const fs = require('fs');
const path = '/opt/polsia/workspaces/company-55743/agent-30/exec-2056856/relio-2/public/index.html';
let content = fs.readFileSync(path, 'utf8');

const changes = [
  // 1. Stat section: $99 -> $69
  {
    old: '<div class=stat-number>$99</div>',
    new: '<div class=stat-number>$69</div>',
    label: 'stat $99 -> $69'
  },
  {
    old: '<div class=stat-label>Flat $99/mo AUD. No surprises.</div>',
    new: '<div class=stat-label>Flat $69/mo AUD. Locked in forever.</div>',
    label: 'stat label'
  },
  // 2. Form notes: $99 -> $69 early bird (two occurrences)
  {
    old: '<p class=form-note>14-day free trial \u00b7 $99/mo AUD \u00b7 No payment until day 15</p>',
    new: '<p class=form-note>14-day free trial \u00b7 <strong>$69/mo early bird</strong> (locked forever) \u00b7 No payment until day 15</p>',
    label: 'form note $99 -> $69'
  },
  // 3. Pricing card: badge, price, subtext, stripe link
  {
    old: '<div class=pricing-tier-badge>14-day free trial</div>',
    new: '<div class=pricing-tier-badge>30% off \u2014 before June 30</div>',
    label: 'pricing badge'
  },
  {
    old: '<span class=currency>$</span><span class=amount style=font-size:3rem;>99</span><span class=period>/mo</span>',
    new: '<span class=currency>$</span><span class=amount style=font-size:3rem;>69</span><span class=period>/mo</span>',
    label: 'pricing amount'
  },
  {
    old: '<p style=font-size:0.82rem;color:var(--slate-light);margin-bottom:1.5rem;>That\u2019s $3.30/day \u2014 less than a coffee</p>',
    new: '<p style=font-size:0.82rem;color:var(--amber-dark);margin-bottom:1.5rem;font-weight:600;>\u26a1 Locked at $69/mo forever \u2014 goes to $99/mo after June 30</p>',
    label: 'pricing subtext'
  },
  {
    old: '<a href=https://buy.stripe.com/8x23cvfGMcpLcbL3BWdby08 class=pricing-tier-cta target=_blank rel=noopener>Start Free Trial</a>',
    new: '<a href=https://buy.stripe.com/dRmbJ1bqw89v4Jj0pKdby0a class=pricing-tier-cta target=_blank rel=noopener>Start Free Trial</a>',
    label: 'monthly stripe link'
  },
  // 4. Comparison table: $99/mo -> $69/mo
  {
    old: '<span class=propops-price>$99/mo</span>',
    new: '<span class=propops-price>$69/mo</span>',
    label: 'comparison price'
  },
  // 5. FAQ section -> Hugo promo + trades cross-promo
  {
    old: '<details class=faq-item>\n                <summary class=faq-question>\n                    <h4>Can I edit the AI responses?</h4>\n                    <span class=faq-chevron>+</span>\n                </summary>\n                <p class=faq-answer>Every AI-generated email includes an Edit &amp; Resend button in your dashboard. Review, personalize, or send a follow-up. PropOps responds instantly \u2014 you keep full control.</p>\n            </details>\n\n            <details class=faq-item>\n                <summary class=faq-question>\n                    <h4>How much does it cost?</h4>\n                    <span class=faq-chevron>+</span>\n                </summary>\n                <p class=faq-answer>$99/month or $999/year (save 17%). 14-day free trial \u2014 no payment until day 15.</p>\n            </details>\n\n        </div>\n    </div>\n</section>\n\n<!-- FINAL CTA -->',
    new: '<details class=faq-item>\n                <summary class=faq-question>\n                    <h4>Can I edit the AI responses?</h4>\n                    <span class=faq-chevron>+</span>\n                </summary>\n                <p class=faq-answer>Every AI-generated email includes an Edit &amp; Resend button in your dashboard. Review, personalize, or send a follow-up. PropOps responds instantly \u2014 you keep full control.</p>\n            </details>\n\n        </div>\n    </div>\n</section>\n\n<!-- HUGO PROMO (replaces remaining FAQ items) -->\n<section style=background:var(--blue-bg);padding:4rem 0;border-top:1px solid rgba(37,99,235,0.1);>\n    <div class=container style=text-align:center;>\n        <div style=font-size:0.8rem;font-weight:700;color:var(--blue);letter-spacing:0.12em;text-transform:uppercase;margin-bottom:1rem;>Ask Hugo instead</div>\n        <h2 style=font-size:1.75rem;font-weight:800;color:var(--slate-dark);margin-bottom:0.75rem;>Got questions? Hugo answers them all \u2014 and handles your onboarding too.</h2>\n        <p style=color:var(--slate-mid);max-width:540px;margin:0 auto 2rem;font-size:1rem;>Skip the static FAQ. Hugo is your live assistant \u2014 answers questions instantly, helps you set up, and walks you through every feature before you even sign up.</p>\n        <button onclick=openHugoChat() type=button style=background:var(--blue);color:white;padding:0.875rem 2rem;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(37,99,235,0.3);>Chat with Hugo \u2192</button>\n    </div>\n</section>\n\n<!-- TRADES CROSS-PROMO -->\n<section style=background:#0a1628;padding:4rem 0;>\n    <div class=container style=text-align:center;>\n        <div style=font-size:0.8rem;font-weight:700;color:var(--amber);letter-spacing:0.12em;text-transform:uppercase;margin-bottom:1rem;>Also from PropOps</div>\n        <h2 style=font-size:1.75rem;font-weight:800;color:white;margin-bottom:0.75rem;>One Dashboard. Different themes and features for every trade.</h2>\n        <p style=color:rgba(255,255,255,0.6);max-width:560px;margin:0 auto 0.75rem;font-size:1rem;>Plumbers, electricians, painters, cleaners, handymen \u2014 PropOps has a dedicated version built for tradies. Same AI brain (Hugo), same job tracking, tailored for trade businesses.</p>\n        <p style=color:rgba(255,255,255,0.4);max-width:560px;margin:0 auto 2rem;font-size:0.875rem;>Different themes. Different features. All on one unified platform.</p>\n        <a href=https://propops.trade target=_blank rel=noopener style=display:inline-block;background:var(--amber);color:#0a1628;padding:0.875rem 2.25rem;border-radius:8px;font-size:1rem;font-weight:700;text-decoration:none;box-shadow:0 4px 14px rgba(245,158,11,0.3);>See PropOps for Tradies \u2192</a>\n    </div>\n</section>\n\n<!-- FINAL CTA -->',
    label: 'partial FAQ + trades cross-promo'
  }
];

let applied = 0;
let failed = 0;
for (const change of changes) {
  if (content.includes(change.old)) {
    content = content.replace(change.old, change.new);
    console.log('\u2713 ' + change.label);
    applied++;
  } else {
    console.log('\u2717 NOT FOUND: ' + change.label);
    console.log('  Looking for: ' + JSON.stringify(change.old.substring(0, 200)));
    failed++;
  }
}

fs.writeFileSync(path, content, 'utf8');
console.log('\n' + applied + ' changes applied, ' + failed + ' failed');