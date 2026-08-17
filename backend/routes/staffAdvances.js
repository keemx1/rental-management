const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');

const router = express.Router();
router.use(requireAuthActive);

// GET / - List staff advances (optional ?employee= filter)
router.get('/', async (req, res) => {
  try {
    const records = await store.listStaffAdvances(req.query.employee);
    res.json(records);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /employees - List distinct employee names
router.get('/employees', async (req, res) => {
  try {
    const employees = await store.listStaffAdvanceEmployees();
    res.json(employees);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id - Get single staff advance
router.get('/:id', async (req, res) => {
  try {
    const record = await store.getStaffAdvance(req.params.id);
    if (!record) return res.status(404).json({ error: 'Staff advance not found' });
    res.json(record);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / - Create staff advance
router.post('/', async (req, res) => {
  try {
    if (!req.body.employee_name) return res.status(400).json({ error: 'Employee name is required' });
    if (!req.body.amount || Number(req.body.amount) <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
    const record = await store.createStaffAdvance(req.body);
    res.status(201).json(record);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id - Update staff advance
router.put('/:id', async (req, res) => {
  try {
    const record = await store.updateStaffAdvance(req.params.id, req.body);
    if (!record) return res.status(404).json({ error: 'Staff advance not found' });
    res.json(record);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id - Delete staff advance
router.delete('/:id', async (req, res) => {
  try {
    const ok = await store.deleteStaffAdvance(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Staff advance not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/payments - List payments for a staff advance
router.get('/:id/payments', async (req, res) => {
  try {
    const payments = await store.getStaffAdvancePayments(req.params.id);
    res.json(payments);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/payments - Record a recovery payment
router.post('/:id/payments', async (req, res) => {
  try {
    if (!req.body.amount || Number(req.body.amount) <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
    const result = await store.recordStaffAdvancePayment(req.params.id, req.body);
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /payments/:paymentId - Delete a recovery payment
router.delete('/payments/:paymentId', async (req, res) => {
  try {
    const ok = await store.deleteStaffAdvancePayment(req.params.paymentId);
    if (!ok) return res.status(404).json({ error: 'Payment not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/invoice - Generate and download staff advance invoice PDF
router.get('/:id/invoice', async (req, res) => {
  try {
    if (req.query.mode === 'info') {
      const record = await store.getStaffAdvance(req.params.id);
      if (!record) return res.status(404).json({ error: 'Staff advance not found' });
      return res.json({ exists: true, title: `Staff Advance Invoice — ${record.employee_name}` });
    }
    const { generateAndStoreStaffAdvanceInvoice } = require('../services/documentStore');
    const result = await generateAndStoreStaffAdvanceInvoice(req.params.id);
    if (!result) return res.status(500).json({ error: 'PDF generation failed' });
    const fs = require('fs');
    if (!fs.existsSync(result.pdfPath)) return res.status(404).json({ error: 'PDF file not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    fs.createReadStream(result.pdfPath).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
