/**
 * D1 (Stephen Kinyangu, Sunview Apartments) - transaction-based correction.
 *
 * 1. Payment #1424 (15,000, ref UJ1838R9VC) is the 1 OCTOBER payment. Its
 *    payment_date was parsed as 2026-01-09 by the pre-fix MM/DD parse bug
 *    (source message in notes: "10/01/2026 at 10:00:50" = 1 October).
 * 2. The unsupported Nov credit (rent_paid_this_month 15,000) came from the
 *    consumption re-emit of the erroneous 60,000 advance (removed 2026-11-05
 *    07:41) - no November transaction exists. Re-derive from transactions.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');
const store = require('../storage/store');

(async () => {
  const before = (await query(`SELECT rent_paid_this_month, status, arrears, advance_rent_balance, advance_rent_until FROM tenants WHERE tenant_code = 'D1'`)).rows[0];
  console.log('D1 before:', before);

  const p = (await query(`SELECT payment_date::text AS payment_date, payment_datetime::text AS payment_datetime, notes FROM payments WHERE id = 1424`)).rows[0];
  console.log('payment #1424 before:', p.payment_date, p.payment_datetime);

  await query(
    `UPDATE payments SET payment_date = '2026-10-01', payment_datetime = '2026-10-01T10:00:50+03:00' WHERE id = 1424`);
  await query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, details, created_at)
     VALUES ('admin-approval', 'CORRECT', 'payment', '1424', $1, NOW())`,
    [JSON.stringify({
      tenant_code: 'D1', mpesa_reference: 'UJ1838R9VC',
      previous_value: { payment_date: p.payment_date, payment_datetime: p.payment_datetime },
      corrected_value: { payment_date: '2026-10-01', payment_datetime: '2026-10-01T10:00:50+03:00' },
      reason: "Payment is the 1 OCTOBER rent payment (management: 'the payment dated 1st October'). Stored date 2026-01-09 is an artifact of the pre-fix MM/DD parse bug (entry #55): the source M-Pesa message in the payment notes reads '10/01/2026 at 10:00:50' = 1 October 2026. Billing_period 2026-10 and the allocation (rentSettled 15,000 to October) were already correct - only the recorded date was wrong.",
      date: '2026-11-05', actor: 'admin-approval',
    })]);

  // Re-derive counters from genuine transactions (the system's reconciler).
  const rec = await store.reconcileTenant('D1');
  console.log('reconcile result:', rec);

  const after = (await query(`SELECT rent_paid_this_month, status, arrears, advance_rent_balance, advance_rent_until FROM tenants WHERE tenant_code = 'D1'`)).rows[0];
  console.log('D1 after:', after);

  await query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, details, created_at)
     VALUES ('admin-approval', 'CORRECT', 'tenant', 'D1', $1, NOW())`,
    [JSON.stringify({
      previous_value: { rent_paid_this_month: before.rent_paid_this_month, status: before.status },
      corrected_value: { rent_paid_this_month: after.rent_paid_this_month, status: after.status },
      reason: "Unsupported November payment credit removed: rent_paid_this_month 15,000 was the consumption re-emit of the erroneous 60,000 advance (removed 2026-11-05 07:41 - preserved, never reintroduced). No November transaction exists - the only genuine payment is #1424 (15,000, ref UJ1838R9VC, 1 October, billed to 2026-10). Counters re-derived from the payment transaction history: October fully settled, November 15,000 outstanding until the actual November payment is entered. The deleted attempt #5316 (ref UJS8306DG3) was classified as overpayment only because of this phantom credit - it can now be re-entered normally.",
      date: '2026-11-05', actor: 'admin-approval',
    })]);
  console.log('audit logged');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
