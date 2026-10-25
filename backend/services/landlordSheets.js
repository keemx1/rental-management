'use strict';

/**
 * Landlord sheets for the Enhanced Monthly Report Excel (reporting only).
 * All functions READ already-recorded data (enhanced report, commission
 * engine, water invoices, payment allocations). No workflow is modified.
 */

const BLUE = 'FF2563EB';
const DARK_BLUE = 'FF1A4B8C';
const WHITE = 'FFFFFFFF';
const GREEN = 'FF16A34A';
const AMBER = 'FFF59E0B';
const RED = 'FFDC2626';
const GREY = 'FF64748B';

function pct(part, whole) {
  const p = Number(part || 0);
  const w = Number(whole || 0);
  if (!(w > 0)) return 0;
  return Math.round((p / w) * 1000) / 1000;
}

function healthText(frac) {
  const v = Number(frac || 0);
  if (v >= 0.95) return 'Excellent';
  if (v >= 0.8) return 'Good';
  if (v >= 0.6) return 'Fair';
  return 'Needs attention';
}

const { resolveLogoPath, getLogoExtension } = require('./logo');
const { finishSheet } = require('./excelFormat');

// Centered logo row + titles + repeating print row, shared by every sheet so
// each one opens (and prints) with the logo on top, centrally aligned.
function prepareSheet(workbook, ws, lastCol, title, subtitle) {
  ws.insertRow(1, []);
  ws.mergeCells(`A1:${lastCol}1`);
  ws.getRow(1).height = 90;
  try {
    const logoPath = resolveLogoPath();
    if (logoPath) {
      const imageId = workbook.addImage({ filename: logoPath, extension: getLogoExtension() });
      const widths = (ws.columns || []).map((c) => Number(c.width) || 10);
      const total = widths.reduce((s, w) => s + w, 0) || 100;
      const IMG_CHARS = 14; // ~100px image in character units
      const target = (total - IMG_CHARS) / 2;
      let acc = 0;
      let col = 0;
      for (let i = 0; i < widths.length; i++) {
        if (acc + widths[i] >= target) {
          col = i + Math.max(0, (target - acc)) / widths[i];
          break;
        }
        acc += widths[i];
      }
      ws.addImage(imageId, { tl: { col, row: 0.05 }, ext: { width: 100, height: 72 } });
    }
  } catch (_) {}
  ws.mergeCells(`A2:${lastCol}2`);
  ws.getCell('A2').value = 'GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS';
  ws.getCell('A2').font = { bold: true, size: 13, color: { argb: DARK_BLUE } };
  ws.getCell('A2').alignment = { horizontal: 'center' };
  ws.getRow(2).height = 22;
  ws.mergeCells(`A3:${lastCol}3`);
  ws.getCell('A3').value = title;
  ws.getCell('A3').font = { bold: true, size: 12 };
  ws.getCell('A3').alignment = { horizontal: 'center' };
  ws.getRow(3).height = 22;
  ws.mergeCells(`A4:${lastCol}4`);
  ws.getCell('A4').value = subtitle;
  ws.getCell('A4').font = { size: 10, italic: true };
  ws.getCell('A4').alignment = { horizontal: 'center' };
  ws.getRow(4).height = 18;
  ws.addRow([]);
  if (!ws.pageSetup) ws.pageSetup = {};
  ws.pageSetup.printTitlesRow = '1:1';
}

function sectionTitle(ws, lastCol, text, color) {
  ws.addRow([]);
  const r = ws.addRow([text]);
  ws.mergeCells(`A${r.number}:${lastCol}${r.number}`);
  ws.getCell(`A${r.number}`).font = { bold: true, size: 12, color: { argb: color || DARK_BLUE } };
  ws.getRow(r.number).height = 22;
}

