// Sync tables from Polsia shared DB to user's personal Neon DB.
// Triggered automatically at app startup when SYNC_ON_STARTUP=true.
// Runs as a background task — does NOT block Express port binding.
// Wrapped in a single transaction; rolls back completely on any failure.

const { Client } = require('pg');

const SOURCE_URL = process.env.DATABASE_URL;
const DEST_URL   = process.env.DEST_NEON_DB_URL;

const TABLES_VERIFY   = ['users','operators','portal_configs','services','subscriptions','leads','jobs','email_notifications'];
const TRUNCATE_ORDER  = ['email_notifications','jobs','leads','subscriptions','services','portal_configs','users','operators'];
const INSERT_ORDER    = ['users','operators','portal_configs','services','subscriptions','leads','jobs','email_notifications'];
const BATCH_SIZE      = 500;

// ── Per-table sync with column mismatch safety ─────────────────────────────────
// Queries destination columns via information_schema, then inserts only those
// columns from source. Skips any source columns absent in destination (no throw).

async function syncTable(clientSrc, clientDst, table) {
  const destColsResult = await clientDst.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
    [table]
  );
  const destCols = destColsResult.rows.map(r => r.column_name);
  if (!destCols.length) {
    console.log(`[SYNC] ${table}: no columns in dest — skipping`);
    return 0;
  }

  let offset = 0, totalSynced = 0;
  while (true) {
    const { rows } = await clientSrc.query(`SELECT * FROM ${table} LIMIT ${BATCH_SIZE} OFFSET ${offset}`);
    if (!rows.length) break;

    const placeholders = [];
    const params = [];
    rows.forEach((row) => {
      const line = [];
      destCols.forEach(col => {
        params.push(row[col]); // undefined for extra source cols — harmless
        line.push(`$${params.length}`);
      });
      placeholders.push(`(${line.join(', ')})`);
    });

    await clientDst.query(
      `INSERT INTO ${table} (${destCols.join(',')}) VALUES ${placeholders.join(',')} ON CONFLICT DO NOTHING`,
      params
    );
    totalSynced += rows.length;
    offset += BATCH_SIZE;
    if (rows.length < BATCH_SIZE) break;
  }
  return totalSynced;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function runSync() {
  if (!SOURCE_URL) throw new Error('DATABASE_URL (source) is not set');
  if (!DEST_URL)   throw new Error('DEST_NEON_DB_URL is not set');

  console.log('[SYNC] Starting background sync to Neon...');

  const src = new Client({ connectionString: SOURCE_URL, ssl: { rejectUnauthorized: false } });
  const dst = new Client({ connectionString: DEST_URL,   ssl: { rejectUnauthorized: false } });

  await src.connect();
  await dst.connect();

  const counts = {};

  try {
    await dst.query('BEGIN');

    // TRUNCATE in reverse dependency order (independent → dependent)
    for (const table of TRUNCATE_ORDER) {
      try {
        await dst.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
        console.log(`[SYNC] Truncated: ${table}`);
      } catch (e) {
        if (!e.message.includes('does not exist')) {
          console.warn(`[SYNC] Truncate ${table} warning: ${e.message}`);
        }
      }
    }

    // INSERT in forward dependency order (independent → dependent)
    for (const table of INSERT_ORDER) {
      try {
        const count = await syncTable(src, dst, table);
        counts[table] = count;
        console.log(`[SYNC] Synced ${table}: ${count} rows`);
      } catch (e) {
        console.error(`[SYNC] Failed to sync ${table}: ${e.message}`);
        throw e;
      }
    }

    await dst.query('COMMIT');
    console.log('[SYNC] All tables synced — transaction committed.');

    // Verification pass
    console.log('[SYNC] Verification:');
    for (const table of TABLES_VERIFY) {
      try {
        const srcRes = await src.query(`SELECT COUNT(*) FROM ${table}`);
        const dstRes = await dst.query(`SELECT COUNT(*) FROM ${table}`);
        const s = parseInt(srcRes.rows[0].count);
        const d = parseInt(dstRes.rows[0].count);
        const match = s === d ? '✅' : '❌';
        console.log(`  ${table}: source=${s}, dest=${d} ${match}`);
      } catch (e) {
        console.log(`  ${table}: verification skipped (${e.message})`);
      }
    }

    console.log('[SYNC] Done.');
    return { success: true, counts };
  } catch (err) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('[SYNC] Rolled back due to error:', err.message);
    throw err;
  } finally {
    await src.end();
    await dst.end();
  }
}

module.exports = runSync;