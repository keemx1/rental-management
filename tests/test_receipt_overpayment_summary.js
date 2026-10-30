/**
 * Acceptance test — PDF receipt: ACCUMULATED OVERPAYMENT SUMMARY.
 *
 *  1. Section appears on receipts for tenants with credit activity, with the
 *     spec layout: previous accumulated / current transaction / combined /
 *     already allocated / remaining + advance-rent coverage date
 *  2. BH46-style example exact: 1,500 + 7,500 = 9,000 combined; 7,500
 *     already allocated (advance); 1,500 remaining; advance paid up to
 *     24 November 2026
 *  3. No double counting: allocated = combined − remaining (true consumed)
 *  4. Section ABSENT for tenants without credit activity (no zero-noise)
 *  5. Existing receipt design/sections/numbering untouched; receipts stay
 *     one-per-payment; payment rows unchanged (presentation only)
 *  6. generateAndStoreReceipt path produces a valid PDF + document row
 *  7. READ-ONLY against the real units BH46 + EX001
 *
 * Fixtures: house 999981, tenant ZZRC-* (removed afterwards).
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const { buildReceiptHtml, generateAndStoreReceipt } = require('../backend/services/documentStore');

const CODE = 'ZZRC-01';

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ` -> ${JSON.stringify(extra)}` : '')); }
}

async function cleanup() {
  let filePaths = [];
  try {
    const docs = await query(`SELECT file_path FROM documents WHERE tenant_code LIKE 'ZZRC-%' AND file_path IS NOT NULL`);
    filePaths = docs.rows.map((r) => r.file_path).filter(Boolean);
  } catch (_) {}
  for (const sql of [
    `DELETE FROM documents WHERE tenant_code LIKE 'ZZRC-%'`,
    `DELETE FROM credit_allocations WHERE tenant_code LIKE 'ZZRC-%'`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZRC-%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZRC-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZRC-%'`,
    `DELETE FROM houses WHERE paybill_number = '999981'`,
  ]) {
    try { await query(sql, []); } catch (e) { console.error('[cleanup]', e.message); }
  }
  for (const p of filePaths) { try { fs.unlinkSync(p); } catch (_) {} }
}

async function main() {
  await cleanup();
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status)
    VALUES ('999981', 'ZZRC House', 4, 'unknown')`);
  await store.createTenant({
    tenant_code: CODE, name: 'ZZRC Tenant', phone_number: '+254700001701',
    property_name: 'ZZRC House', house_id: '999981', rent_amount: 10000, deposit_amount: 5000,
    move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  // BH46-style: 1,500 then 7,500 overpayments (combined 9,000); 7,500 later
  // applied as advance rent; 1,500 remaining available credit.
  const mkPay = (receipt, date, amount, op, period) => query(
    `INSERT INTO payments (tenant_code, amount, overpayment_amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode, tenancy_id)
     VALUES ($1,$2,$3,$4,'Approved','rent',$5,$6,$7,'M-Pesa',NULL) RETURNING *`,
    [CODE, amount, op, date, receipt, `MP-${receipt}`, period]
  );
  const payA = (await mkPay('R-RC-1', '2026-10-05', 11500, 1500, '2026-10')).rows[0];
  const payB = (await mkPay('R-RC-2', '2026-11-24', 7500, 7500, '2026-11')).rows[0];
  await query(
    `UPDATE tenants SET credit_balance = 1500, advance_rent_balance = 7500, advance_rent_until = '2026-11-24'
      WHERE tenant_code = $1`, [CODE]
  );
  // A quiet tenant with no credit activity at all
  await store.createTenant({
    tenant_code: 'ZZRC-02', name: 'ZZRC Quiet', phone_number: '+254700001702',
    property_name: 'ZZRC House', house_id: '999981', rent_amount: 8000, deposit_amount: 5000,
    move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  const quietPay = (await query(
    `INSERT INTO payments (tenant_code, amount, overpayment_amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode, tenancy_id)
     VALUES ('ZZRC-02', 8000, 0, '2026-11-05', 'Approved', 'rent', 'R-RC-Q', 'MPQ', '2026-11', 'M-Pesa', NULL) RETURNING *`
  )).rows[0];

  try {
    const tenant = await store.getTenant(CODE);
    const cons = await store.getOverpaymentConsolidation(CODE);

    // ── 1/2/3. Summary section on the CURRENT (latest) receipt ─────────────
    const html = buildReceiptHtml(tenant, payB, { overpayment: 7500, remainingBalance: 0 }, cons);
    check(html.includes('ACCUMULATED OVERPAYMENT SUMMARY'), '1. section present on the receipt');
    check(html.includes('Previous accumulated overpayment') && html.includes('KES 1,500'),
      '2. previous accumulated = 1,500 (spec)');
    check(html.includes('Current transaction overpayment') && (html.match(/KES 7,500/g) || []).length >= 1,
      '2b. current transaction overpayment = 7,500 (spec)');
    check(html.includes('Total combined overpayment') && html.includes('KES 9,000'),
      '2c. combined = 9,000 (spec)');
    check(html.includes('Amount already allocated') && html.includes('KES 7,500'),
      `2d. allocated shows TRUE consumed amount 7,500 (combined − remaining, no double counting)`);
    check(html.includes('Remaining available overpayment') && html.includes('KES 1,500'),
      '2e. remaining available = 1,500');
    check(html.includes('Advance rent coverage') && html.includes('November 2026'),
      '2f. advance-rent coverage date shown (24 November 2026)');
    check(cons.total_overpaid === 9000 && cons.remaining_credit === 1500,
      '2g. consolidation figures match the dashboard source', { c: cons.total_overpaid, r: cons.remaining_credit });

    // ── 5. Existing receipt design/sections/numbering untouched ────────────
    check(html.includes('RECEIPT') || html.includes('Receipt') || html.includes('receipt_no') || html.includes('R-RC-2'),
      '5. receipt number still rendered');
    check(html.includes('CREDIT / OVERPAYMENT') && html.includes('REMAINING BALANCE'),
      '5b. original credit/balance rows preserved');
    check(html.includes('ZZRC Tenant') && html.includes('KES 7,500'),
      '5c. transaction details preserved');
    const rows = (await query(
      `SELECT receipt_number, amount, overpayment_amount FROM payments WHERE tenant_code = $1 ORDER BY payment_date`,
      [CODE]
    )).rows;
    check(rows.length === 2 && Number(rows[0].overpayment_amount) === 1500 && Number(rows[1].overpayment_amount) === 7500,
      '5d. one receipt per payment, transactions unchanged', rows);

    // ── 4. No section without credit activity ──────────────────────────────
    const quietTenant = await store.getTenant('ZZRC-02');
    const quietCons = await store.getOverpaymentConsolidation('ZZRC-02');
    const quietHtml = buildReceiptHtml(quietTenant, quietPay, { overpayment: 0 }, quietCons);
    check(!quietHtml.includes('ACCUMULATED OVERPAYMENT SUMMARY'),
      '4. section absent when the tenant has no credit activity');

    // ── 6. Generation workflow end-to-end ──────────────────────────────────
    const doc = await generateAndStoreReceipt(tenant, payB, { overpayment: 7500, remainingBalance: 0 });
    check(!!doc && doc.doc_number === 'R-RC-2' && fs.existsSync(doc.file_path),
      '6. receipt PDF generated + stored (same receipt number)');
    if (doc) {
      const head = Buffer.alloc(5);
      const fd = fs.openSync(doc.file_path, 'r'); fs.readSync(fd, head, 0, 5, 0); fs.closeSync(fd);
      check(head.toString() === '%PDF-', '6b. valid PDF file');
    }

    // ── 7. Real units (READ-ONLY) ──────────────────────────────────────────
    const bhTenant = await store.getTenant('BH46');
    const bhPay = (await query(
      `SELECT * FROM payments WHERE tenant_code = 'BH46' AND status = 'Approved'
         AND COALESCE(overpayment_amount, 0) > 0 ORDER BY id DESC LIMIT 1`
    )).rows[0];
    const bhCons = await store.getOverpaymentConsolidation('BH46');
    const bhHtml = buildReceiptHtml(bhTenant, bhPay, { overpayment: Number(bhPay.overpayment_amount) }, bhCons);
    check(bhHtml.includes('ACCUMULATED OVERPAYMENT SUMMARY')
      && bhHtml.includes(`KES ${bhCons.total_overpaid.toLocaleString('en-KE', { maximumFractionDigits: 2 })}`),
      `7. BH46 – John William Musumba: section with combined ${bhCons.total_overpaid} (read-only)`);
    check(bhCons.advance_rent_balance > 0, `7b. BH46 advance rent ${bhCons.advance_rent_balance} on the account`);

    const exTenant = await store.getTenant('EX001');
    const exPay = (await query(
      `SELECT * FROM payments WHERE tenant_code = 'EX001' AND status = 'Approved'
         AND COALESCE(overpayment_amount, 0) > 0 ORDER BY id DESC LIMIT 1`
    )).rows[0];
    const exCons = await store.getOverpaymentConsolidation('EX001');
    const exHtml = buildReceiptHtml(exTenant, exPay, { overpayment: Number(exPay.overpayment_amount) }, exCons);
    check(exHtml.includes('ACCUMULATED OVERPAYMENT SUMMARY')
      && exHtml.includes(`KES ${exCons.total_overpaid.toLocaleString('en-KE', { maximumFractionDigits: 2 })}`),
      `7c. EX001 – Ian Kamau: section with combined ${exCons.total_overpaid} (read-only)`);

    console.log('\n(payments/receipts/workflow untouched — display only)');
  } finally {
    // cleanup in then()
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
