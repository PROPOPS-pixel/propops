/**
 * Generate verified QR codes for propops.trade and propops.pro
 * Generates high-res PNGs, decodes them to verify correctness, uploads to R2.
 */

const QRCode = require('qrcode');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');

const POLSIA_API_KEY = process.env.POLSIA_API_KEY || 'company_55743_f42e419ad4eb9d664ef16a05b515437c';
const R2_UPLOAD_URL = 'https://polsia.com/api/proxy/r2/upload';

const QR_CODES = [
  { url: 'https://propops.trade', filename: 'qr-propops-trade.png' },
  { url: 'https://propops.pro', filename: 'qr-propops-pro.png' },
];

async function generateQRCode(url, outputPath) {
  // Generate high-res QR code (600x600px for print quality)
  await QRCode.toFile(outputPath, url, {
    type: 'png',
    width: 600,
    margin: 2,
    errorCorrectionLevel: 'H', // Highest error correction for print reliability
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
  });
  console.log(`✓ Generated QR code: ${outputPath}`);
}

function verifyQRCode(filePath, expectedUrl) {
  const buffer = fs.readFileSync(filePath);
  const png = PNG.sync.read(buffer);
  const imageData = new Uint8ClampedArray(png.data);

  const code = jsQR(imageData, png.width, png.height);

  if (!code) {
    throw new Error(`VERIFICATION FAILED: Could not decode QR code from ${filePath}`);
  }

  if (code.data !== expectedUrl) {
    throw new Error(`VERIFICATION FAILED: QR code contains "${code.data}" but expected "${expectedUrl}"`);
  }

  console.log(`✓ Verified QR code decodes to: ${code.data}`);
  return true;
}

async function uploadToR2(filePath, filename) {
  const fileBuffer = fs.readFileSync(filePath);
  const formData = new FormData();
  formData.append('file', fileBuffer, {
    filename,
    contentType: 'image/png',
  });

  const response = await fetch(R2_UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${POLSIA_API_KEY}`,
      ...formData.getHeaders(),
    },
    body: formData,
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(`Upload failed: ${JSON.stringify(result)}`);
  }

  console.log(`✓ Uploaded to R2: ${result.file.url}`);
  return result.file.url;
}

async function main() {
  console.log('=== QR Code Generator for PropOps ===\n');

  const outputDir = path.join(__dirname, '..', 'public', 'assets');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const results = [];

  for (const { url, filename } of QR_CODES) {
    console.log(`\n--- Processing: ${url} ---`);

    const outputPath = path.join(outputDir, filename);

    // Step 1: Generate
    await generateQRCode(url, outputPath);

    // Step 2: Verify by decoding back
    verifyQRCode(outputPath, url);

    // Step 3: Upload to R2 for CDN access
    const r2Url = await uploadToR2(outputPath, filename);

    results.push({ url, filename, localPath: outputPath, r2Url });
  }

  console.log('\n\n=== RESULTS ===\n');
  for (const r of results) {
    console.log(`${r.url}`);
    console.log(`  Local: ${r.localPath}`);
    console.log(`  CDN:   ${r.r2Url}`);
    console.log('');
  }

  console.log('=== All QR codes generated, verified, and uploaded ===');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
