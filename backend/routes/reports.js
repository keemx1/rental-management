const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const os = require('os');
const store = require('../storage/store');
const whatsapp = require('../config/whatsapp');
const { requireAuthActive } = require('../middleware/auth');
const { streamWorkbook } = require('../services/excelStream');
const { resolveLogoPath, getLogoExtension } = require('../services/logo');
const { reportDocumentName, renameForDelivery } = require('../services/docNames');
const { formatWorksheet, addReportHeader, addSummarySection, formatKes } = require('../services/excelFormat');

router.use(requireAuthActive);

function addLogoAndTitle(workbook, worksheet, title, colSpan) {
  worksheet.insertRow(1, []);
  worksheet.mergeCells(`A1:${colSpan}1`);
  worksheet.getRow(1).height = 140;

  const logoPath = resolveLogoPath();
  if (logoPath) {
    const imageId = workbook.addImage({ filename: logoPath, extension: getLogoExtension() });
    worksheet.addImage(imageId, {
      tl: { col: 1.8, row: 0.1 },
      ext: { width: 120, height: 120 },
    });
  }

  worksheet.insertRow(2, [`GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS ${title}`]);
  worksheet.mergeCells(`A2:${colSpan}2`);
  worksheet.getCell('A2').font = { bold: true, size: 14 };
  worksheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
  worksheet.getRow(2).height = 30;

  worksheet.insertRow(3, []);
}

function addHeaderRow(worksheet, rowNum, headers) {
  const row = worksheet.insertRow(rowNum, headers);
  row.font = { bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };
  return row;
}

async function sendExcelReport(phone_number, workbook, filename, caption) {
  const tempFilePath = path.join(os.tmpdir(), `report_${Date.now()}.xlsx`);
  await workbook.xlsx.writeFile(tempFilePath);
  const deliveryPath = renameForDelivery(tempFilePath, filename);
  await whatsapp.sendMediaMessage(phone_number, deliveryPath, caption);
  fs.unlinkSync(deliveryPath);
}

router.post('/outstanding-balances', async (req, res) => {
  try {
    const { phone_number, house_id, mode } = req.body;
    if (mode !== 'download' && !phone_number) return res.status(400).json({ error: 'Phone number required' });

    const rows = await store.getOutstandingBalances(house_id || null);
    const house = house_id ? await store.getHouse(house_id) : null;
    const docName = reportDocumentName({ type: 'Outstanding_Report', houseName: house ? house.house_name : '', date: new Date() });

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Outstanding Balances', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    });
    ws.columns = [
      { key: 'unit', width: 12 },
      { key: 'tenant', width: 22 },
      { key: 'house', width: 22 },
      { key: 'arrears', width: 16 },
      { key: 'penalties', width: 16 },
      { key: 'garbage', width: 16 },
      { key: 'deposit_shortfall', width: 18 },
      { key: 'outstanding', width: 16 },
    ];

    addLogoAndTitle(workbook, ws, 'OUTSTANDING BALANCES REPORT', 'H');
    addHeaderRow(ws, 4, ['Unit Number', 'Tenant Name', 'Apartment', 'Arrears (KES)', 'Pending Invoices (KES)', 'Garbage Fee (KES)', 'Deposit Shortfall (KES)', 'Total Outstanding (KES)']);

    let totalArrears = 0;
    let totalPenalties = 0;
    let totalGarbage = 0;
    let totalShortfall = 0;
    let totalOutstanding = 0;

    for (const r of rows) {
      const shortfall = Math.max(0, r.deposit_amount - r.deposit_paid);
      const garbage = Math.max(0, r.garbage_fee_amount - r.garbage_fee_paid);
      totalArrears += r.arrears;
      totalPenalties += r.penalties_outstanding;
      totalGarbage += garbage;
      totalShortfall += shortfall;
      totalOutstanding += r.outstanding;
      ws.addRow({
        unit: r.tenant_code || '',
        tenant: r.name || '',
        house: r.house_name || '',
        arrears: r.arrears,
        penalties: r.penalties_outstanding,
        garbage,
        deposit_shortfall: shortfall,
        outstanding: r.outstanding,
      });
    }

    ws.addRow([]);
    const totalRow = ws.addRow({
      unit: '',
      tenant: 'TOTAL',
      house: '',
      arrears: totalArrears,
      penalties: totalPenalties,
      garbage: totalGarbage,
      deposit_shortfall: totalShortfall,
      outstanding: totalOutstanding,
    });
    totalRow.font = { bold: true };

    formatWorksheet(ws, { dataStartRow: 4, headerRowNum: 4, printLandscape: true, repeatHeaderRows: [4] });

    if (mode === 'download') {
      return streamWorkbook(res, workbook, 'Outstanding_Balances_Report', 'Outstanding_Balances_Report', docName);
    }
    await sendExcelReport(phone_number, workbook, docName, 'Here is the outstanding balances report.');
    res.json({ success: true, count: rows.length });
  } catch (err) {
    console.error('[Reports] outstanding-balances:', err);
    res.status(500).json({ error: 'Failed to generate outstanding balances report' });
  }
});

