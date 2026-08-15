const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/authorize');
const whatsapp = require('../config/whatsapp');

const router = express.Router();
router.use(requireAuthActive);

router.get('/whatsapp-status', (req, res) => {
  res.json(whatsapp.getGatewayState());
});

router.post('/whatsapp-reset', requireAdmin, async (req, res) => {
  try {
    await whatsapp.resetSession();
    const state = whatsapp.getGatewayState();
    res.json({ success: true, whatsapp: state, message: state.message });
  } catch (err) {
    res.status(500).json({
      error: err.message || 'Failed to reset WhatsApp',
      whatsapp: whatsapp.getGatewayState(),
    });
  }
});

module.exports = router;
