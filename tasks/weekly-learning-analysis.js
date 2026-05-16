/**
 * Hugo Self-Learning Engine — Phase 3B
 * Weekly Learning Analysis (Sunday 2AM AEST / Saturday 16:00 UTC)
 *
 * Aggregates raw interaction data from the past 7 days into hugo_learned_knowledge.
 *
 * Data sources:
 *   1. hugo_sim_outcomes   → conversion_pattern (which Hugo response styles led to bookings)
 *   2. hugo_chat_logs      → faq_dynamic (top questions, abandonment, conversion)
 *   3. operator_profiles   → pricing_benchmark (real trade rates from subscriber onboarding)
 *   4. hugo_subscriber_signals → lead_score_weight (which lead types operators actually book)
 *
 * Confidence scoring:
 *   sample_size >= 10  → HIGH  (0.9)  — Hugo states confidently
 *   sample_size 3–9    → MEDIUM (0.65) — Hugo hedges
 *   sample_size < 3    → LOW  (0.3)  — skipped (falls back to static)
 *
 * Privacy rules:
 *   - Pricing benchmarks require >= 3 subscribers before publishing
 *   - Never expose individual operator rates — aggregated ranges only
 *   - hugo_chat_logs messages anonymised after 30 days
 *
 * UNDO PATH:
 *   DELETE FROM hugo_learned_knowledge WHERE last_updated >= NOW() - INTERVAL '7 days';
 *   Re-run the cron to regenerate.
 *
 * Usage:
 *   node tasks/weekly-learning-analysis.js          # run manually
 *   (server.js fires this automatically on Sunday 16:00 UTC)
 */

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── Confidence helpers ──────────────────────────────────────────────────────

function scoreConfidence(sampleSize) {
  if (sampleSize >= 10) return 0.9;  // HIGH — state it
  if (sampleSize >= 3)  return 0.65; // MEDIUM — hedge it
  return 0.3;                         // LOW — skip (below /learned-context threshold of 0.5)
}

// ─── Upsert helper ───────────────────────────────────────────────────────────
// Upserts a learned knowledge entry by (trade_category, region, knowledge_type, source).
// Uses a composite key approach: match on type + trade + region + source slug.

