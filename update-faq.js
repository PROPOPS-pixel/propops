const fs = require('fs');
let content = fs.readFileSync('public/index.html', 'utf8');

// Find the FAQ list
const faqListStart = content.indexOf('<div class=&quot;faq-list&quot;>');
const afterFaqList = content.indexOf('</div>\n\n        </div>\n    </div>\n</section>', faqListStart);
const faqListEnd = afterFaqList + '</div>\n\n        </div>\n    </div>\n</section>'.length;

const oldFaqList = content.substring(faqListStart, faqListEnd);

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

        </div>
    </div>
</section>`;

if (content.includes(oldFaqList)) {
    content = content.replace(oldFaqList, newFaqList);
    fs.writeFileSync('public/index.html', content);
    console.log('FAQ updated successfully!');
} else {
    console.log('Could not find old FAQ list');
    console.log('Looking for substring starting at:', faqListStart);
    console.log('Expected end at:', afterFaqList);
    // Show what's actually at the expected positions
    console.log('\nActual content from faq-list start:');
    console.log(JSON.stringify(content.substring(faqListStart, faqListStart + 200)));
}