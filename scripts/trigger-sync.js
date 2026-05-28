/**
 * Trigger the db-sync endpoint on the deployed app.
 * The app has network access to both source (Polsia) and destination (Render Neon).
 * We trigger via HTTP from this sandbox.
 */
const fetch = require('node-fetch');

const APP_URL = 'https://propopspro.polsia.app';
const ENDPOINT = `${APP_URL}/api/db-sync/sync-from-env`;

console.log(`Triggering sync at ${ENDPOINT}...`);
console.log('This will take a while — the app queries ~70 tables.');

fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  timeout: 600_000,
})
  .then(res => {
    console.log(`HTTP ${res.status}`);
    return res.text();
  })
  .then(body => {
    console.log('Response:', body.slice(0, 2000));
  })
  .catch(err => {
    console.error('Request failed:', err.message);
  });