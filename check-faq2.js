const fs = require('fs');
const c = fs.readFileSync('public/index.html', 'utf8');
const faqStart = c.indexOf('<section class=\u0022faq-section\u0022');
const faqEnd = c.indexOf('</section>', faqStart) + 10;
const faqContent = c.substring(faqStart, faqEnd);
const matches = faqContent.match(/<h4>(.*?)<\/h4>/g);
console.log('FAQ h4 count:', matches ? matches.length : 0);
if (matches) matches.forEach(m => console.log(m));