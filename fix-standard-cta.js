const fs = require('fs');
let c = fs.readFileSync('public/index.html', 'utf8');

// Find the Standard card and fix its CTA link
// The Standard card ends just before <!-- Annual -->
const standardEndMarker = '<!-- Annual -->';
const annualIdx = c.indexOf(standardEndMarker);
if (annualIdx === -1) {
  console.log('Could not find Annual marker');
  process.exit(1);
}

// Find the Standard card block (it's right before <!-- Annual -->)
const standardCardStart = c.lastIndexOf('<!-- Standard -->', annualIdx);
if (standardCardStart === -1) {
  console.log('Could not find Standard card');
  process.exit(1);
}

const standardBlock = c.substring(standardCardStart, annualIdx);

// Find the CTA link in the Standard block
const ctaLink = 'https://buy.stripe.com/9B63cvams0H37VvfkEdby09';
const correctLink = 'https://buy.stripe.com/dRmbJ1bqw89v4Jj0pKdby0a';

if (standardBlock.includes(ctaLink)) {
  const newBlock = standardBlock.split(ctaLink).join(correctLink);
  c = c.substring(0, standardCardStart) + newBlock + c.substring(annualIdx);
  fs.writeFileSync('public/index.html', c);
  console.log('✅ Fixed Standard card CTA: now uses $69 early bird link');
} else {
  console.log('Standard card CTA already correct or has different link');
  // Show what link it has
  const hrefIdx = standardBlock.indexOf('href=');
  if (hrefIdx !== -1) {
    const start = standardBlock.indexOf('>', hrefIdx) - 1;
    const end = standardBlock.indexOf('</a>', hrefIdx);
    const link = standardBlock.substring(hrefIdx, end);
    console.log('Current link:', link);
  }
}