async function upsertLearnedKnowledge(entry) {
  const {
    trade_category,
    region,
    knowledge_type,
    data_payload,
    confidence_score,
    sample_size,
    source,
  } = entry;

  // Check for existing active row with same dimensions
  const existing = await pool.query(
    `SELECT id FROM hugo_learned_knowledge
     WHERE trade_category = $1
       AND (region = $2 OR (region IS NULL AND $2 IS NULL))
       AND knowledge_type = $3
       AND source = $4
       AND is_active = true`,
    [trade_category, region || null, knowledge_type, source]
  );

  if (existing.rows.length > 0) {
    // Update existing
    await pool.query(
      `UPDATE hugo_learned_knowledge
       SET data_payload = $1,
           confidence_score = $2,
           sample_size = $3,
           last_updated = NOW()
       WHERE id = $4`,
      [JSON.stringify(data_payload), confidence_score, sample_size, existing.rows[0].id]
    );
  } else {
    // Insert new
    await pool.query(
      `INSERT INTO hugo_learned_knowledge
         (trade_category, region, knowledge_type, data_payload, confidence_score, sample_size, source, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [
        trade_category,
        region || null,
        knowledge_type,
        JSON.stringify(data_payload),
        confidence_score,
        sample_size,
        source,
      ]
    );
  }
}

// ─── DATA SOURCE 1: Simulation outcomes → conversion_pattern ─────────────────
//
// Which Hugo response styles (simulation_type) correlated with successful final
// statuses (Booked, Complete) in the past 7 days?
// Aggregate per trade_category.

async function analyseSimOutcomes() {
  console.log('[WeeklyAnalysis] Analysing simulation outcomes...');

  const result = await pool.query(`
    SELECT
      trade_category,
      simulation_type,
      COUNT(*) AS total,
      SUM(CASE WHEN final_status IN ('Booked', 'Complete', 'booked', 'complete') THEN 1 ELSE 0 END) AS conversions,
      AVG(response_time_ms) AS avg_response_ms
    FROM hugo_sim_outcomes
    WHERE created_at >= NOW() - INTERVAL '7 days'
      AND trade_category IS NOT NULL
      AND simulation_type IS NOT NULL
    GROUP BY trade_category, simulation_type
    HAVING COUNT(*) >= 3
    ORDER BY trade_category, conversions DESC
  `);

  let inserted = 0;

  for (const row of result.rows) {
    const total = parseInt(row.total, 10);
    const conversions = parseInt(row.conversions, 10);
    const conversionRate = total > 0 ? Math.round((conversions / total) * 100) : 0;
    const confidence = scoreConfidence(total);

    if (confidence < 0.5) continue; // Skip LOW confidence entries

    await upsertLearnedKnowledge({
      trade_category: row.trade_category.toLowerCase(),
      region: null, // sim outcomes not region-specific
      knowledge_type: 'conversion_pattern',
      data_payload: {
        simulation_type: row.simulation_type,
        conversion_rate_pct: conversionRate,
        total_simulations: total,
        successful_bookings: conversions,
        avg_response_ms: Math.round(parseFloat(row.avg_response_ms) || 0),
        insight: conversionRate >= 40
          ? `"${row.simulation_type}" style converts at ${conversionRate}% for ${row.trade_category} — use proactive approach`
          : `"${row.simulation_type}" style converts at ${conversionRate}% for ${row.trade_category}`,
      },
      confidence_score: confidence,
      sample_size: total,
      source: `sim_outcomes_${row.simulation_type}`,
    });
    inserted++;
  }

  console.log(`[WeeklyAnalysis] Sim outcomes: ${result.rows.length} patterns found, ${inserted} upserted`);
  return inserted;
}

// ─── DATA SOURCE 2: Chat logs → faq_dynamic ──────────────────────────────────
//
// Top 20 most-asked visitor questions from the past 7 days.
// Finds abandonment points (response_led_to = 'bounce') and conversion winners.
// Clusters similar questions by normalising them.

async function analyseChatLogs() {
  console.log('[WeeklyAnalysis] Analysing chat logs...');

  // Top questions by volume (simple word-based clustering via lower-case trim)
  const topQuestions = await pool.query(`
    SELECT
      lower(trim(visitor_message)) AS question_norm,
      COUNT(*) AS ask_count,
      SUM(CASE WHEN response_led_to = 'trial_signup' THEN 1 ELSE 0 END) AS conversions,
      SUM(CASE WHEN response_led_to = 'bounce' THEN 1 ELSE 0 END) AS bounces,
      visitor_trade_detected,
      visitor_region_detected
    FROM hugo_chat_logs
    WHERE created_at >= NOW() - INTERVAL '7 days'
      AND visitor_message IS NOT NULL
      AND length(trim(visitor_message)) > 10
      AND anonymised_at IS NULL
    GROUP BY lower(trim(visitor_message)), visitor_trade_detected, visitor_region_detected
    HAVING COUNT(*) >= 2
    ORDER BY ask_count DESC
    LIMIT 20
  `);

  let inserted = 0;

  for (const row of topQuestions.rows) {
    const total = parseInt(row.ask_count, 10);
    const conversions = parseInt(row.conversions, 10);
    const bounces = parseInt(row.bounces, 10);
    const confidence = scoreConfidence(total);

    if (confidence < 0.5) continue;

    const conversionRate = total > 0 ? Math.round((conversions / total) * 100) : 0;
    const bounceRate = total > 0 ? Math.round((bounces / total) * 100) : 0;
    const isHighAbandon = bounceRate >= 50 && total >= 5;

    await upsertLearnedKnowledge({
      trade_category: row.visitor_trade_detected || 'general',
      region: row.visitor_region_detected || null,
      knowledge_type: 'faq_dynamic',
      data_payload: {
        question: row.question_norm,
        ask_count: total,
        conversion_rate_pct: conversionRate,
        bounce_rate_pct: bounceRate,
        needs_rewrite: isHighAbandon,
        insight: isHighAbandon
          ? `HIGH ABANDON: This question leads to ${bounceRate}% bounce rate — Hugo's current answer needs improvement`
          : `Common question (${total}x): conversion ${conversionRate}%`,
      },
      confidence_score: confidence,
      sample_size: total,
      source: `chat_faq_${Buffer.from(row.question_norm.slice(0, 30)).toString('hex').slice(0, 12)}`,
    });
    inserted++;
  }

  console.log(`[WeeklyAnalysis] Chat logs: ${topQuestions.rows.length} FAQ patterns, ${inserted} upserted`);
  return inserted;
}

