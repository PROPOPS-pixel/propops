const fs = require('fs');
let c = fs.readFileSync('public/index.html', 'utf8');

// Find the FAQ section HTML
const faqSectionStart = c.indexOf('<section class=\u0022faq-section\u0022 id=\u0022faq\u0022>');
const faqSectionEnd = c.indexOf('</section>', faqSectionStart) + 10;

// Extract the FAQ section
const faqSection = c.substring(faqSectionStart, faqSectionEnd);

// Find faq-list div boundaries
const faqListStart = faqSection.indexOf('<div class=\u0022faq-list\u0022>');
const afterFaqListOpen = faqSection.substring(faqListStart + '<div class=\u0022faq-list\u0022>'.length);
const faqListDivClose = afterFaqListOpen.indexOf('</div>');

// The full old faq-list block = from '<div class=&quot;faq-list&quot;>' to '</div>' (the closing of faq-list)
const oldFaqListStart = faqListStart;
const oldFaqListEnd = faqListStart + '<div class=\u0022faq-list\u0022>'.length + faqListDivClose + '</div>'.length;
const oldFaqList = faqSection.substring(oldFaqListStart, oldFaqListEnd);

console.log('Old faq-list length:', oldFaqList.length);
console.log('Old faq-list preview:', JSON.stringify(oldFaqList.substring(0, 100)));

const newFaqList = `<div class=&quot;faq-list&quot;>

            <details class=&quot;faq-item&quot;>
                <summary class=&quot;faq-question&quot;>
                    <h4>How fast does PropOps respond to leads?</h4>
                    <span class=&quot;faq-chevron&quot;>+</span>
                </summary>
                <p class=&quot;faq-answer&quot;>Seconds, not hours. Average response time is under 6 seconds.</p>
            </details>

            <details class=&quot;faq-item&quot;>
                <summary class=&quot;faq-question&quot;>
                    <h4>Do I need to change my workflow?</h4>
                    <span class=&quot;faq-chevron&quot;>+</span>
                </summary>
                <p class=&quot;faq-answer&quot;>No. Just forward your portal emails to your unique PropOps address. We handle the rest.</p>
            </details>

            <details class=&quot;faq-item&quot;>
                <summary class=&quot;faq-question&quot;>
                    <h4>What portals does it work with?</h4>
                    <span class=&quot;faq-chevron&quot;>+</span>
                </summary>
                <p class=&quot;faq-answer&quot;>REA, Domain, and any manual email forwards.</p>
            </details>

            <details class=&quot;faq-item&quot;>
                <summary class=&quot;faq-question&quot;>
                    <h4>Is there a contract?</h4>
                    <span class=&quot;faq-chevron&quot;>+</span>
                </summary>
                <p class=&quot;faq-answer&quot;>No lock-in. Cancel anytime.</p>
            </details>

            <details class=&quot;faq-item&quot;>
                <summary class=&quot;faq-question&quot;>
                    <h4>Does it work on mobile?</h4>
                    <span class=&quot;faq-chevron&quot;>+</span>
                </summary>
                <p class=&quot;faq-answer&quot;>Yes — works best in Safari on iPhone for a full-screen experience.</p>
            </details>

            <details class=&quot;faq-item&quot;>
                <summary class=&quot;faq-question&quot;>
                    <h4>Can I edit the AI responses?</h4>
                    <span class=&quot;faq-chevron&quot;>+</span>
                </summary>
                <p class=&quot;faq-answer&quot;>Every AI-generated email includes an Edit &amp; Resend button in your dashboard. Review, personalize, or send a follow-up. PropOps responds instantly — you keep full control.</p>
            </details>

            <details class=&quot;faq-item&quot;>
                <summary class=&quot;faq-question&quot;>
                    <h4>How much does it cost?</h4>
                    <span class=&quot;faq-chevron&quot;>+</span>
                </summary>
                <p class=&quot;faq-answer&quot;>$149/month or $999/year. 14-day free trial, no credit card required.</p>
            </details>

        </div>`;

if (faqSection.includes(oldFaqList)) {
    const newFaqSection = faqSection.replace(oldFaqList, newFaqList);
    const newContent = c.substring(0, faqSectionStart) + newFaqSection + c.substring(faqSectionEnd);
    fs.writeFileSync('public/index.html', newContent);
    console.log('FAQ updated successfully!');
    console.log('New faq-list length:', newFaqList.length);
} else {
    console.log('ERROR: old faq-list not found in FAQ section!');
    console.log('Looking for length:', oldFaqList.length);
    console.log('First 200 chars of old:', JSON.stringify(oldFaqList.substring(0, 200)));
}