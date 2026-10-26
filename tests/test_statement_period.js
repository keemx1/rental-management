/**
 * Acceptance test — Tenant Statement of Account: automatic data integration
 * for a selected statement period.
 *
 * Verifies (client requirements):
 *  1. Monthly Financial Summary for the SELECTED period, in order:
 *     opening brought forward -> full rent charged -> FULL garbage fee
 *     (not the outstanding balance) -> charges recorded this month ->
 *     total amount due -> payments received THIS month (not all-time) ->
 *     outstanding balance after payments and credits
 *  2. Payment History = only the period's receipts (Date, Receipt No,
 *     M-Pesa ref, Type, Amount); deposits shown but never counted in the
 *     monthly total (dashboard billing logic)
 *  3. Charges/Invoices = actual recorded rows for the period (penalties +
 *     water invoices), one row each, with Invoice No/Date/Description/
 *     Category/Status/Amount; period-appropriate empty-state messages
 *  4. Period continuity: opening(next month) == closing(previous month)
 *  5. Design preserved: letterhead, title, statement no, period, deposit
 *     box, stamp line, payment instructions, footer branding
 *  6. Route: period validation + PDF download with statement number header
 *  7. Frontend: statement period selector served
 *
 * Fixtures: house 999995, tenant ZZSTM-*, removed afterwards.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const { buildTenantStatementHtml } = require('../backend/services/documentStore');

const CODE = 'ZZSTM-01';
const HOUSE = '999995';

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ` -> ${JSON.stringify(extra)}` : '')); }
}

async function cleanup() {
  const stmts = [
    `DELETE FROM preexit_inspections WHERE tenant_code LIKE 'ZZSTM-%'`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZSTM-%'`,
    `DELETE FROM penalties WHERE tenant_code LIKE 'ZZSTM-%'`,
    `DELETE FROM water_invoices WHERE tenant_code LIKE 'ZZSTM-%'`,
    `DELETE FROM documents WHERE tenant_code LIKE 'ZZSTM-%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZSTM-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZSTM-%'`,
    `DELETE FROM houses WHERE paybill_number = $1`,
  ];
  for (const sql of stmts) {
    try { await query(sql, sql.includes('$1') ? [HOUSE] : undefined); } catch (_) {}
  }
}

async function makeToken() {
  const u = (await query(
    `SELECT id, username, role FROM users WHERE is_active IS DISTINCT FROM false
      ORDER BY (role = 'admin') DESC, id LIMIT 1`
  )).rows[0];
  return jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '20m' });
}

async function main() {
  await cleanup();
  await query(
    `INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status)
     VALUES ($1, 'ZZSTM House', 4, 'unknown')`, [HOUSE]
  );
  await store.createTenant({
    tenant_code: CODE, name: 'ZZSTM Tenant One', phone_number: '+254700000801',
    property_name: 'ZZSTM House', house_id: HOUSE,
    rent_amount: 10000, deposit_amount: 5000,
    move_in_date: '2026-08-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  // Full garbage fee 2,000 with 1,500 already paid => outstanding balance would
  // be 500; the statement must show the FULL 2,000 (spec: not just the balance).
  await query(`UPDATE tenants SET garbage_fee_amount = 2000, garbage_fee_paid = 1500, credit_balance = 0, advance_rent_balance = 0 WHERE tenant_code = $1`, [CODE]);

  // ── Records: two rent months + a deposit receipt, penalty, water invoice ──
  const pay = (date, amount, type, receipt, mpesa, status) => query(
    `INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, payment_mode, tenancy_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'M-Pesa',NULL)`,
    [CODE, amount, date, status || 'Approved', type, receipt, mpesa]
  );
  await pay('2026-08-10', 4000, 'rent', 'R-AUG-1', 'MP-AUG-1');   // previous month
  await pay('2026-09-05', 6000, 'rent', 'R-SEP-1', 'MP-SEP-1');   // period payment
  await pay('2026-09-12', 5000, 'deposit', 'R-SEP-D', 'MP-SEP-D'); // deposit in period
  await pay('2026-10-02', 1000, 'rent', 'R-OCT-1', 'MP-OCT-1');   // next month

  await query(
    `INSERT INTO penalties (tenant_code, description, amount, invoice_date, status, category, invoice_number, tenancy_id)
     VALUES ($1, 'Late payment penalty', 500, '2026-09-15', 'Pending', 'penalty', 'INV-SEP-1', NULL)`,
    [CODE]
  );
  await query(
    `INSERT INTO penalties (tenant_code, description, amount, invoice_date, status, category, invoice_number, tenancy_id)
     VALUES ($1, 'Previous-month charge', 300, '2026-08-20', 'Paid', 'other', 'INV-AUG-1', NULL)`,
    [CODE]
  );
  await query(
    `INSERT INTO water_invoices (wtr_number, tenant_code, billing_month, units_used, total_amount, due_date, status, tenancy_id)
     VALUES ('WTR-SEP-1', $1, '2026-09', 7, 700, '2026-09-30', 'Finalized', NULL)`,
    [CODE]
  );

  // ════ 1. Period-scoped summary (September 2026) ═══════════════════════════
  const sep = await store.getTenantStatement(CODE, '2026-09');
  check(!!sep, '1. statement loads');
  const s = sep.summary;
  check(s.period === '2026-09' && s.period_label === 'September 2026',
    `1b. period recorded (${s.period}, ${s.period_label})`);
  // opening = Aug: 10,000 rent + 2,000 garbage + 300 charges - 4,000 paid = 8,300
  check(s.arrears === 8300, `1c. opening brought forward = 8,300 (got ${s.arrears})`, s.arrears);
  check(s.rent_due === 10000, `1d. full rent charged for the month (got ${s.rent_due})`);
  check(s.garbage_fee === 2000, `1e. FULL garbage fee shown, not the 500 balance (got ${s.garbage_fee})`);
  check(s.garbage_fee_balance === 500, `1f. underlying garbage balance still 500 (got ${s.garbage_fee_balance})`);
  check(s.pending_charges === 1200, `1g. charges recorded during the month = 1,200 (penalty 500 + water 700, got ${s.pending_charges})`);
  check(s.total_charges === 21500, `1h. total amount due = 21,500 (got ${s.total_charges})`);
  check(s.total_payments === 6000, `1i. payments THIS month only = 6,000 (got ${s.total_payments})`);
  check(s.outstanding_balance === 15500, `1j. balance after payments & credits = 15,500 (got ${s.outstanding_balance})`);

  // ════ 2. Payment history = the period only ════════════════════════════════
  const receipts = sep.payments.map(p => p.receipt_number);
  check(sep.payments.length === 2, `2. two receipts in the period (got ${sep.payments.length})`);
  check(receipts.includes('R-SEP-1') && receipts.includes('R-SEP-D'), '2b. September receipts present');
  check(!receipts.includes('R-AUG-1') && !receipts.includes('R-OCT-1'),
    '2c. other months NOT mixed into the period', receipts);
  const rentRow = sep.payments.find(p => p.receipt_number === 'R-SEP-1');
  check(rentRow && rentRow.mpesa_reference === 'MP-SEP-1' && Number(rentRow.amount) === 6000,
    '2d. Date/Receipt/M-Pesa/Type/Amount fields intact');
  check(s.payments_all_time === 16000, `2e. all-time total kept separately (got ${s.payments_all_time})`);

  // ════ 3. Charges / Invoices = recorded period rows, no duplicates ═════════
  check(sep.invoices.length === 2, `3. two recorded charges in the period (got ${sep.invoices.length})`);
  const pen = sep.invoices.find(i => i.invoice_number === 'INV-SEP-1');
  const wtr = sep.invoices.find(i => i.invoice_number === 'WTR-SEP-1');
  check(pen && pen.category === 'penalty' && pen.status === 'Pending' && pen.amount === 500
    && pen.description === 'Late payment penalty',
    '3b. penalty row shows recorded fields', pen);
  check(wtr && wtr.category === 'water' && wtr.amount === 700, '3c. water invoice row included', wtr);
  check(!sep.invoices.some(i => i.invoice_number === 'INV-AUG-1'),
    '3d. previous-month charge NOT mixed into the period');

  // ════ 4. Period continuity + defaults ═════════════════════════════════════
  const oct = await store.getTenantStatement(CODE, '2026-10');
  check(oct.summary.arrears === 15500,
    `4. October opens where September closed (15,500, got ${oct.summary.arrears})`);
  const cur = await store.getTenantStatement(CODE);
  check(cur.summary.period === new Date().toISOString().slice(0, 7),
    `4b. default period = current month (${cur.summary.period})`);
  const nov = await store.getTenantStatement(CODE, '2026-11');
  check(nov.invoices.length === 0 && nov.payments.length === 0,
    '4c. empty period -> empty collections');

  // ════ 5. Rendered HTML: labels, period scoping, design preserved ══════════
  const htmlSep = buildTenantStatementHtml(sep, 'STMT-TEST-1', '2026-10-26');
  [
    'TENANT STATEMENT OF ACCOUNT',
    '1. Opening arrears / balance brought forward from previous months',
    '2. Rent charged for the month',
    '3. Full garbage collection fee applicable to this month',
    '4. Outstanding charges recorded during this month (if any)',
    '5. Total amount due (opening arrears + applicable charges)',
    '6. Total payments received during this month',
    '7. Outstanding balance after payments and credits',
    'STATEMENT NO:',
    'STATEMENT PERIOD:',
    'September 2026',
    'DEPOSIT',
    'Payment History',
    'Charges / Invoices',
    'GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS',
    'Find a Home. Leave the Management to Us',
    '{{GEHM_STAMP_LINE}}',
  ].forEach((needle, i) => check(htmlSep.includes(needle), `5.${i} html contains: ${needle.slice(0, 58)}`));

  check(htmlSep.includes('KES 8,300') && htmlSep.includes('KES 21,500')
    && htmlSep.includes('KES 6,000') && htmlSep.includes('KES 15,500'),
    '5.10 summary values formatted (8,300 / 21,500 / 6,000 / 15,500)');
  check(htmlSep.includes('R-SEP-1') && htmlSep.includes('MP-SEP-1') && htmlSep.includes('INV-SEP-1')
    && htmlSep.includes('WTR-SEP-1'),
    '5.11 period records rendered (receipt, mpesa, invoice, water number)');
  check(!htmlSep.includes('R-AUG-1') && !htmlSep.includes('R-OCT-1') && !htmlSep.includes('INV-AUG-1'),
    '5.12 NO all-time contamination in the rendered statement');
  check(!htmlSep.includes('all time'), '5.13 "(all time)" wording removed');
  check((htmlSep.match(/INV-SEP-1/g) || []).length === 1, '5.14 charge appears exactly once (no duplicate rows)');
  check((htmlSep.match(/>R-SEP-1</g) || []).length === 1, '5.15 payment appears exactly once (no duplicate rows)');
  check(!/discussion between management and the tenant/i.test(htmlSep), '5.16 no forbidden phrase');

  const htmlNov = buildTenantStatementHtml(nov, 'STMT-TEST-2', '2026-10-26');
  check(htmlNov.includes('No charges / invoices recorded for November 2026.'),
    '5.17 period-specific empty state for charges');
  check(htmlNov.includes('No payments recorded for November 2026.'),
    '5.18 period-specific empty state for payments');

  // ════ 6. Route: validation + PDF download ═════════════════════════════════
  const app = express();
  app.use(express.json());
  app.use('/api/statements', require('../backend/routes/statements'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const PORT = srv.address().port;
  const token = await makeToken();
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    let res = await fetch(`http://127.0.0.1:${PORT}/api/statements/generate`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ tenant_id: CODE, mode: 'download', period: '2026-09' }),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    check(res.status === 200 && buf.slice(0, 5).toString() === '%PDF-',
      `6. statement PDF downloads (HTTP ${res.status})`);
    check(!!res.headers.get('X-Statement-Number'), '6b. statement number header present');
    check((res.headers.get('Content-Disposition') || '').toLowerCase().includes('.pdf'),
      '6c. PDF filename set');

    res = await fetch(`http://127.0.0.1:${PORT}/api/statements/generate`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ tenant_id: CODE, mode: 'download', period: '2026-99' }),
    });
    check(res.status === 400, `6d. invalid period rejected (HTTP ${res.status})`);

    // ════ 7. Frontend ═══════════════════════════════════════════════════════
    const idx = await (await fetch('http://127.0.0.1:3003/')).text();
    check(idx.includes('id="statement-period"') && /app\.js\?v=\d+/.test(idx),
      '7. period selector + versioned assets served');
    const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js')).text();
    check(appJs.includes('statement-period') && appJs.includes('downloadStatement(tenantId, period)'),
      '7b. frontend passes the selected period');
    const apiJs = await (await fetch('http://127.0.0.1:3003/js/api.js')).text();
    check(apiJs.includes('generateStatement(tenant_id, mode, period)'),
      '7c. api client accepts the period');
  } finally {
    srv.close();
  }
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n===============================\nRESULT: ${pass} passed, ${fail} failed`);
    if (failures.length) console.log('FAILURES:\n - ' + failures.join('\n - '));
    process.exit(fail ? 1 : 0);
  })
  .catch(async (e) => {
    console.error(e);
    try { await cleanup(); } catch (_) {}
    process.exit(1);
  });
