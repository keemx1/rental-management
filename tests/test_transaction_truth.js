/**
 * Regression - transaction-based reconciliation (SYSTEM DIRECTIVE 2026-11-05).
 *
 * "No genuine transaction, no recognized payment." The D1 (Stephen Kinyangu)
 * class: rent_paid_this_month claimed for the current cycle with no supporting
 * transaction (the consumption re-emit of a removed 60,000 advance / a previous
 * cycle's payment carried forward by counter drift). When the real November
 * payment was entered the system misread it as an overpayment.
 *
 * Verifies:
 *  1. A phantom rent-paid credit (no transaction) is FLAGGED
 *  2. reconcileTenant re-derives it to the transaction-supported value
 *  3. A previous-cycle payment does NOT support the new cycle's rent
 *  4. A genuine overpayment/advance covering the cycle IS recognised
 *  5. An advance pool/coverage with no supporting transaction is FLAGGED
 *  6. The real payment then settles the cycle to zero / Paid (no overpayment)
 *
 * Fixtures: house 999996, tenant ZZTT01. No sends.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const { validateTenantAccount } = require('../backend/services/financialValidator');

const CODE = 'ZZTT01';
const HOUSE = '999996';
let pass = 0, fail = 0;
const failures = [];
const check = (ok, label, extra) => {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};

async function cleanup() {
  for (const sql of [
    `DELETE FROM invoice_payment_links WHERE payment_id IN (SELECT id FROM payments WHERE tenant_code LIKE 'ZZTT%')`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZTT%'`,
    `DELETE FROM deposit_applications WHERE tenant_code LIKE 'ZZTT%'`,
    `DELETE FROM audit_log WHERE entity_id LIKE 'ZZTT%' OR details::text LIKE '%ZZTT%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZTT%'`,
    `DELETE FROM houses WHERE paybill_number = $1`,
  ]) {
    try { await query(sql, sql.includes('$1') ? [HOUSE] : undefined); } catch (e) { console.error('[cleanup]', e.message); }
  }
}

(async () => {
  await cleanup();
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status) VALUES ($1, 'ZZTT House', 2, 'unknown')`, [HOUSE]);
  await store.createTenant({
    tenant_code: CODE, name: 'ZZTT Tenant', phone_number: '+254700000801',
    property_name: 'ZZTT House', house_id: HOUSE,
    rent_amount: 10000, deposit_amount: 5000, deposit_paid: 5000,
    rent_due_date: '2026-11-05', status: 'Active',
  });
  await query(`UPDATE tenants SET rent_paid_this_month = 0, garbage_fee_paid = 0, deposit_paid = 5000 WHERE tenant_code = $1`, [CODE]);

  // October's genuine payment (settles the 2026-10 cycle only). Billing period
  // is re-tagged after approval (approvePayment derives it from rent_due_date).
  const oct = await store.createPayment({ tenant_id: CODE, amount: 10000, mpesa_reference: 'ZZTTOCT01', payment_type: 'rent', status: 'Pending', payment_mode: 'M-Pesa', source: 'manual' });
  await store.approvePayment(oct.id);
  await query(`UPDATE payments SET billing_period = '2026-10' WHERE id = $1`, [oct.id]);

  // ---- 1-2. the D1 class: phantom November credit with no transaction ----
  await query(`UPDATE tenants SET rent_paid_this_month = 6000, status = 'Paid' WHERE tenant_code = $1`, [CODE]);
  let issues = await validateTenantAccount(CODE);
  check(issues.some((i) => i.code === 'RENT_PAID_UNSUPPORTED'),
    '1. phantom rent-paid credit flagged (D1 class)', issues);
  const rec = await store.reconcileTenant(CODE);
  check(rec && Number(rec.rent_paid_this_month) === 0,
    `2. reconcile re-derives to transaction truth (0) (got ${rec && rec.rent_paid_this_month})`, rec);

  // ---- 3. October's payment must NOT support November ----
  issues = await validateTenantAccount(CODE);
  check(!issues.some((i) => String(i.code).startsWith('RENT_PAID')),
    '3. previous-cycle payment does not support the new cycle', issues);
  const nov = (await query(`SELECT rent_paid_this_month FROM tenants WHERE tenant_code = $1`, [CODE])).rows[0];
  check(Number(nov.rent_paid_this_month) === 0, `3b. Nov rent_paid stays 0 (got ${nov.rent_paid_this_month})`);

  // ---- 4. genuine overpayment/advance covering the cycle is recognised ----
  await query(`UPDATE tenants SET rent_paid_this_month = 0, advance_rent_balance = 10000, advance_rent_until = '2026-11-01', opening_advance_rent = 10000 WHERE tenant_code = $1`, [CODE]);
  const rec2 = await store.reconcileTenant(CODE);
  check(rec2 && Number(rec2.rent_paid_this_month) === 10000,
    `4. transaction-backed advance covering the cycle counts as paid (got ${rec2 && rec2.rent_paid_this_month})`, rec2);
  issues = await validateTenantAccount(CODE);
  check(!issues.some((i) => i.code === 'RENT_PAID_UNSUPPORTED'),
    '4b. no flag while the advance is transaction-backed', issues);

  // ---- 5. advance pool/coverage with no supporting transaction is flagged ----
  await query(`UPDATE tenants SET opening_advance_rent = 0, advance_rent_balance = 10000, advance_rent_until = '2026-11-01' WHERE tenant_code = $1`, [CODE]);
  issues = await validateTenantAccount(CODE);
  check(issues.some((i) => i.code === 'ADVANCE_UNSUPPORTED'),
    '5. unsupported advance flagged', issues);
  await query(`UPDATE tenants SET advance_rent_balance = 0, advance_rent_until = NULL, rent_paid_this_month = 0 WHERE tenant_code = $1`, [CODE]);

  // ---- 6. the real November payment settles to zero / Paid (not overpayment) ----
  const novPay = await store.createPayment({ tenant_id: CODE, amount: 10000, mpesa_reference: 'ZZTTNOV01', payment_type: 'rent', status: 'Pending', payment_mode: 'M-Pesa', source: 'manual' });
  await query(`UPDATE payments SET billing_period = '2026-11' WHERE id = $1`, [novPay.id]);
  const appr = await store.approvePayment(novPay.id);
  const a = appr.allocation || {};
  check(Number(a.rentSettled) === 10000, `6. Nov payment settles rent in full (got ${a.rentSettled})`, a);
  check(Number(a.overpayment) === 0 && Number(a.remainingBalance) === 0,
    `6b. zero overpayment / zero balance (overpay ${a.overpayment}, bal ${a.remainingBalance})`, a);
  const after = (await query(`SELECT rent_paid_this_month, status FROM tenants WHERE tenant_code = $1`, [CODE])).rows[0];
  check(Number(after.rent_paid_this_month) === 10000 && after.status === 'Paid',
    `6c. cycle Paid after entry (paid ${after.rent_paid_this_month}, status ${after.status})`, after);

  await cleanup();
  console.log(`\n===============================\nRESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await cleanup(); } catch (_) {} process.exit(1); });
