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
    const entry = await store.getTenancyArchive(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Archive entry not found' });
    res.json({ archive: entry });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get archive entry: ' + err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const ok = await store.deleteArchive(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Archive entry not found' });
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
