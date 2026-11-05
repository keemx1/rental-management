/**
 * Acceptance test — Overpayment transparency & advance-rent allocations
 * (presentation only; receipts + workflow untouched).
 *
 *  1. Consolidated summary combines SEPARATE receipts' overpayments
 *     (spec example: 2,000 + 8,000 = 10,000) while each receipt stays
 *     individually traceable (number, date, payment, overpayment)
 *  2. Allocations listed from the existing credit_allocations records
 *  3. NO double counting: remaining credit = tenant.credit_balance (net of
 *     allocations) — allocated credit is never offered again
 *  4. Advance rent shown separately from the remaining credit
 *  5. Rent acknowledgement appendix carries previous + new overpayments,
 *     combined credit, allocations and remaining credit; base message
 *     untouched when there is no credit activity
 *  6. Tenant dashboard profile exposes the consolidation (panel data)
 *  7. Receipts/transactions never modified by any of the above reads
 *  8. Real units EX001 + BH46: read-only sanity of their actual records
 *  9. Frontend panel served
 *
 * Fixtures: tenant ZZOP-* (removed afterwards).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const { appendCreditConsolidation } = require('../backend/services/messages');

const CODE = 'ZZOP-01';

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ` -> ${JSON.stringify(extra)}` : '')); }
}

async function cleanup() {
  for (const sql of [
    `DELETE FROM credit_allocations WHERE tenant_code LIKE 'ZZOP-%'`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZOP-%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZOP-%'`,
    `DELETE FROM audit_log WHERE entity_id LIKE 'ZZOP-%' OR details::text LIKE '%ZZOP%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZOP-%'`,
    `DELETE FROM houses WHERE paybill_number IN ('999982', '999983')`,
  ]) {
    try { await query(sql, []); } catch (e) { console.error('[cleanup]', e.message); }
  }
}

async function main() {
  await cleanup();
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status)
    VALUES ('999982', 'ZZOP House', 4, 'unknown')`);
  await store.createTenant({
    tenant_code: CODE, name: 'ZZOP Tenant', phone_number: '+254700001601',
    property_name: 'ZZOP House', house_id: '999982', rent_amount: 10000, deposit_amount: 5000,
    move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  // Two SEPARATE receipts with overpayments (spec example: 2,000 + 8,000).
  const pay = (receipt, date, amount, op, period) => query(
    `INSERT INTO payments (tenant_code, amount, overpayment_amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode, tenancy_id)
     VALUES ($1,$2,$3,$4,'Approved','rent',$5,$6,$7,'M-Pesa',NULL)`,
    [CODE, amount, op, date, receipt, `MP-${receipt}`, period]
  );
  await pay('R-OP-1', '2026-10-05', 12000, 2000, '2026-10');
  await pay('R-OP-2', '2026-11-05', 8000, 8000, '2026-11');
  // Existing workflow state AFTER an allocation: 10,000 combined credit,
  // 6,000 already allocated to November rent, 4,000 still available, plus
  // 5,000 advance rent tracked separately by the system.
  await query(`UPDATE tenants SET credit_balance = 4000, advance_rent_balance = 5000, advance_rent_until = '2026-12-31' WHERE tenant_code = $1`, [CODE]);
  await query(
    `INSERT INTO credit_allocations (tenant_code, amount, target, reason, approved_by, applied_at, tenancy_id)
     VALUES ($1, 6000, 'rent', 'Allocated to November rent', 'tester', '2026-11-06', NULL)`,
    [CODE]
  );

  try {
    // ── 1/2/3/4. Consolidated summary ──────────────────────────────────────
    const cons = await store.getOverpaymentConsolidation(CODE);
    check(!!cons && cons.has_activity, '1. consolidation available with activity');
    check(cons.receipts.length === 2, `1b. BOTH receipts listed separately (${cons.receipts.length})`);
    const r1 = cons.receipts.find((r) => r.receipt_number === 'R-OP-1');
    const r2 = cons.receipts.find((r) => r.receipt_number === 'R-OP-2');
    check(r1 && r1.overpayment === 2000 && r1.payment_amount === 12000 && r1.payment_date === '2026-10-05',
      `1c. receipt 1 traceable (2,000 over 12,000)`, r1);
    check(r2 && r2.overpayment === 8000 && r2.payment_amount === 8000,
      `1d. receipt 2 traceable (8,000 over 8,000)`, r2);
    check(cons.total_overpaid === 10000,
      `1e. combined credit = 10,000 (spec example) (got ${cons.total_overpaid})`);
    check(cons.allocations.length === 1 && cons.total_allocated === 6000,
      `2. allocation record shown (6,000 → rent) (got ${cons.total_allocated})`);
    check(cons.remaining_credit === 4000,
      `3. remaining credit = 4,000 (net of allocations, got ${cons.remaining_credit})`);
    check(cons.remaining_credit + cons.total_allocated === cons.total_overpaid,
      '3b. no double counting: allocated + remaining = combined credit');
    check(cons.advance_rent_balance === 5000 && cons.advance_rent_until === '2026-12-31',
      '4. advance rent reported separately (not inside remaining credit)');

    // ── 5. Rent acknowledgement appendix ───────────────────────────────────
    const base = 'BASE RENT ACKNOWLEDGEMENT';
    const ack = appendCreditConsolidation(base, cons);
    check(ack.startsWith(base), '5. base acknowledgement untouched');
    check(ack.includes('R-OP-1') && ack.includes('R-OP-2'),
      '5b. previous + new overpayments both named');
    check(ack.includes('Total overpaid across receipts (incl. KES 6,000.00 already applied to rent/charges): KES 10,000.00'),
      '5c. lifetime line clearly labels the utilized portion (never presented as the overpayment)');
    check(ack.includes('Allocated to rent') && ack.includes('Total allocated: KES 6,000.00'),
      '5d. allocation lines present');
    check(ack.includes('Overpayment available (reconciled): KES 4,000.00'),
      '5e. overpayment available (reconciled) = 4,000 - utilized credits excluded');
    check(ack.includes('Advance rent: KES 5,000.00') && ack.includes('paid up to 2026-12-31'),
      '5f. advance rent line present');
    const quiet = appendCreditConsolidation(base, { has_activity: false, receipts: [] });
    check(quiet === base, '5g. nothing appended when there is no credit activity');

    // ── 6. Dashboard profile integration ───────────────────────────────────
    const app = express();
    app.use(express.json());
    app.use('/api/tenants', require('../backend/routes/tenants'));
    const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const PORT = srv.address().port;
    const u = (await query(
      `SELECT id, username, role FROM users WHERE role = 'admin' AND is_active IS DISTINCT FROM false ORDER BY id LIMIT 1`
    )).rows[0];
    const token = jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const res = await fetch(`http://127.0.0.1:${PORT}/api/tenants/${encodeURIComponent(CODE)}/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const profile = await res.json();
    const oc = profile.overpayment_consolidation;
    check(res.status === 200 && oc, `6. profile carries overpayment_consolidation (HTTP ${res.status})`);
    check(oc && oc.total_overpaid === 10000 && oc.remaining_credit === 4000 && oc.total_allocated === 6000,
      '6b. dashboard figures consistent with the summary', oc && { t: oc.total_overpaid, r: oc.remaining_credit, a: oc.total_allocated });

    // ── 7. Receipts/transactions untouched by all reads ────────────────────
    const rows = (await query(
      `SELECT receipt_number, amount, overpayment_amount FROM payments WHERE tenant_code = $1 ORDER BY payment_date`,
      [CODE]
    )).rows;
    check(rows.length === 2 && Number(rows[0].overpayment_amount) === 2000 && Number(rows[1].overpayment_amount) === 8000
      && Number(rows[0].amount) === 12000 && Number(rows[1].amount) === 8000,
      '7. original receipts intact — nothing merged or modified', rows);

    // ── 8. Real units (read-only sanity) ───────────────────────────────────
    const ex = await store.getOverpaymentConsolidation('EX001');
    check(!!ex && ex.receipts.length >= 2 && ex.total_overpaid === ex.receipts.reduce((s, r) => s + r.overpayment, 0),
      `8. EX001 – Ian Kamau: ${ex ? ex.receipts.length : 0} separate overpaid receipts, internally consistent (total ${ex && ex.total_overpaid})`);
    const bh = await store.getOverpaymentConsolidation('BH46');
    check(!!bh && bh.receipts.length >= 1 && bh.total_overpaid > 0,
      `8b. BH46: ${bh ? bh.receipts.length : 0} overpaid receipt(s) combined (total ${bh && bh.total_overpaid})`);

    // ── 9. Frontend ────────────────────────────────────────────────────────
    // EX402 regression (2026-11-05): the acknowledgement must show the ACTUAL
    // overpayment (400) and exclude the previously utilized 200 from the
    // available balance - never a "combined credit 600" figure.
    await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status)
      VALUES ('999983', 'ZZOP House Two', 2, 'unknown')`);
    await store.createTenant({
      tenant_code: 'ZZOP-02', name: 'ZZOP Ex402', phone_number: '+254700001602',
      property_name: 'ZZOP House Two', house_id: '999983', rent_amount: 27000, deposit_amount: 27000,
      move_in_date: '2026-09-01', rent_due_date: '2026-11-05', status: 'Active',
    });
    const pExA = (await query(
      `INSERT INTO payments (tenant_code, amount, overpayment_amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode, tenancy_id)
       VALUES ('ZZOP-02', 27400, 200, '2026-10-05', 'Approved', 'rent', 'R-EX-A', 'MP-R-EX-A', '2026-10', 'M-Pesa', NULL) RETURNING *`
    )).rows[0];
    const pExB = (await query(
      `INSERT INTO payments (tenant_code, amount, overpayment_amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode, tenancy_id)
       VALUES ('ZZOP-02', 27400, 400, '2026-11-05', 'Approved', 'rent', 'R-EX-B', 'MP-R-EX-B', '2026-11', 'M-Pesa', NULL) RETURNING *`
    )).rows[0];
    await query(`UPDATE tenants SET advance_rent_balance = 400, advance_rent_until = '2026-11-30' WHERE tenant_code = 'ZZOP-02'`);
    await query(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, details, created_at)
       VALUES ('tester', 'overpayment_resolved', 'tenant', 'ZZOP-02', $1, NOW())`,
      [JSON.stringify({ payment_id: pExA.id, choice: 'advance_rent', overpayment: 200, months: ['2026-11'] })]
    );
    const exCons = await store.getOverpaymentConsolidation('ZZOP-02');
    check(exCons.applied_overpaid === 200 && exCons.available_overpaid === 400,
      `8b. EX402 class: utilized 200 excluded, available = 400 (got applied ${exCons.applied_overpaid}, available ${exCons.available_overpaid})`, exCons);
    const exAck = appendCreditConsolidation('BASE', exCons, pExB, { overpayment: 400 });
    check(exAck.includes('Current transaction overpayment: KES 400.00'),
      '8c. message shows the ACTUAL overpayment 400', exAck);
    check(exAck.includes('Overpayment available (reconciled): KES 400.00'),
      '8d. available balance = 400 (reconciled ledger)', exAck);
    check(!exAck.includes('Total combined credit from receipts'),
      '8e. lifetime accumulation is never presented as the credit figure', exAck);

    const idx = await (await fetch('http://127.0.0.1:3003/')).text();
    check(idx.includes('id="td-credit-panel"') && idx.includes('OVERPAYMENT_CREDIT')
      && idx.includes('id="td-credit-receipts-tbody"') && idx.includes('placeholder="Search anything"'),
      '9. dashboard credit panel + search placeholder served');
    const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js')).text();
    check(appJs.includes('renderTenantCreditPanel') && appJs.includes('overpayment_consolidation'),
      '9b. panel rendering wired into the tenant dashboard');

    srv.close();
  } finally {
    // nothing else
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
