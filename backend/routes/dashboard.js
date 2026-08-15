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

module.exports = router;
