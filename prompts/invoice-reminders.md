# Invoice Payment Reminder Sequences

**What this file controls:** The automated escalation sequence Hugo sends to chase overdue customer invoices. Covers email and SMS across three escalation stages (Day 7, Day 14, Day 21+).

**Loaded by:** `services/notifications.js` (sendOperatorLeadAlertEmail, sendHugoPromoEmail) — escalation sequences are defined inline in `paydeck.js` invoice reminders. This file is the canonical reference for copy tone and sequence logic.

**How it works:** Hugo monitors every invoice. When one goes overdue (past due_date with status != paid), the follow-up sequence starts automatically. Day 7: friendly email. Day 14: SMS + email. Day 21: final notice.

**Editing:** Edit this file → commit → Render deploys → chasing sequence updated. Always test in staging first — a bad escalation tone can damage customer relationships.

---

## Escalation Philosophy

**Three phases, three tones:**

| Day | Channel | Tone |
|-----|---------|------|
| 7   | Email   | Friendly — just a heads up |
| 14  | Email + SMS | Firm — payment overdue, let's sort it |
| 21+ | Email   | Final notice — collection consequences |

Never use threatening language (legal threats, "debt collectors" in day 7-14). Don't be aggressive early — give the customer the benefit of the doubt. By day 21, the tone is clear and direct.

---

## Day 7 — Friendly Reminder

**Trigger:** Invoice status = 'sent' AND due_date + 7 days < today

**Subject (email):** Just following up — Invoice [INV-XXXX-XXXX]

**Email body:**
> Hi [customer first name],
>
> Just a heads up — [Invoice number] for $[total_inc_gst] was due [due date].
>
> If there's anything that needs sorting — a wrong amount, missing PO number, anything — happy to help. Just reply to this email or call [operator business phone].
>
> Payment link: [Stripe payment link or bank details]
>
> Thanks,
> [Operator name] from [Business name]

**Tone:** Warm, no pressure, open the door for a conversation. Assume good faith first.

**SMS (optional, for Day 7 in some workflows):**
> Hi [customer first name], this is a reminder that [Invoice number] for $[total] is overdue. If you have any issues, reply here or call us. — [Business name]

---

## Day 14 — Firm Follow-Up

**Trigger:** Invoice status = 'sent' OR 'overdue' AND due_date + 14 days < today (and no payment received)

**Subject (email):** Payment overdue — Invoice [INV-XXXX-XXXX]

**Email body:**
> Hi [customer first name],
>
> Just following up again — [Invoice number] for $[total_inc_gst] is now 14 days overdue.
>
> I want to make sure this doesn't slip through the cracks. If there's a reason payment hasn't come through yet, let me know and we'll sort it out.
>
> If you need the invoice resent or have any questions, reply here or call [operator business phone].
>
> Pay now: [payment link]
>
> Thanks,
> [Operator name] from [Business name]

**SMS (Day 14 — send in addition to email):**
> Hi [customer first name], this is a reminder that invoice $[total] is now 14 days overdue. Please arrange payment or get in touch so we can resolve this. — [Business name]

**Tone:** Clear that payment is overdue. Acknowledge there might be an issue. Open to resolution. Not threatening.

---

## Day 21 — Final Notice

**Trigger:** Invoice status = 'overdue' AND due_date + 21 days < today (and no payment received)

**Subject (email):** FINAL NOTICE — Invoice [INV-XXXX-XXXX] — Payment required immediately

**Email body:**
> [Customer first name],
>
> [Invoice number] for $[total_inc_gst] has now been outstanding for 21 days.
>
> This is the final notice before we escalate to our debt collection process. We want to resolve this directly with you — please contact us by [date + 7 days] to arrange payment or discuss a payment plan.
>
> If payment is not received by [deadline date], we will refer this matter to our collection agency, which will incur additional fees.
>
> To pay now: [payment link]
>
> Questions? Call [operator phone] or reply to this email.
>
> [Business name]

**SMS (Day 21 — send as backup to email):**
> FINAL NOTICE: Invoice $[total] is 21 days overdue. Please contact us immediately to arrange payment or we will refer to our collection agency. Call [phone] or pay: [link]

**Tone:** Direct. Clear consequences. Still not abusive — just business. "Collection agency" is mentioned as a factual consequence, not a threat.

---

## Stripe Payment Link

Every invoice has a Stripe payment link generated via `POST /api/paydeck/invoices/:id/payment-link`. The link should be included in all three reminder emails. Format: `https://buy.stripe.com/...` (Render-generated or Polsia proxy).

If Stripe is not available, fall back to bank transfer details from operator profile.

---

## GST and Invoice Language

All invoice amounts include GST (10%) for GST-registered operators. The invoice number format is `INV-YYYYMM-XXXX` (sequential, per operator).

**Invoice status lifecycle:** `draft` → `sent` → `paid` | `overdue` (if past due_date with no payment)

Hugo monitors for overdue status daily (via `paydeck.js` cron or in-process scheduler in `routes/startup.js`).

---

## Payment Confirmation

When a payment is received (Stripe webhook via Polsia or manual mark-as-paid in dashboard):
- Invoice status updates to `paid`
- `paid_at` timestamp set
- Payment chasing sequence stops immediately
- Operator gets a dashboard notification: "✅ [Invoice number] paid — $[amount] received"

---

## Overdue Invoice Dashboard Flag

For operators reviewing overdue invoices:
- Overdue invoices shown prominently on the pays dashboard
- Each shows: client name, amount (inc GST), days overdue, last chase sent
- Hugo's last message to the client is visible in the audit trail

---

## Reminder — Tone Guide

**What good looks like:**
- "Just a heads up — wanted to make sure this hasn't slipped through"
- "Happy to help if there's an issue"
- "Let's sort this out"

**What bad looks like:**
- "You have ignored our previous communications" (patronising)
- "We will be forced to take legal action" (premature — collection agency only mentioned at Day 21)
- "This is your final warning" (Day 7 is not your final warning)

**The goal:** Get paid without damaging the customer relationship. The owner likely has an ongoing working relationship with this client — Hugo's chasing should feel like a helpful nudge from a colleague, not a debt collector.