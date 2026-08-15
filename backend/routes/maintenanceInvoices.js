const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const whatsapp = require('../config/whatsapp');
const { generateAndStoreMaintenanceInvoice } = require('../services/documentStore');

const router = express.Router();
router.use(requireAuthActive);

const VALID_STATUSES = ['Pending', 'Approved', 'Assigned', 'In Progress', 'Completed'];

router.get('/', async (req, res) => {
  try {
    const { status, limit, offset } = req.query;
    const invoices = await store.listMaintenanceInvoices({ status, limit, offset });
    const count = invoices.length;
    res.json({ invoices, count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list maintenance invoices: ' + err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const invoice = await store.getMaintenanceInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Maintenance invoice not found' });
    res.json({ invoice });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load maintenance invoice: ' + err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { items, status } = req.body;
    if (!items || !items.length) {
      return res.status(400).json({ error: 'At least one work item is required' });
    }
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    const invoice = await store.createMaintenanceInvoice(req.body);
    res.status(201).json({ invoice });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create maintenance invoice: ' + err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { status } = req.body;
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    const invoice = await store.updateMaintenanceInvoice(req.params.id, req.body);
    if (!invoice) return res.status(404).json({ error: 'Maintenance invoice not found' });
    res.json({ invoice });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update maintenance invoice: ' + err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const ok = await store.deleteMaintenanceInvoice(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Maintenance invoice not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete maintenance invoice: ' + err.message });
  }
});

router.post('/:id/generate', async (req, res) => {
  try {
    const mode = req.body.mode || 'download';
    const doc = await generateAndStoreMaintenanceInvoice(req.params.id, req.user?.username);
    if (!doc) return res.status(500).json({ error: 'Failed to generate maintenance invoice PDF' });

    const mark = (action) => {
      if (doc.register_id) store.markInvoiceRegister({ id: doc.register_id, action }).catch(() => {});
    };

    if (mode === 'download') {
      mark('download');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
      res.setHeader('X-Invoice-Number', doc.doc_number);
      return res.sendFile(doc.file_path, err => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream maintenance invoice PDF' });
      });
    }

    const phone = req.body.phone_number;
    if (!phone) return res.status(400).json({ error: 'phone_number is required for WhatsApp delivery' });

    try {
      await whatsapp.sendMediaMessage(phone, doc.file_path, `Hello, please find attached maintenance invoice ${doc.doc_number} for ${doc.property_name || 'the property'}.`);
      mark('send');
    } catch (err) {
      return res.status(500).json({ error: 'WhatsApp delivery failed: ' + err.message });
    }

    if (mode === 'both') {
      mark('download');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
      res.setHeader('X-Invoice-Number', doc.doc_number);
      return res.sendFile(doc.file_path, err => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream maintenance invoice PDF' });
      });
    }

    res.json({ success: true, message: 'Maintenance invoice sent successfully', invoice_no: doc.doc_number });
  } catch (err) {
    res.status(500).json({ error: 'Maintenance invoice operation failed: ' + err.message });
  }
});

module.exports = router;
