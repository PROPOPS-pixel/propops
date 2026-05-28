# PropOps Technical Notes

## Section 10: Hugo Eyes Phase 2 — Dashboard Analytics Learning

Hugo continuously tracks `/api/hugo/dashboard-analytics` performance matrices, delivering personalized operational optimization summaries and executing runtime corrections using combined telemetry data points.

### The Self-Correction Loop System Pipeline

1. **Training Feed Tracking Integration:** Conversions processed as `corrected` update Hugo's operational tone context. It swaps out conversation layers on the fly during future lead matching attempts.

2. **Self-Learning Affirmations Log:** Structural paths logged as `approved` inside `hugo_confidence_scores` freeze successful workflows. Routes logged under operational drop-offs automatically deprioritize unstable lead engagement variations.

3. **Channel Traffic Warnings:** System prompts read conversion changes down to the individual lead source. If a source drops below conversion baselines, Hugo flags it to the operator directly during performance catchups.

### Endpoint: GET /api/hugo/dashboard-analytics

**Query param:** `operator_id` (UUID, required)

**Response schema:**
- `operator_id` — operator UUID
- `lead_summary` — total leads, breakdown by source/status/trade
- `conversion` — overall rate, per-source rate, best/worst channel, avg response seconds
- `revenue` — this month total, jobs booked, avg job value
- `hugo_performance` — calls handled, emails sent, avg response time, digest days (7d)
- `training_feed` — pending/corrected/approved/total counts from hugo_training_data
- `self_learning` — entries logged, needs_review, stable, avg_confidence, flagged

**Cache:** 1-minute in-process TTL per operator. All values from live DB — zero hardcoding.

### Brain Context Injection

`injectDashboardAnalytics(operatorId)` calls the REST endpoint on every brain request (parallel with `buildAnalyticsContextBlock()`). The resulting block covers: source-level conversion, revenue breakdown, Hugo performance stats, training corrections, and self-learning confidence scores. Guardrail prevents verbatim stats from leaking to external users.

See also: `services/hugoBrainContext.js` (Phase 1 inbox + Phase 2 analytics + Phase 3 dashboard injection), `services/analyticsService.js` (12h cache for internal KPI compute).