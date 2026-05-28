/**
 * Hugo inbox routes — public API endpoint for lead inquiry data.
 *
 * Owns: GET /api/hugo/inbox (operator leads + stats).
 * Does NOT own: hugo-brain.js prompt injection, hugoBrainContext.js logic.
 */

const express = require('express');
const router = express.Router();
const { getInboxDataInternal } = require('../services/inboxService');

router.get('/inbox', async (req, res) => {
  const operatorId = req.query.operator_id;
  try {
    const data = await getInboxDataInternal(operatorId);
    return res.status(200).json({ success: true, stats: data.stats, leads: data.leads });
  } catch (error) {
    console.error('[Hugo Inbox] Express wrapper caught an exception:', error.message);
    if (error.message.includes('required')) return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: 'Internal server error pulling inbox array metrics.' });
  }
});

module.exports = router;