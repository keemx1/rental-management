const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const whatsapp = require('../config/whatsapp');
const { generateAndStoreMaintenanceInvoice, generateAndStoreReimbursementInvoice, generateAndStoreExpenseInvoice } = require('../services/documentStore');

const router = express.Router();
router.use(requireAuthActive);

const VALID_STATUSES = ['Draft', 'Pending', 'Approved', 'Paid', 'Partially Paid', 'Fully Paid', 'Cancelled', 'Assigned', 'In Progress', 'Completed', 'Pending Reimbursement', 'Partially Reimbursed', 'Fully Reimbursed'];

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

// GET /eligible — list management-funded WO expenses not yet included in a Management Expenses Invoice
router.get('/eligible', async (req, res) => {
  try {
    const { house } = req.query;
    const expenses = await store.getEligibleManagementExpenses(house || null);
    res.json({ expenses, count: expenses.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load eligible expenses: ' + err.message });
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
    // Unlink any management charges before deleting
    await store.unlinkManagementExpenseCharges(req.params.id);
    const ok = await store.deleteMaintenanceInvoice(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Maintenance invoice not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete maintenance invoice: ' + err.message });
  }
});

// POST /:id/link-wo — link work order management charges to this invoice
router.post('/:id/link-wo', async (req, res) => {
  try {
    const { wo_id, issue_nos } = req.body;
    if (!wo_id) return res.status(400).json({ error: 'wo_id is required' });
    const charges = await store.createManagementExpenseFromWO(wo_id, issue_nos || null, req.params.id);
    res.json({ linked: charges.length, charges });
  } catch (err) {
    res.status(500).json({ error: 'Failed to link WO expenses: ' + err.message });
  }
});

// POST /:id/payments — record a payment against a management expense
router.post('/:id/payments', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Valid payment amount is required' });
    const invoice = await store.getMaintenanceInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Management expense not found' });
    const result = await store.recordExpensePayment(req.params.id, {
      ...req.body,
      recorded_by: req.user?.username || null,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to record payment: ' + err.message });
  }
});

// GET /:id/payments — list payments for a management expense
router.get('/:id/payments', async (req, res) => {
  try {
    const payments = await store.getExpensePayments(req.params.id);
    res.json({ payments });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load payments: ' + err.message });
  }
});

// DELETE /:id/payments/:paymentId — delete a payment
router.delete('/:id/payments/:paymentId', async (req, res) => {
  try {
    const ok = await store.deleteExpensePayment(req.params.paymentId);
    if (!ok) return res.status(404).json({ error: 'Payment not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete payment: ' + err.message });
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

// GET /:id/reimbursement-invoice — generate staff reimbursement invoice PDF
router.get('/:id/reimbursement-invoice', async (req, res) => {
  try {
    const mode = req.query.mode || 'download';
    const result = await generateAndStoreReimbursementInvoice(req.params.id, req.user?.username || null);
    if (!result) return res.status(404).json({ error: 'Invoice not found or generation failed' });

    if (mode === 'download') {
      res.download(result.pdfPath, result.filename);
    } else {
      res.json({ filename: result.filename, invoice_number: result.invoice_number });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate reimbursement invoice: ' + err.message });
  }
});

// GET /:id/expense-invoice — generate standalone expense invoice PDF (any category)
router.get('/:id/expense-invoice', async (req, res) => {
  try {
    const mode = req.query.mode || 'download';
    const result = await generateAndStoreExpenseInvoice(req.params.id, req.user?.username || null);
    if (!result) return res.status(404).json({ error: 'Invoice not found or generation failed' });

    if (mode === 'download') {
      res.download(result.pdfPath, result.filename);
    } else {
      res.json({ filename: result.filename, invoice_number: result.invoice_number });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate expense invoice: ' + err.message });
  }
});

module.exports = router;
