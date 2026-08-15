const express = require('express');
const router = express.Router();
const store = require('../storage/store');
const { requireAuthActive } = require('../middleware/auth');

router.use(requireAuthActive);

router.get('/:tenantCode', async (req, res) => {
  try {
    const penalties = await store.listPenalties(req.params.tenantCode);
    res.json({ penalties });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list penalties' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { tenant_code, description, amount, invoice_date, category } = req.body;
    if (!tenant_code || !description || amount == null) {
      return res.status(400).json({ error: 'tenant_code, description, and amount required' });
    }
    if (category && !['penalty', 'maintenance', 'other'].includes(category)) {
      return res.status(400).json({ error: 'category must be penalty, maintenance, or other' });
    }
    const penalty = await store.createPenalty({ tenant_code, description, amount, invoice_date, category });
    res.status(201).json({ penalty });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create penalty' });
  }
});

router.patch('/:id/pay', async (req, res) => {
  try {
    const penalty = await store.payPenalty(req.params.id);
    if (!penalty) return res.status(404).json({ error: 'Penalty not found or already paid' });
    res.json({ penalty });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark penalty as paid' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const ok = await store.deletePenalty(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Penalty not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete penalty' });
  }
});

module.exports = router;
