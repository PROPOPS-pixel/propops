# PropOps Landing Pages

Hugo-branded property operations platform. Three landing pages: real estate agents (propops.pro → Hugo.RE), Australian tradies (propops.trade → Hugo.trades), and tradie ops/invoicing (hugopays.pro → Hugo.pays).

## Stack

Express.js + PostgreSQL. Static HTML landing pages served from `/public/` directory.

## Directory Map

- **public/** — Static landing pages (index.html, propops-trade.html, hugopays.html) and assets (logos, favicons, widget scripts)
- **server.js** — Express app wiring only (<200 lines). Entry point.
- **routes/** — API endpoints: hugo.js (dashboard chat), hugo-brain.js (unified brain service), hugo-widget.js (public widget), admin.js (admin/cron endpoints), startup.js (boot tasks), paydeck.js (PAYDECK Premium + AU compliance), etc.
- **services/** — Business logic (email, billing, auth, scheduling, hugo AI, landing page sync, simulation-eval.js for nightly batch eval)
- **migrations/** — node-pg-migrate migration files (numbered 001–054, then unix timestamp names)
- **scripts/** — One-off admin scripts (backfill-embeddings.js for pgvector seeding)

## Database

- **network_leads** — Public leads captured by Hugo widget (trade, suburb, job_description, urgency, contact, status: new|matched|unserviced)
- **network_signups** — Tradie sign-up intent from Hugo widget (trade, service_area, business_name, contact, status: widget_captured|signed_up|trial_active)
- **users** — Operator accounts; subscription_tier (base|premium), gst_registered (boolean, default false)
- **operator_profiles** — Hugo interview data (trade, rates, hours, service area, rates_json, business_customization JSONB)
- **operator_widget_leads** — Leads Hugo captured via widget/phone, per operator (intent_score, status, rough_quote)
- **operator_actions_log** — Immutable audit log of every action Hugo triggered (email, SMS, booking, quote)
- **hugo_training_data** — Hugo training Q&A pairs (embedding vector(1536) for similarity search)
- **hugo_chat_messages** — Dashboard conversation history per operator
- **hugo_widget_sessions** — Public widget conversation sessions
- **hugo_knowledge_entries** — Q&A knowledge entries, vector-embedded, confidence-ranked (trained/learned/default)
- **hugo_lead_memory** — Cross-channel lead recognition: identity + conversation context
- **hugo_founder_config** — God-layer founder controls: pricing locks, global rules, personality overrides
- **hugo_referral_leads** — Operator-to-operator referrals; status: pending/accepted/declined/converted
- **page_analytics** — Landing page visitor tracking: domain, path, referrer, UTM params, device type
- **operator_emails** — HUGO's operator inbox: inbound emails, Hugo summaries, draft replies, approval/send lifecycle
- **hugo_call_scores** — Hugo self-monitoring: per-turn AI quality scores (helpfulness, on_brand, lead_capture, action_quality, brevity), flags, overall score
- **hugo_supervision_log** — Nightly batch review results: conversations reviewed/flagged, avg confidence, issues, suggestions, daily report text
- **hugo_confidence_scores** — Per-conversation confidence (0–1); needs_review=true triggers Layer 2 anomaly pickup
- **hugo_training_versions** — Full prompt version history: before/after diff, change_reason, founder_approved, applied, rolled_back
- **staff_members** — PAYDECK: active staff (name, role, hourly_rate, phone, tfn_status, invite_token, portal_password_hash)
- **roster_entries** — PAYDECK: scheduled jobs (staff, date, time, job_title, address, status)
- **invoices** — PAYDECK: customer invoices; subtotal, gst_amount (10%), total_inc_gst; lifecycle draft→sent→paid
- **payroll_entries** — PAYDECK: payroll periods; amount (gross), super_amount (11.5%), tax_withheld (ATO PAYG), net_pay
- **staff_clock_events** — Staff Portal: GPS clock-in/out events per staff member (lat/lng, accuracy, geofence_ok, roster_entry_id)
- **staff_shift_swap_requests** — Staff Portal: shift swap requests; requesting_staff_id, target_staff_id, status: pending|approved|declined
- **staff_leave_requests** — Staff Portal: leave requests (annual/sick/personal); days_requested, status: pending|approved|declined; operator approves via `/api/paydeck/leave-requests/:id/review`
- **staff_onboarding** — Staff Portal: per-staff onboarding data (TFN declaration, super choice fund/USI/member, bank BSB/account, emergency contacts); one row per staff member (UNIQUE staff_id)
- **portal_sender_registry** — DB-configurable mapping of sender domains → portal names/parse methods (Hipages, ServiceSeeking, Airtasker, Oneflare, Bark, Facebook, Google)
- **operator_portal_connections** — Per-operator portal connection records; auto-created on first forwarded email; tracks emails_count, leads_count, connected_at

## External Integrations

- **Groq (llama-3.1-8b-instant)** — PRIMARY AI brain (GROQ_API_KEY); `HUGO_GROQ_MODEL` env var to swap models
- **OpenAI proxy (Polsia)** — Fallback AI (gpt-4o-mini) + embeddings (text-embedding-3-small for vector search)
- **Gemini (Google)** — Data reads only (landing page sync, NOT persona responses)
- **Twilio** — Phone AI (+61 2 5301 0002), SMS, voice webhooks
- **GoCardless** — Direct debit billing
- **Postmark/Resend** — Transactional email delivery (Resend also sends HUGO's approved email replies)
- **pgvector** — PostgreSQL vector similarity search for training data retrieval

## Recent Changes

1. **May 16** — FEATURE: Founder Dashboard — Payroll & Invoicing section. New sidebar nav item + cross-operator aggregate view: summary cards (invoices sent, collected, overdue, staff rostered, payroll this month), per-operator invoicing table, per-operator roster/payroll table, overdue alarm list, click-through drill-down modal per operator. READ-ONLY; queries invoices, roster_entries, staff_members, payroll_entries. New endpoints: `GET /api/founder/payroll-summary` and `GET /api/founder/payroll-summary/operator/:id`. Affects: `routes/founder.js`, `views/founder-dashboard.html`.
2. **May 16** — BUGFIX: MEGA FIX — 10 bugs + color coding. Fixed Invalid Date on Staff Home/Clock (node-pg Date object handling), AM/PM time formatting (12h offset for end<start), HRS=0 and Pay=$0 cascading fix, raw UTC in RECENT notifications, Swap/Delete button spacing (12px gap), Boss Preview button (session.sub not session.userId), employer branding in header+invite email. FEATURE: per-staff color-coded shift chips with legend. Affects: `views/pays-staff-portal.html`, `views/pays-dashboard.html`, `routes/staff-portal.js`, `routes/paydeck.js`.
3. **May 16** — FEATURE: Staff Portal enhancements — Boss Preview button, auto-invite on staff add with email, Staff Portal week grid with compact shift cells + click-to-expand pay. Affects: `views/pays-dashboard.html`, `views/pays-staff-portal.html`, `routes/staff-portal.js`.
4. **May 16** — FEATURE: Operator email notifications — instant lead alerts when Hugo qualifies a lead + 8am AEST daily digest. Affects: `services/operator-notifications.js`, `routes/network-leads.js`, `routes/startup.js`, `routes/admin.js`.
5. **May 16** — BUGFIX: 8-fix UX overhaul — sidebar replaced with horizontal top nav bar, shift date timezone fix (AEST), delete button on shifts, compact pay boxes. Affects: `views/pays-dashboard.html`, `routes/paydeck.js`.
