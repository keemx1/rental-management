/**
 * Acceptance test: "GEHPM REPORTS — PROFESSIONAL DISPLAY AND READABILITY"
 *
 * Generates sample reports over HTTP (authenticated with a crafted JWT),
 * then verifies, WITHOUT any manual editing:
 *   - Excel: page setup (A4, fit-to-width, orientation), auto-fit column
 *     widths, text wrapping, header styling, frozen heading panes, repeating
 *     print headings (Print_Titles — checked separately via PowerShell),
 *     money number formats, and totals that reconcile with their columns.
 *   - PDF: valid file, A4 landscape for wide reports.
 *   - Frontend: cyber-table report styles + print stylesheet served.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const { query } = require('../backend/config/database');

const BASE = 'http://127.0.0.1:3003/api';
const OUT = path.join(__dirname, '../scratch/report_samples');

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label); }
}

async function makeToken() {
  const u = (await query(
    `SELECT id, username, role FROM users
      WHERE is_active IS DISTINCT FROM false
      ORDER BY (role = 'admin') DESC, id LIMIT 1`
  )).rows[0];
  return jwt.sign({ sub: u.id, username: u.username, role: u.role },
    process.env.JWT_SECRET, { expiresIn: '20m' });
}

async function getBytes(token, url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, headers: res.headers };
}

function num(v) { return typeof v === 'number' ? v : Number(v || 0); }

/** Core per-sheet structural checks shared by every workbook. */
function checkSheetStructure(sheet, label) {
  const ps = sheet.pageSetup || {};
  check(ps.paperSize === 9, `${label}: A4 page setup (paperSize=9), got ${ps.paperSize}`);
  check(ps.fitToPage === true && ps.fitToWidth === 1, `${label}: fit-to-width print layout`);
  check(ps.orientation === 'landscape' || ps.orientation === 'portrait', `${label}: orientation set (${ps.orientation})`);

  const widths = (sheet.columns || []).map((c) => Number(c.width));
  check(widths.length > 0 && widths.every((w) => isFinite(w) && w >= 5 && w <= 41),
    `${label}: column widths auto-fit to content within [5,41] (${widths.join(',')})`);

  let wrapCells = 0;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.alignment && cell.alignment.wrapText) wrapCells++;
    });
  });
  check(wrapCells > 0, `${label}: text wrapping enabled (${wrapCells} wrapped cells)`);
}

/** Totals row must equal the sum of its data rows (calculation integrity).
 *  opts.dedupeByCol1 — vacancy rows repeat house-level figures per vacant
 *  unit; the grand total counts each house once. */
function checkTotalsReconcile(sheet, label, totalMatcher, colIndexes, opts = {}) {
  let totalRowNum = null;
  sheet.eachRow({ includeEmpty: false }, (row, n) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (totalMatcher(String(cell.value))) totalRowNum = n;
    });
  });
  if (!totalRowNum) { check(false, `${label}: totals row found`); return; }
  const seen = new Set();
  for (const ci of colIndexes) {
    let sum = 0;
    seen.clear();
    for (let r = 1; r < totalRowNum; r++) {
      const row = sheet.getRow(r);
      const labelCell = String(row.getCell(1).value || '') + String(row.getCell(2).value || '');
      if (/TOTAL/i.test(labelCell)) continue;
      if (opts.dedupeByCol1) {
        const key = String(row.getCell(1).value || '').trim();
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const n = Number(row.getCell(ci).value);
      if (isFinite(n)) sum += n; // skip header/title/text cells
    }
    const total = num(sheet.getRow(totalRowNum).getCell(ci).value);
    check(Math.abs(sum - total) < 0.01,
      `${label}: column ${ci} totals reconcile (sum=${sum}, total=${total})`);
  }
}

async function checkWorkbook(buf, filename, checks) {
  fs.writeFileSync(path.join(OUT, filename), buf);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  console.log(`\n=== ${filename} (${wb.worksheets.length} sheet(s)) ===`);
  for (const ws of wb.worksheets) {
    checkSheetStructure(ws, `${filename} / "${ws.name}"`);
  }
  if (checks) await checks(wb);
  return wb;
}

