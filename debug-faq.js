const fs = require('fs');
const c = fs.readFileSync('public/index.html', 'utf8');

// Find FAQ section
const faqIdx = c.indexOf('faq-section');
console.log('faq-section at:', faqIdx);

// Find faq-list
const faqListIdx = c.indexOf('faq-list');
console.log('faq-list at:', faqListIdx);

// Find the closing of faq-list div (</div> before the closing container divs)
const afterFaqList = c.indexOf('</div>', faqListIdx);
console.log('</div> after faq-list at:', afterFaqList);

// Check what follows
const afterDiv = c.substring(afterFaqList, afterFaqList + 100);
console.log('After </div>:', JSON.stringify(afterDiv));

// Find the full FAQ section
const sectionStart = c.indexOf('<section class=', faqIdx - 500);
const sectionEnd = c.indexOf('</section>', faqIdx) + 10;
const sectionContent = c.substring(sectionStart, sectionEnd);
console.log('\nFAQ Section preview:', JSON.stringify(sectionContent.substring(0, 300)));

// Look for the full replacement pattern
const fullEnd = c.indexOf('</section>', sectionEnd) + 10; // next </section>
console.log('Next section ends at:', fullEnd);

// Find where faq-list div actually closes
const faqListDivClose = c.indexOf('</div>', afterFaqList + 5);
console.log('faq-list div close at:', faqListDivClose);
const afterClose = c.substring(faqListDivClose, faqListDivClose + 80);
console.log('After faq-list close:', JSON.stringify(afterClose));