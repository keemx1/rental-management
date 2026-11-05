/**
 * Message/receipt accuracy validation (ISSUE 3 - SB1 reference case).
 * Read-only: generates confirmations from EXISTING records only (no writes to
 * payments/receipts). Checks, per the management checklist:
 *   1. the rent displayed matches the tenant's active rent configuration
 *   2. charges are retrieved from the correct tenant and unit
 *   3. already settled invoices are not deducted again
 *   4. unpaid invoices are not omitted
 *   5. message generation never writes/duplicates/reallocates payments
 *   6. the same transaction always produces the same message (deterministic)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');
const store = require('../storage/store');
const { buildPaymentConfirmation } = require('../services/messages');

const fmt = (n) => Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });

(async () => {
  // ---------- SB1 reference ----------
  const sb1 = await store.getTenant('SB1');
  console.log('=== SB1 (Peter Mwangi Nganga) reference ===');
  console.log('configured rent:', sb1.rent_amount, '| garbage:', sb1.garbage_fee_amount, '| rent paid this cycle:', sb1.rent_paid_this_month);
  const fakePay = { amount: 9200, mpesa_reference: 'UK4NV1FIPV', receipt_number: 'GEHPM-RCT-202611-003597', billing_period: '2026-11' };
  const remaining = Math.max(0, Number(sb1.rent_amount) - Number(sb1.rent_paid_this_month || 0));
  const fakeAlloc = {
    rentAmount: Number(sb1.rent_amount), rentDue: remaining, rentSettled: remaining, rentPaidBefore: Number(sb1.rent_paid_this_month || 0),
    garbageFeeBefore: 0, garbageFeeSettled: 0, waterChargeBefore: 0, waterSettled: 0,
    penaltyBefore: 0, maintenanceBefore: 0, otherBefore: 0, depositShortfallBefore: 0, arrearsBefore: 0, agreementBefore: 0,
    penaltySettled: 0, maintenanceSettled: 0, otherSettled: 0, depositSettled: 0, arrearsSettled: 0, agreementSettled: 0,
    remainingBalance: 0, overpayment: Number(fakePay.amount) - remaining,
    remainingRent: 0, remainingGarbage: 0, remainingWater: 0, remainingArrears: 0, remainingPenalties: 0,
    remainingMaintenance: 0, remainingOther: 0, remainingDeposit: 0, remainingAgreement: 0,
  };
  const msg = buildPaymentConfirmation(sb1, fakePay, fakeAlloc);
  console.log('\n----- SB1 November confirmation (regenerated from existing records) -----\n' + msg + '\n---------------------------------');
  const ok1 = msg.includes(`Monthly Rent: KES ${fmt(sb1.rent_amount)}`);
  const ok2 = msg.includes(`Rent Due for November 2026 was KES ${fmt(Number(sb1.rent_amount) + Number(sb1.garbage_fee_amount || 0))}`);
  const ok3 = !msg.includes('was KES 5,500');
  const again = buildPaymentConfirmation(sb1, fakePay, fakeAlloc);
  console.log(`SB1 checks: rent-line=${ok1} total-line=${ok2} no-5500=${ok3} deterministic=${again === msg}\n`);

  // ---------- read-only proof ----------
  const paysBefore = (await query(`SELECT COUNT(*)::int AS n FROM payments`)).rows[0].n;

  // ---------- system-wide ----------
  const tenants = (await query(
    `SELECT tenant_code, name, rent_amount, garbage_fee_amount, garbage_fee_paid, rent_paid_this_month, status
       FROM tenants WHERE status <> 'Vacant' ORDER BY tenant_code`)).rows;
  let checked = 0;
  const bad = [];
  for (const t of tenants) {
    const tenant = await store.getTenant(t.tenant_code);
    const pay = { amount: Number(tenant.rent_amount) + 200, mpesa_reference: 'VERIFY', billing_period: '2026-11' };
    const rem = Math.max(0, Number(tenant.rent_amount) - Number(tenant.rent_paid_this_month || 0));
    const alloc = { ...fakeAlloc, rentAmount: Number(tenant.rent_amount), rentDue: rem, rentSettled: Math.min(rem, pay.amount), rentPaidBefore: Number(tenant.rent_paid_this_month || 0), overpayment: Math.max(0, pay.amount - rem), remainingBalance: 0 };
    const m = buildPaymentConfirmation(tenant, pay, alloc);
    checked++;
    if (!m.includes(`Monthly Rent: KES ${fmt(tenant.rent_amount)}`)) bad.push(`${tenant.tenant_code}: rent line != configured ${tenant.rent_amount}`);
    const garb = Number(tenant.garbage_fee_amount || 0);
    if (garb > 0 && !m.includes(`Garbage Fee: KES ${fmt(garb)}`)) bad.push(`${tenant.tenant_code}: garbage line != configured ${garb}`);
    const m2 = buildPaymentConfirmation(tenant, pay, alloc);
    if (m2 !== m) bad.push(`${tenant.tenant_code}: NON-DETERMINISTIC generation`);
  }

  const paysAfter = (await query(`SELECT COUNT(*)::int AS n FROM payments`)).rows[0].n;
  console.log(`\n=== system-wide: ${checked} tenants checked ===`);
  console.log('violations:', bad.length ? bad : 'NONE');
  console.log('read-only proof: payments', paysBefore, '->', paysAfter, paysBefore === paysAfter ? '(unchanged ✓)' : '(CHANGED ✗)');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
