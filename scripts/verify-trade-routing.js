#!/usr/bin/env node
/**
 * Verification script: tests that every trade category generates
 * leads ONLY from its own trade pool. Zero cross-contamination.
 */

const {
  AUTHORITATIVE_TRADES,
  TRADE_ALIASES,
  SIMULATE_JOB_TYPES,
  normalizeBusinessType,
  generateTradeLead,
  validateLeadMatch,
} = require('../services/trade-simulation');

let failures = 0;
let passes = 0;

console.log('=== Trade Routing Verification ===\n');

// Test 1: All 26 authoritative trades have simulation pools
console.log('--- Test 1: All authoritative trades have simulation pools ---');
for (const trade of AUTHORITATIVE_TRADES) {
  const pool = SIMULATE_JOB_TYPES[trade];
  if (pool && pool.length > 0) {
    console.log(`  ✅ ${trade}: ${pool.length} job types`);
    passes++;
  } else {
    console.log(`  ❌ ${trade}: NO simulation pool!`);
    failures++;
  }
}

// Test 2: Legacy aliases resolve correctly
console.log('\n--- Test 2: Legacy alias normalization ---');
const aliasCases = {
  lawn_care: 'landscaper',
  pool_cleaning: 'pool_tech',
  carpet_cleaning: 'cleaner',
  commercial_cleaner: 'cleaner',
  bricklayer: 'builder',
};
for (const [alias, expected] of Object.entries(aliasCases)) {
  const result = normalizeBusinessType(alias);
  if (result === expected) {
    console.log(`  ✅ '${alias}' → '${result}'`);
    passes++;
  } else {
    console.log(`  ❌ '${alias}' → '${result}' (expected '${expected}')`);
    failures++;
  }
}

// Test 3: Direct authoritative types pass through unchanged
console.log('\n--- Test 3: Authoritative types pass through unchanged ---');
for (const trade of AUTHORITATIVE_TRADES) {
  const result = normalizeBusinessType(trade);
  if (result === trade) {
    passes++;
  } else {
    console.log(`  ❌ '${trade}' normalized to '${result}' (should be unchanged)`);
    failures++;
  }
}
console.log(`  ✅ All ${AUTHORITATIVE_TRADES.length} authoritative types pass through correctly`);

// Test 4: Generate leads for ALL trades — verify no cross-contamination
console.log('\n--- Test 4: Lead generation per trade (10 leads each) ---');
const allTradesToTest = [...AUTHORITATIVE_TRADES, ...Object.keys(aliasCases)];

for (const inputType of allTradesToTest) {
  const expectedType = normalizeBusinessType(inputType);
  const expectedPool = SIMULATE_JOB_TYPES[expectedType];

  if (!expectedPool) {
    console.log(`  ⚠️  ${inputType} (→${expectedType}): No pool, skip`);
    continue;
  }

  let tradeOk = true;
  for (let i = 0; i < 10; i++) {
    const lead = generateTradeLead(inputType);

    // Verify the lead's job type is in the correct pool
    if (!expectedPool.includes(lead.jobType)) {
      console.log(`  ❌ ${inputType} (→${expectedType}): Got job_type='${lead.jobType}' which is NOT in the ${expectedType} pool!`);
      tradeOk = false;
      failures++;
      break;
    }

    // Verify validation passes
    const validation = validateLeadMatch(inputType, lead.jobType);
    if (!validation.valid) {
      console.log(`  ❌ ${inputType} (→${expectedType}): Validation failed for '${lead.jobType}': ${validation.reason}`);
      tradeOk = false;
      failures++;
      break;
    }
  }

  if (tradeOk) {
    console.log(`  ✅ ${inputType}${inputType !== expectedType ? ' (→' + expectedType + ')' : ''}: 10/10 leads correct`);
    passes++;
  }
}

// Test 5: Unknown type falls back to handyman
console.log('\n--- Test 5: Unknown types fall back to handyman ---');
const unknowns = ['xyzzy', '', null, undefined, 'plumbing', 'PLUMBER'];
for (const unknown of unknowns) {
  const result = normalizeBusinessType(unknown);
  // 'PLUMBER' should NOT match because we do toLowerCase (let's check)
  if (unknown && typeof unknown === 'string' && AUTHORITATIVE_TRADES.includes(unknown.toLowerCase())) {
    if (result === unknown.toLowerCase()) {
      console.log(`  ✅ '${unknown}' → '${result}' (case-normalized)`);
      passes++;
    } else {
      console.log(`  ❌ '${unknown}' → '${result}' (expected '${unknown.toLowerCase()}')`);
      failures++;
    }
  } else if (result === 'handyman') {
    console.log(`  ✅ '${unknown}' → 'handyman' (fallback)`);
    passes++;
  } else {
    console.log(`  ❌ '${unknown}' → '${result}' (expected 'handyman')`);
    failures++;
  }
}

// Summary
console.log('\n=== RESULTS ===');
console.log(`Passes: ${passes}`);
console.log(`Failures: ${failures}`);

if (failures > 0) {
  console.log('\n❌ VERIFICATION FAILED — trade routing has issues');
  process.exit(1);
} else {
  console.log('\n✅ ALL TESTS PASSED — zero cross-contamination');
  process.exit(0);
}