function headerRow(ws, labels, color) {
  const hdr = ws.addRow(labels);
  hdr.font = { bold: true, size: 9, color: { argb: WHITE } };
  hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color || BLUE } };
  hdr.height = 20;
  hdr.eachCell((c) => { c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
  // Repeat the real column headings on every printed page (the first header
  // row wins — later section headers must not replace it). Falls back to the
  // logo row set by prepareSheet for sheets without a table header.
  if (!ws.pageSetup) ws.pageSetup = {};
  if (!ws.pageSetup.printTitlesRow || ws.pageSetup.printTitlesRow === '1:1') {
    ws.pageSetup.printTitlesRow = `${hdr.number}:${hdr.number}`;
  }
  return hdr;
}

function kpiRow(ws, label, value, opts = {}) {
  const r = ws.addRow([label, value]);
  r.getCell(1).font = { bold: true, size: 10 };
  r.getCell(2).font = { size: 10, bold: !!opts.bold, color: opts.color ? { argb: opts.color } : undefined };
  if (opts.numFmt) r.getCell(2).numFmt = opts.numFmt;
  return r;
}

// Shared derived figures (single definitions used by every new sheet).
function deriveFigures(data, pack) {
  const s = data.summary || {};
  const units = data.units || [];
  const occupied = units.filter((u) => u.status !== 'VACANT' && u.status !== 'BOOKED');
  const rentExpected = occupied.reduce((sum, u) => sum + Number(u.monthly_rent || 0), 0);
  const c = (pack.collections && pack.collections.totals) || {};
  const rentCollected = Number(c.rent || 0) + Number(c.arrears || 0);
  const waterBilled = Number((pack.waterTotals && pack.waterTotals.total_water_charges) || 0);
  const waterCollected = Number(c.water || 0);
  const gross = Number(c.collected || 0);
  const commissionRows = ((pack.commission && pack.commission.rows) || []);
  const commissionTotal = ((pack.commission && pack.commission.totals) || {}).commission || 0;
  const commissionBase = ((pack.commission && pack.commission.totals) || {}).commissionable || 0;
  const woExpenses = Number(s.total_work_repair_cost || 0);
  const otherExpenses = Number((pack.otherExpenses && pack.otherExpenses.total) || 0);
  const net = gross - commissionTotal - woExpenses - otherExpenses;
  return {
    rentExpected, rentCollected,
    outstanding: Number(s.total_outstanding || 0),
    waterBilled, waterCollected,
    gross, commissionTotal, commissionBase, woExpenses, otherExpenses, net,
    rentCollection: pct(rentCollected, rentExpected),
    waterCollection: pct(waterCollected, waterBilled),
    occupancy: pct(s.occupied_units, s.total_units),
    vacancy: pct(s.vacant_units, s.total_units),
    blendedRate: pct(commissionTotal, commissionBase),
    commissionRows,
    occupiedCount: s.occupied_units || 0,
    vacantCount: s.vacant_units || 0,
    totalUnits: s.total_units || 0,
  };
}

function buildExecutiveSummarySheet(workbook, data, pack, monthLabel, propLabel) {
  const f = deriveFigures(data, pack);
  const ws = workbook.addWorksheet('1 Executive Summary', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
  });
  const lastCol = 'C';
  ws.columns = [{ width: 34 }, { width: 22 }, { width: 26 }];
  prepareSheet(workbook, ws, lastCol, `LANDLORD EXECUTIVE SUMMARY${propLabel}`, `Period: ${monthLabel}`);
  const propName = data.property_name || 'All Properties';
  kpiRow(ws, 'Property / Apartment', propName, { bold: true });
  kpiRow(ws, 'Reporting month', monthLabel);
  ws.addRow([]);
  sectionTitle(ws, lastCol, 'OCCUPANCY', DARK_BLUE);
  kpiRow(ws, 'Total units', f.totalUnits, { numFmt: '#,##0' });
  kpiRow(ws, 'Occupied units', f.occupiedCount, { numFmt: '#,##0' });
  kpiRow(ws, 'Vacant units', f.vacantCount, { numFmt: '#,##0' });
  kpiRow(ws, 'Occupancy %', f.occupancy, { numFmt: '0.0%', bold: true });
  kpiRow(ws, 'Vacancy %', f.vacancy, { numFmt: '0.0%' });
  ws.addRow([]);
  sectionTitle(ws, lastCol, 'RENT PERFORMANCE', DARK_BLUE);
  kpiRow(ws, 'Total rent expected', f.rentExpected, { numFmt: '#,##0' });
  kpiRow(ws, 'Total rent collected', f.rentCollected, { numFmt: '#,##0' });
  kpiRow(ws, 'Outstanding rent / arrears', f.outstanding, { numFmt: '#,##0' });
  kpiRow(ws, 'Rent collection %', f.rentCollection, { numFmt: '0.0%', bold: true });
  ws.addRow([]);
  sectionTitle(ws, lastCol, 'WATER PERFORMANCE', DARK_BLUE);
  kpiRow(ws, 'Total water billed', f.waterBilled, { numFmt: '#,##0' });
  kpiRow(ws, 'Total water collected', f.waterCollected, { numFmt: '#,##0' });
  kpiRow(ws, 'Water collection %', f.waterCollection, { numFmt: '0.0%', bold: true });
  ws.addRow([]);
  sectionTitle(ws, lastCol, 'EXPENSES & COMMISSION', DARK_BLUE);
  kpiRow(ws, 'Work order / maintenance expenses', f.woExpenses, { numFmt: '#,##0' });
  kpiRow(ws, 'Other property expenses', f.otherExpenses, { numFmt: '#,##0' });
  kpiRow(ws, 'Management commission % (blended)', f.blendedRate, { numFmt: '0.0%' });
  kpiRow(ws, 'Management commission amount', f.commissionTotal, { numFmt: '#,##0' });
  ws.addRow([]);
  sectionTitle(ws, lastCol, 'LANDLORD RECONCILIATION', GREEN);
  kpiRow(ws, 'Gross collections', f.gross, { numFmt: '#,##0' });
  kpiRow(ws, 'Less: management commission', -f.commissionTotal, { numFmt: '#,##0' });
  kpiRow(ws, 'Less: work order expenses', -f.woExpenses, { numFmt: '#,##0' });
  kpiRow(ws, 'Less: other property expenses', -f.otherExpenses, { numFmt: '#,##0' });
  kpiRow(ws, 'NET AMOUNT PAYABLE TO LANDLORD', f.net, { numFmt: '#,##0', bold: true, color: GREEN });
  ws.addRow([]);
  sectionTitle(ws, lastCol, 'OVERALL INDICATORS', DARK_BLUE);
  kpiRow(ws, 'Collection health', healthText(f.rentCollection));
  kpiRow(ws, 'Water health', healthText(f.waterCollection));
  kpiRow(ws, 'Occupancy health', healthText(f.occupancy));
  finishSheet(ws, { landscape: false, maxColWidth: 36 });
  return f;
}

function buildRentPerformanceSheet(workbook, data, pack) {
  const f = deriveFigures(data, pack);
  const ws = workbook.addWorksheet('2 Rent Performance', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const lastCol = 'H';
  ws.columns = [{ width: 12 }, { width: 24 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 14 }, { width: 16 }, { width: 16 }];
  prepareSheet(workbook, ws, lastCol, 'RENT & PAYMENT PERFORMANCE', `Share of expected rent actually collected per unit. Collection % = collected ÷ expected × 100.`);
  const hr = headerRow(ws, ['Unit', 'Tenant', 'Status', 'Expected (KES)', 'Collected (KES)', 'Outstanding (KES)', 'Collection %', 'Payments'], BLUE);
  const byTenant = ((pack.collections && pack.collections.byTenant) || {});
  const occupied = (data.units || []).filter((u) => u.status !== 'VACANT' && u.status !== 'BOOKED');
  for (const u of occupied) {
    const code = u.tenant_code || '';
    const agg = (code && byTenant[code]) || { rent: 0, arrears: 0, count: 0 };
    const expected = Number(u.monthly_rent || 0);
    const collected = Number(agg.rent || 0) + Number(agg.arrears || 0);
    const outstanding = Math.max(0, expected - collected);
    const r = ws.addRow([
      u.unit_number, u.tenant_name, u.status,
      expected || null, collected || null, outstanding || null,
      expected > 0 ? collected / expected : 0, agg.count || null,
    ]);
    r.eachCell((c) => { c.font = { size: 9 }; });
    for (const ci of [4, 5, 6]) r.getCell(ci).numFmt = '#,##0';
    r.getCell(7).numFmt = '0.0%';
    if (u.status === 'UNPAID') r.getCell(3).font = { bold: true, color: { argb: RED }, size: 9 };
  }
  const t = ws.addRow(['TOTALS', '', '', f.rentExpected, f.rentCollected, Math.max(0, f.rentExpected - f.rentCollected), f.rentCollection, '']);
  t.font = { bold: true, size: 9 };
  for (const ci of [4, 5, 6]) t.getCell(ci).numFmt = '#,##0';
  t.getCell(7).numFmt = '0.0%';
  finishSheet(ws, { headerRowNum: hr.number, landscape: true });
}

function buildCommissionSheet(workbook, pack) {
  const ws = workbook.addWorksheet('3 Commission', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const lastCol = 'I';
  ws.columns = [{ width: 26 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 10 }, { width: 16 }, { width: 18 }];
  prepareSheet(workbook, ws, lastCol, 'MANAGEMENT COMMISSION', 'Commission = rate % × (collected − deposit − garbage − water), per house.');
  const hr = headerRow(ws, ['House', 'Collected', '− Deposit', '− Garbage', '− Water', '= Rent base', 'Rate %', 'Commission', 'Landlord payout'], AMBER);
  const rows = ((pack.commission && pack.commission.rows) || []);
  for (const r of rows) {
    const row = ws.addRow([
      r.property_name || r.house_paybill_number, r.collected || null, r.deposit || null,
      r.garbage || null, r.water || null, r.commissionable || null,
      (Number(r.rate_percent || 0)) / 100, r.commission || null, r.landlord_payout || null,
    ]);
    row.eachCell((c) => { c.font = { size: 9 }; });
    for (const ci of [2, 3, 4, 5, 6, 8, 9]) row.getCell(ci).numFmt = '#,##0';
    row.getCell(7).numFmt = '0.0%';
  }
  const t = ((pack.commission && pack.commission.totals) || {});
  const tr = ws.addRow(['TOTAL', t.collected || null, t.deposit || null, t.garbage || null, t.water || null, t.commissionable || null, '', t.commission || null, t.landlord_payout || null]);
  tr.font = { bold: true, size: 9 };
  for (const ci of [2, 3, 4, 5, 6, 8, 9]) tr.getCell(ci).numFmt = '#,##0';
  finishSheet(ws, { headerRowNum: hr.number, landscape: true });
}

function buildWaterSheet(workbook, pack, monthLabel) {
  const ws = workbook.addWorksheet('4 Water Bills', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const lastCol = 'I';
  ws.columns = [{ width: 22 }, { width: 12 }, { width: 22 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 20 }];
  prepareSheet(workbook, ws, lastCol, `WATER BILL REPORT — ${monthLabel}`, 'Every unit including vacant ones. Vacant use (caretaker, cleaning, construction) computes normally and is flagged.');
  const hr = headerRow(ws, ['Property', 'Unit', 'Tenant', 'Status', 'Previous', 'Current', 'Consumption', 'Rate', 'Amount (KES)'], 'FF0EA5E9');
  for (const w of (pack.waterByHouse || [])) {
    const pr = ws.addRow([`${w.property_name || ''}`]);
    pr.getCell(1).font = { bold: true, size: 10, color: { argb: DARK_BLUE } };
    for (const r of (w.rows || [])) {
      const vacant = r.occupancy === 'Vacant';
      const status = vacant ? ('Vacant' + (r.usage_note ? ` — ${r.usage_note}` : '')) : 'Occupied';
      const row = ws.addRow([
        '', r.unit || '', vacant ? '' : (r.tenant_name || ''), status,
        r.previous_reading ?? null, r.current_reading ?? null,
        r.consumption ?? null, r.rate_per_unit ?? null, r.water_charge ?? null,
      ]);
      row.eachCell((c) => { c.font = { size: 9, italic: vacant, color: vacant ? { argb: GREY } : undefined }; });
      for (const ci of [5, 6, 7, 8, 9]) row.getCell(ci).numFmt = '#,##0.0';
    }
  }
  const t = pack.waterTotals || {};
  const tr = ws.addRow(['TOTAL', `${t.total_units || 0} units (${t.occupied_units || 0} occ / ${t.vacant_units || 0} vac)`, '', '', '', '', t.total_consumption || null, '', t.total_water_charges || null]);
  tr.font = { bold: true, size: 9 };
  for (const ci of [7, 9]) tr.getCell(ci).numFmt = '#,##0.0';
  finishSheet(ws, { headerRowNum: hr.number, landscape: true });
}

function occupiedVacantLists(data) {
  const occupied = [];
  const vacant = [];
  for (const u of (data.units || [])) {
    if (u.status === 'BOOKED') continue;
    if (u.status === 'VACANT') {
      vacant.push({ unit: u.unit_number, rent: Number(u.monthly_rent || 0) });
    } else {
      occupied.push({
        unit: u.unit_number, tenant: u.tenant_name, phone: u.telephone,
        rent: Number(u.monthly_rent || 0), paid: Number(u.rent_paid || 0),
        balance: Number(u.balance || 0), status: u.status,
      });
    }
  }
  return { occupied, vacant };
}

function buildOccupiedSheet(workbook, data) {
  const { occupied } = occupiedVacantLists(data);
  const ws = workbook.addWorksheet('5 Occupied Units', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const lastCol = 'G';
  ws.columns = [{ width: 12 }, { width: 24 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }];
  prepareSheet(workbook, ws, lastCol, 'OCCUPIED UNITS', 'Tenant identification per occupied unit with rent position.');
  const hr = headerRow(ws, ['Unit', 'Tenant Name', 'Phone', 'Monthly Rent', 'Rent Paid', 'Balance', 'Status'], GREEN);
  for (const u of occupied) {
    const r = ws.addRow([u.unit, u.tenant, u.phone, u.rent || null, u.paid || null, u.balance || null, u.status]);
    r.eachCell((c) => { c.font = { size: 9 }; });
    for (const ci of [4, 5, 6]) r.getCell(ci).numFmt = '#,##0';
  }
  if (!occupied.length) ws.addRow(['No occupied units.', '', '', '', '', '', '']);
  finishSheet(ws, { headerRowNum: hr.number, landscape: true });
}

function buildVacantSheet(workbook, data, pack) {
  const { vacant } = occupiedVacantLists(data);
  const ws = workbook.addWorksheet('6 Vacant Units', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const lastCol = 'F';
  ws.columns = [{ width: 12 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 16 }, { width: 30 }];
  prepareSheet(workbook, ws, lastCol, 'VACANT UNITS', 'Vacant units stay in the report. Metered use while vacant (caretaker, cleaning, construction) is shown.');
  const hr = headerRow(ws, ['Unit', 'Monthly Rent', 'Water Use (units)', 'Water Charge', 'Last Reading', 'Usage Note'], GREY);
  const waterRows = [];
  for (const w of (pack.waterByHouse || [])) {
    for (const r of (w.rows || [])) {
      if (r.occupancy === 'Vacant') waterRows.push(r);
    }
  }
  const waterByUnit = {};
  for (const r of waterRows) {
    const key = String(r.unit || '').toUpperCase();
    if (!waterByUnit[key] || Number(r.consumption || 0) > 0) waterByUnit[key] = r;
  }
  for (const u of vacant) {
    const w = waterByUnit[String(u.unit || '').toUpperCase()] || {};
    const r = ws.addRow([
      u.unit, u.rent || null,
      w.consumption ?? null, w.water_charge ?? null,
      w.current_reading ?? null, w.usage_note || '',
    ]);
    r.eachCell((c) => { c.font = { size: 9 }; });
    for (const ci of [2, 3, 4, 5]) r.getCell(ci).numFmt = '#,##0.0';
  }
  if (!vacant.length) ws.addRow(['No vacant units.', '', '', '', '', '']);
  finishSheet(ws, { headerRowNum: hr.number, landscape: true });
}

function buildWorkExpensesSheet(workbook, data, pack) {
  const ws = workbook.addWorksheet('7 Work & Expenses', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const lastCol = 'G';
  ws.columns = [{ width: 16 }, { width: 12 }, { width: 26 }, { width: 30 }, { width: 14 }, { width: 14 }, { width: 16 }];
  prepareSheet(workbook, ws, lastCol, 'WORK ORDERS & EXPENSES', 'Work-order charges plus other recorded property expenses (contractor invoices, materials, repairs).');
  sectionTitle(ws, lastCol, 'WORK ORDER CHARGES', AMBER);
  const hr = headerRow(ws, ['WO No', 'Unit', 'Tenant', 'Problem / Work Done', 'Material', 'Labour', 'Total'], AMBER);
  for (const w of (data.work_summary || [])) {
    const r = ws.addRow([w.wo_number, w.unit, w.tenant, `${w.problem || ''} / ${w.work_done || ''}`, w.material_cost || null, w.labour_cost || null, w.total_cost || null]);
    r.eachCell((c) => { c.font = { size: 9 }; });
    for (const ci of [5, 6, 7]) r.getCell(ci).numFmt = '#,##0';
  }
  if (!(data.work_summary || []).length) ws.addRow(['No work orders this month.', '', '', '', '', '', '']);
  sectionTitle(ws, lastCol, 'OTHER PROPERTY EXPENSES', AMBER);
  headerRow(ws, ['Ref No', 'Date', 'Property', 'Description / Notes', 'Material', 'Labour', 'Total'], AMBER);
  const rows = ((pack.otherExpenses && pack.otherExpenses.rows) || []);
  // Split material/labour unknown per invoice — full amount under Total.
  for (const e of rows) {
    const r = ws.addRow([e.mnt_number, e.date_reported || '', e.property_name || '', e.notes || '', '', '', e.amount || null]);
    r.eachCell((c) => { c.font = { size: 9 }; });
    r.getCell(7).numFmt = '#,##0';
  }
  if (!rows.length) ws.addRow(['No other property expenses recorded this month.', '', '', '', '', '', '']);
  const woTotal = Number((data.summary || {}).total_work_repair_cost || 0);
  const otherTotal = Number((pack.otherExpenses && pack.otherExpenses.total) || 0);
  const tr = ws.addRow(['', '', '', 'TOTALS', '', '', woTotal + otherTotal || null]);
  tr.font = { bold: true, size: 9 };
  tr.getCell(7).numFmt = '#,##0';
  finishSheet(ws, { headerRowNum: hr.number, landscape: true });
}

function buildArrearsSheet(workbook, data) {
  const ws = workbook.addWorksheet('8 Arrears', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const lastCol = 'H';
  ws.columns = [{ width: 12 }, { width: 24 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }];
  prepareSheet(workbook, ws, lastCol, 'ARREARS / OUTSTANDING BALANCES', 'Units with an outstanding balance at month end.');
  const hr = headerRow(ws, ['Unit', 'Tenant', 'Phone', 'Arrears B/F', 'Rent Due', 'Rent Paid', 'Outstanding', 'Status'], RED);
  const rows = (data.units || []).filter((u) => u.status !== 'VACANT' && u.status !== 'BOOKED' && Number(u.balance || 0) > 0);
  for (const u of rows) {
    const r = ws.addRow([u.unit_number, u.tenant_name, u.telephone, u.balance_bf || null, u.rent_due || null, u.rent_paid || null, u.balance || null, u.status]);
    r.eachCell((c) => { c.font = { size: 9 }; });
    for (const ci of [4, 5, 6, 7]) r.getCell(ci).numFmt = '#,##0';
    r.getCell(8).font = { bold: true, color: { argb: RED }, size: 9 };
  }
  if (!rows.length) ws.addRow(['No outstanding balances. All clear. ✓', '', '', '', '', '', '', '']);
  const tot = rows.reduce((s, u) => s + Number(u.balance || 0), 0);
  const tr = ws.addRow(['', '', '', '', '', 'TOTAL', tot || null, '']);
  tr.font = { bold: true, size: 9 };
  tr.getCell(7).numFmt = '#,##0';
  finishSheet(ws, { headerRowNum: hr.number, landscape: true });
}

function buildDepositsSheet(workbook, pack) {
  const ws = workbook.addWorksheet('9 Deposits & Charges', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const lastCol = 'H';
  ws.columns = [{ width: 12 }, { width: 24 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 18 }, { width: 16 }];
  prepareSheet(workbook, ws, lastCol, 'DEPOSITS & OTHER CHARGES', 'Deposit cover per tenant plus pending penalties and agreement balances.');
  const hr = headerRow(ws, ['Unit', 'Tenant', 'Status', 'Deposit Required', 'Deposit Paid', 'Deposit Balance', 'Penalties Pending', 'Agreement O/S'], 'FF7C3AED');
  const rows = ((pack.charges || [])).filter((c) => String(c.status || '') !== 'Vacant');
  for (const c of rows) {
    const r = ws.addRow([c.unit_label, c.tenant_name, c.status, c.deposit_required || null, c.deposit_paid || null, c.deposit_balance || null, c.penalties_pending || null, c.agreement_outstanding || null]);
    r.eachCell((c2) => { c2.font = { size: 9 }; });
    for (const ci of [4, 5, 6, 7, 8]) r.getCell(ci).numFmt = '#,##0';
  }
  if (!rows.length) ws.addRow(['No tenant deposit records.', '', '', '', '', '', '', '']);
  const tDep = rows.reduce((s, c) => s + Number(c.deposit_balance || 0), 0);
  const tPen = rows.reduce((s, c) => s + Number(c.penalties_pending || 0), 0);
  const tAgr = rows.reduce((s, c) => s + Number(c.agreement_outstanding || 0), 0);
  const tr = ws.addRow(['', '', '', '', '', tDep || null, tPen || null, tAgr || null]);
  tr.font = { bold: true, size: 9 };
  for (const ci of [6, 7, 8]) tr.getCell(ci).numFmt = '#,##0';
  finishSheet(ws, { headerRowNum: hr.number, landscape: true });
}

function buildReconciliationSheet(workbook, data, pack, f, monthLabel, propLabel) {
  const ws = workbook.addWorksheet('10 Reconciliation', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
  });
  const lastCol = 'C';
  ws.columns = [{ width: 40 }, { width: 22 }, { width: 34 }];
  prepareSheet(workbook, ws, lastCol, `LANDLORD FINANCIAL RECONCILIATION${propLabel}`, `Period: ${monthLabel}`);
  const line = (label, value, opts = {}) => {
    const r = ws.addRow([label, value ?? null, opts.note || '']);
    r.getCell(1).font = { bold: !!opts.bold, size: 10 };
    r.getCell(2).font = { size: 10, bold: !!opts.bold, color: opts.color ? { argb: opts.color } : undefined };
    if (opts.numFmt !== false) r.getCell(2).numFmt = '#,##0';
    r.getCell(3).font = { size: 8, italic: true, color: { argb: GREY } };
    return r;
  };
  line('Gross collections (all payments received)', f.gross, { bold: true, note: 'Approved payments, billing period' });
  const rateNote = f.commissionRows.length > 1
    ? `blended ${(f.blendedRate * 100).toFixed(1)}% across ${f.commissionRows.length} houses (see Commission sheet)`
    : `rate ${(f.blendedRate * 100).toFixed(1)}% × commissionable rent`;
  line('Less: management commission', -f.commissionTotal, { note: rateNote });
  line('Less: work order / maintenance expenses', -f.woExpenses, { note: 'Work-order charges for the month' });
  line('Less: other property expenses', -f.otherExpenses, { note: 'Contractor invoices, materials, repairs (non-WO)' });
  line('NET AMOUNT PAYABLE TO LANDLORD', f.net, { bold: true, color: GREEN });
  ws.addRow([]);
  sectionTitle(ws, lastCol, 'BASIS OF FIGURES', DARK_BLUE);
  const note = (t) => { const r = ws.addRow([t]); ws.mergeCells(`A${r.number}:${lastCol}${r.number}`); r.getCell(1).font = { size: 8, color: { argb: GREY } }; };
  note('Collections split by the allocation recorded at each payment approval (rent, arrears, deposit, garbage, water, penalties).');
  note('Commission uses each house\u2019s saved rate over collected rent less deposit, garbage and water.');
  note('Water billed comes from recorded water invoices; water collected from payment allocations.');
  note('Vacant units are included throughout; vacant meter use is flagged in the Water and Vacant Units sheets.');
  finishSheet(ws, { landscape: false, maxColWidth: 40 });
}

module.exports = {
  deriveFigures,
  buildExecutiveSummarySheet,
  buildRentPerformanceSheet,
  buildCommissionSheet,
  buildWaterSheet,
  buildOccupiedSheet,
  buildVacantSheet,
  buildWorkExpensesSheet,
  buildArrearsSheet,
  buildDepositsSheet,
  buildReconciliationSheet,
};
