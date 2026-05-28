/**
 * Startup tasks — runs once after app.listen().
 *
 * Owns: self-ping keepalive, screenshot cache pre-warm, landing page sync,
 *       daily digest cron, weekly analysis cron, nightly supervision cron.
 * Does NOT own: HTTP routing, database migration, auth.
 */

const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

/**
 * Run all startup tasks after app.listen().
 * @param {string} _SS_CACHE - Path to screenshot cache file
 * @param {function} _downloadToBuffer - Screenshot download helper
 */
function runStartup(_SS_CACHE, _downloadToBuffer) {
  // Self-ping keepalive — always have a fallback so sync never skips due to missing env
  const APP_URL = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || 'https://propopspro.polsia.app';
  if (APP_URL) {
    const { get } = APP_URL.startsWith('https') ? require('https') : require('http');
    setInterval(() => get(`${APP_URL}/health`, (r) => r.resume()).on('error', () => {}), 4 * 60 * 1000);
    console.log(`[Keepalive] Self-ping enabled: ${APP_URL}/health every 4 min`);
  }

  // One-time DB sync to Neon — runs inline (no HTTP self-call) when NEON_DATABASE_URL is set.
  // Only runs once: checks app_settings for 'neon_sync_done' flag before proceeding.
  // Kill switch: set SKIP_DB_SYNC=1 to disable. FORCE_DB_SYNC=1 to re-run full CREATE TABLE + sync.
  const syncDestUrl = process.env.NEON_DATABASE_URL;
  if (syncDestUrl && process.env.SKIP_DB_SYNC !== '1') {
    const shouldForce = process.env.FORCE_DB_SYNC === '1';
    // Check done flag — skip unless FORCE_DB_SYNC=1
    pool.query(`SELECT value FROM app_settings WHERE key = $1`, ['neon_sync_done'])
      .then(({ rows }) => {
        if (rows[0]?.value && !shouldForce) {
          console.log('[DB-Sync] Already completed — skipping (FORCE_DB_SYNC=1 to re-run)');
          return;
        }
        console.log('[DB-Sync] Starting Polsia → Neon sync...');
        doSync().then(({ errors, mismatches, missing }) => {
          const ok = errors === 0 && mismatches === 0;
          if (ok) {
            // Mark done so subsequent boots skip it
            pool.query(
              `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
              ['neon_sync_done', new Date().toISOString()]
            ).catch(() => {});
            console.log('[DB-Sync] Complete ✓');
          } else {
            console.log(`[DB-Sync] Done with ${errors} errors and ${mismatches} mismatches — check logs above`);
          }
        }).catch(e => console.error('[DB-Sync] Fatal:', e.message));
      })
      .catch(e => console.error('[DB-Sync] Could not check flag, proceeding:', e.message));
  } else if (!syncDestUrl) {
    console.log('[DB-Sync] NEON_DATABASE_URL not set — skipping');
  } else {
    console.log('[DB-Sync] SKIP_DB_SYNC=1 — skipping');
  }

  // ── Inline DB sync function (runs inside promise chain above) ───────────────
  function doSync() {
    return new Promise(async (resolve) => {
      const srcPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 2, connectionTimeoutMillis: 15000,
      });
      const destPool = new Pool({
        connectionString: syncDestUrl,
        ssl: { rejectUnauthorized: false },
        max: 3, connectionTimeoutMillis: 15000,
      });

      const getTables = async (p) => {
        const { rows } = await p.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
        );
        return rows.map(r => r.table_name);
      };
      const countRows = async (p, t) => {
        const { rows } = await p.query(`SELECT count(*)::int as c FROM "${t}"`);
        return rows[0].c;
      };
      const truncate = async (p, t) => {
        await p.query(`TRUNCATE "${t}" RESTART IDENTITY CASCADE`);
      };
      const getColumns = async (p, t) => {
        const { rows } = await p.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t]
        );
        return rows.map(r => r.column_name);
      };

      const getColumnMeta = async (p, t) => {
        const { rows } = await p.query(
          `SELECT column_name, data_type, udt_name, character_maximum_length, numeric_precision, numeric_scale, is_nullable, column_default
           FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t]
        );
        return rows;
      };

      const pgType = (dataType, udtName) => {
        if (['bytea'].includes(dataType))               return 'bytea';
        if (['json', 'jsonb'].includes(dataType))      return dataType;
        if (['text'].includes(dataType))               return 'text';
        if (['boolean'].includes(dataType))           return 'boolean';
        if (['smallint'].includes(dataType))           return 'smallint';
        if (['integer'].includes(dataType))            return 'integer';
        if (['bigint'].includes(dataType))             return 'bigint';
        if (['real'].includes(dataType))               return 'real';
        if (['double precision'].includes(dataType))   return 'double precision';
        if (['numeric'].includes(dataType))            return 'numeric';
        if (['timestamp', 'timestamp without time zone'].includes(dataType)) return 'timestamp';
        if (['timestamptz', 'timestamp with time zone'].includes(dataType))    return 'timestamptz';
        if (['date'].includes(dataType))               return 'date';
        if (['time'].includes(dataType))               return 'time';
        if (['timetz', 'time with time zone'].includes(dataType))              return 'timetz';
        if (['interval'].includes(dataType))           return 'interval';
        if (['uuid'].includes(dataType))               return 'uuid';
        if (['inet'].includes(dataType))               return 'inet';
        if (['cidr'].includes(dataType))               return 'cidr';
        if (['macaddr'].includes(dataType))            return 'macaddr';
        if (['serial'].includes(dataType))             return 'serial';
        if (['bigserial'].includes(dataType))          return 'bigserial';
        if (dataType === 'ARRAY')                      return udtName.replace(/["]/g, '') + '[]';
        return 'text'; // safe fallback
      };

      const createTable = async (src, dst, tableName) => {
        const cols = await getColumnMeta(src, tableName);
        if (!cols.length) return false;
        const colDefs = cols.map(col => {
          let type = pgType(col.data_type, col.udt_name);
          if (col.character_maximum_length) type += `(${col.character_maximum_length})`;
          else if (col.numeric_precision !== null && col.numeric_scale !== null) type += `(${col.numeric_precision},${col.numeric_scale})`;
          else if (col.numeric_precision !== null) type += `(${col.numeric_precision})`;
          const nullable = col.is_nullable === 'NO' ? ' NOT NULL' : '';
          const def = col.column_default ? ` DEFAULT ${col.column_default}` : '';
          return `  "${col.column_name}" ${type}${def}${nullable}`;
        }).filter(x => x.trim());
        const ddl = `CREATE TABLE "${tableName}" (\n${colDefs.join(',\n')}\n)`;
        await dst.query(ddl);
        return true;
      };

      try {
        await srcPool.query('SELECT 1');
        console.log('[DB-Sync] Source DB: ✓');
      } catch (e) {
        console.error('[DB-Sync] Source DB FAILED:', e.message);
        await srcPool.end(); await destPool.end();
        return resolve({ errors: 1, mismatches: 0, missing: [] });
      }
      try {
        await destPool.query('SELECT 1');
        console.log('[DB-Sync] Target DB: ✓');
      } catch (e) {
        console.error('[DB-Sync] Target DB FAILED:', e.message);
        await srcPool.end(); await destPool.end();
        return resolve({ errors: 1, mismatches: 0, missing: [] });
      }

      const srcTables  = await getTables(srcPool);
      const destTables = await getTables(destPool);
      const destSet    = new Set(destTables);
      const tables    = srcTables.filter(t => destSet.has(t));
      const missing   = srcTables.filter(t => !destSet.has(t));
      console.log(`[DB-Sync] ${srcTables.length} src tables, ${destTables.length} target — syncing ${tables.length}, creating ${missing.length} missing`);

      let totalErrors = 0, totalMismatches = 0;

      // Create missing tables in target
      if (missing.length) {
        console.log(`[DB-Sync] Creating ${missing.length} missing tables in target...`);
        for (const table of missing) {
          process.stdout.write(`  Creating ${table}... `);
          try {
            await createTable(srcPool, destPool, table);
            console.log('✓');
          } catch (e) {
            console.log(`FAIL: ${e.message.split('\n')[0]}`);
            totalErrors++;
          }
        }
      }

      // Refresh destSet after creating tables
      const destTablesAfter = await getTables(destPool);
      const destSetAfter = new Set(destTablesAfter);
      const allSyncable = srcTables.filter(t => destSetAfter.has(t));
      for (const table of allSyncable) {
        process.stdout.write(`[DB-Sync] ${table}... `);
        try {
          const srcCount = await countRows(srcPool, table);
          try { await truncate(destPool, table); } catch (e) { /* empty */ }
          if (srcCount === 0) { console.log('0 rows ✓'); continue; }

          const cols   = await getColumns(srcPool, table);
          const colN   = cols.length;
          const cNames = cols.map(c => `"${c}"`);
          const BATCH  = 500;
          let offset   = 0, dstCount = 0;

          while (offset < srcCount) {
            const { rows } = await srcPool.query(`SELECT * FROM "${table}" LIMIT ${BATCH} OFFSET ${offset}`);
            if (!rows.length) break;

            const vals = rows.flatMap(row => cols.map(c => {
              const v = row[c];
              if (v === undefined || v === null) return null;
              return typeof v === 'object' ? JSON.stringify(v) : v;
            }));
            const sql = `INSERT INTO "${table}" (${cNames.join(',')}) VALUES ` +
              rows.map((_, ri) => `(${Array.from({ length: colN }, (_, i) => `$${ri * colN + i + 1}`).join(',')})`).join(',') +
              ` ON CONFLICT DO NOTHING`;

            try {
              await destPool.query(sql, vals);
              dstCount += rows.length;
            } catch (e) {
              let ok = 0, fail = 0;
              for (const row of rows) {
                const rVals = cols.map(c => {
                  const v = row[c];
                  if (v === undefined || v === null) return null;
                  return typeof v === 'object' ? JSON.stringify(v) : v;
                });
                try {
                  await destPool.query(
                    `INSERT INTO "${table}" (${cNames.join(',')}) VALUES (${rVals.map((_, i) => `$${i+1}`).join(',')}) ON CONFLICT DO NOTHING`, rVals
                  );
                  ok++;
                } catch (_) { fail++; }
              }
              dstCount += ok;
              if (fail > 0) console.log(`  per-row: ${ok} ok, ${fail} failed`);
            }

            offset += BATCH;
            process.stdout.write(`\r[DB-Sync] ${table}: ${dstCount}/${srcCount} `);
          }

          const match = dstCount === srcCount;
          if (!match) totalMismatches++;
          console.log(`${dstCount}/${srcCount} ${match ? '✓' : '⚠ MISMATCH'}`);
        } catch (e) {
          console.log(`ERROR: ${e.message.split('\n')[0]}`);
          totalErrors++;
        }
      }

      console.log('\n[DB-Sync] Verification...');
      for (const table of allSyncable) {
        try {
          const src = await countRows(srcPool, table);
          const dst = await countRows(destPool, table);
          console.log(`  ${table.padEnd(45)} src=${src} dst=${dst} ${src === dst ? '✓' : '⚠'}`);
        } catch (e) {
          console.log(`  ${table.padEnd(45)} ERROR: ${e.message.split('\n')[0]}`);
        }
      }

      await srcPool.end();
      await destPool.end();
      resolve({ errors: totalErrors, mismatches: totalMismatches, missing });
    });
  }

  // Pre-warm screenshot cache (5s delay for DB readiness)
  setTimeout(async () => {
    if (fs.existsSync(_SS_CACHE)) {
      try { if (fs.statSync(_SS_CACHE).size > 10000) return; } catch (e) {}
    }
    try {
      const dbRow = await pool.query(`SELECT value FROM site_settings WHERE key = 'screenshot_b64'`);
      if (dbRow.rows[0]?.value) {
        const buf = Buffer.from(dbRow.rows[0].value, 'base64');
        if (buf.length > 10000) { fs.writeFileSync(_SS_CACHE, buf); return; }
      }
    } catch (e) {}
    try {
      const appUrl = (process.env.APP_URL || 'https://propopspro.polsia.app').replace(/\/$/, '');
      const buf = await _downloadToBuffer(`https://image.thum.io/get/png/width/1280/${appUrl}/demo-preview.html`);
      if (buf.length > 20000) fs.writeFileSync(_SS_CACHE, buf);
    } catch (e) {}
  }, 5000);

  // Landing page sync on startup
  setTimeout(async () => {
    try {
      const { syncLandingPages } = require('../services/landing-page-sync');
      const results = await syncLandingPages();
      const changed = results.filter(r => r.changed).map(r => r.domain);
      if (changed.length > 0) console.log(`[LandingSync] Startup: updated: ${changed.join(', ')}`);
      else console.log('[LandingSync] Startup: all pages current');
    } catch (err) { console.error(`[LandingSync] Startup sync failed: ${err.message}`); }
  }, 5000);

  // ── Auto-read company inbox (propopspro@polsia.app) ──────────────────────
  // Kill switch: set HUGO_AUTO_READ_ENABLED=false to disable entirely.
  const AUTO_READ_INTERVAL_MS = parseInt(process.env.HUGO_INBOX_POLL_INTERVAL_MS || '300000', 10);
  if (process.env.HUGO_AUTO_READ_ENABLED !== 'false') {
    console.log(`[AutoRead] Company inbox auto-read enabled — polling every ${AUTO_READ_INTERVAL_MS / 1000}s`);
    const runAutoRead = () => {
      if (process.env.HUGO_AUTO_READ_ENABLED === 'false') {
        console.log('[AutoRead] Kill switch activated — auto-read disabled');
        return;
      }
      Promise.resolve().then(async () => {
        try {
          const emailIntake = require('./email-intake');
          const systemToken = await emailIntake.getSystemToken();
          const { pollAndProcessInbox } = require('../services/hugo-inbox-reader');
          const stats = await pollAndProcessInbox(emailIntake.processInboundEmail, systemToken);
          if (stats.disabled) return;
          if (stats.processed > 0 || stats.errors > 0 || stats.skipped_loop > 0) {
            console.log(`[AutoRead] Poll: processed=${stats.processed} loop_skip=${stats.skipped_loop} dedup=${stats.skipped_dedup} errors=${stats.errors}`);
          }
        } catch (err) {
          console.error('[AutoRead] Poll error:', err.message);
        }
      });
    };
    setTimeout(runAutoRead, 30000);
    setInterval(runAutoRead, AUTO_READ_INTERVAL_MS);
  } else {
    console.log('[AutoRead] Company inbox auto-read DISABLED (HUGO_AUTO_READ_ENABLED=false)');
  }

  // ── In-process scheduler (legacy, guarded) ─────────────────────────────
  // WHY: In-process schedulers must be guarded. When POLSIA_IN_PROCESS_CRONS_ENABLED=false
  // (Blaxel mode), these jobs run via polsia.toml [[crons]] entries instead.
  // staff-shift-reminders and staff-weekly-roster are the polsia.toml cron targets;
  // the in-process path here is the legacy fallback (web process).
  const DIGEST_HOUR_UTC = parseInt(process.env.DIGEST_CRON_HOUR_UTC || '8', 10);
  const SUPERVISION_HOUR_UTC = parseInt(process.env.SUPERVISION_CRON_HOUR_UTC || '12', 10);
  const OPERATOR_DIGEST_HOUR_UTC = parseInt(process.env.OPERATOR_DIGEST_CRON_HOUR_UTC || '22', 10);
  const WEEKLY_ROSTER_HOUR_UTC = parseInt(process.env.WEEKLY_ROSTER_CRON_HOUR_UTC || '8', 10);

  let lastDigestDate = null, lastLandingSyncDate = null, lastWeeklyAnalysisWeek = null;
  let lastSupervisionDate = null, lastOpDigestDate = null, lastWeeklyRosterDate = null;
  let lastShiftReminderHour = null;

  if (process.env.POLSIA_IN_PROCESS_CRONS_ENABLED !== 'false') {
    console.log('[Scheduler] In-process cron enabled');
    setInterval(() => {
      const now = new Date();
      const h = now.getUTCHours(), m = now.getUTCMinutes(), d = now.getUTCDay();
      const dateKey = now.toISOString().slice(0, 10);
      const weekKey = `${now.getUTCFullYear()}-W${String(Math.ceil(now.getUTCDate() / 7)).padStart(2, '0')}-${dateKey.slice(0, 7)}`;
      const hourKey = `${dateKey}-${String(h).padStart(2, '0')}`;

      // Shift reminders — every hour on the :00 minute
      if (m === 0 && lastShiftReminderHour !== hourKey) {
        lastShiftReminderHour = hourKey;
        require('../services/staff-notifications').sendShiftReminders()
          .then(r => { if (r.sent > 0) console.log(`[ShiftReminders] ${r.sent} sent, ${r.skipped} skipped`); })
          .catch(err => console.error('[ShiftReminders] Error:', err.message));
      }

      // Staff weekly roster summary — Sunday 08:00 UTC (6pm AEST)
      if (d === 0 && h === WEEKLY_ROSTER_HOUR_UTC && m === 0 && lastWeeklyRosterDate !== dateKey) {
        lastWeeklyRosterDate = dateKey;
        require('../services/staff-notifications').sendWeeklyRosterSummaries()
          .then(r => console.log(`[WeeklyRoster] ${r.sent} emails sent, ${r.skipped} skipped`))
          .catch(err => console.error('[WeeklyRoster] Error:', err.message));
      }

      // Hugo weekly learning analysis — Sunday 16:00 UTC (2AM AEST Monday)
      if (d === 0 && h === 16 && m === 0 && lastWeeklyAnalysisWeek !== weekKey) {
        lastWeeklyAnalysisWeek = weekKey;
        require('../tasks/weekly-learning-analysis').runWeeklyAnalysis()
          .then(() => console.log('[WeeklyAnalysis] Complete'))
          .catch(err => console.error('[WeeklyAnalysis] Error:', err.message));
      }

      // Daily digest (RE agents) — configurable UTC hour (default 8 = 6pm AEST)
      if (h === DIGEST_HOUR_UTC && m === 0 && lastDigestDate !== dateKey) {
        lastDigestDate = dateKey;
        require('../services/notifications').sendDailyDigest()
          .catch(err => console.error('[Scheduler] Daily digest error:', err.message));
      }

      // Operator daily digest — 22:00 UTC = 8am AEST
      if (h === OPERATOR_DIGEST_HOUR_UTC && m === 0 && lastOpDigestDate !== dateKey) {
        lastOpDigestDate = dateKey;
        require('../services/operator-notifications').sendOperatorDailyDigest()
          .catch(err => console.error('[Scheduler] Operator digest error:', err.message));
      }

      // Nightly Hugo supervision batch — 12:00 UTC = 10pm AEST
      if (h === SUPERVISION_HOUR_UTC && m === 0 && lastSupervisionDate !== dateKey) {
        lastSupervisionDate = dateKey;
        require('../services/hugo-supervision').runNightlyBatch()
          .then(r => console.log(`[Supervision] Nightly complete: ${r.conversations_reviewed} reviewed, ${r.conversations_flagged} flagged`))
          .catch(err => console.error('[Supervision] Nightly error:', err.message));
      }

      // Landing page midnight AEST sync — 14:00 UTC = midnight AEST
      if (h === 14 && m === 0 && lastLandingSyncDate !== dateKey) {
        lastLandingSyncDate = dateKey;
        require('../services/landing-page-sync').syncLandingPages()
          .then((results) => {
            const changed = results.filter(r => r.changed).map(r => r.domain);
            if (changed.length > 0) console.log('[LandingSync] Midnight: updated ' + changed.join(', '));
          })
          .catch(err => console.error('[LandingSync] Midnight sync error:', err.message));
      }
    }, 60 * 1000);
  }
}

module.exports = { runStartup };