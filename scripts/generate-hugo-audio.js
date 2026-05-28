#!/usr/bin/env node
/**
 * Generate Hugo greeting audio files using OpenAI TTS and upload to R2 CDN.
 *
 * Usage: OPENAI_API_KEY=... OPENAI_BASE_URL=... POLSIA_API_KEY=... node scripts/generate-hugo-audio.js
 */

'use strict';

const OpenAI = require('openai');
const fetch = require('node-fetch');
const FormData = require('form-data');

const POLSIA_API_KEY = process.env.POLSIA_API_KEY;
const R2_BASE_URL = process.env.POLSIA_R2_BASE_URL || 'https://polsia.com';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const GREETINGS = [
  {
    id: 'hugo-greeting-unmatched',
    text: "G'day, this is Hugo. The team is currently busy. Could you tell me what you need help with today?",
    filename: 'hugo-greeting-unmatched.mp3',
  },
  {
    id: 'hugo-no-speech',
    text: "Sorry, I didn't quite catch that. What can I help you with?",
    filename: 'hugo-no-speech.mp3',
  },
  {
    id: 'hugo-goodbye-nospeech',
    text: "Thanks for calling. I'll let the team know you rang and they'll call you back shortly. Cheers!",
    filename: 'hugo-goodbye-nospeech.mp3',
  },
];

async function generateAudio(text) {
  console.log(`  Generating TTS for: "${text.slice(0, 60)}..."`);

  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'onyx',  // Male voice — Hugo sounds male, not female
    input: text,
    response_format: 'mp3',
    speed: 1.0,
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`  Generated ${buffer.length} bytes of audio`);
  return buffer;
}

async function uploadToR2(buffer, filename) {
  console.log(`  Uploading ${filename} to R2...`);

  const formData = new FormData();
  formData.append('file', buffer, {
    filename,
    contentType: 'audio/mpeg',
  });

  const response = await fetch(`${R2_BASE_URL}/api/proxy/r2/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${POLSIA_API_KEY}`,
      ...formData.getHeaders(),
    },
    body: formData,
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(`R2 upload failed: ${JSON.stringify(result)}`);
  }

  console.log(`  Uploaded: ${result.file.url}`);
  return result.file.url;
}

async function main() {
  console.log('=== Hugo Audio Generator ===\n');

  if (!POLSIA_API_KEY) {
    console.error('Missing POLSIA_API_KEY');
    process.exit(1);
  }

  const urls = {};

  for (const greeting of GREETINGS) {
    console.log(`\n[${greeting.id}]`);
    try {
      const audio = await generateAudio(greeting.text);
      const url = await uploadToR2(audio, greeting.filename);
      urls[greeting.id] = url;
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      // If OpenAI TTS fails, we'll need a fallback
      urls[greeting.id] = null;
    }
  }

  console.log('\n=== Results ===');
  console.log(JSON.stringify(urls, null, 2));

  return urls;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
