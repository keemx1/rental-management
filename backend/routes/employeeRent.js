const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');

const router = express.Router();
router.use(requireAuthActive);

// GET / - List employee rent (optional ?employee= and ?period= filters)
router.get('/', async (req, res) => {
  try {
    const records = await store.listEmployeeRent(req.query.employee, req.query.period);
    res.json(records);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /employees - List distinct employee names
router.get('/employees', async (req, res) => {
  try {
    const employees = await store.listEmployeeRentEmployees();
    res.json(employees);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id - Get single employee rent
router.get('/:id', async (req, res) => {
  try {
    const record = await store.getEmployeeRent(req.params.id);
    if (!record) return res.status(404).json({ error: 'Employee rent not found' });
    res.json(record);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / - Create employee rent
router.post('/', async (req, res) => {
  try {
    const { employee_name, property_name, unit_code, monthly_rent, rent_period } = req.body;
    if (!employee_name || !property_name || !unit_code || !rent_period) {
      return res.status(400).json({ error: 'Employee name, property, unit, and rent period are required' });
    }
    if (!monthly_rent || Number(monthly_rent) <= 0) return res.status(400).json({ error: 'Monthly rent must be > 0' });
    const record = await store.createEmployeeRent(req.body);
    res.status(201).json(record);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id - Update employee rent
router.put('/:id', async (req, res) => {
  try {
    const record = await store.updateEmployeeRent(req.params.id, req.body);
    if (!record) return res.status(404).json({ error: 'Employee rent not found' });
    res.json(record);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id - Delete employee rent
router.delete('/:id', async (req, res) => {
  try {
    const ok = await store.deleteEmployeeRent(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Employee rent not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/payments - List rent payments
router.get('/:id/payments', async (req, res) => {
  try {
    const payments = await store.getEmployeeRentPayments(req.params.id);
    res.json(payments);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/payments - Record a rent payment
router.post('/:id/payments', async (req, res) => {
  try {
    if (!req.body.amount || Number(req.body.amount) <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
    const result = await store.recordEmployeeRentPayment(req.params.id, req.body);
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /payments/:paymentId - Delete a rent payment
router.delete('/payments/:paymentId', async (req, res) => {
  try {
    const ok = await store.deleteEmployeeRentPayment(req.params.paymentId);
    if (!ok) return res.status(404).json({ error: 'Payment not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/deduct-from-salary - Deduct rent from a salary record
router.post('/:id/deduct-from-salary', async (req, res) => {
  try {
    const { salary_record_id, amount } = req.body;
    if (!salary_record_id) return res.status(400).json({ error: 'salary_record_id is required' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
    const result = await store.deductRentFromSalary(req.params.id, salary_record_id, amount, req.body.recorded_by);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/invoice - Generate and download employee rent invoice PDF
router.get('/:id/invoice', async (req, res) => {
  try {
    if (req.query.mode === 'info') {
      const record = await store.getEmployeeRent(req.params.id);
      if (!record) return res.status(404).json({ error: 'Employee rent not found' });
      return res.json({ exists: true, title: `Employee Rent — ${record.employee_name} (${record.rent_period})` });
    }
    const { generateAndStoreEmployeeRentInvoice } = require('../services/documentStore');
    const result = await generateAndStoreEmployeeRentInvoice(req.params.id);
    if (!result) return res.status(500).json({ error: 'PDF generation failed' });
    const fs = require('fs');
    if (!fs.existsSync(result.pdfPath)) return res.status(404).json({ error: 'PDF file not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    fs.createReadStream(result.pdfPath).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
