/**
 * Sync Polsia Neon DB → user's Render Neon DB
 * Copies all tables row-by-row via pg client (pg_dump not available in sandbox)
 */
const { Pool } = require('pg');

const SOURCE_URL = process.env.DATABASE_URL;
const DEST_URL   = process.env.SYNC_TO_RENDER_DEST_URL;

const BATCH = 500;

async function getTables(pool) {
  const { rows } = await pool.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  return rows.map(r => r.tablename);
}

async function getRowCount(pool, table) {
  try {
    const { rows } = await pool.query(`SELECT count(*)::int as c FROM "${table}"`);
    return rows[0].c;
  } catch {
    return -1;
  }
}

async function copyTable(src, dst, table) {
  // Clear existing rows
  await dst.query(`DELETE FROM "${table}"`);

  let offset = 0;
  let total = 0;
  while (true) {
    const { rows } = await src.query(
      `SELECT * FROM "${table}" LIMIT ${BATCH} OFFSET ${offset}`
    );
    if (!rows.length) break;

    if (rows.length === 0) break;

    const cols = Object.keys(rows[0]);
    const colList = cols.map(c => `"${c}"`).join(', ');
    const valList = cols.map((_, i) => `$${i+1}`).join(', ');

    for (const row of rows) {
      const vals = cols.map(c => {
        const v = row[c];
        if (Buffer.isBuffer(v)) return v;
        if (v === null) return null;
        return v;
      });
      try {
        await dst.query(
          `INSERT INTO "${table}" (${colList}) VALUES (${valList})`,
          vals
        );
        total++;
      } catch (err) {
        // Skip duplicate / key violations on idempotent re-runs
        if (!err.code || !['23505','23503'].includes(String(err.code))) {
          console.warn(`  [!] ${table} row @${offset}: ${err.message}`);
        }
      }
    }

    offset += BATCH;
    process.stdout.write(`\r  copied ${total} rows…`);
  }
  console.log(`\r  ${table}: ${total} rows copied`);
  return total;
}

async function main() {
  console.log('Connecting to source and destination…');
  const src = new Pool({ connectionString: SOURCE_URL, ssl: { rejectUnauthorized: false } });
  const dst = new Pool({ connectionString: DEST_URL,   ssl: { rejectUnauthorized: false } });

  const tables = await getTables(src);
  console.log(`Found ${tables.length} tables.\n`);

  const report = {};
  for (const table of tables) {
    process.stdout.write(`[${table}] fetching source count…`);
    const srcCount = await getRowCount(src, table);
    const dstBefore = await getRowCount(dst, table);
    process.stdout.write(` source=${srcCount} → `);
    await copyTable(src, dst, table);
    const dstAfter = await getRowCount(dst, table);
    report[table] = { srcCount, dstBefore, dstAfter, match: srcCount === dstAfter };
  }

  await src.end();
  await dst.end();

  console.log('\n\n========== VERIFICATION REPORT ==========\n');
  console.log(`${'Table'.padEnd(40)} ${'Source'.padEnd(10)} ${'Dest'.padEnd(10)} ${'Match'}`);
  console.log('-'.repeat(70));
  for (const [table, r] of Object.entries(report)) {
    console.log(
      `${table.padEnd(40)} ${String(r.srcCount).padEnd(10)} ${String(r.dstAfter).padEnd(10)} ${r.match ? '✓' : '✗ MISMATCH'}`
    );
  }

  const allMatch = Object.values(report).every(r => r.match);
  console.log(`\n${allMatch ? '✅ ALL TABLES MATCH' : '⚠️  MISMATCHES FOUND — review above'}`);
  process.exit(allMatch ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });