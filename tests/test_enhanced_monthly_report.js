/**
 * Acceptance test — Enhanced Monthly Report (occupancy accuracy, live Excel
 * formulas, totals from records, PDF twin).
 *
 * Client requirements:
 *  1. Executive Summary occupancy accuracy: occupied = ALL non-Vacant unit
 *     records (never silently undercounted), vacant = Vacant records,
 *     Total = Occupied + Vacant + Booked; a configured-vs-records mismatch is
 *     surfaced as a warning row instead of being silently forced.
 *  2. Excel live formulas on the unit table: Rent Due = SUM(Dn:Hn),
 *     Balance = In − Jn, totals row = SUM over the DYNAMIC data range (per
 *     property — ranges differ when the property has fewer rows).
 *  3. Deposit / water totals on the totals row come from the unit records
 *     (SUM of the deposit / water columns).
 *  4. PDF twin of the same report (landscape, valid PDF) from the same data.
 *
 * Fixtures: houses 999979 / 999980, tenants ZZEX*, fully removed afterwards.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const store = require('../backend/storage/store');
const { query } = require('../backend/config/database');

const HOUSE_A = '999979';
const HOUSE_B = '999980';
const PERIOD = '2026-10';
const BASE = 'http://127.0.0.1:3003/api';

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra ? ` -> ${JSON.stringify(extra)}` : '')); }
}

async function cleanup() {
  const stmts = [
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZEX%'`,
    `DELETE FROM penalties WHERE tenant_code LIKE 'ZZEX%'`,
    `DELETE FROM water_invoices WHERE tenant_code LIKE 'ZZEX%'`,
    `DELETE FROM maintenance_charges WHERE unit_code LIKE 'ZZEX%'`,
    `DELETE FROM work_orders WHERE house_paybill_number IN ($1, $2)`,
    `DELETE FROM deposit_refunds WHERE tenant_code LIKE 'ZZEX%'`,
    `DELETE FROM exit_invoices WHERE tenant_code LIKE 'ZZEX%'`,
    `DELETE FROM tenancy_archive WHERE tenant_code LIKE 'ZZEX%'`,
    `DELETE FROM documents WHERE tenant_code LIKE 'ZZEX%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZEX%'`,
    `DELETE FROM future_tenancies WHERE house_paybill IN ($1, $2)`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZEX%'`,
    `DELETE FROM houses WHERE paybill_number IN ($1, $2)`,
  ];
  for (const sql of stmts) {
    // Postgres rejects bind params on statements without $n placeholders —
    // only supply them where the SQL actually uses them.
    try { await query(sql, sql.includes('$1') ? [HOUSE_A, HOUSE_B] : undefined); } catch (_) {}
  }
}

async function makeToken() {
  const u = (await query(
    `SELECT id, username, role FROM users WHERE is_active IS DISTINCT FROM false
      ORDER BY (role = 'admin') DESC, id LIMIT 1`
  )).rows[0];
  return jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '15m' });
}

async function getBytes(token, url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, headers: res.headers };
}

/** Read an Executive Summary KPI: label in col A, value in col B. */
function kpiValue(ws, label) {
  let found = null;
  ws.eachRow({ includeEmpty: false }, (row) => {
    const l = String(row.getCell(1).value || '').trim();
    if (l === label) found = row.getCell(2).value;
  });
  return found;
}

function formulaOf(cell) {
  const v = cell && cell.value;
  return v && typeof v === 'object' && v.formula ? String(v.formula) : null;
}
function resultOf(cell) {
  const v = cell && cell.value;
  if (v && typeof v === 'object' && v.formula) {
    // ExcelJS omits cached zero results on serialization — a formula without
    // a result key recalculates to 0 when opened in Excel.
    return 'result' in v ? Number(v.result) : 0;
  }
  return Number(v);
}

/** Locate a data row in the Enhanced sheet by unit label (col A). */
function findUnitRow(ws, unitLabel) {
  let rowNum = null;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (String(row.getCell(1).value || '').trim() === unitLabel) rowNum = n;
  });
  return rowNum;
}

function findTotalsRow(ws) {
  let rowNum = null;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (String(row.getCell(2).value || '').trim() === 'TOTALS') rowNum = n;
  });
  return rowNum;
}

async function main() {
  await cleanup();

  // ── Fixtures ──────────────────────────────────────────────────────────────
  // House A: 4 unit records but configured total_units = 6 → the mismatch
  // must be surfaced (occupied never silently forced to the configured count).
  await query(
    `INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status)
     VALUES ($1, 'ZZ Enhanced A', 6, 'unknown')`,
    [HOUSE_A]
  );
  // House B: records match configured (3 = 3) → no mismatch warning.
  await query(
    `INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status)
     VALUES ($1, 'ZZ Enhanced B', 3, 'unknown')`,
    [HOUSE_B]
  );

  const mk = async (code, house, name, rent, status, water, arrears, unitLabel) => {
    const t = await store.createTenant({
      tenant_code: code, name, phone_number: '+254700000411',
      property_name: house === HOUSE_A ? 'ZZ Enhanced A' : 'ZZ Enhanced B',
      house_id: house, rent_amount: rent, garbage_fee_amount: 0,
      water_charge_amount: water || 0, deposit_amount: 5000,
      move_in_date: '2026-09-01', rent_due_date: '2026-10-05', status,
    });
    if (t && t.error) throw new Error(`createTenant ${code}: ${t.error}`);
    if (unitLabel) await query(`UPDATE tenants SET unit_label = $1 WHERE tenant_code = $2`, [unitLabel, code]);
    if (arrears) await query(`UPDATE tenants SET arrears = $1 WHERE tenant_code = $2`, [arrears, code]);
    return t;
  };

  await mk('ZZEXA-1', HOUSE_A, 'ZZEX Occupied Paid', 10000, 'Active', 0, 0, 'A1');
  await mk('ZZEXA-2', HOUSE_A, 'ZZEX Occupied Partial', 8000, 'Active', 0, 0, 'A2');
  await mk('ZZEXA-3', HOUSE_A, 'ZZEX Occupied Water', 7000, 'Active', 1500, 0, 'A3');
  await mk('ZZEXA-4', HOUSE_A, 'ZZEX Vacant Unit', 6000, 'Vacant', 0, 0, 'A4');
  await mk('ZZEXB-1', HOUSE_B, 'ZZEX B Paid With Deposit', 5000, 'Active', 0, 0, 'B1');
  await mk('ZZEXB-2', HOUSE_B, 'ZZEX B Unpaid', 4000, 'Active', 0, 0, 'B2');
  // Multi-payment tenant: 12 genuine payments in the period (complete-history
  // requirement — every receipt/ref/date must be accessible, none hidden).
  await mk('ZZEXB-3', HOUSE_B, 'ZZEX B Many Payments', 12000, 'Active', 0, 0, 'B3');

  // Payments (payment_date must fall inside the report month — the enhanced
  // report selects payments by payment_date, not billing_period).
  const pay = async (tenant, amount, type, ref, payDate) => {
    const p = await store.createPayment({
      tenant_id: tenant, amount, payment_type: type, status: 'Pending',
      mpesa_reference: ref, client_txn_id: `zzex-${ref}`, payment_mode: 'M-Pesa', source: 'manual',
    });
    if (p && p.error) throw new Error(`payment ${ref}: ${p.error}`);
    const a = await store.approvePayment(p.id);
    if (!a || a.error) throw new Error(`approve ${ref}: ${a && a.error}`);
    if (payDate) await query(`UPDATE payments SET payment_date = $1 WHERE id = $2`, [payDate, p.id]);
    return p.id;
  };
  await pay('ZZEXA-1', 10000, 'rent', 'ZZE1', '2026-10-06');
  await pay('ZZEXA-2', 4000, 'rent', 'ZZE2', '2026-10-07');
  await pay('ZZEXB-1', 5000, 'deposit', 'ZZE3', '2026-10-08');
  await pay('ZZEXB-1', 5000, 'rent', 'ZZE4', '2026-10-08');
  // 12 payments of 1,000 each for ZZEXB-3 across the month (10th–21st Oct).
  for (let i = 1; i <= 12; i++) {
    const day = String(9 + i).padStart(2, '0');
    await pay('ZZEXB-3', 1000, 'rent', `ZZM${i}`, `2026-10-${day}`);
  }
  await store.createPenalty({ tenant_code: 'ZZEXA-2', description: 'ZZEX late fee', amount: 500, invoice_date: '2026-10-10' });
  // The report selects penalties by created_at — backdate into the month.
  await query(`UPDATE penalties SET created_at = '2026-10-10 10:00:00' WHERE tenant_code LIKE 'ZZEX%'`);

  // ── 1. Occupancy accuracy at the source (never forced) ────────────────────
  const repA = await store.buildEnhancedMonthlyReport(PERIOD, HOUSE_A);
  check(repA.summary.occupied_units === 3,
    `1.1 house A occupied = all non-Vacant records (3) got ${repA.summary.occupied_units}`);
  check(repA.summary.vacant_units === 1,
    `1.2 house A vacant = Vacant records (1) got ${repA.summary.vacant_units}`);
  check(repA.summary.total_units === 4,
    `1.3 house A total = unit records (4), NOT configured count got ${repA.summary.total_units}`);
  check(Number(repA.summary.configured_units) === 6,
    `1.4 house A configured_units exposed for the mismatch warning (6) got ${repA.summary.configured_units}`);
  check(repA.summary.occupied_units + repA.summary.vacant_units + repA.summary.booked_units === repA.summary.total_units,
    `1.5 Total = Occupied + Vacant + Booked (${repA.summary.occupied_units}+${repA.summary.vacant_units}+${repA.summary.booked_units}=${repA.summary.total_units})`);

  const repB = await store.buildEnhancedMonthlyReport(PERIOD, HOUSE_B);
  check(repB.summary.occupied_units === 3 && repB.summary.vacant_units === 0 && repB.summary.total_units === 3,
    `1.6 house B occupancy 3/0/3 got ${repB.summary.occupied_units}/${repB.summary.vacant_units}/${repB.summary.total_units}`);
  check(Number(repB.summary.configured_units) === 3,
    '1.7 house B configured matches records (no warning expected)');

  const unitA = (repA.units || []).find((u) => u.unit_number === 'A1');
  check(!!unitA && unitA.status === 'CLEARED' && Number(unitA.rent_due) === 10000 && Number(unitA.balance) === 0,
    `1.8 A1 CLEARED rent_due 10000 balance 0 got ${unitA && JSON.stringify({ s: unitA.status, d: unitA.rent_due, b: unitA.balance })}`);
  const unitA2 = (repA.units || []).find((u) => u.unit_number === 'A2');
  check(!!unitA2 && unitA2.status === 'PARTIALLY PAID' && Number(unitA2.rent_due) === 8500 && Number(unitA2.balance) === 4500,
    `1.9 A2 penalty included (rent_due 8500, balance 4500) got ${unitA2 && JSON.stringify({ s: unitA2.status, d: unitA2.rent_due, b: unitA2.balance })}`);
  const unitA3 = (repA.units || []).find((u) => u.unit_number === 'A3');
  check(!!unitA3 && Number(unitA3.water) === 1500 && Number(unitA3.rent_due) === 8500,
    `1.10 A3 water charge flows into rent_due (water 1500, due 8500) got ${unitA3 && JSON.stringify({ w: unitA3.water, d: unitA3.rent_due })}`);
  const unitA4 = (repA.units || []).find((u) => u.unit_number === 'A4');
  check(!!unitA4 && unitA4.status === 'VACANT',
    `1.11 A4 reported VACANT got ${unitA4 && unitA4.status}`);
  const unitB1 = (repB.units || []).find((u) => u.unit_number === 'B1');
  check(!!unitB1 && Number(unitB1.deposit) === 5000 && Number(unitB1.rent_due) === 5000,
    `1.12 B1 deposit 5000 recorded (deposit col from records) got ${unitB1 && JSON.stringify({ d: unitB1.deposit, due: unitB1.rent_due })}`);
  // Deposit money is EXCLUDED from rent paid (B1 paid 5000 deposit + 5000 rent;
  // rent_paid must be the 5000 charge-applied, not 10000).
  check(!!unitB1 && Number(unitB1.rent_paid) === 5000,
    `1.12b deposit money excluded from rent paid (B1 rent_paid 5000 not 10000) got ${unitB1 && unitB1.rent_paid}`);

  // Multi-payment tenant B3: all 12 payments present with dates/receipts/refs.
  const unitB3 = (repB.units || []).find((u) => u.unit_number === 'B3');
  check(!!unitB3 && unitB3.payment_count === 12,
    `1.13 B3 retains ALL 12 payments (complete history) got ${unitB3 && unitB3.payment_count}`);
  check(!!unitB3 && Number(unitB3.rent_paid) === 12000 && Number(unitB3.balance) === 0 && unitB3.status === 'CLEARED',
    `1.14 B3 12x1000 = 12000 paid, cleared got ${unitB3 && JSON.stringify({ paid: unitB3.rent_paid, bal: unitB3.balance, s: unitB3.status })}`);
  check(!!unitB3 && unitB3.payments.every((p) => p.receipt_number && p.transaction_ref && p.payment_date),
    `1.15 B3 every payment has receipt + ref + date got ${unitB3 && unitB3.payments.filter((p) => p.receipt_number && p.transaction_ref && p.payment_date).length}/12`);
  const b3dates = new Set(unitB3.payments.map((p) => String(p.payment_date).slice(0, 10)));
  check(b3dates.size === 12,
    `1.16 B3 payments span 12 distinct original dates (not report date) got ${b3dates.size}`);

  // ── 2. Excel: Executive Summary occupancy + formulas + totals ─────────────
  const token = await makeToken();

  const exA = await getBytes(token, `${BASE}/monthly-reports/${PERIOD}/enhanced/excel`, { house_paybill: HOUSE_A });
  check(exA.status === 200 && exA.buf.slice(0, 2).toString() === 'PK',
    `2.1 house A enhanced Excel returned (HTTP ${exA.status})`);
  const wbA = new ExcelJS.Workbook();
  await wbA.xlsx.load(exA.buf);
  const execA = wbA.getWorksheet('1 Executive Summary');
  const mainA = wbA.getWorksheet('Enhanced Monthly Report');
  check(!!execA && !!mainA, `2.2 Executive Summary + Enhanced sheets present (${wbA.worksheets.length} sheets total)`);
  check(wbA.worksheets.length >= 10, `2.3 all landlord detail sheets present (${wbA.worksheets.length})`);

  if (execA) {
    check(Number(kpiValue(execA, 'Total units (records)')) === 4,
      `2.4 exec Total units (records) = 4 got ${kpiValue(execA, 'Total units (records)')}`);
    check(Number(kpiValue(execA, 'Occupied units')) === 3,
      `2.5 exec Occupied units = 3 (all non-Vacant) got ${kpiValue(execA, 'Occupied units')}`);
    check(Number(kpiValue(execA, 'Vacant units')) === 1,
      `2.6 exec Vacant units = 1 got ${kpiValue(execA, 'Vacant units')}`);
    check(Number(kpiValue(execA, 'Booked / reserved units')) === 0,
      `2.7 exec Booked / reserved units = 0 got ${kpiValue(execA, 'Booked / reserved units')}`);
    check(Math.abs(Number(kpiValue(execA, 'Occupancy % (occupied ÷ total records)')) - 0.75) < 0.001,
      `2.8 exec Occupancy % = 3/4 = 75% got ${kpiValue(execA, 'Occupancy % (occupied ÷ total records)')}`);
    const note = kpiValue(execA, '⚠ Configured units vs records');
    check(typeof note === 'string' && note.includes('6 configured') && note.includes('4 unit records'),
      `2.9 exec surfaces configured-vs-records mismatch (6 vs 4) got ${note}`);
  }

  if (mainA) {
    const ps = mainA.pageSetup || {};
    check(ps.paperSize === 9 && ps.orientation === 'landscape' && ps.fitToPage === true,
      `2.10 Enhanced sheet A4 landscape fit-to-page (${JSON.stringify({ p: ps.paperSize, o: ps.orientation, f: ps.fitToPage })})`);
    check(ps.printTitlesRow === '1:3',
      `2.11 Enhanced sheet repeats report title rows 1:3 (got ${ps.printTitlesRow})`);

    const rA1 = findUnitRow(mainA, 'A1');
    check(rA1 === 7, `2.12 first data row is row 7 (header layout) got ${rA1}`);
    if (rA1) {
      check(formulaOf(mainA.getRow(rA1).getCell(9)) === `SUM(D${rA1}:H${rA1})`,
        `2.13 Rent Due formula =SUM(D${rA1}:H${rA1}) got ${formulaOf(mainA.getRow(rA1).getCell(9))}`);
      check(Math.abs(resultOf(mainA.getRow(rA1).getCell(9)) - 10000) < 0.01,
        `2.14 Rent Due cached result 10000 got ${resultOf(mainA.getRow(rA1).getCell(9))}`);
      check(formulaOf(mainA.getRow(rA1).getCell(14)) === `I${rA1}-J${rA1}`,
        `2.15 Balance formula =I${rA1}-J${rA1} got ${formulaOf(mainA.getRow(rA1).getCell(14))}`);
      check(Math.abs(resultOf(mainA.getRow(rA1).getCell(14)) - 0) < 0.01,
        `2.16 Balance cached result 0 got ${resultOf(mainA.getRow(rA1).getCell(14))}`);
    }

    const rA3 = findUnitRow(mainA, 'A3');
    if (rA3) {
      check(Number(mainA.getRow(rA3).getCell(5).value) === 1500,
        `2.17 A3 water cell shows 1500 got ${mainA.getRow(rA3).getCell(5).value}`);
      check(Math.abs(resultOf(mainA.getRow(rA3).getCell(9)) - 8500) < 0.01,
        `2.18 A3 Rent Due 8500 (rent+water) got ${resultOf(mainA.getRow(rA3).getCell(9))}`);
    }

    const tA = findTotalsRow(mainA);
    check(!!tA, `2.19 totals row found (${tA})`);
    if (tA) {
      const lastRow = tA - 1; // totals row sits right after the last unit row
      check(formulaOf(mainA.getRow(tA).getCell(5)) === `SUM(E7:E${lastRow})`,
        `2.20 water totals =SUM(E7:E${lastRow}) dynamic range got ${formulaOf(mainA.getRow(tA).getCell(5))}`);
      check(Math.abs(resultOf(mainA.getRow(tA).getCell(5)) - 1500) < 0.01,
        `2.21 water total from records = 1500 got ${resultOf(mainA.getRow(tA).getCell(5))}`);
      check(formulaOf(mainA.getRow(tA).getCell(4)) === `SUM(D7:D${lastRow})`,
        `2.22 deposit totals =SUM(D7:D${lastRow}) got ${formulaOf(mainA.getRow(tA).getCell(4))}`);
      check(Math.abs(resultOf(mainA.getRow(tA).getCell(4)) - 0) < 0.01,
        `2.23 house A deposit total 0 (no deposit rows) got ${resultOf(mainA.getRow(tA).getCell(4))}`);
      check(formulaOf(mainA.getRow(tA).getCell(9)) === `SUM(I7:I${lastRow})`,
        `2.24 rent due totals =SUM(I7:I${lastRow}) got ${formulaOf(mainA.getRow(tA).getCell(9))}`);
      check(Math.abs(resultOf(mainA.getRow(tA).getCell(9)) - 27000) < 0.01,
        `2.25 rent due total 27,000 (10000+8500+8500+0) got ${resultOf(mainA.getRow(tA).getCell(9))}`);
      check(Math.abs(resultOf(mainA.getRow(tA).getCell(10)) - 14000) < 0.01,
        `2.26 rent paid total 14,000 got ${resultOf(mainA.getRow(tA).getCell(10))}`);
      check(Math.abs(resultOf(mainA.getRow(tA).getCell(14)) - 13000) < 0.01,
        `2.27 balance total 13,000 got ${resultOf(mainA.getRow(tA).getCell(14))}`);
    }

    // Auto-formatting: wrap + reasonable widths (squeezed columns fixed)
    let wrapCells = 0;
    mainA.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (c) => { if (c.alignment && c.alignment.wrapText) wrapCells++; });
    });
    check(wrapCells > 0, `2.28 text wrapping enabled (${wrapCells} cells)`);
    const widths = (mainA.columns || []).map((c) => Number(c.width));
    check(widths.length > 0 && widths.every((w) => isFinite(w) && w >= 5 && w <= 41),
      `2.29 column widths auto-fit within [5,41] (${widths.join(',')})`);
  }

  // House B: DYNAMIC per-property ranges (3 rows → SUM(D7:D9))
  const exB = await getBytes(token, `${BASE}/monthly-reports/${PERIOD}/enhanced/excel`, { house_paybill: HOUSE_B });
  check(exB.status === 200, `2.30 house B enhanced Excel returned (HTTP ${exB.status})`);
  const wbB = new ExcelJS.Workbook();
  await wbB.xlsx.load(exB.buf);
  const execB = wbB.getWorksheet('1 Executive Summary');
  const mainB = wbB.getWorksheet('Enhanced Monthly Report');
  if (execB) {
    check(Number(kpiValue(execB, 'Occupied units')) === 3 && Number(kpiValue(execB, 'Vacant units')) === 0,
      `2.31 exec B occupancy 3/0 got ${kpiValue(execB, 'Occupied units')}/${kpiValue(execB, 'Vacant units')}`);
    check(kpiValue(execB, '⚠ Configured units vs records') == null,
      `2.32 exec B has NO mismatch warning (records match configured) got ${kpiValue(execB, '⚠ Configured units vs records')}`);
  }
  if (mainB) {
    const tB = findTotalsRow(mainB);
    check(!!tB && tB === 10, `2.33 house B totals row right after 3 data rows (row 10) got ${tB}`);
    if (tB) {
      check(formulaOf(mainB.getRow(tB).getCell(4)) === 'SUM(D7:D9)',
        `2.34 house B deposit totals use DYNAMIC range SUM(D7:D9) got ${formulaOf(mainB.getRow(tB).getCell(4))}`);
      check(Math.abs(resultOf(mainB.getRow(tB).getCell(4)) - 5000) < 0.01,
        `2.35 house B deposit total from records = 5000 got ${resultOf(mainB.getRow(tB).getCell(4))}`);
    }
    const rB1 = findUnitRow(mainB, 'B1');
    check(rB1 === 7 && formulaOf(mainB.getRow(rB1).getCell(9)) === 'SUM(D7:H7)',
      `2.36 B1 Rent Due formula SUM(D7:H7) got ${rB1 && formulaOf(mainB.getRow(rB1).getCell(9))}`);

    // ── Payment History sheet + drill-down + SUMIFS (complete history) ────
    const phB = wbB.getWorksheet('Payment History');
    check(!!phB, `5.1 Payment History worksheet present (${wbB.worksheets.length} sheets)`);
    if (phB) {
      // Every fixture payment in period appears (B1:2, B2:0, B3:12 = 14 rows)
      let phRows = 0, b3Rows = 0, hasAllRefs = true, distinctDates = new Set();
      phB.eachRow({ includeEmpty: false }, (row, n) => {
        if (n < 5) return; // skip title/header
        const unit = String(row.getCell(1).value || '').trim();
        const ref = String(row.getCell(5).value || '').trim();
        if (!unit) return;
        phRows++;
        if (unit === 'B3') { b3Rows++; if (!ref) hasAllRefs = false; distinctDates.add(String(row.getCell(3).value || '').slice(0, 10)); }
      });
      check(phRows === 14, `5.2 Payment History lists all 14 B-house payments got ${phRows}`);
      check(b3Rows === 12, `5.3 B3 all 12 payments listed got ${b3Rows}`);
      check(hasAllRefs, '5.4 every B3 payment row carries a transaction reference');
      check(distinctDates.size === 12, `5.5 B3 payments show 12 distinct original dates got ${distinctDates.size}`);
      // Charge-applied column (M) sums to the consolidated rent paid
      let chargeSum = 0;
      phB.eachRow({ includeEmpty: false }, (row, n) => {
        if (n < 5) return;
        if (String(row.getCell(1).value || '').trim() === 'B3') chargeSum += Number(row.getCell(13).value || 0);
      });
      check(Math.abs(chargeSum - 12000) < 0.01, `5.6 B3 charge-applied column sums to 12000 got ${chargeSum}`);
    }
    // Drill-down hyperlink beside consolidated Rent Paid (col P)
    const rB3 = findUnitRow(mainB, 'B3');
    if (rB3) {
      const linkCell = mainB.getRow(rB3).getCell(16); // P
      const lv = linkCell.value;
      check(lv && typeof lv === 'object' && lv.hyperlink && /Payment History/.test(lv.hyperlink),
        `5.7 B3 Rent Paid has clickable drill-down to Payment History got ${JSON.stringify(lv)}`);
      check(/12 payment/.test((lv && lv.text) || ''),
        `5.8 drill-down label shows payment count got ${lv && lv.text}`);
      // Rent Paid (col J) is a transaction-based SUMIFS over Payment History
      check(formulaOf(mainB.getRow(rB3).getCell(10)) === `SUMIFS('Payment History'!$M:$M,'Payment History'!$A:$A,$A${rB3})`,
        `5.9 B3 Rent Paid = SUMIFS over Payment History got ${formulaOf(mainB.getRow(rB3).getCell(10))}`);
      check(Math.abs(resultOf(mainB.getRow(rB3).getCell(10)) - 12000) < 0.01,
        `5.10 B3 Rent Paid SUMIFS result 12000 got ${resultOf(mainB.getRow(rB3).getCell(10))}`);
    }
  }

  // All-properties run: totals still reconcile across both houses
  const exAll = await getBytes(token, `${BASE}/monthly-reports/${PERIOD}/enhanced/excel`, {});
  check(exAll.status === 200, `2.37 all-properties enhanced Excel returned (HTTP ${exAll.status})`);
  const wbAll = new ExcelJS.Workbook();
  await wbAll.xlsx.load(exAll.buf);
  const mainAll = wbAll.getWorksheet('Enhanced Monthly Report');
  const execAll = wbAll.getWorksheet('1 Executive Summary');
  if (execAll) {
    // All-properties includes the whole portfolio — assert internal
    // consistency (Total = Occupied + Vacant + Booked), not absolute counts.
    const tot = Number(kpiValue(execAll, 'Total units (records)'));
    const occ = Number(kpiValue(execAll, 'Occupied units'));
    const vac = Number(kpiValue(execAll, 'Vacant units'));
    const bkd = Number(kpiValue(execAll, 'Booked / reserved units') || 0);
    check(occ + vac + bkd === tot && tot > 0,
      `2.38 exec all-properties Total = O+V+B (${occ}+${vac}+${bkd}=${tot})`);
    check(occ >= 5 && vac >= 1,
      `2.39 exec all-properties includes fixture units (occupied >= 5, vacant >= 1) got ${occ}/${vac}`);
  } else check(false, '2.38 exec all-properties sheet present');
  if (mainAll) {
    const tAll = findTotalsRow(mainAll);
    if (tAll) {
      const lastAll = tAll - 1;
      check(formulaOf(mainAll.getRow(tAll).getCell(4)) === `SUM(D7:D${lastAll})`,
        `2.40 all-properties deposit totals dynamic SUM(D7:D${lastAll}) got ${formulaOf(mainAll.getRow(tAll).getCell(4))}`);
      check(resultOf(mainAll.getRow(tAll).getCell(4)) >= 5000,
        `2.41 all-properties deposit total includes fixture 5000 (got ${resultOf(mainAll.getRow(tAll).getCell(4))})`);
      check(resultOf(mainAll.getRow(tAll).getCell(5)) >= 1500,
        `2.42 all-properties water total includes fixture 1500 (got ${resultOf(mainAll.getRow(tAll).getCell(5))})`);
    }
    const rAllB1 = findUnitRow(mainAll, 'B1');
    // (row order across properties: A rows then B rows — B1 must come after A4)
    const rAllA4 = findUnitRow(mainAll, 'A4');
    check(!!rAllB1 && !!rAllA4 && rAllA4 < rAllB1,
      `2.43 both properties in one sheet, A rows before B rows (A4=${rAllA4}, B1=${rAllB1})`);
    if (rAllB1) {
      check(formulaOf(mainAll.getRow(rAllB1).getCell(9)) === `SUM(D${rAllB1}:H${rAllB1})`,
        `2.44 B1 formula uses its OWN row (SUM(D${rAllB1}:H${rAllB1})) got ${formulaOf(mainAll.getRow(rAllB1).getCell(9))}`);
    }
  }

  // ── 3. PDF twin ───────────────────────────────────────────────────────────
  const pdfA = await getBytes(token, `${BASE}/monthly-reports/${PERIOD}/enhanced/pdf`, { house_paybill: HOUSE_A });
  check(pdfA.status === 200 && pdfA.buf.slice(0, 5).toString() === '%PDF-',
    `3.1 house A enhanced PDF returned (HTTP ${pdfA.status}, magic ${pdfA.buf.slice(0, 5).toString()}) ${pdfA.status !== 200 ? pdfA.buf.slice(0, 200).toString() : ''}`);
  if (pdfA.status === 200 && pdfA.buf.slice(0, 5).toString() === '%PDF-') {
    check(pdfA.buf.length > 4000, `3.2 non-trivial PDF size (${pdfA.buf.length} bytes)`);
    const m = pdfA.buf.toString('latin1').match(/MediaBox\s*\[\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)\s*\]/);
    if (m) {
      const w = parseFloat(m[1]), h = parseFloat(m[2]);
      check(w > h, `3.3 PDF is A4 landscape for the wide table (${w}x${h})`);
    } else check(false, '3.3 PDF MediaBox found');
    const disp = pdfA.headers.get('Content-Disposition') || '';
    check(disp.includes('.pdf') && disp.includes('attachment'),
      `3.4 PDF served as attachment (${disp})`);
  }

  const pdfAll = await getBytes(token, `${BASE}/monthly-reports/${PERIOD}/enhanced/pdf`, {});
  check(pdfAll.status === 200 && pdfAll.buf.slice(0, 5).toString() === '%PDF-',
    `3.5 all-properties enhanced PDF returned (HTTP ${pdfAll.status})`);

  // ── 4. Frontend: PDF button + API wired ───────────────────────────────────
  const idx = await (await fetch('http://127.0.0.1:3003/')).text();
  check(idx.includes('btn-download-enhanced-pdf'), '4.1 index.html serves the Download PDF button');
  check(/app\.js\?v=\d+/.test(idx), '4.2 versioned app.js loader served');
  const apiJs = await (await fetch('http://127.0.0.1:3003/js/api.js')).text();
  check(apiJs.includes('downloadEnhancedMonthlyReportPdf'), '4.3 api.js exposes downloadEnhancedMonthlyReportPdf');
  const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js?v=87')).text();
  check(appJs.includes('btn-download-enhanced-pdf') && appJs.includes('v87'),
    '4.4 app.js wires the PDF button (v87 served)');

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await cleanup();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('FAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
