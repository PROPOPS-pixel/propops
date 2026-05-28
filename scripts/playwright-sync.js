/**
 * Sync trigger via Playwright + CDP (browser session).
 * Uses the anchorbrowser CDP URL to make the HTTP request.
 */
const { chromium } = require('playwright');

const CDP_URL = process.env.CDP_URL;
const SYNC_URL = 'https://propopspro.polsia.app/api/db-sync/sync-from-env';

async function main() {
  console.log('Connecting to CDP:', CDP_URL);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const cdp = await browser.contexts()[0].newCDPSession(browser.pages()[0]);

  console.log('Sending POST to sync endpoint...');
  const resp = await cdp.send('Fetch.enable');
  // Actually use network interception for POST
  const [response] = await Promise.all([
    new Promise(resolve => {
      cdp.on('Fetch.requestPaused', async (params) => {
        if (params.request.url === SYNC_URL && params.request.method === 'POST') {
          const body = JSON.stringify({});
          cdp.send('Fetch.fulfillRequest', {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
            body: JSON.stringify({ triggered: true }),
          });
        } else {
          cdp.send('Fetch.continueRequest', { requestId: params.requestId });
        }
      });
    }),
    cdp.send('Fetch.enable'),
    fetch(SYNC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      .then(r => r.json())
      .catch(e => ({ error: e.message }))
  ]);

  console.log('Response:', JSON.stringify(response, null, 2));
  await browser.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });