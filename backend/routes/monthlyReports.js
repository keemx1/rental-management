const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');

const router = express.Router();
router.use(requireAuthActive);

// List all monthly reports
router.get('/', async (req, res) => {
  try {
    const reports = await store.listMonthlyReports();
    res.json({ reports });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list monthly reports: ' + err.message });
  }
});

// Get a specific monthly report
router.get('/:month', async (req, res) => {
  try {
    const { month } = req.params;
    const housePaybill = req.query.house_paybill || null;
    const report = await store.getMonthlyReport(month, housePaybill);
    if (!report) return res.status(404).json({ error: 'Report not found for this month' });
    res.json({ report });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get monthly report: ' + err.message });
  }
});

// Generate/refresh a monthly report (without closing it)
router.post('/:month/refresh', async (req, res) => {
  try {
    const { month } = req.params;
    const housePaybill = req.body?.house_paybill || null;
    const report = await store.generateMonthlyReport(month, housePaybill);
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate monthly report: ' + err.message });
  }
});

// Close a monthly report (make it permanent)
router.post('/:month/close', async (req, res) => {
  try {
    const { month } = req.params;
    const housePaybill = req.body?.house_paybill || null;
    const report = await store.closeMonthlyReport(month, housePaybill);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ error: 'Failed to close monthly report: ' + err.message });
  }
});

// Create maintenance charges from a completed work order
router.post('/charges/from-wo/:woId', async (req, res) => {
  try {
    const charges = await store.createMaintenanceChargesFromWO(Number(req.params.woId));
    res.json({ success: true, charges, count: charges.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create maintenance charges: ' + err.message });
  }
});

// List maintenance charges for a month
router.get('/:month/charges', async (req, res) => {
  try {
    const { month } = req.params;
    const { pool } = require('../config/database');
    const res2 = await pool.query(
      `SELECT mc.*, wo.property_name
       FROM maintenance_charges mc
       LEFT JOIN work_orders wo ON mc.work_order_id = wo.id
       WHERE mc.charge_month = $1
       ORDER BY mc.wo_number, mc.issue_no`,
      [month]
    );
    res.json({ charges: res2.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list charges: ' + err.message });
  }
});

module.exports = router;
