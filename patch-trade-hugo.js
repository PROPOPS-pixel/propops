const fs = require('fs');
const path = '/opt/polsia/workspaces/company-55743/agent-30/exec-2056856/relio-2/public/propops-trade.html';
let content = fs.readFileSync(path, 'utf8');

// Add Hugo promo section between pricing end and footer
// Find the second copy's pricing end
const pricingEndMarker = '<!-- ─── FOOTER ─── -->';
const idx = content.indexOf(pricingEndMarker);
if (idx < 0) {
  console.log('Footer marker not found!');
} else {
  const hugoPromo = `
<!-- HUGO PROMO (replaces any Q&A — no static FAQ on this page) -->
<section class=\"hugo-promo\" style=\"background:#f0f4ff;padding:4rem 0;text-align:center;\">
    <div class=\"container\" style=\"max-width:680px;margin:0 auto;\">
        <div style=\"font-size:0.75rem;font-weight:700;color:var(--blue);letter-spacing:0.12em;text-transform:uppercase;margin-bottom:1rem;\">Ask Hugo instead</div>
        <h2 style=\"font-size:1.6rem;font-weight:800;color:var(--slate-dark);margin-bottom:0.75rem;\">Got questions? Hugo\u2019s got answers \u2014 and handles your entire onboarding.</h2>
        <p style=\"color:var(--text-muted);margin-bottom:2rem;font-size:1rem;\">Skip the static FAQ. Hugo is your live assistant \u2014 answers questions instantly, helps you set up, and walks you through every feature before you even sign up.</p>
        <button onclick=\"openHugoChat()\" type=\"button\" style=\"background:var(--blue);color:white;padding:0.875rem 2rem;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(37,99,235,0.25);\">Chat with Hugo \u2192</button>
    </div>
</section>

`;

  // Insert Hugo promo before the FOOTER marker (in both copies if there are two)
  // But we need to add it only once - the footer marker appears once in the second copy
  // Actually the marker might appear twice (once in each copy). Let me replace only the SECOND occurrence.
  // Count how many times the marker appears before inserting.
  const firstIdx = content.indexOf(pricingEndMarker);
  const secondIdx = content.indexOf(pricingEndMarker, firstIdx + 1);

  if (secondIdx >= 0) {
    // There are two copies - insert Hugo promo in both
    content = content.split(pricingEndMarker).join(pricingEndMarker + '\n' + hugoPromo);
    console.log('\u2713 Added Hugo promo in BOTH copies (before footer)');
  } else {
    // Only one occurrence
    content = content.replace(pricingEndMarker, pricingEndMarker + '\n' + hugoPromo);
    console.log('\u2713 Added Hugo promo before footer');
  }
}

fs.writeFileSync(path, content, 'utf8');
console.log('Done. Hugo promo added to propops-trade.html');

// Verify
const updated = fs.readFileSync(path, 'utf8');
const promoCount = (updated.match(/Ask Hugo instead/g) || []).length;
console.log('Hugo promo sections: ' + promoCount);