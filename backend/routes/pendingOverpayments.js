const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const { buildAdvanceRentConfirmation, buildCreditBalanceConfirmation } = require('../services/messages');

const router = express.Router();
router.use(requireAuthActive);

router.get('/', async (req, res) => {
  try {
    const status = req.query.status || null;
    const records = await store.listPendingOverpayments(status ? { status } : {});
    res.json({ records });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list pending overpayments' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const record = await store.getPendingOverpayment(req.params.id);
    if (!record) return res.status(404).json({ error: 'Pending overpayment not found' });
    res.json({ record });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load pending overpayment' });
  }
});

router.post('/:id/resolve', async (req, res) => {
  try {
    const { choice, months } = req.body;
    if (!['advance_rent', 'credit_balance'].includes(choice)) {
      return res.status(400).json({ error: 'choice (advance_rent|credit_balance) required' });
    }

    const result = await store.resolvePendingOverpayment(req.params.id, choice, months || null, req.user?.username);
    if (!result) return res.status(404).json({ error: 'Pending overpayment not found' });
    if (result.alreadyResolved) {
      return res.status(409).json({ error: 'Pending overpayment already resolved', record: result.record });
    }

    const payment = await store.findPaymentById(result.record.payment_id);
    let messageBody = null;
    if (choice === 'advance_rent') {
      messageBody = buildAdvanceRentConfirmation(result.tenant, payment || {}, result.result);
    } else {
      messageBody = buildCreditBalanceConfirmation(result.tenant, payment || {}, result.record.overpayment_amount, result.result);
    }

    res.json({
      success: true,
      record: result.record,
      result: result.result,
      tenant: result.tenant,
      payment: payment || null,
      messageBody,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve pending overpayment: ' + err.message });
  }
});

module.exports = router;
