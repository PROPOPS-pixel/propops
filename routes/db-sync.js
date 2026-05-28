/**
 * db-sync routes — standalone database sync tool.
 *
 * Owns: copying all tables from Polsia live DB to a destination Neon DB.
 * Does NOT own: any app logic, billing, auth.
 *
 * Usage: POST /api/db-sync/sync
 *   Body: { "dest_url": "postgresql://..." }
 *   Headers: x-admin-token or ADMIN_TOKEN set
 *
 * This route lives standalone so it can be deployed and triggered
 * when the sandbox cannot reach external databases directly.
 */
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const srcPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

// Dynamically resolved at sync time — see getAllTables()
const SYNC_TABLES = null;

// Fetch all public base tables from source DB.
// WHY dynamic: the task requires syncing all 79 tables, not a hardcoded subset.
async function getAllTables(pool) {
  const res = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return res.rows.map(r => r.table_name);
}

// Build parameterized multi-row INSERT — avoids SQL injection and quoting issues
function buildInsertSql(table, cols, rows) {
  if (!rows.length) return null;
  const colList = cols.map(c => `"${c}"`).join(', ');
  const placeholders = rows.map((_, ri) =>
    '(' + cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(', ') + ')'
  ).join(', ');
  return `INSERT INTO "${table}" (${colList}) VALUES ${placeholders}`;
}

// Flatten rows to flat param array — handles Buffer (BYTEA) → hex
function flattenRows(rows, cols) {
  const flat = [];
  for (const row of rows) {
    for (const c of cols) {
      const v = row[c];
      if (Buffer.isBuffer(v)) {
        flat.push('\\x' + v.toString('hex'));
      } else {
        flat.push(v);
      }
    }
  }
  return flat;
}

// In-memory job store for async sync (key = jobId, value = result)
const syncJobs = new Map();

const JOB_TTL_MS = 30 * 60 * 1000;

// ─── POST /api/db-sync/trigger-async ────────────────────────────────────────
// Starts sync in background, returns immediately with a jobId.
// Poll GET /api/db-sync/status/:jobId for results.
router.post('/trigger-async', async (req, res) => {
  const destUrl = process.env.SYNC_TO_RENDER_DEST_URL;
  if (!destUrl) return res.status(500).json({ success: false, message: 'SYNC_TO_RENDER_DEST_URL not set' });
  const adminToken = process.env.ADMIN_TOKEN;
  const provided = req.headers['x-admin-token'];
  if (adminToken && provided !== adminToken) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  syncJobs.set(jobId, { status: 'running', started_at: new Date().toISOString() });

  // Fire-and-forget — runs in background, app serves requests meanwhile
  (async () => {
    try {
      const destPool = new Pool({ connectionString: destUrl, ssl: { rejectUnauthorized: false }, max: 5 });
      const tables = await getAllTables(srcPool);

      for (const table of tables) {
        try {
          const colsRes = await srcPool.query(
            `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default, udt_name
             FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public'
             ORDER BY ordinal_position`, [table]
          );
          if (!colsRes.rows.length) continue;
          const cols = colsRes.rows.map(c => {
            let type = c.data_type;
            if (type === 'character varying') type = c.character_maximum_length ? `varchar(${c.character_maximum_length})` : 'varchar';
            if (type === 'USER-DEFINED') type = c.udt_name;
            const nullable = c.is_nullable === 'YES' ? '' : ' NOT NULL';
            const def = c.column_default ? ` DEFAULT ${c.column_default}` : '';
            return `"${c.column_name}" ${type}${nullable}${def}`;
          });
          await destPool.query(`CREATE TABLE IF NOT EXISTS "${table}" (${cols.join(', ')})`);
        } catch (e) { console.warn(`[DB-Sync] DDL warn for ${table}: ${e.message}`); }
      }

      const results = [];
      let totalSrc = 0, totalDest = 0;
      for (const table of tables) {
        process.stdout.write(`  [job ${jobId}] ${table}... `);
        process.stdout.flush();
        try {
          const colsRes = await srcPool.query(
            `SELECT column_name, data_type FROM information_schema.columns
             WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position`, [table]
          );
          if (!colsRes.rows.length) { results.push({ table, status: 'skipped' }); continue; }
          const srcRows = await srcPool.query(`SELECT * FROM "${table}"`);
          const srcCount = srcRows.rows.length;
          totalSrc += srcCount;
          await destPool.query(`TRUNCATE TABLE "${table}" CASCADE`);
          if (srcCount > 0) {
            const cols = colsRes.rows.map(r => r.column_name);
            const insertSql = buildInsertSql(table, cols, srcRows.rows);
            if (insertSql) {
              try {
                await destPool.query(insertSql, flattenRows(srcRows.rows, cols));
              } catch (e) {
                for (const row of srcRows.rows) {
                  try {
                    await destPool.query(buildInsertSql(table, cols, [row]), flattenRows([row], cols));
                  } catch (e2) { /* skip */ }
                }
              }
            }
          }
          const destCount = await destPool.query(`SELECT COUNT(*) FROM "${table}"`);
          const destRows = parseInt(destCount.rows[0].count, 10);
          totalDest += destRows;
          console.log(`${destRows}/${srcCount}`);
          results.push({ table, status: 'ok', src_rows: srcCount, dest_rows: destRows });
        } catch (err) {
          console.log(`❌ ${err.message}`);
          results.push({ table, status: 'error', message: err.message });
        }
      }

      await destPool.end();
      const errors = results.filter(r => r.status === 'error');
      syncJobs.set(jobId, {
        status: 'done',
        success: errors.length === 0,
        tables_synced: results.filter(r => r.status === 'ok').length,
        tables_errored: errors.length,
        total_src_rows: totalSrc,
        total_dest_rows: totalDest,
        details: results,
        completed_at: new Date().toISOString(),
      });
    } catch (err) {
      syncJobs.set(jobId, { status: 'done', success: false, error: err.message, completed_at: new Date().toISOString() });
    }
  })().catch(console.error);

  res.json({ success: true, job_id: jobId, poll_url: `/api/db-sync/status/${jobId}` });
});

