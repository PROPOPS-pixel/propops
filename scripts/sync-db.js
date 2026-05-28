/**
 * Sync Polsia Neon DB → User's Render Neon DB
 * Batched INSERT approach — works in Node.js without pg_dump CLI.
 */
const { Pool } = require('pg');

const SOURCE_URL = process.env.DATABASE_URL;
const DEST_URL   = process.env.SYNC_TO_RENDER_DEST_URL;

if (!SOURCE_URL || !DEST_URL) {
  console.error('ERROR: Missing DATABASE_URL or SYNC_TO_RENDER_DEST_URL');
  process.exit(1);
}

const source = new Pool({ connectionString: SOURCE_URL, max: 3 });
const dest   = new Pool({ connectionString: DEST_URL,   max: 3 });

// ── helpers ──────────────────────────────────────────────────────────────────

async function getTables(pool) {
  const { rows } = await pool.query(`
    SELECT table_name, table_type
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_type DESC, table_name ASC
  `);
  return rows;
}

async function getColumns(pool, table) {
  const { rows } = await pool.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table]);
  return rows;
}

async function countRows(pool, table) {
  const { rows } = await pool.query(`SELECT count(*)::int as c FROM "${table}"`);
  return rows[0].c;
}

// ── sync one table ────────────────────────────────────────────────────────────

async function syncTable(table, isView) {
  const srcCount = await countRows(source, table);
  console.log(`  [${table}] source has ${srcCount} rows`);

  if (srcCount === 0) return { table, src: 0, dst: 0 };

  const cols = await getColumns(source, table);
  if (!cols.length) return { table, src: 0, dst: 0, note: 'no columns' };

  // Truncate base tables; skip views
  if (!isView) {
    try {
      await dest.query(`TRUNCATE "${table}" RESTART IDENTITY CASCADE`);
    } catch (e) {
      console.log(`  TRUNCATE failed (normal for inherited tables): ${e.message}`);
    }
  }

  // Copy in batches
  const BATCH = 500;
  let offset = 0;
  let dstCount = 0;

  while (offset < srcCount) {
    const { rows } = await source.query(
      `SELECT * FROM "${table}" LIMIT ${BATCH} OFFSET ${offset}`
    );
    if (!rows.length) break;

    const colNames = cols.map(c => `"${c.column_name}"`);
    const placeholders = (n) => cols.map((_, i) => `$${n + i}`).join(',');

    // Build multi-row INSERT
    const values = rows.flatMap((row, ri) =>
      cols.map(c => row[c.column_name] === undefined ? null : row[c.column_name])
    );
    const paramOffset = offset * cols.length;

    const sql = `INSERT INTO "${table}" (${colNames.join(',')}) VALUES ${
      rows.map((_, ri) => `(${placeholders(ri * cols.length)})`).join(',')
    } ON CONFLICT DO NOTHING`;

    try {
      await dest.query(sql, values);
      dstCount += rows.length;
    } catch (e) {
      console.log(`  INSERT batch error: ${e.message.slice(0, 120)}`);
      // Per-row fallback
      for (const row of rows) {
        const vals = cols.map(c => row[c.column_name] === undefined ? null : row[c.column_name]);
        try {
          await dest.query(
            `INSERT INTO "${table}" (${colNames.join(',')}) VALUES (${vals.map((_, i) => `$${i+1}`).join(',')}) ON CONFLICT DO NOTHING`,
            vals
          );
          dstCount++;
        } catch (err) {
          // skip bad rows silently
        }
      }
    }

    offset += BATCH;
  }

  return { table, src: srcCount, dst: dstCount };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Syncing Polsia DB → Render Neon ===\n');

  const tables = await getTables(source);
  console.log(`Found ${tables.length} tables/views\n`);

  const results = [];

  for (const { table_name, table_type } of tables) {
    const isView = table_type === 'VIEW';
    process.stdout.write(`Syncing ${isView ? '[VIEW] ' : ''}${table_name}... `);
    try {
      const r = await syncTable(table_name, isView);
      console.log(`  → ${r.dst}/${r.src} rows`);
      results.push(r);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      results.push({ table: table_name, error: e.message });
    }
  }

  // Final verification: row counts from both DBs
  console.log('\n=== VERIFICATION (row counts) ===\n');
  const verificationRows = [];

  for (const { table_name } of tables) {
    try {
      const srcCnt = await countRows(source, table_name);
      const dstCnt = await countRows(dest, table_name);
      const match = srcCnt === dstCnt ? '✓' : '✗';
      console.log(`${match} ${table_name}: source=${srcCnt}, dest=${dstCnt}`);
      verificationRows.push({ table: table_name, src: srcCnt, dst: dstCnt, match: srcCnt === dstCnt });
    } catch (e) {
      console.log(`✗ ${table_name}: verification error — ${e.message}`);
      verificationRows.push({ table: table_name, error: e.message });
    }
  }

  const allMatch = verificationRows.every(r => r.match === true);
  console.log(`\n${allMatch ? '✓ ALL TABLES MATCH' : '⚠ SOME TABLES DO NOT MATCH'}`);

  await source.end();
  await dest.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });