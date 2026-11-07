/**
 * B14 (Ian Nixon) - 2026-11-06.
 * The 500 arrears payment is consumed as remaining rent (payment #1582,
 * receipt GEHPM-RCT-202610-001359, ref UJKIIAZ5PW - alloc rentSettled 500,
 * October). It was ALSO booked as an opening advance (audit: opening_advance_added
 * {amount:500, via:edit} 2026-10-16) = the "system picked it as an overpayment"
 * classification - the same 500 credited twice. Per management: it is NOT an
 * overpayment/advance; November must read the full normal rent 6,500.
 * FIX: remove the duplicate advance (slot + pool + coverage), re-derive the
 * counters from the payment history, audit-log both steps.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');
const store = require('../storage/store');

(async () => {
  const code = 'B14';
  const before = (await query(
    `SELECT rent_paid_this_month, arrears, credit_balance, advance_rent_balance,
            advance_rent_until::text AS advance_rent_until, opening_advance_rent, status
     FROM tenants WHERE tenant_code = $1`, [code])).rows[0];
  console.log('B14 before:', before);

  await query(
    `UPDATE tenants SET opening_advance_rent = 0, advance_rent_balance = 0, advance_rent_until = NULL, updated_at = NOW()
     WHERE tenant_code = $1`, [code]);
  await query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, details, created_at)
     VALUES ('admin-approval', 'CORRECT', 'tenant', $1, $2, NOW())`,
    [code, JSON.stringify({
      previous_value: { opening_advance_rent: before.opening_advance_rent, advance_rent_balance: before.advance_rent_balance, advance_rent_until: before.advance_rent_until },
      corrected_value: { opening_advance_rent: 0, advance_rent_balance: 0, advance_rent_until: null },
      reason: "The KES 500 arrears payment is consumed as remaining rent balance (payment #1582, receipt GEHPM-RCT-202610-001359, ref UJKIIAZ5PW, 20 Oct - allocation rentSettled 500 against October's remaining rent). It was ALSO recorded as an opening advance (audit 2026-10-16 opening_advance_added {amount:500, via:edit}) = the 'picked as overpayment' misclassification - the same 500 credited twice (October settlement + phantom November credit). Per management it is NOT an overpayment/advance. Duplicate credit removed; one payment credit can only be utilized once.",
      date: '2026-11-06', actor: 'admin-approval',
    })]
  );

  const rec = await store.reconcileTenant(code);
  console.log('reconcile:', { rent_paid: rec && rec.rent_paid_this_month, status: rec && rec.status, out: rec && rec.current_month_outstanding });

  const after = (await query(
    `SELECT rent_paid_this_month, arrears, credit_balance, advance_rent_balance,
            advance_rent_until::text AS advance_rent_until, opening_advance_rent, status
     FROM tenants WHERE tenant_code = $1`, [code])).rows[0];
  console.log('B14 after:', after);
  await query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, details, created_at)
     VALUES ('admin-approval', 'CORRECT', 'tenant', $1, $2, NOW())`,
    [code, JSON.stringify({
      previous_value: { rent_paid_this_month: before.rent_paid_this_month, status: before.status },
      corrected_value: { rent_paid_this_month: after.rent_paid_this_month, status: after.status },
      reason: "Counters re-derived from the payment transaction history after removing the duplicate 500 credit: November reads the full normal rent 6,500 (rent back to normal), the 500 stays consumed as October's remaining rent per payment #1582's recorded allocation. No historical transaction altered.",
      date: '2026-11-06', actor: 'admin-approval',
    })]
  );
  console.log('B14 corrected + audited');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
