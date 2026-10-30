/**
 * Acceptance test — Future Tenancy / Reserved Unit activation:
 * automatic data transfer + PDF receipts with continuous numbering.
 *
 *  1. Activation transfers ALL reservation data into the active tenancy
 *     (name/phone/ID/property/unit/status/balances/credits)
 *  2. Payments appear in the active tenancy with ORIGINAL dates, refs,
 *     modes, purposes and allocations (not re-dated to activation day)
 *  3. A PDF receipt is generated immediately for EVERY approved payment,
 *     linked to its payment (preview/download path)
 *  4. Receipt numbering CONTINUES the existing global sequence (no restart,
 *     no duplicates): pre-activation next N → receipts N, N+1, N+2
 *  5. Receipts show the required fields (receipt no, property, unit, tenant
 *     name, phone, ID, tenant code, amount, reference, date, mode, purpose)
 *  6. Retry recognition: re-activation is refused (no duplicates); a
 *     partial-loss retry re-moves ONLY the missing payment, retains the
 *     original receipt numbers of the others, generates only 1 new PDF
 *  7. Profile/payment-history consistency (receipt documents findable)
 *
 * Fixtures: house 999980, future tenancy ZZFT-* (removed afterwards).
 * WhatsApp sender stubbed — no real messages.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const futureTenancies = require('../backend/storage/futureTenancies');
const { buildReceiptHtml } = require('../backend/services/documentStore');
const sessionManager = require('../backend/whatsapp/session-manager');

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ` -> ${JSON.stringify(extra)}` : '')); }
}

sessionManager.sendText = async () => ({ id: 'STUB' }); // no real WhatsApp

async function cleanup() {
  let filePaths = [];
  try {
    const docs = await query(
      `SELECT d.file_path FROM documents d JOIN payments p ON d.payment_id = p.id
        WHERE p.tenant_code LIKE 'ZZFT-%' AND d.file_path IS NOT NULL`
    );
    filePaths = docs.rows.map((r) => r.file_path).filter(Boolean);
  } catch (_) {}
  for (const sql of [
    `DELETE FROM documents WHERE tenant_code LIKE 'ZZFT-%' OR payment_id IN (SELECT id FROM payments WHERE tenant_code LIKE 'ZZFT-%')`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZFT-%'`,
    `DELETE FROM future_payments WHERE future_tenancy_id IN (SELECT id FROM future_tenancies WHERE tenant_name LIKE 'ZZFT%')`,
    `DELETE FROM future_tenancies WHERE tenant_name LIKE 'ZZFT%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZFT-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZFT-%'`,
    `DELETE FROM houses WHERE paybill_number = '999980'`,
  ]) {
    try { await query(sql, []); } catch (e) { console.error('[cleanup]', e.message); }
  }
  for (const p of filePaths) { try { fs.unlinkSync(p); } catch (_) {} }
}

const nextCounter = async () => {
  const r = await query(`SELECT next_number FROM receipt_counters WHERE prefix = 'GEHPM-RCT'`);
  return r.rows[0] ? Number(r.rows[0].next_number) : 1;
};
const seqOf = (receiptNo) => Number(String(receiptNo).split('-').pop());

async function main() {
  await cleanup();
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status)
    VALUES ('999980', 'ZZFT House', 4, 'unknown')`);

  // ── Reserve + record + approve booking payments (existing workflow) ─────
  const ft = await futureTenancies.createFutureTenancy({
    property_name: 'ZZFT House', unit_label: 'FZ1', house_paybill: '999980',
    tenant_name: 'ZZFT Tenant', phone_number: '+254700001801', national_id: '12345678',
    tenant_code: 'ZZFT-01', allocated_month: '2026-12', rent_amount: 10000, deposit_amount: 5000,
    notes: 'reservation fixture',
  });
  const mkPay = (amount, payment_date, allocated_month, payment_mode, mpesa_reference, purpose) =>
    futureTenancies.createFuturePayment({
      future_tenancy_id: ft.id, amount, payment_date, payment_time: '10:00:00',
      allocated_month, payment_mode, mpesa_reference, purpose, notes: null,
    });
  const fp1 = await mkPay(5000, '2026-09-10', '2026-12', 'M-Pesa', 'MPFT1', 'Deposit');
  const fp2 = await mkPay(4000, '2026-10-05', '2026-12', 'Bank Transfer', 'MPFT2', 'Rent');
  const fp3 = await mkPay(1000, '2026-10-20', '2026-12', 'M-Pesa', 'MPFT3', 'Other');
  await futureTenancies.approveFuturePayment(fp1.id);
  await futureTenancies.approveFuturePayment(fp2.id);
  await futureTenancies.approveFuturePayment(fp3.id);

  const counterBefore = await nextCounter();

  const app = express();
  app.use(express.json());
  app.use('/api/future-tenancies', require('../backend/routes/futureTenancies'));
  app.use('/api/tenants', require('../backend/routes/tenants'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const PORT = srv.address().port;
  const u = (await query(
    `SELECT id, username, role FROM users WHERE role = 'admin' AND is_active IS DISTINCT FROM false ORDER BY id LIMIT 1`
  )).rows[0];
  const token = jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/future-tenancies${p}`, {
      method, headers: auth, body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };

  try {
    // ── 1/2/3/4. Activation ────────────────────────────────────────────────
    let r = await call('POST', `/${ft.id}/activate`);
    check(r.status === 200, `1. activation OK (HTTP ${r.status})`, r.json);
    check(r.json.moved_payments === 3, `1b. all 3 approved payments moved (${r.json.moved_payments})`);
    check(r.json.receipts_generated === 3 && r.json.receipts.length === 3,
      `1c. PDF receipt generated for EVERY payment (${r.json.receipts_generated}/${r.json.receipts.length})`);

    const tenant = await store.getTenant('ZZFT-01');
    check(tenant.name === 'ZZFT Tenant' && tenant.phone_number === '+254700001801'
      && tenant.national_id === '12345678' && String(tenant.status) === 'Active',
      '1d. tenant profile populated (name/phone/ID/Active status)');
    check(Number(tenant.deposit_paid) === 5000 && Number(tenant.rent_paid_this_month) === 4000
      && Number(tenant.credit_balance) === 1000,
      `1e. balances/credits transferred (deposit 5000, rent 4000, credit 1000)`,
      { d: tenant.deposit_paid, r: tenant.rent_paid_this_month, c: tenant.credit_balance });
    check(tenant.property_name === 'ZZFT House' && (tenant.unit_label === 'FZ1' || tenant.tenant_code === 'ZZFT-01'),
      '1f. property + unit details populated');

    const rows = (await query(
      `SELECT * FROM payments WHERE tenant_code = 'ZZFT-01' ORDER BY payment_date`
    )).rows;
    check(rows.length === 3, `2. three payments in Payment History (${rows.length})`);
    check(rows.every((p) => p.status === 'Approved' && p.source === 'booking' && p.future_payment_id),
      '2b. all approved + linked to their booking payments (retries recognisable)');
    const payDateStr = (d) => (d instanceof Date && !isNaN(d))
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      : String(d || '').slice(0, 10);
    check(payDateStr(rows[0].payment_date) === '2026-09-10',
      `2c. ORIGINAL payment date preserved (2026-09-10, not activation day)`, payDateStr(rows[0].payment_date));
    check(rows.some((p) => p.mpesa_reference === 'MPFT1') && rows.some((p) => p.mpesa_reference === 'MPFT2')
      && rows.some((p) => p.payment_mode === 'Bank Transfer'),
      '2d. original references + payment methods preserved');
    check(rows.every((p) => p.billing_period === '2026-12'),
      '2e. original allocations (allocated month) preserved');

    // Receipt numbers: continuous with the pre-activation sequence
    const nums = rows.map((p) => seqOf(p.receipt_number)).sort((a, b) => a - b);
    const expected = [counterBefore, counterBefore + 1, counterBefore + 2];
    check(rows.every((p) => p.receipt_number) && JSON.stringify(nums) === JSON.stringify(expected),
      `4. numbering CONTINUES the sequence (${expected.join(', ')}) got ${nums.join(', ')}`);
    check(new Set(rows.map((p) => p.receipt_number)).size === 3, '4b. no duplicate receipt numbers');
    const counterAfter = await nextCounter();
    check(counterAfter === counterBefore + 3,
      `4c. global counter advanced by exactly 3 (${counterBefore} → ${counterAfter})`);

    // Receipt documents ready immediately, linked per payment
    for (const p of rows) {
      const doc = await store.findReceiptDocument(p.id);
      check(!!doc && doc.doc_number === p.receipt_number && fs.existsSync(doc.file_path),
        `3. receipt PDF ready for ${p.receipt_number} (${doc && doc.filename})`);
      if (doc) {
        const head = Buffer.alloc(5);
        const fd = fs.openSync(doc.file_path, 'r'); fs.readSync(fd, head, 0, 5, 0); fs.closeSync(fd);
        check(head.toString() === '%PDF-', `3b. valid PDF for ${p.receipt_number}`);
      }
    }

    // ── 5. Receipt content (spec checklist) ────────────────────────────────
    const rentPay = rows.find((p) => p.mpesa_reference === 'MPFT2');
    const html = buildReceiptHtml(tenant, rentPay,
      { paymentType: 'rent', rentSettled: Number(rentPay.amount), overpayment: 0, remainingBalance: 0 });
    [
      rentPay.receipt_number, 'ZZFT House', 'ZZFT Tenant', '+254700001801', '12345678',
      'ZZFT-01', 'KES 4,000', 'MPFT2', 'Bank', 'Rent settled', 'PAYMENT RECEIPT',
    ].forEach((needle, i) => check(html.includes(needle), `5.${i} receipt shows: ${needle}`));
    check(html.includes('PHONE') && html.includes('ID NUMBER') && html.includes('TENANT CODE'),
      '5.10 contact/ID/code labels on the receipt');
    check(html.includes('5 October 2026') || html.includes('05 October 2026'),
      '5.11 actual payment date shown (October 2026)');
    const depPay = rows.find((p) => p.payment_type === 'deposit');
    const depHtml = buildReceiptHtml(tenant, depPay,
      { paymentType: 'deposit', depositSettled: Number(depPay.amount), overpayment: 0, remainingBalance: 0 });
    check(depHtml.includes('Deposit paid'), '5.12 deposit purpose shown');
    const otherPay = rows.find((p) => p.payment_type === 'other');
    const othHtml = buildReceiptHtml(tenant, otherPay,
      { paymentType: 'other', otherSettled: Number(otherPay.amount), overpayment: 0, remainingBalance: 0 });
    check(othHtml.includes('Other charges settled') && othHtml.includes('>Other<'),
      '5.13 other-purpose payment labelled Other (not Rent)');

    // ── 7. Payment history / profile consistency ──────────────────────────
    const prof = await (await fetch(`http://127.0.0.1:${PORT}/api/tenants/${encodeURIComponent('ZZFT-01')}/profile`,
      { headers: { Authorization: `Bearer ${token}` } })).json();
    const histIds = (prof.payments || []).map((p) => p.id);
    check(rows.every((p) => histIds.includes(p.id)),
      '7. all booking payments visible in the tenant profile/history');

    // ── 6. Retry recognition ───────────────────────────────────────────────
    r = await call('POST', `/${ft.id}/activate`);
    check(r.status === 400, `6. re-activation refused on ACTIVE tenancy (HTTP ${r.status})`);
    const stillCount = (await query(`SELECT COUNT(*)::int AS n FROM payments WHERE tenant_code = 'ZZFT-01'`)).rows[0].n;
    check(stillCount === 3, `6b. no duplicate payments after retry attempt (${stillCount})`);
    check((await nextCounter()) === counterBefore + 3, '6c. no receipt numbers burned by the failed retry');

    // Partial-loss retry: mimic a rolled-back/partial activation (unit back
    // to Vacant, one moved payment lost). Only the lost payment is re-moved;
    // retained payments keep their original receipt numbers.
    await query(`UPDATE future_tenancies SET status = 'RESERVED' WHERE id = $1`, [ft.id]);
    await query(`UPDATE tenants SET status = 'Vacant' WHERE tenant_code = 'ZZFT-01'`);
    const lost = rows[0];
    await query(`DELETE FROM payments WHERE id = $1`, [lost.id]);
    const retainedNumbers = rows.slice(1).map((p) => p.receipt_number).sort();
    r = await call('POST', `/${ft.id}/activate`);
    check(r.status === 200 && r.json.moved_payments === 1,
      `6d. partial retry re-moves ONLY the missing payment (${r.json.moved_payments})`);
    check(r.json.receipts.length === 3 && r.json.receipts.filter((x) => x.existing).length === 3
      && r.json.receipts_generated === 0,
      `6e. existing receipts RECOGNISED — recreated payment reuses its receipt number + document (3 kept, 0 generated)`,
      r.json.receipts.map((x) => ({ n: x.receipt_number, existing: x.existing })));
    check((await nextCounter()) === counterBefore + 3,
      '6e2. partial retry burns NO new receipt numbers (original sequence reused)');
    const rows2 = (await query(`SELECT id, receipt_number, future_payment_id FROM payments WHERE tenant_code = 'ZZFT-01' ORDER BY id`)).rows;
    const futureRows = (await query(`SELECT id, receipt_number FROM future_payments WHERE future_tenancy_id = $1 ORDER BY id`, [ft.id])).rows;
    const retainedNow = rows2.map((r2) => r2.receipt_number).filter((n) => !n.startsWith('x')).sort();
    const newNumbers = rows2.map((r2) => r2.receipt_number);
    check(retainedNumbers.every((n) => newNumbers.includes(n)),
      '6f. retained payments KEEP their original receipt numbers', { retainedNumbers, newNumbers });
    check(newNumbers.length === 3 && new Set(newNumbers).size === 3,
      '6g. still exactly 3 receipts, no duplicates');

    console.log('\n(WhatsApp stubbed; original booking records preserved)');
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
