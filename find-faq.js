const fs = require('fs');
const content = fs.readFileSync('public/index.html', 'utf8');

// Find the FAQ list section
const faqStart = content.indexOf('<section class=\"faq-section\"');
const faqEnd = content.indexOf('</section>', faqStart) + '</section>'.length;
const faqSection = content.substring(faqStart, faqEnd);

console.log('FAQ section length:', faqSection.length);
console.log('\n--- FAQ SECTION CONTENT ---');
console.log(faqSection);