// ─── DATA SOURCE 3: Operator profiles → pricing_benchmark ────────────────────
//
// Real pricing benchmarks from operators' onboarding answers.
// Requires >= 3 operators per (trade, region) pair for privacy.
// Aggregates hourly_rate and callout_fee into min/avg/max ranges.

async function analysePricingBenchmarks() {
  console.log('[WeeklyAnalysis] Analysing pricing benchmarks from operator profiles...');

  // Extract trade + region + rates from operator_profiles
  // service_area_suburb is the region proxy (normalised to state/city in a best-effort way)
  const result = await pool.query(`
    SELECT
      lower(trim(trade_type)) AS trade,
      lower(trim(service_area_suburb)) AS suburb,
      COUNT(*) AS operator_count,
      MIN(hourly_rate) AS min_hourly,
      MAX(hourly_rate) AS max_hourly,
      ROUND(AVG(hourly_rate), 0) AS avg_hourly,
      MIN(callout_fee) AS min_callout,
      MAX(callout_fee) AS max_callout,
      ROUND(AVG(callout_fee), 0) AS avg_callout
    FROM operator_profiles
    WHERE trade_type IS NOT NULL
      AND hourly_rate IS NOT NULL
      AND hourly_rate > 0
      AND hourly_rate < 2000
    GROUP BY lower(trim(trade_type)), lower(trim(service_area_suburb))
    HAVING COUNT(*) >= 3
    ORDER BY trade, operator_count DESC
  `);

  let inserted = 0;

  for (const row of result.rows) {
    const count = parseInt(row.operator_count, 10);
    const confidence = scoreConfidence(count);

    if (confidence < 0.5) continue;

    // Map suburb to a broader region label for Hugo's use
    const region = mapSuburbToRegion(row.suburb);

    const minH = parseFloat(row.min_hourly) || 0;
    const maxH = parseFloat(row.max_hourly) || 0;
    const avgH = parseFloat(row.avg_hourly) || 0;

    const summary = maxH > 0
      ? `$${Math.round(minH)}–$${Math.round(maxH)}/hr (avg $${Math.round(avgH)})`
      : null;

    if (!summary) continue;

    await upsertLearnedKnowledge({
      trade_category: row.trade,
      region,
      knowledge_type: 'pricing_benchmark',
      data_payload: {
        trade: row.trade,
        region: region || row.suburb,
        hourly_rate: {
          min: Math.round(minH),
          max: Math.round(maxH),
          avg: Math.round(avgH),
          display: summary,
        },
        callout_fee: row.avg_callout > 0 ? {
          min: Math.round(parseFloat(row.min_callout) || 0),
          max: Math.round(parseFloat(row.max_callout) || 0),
          avg: Math.round(parseFloat(row.avg_callout) || 0),
        } : null,
        operator_count: count,
        insight: `${count} PropOps ${row.trade}s in ${region || row.suburb || 'your area'} typically charge ${summary}`,
      },
      confidence_score: confidence,
      sample_size: count,
      source: `pricing_${row.trade}_${region || row.suburb || 'national'}`,
    });
    inserted++;
  }

  console.log(`[WeeklyAnalysis] Pricing benchmarks: ${result.rows.length} groups found, ${inserted} upserted`);
  return inserted;
}