router.post('/unpaid-units', async (req, res) => {
  try {
    const { phone_number, house_id, mode } = req.body;
    if (mode !== 'download' && !phone_number) return res.status(400).json({ error: 'Phone number required' });

    const rows = await store.getUnpaidUnits(house_id || null);
    const house = house_id ? await store.getHouse(house_id) : null;
    const docName = reportDocumentName({ type: 'Unpaid_Units_Report', houseName: house ? house.house_name : '', date: new Date() });

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Unpaid Units', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    });
    ws.columns = [
      { key: 'unit', width: 12 },
      { key: 'tenant', width: 22 },
      { key: 'house', width: 22 },
      { key: 'amount_due', width: 16 },
    ];

    addLogoAndTitle(workbook, ws, 'UNPAID UNITS REPORT', 'D');
    addHeaderRow(ws, 4, ['Unit Number', 'Tenant Name', 'Apartment', 'Amount Due (KES)']);

    let totalDue = 0;
    for (const r of rows) {
      totalDue += r.rent_amount;
      ws.addRow({
        unit: r.tenant_code || '',
        tenant: r.name || '',
        house: r.house_name || '',
        amount_due: r.rent_amount,
      });
    }

    ws.addRow([]);
    const totalRow = ws.addRow({
      unit: '',
      tenant: 'TOTAL',
      house: '',
      amount_due: totalDue,
    });
    totalRow.font = { bold: true };

    formatWorksheet(ws, { dataStartRow: 4, headerRowNum: 4, printLandscape: true, repeatHeaderRows: [4] });

    if (mode === 'download') {
      return streamWorkbook(res, workbook, 'Unpaid_Units_Report', 'Unpaid_Units_Report', docName);
    }
    await sendExcelReport(phone_number, workbook, docName, 'Here is the unpaid units report.');
    res.json({ success: true, count: rows.length });
  } catch (err) {
    console.error('[Reports] unpaid-units:', err);
    res.status(500).json({ error: 'Failed to generate unpaid units report' });
  }
});

