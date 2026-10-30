/**
 * Acceptance test — Deposit Refund Cancellation / Deposit Restoration /
 * Tenancy Reinstatement / Unit Reassignment (proposal §1-§14).
 *
 *  1. Eligibility gating: finalized exit + unpaid + not yet processed;
 *     disbursed refunds refuse (reason), original records surfaced
 *  2. Scenario A (original tenant still in unit): reinstate profile/code/
 *     unit, deposit restored on the EXISTING payment (no new payment, no
 *     new reference), refund -> Cancelled / Reinstated, audit written
 *  3. Scenario B (unit vacant): profile + deposit restored to the vacant
 *     original row; sealed original payment untouched
 *  4. Scenario C (unit re-let): current occupant NEVER touched; Option 1
 *     reassign to a confirmed vacant unit (profile travels, payment
 *     origin snapshot + current allocation both recorded); Option 2 hold
 *     deposit on a holding profile, later Assign Unit
 *  5. Duplicate restoration impossible (409) and paid refunds excluded
 *  6. Reinstatement receipt PDF: confirmation, NOT a new collection —
 *     original + current allocation shown, linked to original payment
 *  7. Money invariant: payment count and totals NEVER change
 *  8. Exit invoice preserved (Finalized) and its four preview buttons intact;
 *     the cancel action lives on the refund detail screen, NOT the preview
 *  9. Payment history shows the reinstatement link; admin-only endpoint
 *
 * Fixtures: house 999976, tenants ZZRI-*, removed afterwards.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const { buildDepositReinstatementHtml } = require('../backend/services/documentStore');

const HOUSE = '999976';

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
    const docs = await query(`SELECT file_path FROM documents WHERE tenant_code LIKE 'ZZRI-%' AND file_path IS NOT NULL`);
    filePaths = docs.rows.map((r) => r.file_path).filter(Boolean);
  } catch (_) {}
  for (const sql of [
    `DELETE FROM deposit_reinstatements WHERE original_tenant_code LIKE 'ZZRI%'`,
    `DELETE FROM documents WHERE tenant_code LIKE 'ZZRI%' OR house_paybill_number = '999976'`,
    `DELETE FROM deposit_refunds WHERE tenant_code LIKE 'ZZRI%'`,
    `DELETE FROM exit_invoices WHERE tenant_code LIKE 'ZZRI%'`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZRI%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZRI%'`,
    `DELETE FROM tenancy_archive WHERE tenant_code LIKE 'ZZRI%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZRI%'`,
    `DELETE FROM houses WHERE paybill_number = '999976'`,
    `DELETE FROM users WHERE username = 'zzri-ops'`,
    `DELETE FROM audit_log WHERE action = 'deposit_refund_cancelled_reinstated' AND details::text LIKE '%ZZRI%'`,
  ]) {
    try { await query(sql, []); } catch (e) { console.error('[cleanup]', e.message); }
  }
  for (const p of filePaths) { try { fs.unlinkSync(p); } catch (_) {} }
}

// Build a full exit + refund fixture for a tenant (finalize creates the
// refund row automatically).
async function makeExitFixture(code, { unitLabel }) {
  await store.createTenant({
    tenant_code: code, name: `ZZRI Tenant ${unitLabel}`, phone_number: '+254700001' + unitLabel.slice(-3).padStart(3, '0'),
    property_name: 'ZZRI House A', house_id: HOUSE, unit_label: unitLabel,
    rent_amount: 0, deposit_amount: 10000, move_in_date: '2026-01-01',
    rent_due_date: '2026-12-05', status: 'Active',
  });
  await query(`UPDATE tenants SET deposit_paid = 10000, unit_label = $2, status = 'Active' WHERE tenant_code = $1`,
    [code, unitLabel]);
  await query(
    `INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, payment_mode, tenancy_id)
     VALUES ($1, 10000, '2026-01-15', 'Approved', 'deposit', $2, $3, 'M-Pesa', NULL)`,
    [code, `R-DEP-${unitLabel}`, `MPESA${unitLabel}`]
  );
  const exit = await store.createExitInvoice(code, { reason: 'test exit' });
  await store.finalizeExitInvoice(exit.id, { move_out_date: '2026-10-25' }, 'test');
  const refund = await store.getDepositRefundByExitInvoice(exit.id);
  return { exit, refund };
}

async function main() {
  await cleanup();
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status) VALUES ($1, 'ZZRI House A', 9, 'unknown')`, [HOUSE]);

  // ── Fixture A: original tenant STILL in the unit (never vacated) ────────
  const A = await makeExitFixture('ZZRI-A1', { unitLabel: 'RI1' });
  check(!!A.refund, `fixture: refund row auto-created on finalize (id ${A.refund && A.refund.id})`);
  await query(`UPDATE tenants SET deposit_paid = 0 WHERE tenant_code = 'ZZRI-A1'`); // money "owed" as refund

  // ── Fixture B: exited + vacated (unit now vacant, profile archived) ─────
  const B = await makeExitFixture('ZZRI-B1', { unitLabel: 'RI2' });
  await store.vacateTenancy('ZZRI-B1', { move_out_date: '2026-10-26', reason: 'test exit', exit_invoice_id: B.exit.id, archived_by: 'test' });
  await query(`UPDATE tenants SET deposit_paid = 0 WHERE tenant_code = 'ZZRI-B1'`);

  // ── Fixture C: exited, then the SAME unit was re-let to another tenant ──
  const C = await makeExitFixture('ZZRI-C1', { unitLabel: 'RI3' });
  await store.vacateTenancy('ZZRI-C1', { move_out_date: '2026-10-26', reason: 'test exit', exit_invoice_id: C.exit.id, archived_by: 'test' });
  await query(`UPDATE tenants SET deposit_paid = 0 WHERE tenant_code = 'ZZRI-C1'`);
  await query(
    `UPDATE tenants SET name = 'ZZRI New Occupant', phone_number = '+254700001999',
            status = 'Active', move_in_date = '2026-11-05'
      WHERE tenant_code = 'ZZRI-C1'`
  );

  // ── Fixture D: same as C (for the hold-option flow) ─────────────────────
  const D = await makeExitFixture('ZZRI-D1', { unitLabel: 'RI4' });
  await store.vacateTenancy('ZZRI-D1', { move_out_date: '2026-10-26', reason: 'test exit', exit_invoice_id: D.exit.id, archived_by: 'test' });
  await query(`UPDATE tenants SET deposit_paid = 0 WHERE tenant_code = 'ZZRI-D1'`);
  await query(
    `UPDATE tenants SET name = 'ZZRI New Occupant 2', phone_number = '+254700001998',
            status = 'Active', move_in_date = '2026-11-06'
      WHERE tenant_code = 'ZZRI-D1'`
  );

  // Vacant target units for reassignment + hold assignment
  for (const [code, rent] of [['ZZRI-RI9', 9500], ['ZZRI-RI8', 8500]]) {
    const unit = code.replace('ZZRI-', '');
    await store.createTenant({
      tenant_code: code, name: `ZZRI Vacant ${unit}`, phone_number: '+254700000000',
      property_name: 'ZZRI House A', house_id: HOUSE, unit_label: unit, rent_amount: rent,
      deposit_amount: 5000, move_in_date: '2026-01-01', rent_due_date: '2026-12-05', status: 'Active',
    });
    await query(`UPDATE tenants SET name = '', phone_number = '', status = 'Vacant' WHERE tenant_code = $1`, [code]);
  }

  // Money invariant baseline (the proposal's core accounting rule)
  const moneyBefore = await query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float8 AS s FROM payments WHERE tenant_code LIKE 'ZZRI%'`
  );

  const app = express();
  app.use(express.json());
  app.use('/api/deposit-refunds', require('../backend/routes/depositRefunds'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const PORT = srv.address().port;
  const admin = (await query(`SELECT id, username, role FROM users WHERE role = 'admin' AND is_active IS DISTINCT FROM false ORDER BY id LIMIT 1`)).rows[0];
  const adminToken = jwt.sign({ sub: admin.id, username: admin.username, role: admin.role }, process.env.JWT_SECRET, { expiresIn: '20m' });
  await query(`INSERT INTO users (username, password_hash, display_name, role, is_active) VALUES ('zzri-ops', 'x', 'ZZRI Operator', 'operator', true)`);
  const ops = (await query(`SELECT id, username, role FROM users WHERE username = 'zzri-ops'`)).rows[0];
  const opsToken = jwt.sign({ sub: ops.id, username: ops.username, role: ops.role }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const call = async (method, p, body, token = adminToken) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/deposit-refunds${p}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };

  try {
    // ── 1. Eligibility (Scenario A) ────────────────────────────────────────
    let r = await call('GET', `/${A.refund.id}/reinstatement-eligibility`);
    check(r.status === 200 && r.json.eligible === true,
      `1. A: eligible (HTTP ${r.status})`, r.json.error);
    const el = r.json;
    check(el.unit_state === 'ORIGINAL_TENANT', `1b. unit state ORIGINAL_TENANT (got ${el.unit_state})`);
    check(el.original.tenant_name === 'ZZRI Tenant RI1' && el.original.tenant_code === 'ZZRI-A1'
      && el.original.unit === 'RI1' && el.original.deposit_amount === 10000,
      '1c. confirmation fields: name/code/unit/deposit', el.original);
    check(el.original.payment_reference === 'MPESARI1' && el.original.payment_date === '2026-01-15'
      && el.original.payment_method === 'M-Pesa' && el.original.payment_receipt === 'R-DEP-RI1',
      '1d. original payment reference/date/method/receipt shown', el.original);
    check(el.exit.exit_number && el.exit.refundable_amount > 0, '1e. refund invoice number + refundable shown', el.exit);

    // Paid refund → NOT eligible (§4)
    await store.updateDepositRefund(A.refund.id, { refund_status: 'refunded', amount_refunded: 10000, refund_date: '2026-10-28' });
    r = await call('GET', `/${A.refund.id}/reinstatement-eligibility`);
    check(r.json.eligible === false && /disbursed/i.test(r.json.reason),
      '1f. disbursed refund refuses the action', r.json.reason);
    await store.updateDepositRefund(A.refund.id, { refund_status: 'pending', amount_refunded: 0, refund_date: null });

    // ── 2. Scenario A: reinstate in place ──────────────────────────────────
    const payCountA = await query(`SELECT COUNT(*)::int AS n FROM payments WHERE tenant_code = 'ZZRI-A1'`);
    r = await call('POST', `/${A.refund.id}/cancel-reinstate`, {
      reason: 'Tenant withdrew the refund request and opted to continue tenancy.', mode: 'same_unit',
    });
    check(r.status === 200, `2. A: reinstate OK (HTTP ${r.status})`, r.json);
    check(r.json.refund.refund_status === 'cancelled_reinstated',
      `2b. refund status Cancelled / Reinstated (got ${r.json.refund.refund_status})`);
    const tA = await store.getTenant('ZZRI-A1');
    check(tA.name === 'ZZRI Tenant RI1' && String(tA.status) === 'Active',
      '2c. profile + code + unit retained, Active status restored');
    check(Number(tA.deposit_paid) === 10000, `2d. deposit restored to 10,000 (got ${tA.deposit_paid})`);
    const payA = (await query(`SELECT * FROM payments WHERE tenant_code = 'ZZRI-A1' AND payment_type = 'deposit'`)).rows[0];
    const localDate = (d) => (d instanceof Date && !isNaN(d))
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      : String(d || '').slice(0, 10);
    check(Number(payA.amount) === 10000 && payA.mpesa_reference === 'MPESARI1'
      && localDate(payA.payment_date) === '2026-01-15',
      '2e. ORIGINAL payment unchanged (amount/ref/date — no new payment)');
    check(payA.origin_house_paybill === HOUSE && payA.origin_unit === 'RI1'
      && payA.allocation_unit === 'RI1' && payA.reinstatement_id,
      '2f. origin snapshot + current allocation + reinstatement link recorded');
    const countA = await query(`SELECT COUNT(*)::int AS n FROM payments WHERE tenant_code = 'ZZRI-A1'`);
    check(countA.rows[0].n === payCountA.rows[0].n, '2g. payment COUNT unchanged (no duplicate payment)');

    // Duplicate restoration attempt
    r = await call('POST', `/${A.refund.id}/cancel-reinstate`, { reason: 'again', mode: 'same_unit' });
    check(r.status === 409 && r.json.code === 'ALREADY_PROCESSED',
      `3. duplicate restoration refused (HTTP ${r.status})`);
    const instCountA = (await query(`SELECT COUNT(*)::int AS n FROM deposit_reinstatements WHERE deposit_refund_id = $1`, [A.refund.id])).rows[0].n;
    check(instCountA === 1, `3b. exactly ONE reinstatement row (${instCountA})`);

    // Admin-only gate
    r = await call('POST', `/${B.refund.id}/cancel-reinstate`, { reason: 'x', mode: 'same_unit' }, opsToken);
    check(r.status === 403, `3c. non-admin refused (HTTP ${r.status})`);

    // ── 4. Scenario B: unit vacant ────────────────────────────────────────
    r = await call('GET', `/${B.refund.id}/reinstatement-eligibility`);
    check(r.json.eligible && r.json.unit_state === 'VACANT',
      `4. B: eligible + VACANT (got ${r.json.unit_state})`);
    r = await call('POST', `/${B.refund.id}/cancel-reinstate`, { reason: 'Unit vacant — tenant returns.', mode: 'same_unit' });
    check(r.status === 200, `4b. B: reinstate OK (HTTP ${r.status})`, r.json);
    const tB = await store.getTenant('ZZRI-B1');
    check(tB.name === 'ZZRI Tenant RI2' && String(tB.status) === 'Active' && Number(tB.deposit_paid) === 10000,
      '4c. vacant row restored: profile + Active + deposit 10,000');
    const payB = (await query(`SELECT * FROM payments WHERE tenant_code = 'ZZRI-B1' AND payment_type = 'deposit'`)).rows[0];
    check(payB.tenancy_id != null && Number(payB.amount) === 10000 && payB.mpesa_reference === 'MPESARI2'
      && payB.allocation_unit === 'RI2' && payB.origin_unit === 'RI2',
      '4d. SEALED original payment untouched + origin/allocation recorded');

    // ── 5. Scenario C: occupied by another tenant ─────────────────────────
    r = await call('GET', `/${C.refund.id}/reinstatement-eligibility`);
    check(r.json.eligible && r.json.unit_state === 'OCCUPIED_BY_OTHER',
      `5. C: OCCUPIED_BY_OTHER detected (got ${r.json.unit_state})`);
    check(r.json.current_occupancy.current_tenant_name === 'ZZRI New Occupant',
      '5b. current occupant identified', r.json.current_occupancy);
    r = await call('POST', `/${C.refund.id}/cancel-reinstate`, { reason: 'x', mode: 'same_unit' });
    check(r.status === 409 && r.json.code === 'UNIT_OCCUPIED',
      `5c. same-unit refused while occupied (HTTP ${r.status})`);

    // Option 1: vacant unit picker + reassignment
    const vac = await (await fetch(`http://127.0.0.1:${PORT}/api/deposit-refunds/vacant-units?house_paybill=${HOUSE}`,
      { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    check((vac.units || []).some((u) => u.unit === 'ZZRI-RI9' && u.rent_amount === 9500),
      '5d. vacant units listed with rent (RI9 9,500)', vac.units);
    const occupantBefore = (await query(`SELECT name, phone_number, move_in_date::text AS mi FROM tenants WHERE tenant_code = 'ZZRI-C1'`)).rows[0];
    const payC = (await query(`SELECT * FROM payments WHERE tenant_code = 'ZZRI-C1' AND payment_type='deposit'`)).rows[0];
    r = await call('POST', `/${C.refund.id}/cancel-reinstate`, {
      reason: 'Original unit re-let; tenant reinstated elsewhere.', mode: 'reassign',
      new_house_paybill: HOUSE, new_unit: 'ZZRI-RI9',
    });
    check(r.status === 200, `5e. reassign OK (HTTP ${r.status})`, r.json);
    check(r.json.reinstatement.outcome === 'REASSIGNED' && r.json.reinstatement.new_unit === 'ZZRI-RI9',
      '5f. outcome REASSIGNED with the confirmed unit');
    const tC9 = await store.getTenant('ZZRI-RI9');
    check(tC9.name === 'ZZRI Tenant RI3' && String(tC9.status) === 'Active'
      && Number(tC9.deposit_paid) === 10000 && Number(tC9.rent_amount) === 9500,
      `5g. original profile landed on RI9 (deposit 10,000, NEW unit rent 9,500)`, { rent: tC9.rent_amount });
    const occupantAfter = (await query(`SELECT name, phone_number, move_in_date::text AS mi FROM tenants WHERE tenant_code = 'ZZRI-C1'`)).rows[0];
    check(occupantAfter.name === occupantBefore.name && occupantAfter.phone === occupantBefore.phone
      && occupantAfter.mi === occupantBefore.mi,
      '5h. CURRENT occupant completely untouched (§11)');
    const payC2 = (await query(`SELECT * FROM payments WHERE id = $1`, [payC.id])).rows[0];
    check(Number(payC2.amount) === Number(payC.amount) && payC2.mpesa_reference === payC.mpesa_reference
      && String(payC2.payment_date) === String(payC.payment_date),
      '5i. original payment source unchanged (amount/ref/date)');
    check(payC2.origin_house_paybill === HOUSE && payC2.origin_unit === 'RI3'
      && payC2.origin_tenant_code === 'ZZRI-C1'
      && payC2.allocation_unit === 'ZZRI-RI9' && payC2.allocation_tenant_code === 'ZZRI-RI9',
      '5j. ORIGIN (RI3, old code) vs CURRENT ALLOCATION (RI9) both recorded', {
        origin_unit: payC2.origin_unit, alloc_unit: payC2.allocation_unit,
      });

    // Option 2: hold deposit, then assign later
    r = await call('POST', `/${D.refund.id}/cancel-reinstate`, { reason: 'Hold deposit while awaiting a unit.', mode: 'hold' });
    check(r.status === 200 && r.json.reinstatement && r.json.reinstatement.outcome === 'DEPOSIT_ONLY',
      `6. Option 2: deposit held without a unit (HTTP ${r.status})`, r.json);
    const holdRow = await store.getTenant('ZZRI-D1-R');
    check(holdRow && String(holdRow.status) === 'Vacant' && Number(holdRow.deposit_paid) === 10000
      && holdRow.name === 'ZZRI Tenant RI4',
      '6b. holding profile keeps deposit + original identity, occupies nothing');
    const tD = await store.getTenant('ZZRI-D1');
    check(tD.name === 'ZZRI New Occupant 2', '6c. current occupant of original unit still untouched');
    const instD = r.json.reinstatement;
    r = await call('POST', `/reinstatements/${instD.id}/assign-unit`, { new_house_paybill: HOUSE, new_unit: 'ZZRI-RI8' });
    check(r.status === 200, `6d. later assignment OK (HTTP ${r.status})`, r.json);
    const tR8 = await store.getTenant('ZZRI-RI8');
    check(tR8 && tR8.name === 'ZZRI Tenant RI4' && String(tR8.status) === 'Active' && Number(tR8.deposit_paid) === 10000,
      '6e. held deposit delivered to the confirmed new unit');
    check((await query(`SELECT COUNT(*)::int AS n FROM tenants WHERE tenant_code = 'ZZRI-D1-R'`)).rows[0].n === 0,
      '6f. holding profile removed after assignment (audited)');
    const payD = (await query(`SELECT * FROM payments WHERE tenant_code = 'ZZRI-D1' AND payment_type='deposit'`)).rows[0];
    check(payD.allocation_unit === 'ZZRI-RI8' && payD.origin_unit === 'RI4',
      '6g. allocation moved to RI8, ORIGIN still RI4 (§9)');
    r = await call('POST', `/reinstatements/${instD.id}/assign-unit`, { new_house_paybill: HOUSE, new_unit: 'ZZRI-RI9' });
    check(r.status === 409, `6h. re-assign refused after outcome changed (HTTP ${r.status})`);

    // ── 7. Reinstatement receipt (§8) ─────────────────────────────────────
    const instC = (await query(`SELECT * FROM deposit_reinstatements WHERE deposit_refund_id = $1`, [C.refund.id])).rows[0];
    const tenantNow = await store.getTenant('ZZRI-RI9');
    const exitC = await store.getExitInvoice(C.exit.id);
    const html = buildDepositReinstatementHtml(instC, tenantNow, exitC);
    [
      'DEPOSIT REINSTATEMENT RECEIPT', 'ZZRI Tenant RI3', 'MPESARI3', 'R-DEP-RI3',
      'Deposit Reinstatement / Transfer to New Unit', exitC.exit_number,
      'Original payment source', 'Current allocation', 'not a new payment',
      'ZZRI-RI9', 'no new payment reference',
    ].forEach((needle, i) => check(html.includes(needle), `7.${i} receipt shows: ${needle.slice(0, 52)}`));
    const instRow = (await query(`SELECT receipt_document_id FROM deposit_reinstatements WHERE id = $1`, [instC.id])).rows[0];
    check(!!instRow.receipt_document_id, '7b. receipt document registered + linked');
    if (instRow.receipt_document_id) {
      const doc = (await query(`SELECT * FROM documents WHERE id = $1`, [instRow.receipt_document_id])).rows[0];
      const head = Buffer.alloc(5);
      const fd = fs.openSync(doc.file_path, 'r'); fs.readSync(fd, head, 0, 5, 0); fs.closeSync(fd);
      check(head.toString() === '%PDF-', '7c. valid PDF');
      check(doc.doc_type === 'deposit_reinstatement' && doc.payment_id === payC.id,
        '7d. doc linked to the ORIGINAL deposit payment (doc_type deposit_reinstatement)');
    }

    // Payment history surface (§8: viewable from Payments)
    const forPay = await (await fetch(`http://127.0.0.1:${PORT}/api/deposit-refunds/reinstatements/for-payments?ids=${payC.id}`,
      { headers: { Authorization: `Bearer ${adminToken}` } })).json();
    check((forPay.reinstatements || []).length === 1 && forPay.reinstatements[0].receipt_document_id,
      '7e. payment history can surface the reinstatement receipt');

    // ── 8. Money invariant + preserved exit invoice/buttons ───────────────
    const moneyAfter = await query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float8 AS s FROM payments WHERE tenant_code LIKE 'ZZRI%'`
    );
    check(moneyAfter.rows[0].n === moneyBefore.rows[0].n && moneyAfter.rows[0].s === moneyBefore.rows[0].s,
      `8. payment count & totals NEVER changed (${moneyAfter.rows[0].n} rows / KES ${moneyAfter.rows[0].s})`,
      { before: moneyBefore.rows[0], after: moneyAfter.rows[0] });
    const exits = (await query(`SELECT status FROM exit_invoices WHERE tenant_code LIKE 'ZZRI%'`)).rows;
    check(exits.length >= 4 && exits.every((e) => e.status === 'Finalized'),
      `8b. all exit invoices preserved Finalized (${exits.length})`);
    const idx = await (await fetch('http://127.0.0.1:3003/')).text();
    ['btn-ei-download', 'btn-ei-send', 'btn-ei-both', 'btn-ei-cancel'].forEach((id, i) =>
      check(idx.includes(`id="${id}"`), `8c.${i} exit preview button intact: ${id}`));
    const cancelAt = idx.indexOf('btn-dr-cancel-reinstate');
    const actionsAt = idx.indexOf('id="dr-detail-actions"');
    check(cancelAt > actionsAt && cancelAt > 0,
      '8d. cancel action lives on the refund detail screen (not the exit preview)');
    check(idx.includes('id="dr-reinstate-modal"') && idx.includes('btn-ri-reassign') && idx.includes('btn-ri-hold'),
      '8e. confirmation window with both scenario-C options served');
    const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js')).text();
    check(appJs.includes('openDrReinstateModal') && appJs.includes('submitRi')
      && appJs.includes('data-rein-view') && appJs.includes('cancelled_reinstated'),
      '8f. reinstatement UI + payments badge + status served');

    // Audit trail (§13)
    const audits = (await query(
      `SELECT details FROM audit_log WHERE action = 'deposit_refund_cancelled_reinstated' ORDER BY id`
    )).rows;
    check(audits.length >= 4, `9. audit entries written (${audits.length})`);
    const a0 = JSON.parse(audits[0].details);
    check(a0.refund_invoice_number && a0.original_payment_reference && a0.reason && a0.restored_deposit,
      '9b. audit carries refund no, original ref, reason, restored amount', a0);

    console.log('\n(no real messages were sent)');
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
