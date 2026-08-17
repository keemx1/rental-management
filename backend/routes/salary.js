const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const { generateAndStoreSalaryInvoice } = require('../services/documentStore');

const router = express.Router();
router.use(requireAuthActive);

// GET / — list salary records for a month (default: current month)
router.get('/', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const records = await store.listSalaryRecords(month);
    res.json({ records, month });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list salary records: ' + err.message });
  }
});

// GET /employees — list all unique employee names
router.get('/employees', async (req, res) => {
  try {
    const employees = await store.listSalaryEmployees();
    res.json({ employees });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list employees: ' + err.message });
  }
});

// GET /history/:employee — salary history for an employee
router.get('/history/:employee', async (req, res) => {
  try {
    const history = await store.getSalaryHistory(decodeURIComponent(req.params.employee));
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load salary history: ' + err.message });
  }
});

// GET /:id — get a single salary record
router.get('/:id', async (req, res) => {
  try {
    const record = await store.getSalaryRecord(req.params.id);
    if (!record) return res.status(404).json({ error: 'Salary record not found' });
    res.json({ record });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load salary record: ' + err.message });
  }
});

// POST / — create a salary record
router.post('/', async (req, res) => {
  try {
    const { employee_name, salary_month, expected_salary } = req.body;
    if (!employee_name || !salary_month) {
      return res.status(400).json({ error: 'employee_name and salary_month are required' });
    }
    if (!expected_salary || Number(expected_salary) <= 0) {
      return res.status(400).json({ error: 'expected_salary must be > 0' });
    }
    const record = await store.createSalaryRecord(req.body);
    res.status(201).json({ record });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create salary record: ' + err.message });
  }
});

// PUT /:id — update a salary record
router.put('/:id', async (req, res) => {
  try {
    const record = await store.updateSalaryRecord(req.params.id, req.body);
    if (!record) return res.status(404).json({ error: 'Salary record not found' });
    res.json({ record });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update salary record: ' + err.message });
  }
});

// DELETE /:id — delete a salary record
router.delete('/:id', async (req, res) => {
  try {
    const ok = await store.deleteSalaryRecord(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Salary record not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete salary record: ' + err.message });
  }
});

// POST /:id/payments — record a payment against a salary record
router.post('/:id/payments', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Valid payment amount is required' });
    const record = await store.getSalaryRecord(req.params.id);
    if (!record) return res.status(404).json({ error: 'Salary record not found' });
    const result = await store.recordSalaryPayment(req.params.id, {
      ...req.body,
      recorded_by: req.user?.username || null,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to record payment: ' + err.message });
  }
});

// GET /:id/payments — list payments for a salary record
router.get('/:id/payments', async (req, res) => {
  try {
    const payments = await store.getSalaryPayments(req.params.id);
    res.json({ payments });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load payments: ' + err.message });
  }
});

// DELETE /:id/payments/:paymentId — delete a salary payment
router.delete('/:id/payments/:paymentId', async (req, res) => {
  try {
    const ok = await store.deleteSalaryPayment(req.params.paymentId);
    if (!ok) return res.status(404).json({ error: 'Payment not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete payment: ' + err.message });
  }
});

// POST /rollover — roll over salaries to next month
router.post('/rollover', async (req, res) => {
  try {
    const month = req.body.month || new Date().toISOString().slice(0, 7);
    // Calculate next month
    const d = new Date(month + '-15T12:00:00');
    d.setMonth(d.getMonth() + 1);
    const nextMonth = d.toISOString().slice(0, 7);
    const result = await store.rollOverSalaries(nextMonth);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to roll over salaries: ' + err.message });
  }
});

// GET /:id/invoice — generate salary invoice PDF
router.get('/:id/invoice', async (req, res) => {
  try {
    const mode = req.query.mode || 'download';
    const result = await generateAndStoreSalaryInvoice(req.params.id, req.user?.username || null);
    if (!result) return res.status(404).json({ error: 'Salary record not found or generation failed' });

    if (mode === 'download') {
      res.download(result.pdfPath, result.filename);
    } else {
      res.json({ filename: result.filename, invoice_number: result.invoice_number });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate salary invoice: ' + err.message });
  }
});

module.exports = router;