// Map suburb name to a broader region for Hugo's use in prompts
function mapSuburbToRegion(suburb) {
  if (!suburb) return null;
  const s = suburb.toLowerCase();
  const SUBURB_TO_REGION = {
    sydney: 'sydney', parramatta: 'sydney', penrith: 'sydney', bondi: 'sydney',
    randwick: 'sydney', chatswood: 'sydney', cronulla: 'sydney', concord: 'sydney',
    melbourne: 'melbourne', richmond: 'melbourne', fitzroy: 'melbourne',
    brisbane: 'brisbane', southbank: 'brisbane',
    perth: 'perth', fremantle: 'perth',
    adelaide: 'adelaide',
    canberra: 'canberra',
    darwin: 'darwin',
    hobart: 'hobart',
    'gold coast': 'brisbane', 'sunshine coast': 'brisbane',
    newcastle: 'newcastle', wollongong: 'wollongong',
  };
  for (const [key, region] of Object.entries(SUBURB_TO_REGION)) {
    if (s.includes(key)) return region;
  }
  // State-level fallback
  if (s.includes('nsw') || s.includes('new south wales')) return 'new_south_wales';
  if (s.includes('vic') || s.includes('victoria')) return 'victoria';
  if (s.includes('qld') || s.includes('queensland')) return 'queensland';
  if (s.includes('wa') || s.includes('western australia')) return 'western_australia';
  if (s.includes('sa') || s.includes('south australia')) return 'south_australia';
  return null;
}

// ─── DATA SOURCE 4: Subscriber signals → lead_score_weight ───────────────────
//
// Which lead types do operators actually book vs ignore?
// Weights based on signal_type = 'status_changed' with new_status = 'Booked'.
// Compared against 'New' leads that were never progressed.

async function analyseSubscriberSignals() {
  console.log('[WeeklyAnalysis] Analysing subscriber signals...');

  // Find signal patterns: what lead types (from signal_data) convert to bookings?
  const result = await pool.query(`
    SELECT
      trade_category,
      signal_type,
      COUNT(*) AS signal_count,
      SUM(CASE WHEN signal_data->>'new_status' IN ('Booked', 'Complete') THEN 1 ELSE 0 END) AS positive_outcomes
    FROM hugo_subscriber_signals
    WHERE created_at >= NOW() - INTERVAL '7 days'
      AND trade_category IS NOT NULL
    GROUP BY trade_category, signal_type
    HAVING COUNT(*) >= 3
    ORDER BY trade_category, signal_count DESC
  `);

  let inserted = 0;

  for (const row of result.rows) {
    const total = parseInt(row.signal_count, 10);
    const positive = parseInt(row.positive_outcomes, 10);
    const confidence = scoreConfidence(total);

    if (confidence < 0.5) continue;

    const conversionRate = total > 0 ? Math.round((positive / total) * 100) : 0;

    await upsertLearnedKnowledge({
      trade_category: row.trade_category.toLowerCase(),
      region: null,
      knowledge_type: 'lead_score_weight',
      data_payload: {
        signal_type: row.signal_type,
        total_signals: total,
        positive_outcomes: positive,
        conversion_rate_pct: conversionRate,
        insight: conversionRate >= 40
          ? `${row.signal_type} signals convert ${conversionRate}% for ${row.trade_category} — prioritise these leads`
          : `${row.signal_type} signals — ${conversionRate}% conversion rate for ${row.trade_category}`,
      },
      confidence_score: confidence,
      sample_size: total,
      source: `signal_${row.trade_category}_${row.signal_type}`,
    });
    inserted++;
  }

  console.log(`[WeeklyAnalysis] Subscriber signals: ${result.rows.length} patterns, ${inserted} upserted`);
  return inserted;
}

// ─── CLEANUP ─────────────────────────────────────────────────────────────────

