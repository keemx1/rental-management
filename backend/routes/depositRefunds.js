const express = require('express');
const { requireAuthActive, requireAdmin } = require('../middleware/auth');
const store = require('../storage/store');
const reinstatement = require('../services/depositReinstatement');

const router = express.Router();
router.use(requireAuthActive);

router.get('/', async (req, res) => {
  try {
    const { status, tenant, house, search, sort, limit, offset } = req.query;
    const refunds = await store.listDepositRefunds({
      status, tenant, house, search, sort,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
    });
    res.json({ refunds });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list deposit refunds' });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const summary = await store.getDepositRefundSummary();
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

// ── Cancel Refund / Reinstate Deposit (enhancement §4-§14) ─────────────────
// Declared BEFORE '/:id' so 'vacant-units' is not captured as an id.

router.get('/vacant-units', async (req, res) => {
  try {
    const hp = req.query.house_paybill;
    if (!hp) return res.status(400).json({ error: 'house_paybill is required' });
    res.json(await reinstatement.vacantUnits(hp));
  } catch (err) {
    res.status(500).json({ error: 'Failed to list vacant units: ' + err.message });
  }
});

router.get('/houses-options', async (req, res) => {
  try {
    res.json({ houses: await reinstatement.listHousesForReassignment() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list properties: ' + err.message });
  }
});

router.get('/reinstatements/for-payments', async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map((n) => Number(n)).filter(Boolean);
    res.json({ reinstatements: await reinstatement.reinstatementsForPayments(ids) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load reinstatements: ' + err.message });
  }
});

router.get('/:id/reinstatement-eligibility', async (req, res) => {
  try {
    const result = await reinstatement.eligibility(req.params.id);
    if (result.error) return res.status(result.code === 'NOT_FOUND' ? 404 : 400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Eligibility check failed: ' + err.message });
  }
});

router.post('/:id/cancel-reinstate', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await reinstatement.cancelAndReinstate(req.params.id, {
      reason: body.reason,
      mode: body.mode,
      new_house_paybill: body.new_house_paybill,
      new_unit: body.new_unit,
      actor: req.user?.username,
    });
    if (result.error) {
      const status = ['ALREADY_PROCESSED', 'UNIT_OCCUPIED'].includes(result.code) ? 409
        : result.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: result.error, code: result.code });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Cancel/reinstate failed: ' + err.message });
  }
});

router.post('/reinstatements/:reinstatementId/assign-unit', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await reinstatement.assignHeldUnit(req.params.reinstatementId, {
      new_house_paybill: body.new_house_paybill,
      new_unit: body.new_unit,
      actor: req.user?.username,
    });
    if (result.error) {
      const status = ['UNIT_NOT_VACANT', 'NOT_ELIGIBLE'].includes(result.code) ? 409
        : result.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: result.error, code: result.code });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Unit assignment failed: ' + err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const refund = await store.getDepositRefund(req.params.id);
    if (!refund) return res.status(404).json({ error: 'Deposit refund not found' });
    res.json({ refund });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get deposit refund' });
  }
});

router.get('/:id/exit-invoice', async (req, res) => {
  try {
    const refund = await store.getDepositRefund(req.params.id);
    if (!refund) return res.status(404).json({ error: 'Deposit refund not found' });
    const invoice = await store.getExitInvoice(refund.exit_invoice_id);
    if (!invoice) return res.status(404).json({ error: 'Exit invoice not found' });
    res.json({ invoice });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get exit invoice' });
  }
});

router.post('/:id/record-refund', async (req, res) => {
  try {
    const { amount, payment_method, transaction_reference, refund_date, refund_time, remarks } = req.body || {};
    const result = await store.recordDepositRefund(req.params.id, {
      amount: Number(amount || 0),
      paymentMethod: payment_method,
      transactionReference: transaction_reference,
      refundDate: refund_date,
      refundTime: refund_time,
      remarks,
      actor: req.user?.username,
    });
    if (result.error) return res.status(400).json({ error: result.error });
    await store.logAudit({
      actor: req.user?.username,
      action: 'deposit_refund_recorded',
      entityType: 'deposit_refund',
      entityId: String(req.params.id),
      details: { amount, payment_method, transaction_reference },
    });
    res.json({ refund: result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record refund: ' + err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const refund = await store.updateDepositRefund(req.params.id, req.body);
    if (!refund) return res.status(404).json({ error: 'Deposit refund not found' });
    await store.logAudit({
      actor: req.user?.username,
      action: 'deposit_refund_updated',
      entityType: 'deposit_refund',
      entityId: String(req.params.id),
      details: req.body,
    });
    res.json({ refund });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update deposit refund' });
  }
});

module.exports = router;
