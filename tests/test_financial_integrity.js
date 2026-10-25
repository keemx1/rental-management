/**
 * Acceptance test — financial integrity: validation, origin, archive-instead-
 * of-delete, database-level constraints and audit trail.
 *
 * Covers (client requirements):
 *  - every financial record ties to a valid property + unit + tenant
 *  - payments/parse/receipts/WhatsApp cannot be created against incomplete
 *    or non-existent tenancies (rejected at app layer AND at the DB layer)
 *  - payment records can never be re-linked to another tenant (DB trigger)
 *  - deleting/vacating archives the complete history — never a blank archive
 *  - ON DELETE RESTRICT: history can never disappear with a tenant row
 *  - payments carry an origin (`source`) and every insert/approval is
 *    written to audit_log by the database itself
 *
 * Fixtures use unit codes ZZFIN-* and are fully removed afterwards.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const store = require('../backend/storage/store');
const { query } = require('../backend/config/database');

const CODE = 'ZZFIN-01';       // valid tenant fixture
const GHOST = 'ZZFIN-GHOST';   // never-created unit code
const BLANK = 'ZZFIN-BLANK';   // nameless tenant fixture
const OTHER = 'ZZFIN-OTHER';   // second valid tenant (relink target)
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
    `DELETE FROM future_payments WHERE future_tenancy_id IN (SELECT id FROM future_tenancies WHERE tenant_code LIKE 'ZZFIN-%')`,
    `DELETE FROM future_tenancies WHERE tenant_code LIKE 'ZZFIN-%'`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZFIN-%'`,
    `DELETE FROM penalties WHERE tenant_code LIKE 'ZZFIN-%'`,
    `DELETE FROM water_invoices WHERE tenant_code LIKE 'ZZFIN-%'`,
    `DELETE FROM deposit_applications WHERE tenant_code LIKE 'ZZFIN-%'`,
    `DELETE FROM deposit_refunds WHERE tenant_code LIKE 'ZZFIN-%'`,
    `DELETE FROM exit_invoices WHERE tenant_code LIKE 'ZZFIN-%'`,
    `DELETE FROM tenancy_archive WHERE tenant_code LIKE 'ZZFIN-%'`,
    `DELETE FROM documents WHERE tenant_code LIKE 'ZZFIN-%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZFIN-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZFIN-%'`,
    `DELETE FROM audit_log WHERE entity_id LIKE 'ZZFIN-%'`,
  ];
  for (const sql of stmts) {
    try { await query(sql); } catch (_) { /* nothing to clean */ }
  }
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
  const house = (await query(`SELECT paybill_number FROM houses ORDER BY paybill_number LIMIT 1`)).rows[0];

  // ── 1. Non-existent tenant: rejected at the app layer ─────────────────────
  const p1 = await store.createPayment({ tenant_id: GHOST, amount: 1000, status: 'Pending', client_txn_id: 'zzfin-ghost-1' });
  check(p1 && p1.error && p1.code === 'INCOMPLETE_TENANCY', '1. payment to non-existent tenant rejected', p1);

  // ── 2. Nameless (incomplete) tenant: rejected ─────────────────────────────
  await store.createTenant({
    tenant_code: BLANK, name: 'ZZFIN Temp', phone_number: '+254700000201',
    property_name: 'ZZ Integrity', house_id: house.paybill_number,
    rent_amount: 5000, rent_due_date: '2026-12-05', move_in_date: '2026-11-01', status: 'Active',
  });
  await query(`UPDATE tenants SET name = '' WHERE tenant_code = $1`, [BLANK]);
  const p2 = await store.createPayment({ tenant_id: BLANK, amount: 500, status: 'Pending', client_txn_id: 'zzfin-blank-1' });
  check(p2 && p2.error && p2.code === 'INCOMPLETE_TENANCY', '2. payment to nameless tenancy rejected', p2);

  // ── 3. Vacant unit: rejected ──────────────────────────────────────────────
  await store.createTenant({
    tenant_code: OTHER, name: 'ZZFIN Other', phone_number: '+254700000202',
    property_name: 'ZZ Integrity', house_id: house.paybill_number,
    rent_amount: 6000, rent_due_date: '2026-12-05', move_in_date: '2026-11-01', status: 'Vacant',
  });
  const p3 = await store.createPayment({ tenant_id: OTHER, amount: 700, status: 'Pending', client_txn_id: 'zzfin-vac-1' });
  check(p3 && p3.error && p3.code === 'INCOMPLETE_TENANCY', '3. payment to vacant unit rejected', p3);

  // ── 4. Valid tenancy: accepted with recorded origin ───────────────────────
  await store.createTenant({
    tenant_code: CODE, name: 'ZZFIN Valid Tenant', phone_number: '+254700000200',
    property_name: 'ZZ Integrity', house_id: house.paybill_number,
    rent_amount: 8000, deposit_amount: 2000, rent_due_date: '2026-12-05',
    move_in_date: '2026-11-01', status: 'Active',
  });
  const p4 = await store.createPayment({
    tenant_id: CODE, amount: 8000, status: 'Pending', payment_type: 'rent',
    client_txn_id: 'zzfin-ok-1', source: 'manual',
  });
  check(p4 && !p4.error && p4.id, '4. valid tenancy accepted', p4);
  const srcRow = await query(`SELECT source FROM payments WHERE id = $1`, [p4.id]);
  check(srcRow.rows[0] && srcRow.rows[0].source === 'manual', '4b. origin recorded on the payment row', srcRow.rows[0]);

  // ── 5. Route layer: 404 for missing unit, 409 for incomplete tenancy ──────
  const token = await makeToken();
  const ghostRes = await fetch(`${BASE}/payments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: GHOST, amount: 500 }),
  });
  check(ghostRes.status === 404, `5. POST /payments to non-existent unit -> 404 (got ${ghostRes.status})`);
  const blankRes = await fetch(`${BASE}/payments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: BLANK, amount: 500 }),
  });
  check(blankRes.status === 409, `5b. POST /payments to incomplete tenancy -> 409 (got ${blankRes.status})`);

  // ── 6. DB trigger: raw INSERT with invalid tenant fails ───────────────────
  let trigErr = null;
  try {
    await query(
      `INSERT INTO payments (tenant_code, amount, status, payment_date, source)
       VALUES ($1, 100, 'Pending', CURRENT_DATE, 'manual')`, [GHOST]
    );
  } catch (e) { trigErr = e; }
  check(!!trigErr, '6. database trigger rejects raw payment insert for invalid tenancy', trigErr && trigErr.message);

  // ── 7. DB trigger: re-linking a payment to another tenant fails ───────────
  let relinkErr = null;
  try {
    await query(`UPDATE payments SET tenant_code = $1 WHERE id = $2`, [OTHER, p4.id]);
  } catch (e) { relinkErr = e; }
  check(!!relinkErr, '7. database trigger blocks payment re-linking to another tenant', relinkErr && relinkErr.message);
  const afterRelink = await query(`SELECT tenant_code FROM payments WHERE id = $1`, [p4.id]);
  check(afterRelink.rows[0].tenant_code === CODE, '7b. payment still tied to original tenant');

  // ── 8. Approval blocked when the tenancy became incomplete ────────────────
  await query(`UPDATE tenants SET name = '' WHERE tenant_code = $1`, [CODE]);
  const apr = await store.approvePayment(p4.id);
  check(apr && apr.error && apr.code === 'INCOMPLETE_TENANCY',
    '8. approval blocked for incomplete tenancy (no receipt / no WhatsApp possible)', apr);
  const stillPending = await query(`SELECT status FROM payments WHERE id = $1`, [p4.id]);
  check(stillPending.rows[0].status === 'Pending', '8b. payment left Pending (nothing generated)');
  await query(`UPDATE tenants SET name = 'ZZFIN Valid Tenant' WHERE tenant_code = $1`, [CODE]);

  // ── 9. Valid approval works + DB writes the audit trail ───────────────────
  const aprOk = await store.approvePayment(p4.id);
  check(aprOk && !aprOk.error && aprOk.payment, '9. valid approval succeeds', aprOk && aprOk.error);
  const audInsert = await query(
    `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'financial_record_inserted'
       AND entity_type = 'payments' AND entity_id = $1 AND details LIKE '%ZZFIN-%'`,
    [String(p4.id)]
  );
  check(audInsert.rows[0].n >= 1, '9b. DB audit: payment insert logged with origin');
  const audApprove = await query(
    `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'financial_payment_approved'
       AND entity_type = 'payments' AND entity_id = $1`,
    [String(p4.id)]
  );
  check(audApprove.rows[0].n >= 1, '9c. DB audit: approval logged');

  // ── 10. Raw exit invoice insert for ghost tenant fails (DB level) ─────────
  let eiErr = null;
  try {
    await query(
      `INSERT INTO exit_invoices (exit_number, tenant_code, status, lines)
       VALUES ('ZZFIN-EXT-1', $1, 'Draft', '[]'::jsonb)`, [GHOST]
    );
  } catch (e) { eiErr = e; }
  check(!!eiErr, '10. database trigger rejects exit invoice for invalid tenancy', eiErr && eiErr.message);

  // ── 11. Delete = archive complete history, never destroy ──────────────────
  const del = await store.deleteTenant(CODE, 'test');
  check(del && del.archived === true, '11. deleteTenant archives the tenancy instead of deleting it', del);
  const arc = await query(
    `SELECT id, tenant_name, payments FROM tenancy_archive WHERE tenant_code = $1 ORDER BY archived_at DESC LIMIT 1`,
    [CODE]
  );
  check(arc.rows.length === 1 && arc.rows[0].tenant_name === 'ZZFIN Valid Tenant',
    '11b. archive holds the complete identity (not blank)', arc.rows[0] && arc.rows[0].tenant_name);
  const snapPays = typeof arc.rows[0].payments === 'string' ? JSON.parse(arc.rows[0].payments) : arc.rows[0].payments;
  check(Array.isArray(snapPays) && snapPays.length === 1,
    `11c. archive snapshot holds the payment (${snapPays && snapPays.length}/1)`);
  const payStill = await query(`SELECT COUNT(*)::int AS n FROM payments WHERE tenant_code = $1`, [CODE]);
  check(payStill.rows[0].n === 1, '11d. payment rows still exist after "delete"');
  const tenantRow = await query(`SELECT status, name FROM tenants WHERE tenant_code = $1`, [CODE]);
  check(tenantRow.rows.length === 1 && tenantRow.rows[0].status === 'Vacant',
    '11e. unit row preserved as Vacant placeholder', tenantRow.rows[0]);

  // ── 12. ON DELETE RESTRICT: hard deletion of a tenant with history fails ──
  let restrictErr = null;
  try {
    await query(`DELETE FROM tenants WHERE tenant_code = $1`, [CODE]);
  } catch (e) { restrictErr = e; }
  check(!!restrictErr && restrictErr.code === '23503',
    '12. database RESTRICT blocks hard delete of a tenant with financial history', restrictErr && restrictErr.message);
  const survived = await query(`SELECT COUNT(*)::int AS n FROM payments WHERE tenant_code = $1`, [CODE]);
  check(survived.rows[0].n === 1, '12b. history intact after blocked delete');

  // ── 13. Vacating a blank unit must not create a blank archive ─────────────
  const vac = await store.vacateTenancy(BLANK, { reason: 'test blank vacate' });
  check(vac && vac.error && vac.code === 'NOTHING_TO_ARCHIVE',
    '13. vacating a nameless unit with no history refuses blank archive', vac);
  const blankArchives = await query(
    `SELECT COUNT(*)::int AS n FROM tenancy_archive WHERE tenant_code = $1`, [BLANK]
  );
  check(blankArchives.rows[0].n === 0, '13b. no blank archive record created');

  // ── 14. Empty placeholder CAN still be deleted outright ───────────────────
  await query(`UPDATE tenants SET name = '', status = 'Vacant' WHERE tenant_code = $1`, [OTHER]);
  const delEmpty = await store.deleteTenant(OTHER, 'test');
  check(delEmpty === true, '14. empty placeholder unit deletes cleanly', delEmpty);
  const gone = await query(`SELECT COUNT(*)::int AS n FROM tenants WHERE tenant_code = $1`, [OTHER]);
  check(gone.rows[0].n === 0, '14b. placeholder row removed');
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
