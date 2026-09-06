const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const ExcelJS = require('exceljs');
const { streamWorkbook } = require('../services/excelStream');
const { resolveLogoPath, getLogoExtension } = require('../services/logo');

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

// Get enhanced monthly report (unit-by-unit financial detail)
router.get('/:month/enhanced', async (req, res) => {
  try {
    const { month } = req.params;
    const housePaybill = req.query.house_paybill || null;
    const data = await store.buildEnhancedMonthlyReport(month, housePaybill);
    res.json({ report: data });
  } catch (err) {
    console.error('[Enhanced Report]', err);
    res.status(500).json({ error: 'Failed to generate enhanced report: ' + err.message });
  }
});

// Download enhanced monthly report as Excel
router.post('/:month/enhanced/excel', async (req, res) => {
  try {
    const { month } = req.params;
    const housePaybill = req.body?.house_paybill || null;
    const data = await store.buildEnhancedMonthlyReport(month, housePaybill);

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Enhanced Monthly Report', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });

    const lastCol = 'O';
    ws.columns = [
      { key: 'c1', width: 12 }, { key: 'c2', width: 22 }, { key: 'c3', width: 16 },
      { key: 'c4', width: 14 }, { key: 'c5', width: 14 }, { key: 'c6', width: 14 },
      { key: 'c7', width: 16 }, { key: 'c8', width: 16 }, { key: 'c9', width: 16 },
      { key: 'c10', width: 16 }, { key: 'c11', width: 18 }, { key: 'c12', width: 22 },
      { key: 'c13', width: 14 }, { key: 'c14', width: 16 }, { key: 'c15', width: 16 },
    ];

    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const [yr, mo] = month.split('-');
    const monthLabel = `${monthNames[parseInt(mo, 10) - 1]} ${yr}`;
    const propLabel = data.property_name ? ` - ${data.property_name}` : ' - All Properties';

    // Logo
    ws.insertRow(1, []);
    ws.mergeCells(`A1:${lastCol}1`);
    ws.getRow(1).height = 120;
    const logoPath = resolveLogoPath();
    if (logoPath) {
      const imageId = workbook.addImage({ filename: logoPath, extension: getLogoExtension() });
      ws.addImage(imageId, { tl: { col: 1.8, row: 0.1 }, ext: { width: 100, height: 100 } });
    }

    // Title
    ws.insertRow(2, [`GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS - ENHANCED MONTHLY REPORT${propLabel}`]);
    ws.mergeCells(`A2:${lastCol}2`);
    ws.getCell('A2').font = { bold: true, size: 13 };
    ws.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 28;

    ws.insertRow(3, [`Period: ${monthLabel}`]);
    ws.mergeCells(`A3:${lastCol}3`);
    ws.getCell('A3').font = { size: 11, italic: true };
    ws.getCell('A3').alignment = { horizontal: 'center' };
    ws.getRow(3).height = 20;
    ws.insertRow(4, []);

    // ─── SECTION 1: Unit-by-Unit Financial Table ───
    ws.insertRow(5, ['DETAILED UNIT-BY-UNIT FINANCIAL TABLE']);
    ws.mergeCells(`A5:${lastCol}5`);
    ws.getCell('A5').font = { bold: true, size: 12 };
    ws.getRow(5).height = 22;

    const hdr = ws.addRow([
      'Unit No', 'Tenant Name', 'Telephone', 'Deposit (KES)', 'Water (KES)',
      'Penalty (KES)', 'Monthly Rent (KES)', 'Balance B/F (KES)', 'Rent Due (KES)',
      'Rent Paid (KES)', 'Receipt No.', 'Transaction Ref', 'Payment Date',
      'Balance (KES)', 'Status',
    ]);
    hdr.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    hdr.height = 20;
    hdr.eachCell(c => { c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });

    for (const u of data.units) {
      const r = ws.addRow([
        u.unit_number, u.tenant_name, u.telephone,
        u.deposit || null, u.water || null, u.penalty || null,
        u.monthly_rent || null, u.balance_bf || null, u.rent_due || null,
        u.rent_paid || null, u.receipt_no, u.transaction_ref,
        u.payment_date || '', u.balance || null, u.status,
      ]);
      r.eachCell(c => { c.font = { size: 9 }; c.alignment = { vertical: 'middle' }; });
      const sc = r.getCell(15);
      if (u.status === 'CLEARED') sc.font = { bold: true, color: { argb: 'FF16A34A' }, size: 9 };
      else if (u.status === 'PARTIALLY_PAID') sc.font = { bold: true, color: { argb: 'FFF59E0B' }, size: 9 };
      else if (u.status === 'UNPAID') sc.font = { bold: true, color: { argb: 'FFDC2626' }, size: 9 };
      else if (u.status === 'VACANT') r.eachCell(c => { c.font = { size: 9, italic: true, color: { argb: 'FF94A3B8' } }; });
      else if (u.status === 'BOOKED') r.eachCell(c => { c.font = { size: 9, italic: true, color: { argb: 'FF6366F1' } }; });
      else if (u.status === 'OVERPAYMENT') sc.font = { bold: true, color: { argb: 'FF2563EB' }, size: 9 };
    }

    const totalsRow = ws.addRow([
      '', 'TOTALS', '',
      data.units.reduce((s, u) => s + (u.deposit || 0), 0),
      data.units.reduce((s, u) => s + (u.water || 0), 0),
      data.units.reduce((s, u) => s + (u.penalty || 0), 0),
      data.units.reduce((s, u) => s + (u.monthly_rent || 0), 0),
      data.units.reduce((s, u) => s + (u.balance_bf || 0), 0),
      data.units.reduce((s, u) => s + (u.rent_due || 0), 0),
      data.units.reduce((s, u) => s + (u.rent_paid || 0), 0),
      '', '', '',
      data.units.reduce((s, u) => s + (u.balance || 0), 0),
      '',
    ]);
    totalsRow.font = { bold: true, size: 9 };
    for (let ci = 4; ci <= 10; ci++) totalsRow.getCell(ci).numFmt = '#,##0';
    totalsRow.getCell(14).numFmt = '#,##0';
    ws.insertRow(1, []);

    // ─── SECTION 2: Work Done During the Month ───
    const workRow = ws.addRow([]);
    const workTitleRow = ws.addRow(['WORK DONE DURING THE MONTH']);
    ws.mergeCells(`A${workTitleRow.number}:${lastCol}${workTitleRow.number}`);
    ws.getCell(`A${workTitleRow.number}`).font = { bold: true, size: 12 };
    ws.getRow(workTitleRow.number).height = 22;

    const wHdr = ws.addRow([
      'WO No', 'Unit', 'Tenant', 'Problem Reported', 'Work Done',
      'Material Cost', 'Labour Cost', 'Total Cost', 'Responsible Party',
      'Amount Recovered', 'Outstanding Recovery', 'Status', '', '', '',
    ]);
    wHdr.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    wHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD97706' } };
    wHdr.height = 20;
    wHdr.eachCell(c => { c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });

    if (data.work_summary.length === 0) {
      ws.addRow(['No work/maintenance activities recorded for this month.', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    } else {
      for (const w of data.work_summary) {
        ws.addRow([
          w.wo_number, w.unit, w.tenant, w.problem, w.work_done,
          w.material_cost || null, w.labour_cost || null, w.total_cost || null,
          w.responsible_party, w.amount_recovered || null, w.outstanding_recovery || null, w.status,
          '', '', '',
        ]);
      }
    }
    ws.insertRow(1, []);

    // ─── SECTION 3: Invoices Issued During the Month ───
    const invTitleRow = ws.addRow(['INVOICES ISSUED DURING THE MONTH']);
    ws.mergeCells(`A${invTitleRow.number}:${lastCol}${invTitleRow.number}`);
    ws.getCell(`A${invTitleRow.number}`).font = { bold: true, size: 12 };
    ws.getRow(invTitleRow.number).height = 22;

    const iHdr = ws.addRow([
      'Invoice No', 'Invoice Type', 'Property/Unit', 'Description', 'Amount (KES)',
      'Date Issued', 'Responsible Party', 'Payment Status', 'Amount Paid', 'Outstanding Amount',
      '', '', '', '', '',
    ]);
    iHdr.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    iHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C3AED' } };
    iHdr.height = 20;
    iHdr.eachCell(c => { c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });

    if (data.invoices_issued.length === 0) {
      ws.addRow(['No invoices issued during this month.', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    } else {
      for (const inv of data.invoices_issued) {
        ws.addRow([
          inv.invoice_number, inv.invoice_type, inv.property ? `${inv.property}${inv.unit ? ' / ' + inv.unit : ''}` : (inv.unit || ''),
          inv.description, inv.amount || null,
          inv.date_issued ? new Date(inv.date_issued).toISOString().slice(0, 10) : '',
          inv.responsible_party, inv.payment_status, inv.amount_paid || null, inv.outstanding || null,
          '', '', '', '', '',
        ]);
      }
    }
    ws.insertRow(1, []);

    // ─── SECTION 4: Monthly Summary ───
    const sumTitleRow = ws.addRow(['MONTHLY SUMMARY / TOTALS']);
    ws.mergeCells(`A${sumTitleRow.number}:${lastCol}${sumTitleRow.number}`);
    ws.getCell(`A${sumTitleRow.number}`).font = { bold: true, size: 12 };
    ws.getRow(sumTitleRow.number).height = 22;

    const s = data.summary;
    const summaryData = [
      ['Total Units', s.total_units, '', 'Total Rent Due', s.total_rent_due],
      ['Occupied Units', s.occupied_units, '', 'Total Rent Paid/Collected', s.total_rent_paid],
      ['Vacant Units', s.vacant_units, '', 'Total Deposit Collected', s.total_deposit_collected],
      ['Booked Units', s.booked_units, '', 'Total Water Charges', s.total_water_charges],
      ['Paid Units', s.paid_units, '', 'Penalties (Pending)', s.total_penalties],
      ['Partially Paid Units', s.partially_paid_units, '', 'Penalties (Paid)', s.total_penalties_paid || 0],
      ['Unpaid Units', s.unpaid_units, '', 'Total Outstanding Balance', s.total_outstanding],
      ['Unpaid Units', s.unpaid_units, '', 'Total Advance/Overpayment', s.total_advance_overpayment],
      ['Overpayment Units', s.overpayment_units, '', 'Total Credit Balance', s.total_credit_balance],
      ['New Tenants', s.new_tenants, '', 'Total Tenant Recoveries', s.total_tenant_recoveries],
      ['Vacated Tenants', s.vacated_tenants, '', 'Total Mgmt Maintenance Cost', s.total_mgmt_maintenance_cost],
      ['', '', '', 'Total Work/Repair Cost', s.total_work_repair_cost],
      ['', '', '', 'Total Invoices Issued', s.total_invoices_issued],
    ];
    for (const row of summaryData) {
      const r = ws.addRow(row);
      r.getCell(1).font = { bold: true, size: 10 };
      r.getCell(2).font = { size: 10 };
      r.getCell(2).numFmt = '#,##0';
      r.getCell(4).font = { bold: true, size: 10 };
      r.getCell(5).font = { size: 10 };
      r.getCell(5).numFmt = '#,##0';
    }

    // Save & stream
    const today = new Date().toISOString().slice(0, 10);
    const safeProp = (data.property_name || 'All').replace(/[^A-Za-z0-9]/g, '_');
    const filename = `Enhanced_Monthly_Report_${safeProp}_${month}_${today}.xlsx`;
    streamWorkbook(res, workbook, 'Enhanced_Monthly_Report', 'Enhanced_Monthly_Report', filename);
  } catch (err) {
    console.error('[Enhanced Report Excel]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate enhanced report Excel' });
  }
});

// Download standard monthly report as Excel
router.post('/:month/excel', async (req, res) => {
  try {
    const { month } = req.params;
    const housePaybill = req.body?.house_paybill || null;

    // Build the report data fresh (same as refresh)
    const rd = await store.buildMonthlyReportData(month, housePaybill);
    const propertyName = housePaybill ? (await store.getHouse(housePaybill))?.house_name || null : null;

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Monthly Report', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });

    const lastCol = 'I';
    ws.columns = [
      { key: 'a', width: 20 }, { key: 'b', width: 30 }, { key: 'c', width: 16 },
      { key: 'd', width: 16 }, { key: 'e', width: 16 }, { key: 'f', width: 16 },
      { key: 'g', width: 16 }, { key: 'h', width: 16 }, { key: 'i', width: 16 },
    ];

    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const [yr, mo] = month.split('-');
    const monthLabel = `${monthNames[parseInt(mo, 10) - 1]} ${yr}`;
    const propLabel = propertyName ? ` - ${propertyName}` : ' - All Properties';

    // Logo
    ws.insertRow(1, []);
    ws.mergeCells(`A1:${lastCol}1`);
    ws.getRow(1).height = 120;
    const logoPath = resolveLogoPath();
    if (logoPath) {
      const imageId = workbook.addImage({ filename: logoPath, extension: getLogoExtension() });
      ws.addImage(imageId, { tl: { col: 1.8, row: 0.1 }, ext: { width: 100, height: 100 } });
    }

    ws.insertRow(2, [`GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS - MONTHLY REPORT${propLabel}`]);
    ws.mergeCells(`A2:${lastCol}2`);
    ws.getCell('A2').font = { bold: true, size: 13 };
    ws.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 28;

    ws.insertRow(3, [`Period: ${monthLabel}`]);
    ws.mergeCells(`A3:${lastCol}3`);
    ws.getCell('A3').font = { size: 11, italic: true };
    ws.getCell('A3').alignment = { horizontal: 'center' };
    ws.getRow(3).height = 20;
    ws.insertRow(4, []);

    const money = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });

    // ─── Revenue ───
    const rev = rd.revenue || {};
    ws.insertRow(5, ['REVENUE SUMMARY']);
    ws.mergeCells(`A5:${lastCol}5`);
    ws.getCell('A5').font = { bold: true, size: 12 };
    ws.addRow(['Revenue Collected', rev.total_collected || 0, '', 'Payments', rev.payment_count || 0]);
    ws.addRow(['Deposits Collected', rev.deposits_collected || 0, '', '', '']);
    ws.insertRow(1, []);

    // ─── Occupancy ───
    const occ = rd.occupancy || {};
    const occRow = ws.addRow([]);
    const occTitle = ws.addRow(['OCCUPANCY & COLLECTION STATUS']);
    ws.mergeCells(`A${occTitle.number}:${lastCol}${occTitle.number}`);
    ws.getCell(`A${occTitle.number}`).font = { bold: true, size: 12 };
    ws.addRow(['Occupied', occ.occupied || 0, '', 'Paid', occ.paid_count || 0]);
    ws.addRow(['Vacant', occ.vacant || 0, '', 'Partially Paid', occ.partial_count || 0]);
    ws.addRow(['New Tenants', occ.new_tenants || 0, '', 'Unpaid', occ.unpaid_count || 0]);
    ws.addRow(['Exiting', occ.exiting_tenants || 0, '', 'Collection %', `${occ.collection_pct || 0}%`]);
    ws.insertRow(1, []);

    // ─── Management Expenses ───
    const mgmt = rd.management_expenses || [];
    const mgmtTitle = ws.addRow(['MANAGEMENT EXPENSES']);
    ws.mergeCells(`A${mgmtTitle.number}:${lastCol}${mgmtTitle.number}`);
    ws.getCell(`A${mgmtTitle.number}`).font = { bold: true, size: 12 };
    const mgmtHdr = ws.addRow(['WO No', 'Issue', 'Unit', 'Problem', 'Material', 'Labour', 'Total', 'Party', '']);
    mgmtHdr.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    mgmtHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD97706' } };
    for (const e of mgmt) {
      ws.addRow([e.wo_number, e.issue_no, e.unit, e.problem, e.material_cost, e.labour_cost, e.total_cost, e.responsible_party, '']);
    }
    if (mgmt.length === 0) ws.addRow(['No management expenses this month', '', '', '', '', '', '', '', '']);
    ws.insertRow(1, []);

    // ─── Tenant Recoveries ───
    const tenant = rd.tenant_recoveries || [];
    const tenantTitle = ws.addRow(['TENANT RECOVERIES']);
    ws.mergeCells(`A${tenantTitle.number}:${lastCol}${tenantTitle.number}`);
    ws.getCell(`A${tenantTitle.number}`).font = { bold: true, size: 12 };
    const tenantHdr = ws.addRow(['WO No', 'Unit', 'Tenant', 'Problem', 'Total', 'Recovered', 'Outstanding', 'Status', '']);
    tenantHdr.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    tenantHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    for (const e of tenant) {
      ws.addRow([e.wo_number, e.unit, e.tenant, e.problem, e.total_cost, e.amount_recovered, e.total_cost - e.amount_recovered, e.recovery_status, '']);
    }
    if (tenant.length === 0) ws.addRow(['No tenant recoveries this month', '', '', '', '', '', '', '', '']);
    ws.insertRow(1, []);

    // ─── Penalties ───
    const penalties = rd.penalties || [];
    const penTitle = ws.addRow(['PENALTY INVOICES']);
    ws.mergeCells(`A${penTitle.number}:${lastCol}${penTitle.number}`);
    ws.getCell(`A${penTitle.number}`).font = { bold: true, size: 12 };
    const penHdr = ws.addRow(['Tenant', 'Description', 'Category', 'Amount', 'Status', '', '', '', '']);
    penHdr.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    penHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC2626' } };
    for (const p of penalties) {
      ws.addRow([p.tenant_name, p.description, p.category, p.amount, p.status, '', '', '', '']);
    }
    if (penalties.length === 0) ws.addRow(['No penalties this month', '', '', '', '', '', '', '', '']);
    ws.insertRow(1, []);

    // ─── Exit Invoices ───
    const exits = rd.exit_invoices || [];
    const exitTitle = ws.addRow(['EXIT INVOICES']);
    ws.mergeCells(`A${exitTitle.number}:${lastCol}${exitTitle.number}`);
    ws.getCell(`A${exitTitle.number}`).font = { bold: true, size: 12 };
    const exitHdr = ws.addRow(['Exit No', 'Tenant', 'Unit', 'Rent Treatment', 'Deductions', 'Deposit Refund', 'Final', 'Status', '']);
    exitHdr.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    exitHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C3AED' } };
    for (const e of exits) {
      ws.addRow([e.exit_number, e.tenant_name, e.unit_label, e.rent_treatment, e.deductions_total, e.deposit_refund, e.final_settlement, e.status, '']);
    }
    if (exits.length === 0) ws.addRow(['No exit invoices this month', '', '', '', '', '', '', '', '']);
    ws.insertRow(1, []);

    // ─── Notices to Vacate ───
    const notices = rd.notices_to_vacate || [];
    const noticeTitle = ws.addRow(['NOTICES TO VACATE']);
    ws.mergeCells(`A${noticeTitle.number}:${lastCol}${noticeTitle.number}`);
    ws.getCell(`A${noticeTitle.number}`).font = { bold: true, size: 12 };
    const noticeHdr = ws.addRow(['Tenant', 'Unit', 'Notice Date', 'Expected Vacate', 'Status', '', '', '', '']);
    noticeHdr.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    noticeHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0EA5E9' } };
    for (const n of notices) {
      ws.addRow([n.tenant_name, n.tenant_code, n.notice_date, n.expected_vacate, n.status, '', '', '', '']);
    }
    if (notices.length === 0) ws.addRow(['No notices to vacate this month', '', '', '', '', '', '', '', '']);

    const today = new Date().toISOString().slice(0, 10);
    const safeProp = (propertyName || 'All').replace(/[^A-Za-z0-9]/g, '_');
    const filename = `Monthly_Report_${safeProp}_${month}_${today}.xlsx`;
    streamWorkbook(res, workbook, 'Monthly_Report', 'Monthly_Report', filename);
  } catch (err) {
    console.error('[Standard Report Excel]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate standard report Excel' });
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
