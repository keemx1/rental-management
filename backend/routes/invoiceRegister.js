const express = require('express');
const fs = require('fs');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const whatsapp = require('../config/whatsapp');

const router = express.Router();
router.use(requireAuthActive);

router.get('/', async (req, res) => {
  try {
    const {
      q, invoice_type, status, tenant_code, house_paybill_number, unit_label,
      month, year, from, to, limit, offset,
    } = req.query;
    const result = await store.listInvoiceRegister({
      q: q || undefined,
      invoice_type: invoice_type || undefined,
      status: status || undefined,
      tenant_code: tenant_code || undefined,
      house_paybill_number: house_paybill_number || undefined,
      unit_label: unit_label || undefined,
      month: month || undefined,
      year: year || undefined,
      from: from || undefined,
      to: to || undefined,
      limit: limit || undefined,
      offset: offset || undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load invoice register: ' + err.message });
  }
});

router.get('/monthly', async (req, res) => {
  try {
    const { from, to, limit } = req.query;
    const result = await store.listInvoiceRegisterMonthly({ from: from || undefined, to: to || undefined, limit: limit || undefined });
    res.json({ months: result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load invoice register monthly summary: ' + err.message });
  }
});

router.get('/exit-invoices', async (req, res) => {
  try {
    const result = await store.listInvoiceRegister({ invoice_type: 'exit', q: req.query.q || undefined, limit: req.query.limit || undefined, offset: req.query.offset || undefined });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load exit invoice register: ' + err.message });
  }
});

router.get('/by-number/:invoiceNumber', async (req, res) => {
  try {
    const register = await store.getInvoiceRegisterByNumber(req.params.invoiceNumber);
    if (!register) return res.status(404).json({ error: 'Invoice not found in register' });
    res.json({ register });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load invoice register entry: ' + err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const register = await store.getInvoiceRegister(req.params.id);
    if (!register) return res.status(404).json({ error: 'Invoice register entry not found' });
    res.json({ register });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load invoice register entry: ' + err.message });
  }
});

router.get('/:id/document', async (req, res) => {
  try {
    const register = await store.getInvoiceRegister(req.params.id);
    if (!register) return res.status(404).json({ error: 'Invoice register entry not found' });
    if (!register.document_id) {
      return res.status(404).json({ error: 'No stored document is attached to this invoice' });
    }
    const doc = await store.getDocument(register.document_id);
    if (!doc) return res.status(404).json({ error: 'Original invoice document not found' });
    if (!fs.existsSync(doc.file_path)) {
      return res.status(404).json({ error: 'Original invoice PDF is missing on disk' });
    }
    const inline = req.query.inline === '1';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${doc.filename}"`);
    fs.createReadStream(doc.file_path).on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Failed to stream invoice PDF' });
    }).pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Failed to stream invoice document: ' + err.message });
  }
});

router.post('/:id/send', async (req, res) => {
  try {
    const register = await store.getInvoiceRegister(req.params.id);
    if (!register) return res.status(404).json({ error: 'Invoice register entry not found' });
    if (!register.document_id) {
      return res.status(400).json({ error: 'No stored document is attached to this invoice' });
    }
    const doc = await store.getDocument(register.document_id);
    if (!doc) return res.status(404).json({ error: 'Original invoice document not found' });
    if (!fs.existsSync(doc.file_path)) {
      return res.status(404).json({ error: 'Original invoice PDF is missing on disk' });
    }

    const phone = req.body?.phone_number || doc.tenant_phone || register.house_paybill_number;
    if (!phone) {
      return res.status(400).json({ error: 'No recipient phone number available for this invoice' });
    }

    const tenantName = register.tenant_name || doc.tenant_name || doc.property_name || doc.unit_label || '';
    const unitText = doc.unit_label ? ` for unit ${doc.unit_label}` : '';
    const caption = `Hello ${tenantName}, please find attached your invoice ${register.invoice_number}${unitText}.`;

    const result = await whatsapp.sendMediaMessage(phone, doc.file_path, caption);
    await store.markInvoiceRegister({ id: register.id, action: 'send' });
    res.json({ success: true, whatsapp: result, phone });
  } catch (err) {
    res.status(500).json({ error: 'WhatsApp resend failed: ' + err.message });
  }
});

module.exports = router;
