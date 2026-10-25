const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const whatsapp = require('../config/whatsapp');
const store = require('../storage/store');

const router = express.Router();
router.use(requireAuthActive);

router.get('/metrics', async (req, res) => {
  try {
    const metrics = await store.getDashboardMetrics();
    res.json({
      ...metrics,
      whatsapp: whatsapp.getGatewayState(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load metrics' });
  }
});

// The list behind a dashboard card (vacant / overdue / due7 / pending /
// arrears / revenue / progress). Built from the same predicates as /metrics
// so the card count and this list can never disagree.
const DRILLDOWN_KINDS = new Set(['vacant', 'overdue', 'due7', 'pending', 'arrears', 'revenue', 'progress']);

router.get('/drilldown/:kind', async (req, res) => {
  const kind = String(req.params.kind || '');
  if (!DRILLDOWN_KINDS.has(kind)) {
    return res.status(400).json({ error: 'Unknown drilldown kind' });
  }
  try {
    const payload = await store.getDashboardDrilldown(kind);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load drilldown' });
  }
});

module.exports = router;
