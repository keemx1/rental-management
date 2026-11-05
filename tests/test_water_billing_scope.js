/**
 * Regression - water billing uses WATER-ONLY invoices and the month's full charges.
 *
 * Root cause fixed 2026-11-05: the legacy "MONTHLY RENT & UTILITY" rows bundled
 * rent + garbage + water into one total; billing pulled the WHOLE water_invoices
 * register (and previous billing periods) into the current bill (SS6 showed
 * water 9,481 + rent 9,000 = 18,681 instead of water 180 + rent 12,000 +
 * garbage 200 = 12,380). Also the message's "Monthly Rent" showed the remaining
 * amount after earlier partial payments instead of the month's full rent.
 *
 * Verifies:
 *  1. Water owed = water-only invoices (bundled rent+utility rows excluded),
 *     exit-summary billing matches (rent + garbage + water-only)
 *  2. Parse preview: water = this cycle's water-only invoice, Monthly Rent =
 *     full month rent, total = the month's billing; no bundled figures leak
 *  3. Approval allocation settles garbage -> water -> rent exactly; the
 *     bundled legacy row is never touched by water settling; the register
 *     twin settles; the confirmation matches the preview
 *  4. Payment deletion reopens the settled water invoice + restores the
 *     register balance (delete-reversal sync)
 *
 * Fixtures: house 999994, tenant ZZWA01, removed afterwards. No sends.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const jwt = require('jsonwebtoken');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const { buildPaymentConfirmation } = require('../backend/services/messages');

const CODE = 'ZZWA01';
const HOUSE = '999994';
let pass = 0, fail = 0;
const failures = [];
const check = (ok, label, extra) => {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};

async function cleanup() {
  for (const sql of [
    `DELETE FROM invoice_payment_links WHERE payment_id IN (SELECT id FROM payments WHERE tenant_code LIKE 'ZZWA%')`,
    `DELETE FROM invoice_register WHERE tenant_code LIKE 'ZZWA%'`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZWA%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZWA%'`,
    `DELETE FROM audit_log WHERE entity_id LIKE 'ZZWA%' OR details::text LIKE '%ZZWA%'`,
    `DELETE FROM water_invoices WHERE tenant_code LIKE 'ZZWA%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZWA%'`,
    `DELETE FROM houses WHERE paybill_number = $1`,
  ]) {
    try { await query(sql, sql.includes('$1') ? [HOUSE] : undefined); } catch (e) { console.error('[cleanup]', e.message); }
  }
}

async function makeToken() {
  const u = (await query(
    `SELECT id, username, role FROM users WHERE is_active IS DISTINCT FROM false
      ORDER BY (role = 'admin') DESC, id LIMIT 1`
  )).rows[0];
  return jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '20m' });
}

(async () => {
  await cleanup();
  await query(
    `INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status)
     VALUES ($1, 'ZZWA House', 4, 'unknown')`, [HOUSE]);
  await store.createTenant({
    tenant_code: CODE, name: 'ZZWA Tenant', phone_number: '+254700000701',
    property_name: 'ZZWA House', house_id: HOUSE,
    rent_amount: 10000, deposit_amount: 8000, deposit_paid: 8000, garbage_fee_amount: 200,
    rent_due_date: '2026-11-05', status: 'Active',
  });
  await query(`UPDATE tenants SET garbage_fee_paid = 0, deposit_paid = 8000, rent_paid_this_month = 0 WHERE tenant_code = $1`, [CODE]);

  // legacy bundled "MONTHLY RENT & UTILITY" row (Sept: rent 8000 + garbage 200 + water 180)
  await query(
    `INSERT INTO water_invoices (wtr_number, tenant_code, tenant_name, property_name, house_paybill_number,
       billing_month, payment_month, previous_reading, current_reading, units_used, rate_per_unit,
       total_amount, total_amount_payable, due_date, status, notes, rent_amount, garbage_fee)
     VALUES ('ZZWA-WTR-202609-000001', $1, 'ZZWA Tenant', 'ZZWA House', $2,
       '2026-09', '2026-10', 10, 11, 1, 180, 8380, 8380, '2026-10-05', 'Sent',
       'Water charges for September 2026 ... This invoice also includes the applicable rent, garbage fee and any previous outstanding balance.',
       8000, 200)`, [CODE, HOUSE]);

  // water-only row (Oct consumption, due 5 Nov) + its invoice_register twin
  await query(
    `INSERT INTO water_invoices (wtr_number, tenant_code, tenant_name, property_name, house_paybill_number,
       billing_month, payment_month, previous_reading, current_reading, units_used, rate_per_unit,
       total_amount, total_amount_payable, due_date, status, notes, rent_amount, garbage_fee)
     VALUES ('ZZWA-WTR-202610-000002', $1, 'ZZWA Tenant', 'ZZWA House', $2,
       '2026-10', '2026-11', 0, 2, 2, 180, 360, 360, '2026-11-05', 'Sent',
       'This invoice covers water charges only.', 0, 0)`, [CODE, HOUSE]);
  await query(
    `INSERT INTO invoice_register (invoice_number, invoice_type, tenant_code, tenant_name, property_name,
       house_paybill_number, amount, amount_paid, balance_due, status)
     VALUES ('ZZWA-WTR-202610-000002', 'water', $1, 'ZZWA Tenant', 'ZZWA House', $2, 360, 0, 360, 'Sent via WhatsApp')`,
    [CODE, HOUSE]);

  // ---- 1. water outstanding source ----
  const out = await store.getWaterInvoiceOutstanding(CODE);
  check(out === 360, `1. getWaterInvoiceOutstanding = 360 (water-only, not 8,740) (got ${out})`);

  const exitSummary = await store.getTenantExitSummary(CODE);
  const waterLine = (exitSummary.outstanding || []).find((i) => i.type === 'water');
  check(waterLine && Number(waterLine.amount) === 360, `1b. exit summary water = 360 (got ${waterLine && waterLine.amount})`);
  check(Number(exitSummary.totals.outstanding_total) === 10560,
    `1c. exit summary total = 10,560 (rent 10,000 + garbage 200 + water 360) (got ${exitSummary.totals.outstanding_total})`);

  // ---- 2. parse preview message ----
  const app = express();
  app.use(express.json());
  app.use('/api/payments', require('../backend/routes/payments'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const token = await makeToken();
  const raw = `QA11B22C33 Confirmed. Ksh10560 paid to Equity Account, 247247 for account number#${CODE} 0700000701 via My OneApp on 5th Nov 2026 at 10:00 am.`;
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/payments/parse-message`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw_message: raw }),
  });
  const body = await res.json();
  const msg = body.generated_message || '';
  console.log('\n----- PREVIEW MESSAGE -----\n' + msg + '\n----------------------------');
  check(msg.includes('Water Charges: KES 360'), '2. preview water = 360', msg);
  check(msg.includes('Monthly Rent: KES 10,000'), '2b. preview rent = full 10,000', msg);
  check(msg.includes('Garbage Fee: KES 200'), '2c. preview garbage = 200', msg);
  check(msg.includes('Rent Due for November 2026 was KES 10,560'), '2d. preview total = 10,560', msg);
  check(!msg.includes('8,740') && !msg.includes('8,380'), '2e. no bundled figures leak into the message', msg);

  // ---- 3. approval allocation ----
  const payment = await store.createPayment({
    tenant_id: CODE, amount: 10560, mpesa_reference: 'QATESTREF01', payment_type: 'rent',
    status: 'Pending', payment_mode: 'M-Pesa', source: 'manual',
  });
  check(payment && payment.id, '3. fixture payment created', payment);
  await query(`UPDATE payments SET billing_period = '2026-11' WHERE id = $1`, [payment.id]);
  const approved = await store.approvePayment(payment.id);
  const a = approved.allocation || {};
  check(Number(a.garbageFeeSettled) === 200, `3b. garbageSettled = 200 (got ${a.garbageFeeSettled})`, a);
  check(Number(a.waterSettled) === 360, `3c. waterSettled = 360 (got ${a.waterSettled})`, a);
  check(Number(a.rentSettled) === 10000, `3d. rentSettled = 10,000 (got ${a.rentSettled})`, a);
  check(Number(a.remainingBalance) === 0, `3e. remainingBalance = 0 (got ${a.remainingBalance})`, a);
  check(Number(a.waterChargeBefore) === 360, `3f. waterChargeBefore (Rent Due water) = 360 (got ${a.waterChargeBefore})`, a);

  const confirmMsg = buildPaymentConfirmation(approved.tenant, approved.payment, a);
  console.log('\n----- CONFIRMATION -----\n' + confirmMsg + '\n------------------------');
  check(confirmMsg.includes('Water Charges: KES 360'), '3g. confirmation water = 360', confirmMsg);
  check(confirmMsg.includes('Monthly Rent: KES 10,000'), '3h. confirmation rent = full 10,000', confirmMsg);
  check(confirmMsg.includes('Rent Due for November 2026 was KES 10,560'), '3i. confirmation total = 10,560', confirmMsg);

  const rows = (await query(`SELECT wtr_number, status FROM water_invoices WHERE tenant_code = $1 ORDER BY id`, [CODE])).rows;
  const bundled = rows.find((r) => r.wtr_number.includes('202609'));
  const only = rows.find((r) => r.wtr_number.includes('202610'));
  check(only && only.status === 'Paid', `3j. water-only invoice settled (got ${only && only.status})`, rows);
  check(bundled && bundled.status === 'Sent', `3k. bundled legacy invoice untouched by water settling (got ${bundled && bundled.status})`, rows);
  const reg = (await query(`SELECT amount_paid, balance_due FROM invoice_register WHERE invoice_number = 'ZZWA-WTR-202610-000002'`)).rows[0];
  check(reg && Number(reg.amount_paid) === 360 && Number(reg.balance_due) === 0,
    `3l. register twin fully settled (got paid=${reg && reg.amount_paid} bal=${reg && reg.balance_due})`, reg);

  // ---- 4. delete reversal reopens the water invoice ----
  const del = await store.deletePayment(payment.id, 'verify-script');
  check(del && del.deleted, '4. payment deleted', del);
  const onlyAfter = (await query(`SELECT status FROM water_invoices WHERE wtr_number = 'ZZWA-WTR-202610-000002'`)).rows[0];
  check(onlyAfter && onlyAfter.status === 'Sent',
    `4b. water invoice reopened after delete (got ${onlyAfter && onlyAfter.status})`, onlyAfter);
  const regAfter = (await query(`SELECT amount_paid, balance_due FROM invoice_register WHERE invoice_number = 'ZZWA-WTR-202610-000002'`)).rows[0];
  check(regAfter && Number(regAfter.balance_due) === 360,
    `4c. register balance restored (got ${regAfter && regAfter.balance_due})`, regAfter);

  srv.close();
  await cleanup();
  console.log(`\n===============================\nRESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await cleanup(); } catch (_) {} process.exit(1); });
