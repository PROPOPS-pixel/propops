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
  // Self-ping keepalive
  const APP_URL = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (APP_URL) {
    const { get } = APP_URL.startsWith('https') ? require('https') : require('http');
    setInterval(() => get(`${APP_URL}/health`, (r) => r.resume()).on('error', () => {}), 4 * 60 * 1000);
    console.log(`[Keepalive] Self-ping enabled: ${APP_URL}/health every 4 min`);
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

  // Daily/weekly scheduler (every-minute tick)
  const DIGEST_HOUR_UTC = parseInt(process.env.DIGEST_CRON_HOUR_UTC || '8', 10);
  // Nightly supervision: 12:00 UTC = 10pm AEST (low-traffic window, ~$0.01/night)
  const SUPERVISION_HOUR_UTC = parseInt(process.env.SUPERVISION_CRON_HOUR_UTC || '12', 10);
  // Operator digest: 22:00 UTC = 8am AEST; configurable via OPERATOR_DIGEST_CRON_HOUR_UTC
  const OPERATOR_DIGEST_HOUR_UTC = parseInt(process.env.OPERATOR_DIGEST_CRON_HOUR_UTC || '22', 10);
  let lastDigestDate = null, lastLandingSyncDate = null, lastWeeklyAnalysisWeek = null, lastSupervisionDate = null, lastOpDigestDate = null;
  setInterval(() => {
    const now = new Date();
    const h = now.getUTCHours(), m = now.getUTCMinutes(), d = now.getUTCDay();
    const dateKey = now.toISOString().slice(0, 10);
    const weekKey = `${now.getUTCFullYear()}-W${String(Math.ceil(now.getUTCDate() / 7)).padStart(2, '0')}-${dateKey.slice(0, 7)}`;

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

    // Operator daily digest (tradie operators + founder) — 22:00 UTC = 8am AEST
    // Skips operators with no new activity since last digest — no empty emails
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
        .then(results => {
          const changed = results.filter(r => r.changed).map(r => r.domain);
          if (changed.length > 0) console.log(`[LandingSync] Midnight: updated ${changed.join(', ')}`);
        })
        .catch(err => console.error('[LandingSync] Midnight sync error:', err.message));
    }
  }, 60 * 1000);
}

module.exports = { runStartup };
