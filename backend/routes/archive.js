const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');

const router = express.Router();
router.use(requireAuthActive);

router.get('/', async (req, res) => {
  try {
    const entries = await store.searchArchive({
      q: req.query.q,
      property_name: req.query.property_name,
      house_id: req.query.house_id,
      unit_code: req.query.unit_code,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
    });
    res.json({ archives: entries });
  } catch (err) {
    res.status(500).json({ error: 'Failed to search archive: ' + err.message });
  }
});

router.get('/occupancy/house/:houseId', async (req, res) => {
  try {
    const history = await store.getOccupancyHistory(req.params.houseId);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load occupancy history: ' + err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const archive = await store.getTenancyArchive(req.params.id);
    if (!archive) return res.status(404).json({ error: 'Archive entry not found' });
    res.json({ archive });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load archive entry: ' + err.message });
  }
});

// Complete payment history for ONE archived tenancy: chronological payments
// with per-charge allocations and balance-before/after reconstructed from
// this tenancy's own records only (never the tenant's current balance).
router.get('/:id/history', async (req, res) => {
  try {
    const history = await store.getTenancyPaymentHistory(req.params.id);
    if (!history) return res.status(404).json({ error: 'Archive entry not found' });
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: 'Failed to build tenancy payment history: ' + err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await store.deleteArchive(req.params.id);
    if (result && result.error) {
      return res.status(409).json({ error: result.error, code: result.code });
    }
    if (!result) return res.status(404).json({ error: 'Archive entry not found' });
    await store.logAudit({
      actor: req.user?.username,
      action: 'archive_deleted',
      entityType: 'archive',
      entityId: String(req.params.id),
      details: {},
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete archive entry: ' + err.message });
  }
});

module.exports = router;
