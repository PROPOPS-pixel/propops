/**
 * Hugo Inbox API — exposes lead data for the dashboard + brain context injection.
 *
 * Owns: GET /api/hugo/inbox — returns operator leads + stats.
 * Does NOT own: lead creation, email parsing, or brain logic.
 */

const express = require('express');
const router = express.Router();
const { getInboxDataInternal } = require('../services/inboxService');

router.get('/api/hugo/inbox', async (req, res) => {
  const operatorId = req.query.operator_id;

  if (!operatorId) {
    return res.status(400).json({ error: 'operator_id query param is required' });
  }

  try {
    const data = await getInboxDataInternal(operatorId);

    // Strip is_test rows from the public response — never surface these to operators
    const filteredLeads = data.leads.map(lead => {
      const { is_test, ...rest } = lead;
      return rest;
    });

    return res.status(200).json({
      success: true,
      stats: data.stats,
      leads: filteredLeads,
    });
  } catch (error) {
    console.error('Express wrapper inbox route caught an exception:', error.message);
    if (error.message.includes('required')) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Internal server error pulling inbox array metrics.' });
  }
});

module.exports = router;