async function runCleanup() {
  console.log('[WeeklyAnalysis] Running cleanup...');

  // Anonymise hugo_chat_logs visitor messages older than 30 days
  const anonResult = await pool.query(`
    UPDATE hugo_chat_logs
    SET
      visitor_message = NULL,
      hugo_response = NULL,
      anonymised_at = NOW()
    WHERE created_at < NOW() - INTERVAL '30 days'
      AND anonymised_at IS NULL
  `);
  console.log(`[WeeklyAnalysis] Anonymised ${anonResult.rowCount} old chat log entries`);

  // Archive inactive learned knowledge older than 90 days
  const archiveResult = await pool.query(`
    UPDATE hugo_learned_knowledge
    SET is_active = false
    WHERE is_active = true
      AND last_updated < NOW() - INTERVAL '90 days'
  `);
  console.log(`[WeeklyAnalysis] Archived ${archiveResult.rowCount} stale learned knowledge entries`);

  return {
    anonymised: anonResult.rowCount,
    archived: archiveResult.rowCount,
  };
}

// ─── MAIN ENTRY POINT ────────────────────────────────────────────────────────

async function runWeeklyAnalysis() {
  const startTime = Date.now();
  console.log('[WeeklyAnalysis] === Hugo Weekly Learning Analysis starting ===');
  console.log(`[WeeklyAnalysis] Timestamp: ${new Date().toISOString()}`);

  const results = {
    conversion_patterns: 0,
    faq_dynamic: 0,
    pricing_benchmarks: 0,
    lead_score_weights: 0,
    cleanup: {},
    errors: [],
  };

  // Run all analysis steps independently — one failure doesn't block others
  try {
    results.conversion_patterns = await analyseSimOutcomes();
  } catch (err) {
    console.error('[WeeklyAnalysis] Sim outcomes error:', err.message);
    results.errors.push({ step: 'sim_outcomes', error: err.message });
  }

  try {
    results.faq_dynamic = await analyseChatLogs();
  } catch (err) {
    console.error('[WeeklyAnalysis] Chat logs error:', err.message);
    results.errors.push({ step: 'chat_logs', error: err.message });
  }

  try {
    results.pricing_benchmarks = await analysePricingBenchmarks();
  } catch (err) {
    console.error('[WeeklyAnalysis] Pricing benchmarks error:', err.message);
    results.errors.push({ step: 'pricing_benchmarks', error: err.message });
  }

  try {
    results.lead_score_weights = await analyseSubscriberSignals();
  } catch (err) {
    console.error('[WeeklyAnalysis] Subscriber signals error:', err.message);
    results.errors.push({ step: 'subscriber_signals', error: err.message });
  }

  try {
    results.cleanup = await runCleanup();
  } catch (err) {
    console.error('[WeeklyAnalysis] Cleanup error:', err.message);
    results.errors.push({ step: 'cleanup', error: err.message });
  }

  const totalInserted = results.conversion_patterns + results.faq_dynamic +
    results.pricing_benchmarks + results.lead_score_weights;

  const elapsed = Math.round((Date.now() - startTime) / 1000);

  console.log('[WeeklyAnalysis] === Analysis complete ===');
  console.log(`[WeeklyAnalysis] Total learned knowledge entries upserted: ${totalInserted}`);
  console.log(`[WeeklyAnalysis] Breakdown: conversion_patterns=${results.conversion_patterns}, faq=${results.faq_dynamic}, pricing=${results.pricing_benchmarks}, lead_weights=${results.lead_score_weights}`);
  console.log(`[WeeklyAnalysis] Cleanup: anonymised=${results.cleanup.anonymised || 0}, archived=${results.cleanup.archived || 0}`);
  if (results.errors.length > 0) {
    console.warn(`[WeeklyAnalysis] ${results.errors.length} non-fatal errors:`, results.errors);
  }
  console.log(`[WeeklyAnalysis] Total time: ${elapsed}s`);

  return results;
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

if (require.main === module) {
  runWeeklyAnalysis()
    .then(results => {
      console.log('[WeeklyAnalysis] Done. Results:', JSON.stringify(results, null, 2));
      pool.end();
      process.exit(0);
    })
    .catch(err => {
      console.error('[WeeklyAnalysis] Fatal error:', err.message, err.stack);
      pool.end();
      process.exit(1);
    });
}

module.exports = { runWeeklyAnalysis };
