/**
 * Acceptance test — Tenancy-scoped financial history (permanence).
 *
 * Scenario: Tenant A occupies unit ZZTENHIST, pays rent + deposit, gets a
 * penalty, exits with a FINALIZED exit invoice, is vacated/archived. Tenant B
 * re-lets the same unit, pays. A reservation then activates a Tenant C.
 *
 * Acceptance (the rules the client demanded):
 *  1. Re-letting NEVER deletes/merges/relinks A's payments, penalties,
 *     water invoices, deposit records or documents — they stay bound to A's
 *     tenancy id forever.
 *  2. B (and C) start financially clean: live views show zero of A's rows;
 *     counters never inherit A's leftovers (both occupy paths).
 *  3. A's finalized exit invoice and archive record are immutable
 *     (server refuses edit/delete with 409).
 *  4. Archive → A's tenancy → COMPLETE payment history (incl. a payment
 *     recorded after vacate), and the deposit refund tied to that exact
 *     tenancy.
 *  5. Sealed payments can never be approved or deleted again.
 *
 * The test creates and fully removes its own rows (unit code ZZTENHIST).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const store = require('../backend/storage/store');
const { activateFutureTenancy } = require('../backend/storage/futureTenancies');
const { query } = require('../backend/config/database');

const CODE = 'ZZTENHIST';
const BASE = 'http://127.0.0.1:3003/api';

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra ? ` → ${JSON.stringify(extra)}` : '')); }
}

async function cleanup() {
  const stmts = [
    `DELETE FROM future_payments WHERE future_tenancy_id IN (SELECT id FROM future_tenancies WHERE tenant_code = $1)`,
    `DELETE FROM future_tenancies WHERE tenant_code = $1`,
    `DELETE FROM payments WHERE tenant_code = $1`,
    `DELETE FROM penalties WHERE tenant_code = $1`,
    `DELETE FROM water_invoices WHERE tenant_code = $1`,
    `DELETE FROM deposit_applications WHERE tenant_code = $1`,
    `DELETE FROM deposit_refunds WHERE tenant_code = $1`,
    `DELETE FROM exit_invoices WHERE tenant_code = $1`,
    `DELETE FROM tenancy_archive WHERE tenant_code = $1`,
    `DELETE FROM documents WHERE tenant_code = $1`,
    `DELETE FROM tenants WHERE tenant_code = $1`,
    `DELETE FROM audit_logs WHERE entity_id = $1`,
    `DELETE FROM audit_log WHERE entity_id = $1`,
  ];
  for (const sql of stmts) {
    try { await query(sql, [CODE]); } catch (_) { /* table may not exist / no rows */ }
  }
}

