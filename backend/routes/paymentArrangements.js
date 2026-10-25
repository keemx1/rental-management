/**
 * Payment Arrangements — MANAGEMENT-ONLY approved payment dates.
 * All routes require authenticated staff (no tenant role exists in this
 * system). Arrangement data is never included in receipts, statements,
 * confirmations, letters or WhatsApp messages — those outputs are untouched.
 */
const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');

const router = express.Router();
router.use(requireAuthActive);

router.get('/tenant/:code', async (req, res) => {
  try {
    const tenant = await store.getTenant(req.params.code);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const view = await store.listArrangements(req.params.code);
    res.json(view);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load arrangements' });
  }
});

router.get('/:id/history', async (req, res) => {
  try {
    const row = await store.getArrangement(req.params.id);
    if (!row) return res.status(404).json({ error: 'Arrangement not found' });
    const history = await store.getArrangementHistory(req.params.id);
    res.json({ arrangement: row, history });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load history' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { tenant_code, billing_period, requested_date, approved_date, reason } = req.body || {};
    if (!tenant_code) return res.status(400).json({ error: 'tenant_code required' });
    const row = await store.createArrangement({
      tenant_code, billing_period, requested_date, approved_date, reason,
      created_by: req.user?.username || null,
    });
    res.status(201).json({ arrangement: row });
  } catch (err) {
    const msg = err.message || 'Failed to create arrangement';
    const code = /already|duplicate/i.test(msg) ? 409 : 400;
    res.status(code).json({ error: msg });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const { approved_date, reason } = req.body || {};
    const row = await store.transitionArrangement(req.params.id, {
      action: 'approve', approved_date, reason, actor: req.user?.username || null,
    });
    res.json({ arrangement: row });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to approve arrangement' });
  }
});

router.post('/:id/decline', async (req, res) => {
  try {
    const { reason } = req.body || {};
    const row = await store.transitionArrangement(req.params.id, {
      action: 'decline', reason, actor: req.user?.username || null,
    });
    res.json({ arrangement: row });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to decline arrangement' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { approved_date, requested_date, reason } = req.body || {};
    const row = await store.transitionArrangement(req.params.id, {
      action: 'modify', approved_date, requested_date, reason, actor: req.user?.username || null,
    });
    res.json({ arrangement: row });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to modify arrangement' });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const { reason } = req.body || {};
    const row = await store.transitionArrangement(req.params.id, {
      action: 'cancel', reason, actor: req.user?.username || null,
    });
    res.json({ arrangement: row });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to cancel arrangement' });
  }
});

router.post('/:id/expire', async (req, res) => {
  try {
    const { reason } = req.body || {};
    const row = await store.transitionArrangement(req.params.id, {
      action: 'expire', reason, actor: req.user?.username || null,
    });
    res.json({ arrangement: row });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to expire arrangement' });
  }
});

module.exports = router;
