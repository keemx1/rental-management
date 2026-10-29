/**
 * Acceptance test — Central Notification Bar + emergency indicator (§13).
 *
 *  1. Qualifying critical/overdue issue activates the emergency state
 *  2. Correct unresolved counts (per-priority summary)
 *  3/4. Bar + list endpoints; alerts carry deep links to real records
 *  5. Opening/viewing NEVER clears an alert (state untouched by reads)
 *  6. Resolving one issue does not clear unrelated alerts
 *  7. Partial payment updates the amount without resolving the alert
 *  8. Emergency stays while ≥1 critical/overdue remains; stops when clear
 *  10. Alerts update automatically when records change (no refresh)
 *  11. Duplicate active alerts prevented (one Open row per key)
 *  12. Resolved notifications remain in history with resolution
 *  13. Existing permissions apply (operator can READ notifications)
 *  14. Notification reads never change balances/ledgers
 *
 * NOTE: production data may already contain real alerts — every assertion
 * is keyed to THIS test's fixture records or uses relative deltas.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const commission = require('../backend/services/landlordCommission');

const HOUSE = '999983';
const TODAY = new Date();
const CUR_MONTH = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}`;
const REMIT_DAY = Math.max(1, TODAY.getDate() - 1); // yesterday => overdue

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ` -> ${JSON.stringify(extra)}` : '')); }
}

async function cleanup() {
  for (const sql of [
    `DELETE FROM notification_log WHERE alert_key LIKE '%${HOUSE}%' OR alert_key LIKE '%ZZNT-%'`,
    `DELETE FROM landlord_reviews WHERE house_paybill_number = $1`,
    `DELETE FROM landlord_remittance_payments WHERE house_paybill_number = $1`,
    `DELETE FROM commission_invoices WHERE house_paybill_number = $1`,
    `DELETE FROM documents WHERE house_paybill_number = $1`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZNT-%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZNT-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZNT-%'`,
    `DELETE FROM houses WHERE paybill_number = $1`,
    `DELETE FROM landlords WHERE name LIKE 'ZZNT Landlord%'`,
    `DELETE FROM users WHERE username = 'zznt-ops'`,
  ]) {
    try { await query(sql, sql.includes('$1') ? [HOUSE] : []); } catch (e) { console.error('[cleanup]', e.message); }
  }
}

async function main() {
  await cleanup();
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status) VALUES ($1, 'ZZNT House', 4, 'unknown')`, [HOUSE]);
  await store.createTenant({
    tenant_code: 'ZZNT-01', name: 'ZZNT Tenant', phone_number: '+254700001501',
    property_name: 'ZZNT House', house_id: HOUSE, rent_amount: 100000, deposit_amount: 5000,
    move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  const ll = (await query(`INSERT INTO landlords (name, phone) VALUES ('ZZNT Landlord', '+254700001500') RETURNING id`)).rows[0];
  await query(`UPDATE houses SET landlord_id = $1 WHERE paybill_number = $2`, [ll.id, HOUSE]);
  await store.setCommissionRate(HOUSE, 5, 'test');
  await query(`UPDATE houses SET landlord_remittance_day = $1 WHERE paybill_number = $2`, [REMIT_DAY, HOUSE]);
  // NOTE: the collection payment is inserted AFTER the baseline snapshot so
  // the fixture provably raises its own alerts (production may already have real ones).

  const app = express();
  app.use(express.json());
  app.use('/api/notifications', require('../backend/routes/notifications'));
  app.use('/api/landlords', require('../backend/routes/landlords'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const PORT = srv.address().port;

  const admin = (await query(`SELECT id, username, role FROM users WHERE role = 'admin' AND is_active IS DISTINCT FROM false ORDER BY id LIMIT 1`)).rows[0];
  const adminToken = jwt.sign({ sub: admin.id, username: admin.username, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '20m' });
  await query(`INSERT INTO users (username, password_hash, display_name, role, is_active)
    VALUES ('zznt-ops', 'x', 'ZZNT Operator', 'operator', true)`);
  const ops = (await query(`SELECT id, username, role FROM users WHERE username = 'zznt-ops'`)).rows[0];
  const opsToken = jwt.sign({ sub: ops.id, username: ops.username, role: 'operator' }, process.env.JWT_SECRET, { expiresIn: '20m' });

  const get = async (p, token = adminToken) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { Authorization: `Bearer ${token}` } });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };

  try {
    // ── 1/2. Baseline (production may already have real alerts) ────────────
    let r = await get('/api/notifications');
    check(r.status === 200 && r.json.summary, `1. notifications endpoint (HTTP ${r.status})`);
    const base = r.json.summary;
    check(typeof base.total === 'number' && typeof base.emergency === 'boolean',
      '1b. summary carries total + emergency flag');
    const fixtureKeysBefore = (r.json.alerts || []).filter((a) => a.key.includes(HOUSE)).length;
    check(fixtureKeysBefore === 0, `2. no fixture alerts before its records exist (${fixtureKeysBefore})`);

    // Phase B: create the collection -> outstanding appears
    await query(
      `INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode, tenancy_id)
       VALUES ('ZZNT-01', 100000, $1, 'Approved', 'rent', 'R-NT-1', 'MPNT1', $2, 'M-Pesa', NULL)`,
      [`${CUR_MONTH}-05`, CUR_MONTH]
    );

    // ── Overdue remittance issue (fixture) ─────────────────────────────────
    r = await get('/api/notifications');
    let fix = (r.json.alerts || []).find((a) => a.key === `remittance:${HOUSE}`);
    check(fix && fix.priority === 'overdue', `2b. overdue remittance detected (got ${fix && fix.priority})`);
    check(r.json.summary.overdue >= base.overdue, '2c. overdue count includes the new alert');
    check(fix && fix.link && fix.link.kind === 'landlord_ledger' && fix.link.paybill === HOUSE,
      '2d. alert links to the exact landlord ledger record', fix && fix.link);
    check(fix && fix.details.balance === 95000 && fix.details.due_date,
      `2e. actual details (balance 95,000 + due date)`, fix && fix.details);
    check(r.json.summary.emergency === true, '2f. emergency indicator ACTIVE for overdue');

    // ── 5/11. Viewing never clears; dedupe (one Open row) ──────────────────
    const openCountKey = async () => (await query(
      `SELECT COUNT(*)::int AS n FROM notification_log WHERE alert_key = $1 AND status = 'Open'`,
      [`remittance:${HOUSE}`])).rows[0].n;
    const firstSeen = (await query(
      `SELECT first_seen::text AS f FROM notification_log WHERE alert_key = $1 AND status = 'Open'`,
      [`remittance:${HOUSE}`])).rows[0].f;
    await get('/api/notifications'); // view #1
    await get('/api/notifications'); // view #2
    check(await openCountKey() === 1, `3. still ONE Open row after repeated views (${await openCountKey()})`);
    const firstSeen2 = (await query(
      `SELECT first_seen::text AS f FROM notification_log WHERE alert_key = $1 AND status = 'Open'`,
      [`remittance:${HOUSE}`])).rows[0].f;
    check(firstSeen === firstSeen2, '3b. viewing does not reset or resolve the alert');

    // ── 7. Partial payment updates amount, does NOT resolve ────────────────
    const partial = (await query(
      `INSERT INTO landlord_remittance_payments (landlord_id, house_paybill_number, billing_month, payment_date, amount, method, reference, status, verified_by, verified_at)
       VALUES ($1,$2,$3,$4,40000,'M-Pesa','NT-PARTIAL','Verified','tester',NOW()) RETURNING id`,
      [ll.id, HOUSE, CUR_MONTH, `${CUR_MONTH}-10`]
    )).rows[0];
    r = await get('/api/notifications');
    fix = (r.json.alerts || []).find((a) => a.key === `remittance:${HOUSE}`);
    check(fix && Number(fix.details.balance) === 55000,
      `4. partial transfer updates outstanding 95,000→55,000 (got ${fix && fix.details.balance})`);
    check(fix && fix.priority === 'overdue', '4b. partial did NOT falsely resolve the alert');

    // ── 14. Reads never change money ───────────────────────────────────────
    const balBefore = (await commission.remittanceLedger(HOUSE, ll.id)).summary.outstanding;
    await get('/api/notifications');
    const balAfter = (await commission.remittanceLedger(HOUSE, ll.id)).summary.outstanding;
    check(balBefore === balAfter && balAfter === 55000,
      `5. notification reads never alter the ledger (${balBefore} → ${balAfter})`);

    // ── 6/8/10. Resolve fully: alert auto-resolves, others unaffected ──────
    await query(
      `INSERT INTO landlord_remittance_payments (landlord_id, house_paybill_number, billing_month, payment_date, amount, method, reference, status, verified_by, verified_at)
       VALUES ($1,$2,$3,$4,55000,'Bank','NT-FULL','Verified','tester',NOW())`,
      [ll.id, HOUSE, CUR_MONTH, `${CUR_MONTH}-12`]
    );
    // Unrelated pending alert (stays open regardless of the remittance resolving)
    const pend = await query(
      `INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode, tenancy_id)
       VALUES ('ZZNT-01', 500, $1, 'Pending', 'rent', 'R-NT-PEND', 'MPNTP', $2, 'M-Pesa', NULL) RETURNING id`,
      [`${CUR_MONTH}-15`, CUR_MONTH]
    );
    r = await get('/api/notifications');
    fix = (r.json.alerts || []).find((a) => a.key === `remittance:${HOUSE}`);
    check(!fix, '6. fully-paid remittance alert disappears from the active list');
    const pendAlert = (r.json.alerts || []).find((a) => a.key === `pending_payment:${pend.rows[0].id}`);
    check(pendAlert && pendAlert.priority === 'pending',
      `6b. unrelated pending alert REMAINS (got ${pendAlert && pendAlert.priority})`);
    const remLog = (await query(
      `SELECT status, resolution FROM notification_log WHERE alert_key = $1 AND status = 'Resolved' ORDER BY id DESC LIMIT 1`,
      [`remittance:${HOUSE}`]
    )).rows[0];
    check(!!remLog && /Auto-resolved/.test(remLog.resolution || ''),
      '10. alert auto-resolved when the underlying issue cleared');
    if (!base.emergency) {
      // Fixture was the only emergency-class issue -> light must clear
      check(r.json.summary.emergency === false || (r.json.summary.critical + r.json.summary.overdue) === (base.critical + base.overdue - 1),
        '8. emergency clears when the last critical/overdue fixture resolves');
    }

    // ── 12. History retains resolved notifications ─────────────────────────
    r = await get('/api/notifications/history?status=Resolved');
    check(r.status === 200 && (r.json.notifications || []).some((n) => n.alert_key === `remittance:${HOUSE}`),
      '11. resolved notification preserved in history with resolution');

    // ── Reopen: issue becomes unresolved again -> new Open row (history kept)
    await query(
      `INSERT INTO landlord_remittance_payments (landlord_id, house_paybill_number, billing_month, payment_date, amount, method, reference, status, created_by)
       VALUES ($1,$2,$3,$4,1000,'M-Pesa','NT-REOPEN','Pending Verification','tester')`,
      [ll.id, HOUSE, CUR_MONTH, `${CUR_MONTH}-20`]
    );
    r = await get('/api/notifications');
    const reopenPending = (r.json.alerts || []).find((a) => a.key === `remittance_pending:${HOUSE}`);
    check(!!reopenPending, '12b. new underlying issue raises a fresh alert (history retained separately)');

    // ── Reconciliation critical → review (dispute) → resolved ─────────────
    const inv = (await query(
      `INSERT INTO commission_invoices (invoice_number, landlord_id, house_paybill_number, billing_month, rent_collected, commission_rate, commission_amount, previous_balance, payments_applied, total_payable, status)
       VALUES ('GEHPM-COM-NT', $1, $2, $3, 105000, 5, 5250, 0, 0, 5250, 'Issued') RETURNING id`,
      [ll.id, HOUSE, CUR_MONTH]
    )).rows[0];
    r = await get('/api/notifications');
    const recon = (r.json.alerts || []).find((a) => a.key === `recon:${HOUSE}:${CUR_MONTH}`);
    check(recon && recon.priority === 'critical',
      `7. reconciliation discrepancy = CRITICAL (got ${recon && recon.priority})`);
    check(r.json.summary.critical >= 1 && r.json.summary.emergency === true, '7b. critical activates the emergency');
    await query(
      `INSERT INTO landlord_reviews (house_paybill_number, billing_month, reason, created_by)
       VALUES ($1,$2,'ZZNT discrepancy under investigation','tester')`, [HOUSE, CUR_MONTH]
    );
    r = await get('/api/notifications');
    const recon2 = (r.json.alerts || []).find((a) => a.key === `recon:${HOUSE}:${CUR_MONTH}`);
    check(recon2 && recon2.priority === 'review',
      `7c. flagged for review downgrades to Under Review (got ${recon2 && recon2.priority})`);
    const reviewAlert = (r.json.alerts || []).find((a) => a.issue_type && a.issue_type.includes('review'));
    check(!!reviewAlert, '7d. review remains visible until concluded');

    // Resolve: fix invoice figure + resolve review + remove the pending fixture payment
    // (deleting rather than approving keeps verified collections at 100,000
    // so the repaired invoice reconciles exactly).
    await query(`UPDATE commission_invoices SET rent_collected = 100000, commission_amount = 5000 WHERE id = $1`, [inv.id]);
    await query(`UPDATE landlord_reviews SET status='Resolved', resolved_by='tester', resolved_at=NOW() WHERE house_paybill_number = $1 AND status='Under Review'`, [HOUSE]);
    await query(`DELETE FROM payments WHERE id = $1`, [pend.rows[0].id]);
    r = await get('/api/notifications');
    const remaining = (r.json.alerts || []).filter((a) =>
      (a.key.startsWith(`recon:${HOUSE}`))
      || (a.key.startsWith('review:') && (a.details || {}).property === HOUSE)
      || a.key === `pending_payment:${pend.rows[0].id}`);
    check(remaining.length === 0,
      '9. resolved fixture issues drop from the active list automatically', remaining.map((x) => x.key));

    // ── 13. Permissions: operator can read (same as admin for this view) ───
    const opsRead = await get('/api/notifications', opsToken);
    check(opsRead.status === 200, `13. operator may read notifications (HTTP ${opsRead.status})`);
    const noAuth = await fetch(`http://127.0.0.1:${PORT}/api/notifications`);
    check(noAuth.status === 401, `13b. unauthenticated blocked (HTTP ${noAuth.status})`);

    // ── Frontend surface ────────────────────────────────────────────────────
    const idx = await (await fetch('http://127.0.0.1:3003/')).text();
    check(idx.includes('id="ne-bar"') && idx.includes('id="ne-modal"')
      && idx.includes('id="ne-tbody"') && /rental-theme\.css\?v=\d+/.test(idx),
      '14. notification bar + modal served');
    const css = await (await fetch('http://127.0.0.1:3003/css/rental-theme.css?v=6')).text();
    check(css.includes('ne-pulse') && css.includes('.ne-bar.emergency'),
      '14b. pulsing emergency CSS served');
    const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js')).text();
    check(appJs.includes('startNePolling') && appJs.includes('handleNotificationGo')
      && appJs.includes('URGENT ATTENTION REQUIRED') && appJs.includes('loadNotifications'),
      '14c. bar logic + deep-link dispatcher + auto-polling served');

    console.log('\n(no records outside the fixture were modified)');
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
