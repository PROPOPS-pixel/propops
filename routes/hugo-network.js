/**
 * Hugo Network routes.
 *
 * POST /api/hugo/network/request          — Operator asks Hugo for a tradie
 * GET  /api/hugo/network/history          — Operator's request history
 * GET  /api/hugo/network/status/:id       — Status of a specific request
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('./auth');
const hugoNetwork = require('../services/hugo-network');

// POST /api/hugo/network/request
// Operator sends a free-text request. Hugo parses, matches, responds naturally.
router.post('/network/request', requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ success: false, message: 'Message is required' });
  }
  try {
    const result = await hugoNetwork.processNetworkRequest(req.userId, {
      message: message.trim()
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[HugoNetwork] POST /network/request error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to process request' });
  }
});

// GET /api/hugo/network/history
// Returns the operator's recent network requests.
router.get('/network/history', requireAuth, async (req, res) => {
  try {
    const history = await hugoNetwork.getRequestHistory(req.userId);
    res.json({ success: true, history });
  } catch (err) {
    console.error('[HugoNetwork] GET /network/history error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch history' });
  }
});

// GET /api/hugo/network/status/:requestId
// Returns the current status of a specific request.
router.get('/network/status/:requestId', requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.requestId, 10);
  if (!requestId || isNaN(requestId)) {
    return res.status(400).json({ success: false, message: 'Invalid request ID' });
  }
  try {
    const request = await hugoNetwork.getRequestStatus(requestId, req.userId);
    if (!request) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    res.json({ success: true, request });
  } catch (err) {
    console.error('[HugoNetwork] GET /network/status error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch status' });
  }
});

module.exports = router;
