/**
 * Phone Hugo — Twilio Voice Webhook Routes
 *
 * Handles inbound voice calls to +61 2 5301 0002.
 * Routes to promotion brain (unknown callers) or operator brain (matched operators).
 * Sends QR flyer emails after call completion when email is captured.
 *
 * Endpoints:
 *   POST /api/voice/incoming           — inbound call gateway (Twilio webhook)
 *   POST /api/voice/conversational-turn — each STT turn → LLM → TTS response
 *   POST /api/voice/status-callback    — call completion: dispatch QR flyer emails
 */

'use strict';

const express = require('express');
const twilio = require('twilio');
const { pool } = require('../db/index');
const { getConversationalResponse } = require('../services/hugoVoiceBrain');
const { queueQRFlyer } = require('../services/flyerService');
const { normalizePhone, findNetworkLeadByPhone } = require('../db/phone');

const router = express.Router();

// Twilio webhook signature guard — validates in production, bypasses in dev
const twilioGuard = twilio.webhook({ validate: process.env.NODE_ENV === 'production' });

// ─── TwiML Helpers ─────────────────────────────────────────────────────────────

const VOICE = 'Polly.Neural.Olivia';
const LANGUAGE = 'en-AU';

function buildTwiml(cb) {
  const twiml = new twilio.twiml.VoiceResponse();
  cb(twiml);
  return twiml;
}

function say(text, voice = VOICE) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return { say: { _text: escaped, voice, language: LANGUAGE } };
}

function gatherWithSpeech(text, actionUrl) {
  const g = { gather: { input: 'speech', action: actionUrl, method: 'POST',
    speechTimeout: 'auto', language: LANGUAGE, enhanced: true } };
  g.gather.say = { voice: VOICE, language: LANGUAGE };
  g.gather.say._text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return g;
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Operator Lookup ─────────────────────────────────────────────────────────

async function findOperatorByPhone(callerPhone) {
  const clean = callerPhone.replace(/\//g, '');
  try {
    const result = await pool.query(
      `SELECT id, name, role, email
       FROM propops_operators
       WHERE regexp_replace(phone, '\\D', '', 'g') LIKE $1
         AND user_id IS NOT NULL
       LIMIT 1`,
      [`%${clean.slice(-9)}`]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('[Voice] findOperatorByPhone error:', err.message);
    return null;
  }
}

// ─── POST /api/voice/incoming ─────────────────────────────────────────────────

router.post('/incoming', twilioGuard, async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const rawCallerPhone = req.body.From || '';
  const callSid = req.body.CallSid || `init-${Date.now()}`;

  if (!rawCallerPhone) {
    twiml.say({ voice: VOICE, language: LANGUAGE }, "System routing failure. Unknown caller profile.");
    return res.type('text/xml').send(twiml.toString());
  }

  try {
    const operator = await findOperatorByPhone(rawCallerPhone);
    let brainMode = 'promotion';
    let operatorId = null;
    let initialGreeting = "Hi there, you've reached Hugo — the PropOps AI operations manager. How can I help your business grow today?";

    if (operator) {
      brainMode = 'operator';
      operatorId = operator.id;
      const bizName = operator.name || 'the team';
      initialGreeting = `Hi, you've reached the office of ${bizName}. This is Hugo, their AI operational assistant. How can I help you today?`;
    }

    await pool.query(
      `INSERT INTO call_logs (twilio_call_sid, caller_phone, operator_id, brain_mode)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (twilio_call_sid) DO NOTHING`,
      [callSid, rawCallerPhone, operatorId, brainMode]
    );

    const gather = twiml.gather({
      input: 'speech',
      action: '/api/voice/conversational-turn',
      method: 'POST',
      speechTimeout: 'auto',
      language: LANGUAGE,
      enhanced: true,
    });
    gather.say({ voice: VOICE, language: LANGUAGE }, initialGreeting);

    return res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('[INBOUND ROUTE FAILURE]:', err);
    twiml.say({ voice: VOICE, language: LANGUAGE }, "System temporarily offline.");
    return res.type('text/xml').send(twiml.toString());
  }
});

// ─── POST /api/voice/conversational-turn ─────────────────────────────────────

router.post('/conversational-turn', twilioGuard, async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid || '';
  const speechResult = (req.body.SpeechResult || '').trim();

  if (!speechResult) {
    const gather = twiml.gather({
      input: 'speech',
      action: '/api/voice/conversational-turn',
      speechTimeout: 'auto',
      language: LANGUAGE,
    });
    gather.say({ voice: VOICE, language: LANGUAGE }, "I didn't quite catch that. Could you repeat it for me?");
    return res.type('text/xml').send(twiml.toString());
  }

  try {
    const nextResponseText = await getConversationalResponse(callSid, speechResult);

    const gather = twiml.gather({
      input: 'speech',
      action: '/api/voice/conversational-turn',
      method: 'POST',
      speechTimeout: 'auto',
      language: LANGUAGE,
    });
    gather.say({ voice: VOICE, language: LANGUAGE }, nextResponseText);
    return res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('[CONVERSATIONAL TURN FAILURE]:', err);
    twiml.say({ voice: VOICE, language: LANGUAGE }, "Thank you for calling. Have a great day.");
    return res.type('text/xml').send(twiml.toString());
  }
});

// ─── POST /api/voice/status-callback ─────────────────────────────────────────

router.post('/status-callback', twilioGuard, async (req, res) => {
  const callSid = req.body.CallSid || '';
  const callStatus = req.body.CallStatus || '';

  if (callStatus === 'completed' || callStatus === 'no-answer') {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM call_logs WHERE twilio_call_sid = $1`,
        [callSid]
      );
      if (rows.length > 0) {
        const log = rows[0];
        if (log.brain_mode === 'promotion' && log.email_captured && !log.flyer_sent) {
          // Normalize phone to +61 format and dedup before inserting
          const normPhone = normalizePhone(log.caller_phone) || log.caller_phone || null;
          let skipInsert = false;
          if (normPhone) {
            const existing = await findNetworkLeadByPhone(normPhone);
            if (existing) {
              // Update existing lead with email if missing
              await pool.query(
                `UPDATE network_leads SET contact_email = COALESCE($1, contact_email), updated_at = NOW() WHERE id = $2`,
                [log.email_captured, existing.id]
              );
              skipInsert = true;
              console.log(`[Voice] Phone dedup: updated network_lead #${existing.id} (phone=${normPhone})`);
            }
          }
          if (!skipInsert) {
            await pool.query(
              `INSERT INTO network_leads (contact_phone, contact_email, status)
               VALUES ($1, $2, 'new')
               ON CONFLICT (contact_phone) WHERE contact_phone IS NOT NULL AND contact_phone != ''
               DO UPDATE SET
                 contact_email = COALESCE(EXCLUDED.contact_email, network_leads.contact_email),
                 updated_at = NOW()`,
              [normPhone, log.email_captured]
            );
          }
          const leadType = log.lead_type || 'trade';
          queueQRFlyer(log.email_captured, 'There', leadType).catch(err => {
            console.error(`[FLYER FAILED] ${log.email_captured}:`, err.message);
          });
        }
      }
    } catch (err) {
      console.error('[STATUS CALLBACK PROCESSING ERROR]:', err);
    }
  }

  return res.sendStatus(200);
});

module.exports = router;