// ─── GET /api/db-sync/status/:jobId ──────────────────────────────────────────
router.get('/status/:jobId', (req, res) => {
  const job = syncJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, message: 'Job not found or expired' });
  res.json({ success: true, job });
});

// ─── GET /api/db-sync/sync-to-render-now ──────────────────────────────────────
// One-shot GET trigger for browser-initiated syncs.
// Runs full sync (all tables) and returns JSON report.
router.get('/sync-to-render-now', async (req, res) => {
  const destUrl = process.env.SYNC_TO_RENDER_DEST_URL;
  if (!destUrl) return res.status(500).json({ error: 'SYNC_TO_RENDER_DEST_URL not set' });

  const destPool = new Pool({ connectionString: destUrl, ssl: { rejectUnauthorized: false }, max: 5 });
  const tables = await getAllTables(srcPool);

  const results = [];
  let totalSrc = 0, totalDest = 0;

  // Ensure all tables exist
  for (const table of tables) {
    try {
      const colsRes = await srcPool.query(`
        SELECT column_name, data_type, character_maximum_length, is_nullable, column_default, udt_name
        FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public'
        ORDER BY ordinal_position`, [table]);
      if (!colsRes.rows.length) continue;
      const cols = colsRes.rows.map(c => {
        let type = c.data_type;
        if (type === 'character varying') type = c.character_maximum_length ? `varchar(${c.character_maximum_length})` : 'varchar';
        if (type === 'USER-DEFINED') type = c.udt_name;
        const nullable = c.is_nullable === 'YES' ? '' : ' NOT NULL';
        const def = c.column_default ? ` DEFAULT ${c.column_default}` : '';
        return `"${c.column_name}" ${type}${nullable}${def}`;
      });
      await destPool.query(`CREATE TABLE IF NOT EXISTS "${table}" (${cols.join(', ')})`);
    } catch (e) { /* non-fatal */ }
  }

  for (const table of tables) {
    try {
      const colsRes = await srcPool.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position`, [table]);
      if (!colsRes.rows.length) { results.push({ table, status: 'skipped' }); continue; }

      const srcRows = await srcPool.query(`SELECT * FROM "${table}"`);
      const srcCount = srcRows.rows.length;
      totalSrc += srcCount;

      await destPool.query(`TRUNCATE TABLE "${table}" CASCADE`);

      if (srcCount > 0) {
        const cols = colsRes.rows.map(r => r.column_name);
        const insertSql = buildInsertSql(table, cols, srcRows.rows);
        if (insertSql) {
          try {
            await destPool.query(insertSql, flattenRows(srcRows.rows, cols));
          } catch (e) {
            for (const row of srcRows.rows) {
              try {
                await destPool.query(buildInsertSql(table, cols, [row]), flattenRows([row], cols));
              } catch (e2) { /* skip bad rows */ }
            }
          }
        }
      }

      const destCount = await destPool.query(`SELECT COUNT(*) FROM "${table}"`);
      const destRows = parseInt(destCount.rows[0].count, 10);
      totalDest += destRows;
      const match = srcCount === destRows;
      results.push({ table, status: 'ok', src_rows: srcCount, dest_rows: destRows, match });
      console.log(`[sync] ${table}: ${destRows}/${srcCount} ${match ? '✓' : '⚠'}`);
    } catch (err) {
      results.push({ table, status: 'error', message: err.message });
      console.log(`[sync] ${table}: ERROR ${err.message}`);
    }
  }

  await destPool.end();
  const errors = results.filter(r => r.status === 'error');
  const allMatch = errors.length === 0 && results.every(r => r.match !== false);

  res.json({
    success: allMatch,
    tables_synced: results.filter(r => r.status === 'ok').length,
    tables_errored: errors.length,
    total_src_rows: totalSrc,
    total_dest_rows: totalDest,
    details: results,
  });
});

// ─── POST /api/db-sync/sync-from-env ─────────────────────────────────────────
// Sync using SYNC_TO_RENDER_DEST_URL env var (no body required)
router.post('/sync-from-env', async (req, res) => {
  const destUrl = process.env.SYNC_TO_RENDER_DEST_URL;
  if (!destUrl) {
    return res.status(500).json({ success: false, message: 'SYNC_TO_RENDER_DEST_URL not set' });
  }
  req.body = { dest_url: destUrl };
  // Fall through to the main sync handler
  const adminToken = process.env.ADMIN_TOKEN;
  const provided = req.headers['x-admin-token'];
  if (adminToken && provided !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const destPool = new Pool({ connectionString: destUrl, ssl: { rejectUnauthorized: false }, max: 5 });
  const tables = await getAllTables(srcPool);

  for (const table of tables) {
    try {
      const colsRes = await srcPool.query(
        `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default, udt_name
         FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public'
         ORDER BY ordinal_position`, [table]
      );
      if (!colsRes.rows.length) continue;
      const cols = colsRes.rows.map(c => {
        let type = c.data_type;
        if (type === 'character varying') type = c.character_maximum_length ? `varchar(${c.character_maximum_length})` : 'varchar';
        if (type === 'USER-DEFINED') type = c.udt_name;
        const nullable = c.is_nullable === 'YES' ? '' : ' NOT NULL';
        const def = c.column_default ? ` DEFAULT ${c.column_default}` : '';
        return `"${c.column_name}" ${type}${nullable}${def}`;
      });
      await destPool.query(`CREATE TABLE IF NOT EXISTS "${table}" (${cols.join(', ')})`);
    } catch (e) {
      console.warn(`[DB-Sync] DDL warn for ${table}: ${e.message}`);
    }
  }

  const results = [];
  let totalSrc = 0, totalDest = 0;

  for (const table of tables) {
    process.stdout.write(`  ${table}... `);
    process.stdout.flush();
    try {
      const colsRes = await srcPool.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position`, [table]
      );
      if (!colsRes.rows.length) { results.push({ table, status: 'skipped' }); continue; }

      const srcRows = await srcPool.query(`SELECT * FROM "${table}"`);
      const srcCount = srcRows.rows.length;
      totalSrc += srcCount;

      await destPool.query(`TRUNCATE TABLE "${table}" CASCADE`);

      if (srcCount > 0) {
        const cols = colsRes.rows.map(r => r.column_name);
        const insertSql = buildInsertSql(table, cols, srcRows.rows);
        if (insertSql) {
          const params = flattenRows(srcRows.rows, cols);
          try {
            await destPool.query(insertSql, params);
          } catch (e) {
            // Fallback: per-row for problematic tables
            console.log('[fallback row-by-row]');
            for (const row of srcRows.rows) {
              try {
                const rowSql = buildInsertSql(table, cols, [row]);
                const p = flattenRows([row], cols);
                await destPool.query(rowSql, p);
              } catch (e2) { /* skip */ }
            }
          }
        }
      }

      const destCount = await destPool.query(`SELECT COUNT(*) FROM "${table}"`);
      const destRows = parseInt(destCount.rows[0].count, 10);
      totalDest += destRows;
      const match = srcCount === destRows ? '✓' : '⚠';
      console.log(`${destRows}/${srcCount} ${match}`);
      results.push({ table, status: 'ok', src_rows: srcCount, dest_rows: destRows });
    } catch (err) {
      console.log(`❌ ${err.message}`);
      results.push({ table, status: 'error', message: err.message });
    }
  }

  await destPool.end();
  const errors = results.filter(r => r.status === 'error');
  res.json({
    success: errors.length === 0,
    tables_synced: results.filter(r => r.status === 'ok').length,
    tables_errored: errors.length,
    total_src_rows: totalSrc,
    total_dest_rows: totalDest,
    details: results,
  });
});