async function makeToken() {
  const u = (await query(
    `SELECT id, username, role FROM users WHERE is_active IS DISTINCT FROM false
      ORDER BY (role = 'admin') DESC, id LIMIT 1`
  )).rows[0];
  return jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

async function http(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

const row = async (sql, params) => (await query(sql, params)).rows;
const one = async (sql, params) => (await query(sql, params)).rows[0];

async function main() {
  await cleanup();

  // ── 1. Tenant A moves in (a real property — DB now validates the chain) ───
  const house = (await one(`SELECT paybill_number, house_name FROM houses ORDER BY paybill_number LIMIT 1`));
  const A = await store.createTenant({
    tenant_code: CODE,
    name: 'Tenant Alpha Histtest',
    phone_number: '+254700000101',
    property_name: 'ZZ Tenancy Test Property',
    house_id: house ? house.paybill_number : null,
    rent_amount: 10000,
    deposit_amount: 5000,
    garbage_fee_amount: 2000,
    water_charge_amount: 0,
    move_in_date: '2026-01-05',
    rent_due_date: '2026-10-05',
    status: 'Active',
  });
  check(!!A && A.tenant_code === CODE, '1. Tenant A created');

  const pa1 = await store.createPayment({
    tenant_id: CODE, amount: 8000, mpesa_reference: 'ZZT-RENT-1',
    payment_date: '2026-02-03', payment_type: 'rent', status: 'Pending',
    notes: 'test rent', client_txn_id: 'zzhist-rent-1',
  });
  const pa2 = await store.createPayment({
    tenant_id: CODE, amount: 5000, mpesa_reference: 'ZZT-DEP-1',
    payment_date: '2026-01-06', payment_type: 'deposit', status: 'Pending',
    notes: 'test deposit', client_txn_id: 'zzhist-dep-1',
  });
  check(!!pa1 && !!pa2, '1b. A payments created');

  const apr1 = await store.approvePayment(pa1.id);
  const apr2 = await store.approvePayment(pa2.id);
  check(apr1 && !apr1.error && apr2 && !apr2.error, '1c. A payments approved',
    { apr1: apr1 && apr1.error, apr2: apr2 && apr2.error });

  const penA = await store.createPenalty({ tenant_code: CODE, description: 'Test late penalty', amount: 500, invoice_date: '2026-03-01' });
  check(!!penA, '1d. A penalty created');

  // Water invoice for A (raw insert — test fixture)
  if (house) {
    await query(
      `INSERT INTO water_invoices (wtr_number, tenant_code, tenant_name, property_name, house_paybill_number, unit_label, billing_month, previous_reading, current_reading, units_used, rate_per_unit, total_amount, status)
       VALUES ('ZZTENHIST-W1', $1, 'Tenant Alpha Histtest', 'ZZ Tenancy Test Property', $2, $1, '2026-03', 10, 20, 10, 100, 1000, 'Finalized')`,
      [CODE, house.paybill_number]
    );
  }
  const wr = await one(`SELECT id FROM water_invoices WHERE tenant_code = $1`, [CODE]);
  check(!!wr, '1e. A water invoice created');

  // ── 2. A's exit invoice is created and FINALIZED ──────────────────────────
  const eiA = await store.createExitInvoice(CODE, {
    move_out_date: '2026-10-20', reason: 'End of tenancy (test)', lines: [],
  });
  check(!!eiA && eiA.status === 'Draft', '2. A exit invoice drafted', eiA && eiA.error);
  const finA = await store.finalizeExitInvoice(eiA.id, { move_out_date: '2026-10-20' }, 'test');
  check(finA && finA.status === 'Finalized', '2b. A exit invoice finalized', finA && finA.error);

  // ── 3. Route guards: finalized records are immutable ──────────────────────
  const token = await makeToken();
  const putEi = await http(token, 'PUT', `${BASE}/exit-invoices/${eiA.id}`, { reason: 'tamper attempt' });
  check(putEi.status === 409, `3. finalized exit invoice edit refused (409), got ${putEi.status}`);
  const delEi = await http(token, 'DELETE', `${BASE}/exit-invoices/${eiA.id}`);
  check(delEi.status === 409, `3b. finalized exit invoice delete refused (409), got ${delEi.status}`);
  const eiAfter = await store.getExitInvoice(eiA.id);
  check(eiAfter && eiAfter.status === 'Finalized' && eiAfter.reason === 'End of tenancy (test)',
    '3c. exit invoice untouched after refused edit/delete', eiAfter && { status: eiAfter.status, reason: eiAfter.reason });

  const putCode = await http(token, 'PUT', `${BASE}/tenants/${CODE}`, { tenant_code: 'SOMETHING-ELSE' });
  check(putCode.status === 400, `3d. unit/tenant code change refused (400), got ${putCode.status}`);

  // ── 4. Vacate → archive → everything sealed to A's tenancy id ────────────
  const vac = await store.vacateTenancy(CODE, {
    move_out_date: '2026-10-20', reason: 'End of tenancy (test)',
    exit_invoice_id: eiA.id, archived_by: 'test',
  });
  check(!!vac && !!vac.archive, '4. A vacated + archived', vac);
  const arcA = vac && vac.archive;
  check(!!arcA && arcA.id, '4b. archive record exists');

  const aPays = await row(`SELECT id, amount, status, tenancy_id, receipt_number FROM payments WHERE tenant_code = $1 ORDER BY id`, [CODE]);
  check(aPays.length === 2 && aPays.every((p) => p.tenancy_id === arcA.id),
    '4c. BOTH A payments sealed to A tenancy id', aPays);
  const aPen = await one(`SELECT tenancy_id FROM penalties WHERE tenant_code = $1`, [CODE]);
  check(aPen && aPen.tenancy_id === arcA.id, '4d. A penalty sealed', aPen);
  const aWtr = await one(`SELECT tenancy_id FROM water_invoices WHERE tenant_code = $1`, [CODE]);
  check(aWtr && aWtr.tenancy_id === arcA.id, '4e. A water invoice sealed', aWtr);

  const arcArow = await one(`SELECT payments, penalties, financial_snapshot, deposit_refund FROM tenancy_archive WHERE id = $1`, [arcA.id]);
  const snap = typeof arcArow.payments === 'string' ? JSON.parse(arcArow.payments) : arcArow.payments;
  check(snap.length === 2, '4f. archive snapshot captured A payments', snap && snap.length);
  check(Number(arcArow.deposit_refund) >= 0 && arcArow.financial_snapshot != null,
    '4g. archive holds final financial snapshot');

  const dr = await one(`SELECT archive_id, refundable_amount FROM deposit_refunds WHERE exit_invoice_id = $1`, [eiA.id]);
  check(dr && dr.archive_id === arcA.id, '4h. deposit refund bound to A tenancy', dr);

  const delArc = await http(token, 'DELETE', `${BASE}/archive/${arcA.id}`);
  check(delArc.status === 409, `4i. archive delete refused (409), got ${delArc.status}`);

  // Sealed payments can never be deleted or re-approved again
  const delPay = await http(token, 'DELETE', `${BASE}/payments/${pa1.id}`);
  check(delPay.status === 409, `4j. sealed payment delete refused (409), got ${delPay.status}`);
  const reApr = await http(token, 'POST', `${BASE}/payments/${pa1.id}/approve`);
  check(reApr.status === 409, `4k. sealed payment re-approve refused (409), got ${reApr.status}`);
  const pa1Still = await one(`SELECT id, tenancy_id FROM payments WHERE id = $1`, [pa1.id]);
  check(pa1Still && pa1Still.tenancy_id === arcA.id, '4l. sealed payment row still intact after refused ops', pa1Still);

  // ── 5. Re-let: B takes the unit — A's records must be untouched ───────────
  await store.resetTenancyFinancials(CODE);
  const afterReset = await row(`SELECT id, amount, tenancy_id FROM payments WHERE tenant_code = $1 ORDER BY id`, [CODE]);
  check(afterReset.length === 2, `5. re-let did NOT delete A's payments (${afterReset.length}/2 remain)`, afterReset);
  const penAfterReset = await row(`SELECT id FROM penalties WHERE tenant_code = $1`, [CODE]);
  check(penAfterReset.length === 1, '5b. re-let did NOT delete A penalty', penAfterReset);

  await store.updateTenant(CODE, {
    name: 'Tenant Beta Histtest',
    phone_number: '+254700000102',
    national_id: null,
    status: 'Active',
    rent_amount: 9500,
    deposit_amount: 4500,
    move_in_date: '2026-11-01',
    rent_due_date: '2026-12-05',
    deposit_paid: 3000,   // B's own deposit payments
    arrears: 700,         // B's own arrears
    garbage_fee_paid: 0,
    rent_paid_this_month: 0,
    credit_balance: 0,
    exit_reason: null,
    move_out_date: null,
  });

  // Live views for the NEW tenant show none of A's history
  check((await row(`SELECT id FROM penalties WHERE tenant_code = $1 AND tenancy_id IS NULL`, [CODE])).length === 0,
    '5c. B sees zero penalties (A penalty sealed out)');
  check(Number(await store.getOutstandingPenalties(CODE)) === 0,
    '5d. B outstanding penalties = 0');
  check(Number(await store.getApprovedPaymentCount(CODE)) === 0,
    '5e. B approved payment count = 0');
  const livePays = (await store.listPayments()).filter((p) => p.tenant_code === CODE && (p.tenancy_id == null));
  check(livePays.length === 0, '5f. B live payment list empty', livePays.length);
  check(Number(await store.getLatestWaterReading(CODE)) === 0,
    '5g. B water meter starts fresh (A reading sealed out)');
  check((await row(`SELECT id FROM deposit_applications WHERE tenant_code = $1 AND tenancy_id IS NULL`, [CODE])).length === 0,
    '5h. B deposit application list empty');

  // ── 6. Late payment recorded after A vacated → still A's tenancy ──────────
  const late = await store.createPayment({
    tenant_id: CODE, amount: 400, mpesa_reference: 'ZZT-LATE-1',
    payment_date: '2026-10-19', payment_type: 'rent', status: 'Pending',
    notes: 'late payment for A', client_txn_id: 'zzhist-late-1',
  });
  // (sealed by sealStrayTenancyRows at re-let — happens on NEXT transition;
  //  explicitly seal here the same way the re-let does for stragglers)
  //  NOTE: this payment was created AFTER reset, so at the NEXT re-let it is
  //  sealed only if dated <= A's move_out (2026-10-20) — which it is.
  check(!!late, '6. late payment created');

  // ── 7. B pays → live; A's rows byte-identical before/after ────────────────
  const beforeB = JSON.stringify(await row(`SELECT id, amount, status, tenancy_id, receipt_number, payment_date::text AS d FROM payments WHERE tenant_code = $1 ORDER BY id`, [CODE]));
  const pb = await store.createPayment({
    tenant_id: CODE, amount: 9000, mpesa_reference: 'ZZT-RENT-B',
    payment_date: '2026-11-04', payment_type: 'rent', status: 'Pending',
    client_txn_id: 'zzhist-rent-b',
  });
  const aprB = await store.approvePayment(pb.id);
  check(aprB && !aprB.error, '7. B payment approved', aprB && aprB.error);
  const pbRow = await one(`SELECT tenancy_id FROM payments WHERE id = $1`, [pb.id]);
  check(pbRow && pbRow.tenancy_id == null, '7b. B payment is live (unsealed)', pbRow);

  const afterB = await row(`SELECT id, amount, status, tenancy_id, receipt_number, payment_date::text AS d FROM payments WHERE tenant_code = $1 ORDER BY id`, [CODE]);
  const aRowsAfter = afterB.filter((r) => r.id !== pb.id && r.id !== late.id);
  const aRowsBefore = JSON.parse(beforeB).filter((r) => r.id !== late.id);
  check(JSON.stringify(aRowsAfter) === JSON.stringify(aRowsBefore),
    '7c. A payment rows byte-identical after B pays', { before: aRowsBefore, after: aRowsAfter });

  // ── 8. Archive → A's COMPLETE payment history (incl. late payment) ────────
  await store.sealStrayTenancyRows(CODE); // seals the dated-in-A late payment
  const lateRow = await one(`SELECT tenancy_id FROM payments WHERE id = $1`, [late.id]);
  check(lateRow && lateRow.tenancy_id === arcA.id,
    '8. late A payment sealed to A tenancy (dated inside A)', lateRow);

  const arcFull = await store.getTenancyArchive(arcA.id);
  const mergedPays = Array.isArray(arcFull.payments) ? arcFull.payments : [];
  check(mergedPays.length === 3, `8b. A archive shows COMPLETE history (${mergedPays.length}/3 payments incl. late one)`,
    mergedPays.map((p) => p.id));
  check(mergedPays.every((p) => p.id !== pb.id), '8c. B payment never appears in A history');
  check(arcFull.deposit_refund_row && arcFull.deposit_refund_row.archive_id === arcA.id,
    '8d. archive returns the deposit refund bound to THIS tenancy', arcFull.deposit_refund_row && arcFull.deposit_refund_row.archive_id);
  const docLive = await row(`SELECT id FROM documents WHERE tenancy_id = $1`, [arcA.id]);
  check(true, `8e. (info) documents bound to A: ${docLive.length}`);

  // ── 9. B exits, then reservation activation (2nd re-let path) ─────────────
  const vacB = await store.vacateTenancy(CODE, { move_out_date: '2026-12-15', reason: 'B exit (test)', archived_by: 'test' });
  check(!!vacB && !!vacB.archive && vacB.archive.id !== arcA.id, '9. B archived as a SEPARATE tenancy record');
  const arcB = vacB.archive;
  const bPay = await one(`SELECT tenancy_id FROM payments WHERE id = $1`, [pb.id]);
  check(bPay && bPay.tenancy_id === arcB.id, '9b. B payment sealed to B tenancy, not A', bPay);

  // Reservation for the same unit with an approved booking deposit
  const ft = await one(
    `INSERT INTO future_tenancies (property_name, unit_label, tenant_name, phone_number, tenant_code, allocated_month, status, rent_amount, deposit_amount)
     VALUES ('ZZ Tenancy Test Property', $1, 'Tenant Gamma Histtest', '+254700000103', $1, '2026-12', 'RESERVED', 9000, 500)
     RETURNING id`,
    [CODE]
  );
  await query(
    `INSERT INTO future_payments (future_tenancy_id, amount, payment_date, allocated_month, purpose, status, approved_at, receipt_number)
     VALUES ($1, 500, '2026-12-01', '2026-12', 'Deposit', 'Approved', NOW(), 'ZZT-BOOK-1')`,
    [ft.id]
  );
  const act = await activateFutureTenancy(ft.id, store);
  check(!!act, '9c. reservation activated', act && act.message);
  const g = await one(`SELECT deposit_paid, arrears, rent_paid_this_month, garbage_fee_amount, name FROM tenants WHERE tenant_code = $1`, [CODE]);
  check(Number(g.deposit_paid) === 500,
    `9d. new tenancy deposit = booking only (500), NOT inherited (${g.deposit_paid})`, g);
  check(Number(g.arrears) === 0, `9e. new tenancy arrears = 0 (got ${g.arrears})`, g);
  check(Number(g.rent_paid_this_month) === 0, `9f. new tenancy rent_paid = 0 (got ${g.rent_paid_this_month})`, g);
  check(g.name === 'Tenant Gamma Histtest', '9g. new tenancy identity applied');
  const gPays = await row(`SELECT id, tenancy_id FROM payments WHERE tenant_code = $1 AND future_payment_id IS NOT NULL`, [CODE]);
  check(gPays.length === 1 && gPays[0].tenancy_id == null, '9h. booking payment is live (belongs to new tenancy)', gPays);

  // ── 10. Unit row itself is protected while it anchors history ─────────────
  const delTenant = await store.deleteTenant(CODE, 'test');
  check(delTenant && delTenant.archived === true && delTenant.archive_id,
    '10. unit delete archives the complete tenancy instead of destroying it', delTenant);

  const totalRows = Number((await one(`SELECT COUNT(*)::int AS c FROM payments WHERE tenant_code = $1`, [CODE])).c);
  // A: rent + deposit + late payment · B: rent · C: booking deposit = 5
  check(totalRows === 5, `10b. ALL payments across 3 tenancies still exist (${totalRows}/5)`, totalRows);
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
