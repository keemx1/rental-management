'use strict';

/**
 * Central Notification Bar — /api/notifications
 * Read-only reporting over existing records (never changes any balance,
 * approval or ledger). Viewing never resolves an alert.
 */
const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const notifications = require('../services/notifications');

const router = express.Router();
router.use(requireAuthActive);

router.get('/', async (req, res) => {
  try {
    res.json(await notifications.getNotifications());
  } catch (err) {
    res.status(500).json({ error: 'Failed to load notifications: ' + err.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    res.json(await notifications.getHistory({
      status: req.query.status,
      limit: req.query.limit,
    }));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load history: ' + err.message });
  }
});

module.exports = router;
