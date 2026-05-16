const fs = require('fs');
const c = fs.readFileSync('public/index.html', 'utf8');

// Find the actual FAQ section HTML
const faqSectionHtmlStart = c.indexOf('<section class=\u0022faq-section\u0022 id=\u0022faq\u0022>');
console.log('FAQ section HTML starts at:', faqSectionHtmlStart);

// Extract the FAQ section content
const faqSectionEnd = c.indexOf('</section>', faqSectionHtmlStart) + 10;
const faqContent = c.substring(faqSectionHtmlStart, faqSectionEnd);
console.log('FAQ content length:', faqContent.length);

// Find the faq-list inside the section
const faqListStart = faqContent.indexOf('<div class=\u0022faq-list\u0022>');
console.log('faq-list within section at offset:', faqListStart);

// Find where the faq-list div closes
const faqListDivCloseIdx = faqContent.indexOf('</div>', faqListStart + 20);
console.log('faq-list div close at offset:', faqListDivCloseIdx);

// Find the closing of the faq-list wrapper (</div> that closes .faq-list)
const faqListCloseContent = faqContent.substring(faqListStart, faqListDivCloseIdx + 6);
console.log('\nfaq-list content (from <div class=faq-list> to </div>):');
console.log('Length:', faqListCloseContent.length);
console.log('Preview:', JSON.stringify(faqListCloseContent.substring(0, 200)));
console.log('...');
console.log('End:', JSON.stringify(faqListCloseContent.substring(faqListCloseContent.length - 100)));