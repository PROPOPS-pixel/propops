/**
 * Staff weekly roster summary cron — runs Sunday 08:00 UTC = 6pm AEST.
 * Sends each active staff member an email with their upcoming week's shifts.
 *
 * Declared in polsia.toml as a [[cron]] entry.
 */

require('../services/staff-notifications').sendWeeklyRosterSummaries()
  .then(r => {
    console.log(`[WeeklyRoster] ${r.sent} emails sent, ${r.skipped} skipped`);
    process.exit(0);
  })
  .catch(err => {
    console.error('[WeeklyRoster] Unhandled error:', err.message);
    process.exit(1);
  });