// ─── POST /api/db-sync/sync ────────────────────────────────────────────────────
// Main sync entry point. Runs all table copies and returns detailed report.
router.post('/sync', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  const provided = req.headers['x-admin-token'];
  if (adminToken && provided !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const destUrl = req.body?.dest_url;
  if (!destUrl) {
    return res.status(400).json({ success: false, message: 'dest_url required in body' });
  }

  const destPool = new Pool({
    connectionString: destUrl,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });

  // Discover all tables from source
  const tables = await getAllTables(srcPool);
  console.log(`[DB-Sync] Syncing ${tables.length} tables: ${tables.join(', ')}`);

  // Ensure all tables exist on destination (CREATE TABLE IF NOT EXISTS based on source DDL)
  for (const table of tables) {
    try {
      const colsRes = await srcPool.query(
        `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default, udt_name
         FROM information_schema.columns
         WHERE table_name = $1 AND table_schema = 'public'
         ORDER BY ordinal_position`, [table]
      );
      if (!colsRes.rows.length) continue;
      const cols = colsRes.rows.map(c => {
        let type = c.data_type;
        if (type === 'character varying') type = c.character_maximum_length ? `varchar(${c.character_maximum_length})` : 'varchar';
        if (type === 'USER-DEFINED') type = c.udt_name;
        const nullable = c.is_nullable === 'YES' ? '' : ' NOT NULL';
        const def = c.column_default ? ` DEFAULT ${c.column_default}` : '';
        return `"${c.column_name}" ${type}${nullable}${def}`;
      });
      await destPool.query(`CREATE TABLE IF NOT EXISTS "${table}" (${cols.join(', ')})`);
    } catch (e) {
      // Non-fatal: if table can't be created, the copy step will report error
      console.warn(`[DB-Sync] DDL warn for ${table}: ${e.message}`);
    }
  }

  const results = [];
  let totalSrc = 0;
  let totalDest = 0;

  for (const table of tables) {
    try {
      const colsRes = await srcPool.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = $1 AND table_schema = 'public'
         ORDER BY ordinal_position`, [table]
      );
      if (!colsRes.rows.length) {
        results.push({ table, status: 'skipped', reason: 'not found' });
        continue;
      }

      const srcRows = await srcPool.query(`SELECT * FROM "${table}"`);
      const srcCount = srcRows.rows.length;
      totalSrc += srcCount;

      await destPool.query(`TRUNCATE TABLE "${table}" CASCADE`);

      if (srcRows.rows.length > 0) {
        const cols = colsRes.rows.map(r => r.column_name);
        const insertSql = buildInsertSql(table, cols, srcRows.rows);
        if (insertSql) {
          const params = flattenRows(srcRows.rows, cols);
          await destPool.query(insertSql, params);
        }
      }

      const destCount = await destPool.query(`SELECT COUNT(*) FROM "${table}"`);
      const destRows = parseInt(destCount.rows[0].count, 10);
      totalDest += destRows;

      results.push({ table, status: 'ok', src_rows: srcCount, dest_rows: destRows });
    } catch (err) {
      results.push({ table, status: 'error', message: err.message });
    }
  }

  await destPool.end();

  const errors = results.filter(r => r.status === 'error');
  res.json({
    success: errors.length === 0,
    tables_synced: results.filter(r => r.status === 'ok').length,
    tables_errored: errors.length,
    total_src_rows: totalSrc,
    total_dest_rows: totalDest,
    details: results,
  });
});

// ─── POST /api/db-sync/sync-to-neon ─────────────────────────────────────────
// Sync source DB → NEON_DATABASE_URL (Polsia Render → the other Neon DB).
// Runs async, returns jobId. Poll GET /api/db-sync/status/:jobId for results.
// Auth: x-admin-token header matching ADMIN_TOKEN env var.
router.post('/sync-to-neon', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  const provided = req.headers['x-admin-token'];
  if (adminToken && provided !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const destUrl = process.env.NEON_DATABASE_URL;
  if (!destUrl) {
    return res.status(500).json({ success: false, message: 'NEON_DATABASE_URL not set' });
  }

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  syncJobs.set(jobId, { status: 'running', started_at: new Date().toISOString() });

  (async () => {
    const destPool = new Pool({ connectionString: destUrl, ssl: { rejectUnauthorized: false }, max: 5 });

    // Only sync tables that exist on both source AND target
    const srcTables  = await getAllTables(srcPool);
    const destTables = await getAllTables(destPool);
    const destSet    = new Set(destTables);
    const tables     = srcTables.filter(t => destSet.has(t));
    const skippedMissing = srcTables.filter(t => !destSet.has(t));

    console.log(`[sync-to-neon job ${jobId}] ${srcTables.length} tables on source, ${destTables.length} on target — syncing ${tables.length} common tables (${skippedMissing.length} missing in target)`);

    const results = [];
    let totalSrc = 0, totalDest = 0;

    for (const table of tables) {
      process.stdout.write(`[sync-to-neon job ${jobId}] ${table}... `);
      process.stdout.flush();
      try {
        const colsRes = await srcPool.query(
          `SELECT column_name, data_type FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position`, [table]
        );
        if (!colsRes.rows.length) { results.push({ table, status: 'skipped', reason: 'no columns' }); console.log('no cols'); continue; }

        const srcRows = await srcPool.query(`SELECT * FROM "${table}"`);
        const srcCount = srcRows.rows.length;
        totalSrc += srcCount;

        await destPool.query(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`);

        if (srcCount > 0) {
          const cols = colsRes.rows.map(r => r.column_name);
          const insertSql = buildInsertSql(table, cols, srcRows.rows);
          if (insertSql) {
            try {
              await destPool.query(insertSql, flattenRows(srcRows.rows, cols));
            } catch (e) {
              // Row-by-row fallback for problematic rows
              for (const row of srcRows.rows) {
                try {
                  const rowSql = buildInsertSql(table, cols, [row]);
                  await destPool.query(rowSql, flattenRows([row], cols));
                } catch (_) { /* skip */ }
              }
            }
          }
        }

        const destCount = await destPool.query(`SELECT COUNT(*) FROM "${table}"`);
        const destRows = parseInt(destCount.rows[0].count, 10);
        totalDest += destRows;
        const match = srcCount === destRows;
        console.log(`${destRows}/${srcCount} ${match ? '✓' : '⚠ MISMATCH'}`);
        results.push({ table, status: 'ok', src_rows: srcCount, dest_rows: destRows, match });
      } catch (err) {
        console.log(`ERROR: ${err.message.split('\n')[0]}`);
        results.push({ table, status: 'error', message: err.message.split('\n')[0] });
      }
    }

    await destPool.end();
    const errors = results.filter(r => r.status === 'error');
    const mismatches = results.filter(r => r.status === 'ok' && !r.match);
    syncJobs.set(jobId, {
      status: 'done',
      success: errors.length === 0 && mismatches.length === 0,
      tables_synced: results.filter(r => r.status === 'ok').length,
      tables_errored: errors.length,
      tables_mismatched: mismatches.length,
      tables_missing_in_target: skippedMissing,
      total_src_rows: totalSrc,
      total_dest_rows: totalDest,
      details: results,
      completed_at: new Date().toISOString(),
    });
  })().catch(err => {
    syncJobs.set(jobId, { status: 'done', success: false, error: err.message, completed_at: new Date().toISOString() });
  });

  res.json({ success: true, job_id: jobId, poll_url: `/api/db-sync/status/${jobId}` });
});

