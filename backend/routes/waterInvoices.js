const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const whatsapp = require('../config/whatsapp');
const { generateAndStoreWaterInvoice } = require('../services/documentStore');

const router = express.Router();
router.use(requireAuthActive);

router.get('/', async (req, res) => {
  try {
    const invoices = await store.listWaterInvoices(req.query);
    res.json({ water_invoices: invoices });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list water invoices' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const invoice = await store.getWaterInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Water invoice not found' });
    res.json({ water_invoice: invoice });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get water invoice' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { tenant_code, billing_month, previous_reading, current_reading, due_date, notes } = req.body || {};
    if (!tenant_code) return res.status(400).json({ error: 'tenant_code required' });
    if (!billing_month) return res.status(400).json({ error: 'billing_month required' });

    const tenant = await store.getTenant(tenant_code);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const housePaybill = tenant.house_id || tenant.house_paybill_number;
    let ratePerUnit = req.body.rate_per_unit != null ? Number(req.body.rate_per_unit) : null;
    if (ratePerUnit == null || isNaN(ratePerUnit)) {
      ratePerUnit = await store.getWaterRate(housePaybill);
    }

    const invoice = await store.createWaterInvoice({
      tenant_code,
      tenant_name: tenant.name,
      property_name: tenant.property_name || '',
      house_paybill_number: housePaybill,
      unit_label: tenant.unit_label || '',
      billing_month,
      previous_reading: Number(previous_reading || 0),
      current_reading: Number(current_reading || 0),
      rate_per_unit: ratePerUnit,
      due_date: due_date || null,
      notes: notes || null,
    });

    await store.logAudit({
      actor: req.user?.username,
      action: 'water_invoice_created',
      entityType: 'water_invoice',
      entityId: invoice.wtr_number,
      details: { tenant_code, billing_month, total_amount: invoice.total_amount },
    });

    res.status(201).json({ water_invoice: invoice });
  } catch (err) {
    console.error('[Water Invoice] Create error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to create water invoice' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const invoice = await store.updateWaterInvoice(req.params.id, req.body || {});
    if (!invoice) return res.status(404).json({ error: 'Water invoice not found' });
    await store.logAudit({
      actor: req.user?.username,
      action: 'water_invoice_updated',
      entityType: 'water_invoice',
      entityId: invoice.wtr_number,
      details: req.body,
    });
    res.json({ water_invoice: invoice });
  } catch (err) {
    console.error('[Water Invoice] Update error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to update water invoice' });
  }
});

router.post('/:id/finalize', async (req, res) => {
  try {
    const invoice = await store.updateWaterInvoice(req.params.id, { status: 'Finalized' });
    if (!invoice) return res.status(404).json({ error: 'Water invoice not found' });
    await store.logAudit({
      actor: req.user?.username,
      action: 'water_invoice_finalized',
      entityType: 'water_invoice',
      entityId: invoice.wtr_number,
    });
    res.json({ water_invoice: invoice });
  } catch (err) {
    res.status(500).json({ error: 'Failed to finalize water invoice' });
  }
});

router.post('/:id/void', async (req, res) => {
  try {
    const { reason } = req.body || {};
    const invoice = await store.voidWaterInvoice(req.params.id, reason);
    if (!invoice) return res.status(404).json({ error: 'Water invoice not found or already paid' });
    await store.logAudit({
      actor: req.user?.username,
      action: 'water_invoice_voided',
      entityType: 'water_invoice',
      entityId: invoice.wtr_number,
      details: { reason },
    });
    res.json({ water_invoice: invoice });
  } catch (err) {
    res.status(500).json({ error: 'Failed to void water invoice' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const invoice = await store.getWaterInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Water invoice not found' });
    if (invoice.status !== 'Draft') {
      return res.status(400).json({ error: 'Only draft invoices can be deleted. Use void instead.' });
    }
    await store.deleteWaterInvoice(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete water invoice' });
  }
});

router.post('/:id/send', async (req, res) => {
  try {
    const mode = req.body.mode || 'download';
    const invoice = await store.getWaterInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Water invoice not found' });
    if (invoice.status !== 'Finalized') {
      return res.status(400).json({ error: 'Water invoice must be finalized before downloading or sending.' });
    }

    const tenant = await store.getTenant(invoice.tenant_code);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const doc = await generateAndStoreWaterInvoice(invoice.id, req.user?.username);
    if (!doc) return res.status(500).json({ error: 'Failed to generate water invoice PDF' });

    const mark = (action) => {
      if (doc.register_id) store.markInvoiceRegister({ id: doc.register_id, action }).catch(() => {});
    };

    const caption = `Hello ${tenant.name}, please find attached your Water Bill Invoice ${invoice.wtr_number} for ${invoice.billing_month}.`;

    if (mode === 'download') {
      mark('download');
      await store.updateWaterInvoice(req.params.id, { status: 'Downloaded' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
      res.setHeader('X-Wtr-Number', invoice.wtr_number);
      return res.sendFile(doc.file_path, err => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream water invoice PDF' });
      });
    }

    try {
      await whatsapp.sendMediaMessage(tenant.phone_number, doc.file_path, caption);
      await store.logMessage({
        tenantId: tenant.tenant_code,
        messageType: 'Water Invoice',
        messageBody: `Water bill invoice PDF sent successfully (${invoice.wtr_number})`,
        status: 'Sent',
      });
      mark('send');
      await store.updateWaterInvoice(req.params.id, { status: 'Sent' });
      res.json({ success: true, message: 'Water invoice sent via WhatsApp' });
    } catch (err) {
      await store.logMessage({
        tenantId: tenant.tenant_code,
        messageType: 'Water Invoice',
        messageBody: `Failed to send water invoice: ${err.message}`,
        status: 'Failed',
      });
      res.status(500).json({ error: 'Failed to send water invoice via WhatsApp' });
    }
  } catch (err) {
    console.error('[Water Invoice] Send error:', err.message);
    res.status(500).json({ error: 'Failed to send water invoice' });
  }
});

// Water rate management
router.get('/rates/:housePaybill', async (req, res) => {
  try {
    const rate = await store.getWaterRate(req.params.housePaybill);
    res.json({ rate_per_unit: rate });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get water rate' });
  }
});

router.put('/rates/:housePaybill', async (req, res) => {
  try {
    const { rate_per_unit, effective_month } = req.body || {};
    if (rate_per_unit == null) return res.status(400).json({ error: 'rate_per_unit required' });
    const result = await store.updateWaterRate(
      req.params.housePaybill,
      Number(rate_per_unit),
      effective_month || new Date().toISOString().slice(0, 7),
      req.user?.username
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update water rate' });
  }
});

router.get('/rates/:housePaybill/history', async (req, res) => {
  try {
    const history = await store.getWaterRateHistory(req.params.housePaybill);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get rate history' });
  }
});

router.get('/latest-reading/:tenantCode', async (req, res) => {
  try {
    const reading = await store.getLatestWaterReading(req.params.tenantCode);
    res.json({ current_reading: reading });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get latest reading' });
  }
});

module.exports = router;
