const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');

const router = express.Router();
router.use(requireAuthActive);

router.get('/mode', async (req, res) => {
  try {
    const mode = await store.getReceiptMode();
    res.json({ mode });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get receipt mode: ' + err.message });
  }
});

router.patch('/mode', async (req, res) => {
  try {
    const { mode } = req.body;
    if (!['test', 'production'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be test or production' });
    }
    await store.setReceiptMode(mode);
    res.json({ success: true, mode });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set receipt mode: ' + err.message });
  }
});

router.post('/reset-test', async (req, res) => {
  try {
    await store.resetTestReceipts();
    res.json({ success: true, message: 'Test receipt counter reset to 1' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset test receipts: ' + err.message });
  }
});

module.exports = router;
