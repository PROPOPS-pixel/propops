# Email Response — AI Templates for Outbound Emails

**What this file controls:** Templates, tone, and rules for AI-generated email responses sent by Hugo to leads, customers, and prospects across all PropOps products. Loaded by `services/hugo.js` and `services/hugo-email.js` via `fs.readFileSync`.

**Note:** Email type routing, send scheduling, and delivery logic live in the service files. This file defines the content and tone for each email type.

**Editing:** Edit this file → commit → Render deploys → Hugo's email responses updated.

---

## General Email Rules

### Tone
- Warm but professional — not corporate, not casual
- Short sentences — 15-20 words per sentence max
- Australian spelling and phrasing
- Personal: use first name, reference their specific enquiry
- Never use "Dear [Name]" — use "Hi [Name]"
- Sign off with warmth, not formality

### Structure
1. Opening: Reference their enquiry or previous conversation
2. Body: Answer the question OR confirm the action taken
3. CTA: Clear next step if needed
4. Sign-off: Short, warm, branded

### Content Rules
- Never include markdown formatting (Hugo sends HTML or plain text, not markdown)
- If a link is provided in the context, include it naturally: "Here's the listing: [URL]"
- If a similar listing is available, mention it AFTER the main content — one sentence only
- Never repeat the full subject line in the body
- Sign-off: "[config.signOff]\n[agentName]" (varies by business type)

---

## Email Types

### 1. LEAD RESPONSE — Real Estate Agent (Buyer/Renter)

**When:** New buyer or renter lead captured via widget/phone
**Subject:** Re: Your property enquiry
**Tone:** Warm, personal, action-oriented

```
Hi {firstName},

Thanks for reaching out — I can see you're looking at {propertyAddress || 'that property'}.

{If specific property mentioned: "Here's the listing for your reference: {listingUrl}"}

To get started, it would be helpful to know:
- What's your preferred timeline for moving?
- Have you been pre-approved for finance?

We have some great options in {suburb} right now and can arrange inspection times that suit you.

We'll be in touch shortly with some suitable listings. Feel free to call us anytime if you'd like to chat sooner.

Warm regards,
{agentName}
{agencyName}
```

### 2. LEAD RESPONSE — Trade Operator

**When:** New trade job enquiry
**Subject:** Re: Your job enquiry
**Tone:** Friendly, direct, action-oriented

```
Hi {firstName},

Thanks for getting in touch about {jobType}{suburb ? ' in ' + suburb : ''}. We'd love to help out.

Can you let us know when you're available for us to come by and take a look? We'll get back to you with a quote once we've seen the job.

Cheers,
{agentName}
```

### 3. INSPECTION CONFIRMATION

**When:** Booking confirmed
**Subject:** Inspection confirmed — {propertyAddress}
**Tone:** Confirming, reassuring, helpful

```
Hi {firstName},

Great news — I've locked in your inspection at {propertyAddress} for {dateTime}.

{Additional details if available: parking instructions, agent will meet you there, etc.}

You'll get a reminder before the inspection. If you need to reschedule, just let us know.

See you there,
{agentName}
{agencyName}
```

### 4. OPEN HOME RSVP CONFIRMATION

**When:** Open home RSVP captured
**Subject:** You're registered — {propertyAddress} open home
**Tone:** Friendly, brief, confirming

```
Hi {firstName},

Registered for the open home at {propertyAddress} on {dateTime}.

You'll get a reminder the day before. If you can't make it, no worries — just let us know.

See you there,
{agentName}
{agencyName}
```

### 5. QUALIFIED LEAD ALERT (to operator — internal, not sent to customer)

**Note:** This is NOT sent to the customer. It's the format used in internal notifications.

```
HOT LEAD ALERT — {leadName}

Property: {propertyAddress}
Type: {leadType}
Score: {score}/10
Pre-approval: {preApproval}
Timeline: {buyingWindow}

Contact: {phone} | {email}

Notes: {jobDescription || conversation_summary}
```

### 6. TRADE JOB ALERT (to tradie via SMS + dashboard)

**Note:** This is the format used in SMS/dashboard notifications to tradies.

```
New job from Hugo:

Customer: {leadName}
Phone: {phone}
Job: {jobDescription}
Location: {suburb}
Urgency: {urgency}

Tap to view: {dashboardUrl}
```

### 7. FOLLOW-UP — Hot Lead (3 days after initial contact)

**When:** 3 days after initial hot lead contact, no response
**Subject:** Still keen on {propertyAddress}?
**Tone:** Friendly check-in, not pushy

```
Hi {firstName},

Just checking in — did you get a chance to look at {propertyAddress}?

We've had a lot of interest in that one and wanted to make sure you didn't miss out.

Let us know if you'd like to arrange an inspection or if you have any questions.

Cheers,
{agentName}
```

### 8. FOLLOW-UP — Warm Lead (7 days)

**When:** 7 days after initial contact for warm leads
**Subject:** Some new listings in {suburb} you might like
**Tone:** Value-adding, not pushy

```
Hi {firstName},

Hope all is well. We've just added a few new properties in {suburb} that might suit what you're looking for.

Here's one that might interest you: {listingUrl}

Happy to arrange a viewing if you'd like to take a look.

Cheers,
{agentName}
```

### 9. OFFER RECEIVED (to agent — internal notification)

**When:** Lead captures offer details via phone/widget
**Subject:** Offer received — {propertyAddress}

```
Offer logged:

Property: {propertyAddress}
Amount: ${amount}
Conditions: {conditions}
Settlement: {settlementPeriod} days

Lead: {leadName} | {phone} | {email}

{agentName} should follow up directly.
```

### 10. PRICE RESPONSE (if they ask about PropOps pricing — promoter/promotional context)

**When:** Caller/lead asks about PropOps pricing on phone call
**Subject:** (Not emailed — spoken on phone)

```
Pricing:
- $69/month launch special — locked for life if you sign up before June 30
- After June 30, price goes to $99/month
- 14-day free trial, no credit card to start
- One extra job a month pays for Hugo ten times over

PAYDECK Premium (payroll/invoicing): $149/month
```

---

## Sign-Off Styles by Business Type

| Business Type | Sign-Off | Example |
|---------------|----------|---------|
| real_estate | Warm regards, | Warm regards,\nThe PropOps Team |
| plumber | Cheers, | Cheers,\n[Name] |
| electrician | Cheers, | Cheers,\n[Name] |
| cleaner | Thanks, | Thanks,\n[Name] |
| commercial_cleaner | Regards, | Regards,\n[Name] |
| painter | Cheers, | Cheers,\n[Name] |
| landscaper | Cheers, | Cheers,\n[Name] |
| re_agent | Kind regards, | Kind regards,\n[Name] |
| (default) | Cheers, | Cheers,\n[Name] |

---

## Never Include in Emails

- "Dear [Name]" — always "Hi [Name]"
- "I hope this email finds you well" — old-fashioned, not Hugo's style
- "Please do not hesitate to contact us" — corporate, not Aussie
- Markdown formatting (bold, italic, bullet points)
- Credit card / trial payment language for PropOps itself (handled separately in onboarding)
- "As per my previous email" — never send emails that require this
- Pricing for PropOps products (keep pricing conversations on the call or landing page)

---

## Subject Line Rules

- Keep under 60 characters
- Reference the specific property or job type
- "Re:" prefix for responses to enquiries
- "Confirmation:" prefix for booking confirmations
- "Alert:" prefix for internal operator alerts (not customer-facing)