function assertFrozen(ws, label, expectedY) {
  const v = (ws.views || [])[0];
  if (!v || v.state !== 'frozen') { check(false, `${label}: header pane frozen (got ${JSON.stringify(v)})`); return; }
  if (expectedY != null) check(v.ySplit === expectedY, `${label}: frozen under header row ${expectedY} (ySplit=${v.ySplit})`);
  else check(v.ySplit >= 1 && v.ySplit <= 6, `${label}: frozen near top (ySplit=${v.ySplit})`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const token = await makeToken();
  console.log('report sample output:', OUT);

  /* ── 1. Outstanding Balances ─────────────────────────────────────────── */
  {
    const r = await getBytes(token, `${BASE}/reports/outstanding-balances`, { method: 'POST', body: { mode: 'download' } });
    check(r.status === 200 && r.buf.slice(0, 2).toString() === 'PK', `outstanding-balances: xlsx returned (HTTP ${r.status})`);
    if (r.status === 200) {
      await checkWorkbook(r.buf, 'Outstanding_Balances.xlsx', async (wb) => {
        const ws = wb.getWorksheet('Outstanding Balances');
        assertFrozen(ws, 'Outstanding', 4);
        check(ws.getRow(4).font && ws.getRow(4).font.bold === true, 'Outstanding: header row bold');
        check(Number(ws.getRow(4).height) >= 16, `Outstanding: header row height (${ws.getRow(4).height})`);
        const fmt = ws.getRow(5).getCell(4).numFmt;
        check(typeof fmt === 'string' && fmt.includes('#,##0'), `Outstanding: money number format (got ${fmt})`);
        checkTotalsReconcile(ws, 'Outstanding', (s) => /^TOTAL$/i.test(s.trim()), [4, 5, 6, 7, 8, 9, 10]);
      });
    }
  }

  /* ── 2. Unpaid Units ────────────────────────────────────────────────── */
  {
    const r = await getBytes(token, `${BASE}/reports/unpaid-units`, { method: 'POST', body: { mode: 'download' } });
    check(r.status === 200 && r.buf.slice(0, 2).toString() === 'PK', `unpaid-units: xlsx returned (HTTP ${r.status})`);
    if (r.status === 200) {
      await checkWorkbook(r.buf, 'Unpaid_Units.xlsx', async (wb) => {
        const ws = wb.getWorksheet('Unpaid Units');
        assertFrozen(ws, 'Unpaid', 4);
        checkTotalsReconcile(ws, 'Unpaid', (s) => /^TOTAL$/i.test(s.trim()), [4]);
      });
    }
  }

  /* ── 3. Deposits & New Tenants (was completely unformatted before) ──── */
  {
    const r = await getBytes(token, `${BASE}/reports/deposits-new-tenants`, { method: 'POST', body: { mode: 'download' } });
    check(r.status === 200 && r.buf.slice(0, 2).toString() === 'PK', `deposits-new-tenants: xlsx returned (HTTP ${r.status})`);
    if (r.status === 200) {
      await checkWorkbook(r.buf, 'Deposits_New_Tenants.xlsx', async (wb) => {
        const ws = wb.getWorksheet('Deposits & New Tenants');
        assertFrozen(ws, 'Deposits', 4);
        check(ws.pageSetup.orientation === 'landscape', 'Deposits: landscape print setup');
      });
    }
  }

  /* ── 4. Vacancy Report (was unformatted) ────────────────────────────── */
  {
    const r = await getBytes(token, `${BASE}/houses/send-vacant-report`, { method: 'POST', body: { mode: 'download' } });
    check(r.status === 200 && r.buf.slice(0, 2).toString() === 'PK', `vacant-report: xlsx returned (HTTP ${r.status})`);
    if (r.status === 200) {
      await checkWorkbook(r.buf, 'Vacancy_Report.xlsx', async (wb) => {
        const ws = wb.getWorksheet('Vacant Houses Report');
        assertFrozen(ws, 'Vacancy', 4);
        checkTotalsReconcile(ws, 'Vacancy', (s) => /GRAND TOTAL/i.test(s), [3, 4, 5], { dedupeByCol1: true });
      });
    }
  }

  /* ── 5. Payments Report (was unformatted; title merged A:E on 6 cols) ─ */
  {
    const r = await getBytes(token, `${BASE}/payments/send-report`, { method: 'POST', body: { mode: 'download' } });
    check(r.status === 200 && r.buf.slice(0, 2).toString() === 'PK', `payments send-report: xlsx returned (HTTP ${r.status})`);
    if (r.status === 200) {
      await checkWorkbook(r.buf, 'Payments_Report.xlsx', async (wb) => {
        const ws = wb.getWorksheet('Payments Report');
        assertFrozen(ws, 'Payments', 4);
        check(ws.pageSetup.orientation === 'landscape', 'Payments: landscape print setup');
        checkTotalsReconcile(ws, 'Payments', (s) => /TOTAL PAID/i.test(s), [3]);
      });
    }
  }

  /* ── 6. Collection Report (2 sheets) ────────────────────────────────── */
  {
    const r = await getBytes(token, `${BASE}/payments/collection-report?mode=download&billing_month=2026-10`);
    check(r.status === 200 && r.buf.slice(0, 2).toString() === 'PK', `collection-report: xlsx returned (HTTP ${r.status})`);
    if (r.status === 200) {
      await checkWorkbook(r.buf, 'Collection_Report.xlsx', async (wb) => {
        const ws1 = wb.getWorksheet('Collection Report');
        const ws2 = wb.getWorksheet('Payment Transactions');
        assertFrozen(ws1, 'Collection');
        assertFrozen(ws2, 'Transactions', 2);
        // Row 6 = header, row 7 = first data row (moneyCols applied to data)
        const fmt = ws1.getRow(7).getCell(3).numFmt;
        check(typeof fmt === 'string' && fmt.includes('#,##0'), `Collection: money format (got ${fmt})`);
      });
    }
  }

  /* ── 7. Standard Monthly Report ─────────────────────────────────────── */
  {
    const r = await getBytes(token, `${BASE}/monthly-reports/2026-10/excel`, { method: 'POST', body: {} });
    check(r.status === 200 && r.buf.slice(0, 2).toString() === 'PK', `monthly standard: xlsx returned (HTTP ${r.status})`);
    if (r.status === 200) {
      await checkWorkbook(r.buf, 'Monthly_Report.xlsx', async (wb) => {
        const ws = wb.getWorksheet('Monthly Report');
        check(ws.pageSetup.orientation === 'landscape', 'Monthly: landscape');
        check(ws.pageSetup.printTitlesRow === '1:3', `Monthly: repeats logo+title+period on pages (got ${ws.pageSetup.printTitlesRow})`);
        const v = (ws.views || [])[0];
        check(!v || v.state !== 'frozen', 'Monthly: no bogus freeze under mid-sheet sections');
      });
    }
  }

  /* ── 8. Enhanced Monthly Report (11 sheets) ─────────────────────────── */
  {
    const r = await getBytes(token, `${BASE}/monthly-reports/2026-10/enhanced/excel`, { method: 'POST', body: {} });
    check(r.status === 200 && r.buf.slice(0, 2).toString() === 'PK', `monthly enhanced: xlsx returned (HTTP ${r.status})`);
    if (r.status === 200) {
      await checkWorkbook(r.buf, 'Enhanced_Monthly_Report.xlsx', async (wb) => {
        check(wb.worksheets.length >= 10, `Enhanced: all landlord sheets present (${wb.worksheets.length})`);
        const main = wb.getWorksheet('Enhanced Monthly Report');
        check(main.pageSetup.printTitlesRow === '1:3', `Enhanced: repeating report title rows (got ${main.pageSetup.printTitlesRow})`);
        // Money number formats on the unit table (col 7 = monthly rent)
        let moneyFmt = 0;
        main.eachRow({ includeEmpty: false }, (row) => {
          for (let ci = 4; ci <= 14; ci++) {
            const c = row.getCell(ci);
            if (typeof c.value === 'number' && Math.abs(c.value) >= 1000 && c.numFmt) moneyFmt++;
          }
        });
        check(moneyFmt > 0, `Enhanced: money cells carry thousands format (${moneyFmt} cells)`);
        // Landlord sheets: colored headers preserved + print titles set
        const rent = wb.getWorksheet('2 Rent Performance');
        if (rent) {
          const hdrRow = (() => {
            for (let n = 5; n <= 12; n++) {
              const f = rent.getRow(n).getCell(1).fill;
              if (f && f.type === 'pattern') return n;
            }
            return null;
          })();
          check(hdrRow !== null, 'Rent Performance: colored header row preserved');
          check(typeof rent.pageSetup.printTitlesRow === 'string' && rent.pageSetup.printTitlesRow.includes(String(hdrRow)),
            `Rent Performance: repeats its own column headings (printTitles=${rent.pageSetup.printTitlesRow}, hdr=${hdrRow})`);
        } else {
          check(false, 'Rent Performance: sheet present');
        }
      });
    }
  }

  /* ── 9. Water Bill Report PDF (wide → landscape) ────────────────────── */
  async function pdfCheck(url, body, filename, expectLandscape) {
    let r = await getBytes(token, url, { method: 'POST', body });
    if (r.status !== 200 || r.buf.slice(0, 5).toString() !== '%PDF-') {
      r = await getBytes(token, url, { method: 'POST', body: {} });
    }
    const isPdf = r.buf.slice(0, 5).toString() === '%PDF-';
    check(r.status === 200 && isPdf, `${filename}: PDF returned (HTTP ${r.status}) ${isPdf ? '' : r.buf.slice(0, 200).toString()}`);
    if (!isPdf) return;
    fs.writeFileSync(path.join(OUT, filename), r.buf);
    const text = r.buf.toString('latin1');
    const m = text.match(/MediaBox\s*\[\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)\s*\]/);
    if (!m) { check(false, `${filename}: MediaBox found`); return; }
    const w = parseFloat(m[1]), h = parseFloat(m[2]);
    const landscape = w > h;
    if (expectLandscape) check(landscape, `${filename}: A4 landscape for wide report (${w}x${h})`);
    else check(!landscape, `${filename}: A4 portrait (${w}x${h})`);
    check(r.buf.length > 4000, `${filename}: non-trivial file size (${r.buf.length} bytes)`);
  }

  const house = (await query(
    `SELECT paybill_number FROM houses WHERE paybill_number IS NOT NULL AND TRIM(paybill_number) <> '' LIMIT 1`
  )).rows[0];
  await pdfCheck(`${BASE}/monthly-reports/water/pdf`,
    { house_paybill: house ? house.paybill_number : null, billing_month: '2026-10' },
    'Water_Bill_Report.pdf', true);
  await pdfCheck(`${BASE}/management-expenses-report/pdf`, { month: '2026-10' }, 'Management_Expenses_Report.pdf', true);

  /* ── 10. Frontend: report table styles + print stylesheet served ────── */
  const css = await (await fetch('http://127.0.0.1:3003/css/rental-theme.css')).text();
  check(css.includes('.cyber-table'), 'frontend: professional .cyber-table report styles served');
  check(css.includes('@media print') && css.includes('.print-active'), 'frontend: print stylesheet (report-only printing) served');
  check(css.includes('overflow-wrap: anywhere'), 'frontend: long names wrap instead of overlapping');
  const idx = await (await fetch('http://127.0.0.1:3003/')).text();
  check(/app\.js\?v=\d+/.test(idx), 'frontend: versioned app.js loader served');
  check((idx.match(/cyber-table/g) || []).length >= 20, `frontend: all report tables use cyber-table (${(idx.match(/cyber-table/g) || []).length})`);
  const sw = await (await fetch('http://127.0.0.1:3003/sw.js')).text();
  check(/gutenberg-v\d+-irmanage/.test(sw), 'frontend: service worker cache stamp present');

  console.log(`\n===============================\nRESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log('FAILURES:\n - ' + failures.join('\n - '));
}

main().then(() => process.exit(fail ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
