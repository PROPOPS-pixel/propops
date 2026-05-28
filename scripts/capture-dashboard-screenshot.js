#!/usr/bin/env node
/**
 * Captures a screenshot of the demo-preview page and saves it as a static PNG.
 * Run: node scripts/capture-dashboard-screenshot.js <screenshot_url>
 *
 * The screenshot URL is provided as a CLI argument (from sapiom_screenshot tool).
 * The script downloads the PNG and saves it to public/dashboard-screenshot.png
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

async function downloadImage(url, outputPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(outputPath);

    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Follow redirect
        file.close();
        downloadImage(response.headers.location, outputPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${url}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
      file.on('error', reject);
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  const screenshotUrl = process.argv[2];
  if (!screenshotUrl) {
    console.error('Usage: node scripts/capture-dashboard-screenshot.js <screenshot_url>');
    process.exit(1);
  }

  const outputPath = path.join(__dirname, '..', 'public', 'dashboard-screenshot.png');
  console.log(`Downloading screenshot from: ${screenshotUrl}`);
  console.log(`Saving to: ${outputPath}`);

  try {
    await downloadImage(screenshotUrl, outputPath);
    const stats = fs.statSync(outputPath);
    console.log(`✅ Screenshot saved (${Math.round(stats.size / 1024)}KB)`);
  } catch (err) {
    console.error(`❌ Failed: ${err.message}`);
    process.exit(1);
  }
}

main();
