/**
 * Acceptance test — Tenancy Archive: complete per-tenancy payment history.
 *
 * Verifies (client requirements):
 *  1. GET /api/archive/:id/history returns tenant+tenancy information
 *  2. payments in chronological order with reference, amount, method, type,
 *     billing period, per-charge allocations, balance_before / balance_after
 *  3. balances reconstructed ONLY from this tenancy's own charges +
 *     allocations (exact known values asserted), never from current balance
 *  4. deposit payments held separately (do not reduce the outstanding balance)
 *  5. complete financial summary (rent/water/garbage/penalties/other/deposit
 *     deductions/refund/final outstanding/exit invoice amount)
 *  6. link data: exit invoice id + number present for the "View Exit Invoice"
 *  7. SPECIFIC-TENANCY scoping: a later tenant on the SAME unit never bleeds
 *     into the archived tenancy's history
 *  8. frontend: tenant name clickable, history modal served
 *
 * Fixtures use unit code ZZARCH-* and are fully removed afterwards.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const store = require('../backend/storage/store');
const { query } = require('../backend/config/database');

const CODE = 'ZZARCH-A1';
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
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZARCH-%'`,
    `DELETE FROM penalties WHERE tenant_code LIKE 'ZZARCH-%'`,
    `DELETE FROM water_invoices WHERE tenant_code LIKE 'ZZARCH-%'`,
    `DELETE FROM deposit_refunds WHERE tenant_code LIKE 'ZZARCH-%'`,
    `DELETE FROM exit_invoices WHERE tenant_code LIKE 'ZZARCH-%'`,
    `DELETE FROM tenancy_archive WHERE tenant_code LIKE 'ZZARCH-%'`,
    `DELETE FROM documents WHERE tenant_code LIKE 'ZZARCH-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZARCH-%'`,
    `DELETE FROM audit_log WHERE entity_id LIKE 'ZZARCH-%'`,
  ];
  for (const sql of stmts) { try { await query(sql); } catch (_) {} }
}

async function makeToken() {
  const u = (await query(
    `SELECT id, username, role FROM users WHERE is_active IS DISTINCT FROM false
      ORDER BY (role = 'admin') DESC, id LIMIT 1`
  )).rows[0];
  return jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

async function main() {
  await cleanup();
  const house = (await query(`SELECT paybill_number, house_name FROM houses ORDER BY paybill_number LIMIT 1`)).rows[0];
  const token = await makeToken();
  const get = async (p) => {
    const res = await fetch(BASE + p, { headers: { Authorization: `Bearer ${token}` } });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };

  // ── Build Tenant A's tenancy (single month: move-in 01 Oct, move-out 20 Oct)
  await store.createTenant({
    tenant_code: CODE, name: 'ZZARCH Elizabeth Ngugi', phone_number: '+254700000301',
    property_name: 'ZZ Archive Property', house_id: house.paybill_number,
    rent_amount: 10000, deposit_amount: 5000, garbage_fee_amount: 0, water_charge_amount: 0,
    move_in_date: '2026-10-01', rent_due_date: '2026-11-01', status: 'Active',
  });

  const p1 = await store.createPayment({
    tenant_id: CODE, amount: 8000, payment_type: 'rent', status: 'Pending',
    payment_date: '2026-10-03', mpesa_reference: 'ZZARCH-R1', client_txn_id: 'zzarch-1',
    payment_mode: 'M-Pesa', source: 'manual',
  });
  const a1 = await store.approvePayment(p1.id);
  check(a1 && !a1.error && Number(a1.allocation?.rentSettled || 0) === 8000,
    'A1. rent payment allocated rent=8000', a1 && (a1.error || a1.allocation));

  await store.createPenalty({ tenant_code: CODE, description: 'ZZARCH late fee', amount: 500, invoice_date: '2026-10-05' });

  const p2 = await store.createPayment({
    tenant_id: CODE, amount: 5000, payment_type: 'deposit', status: 'Pending',
    payment_date: '2026-10-06', mpesa_reference: 'ZZARCH-D1', client_txn_id: 'zzarch-2',
    payment_mode: 'M-Pesa', source: 'manual',
  });
  const a2 = await store.approvePayment(p2.id);
  check(a2 && !a2.error && Number(a2.allocation?.depositSettled || 0) === 5000,
    'A2. deposit payment allocated deposit=5000', a2 && (a2.error || a2.allocation));

  const p3 = await store.createPayment({
    tenant_id: CODE, amount: 500, payment_type: 'rent', status: 'Pending',
    payment_date: '2026-10-07', mpesa_reference: 'ZZARCH-P1', client_txn_id: 'zzarch-3',
    payment_mode: 'M-Pesa', source: 'manual',
  });
  const a3 = await store.approvePayment(p3.id);
  check(a3 && !a3.error && Number(a3.allocation?.penaltySettled || 0) === 500,
    'A3. payment settled the penalty=500', a3 && (a3.error || a3.allocation));

  // ── Exit invoice finalized, tenancy archived
  const ei = await store.createExitInvoice(CODE, { move_out_date: '2026-10-20', reason: 'End of tenancy (test)', lines: [] });
  check(!!ei && ei.status === 'Draft', 'B. exit invoice drafted', ei && ei.error);
  const fin = await store.finalizeExitInvoice(ei.id, { move_out_date: '2026-10-20' }, 'test');
  check(fin && fin.status === 'Finalized', 'B1. exit invoice finalized', fin && fin.error);
  const vac = await store.vacateTenancy(CODE, {
    move_out_date: '2026-10-20', reason: 'End of tenancy (test)', exit_invoice_id: ei.id, archived_by: 'test',
  });
  check(!!vac && !!vac.archive, 'B2. tenancy archived', vac && vac.error);
  const arcId = vac.archive.id;

  // ── Tenant B re-lets the SAME unit and pays (must never appear below)
  await store.resetTenancyFinancials(CODE);
  await store.updateTenant(CODE, {
    name: 'ZZARCH Second Tenant', phone_number: '+254700000302', status: 'Active',
    rent_amount: 9500, deposit_amount: 4500, move_in_date: '2026-11-01',
    rent_due_date: '2026-12-01', deposit_paid: 0, arrears: 0, rent_paid_this_month: 0,
  });
  const pB = await store.createPayment({
    tenant_id: CODE, amount: 9000, payment_type: 'rent', status: 'Pending',
    payment_date: '2026-11-05', client_txn_id: 'zzarch-b1', source: 'manual',
  });
  await store.approvePayment(pB.id);

  // ── Fetch the archived tenancy's complete history
  const { status, json } = await get(`/archive/${arcId}/history`);
  check(status === 200, `C. history endpoint 200 (got ${status})`, json && json.error);
  if (status !== 200) throw new Error('history endpoint failed');

  const h = json.history;
  const t = h.tenancy;

  // 1. Tenant & tenancy information
  check(t.tenant_name === 'ZZARCH Elizabeth Ngugi', 'C1. tenant name', t.tenant_name);
  check(String(t.unit) === CODE && t.property_name === house.house_name,
    'C2. unit + property (property follows the house)', t);
  check(t.move_in_date === '2026-10-01' && t.move_out_date === '2026-10-20', 'C3. move-in / move-out dates', t);
  check(Number(t.rent_amount) === 10000, 'C4. monthly rent', t.rent_amount);
  check(Number(t.deposit_paid) === 5000, 'C5. deposit paid', t.deposit_paid);
  check(t.water_deposit === null, 'C6. water deposit field present (— where n/a)');
  check(/Archived/.test(t.status || ''), 'C7. tenancy status', t.status);
  check(t.exit_date === '2026-10-20' && t.exit_reason === 'End of tenancy (test)', 'C8. exit date + reason', t);

  // 2. Complete payment history — chronological, with allocations + balances
  const pays = h.payments;
  check(pays.length === 3, `D. exactly this tenancy's payments (${pays.length}/3)`, pays.map((p) => p.id));
  const dates = pays.map((p) => p.payment_date);
  check(JSON.stringify(dates) === JSON.stringify(dates.slice().sort()), 'D1. payments chronological', dates);

  const [r1, r2, r3] = pays;
  check(r1.amount === 8000 && r1.mpesa_reference === 'ZZARCH-R1' && !!r1.reference
    && r1.payment_mode === 'M-Pesa' && r1.payment_type === 'rent' && r1.billing_period,
    'D2. payment 1 reference/method/type/period', r1);
  check(r1.allocations.rent === 8000, 'D3. payment 1 allocation: rent 8000', r1.allocations);
  check(Number(r1.balance_before) === 10000 && Number(r1.balance_after) === 2000,
    `D4. payment 1 balance 10000 -> 2000 (got ${r1.balance_before} -> ${r1.balance_after})`);
  check(r2.amount === 5000 && r2.allocations.deposit === 5000, 'D5. payment 2 allocation: deposit 5000', r2.allocations);
  check(Number(r2.balance_before) === 2500 && Number(r2.balance_after) === 2500,
    `D6. deposit payment does not reduce balance (2500 -> 2500, got ${r2.balance_before} -> ${r2.balance_after})`);
  check(r3.amount === 500 && r3.allocations.penalty === 500, 'D7. payment 3 allocation: penalty 500', r3.allocations);
  check(Number(r3.balance_before) === 2500 && Number(r3.balance_after) === 2000,
    `D8. payment 3 balance 2500 -> 2000 (got ${r3.balance_before} -> ${r3.balance_after})`);

  // Charges posted during the tenancy (rent month + penalty) — the audit
  // trail behind the balances.
  const chargeTypes = h.charges.map((c) => `${c.type}:${c.amount}`);
  check(chargeTypes.includes('rent:10000'), 'E1. rent charge posted for the tenancy month', chargeTypes);
  check(chargeTypes.includes('penalty:500'), 'E2. penalty charge posted', chargeTypes);

  // 4. Complete financial summary
  const s = h.summary;
  check(Number(s.total_rent_charged) === 10000 && Number(s.total_rent_paid) === 8000,
    'F1. rent charged/paid 10000/8000', s);
  check(Number(s.total_penalties) === 500 && Number(s.total_penalties_paid) === 500,
    'F2. penalties charged/paid 500/500', s);
  check(Number(s.deposit_paid) === 5000, 'F3. deposit paid 5000', s.deposit_paid);
  check(Number(s.total_water_charges) === 0 && Number(s.total_garbage_charged) === 0,
    'F4. no water/garbage invented', s);
  check(h.exit_invoice && h.exit_invoice.id === ei.id && h.exit_invoice.exit_number,
    'F5. exit invoice linked (id + number for the View button)', h.exit_invoice);
  check(Number(s.final_outstanding) === Number(h.exit_invoice.outstanding_balance),
    'F6. final outstanding = exit invoice figure (authoritative)', s);
  check(Number(s.deposit_deductions) === Number(h.exit_invoice.deductions_total),
    'F7. deposit deductions = exit invoice deductions', s);
  check(Number(s.deposit_refundable) === Number(h.exit_invoice.deposit_refund),
    'F8. deposit refundable = exit invoice refund', s);
  check(Number(s.exit_invoice_amount) === Number(h.exit_invoice.final_settlement),
    'F9. exit invoice amount = final settlement', s);
  check(Number(s.total_payments) === 8000 + 5000 + 500, 'F10. total payments received', s.total_payments);

  // 7. Specific tenancy: B's payment must NOT appear
  check(!pays.some((p) => p.id === pB.id),
    'G. later tenant payment never mixed into this tenancy', pays.map((p) => p.id));

  // 404 for unknown tenancy
  const missing = await get('/archive/99999999/history');
  check(missing.status === 404, `H. unknown tenancy -> 404 (got ${missing.status})`);

  // 8. Frontend markers served
  const idx = await (await fetch('http://127.0.0.1:3003/')).text();
  check(idx.includes('tenancy-history-modal') && idx.includes('btn-th-exit-invoice'),
    'I. history modal + View Exit Invoice button served');
  const app = await (await fetch('http://127.0.0.1:3003/js/app.js?v=64')).text();
  check(app.includes('openTenancyHistory') && app.includes('archiveHistory'),
    'Ib. openTenancyHistory + api client served');
  check(app.includes('data-archive-history'), 'Ic. clickable tenant-name wiring served');
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
