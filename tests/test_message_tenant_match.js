/**
 * Regression - confirmation figures come from the CORRECT tenant's active
 * configuration, deterministically (ISSUE 3 - SB1, Peter Mwangi Nganga).
 *
 * The parse preview OR-matches phone / account code / paybill and used to
 * suggest the first match BY NAME - a shared sender phone could surface another
 * unit's record and display THAT unit's rent. Also locks the rent display: the
 * Rent Due line shows the month's FULL configured rent even when part of the
 * month was already paid (the old message showed the remainder - SB1's 5,500
 * instead of 9,200), and identical input always produces identical output.
 *
 * Fixtures: house 999995, tenants ZZMA-01/ZZMA-02 sharing one phone.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const jwt = require('jsonwebtoken');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const { buildPaymentConfirmation } = require('../backend/services/messages');

const HOUSE = '999995';
let pass = 0, fail = 0;
const failures = [];
const check = (ok, label, extra) => {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};

async function cleanup() {
  for (const sql of [
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZMA-%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZMA-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZMA-%'`,
    `DELETE FROM houses WHERE paybill_number = $1`,
  ]) {
    try { await query(sql, sql.includes('$1') ? [HOUSE] : undefined); } catch (e) { console.error('[cleanup]', e.message); }
  }
}

(async () => {
  await cleanup();
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status) VALUES ($1, 'ZZMA House', 4, 'unknown')`, [HOUSE]);
  for (const [code, name, rent] of [['ZZMA-01', 'ZZMA Alpha', 5000], ['ZZMA-02', 'ZZMA Beta', 9000]]) {
    await store.createTenant({
      tenant_code: code, name, phone_number: '+254700000901',
      property_name: 'ZZMA House', house_id: HOUSE,
      rent_amount: rent, deposit_amount: rent, deposit_paid: rent, garbage_fee_amount: 200,
      rent_due_date: '2026-11-05', status: 'Active',
    });
    await query(`UPDATE tenants SET rent_paid_this_month = 0, garbage_fee_paid = 0, deposit_paid = deposit_amount WHERE tenant_code = $1`, [code]);
  }
  // ZZMA-02 has an earlier partial payment this cycle (SB1 class: 3,500 of 9,000)
  await query(`UPDATE tenants SET rent_paid_this_month = 3500, garbage_fee_paid = 200, deposit_paid = deposit_amount WHERE tenant_code = 'ZZMA-02'`);

  const app = express();
  app.use(express.json());
  app.use('/api/payments', require('../backend/routes/payments'));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const u = (await query(`SELECT id, username, role FROM users WHERE is_active IS DISTINCT FROM false ORDER BY (role = 'admin') DESC, id LIMIT 1`)).rows[0];
  const token = jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const parse = async (raw) => {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/payments/parse-message`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_message: raw }),
    });
    return res.json();
  };
  // Both tenants share the sender phone - only the account code decides.
  const raw = 'QA99ZZ11AA Confirmed. Ksh9,200.00 sent to ZZMA HOUSE for account number#ZZMA-02 on 11/05/2026 at 10:00:50. MPESA Ref. QA99ZZ11AA.';

  try {
    const r1 = await parse(raw);
    check(r1.suggested_tenant && r1.suggested_tenant.tenant_code === 'ZZMA-02',
      '1. exact account-code match wins over the shared phone (name order would pick ZZMA-01)', r1.suggested_tenant && r1.suggested_tenant.tenant_code);
    const msg = r1.generated_message || '';
    check(msg.includes('Dear ZZMA BETA'), '2. message addressed to the CORRECT tenant', msg.slice(0, 120));
    check(msg.includes('Monthly Rent: KES 9,000'), '3. rent line = the matched tenant\'s CONFIGURED rent (9,000, not 5,000 nor the 5,500 remainder)', msg);
    check(msg.includes('Rent Due for November 2026 was KES 9,200'),
      '4. SB1 class: Rent Due shows the month\'s FULL billing (9,200) though 3,500 was already paid', msg);
    const r2 = await parse(raw);
    check(r2.generated_message === msg, '5. deterministic: the same transaction always produces the same message');

    // unit-level check via the confirmation builder (receipt parity)
    const t = await store.getTenant('ZZMA-02');
    const alloc = {
      rentAmount: 9000, rentDue: 5500, rentSettled: 5500, rentPaidBefore: 3500,
      garbageFeeBefore: 0, garbageFeeSettled: 0, waterChargeBefore: 0, waterSettled: 0,
      penaltyBefore: 0, maintenanceBefore: 0, otherBefore: 0, depositShortfallBefore: 0, arrearsBefore: 0, agreementBefore: 0,
      penaltySettled: 0, maintenanceSettled: 0, otherSettled: 0, depositSettled: 0, arrearsSettled: 0, agreementSettled: 0,
      remainingBalance: 0, overpayment: 3700, remainingRent: 0, remainingGarbage: 0, remainingWater: 0,
      remainingArrears: 0, remainingPenalties: 0, remainingMaintenance: 0, remainingOther: 0, remainingDeposit: 0, remainingAgreement: 0,
    };
    const conf = buildPaymentConfirmation(t, { amount: 9200, mpesa_reference: 'QA99ZZ11AA', billing_period: '2026-11' }, alloc);
    check(conf.includes('Rent Due for November 2026 was KES 9,200') && conf.includes('Monthly Rent: KES 9,000'),
      '6. receipt/confirmation parity: same configured figures', conf);
  } finally {
    srv.close();
  }

  await cleanup();
  console.log(`\n===============================\nRESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await cleanup(); } catch (_) {} process.exit(1); });
