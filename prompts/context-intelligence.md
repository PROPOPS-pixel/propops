# Context Intelligence — Hugo's Pipeline Awareness

**What this file controls:** Rules and format for how Hugo understands an operator's pipeline patterns, converts those insights into conversation prompts, and uses them to improve lead qualification. Loaded by `services/hugo-context-intelligence.js` via `fs.readFileSync`.

**Note:** The query functions and caching live in `services/hugo-context-intelligence.js`. This file defines the prompt formatting and business rules for how intelligence data is presented to Hugo's brain.

**Editing:** Edit this file → commit → Render deploys → Hugo's pipeline intelligence updated.

---

## Purpose

Hugo should understand the patterns in an operator's pipeline — which suburbs most leads come from, which sources convert best, where leads get stuck — and use that to:
1. Mention hot suburbs naturally in conversation
2. Push leads toward qualification when the pipeline shows stagnation
3. Mention relevant listings when a lead asks about a suburb with known inventory
4. Highlight high-intent leads that need follow-up

---

## Intelligence Data Types

### Hot Suburbs
Hugo should know the top 5 suburbs by lead volume for this operator.

Prompt format:
```
HIGH-DEMAND SUBURBS: {suburb1} ({count1}), {suburb2} ({count2}), {suburb3} ({count3}) — mention these naturally when relevant, e.g. "I see you're in Mosman — we've had strong demand there"
```

Rule: Only mention if the lead's suburb matches a hot suburb OR if Hugo is introducing themselves and can naturally say "We work across [suburb] quite a bit."

### Pipeline Stagnation
Hugo should notice when many leads are contacted but few are qualified.

Prompt format:
```
PIPELINE INSIGHT: {contactedCount} leads contacted but only {qualifiedCount} qualified — Hugo should actively push leads toward qualification (ask budget, timeline, location)
```

Rule: Only include this prompt segment if contactedCount > qualifiedCount AND both are > 0.

### Source Conversion
Hugo should know which lead sources produce the most qualified leads.

Prompt format:
```
TOP CONVERTING SOURCE: {source} ({converted}/{total} converted) — when a lead mentions this source, treat as higher intent
```

Rule: Only include if topSource has converted > 0. Only show the top source.

### Lead Type Mix (RE agents only)
Hugo should adjust qualification approach based on the operator's historical lead type mix.

Prompt format:
```
LEAD TYPE MIX: {buyerCount} buyers, {renterCount} renters, {landlordCount} landlords — Buyer → push inspection booking; Renter → push viewing; Landlord → connect for appraisal
```

Rule: Only for real_estate operators. Show top 3 lead types.

### Job Patterns (Tradies/Builders only)
Hugo should know which job types the operator handles most and converts best on.

Prompt format:
```
TOP JOB TYPES HANDLED: {job1}, {job2}, {job3}, {job4} — when new leads mention these, respond with confidence ("We do a lot of {job1} work")
```

Rule: Only for non-real_estate operators. Minimum 1 job type with total >= 1.

### Active Listings Cross-Match (RE agents only)
Hugo should cross-match current lead suburb against operator's active listings.

Prompt format:
```
LISTING MATCH: Lead is asking about {suburb} — you have {count} active listing(s) there: {listingDetails}. Mention these naturally.
```

Rule: Only when currentLeadSuburb matches a suburb in activeListings. Show max 2 listings.

Prompt format (general):
```
ACTIVE LISTINGS: {count} listing(s) across {suburbs} — if a lead mentions any of these suburbs, mention the relevant listing
```

### High-Intent Unclosed Leads
Hugo should flag high-intent leads that haven't been qualified.

Prompt format:
```
HIGH-INTENT UNCLOSED: {leadName} (intent {score}/10, {jobType}, {status}) — {others} more. If operator asks about pipeline, highlight these — they need follow-up
```

Rule: Only show lead if intentScore >= 7 AND status not in qualified/won/booked/converted/closed. Maximum 5.

---

## General Prompt Formatting

All intelligence segments should be wrapped in:
```
LEAD INTELLIGENCE (use naturally, don't lecture — integrate into conversation):
{segment1}
{segment2}
...
```

If no useful data (all queries return empty), return empty string — do not include a generic fallback.

---

## Integration with Hugo Brain

`formatIntelligencePrompt(intelligence, currentLeadSuburb)` is called with:
- `intelligence`: result of `fetchContextIntelligence(operatorId, businessType)`
- `currentLeadSuburb`: suburb from current lead (for listing cross-match)

The function formats the intelligence into a string that is injected into the Hugo brain system prompt before every response.

---

## Cache Behavior

- Intelligence is cached per operator_id for 5 minutes
- Cache is invalidated when `clearIntelligenceCache(operatorId)` is called
- All 7 queries run in parallel — budget < 500ms total

---

## Error Handling

- All queries are non-fatal — missing tables or empty results return empty arrays
- If a query fails, that segment is skipped (not replaced with a fallback)
- Intelligence is additive — missing segments don't break the prompt

---

## Example Complete Prompt

```
LEAD INTELLIGENCE (use naturally, don't lecture — integrate into conversation):
HIGH-DEMAND SUBURBS: Mosman (12), Cremorne (8), Neutral Bay (6) — mention these naturally when relevant, e.g. "I see you're in Mosman — we've had strong demand there"
PIPELINE INSIGHT: 15 leads contacted but only 3 qualified — Hugo should actively push leads toward qualification (ask budget, timeline, location)
TOP CONVERTING SOURCE: Hipages (4/6 converted) — when a lead mentions Hipages, treat as higher intent
ACTIVE LISTINGS: 3 listing(s) across Mosman, Cremorne, Neutral Bay — if a lead mentions any of these suburbs, mention the relevant listing
HIGH-INTENT UNCLOSED: Sarah Chen (intent 9/10, apartment buyer, new) — +2 more. If operator asks about pipeline, highlight these — they need follow-up
```