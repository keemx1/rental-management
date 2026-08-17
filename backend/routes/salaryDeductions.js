const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');

const router = express.Router();
router.use(requireAuthActive);

// GET / - List deductions (optional ?employee= and ?month= filters)
router.get('/', async (req, res) => {
  try {
    const records = await store.listSalaryDeductions(req.query.employee, req.query.month);
    res.json(records);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /for-month - Get deductions for a specific employee and month
router.get('/for-month', async (req, res) => {
  try {
    const { employee, month } = req.query;
    if (!employee || !month) return res.status(400).json({ error: 'employee and month are required' });
    const records = await store.getSalaryDeductionsForMonth(employee, month);
    res.json(records);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id - Get single deduction
router.get('/:id', async (req, res) => {
  try {
    const record = await store.getSalaryDeduction(req.params.id);
    if (!record) return res.status(404).json({ error: 'Salary deduction not found' });
    res.json(record);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / - Create deduction
router.post('/', async (req, res) => {
  try {
    const { employee_name, salary_month, deduction_type, amount } = req.body;
    if (!employee_name || !salary_month || !deduction_type || !amount) {
      return res.status(400).json({ error: 'employee_name, salary_month, deduction_type, and amount are required' });
    }
    if (Number(amount) <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
    const record = await store.createSalaryDeduction(req.body);
    res.status(201).json(record);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id - Update deduction
router.put('/:id', async (req, res) => {
  try {
    const record = await store.updateSalaryDeduction(req.params.id, req.body);
    if (!record) return res.status(404).json({ error: 'Salary deduction not found' });
    res.json(record);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id - Delete deduction
router.delete('/:id', async (req, res) => {
  try {
    const ok = await store.deleteSalaryDeduction(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Salary deduction not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
