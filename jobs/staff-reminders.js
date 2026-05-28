/**
 * Staff reminder cron — runs every hour, sends shift reminders to staff
 * whose upcoming shift falls within their preferred reminder window.
 *
 * Declared in polsia.toml as a [[cron]] entry.
 * In Blaxel mode (POLSIA_IN_PROCESS_CRONS_ENABLED=false): run via Render cron.
 * In legacy mode: handled by in-process scheduler in routes/startup.js.
 */

require('../services/staff-notifications').sendShiftReminders()
  .then(r => {
    if (r.error) {
      console.error('[StaffReminders] Error:', r.error);
      process.exit(1);
    }
    console.log(`[StaffReminders] Done — ${r.sent} sent, ${r.skipped} skipped`);
    process.exit(0);
  })
  .catch(err => {
    console.error('[StaffReminders] Unhandled error:', err.message);
    process.exit(1);
  });