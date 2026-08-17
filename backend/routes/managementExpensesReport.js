const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const { generateAndStoreManagementExpensesReport } = require('../services/documentStore');

const router = express.Router();
router.use(requireAuthActive);

// GET / — monthly management expenses report
router.get('/', async (req, res) => {
  try {
    const { month, date_from, date_to, property, category, status, source, employee, wo_number, invoice_number } = req.query;
    const report = await store.getManagementExpensesReport({
      month, date_from, date_to, property, category, status, source, employee, wo_number, invoice_number,
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report: ' + err.message });
  }
});

// GET /property — property expense report
router.get('/property', async (req, res) => {
  try {
    const { property, month, date_from, date_to } = req.query;
    if (!property) return res.status(400).json({ error: 'property query parameter is required' });
    const report = await store.getPropertyExpenseReport(property, month || null, date_from || null, date_to || null);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate property report: ' + err.message });
  }
});

// POST /pdf — generate management expenses report PDF
router.post('/pdf', async (req, res) => {
  try {
    const { month, date_from, date_to, property, category, status, source, employee } = req.body;
    const report = await store.getManagementExpensesReport({
      month, date_from, date_to, property, category, status, source, employee,
    });
    const result = await generateAndStoreManagementExpensesReport(report, req.user?.username || null);
    if (!result) return res.status(500).json({ error: 'Failed to generate report PDF' });
    res.download(result.pdfPath, result.filename);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report PDF: ' + err.message });
  }
});

module.exports = router;
