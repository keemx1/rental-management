/**
 * EX004 (GEOFREY MUGAMBI) - 2026-11-06 (management).
 * Last month's payment of 61,500 (#1479, ref UIP9G79YWE) covered rent 30,000
 * + deposit 30,000 + tenants agreement 1,500, remaining arrears 200 (the
 * garbage fee). This month (November) is DUE: rent 30,000 + last month's
 * garbage 200 + this month's garbage 200 = 30,400 - so entering this month's
 * 30,000 payment must deduct rent (leaving rent arrears 400), NOT book an
 * overpayment of 29,600.
 *
 * Root cause: #1479 was tagged billing_period 2026-11 (the approval derived it
 * from rent_due_date), so its rent settlement counted as NOVEMBER rent -> the
 * real November payment found no rent due. Also its allocation put 200 to
 * garbage (allocation order) leaving deposit 200 short - management: the 61,500
 * covered rent + deposit + agreement and the 200 garbage is the ARREARS.
 *
 * Corrections (audit-logged, history untouched):
 *  1. #1479 billing_period 2026-11 -> 2026-10 (its actual month).
 *  2. deposit_paid 29,800 -> 30,000 (the 61,500 covered the deposit).
 *  3. arrears 0 -> 200 (October's garbage fee = "remaining with arrears of 200"),
 *     arrears_manually_set (management figure - protected from recompute).
 *  4. Re-derive counters from the payment history (November rent due again).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');
const store = require('../storage/store');

(async () => {
  const code = 'EX004';
  const before = (await query(`SELECT rent_paid_this_month, arrears, deposit_amount, deposit_paid,
    garbage_fee_amount, garbage_fee_paid, rent_amount, status FROM tenants WHERE tenant_code = $1`, [code])).rows[0];
  const payBefore = (await query(`SELECT billing_period, payment_date::text AS pd FROM payments WHERE id = 1479`)).rows[0];
  console.log('tenant before:', before);
  console.log('#1479 before:', payBefore);

  await query(`UPDATE payments SET billing_period = '2026-10' WHERE id = 1479`);
  await query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, details, created_at)
     VALUES ('admin-approval', 'CORRECT', 'payment', '1479', $1, NOW())`,
    [JSON.stringify({
      tenant_code: code, mpesa_reference: 'UIP9G79YWE',
      previous_value: { billing_period: payBefore.billing_period },
      corrected_value: { billing_period: '2026-10' },
      reason: "Management (2026-11-06): the 61,500 is LAST MONTH's payment (rent 30,000 + deposit 30,000 + tenants agreement 1,500). It was tagged billing 2026-11 (derived from rent_due_date at approval) so its rent settlement counted as NOVEMBER rent - which made November appear paid and turned the real November 30,000 payment into a 29,600 overpayment. Re-tagged to its actual cycle (2026-10); November rent is DUE again. Allocation/receipt/reference untouched.",
      date: '2026-11-06', actor: 'admin-approval',
    })]
  );

  await query(
    `UPDATE tenants SET deposit_paid = 30000, garbage_fee_paid = 0, arrears = 200,
       arrears_manually_set = true, updated_at = NOW() WHERE tenant_code = $1`, [code]);
  await query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, details, created_at)
     VALUES ('admin-approval', 'CORRECT', 'tenant', $1, $2, NOW())`,
    [code, JSON.stringify({
      previous_value: { deposit_paid: before.deposit_paid, arrears: before.arrears, garbage_fee_paid: before.garbage_fee_paid },
      corrected_value: { deposit_paid: 30000, arrears: 200, garbage_fee_paid: 0, arrears_manually_set: true },
      reason: "Management: the 61,500 covered rent 30,000 + deposit 30,000 + agreement 1,500 with 200 garbage remaining as ARREARS. Its allocation had put 200 to garbage (allocation order) leaving deposit 200 short - corrected to the confirmed position: deposit fully covered, October's garbage 200 = the arrears (manually-set figure, protected), November garbage 200 owed. Expected November due: 200 + 30,000 + 200 = 30,400.",
      date: '2026-11-06', actor: 'admin-approval',
    })]
  );

  const rec = await store.reconcileTenant(code);
  console.log('reconcile:', { rent_paid: rec && rec.rent_paid_this_month, arrears: rec && rec.arrears, status: rec && rec.status, out: rec && rec.current_month_outstanding });

  const after = (await query(`SELECT rent_paid_this_month, arrears, deposit_amount, deposit_paid,
    garbage_fee_amount, garbage_fee_paid, arrears_manually_set FROM tenants WHERE tenant_code = $1`, [code])).rows[0];
  console.log('tenant after:', after);
  const es = await store.getTenantExitSummary(code);
  console.log('exit summary (the DUE):', es.totals.outstanding_total, '| lines:', es.outstanding.map((i) => `${i.type}:${i.amount}`).join(', '));

  // simulate this month's 30,000 payment with the EXISTING allocation order
  // (agreement -> arrears -> penalties -> maintenance -> garbage -> other ->
  // water -> rent -> deposit): 200 arrears + 200 garbage + 29,600 rent ->
  // rent arrears 400.
  let remaining = 30000;
  const settle = (n) => { const s = Math.min(n, remaining); remaining -= s; return s; };
  const sArr = settle(Number(after.arrears || 0));
  const sGarb = settle(Math.max(0, Number(after.garbage_fee_amount || 0) - Number(after.garbage_fee_paid || 0)));
  const rentRem = Math.max(0, Number(after.rent_amount || before.rent_amount || 0) - Number(after.rent_paid_this_month || 0));
  const sRent = settle(rentRem);
  console.log(`simulation of the 30,000: arrears ${sArr} + garbage ${sGarb} + rent ${sRent} = ${sArr + sGarb + sRent}; remaining rent arrears = ${rentRem - sRent}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
