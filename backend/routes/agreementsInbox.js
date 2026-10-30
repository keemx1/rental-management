'use strict';

/**
 * Agreements Inbox — /api/agreements-inbox
 * Drop-folder automation for tenancy agreement PDFs. STORE-ONLY:
 * matched files go to the tenant's Agreements section; WhatsApp is
 * never invoked from here (management shares manually, as today).
 */
const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const inbox = require('../services/agreementsInbox');

const router = express.Router();
router.use(requireAuthActive);

router.get('/status', async (req, res) => {
  try {
    res.json(inbox.status());
  } catch (err) {
    res.status(500).json({ error: 'Status unavailable: ' + err.message });
  }
});

router.post('/process', async (req, res) => {
  try {
    const summary = await inbox.processInbox({ actor: req.user?.username || 'agreements-inbox' });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: 'Inbox processing failed: ' + err.message });
  }
});

module.exports = router;
