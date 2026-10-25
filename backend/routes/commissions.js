'use strict';

/**
 * Agent commissions (per house, per month).
 * GET /api/commissions?month=YYYY-MM&house_paybill=... — computed report.
 * PUT /api/commissions/rates — set a house's commission percentage.
 */
const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');

const router = express.Router();
router.use(requireAuthActive);

router.get('/', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const report = await store.getCommissionReport(month, req.query.house_paybill || null);
    res.json(report);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to build commission report' });
  }
});

router.get('/rates', async (req, res) => {
  try {
    res.json({ rates: await store.getCommissionRates() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load commission rates' });
  }
});

router.put('/rates', async (req, res) => {
  try {
    const { house_paybill_number, rate_percent } = req.body || {};
    if (!house_paybill_number) return res.status(400).json({ error: 'house_paybill_number required' });
    const saved = await store.setCommissionRate(house_paybill_number, rate_percent, req.user?.username || null);
    await store.logAudit({
      actor: req.user?.username,
      action: 'commission_rate_updated',
      entityType: 'house',
      entityId: house_paybill_number,
      details: { rate_percent: saved.rate_percent },
    });
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save commission rate: ' + err.message });
  }
});

module.exports = router;
