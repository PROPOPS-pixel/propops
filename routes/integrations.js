/**
 * Integration management — Groq API key storage and verification.
 *
 * Owns: Groq key upsert + status check endpoints.
 * Does NOT own: other integration rows (Resend, Twilio, Gemini), email pipeline, Hugo brain.
 */

const express = require('express');
const router  = express.Router();
const { requireAuth } = require('./auth');
const { upsertCredential, getCredential, listCredentials } = require('../db/credentials');

// ─── GET /api/integrations/groq/status ─────────────────────────────────────

router.get('/groq/status', requireAuth, async (req, res) => {
  try {
    const apiKey = await getCredential('groq');
    if (!apiKey) {
      return res.json({ connected: false, reason: 'No Groq key configured' });
    }
    // Verify by hitting Groq models endpoint
    const groqVerify = await fetch('https://api.groq.com/openai/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    return res.json({ connected: groqVerify.ok });
  } catch (error) {
    console.error('[Integrations] Groq status check failed:', error.message);
    return res.status(500).json({ error: 'Failed to check Groq status.' });
  }
});

// ─── POST /api/integrations/groq/key ────────────────────────────────────────

router.post('/groq/key', requireAuth, async (req, res) => {
  const { api_key } = req.body;
  if (!api_key || !api_key.trim()) {
    return res.status(400).json({ error: 'API Key cannot be blank.' });
  }
  const trimmed = api_key.trim();
  try {
    // Reject keys that don't look like Groq keys
    if (!trimmed.startsWith('gsk_')) {
      return res.status(400).json({ error: 'Invalid key format. Groq keys start with gsk_.' });
    }
    // Verify before storing
    const groqVerify = await fetch('https://api.groq.com/openai/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${trimmed}`,
        'Content-Type': 'application/json',
      },
    });
    if (!groqVerify.ok) {
      return res.status(401).json({ error: 'Groq rejected this key.' });
    }
    await upsertCredential('groq', trimmed);
    return res.json({ success: true, message: 'Groq integration is live.' });
  } catch (error) {
    console.error('[Integrations] Groq key save failed:', error.message);
    return res.status(500).json({ error: 'Network or database error.' });
  }
});

// ─── GET /api/integrations (all services status) ────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await listCredentials();
    res.json({ success: true, credentials: rows });
  } catch (error) {
    console.error('[Integrations] List failed:', error.message);
    res.status(500).json({ success: false, error: 'Failed to load integrations.' });
  }
});

module.exports = router;