router.post('/deposits-new-tenants', async (req, res) => {
  try {
    const { phone_number, house_id, month, mode } = req.body;
    if (mode !== 'download' && !phone_number) return res.status(400).json({ error: 'Phone number required' });

    const data = await store.getDepositsAndNewTenants(house_id || null, month || null);
    const house = house_id ? await store.getHouse(house_id) : null;
    const docName = reportDocumentName({
      type: 'Deposits_New_Tenants_Report',
      houseName: house ? house.house_name : '',
      date: month ? new Date(month + '-01') : new Date(),
    });

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Deposits & New Tenants');
    ws.columns = [
      { key: 'type', width: 18 },
      { key: 'tenant', width: 25 },
      { key: 'unit', width: 15 },
      { key: 'house', width: 25 },
      { key: 'amount', width: 18 },
      { key: 'date', width: 15 },
    ];

    addLogoAndTitle(workbook, ws, 'DEPOSIT REPORT & NEW TENANT ENTRIES', 'F');
    addHeaderRow(ws, 4, ['Type', 'Tenant Name', 'Unit Number', 'Apartment', 'Amount (KES)', 'Date']);

    const monthLabel = month ? new Date(month).toLocaleString('en-KE', { month: 'long', year: 'numeric' }) : new Date().toLocaleString('en-KE', { month: 'long', year: 'numeric' });

    ws.insertRow(5, [`Deposits Received — ${monthLabel}`]);
    ws.mergeCells('A5:F5');
    ws.getCell('A5').font = { bold: true, size: 12, color: { argb: 'FF1E3A5F' } };

    let totalDeposits = 0;
    let rowNum = 6;
    if (data.deposits.length === 0) {
      ws.insertRow(rowNum, ['No deposit payments recorded for this period']);
      ws.mergeCells(`A${rowNum}:F${rowNum}`);
      ws.getCell(`A${rowNum}`).font = { italic: true, color: { argb: 'FF888888' } };
      rowNum++;
    } else {
      for (const d of data.deposits) {
        ws.insertRow(rowNum, [
          'Deposit Payment',
          d.tenant_name || '',
          d.tenant_code || '',
          d.house_name || '',
          d.amount,
          d.payment_date || '',
        ]);
        totalDeposits += d.amount;
        rowNum++;
      }
    }

    rowNum++;
    ws.insertRow(rowNum, [`Total Deposits Received: KES ${formatKes(totalDeposits)}`]);
    ws.mergeCells(`A${rowNum}:F${rowNum}`);
    ws.getCell(`A${rowNum}`).font = { bold: true };
    rowNum += 2;

    ws.insertRow(rowNum, [`New Tenant Entries — ${monthLabel}`]);
    ws.mergeCells(`A${rowNum}:F${rowNum}`);
    ws.getCell(`A${rowNum}`).font = { bold: true, size: 12, color: { argb: 'FF1E3A5F' } };
    rowNum++;

    if (data.newTenants.length === 0) {
      ws.insertRow(rowNum, ['No new tenants added for this period']);
      ws.mergeCells(`A${rowNum}:F${rowNum}`);
      ws.getCell(`A${rowNum}`).font = { italic: true, color: { argb: 'FF888888' } };
      rowNum++;
    } else {
      for (const t of data.newTenants) {
        ws.insertRow(rowNum, [
          'New Tenant',
          t.name || '',
          t.tenant_code || '',
          t.house_name || '',
          t.deposit_amount,
          t.created_at ? t.created_at.slice(0, 10) : '',
        ]);
        rowNum++;
      }
    }

    if (mode === 'download') {
      return streamWorkbook(res, workbook, 'Deposits_New_Tenants_Report', 'Deposits_New_Tenants_Report', docName);
    }
    await sendExcelReport(phone_number, workbook, docName, 'Here is the deposits and new tenants report.');
    res.json({ success: true, deposits: data.deposits.length, newTenants: data.newTenants.length });
  } catch (err) {
    console.error('[Reports] deposits-new-tenants:', err);
    res.status(500).json({ error: 'Failed to generate deposits and new tenants report' });
  }
});

router.post('/rollover', async (req, res) => {
  try {
    const { runRolloverJob } = require('../services/scheduler');
    const force = req.body && req.body.force === true;
    const result = await runRolloverJob({ force });

    if (result.skipped) {
      if (result.reason === 'already_ran_this_month') {
        return res.status(409).json({
          error: `Rollover already ran for ${result.month} at ${result.last_rollover_at}. Manual rerun is blocked to prevent duplicate arrears or incorrect balances.`,
          last_rollover_at: result.last_rollover_at,
          month: result.month,
        });
      }
      return res.status(409).json({ error: 'A rollover is already running right now. Please wait a moment and try again.' });
    }

    const actor = req.user ? req.user.username : 'system';
    try {
      await store.logAudit({
        actor,
        action: 'rollover_run',
        entityType: 'system',
        entityId: result.details && result.details.length ? `month:${result.details[0].new_due_date}` : null,
        details: { tenants_updated: result.tenants_updated, force },
      });
    } catch (auditErr) {
      console.error('[Reports] rollover audit log failed:', auditErr.message);
    }

    res.json({ success: true, tenants_updated: result.tenants_updated, details: result.details });
  } catch (err) {
    console.error('[Reports] rollover:', err);
    res.status(500).json({ error: 'Failed to run rollover' });
  }
});

module.exports = router;
