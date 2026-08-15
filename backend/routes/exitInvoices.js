const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const whatsapp = require('../config/whatsapp');
const { generateAndStoreExitInvoice } = require('../services/documentStore');

const router = express.Router();
router.use(requireAuthActive);

router.get('/', async (req, res) => {
  try {
    const invoices = await store.listExitInvoices(req.query.tenant_code || null);
    res.json({ exit_invoices: invoices });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list exit invoices' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const invoice = await store.getExitInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Exit invoice not found' });
    res.json({ exit_invoice: invoice });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get exit invoice' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { tenant_code, lines, move_out_date, reason, outstanding_balance } = req.body || {};
    if (!tenant_code) {
      return res.status(400).json({ error: 'tenant_code required' });
    }
    const invoice = await store.createExitInvoice(tenant_code, {
      lines: Array.isArray(lines) ? lines : [],
      move_out_date,
      reason,
      outstanding_balance,
    });
    if (!invoice) return res.status(404).json({ error: 'Tenant not found' });
    await store.logAudit({
      actor: req.user?.username,
      action: 'exit_invoice_created',
      entityType: 'tenant',
      entityId: tenant_code,
      details: { exit_number: invoice.exit_number, lines: invoice.lines.length },
    });
    res.status(201).json({ exit_invoice: invoice });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create exit invoice: ' + err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { lines, move_out_date, reason, outstanding_balance } = req.body || {};
    const invoice = await store.updateExitInvoice(req.params.id, {
      lines: lines !== undefined ? lines : undefined,
      move_out_date,
      reason,
      outstanding_balance,
    });
    if (!invoice) return res.status(404).json({ error: 'Exit invoice not found' });
    if (invoice.error) return res.status(400).json({ error: invoice.error });
    res.json({ exit_invoice: invoice });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update exit invoice: ' + err.message });
  }
});

router.post('/:id/finalize', async (req, res) => {
  try {
    const { move_out_date, reason } = req.body || {};
    const invoice = await store.finalizeExitInvoice(req.params.id, { move_out_date, reason }, req.user?.username);
    if (!invoice) return res.status(404).json({ error: 'Exit invoice not found' });
    if (invoice.error) return res.status(400).json({ error: invoice.error });
    await store.logAudit({
      actor: req.user?.username,
      action: 'exit_invoice_finalized',
      entityType: 'tenant',
      entityId: invoice.tenant_code,
      details: { exit_number: invoice.exit_number },
    });
    res.json({ exit_invoice: invoice });
  } catch (err) {
    res.status(500).json({ error: 'Failed to finalize exit invoice: ' + err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const ok = await store.deleteExitInvoice(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Exit invoice not found or already finalized' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete exit invoice' });
  }
});

router.post('/:id/send', async (req, res) => {
  try {
    const mode = req.body.mode || 'download';
    const invoice = await store.getExitInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Exit invoice not found' });
    if (invoice.status !== 'Finalized') {
      return res.status(400).json({ error: 'Exit invoice must be finalized before downloading or sending.' });
    }

    const tenant = await store.getTenant(invoice.tenant_code);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const doc = await generateAndStoreExitInvoice(invoice.id, req.user?.username);
    if (!doc) return res.status(500).json({ error: 'Failed to generate exit invoice PDF' });

    const mark = (action) => {
      if (doc.register_id) store.markInvoiceRegister({ id: doc.register_id, action }).catch(() => {});
    };

    const caption = `Hello ${tenant.name}, please find attached your exit invoice ${invoice.exit_number} for unit ${invoice.unit_label || invoice.tenant_code}.`;

    if (mode === 'download') {
      mark('download');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
      res.setHeader('X-Exit-Number', invoice.exit_number);
      return res.sendFile(doc.file_path, err => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream exit invoice PDF' });
      });
    }

    try {
      await whatsapp.sendMediaMessage(tenant.phone_number, doc.file_path, caption);
      await store.logMessage({
        tenantId: tenant.tenant_code,
        messageType: 'Exit Invoice',
        messageBody: `Exit invoice PDF sent successfully (${invoice.exit_number})`,
        status: 'Sent',
      });
      mark('send');
    } catch (err) {
      await store.logMessage({
        tenantId: tenant.tenant_code,
        messageType: 'Exit Invoice',
        messageBody: 'Failed to send Exit invoice PDF',
        status: 'Failed',
      });
      return res.status(500).json({ error: 'WhatsApp delivery failed: ' + err.message });
    }

    if (mode === 'both') {
      mark('download');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
      res.setHeader('X-Exit-Number', invoice.exit_number);
      return res.sendFile(doc.file_path, err => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream exit invoice PDF' });
      });
    }

    res.json({ success: true, message: 'Exit invoice sent successfully', exit_number: invoice.exit_number });
  } catch (err) {
    res.status(500).json({ error: 'Exit invoice operation failed: ' + err.message });
  }
});

module.exports = router;