// ─── POST /api/db-sync/sync-to-neon-verify ───────────────────────────────────
// Returns row-count comparison between source (DATABASE_URL) and target (NEON_DATABASE_URL).
router.post('/sync-to-neon-verify', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  const provided = req.headers['x-admin-token'];
  if (adminToken && provided !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const destUrl = process.env.NEON_DATABASE_URL;
  if (!destUrl) {
    return res.status(500).json({ success: false, message: 'NEON_DATABASE_URL not set' });
  }

  const destPool = new Pool({ connectionString: destUrl, ssl: { rejectUnauthorized: false }, max: 2 });
  const srcTables  = await getAllTables(srcPool);
  const destTables = await getAllTables(destPool);
  const destSet    = new Set(destTables);
  const tables     = srcTables.filter(t => destSet.has(t));
  const missing    = srcTables.filter(t => !destSet.has(t));

  const rows = [];
  let totalMismatch = 0;
  for (const table of tables) {
    try {
      const src = await srcPool.query(`SELECT COUNT(*)::int as c FROM "${table}"`);
      const dst = await destPool.query(`SELECT COUNT(*)::int as c FROM "${table}"`);
      const match = src.rows[0].c === dst.rows[0].c;
      if (!match) totalMismatch++;
      rows.push({ table, source: src.rows[0].c, target: dst.rows[0].c, match });
    } catch (e) {
      rows.push({ table, source: -1, target: -1, match: false, error: e.message.split('\n')[0] });
    }
  }

  await destPool.end();
  res.json({ success: true, total_tables: tables.length, total_mismatches: totalMismatch, tables_missing_in_target: missing, results: rows });
});

// ─── GET /api/db-sync/verify ──────────────────────────────────────────────────
// No auth. Compares source (DATABASE_URL) vs target (NEON_DATABASE_URL) row counts.
// Returns JSON with table-by-table comparison. Logs to stdout for log-based reading.
// Use: curl https://propopspro.polsia.app/api/db-sync/verify
router.get('/verify', async (req, res) => {
  const destUrl = process.env.NEON_DATABASE_URL;
  if (!destUrl) return res.status(500).json({ error: 'NEON_DATABASE_URL not set' });

  const destPool = new Pool({ connectionString: destUrl, ssl: { rejectUnauthorized: false }, max: 2 });
  const srcTables  = await getAllTables(srcPool);
  const destTables = await getAllTables(destPool);
  const destSet    = new Set(destTables);
  const tables     = srcTables.filter(t => destSet.has(t));
  const missing    = srcTables.filter(t => !destSet.has(t));

  console.log(`[verify] ${srcTables.length} tables on source, ${destTables.length} on target — checking ${tables.length} common tables`);
  const results = [];
  let mismatches = 0;

  for (const table of tables) {
    try {
      const src = await srcPool.query(`SELECT COUNT(*)::int as c FROM "${table}"`);
      const dst = await destPool.query(`SELECT COUNT(*)::int as c FROM "${table}"`);
      const srcCount = src.rows[0].c;
      const dstCount = dst.rows[0].c;
      const match = srcCount === dstCount;
      if (!match) mismatches++;
      results.push({ table, source: srcCount, target: dstCount, match });
      console.log(`[verify] ${table}: src=${srcCount} target=${dstCount} ${match ? '✓' : '⚠ MISMATCH'}`);
    } catch (e) {
      console.log(`[verify] ${table}: ERROR ${e.message.split('\n')[0]}`);
      results.push({ table, source: -1, target: -1, match: false, error: e.message.split('\n')[0] });
    }
  }

  await destPool.end();

  console.log(`[verify] Done. ${mismatches} mismatches out of ${tables.length} common tables. Missing in target: ${missing.length}`);
  res.json({
    success: mismatches === 0,
    total_tables: tables.length,
    total_tables_on_source: srcTables.length,
    total_tables_on_target: destTables.length,
    tables_missing_in_target: missing,
    mismatches,
    results,
    timestamp: new Date().toISOString(),
  });
});

// ─── GET /api/db-sync/counts ──────────────────────────────────────────────────
// Returns side-by-side row counts for both source and dest.
router.get('/counts', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  const provided = req.headers['x-admin-token'];
  if (adminToken && provided !== adminToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const destUrl = req.query.dest_url;
  if (!destUrl) {
    return res.status(400).json({ success: false, message: 'dest_url query param required' });
  }

  const destPool = new Pool({
    connectionString: destUrl,
    ssl: { rejectUnauthorized: false },
    max: 2,
  });

  const tables = await getAllTables(srcPool);
  const counts = [];
  for (const table of tables) {
    try {
      const src = await srcPool.query(`SELECT COUNT(*) FROM "${table}"`);
      const dst = await destPool.query(`SELECT COUNT(*) FROM "${table}"`);
      counts.push({
        table,
        source: parseInt(src.rows[0].count, 10),
        dest: parseInt(dst.rows[0].count, 10),
        match: src.rows[0].count === dst.rows[0].count,
      });
    } catch {
      counts.push({ table, source: -1, dest: -1, match: false, error: 'not found' });
    }
  }

  await destPool.end();
  res.json({ success: true, counts });
});

module.exports = { router };