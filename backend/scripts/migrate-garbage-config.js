/**
 * Garbage fee configuration (management 2026-11-07):
 *   Mariana House / Blue House / Sunview / Cream House -> KES 2,000 ONE-TIME
 *   all other houses                                 -> KES 200 MONTHLY
 *   Matangi Junction Shops                           -> NO garbage fee
 * The one-time fee must be charged ONCE: the monthly rollover must neither
 * reset garbage_fee_paid nor re-accrue the fee for one-time tenants.
 * This script adds the frequency column and applies the house standards to
 * every active tenant (audit-logged per tenant when a fee changes).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

const ONE_TIME = ['BLUE HOUSE', 'CREAM HOUSE', 'MARIANA HOUSE', 'SUNVIEW APARTMENTS'];
const NO_FEE = ['MATANGI JUNCTION SHOPS'];

(async () => {
  await query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS garbage_fee_frequency VARCHAR(16) NOT NULL DEFAULT 'monthly'`);
  console.log('OK garbage_fee_frequency column');

  const houses = (await query(`SELECT paybill_number, house_name FROM houses`)).rows;
  const nameOf = {};
  for (const h of houses) nameOf[h.paybill_number] = String(h.house_name || '').trim().toUpperCase();

  const tenants = (await query(
    `SELECT tenant_code, house_paybill_number, garbage_fee_amount, garbage_fee_paid
       FROM tenants WHERE status <> 'Vacant'`)).rows;

  let changed = 0;
  for (const t of tenants) {
    const houseName = nameOf[t.house_paybill_number] || String(t.property_name || '').trim().toUpperCase();
    let amount, freq, label;
    if (NO_FEE.some((h) => houseName.includes(h))) { amount = 0; freq = 'monthly'; label = 'none (Matangi)'; }
    else if (ONE_TIME.some((h) => houseName.includes(h))) { amount = 2000; freq = 'one_time'; label = 'one-time 2,000'; }
    else { amount = 200; freq = 'monthly'; label = 'monthly 200'; }
    const beforeAmt = Number(t.garbage_fee_amount || 0);
    if (Math.abs(beforeAmt - amount) < 0.01) {
      // amount already right - still normalise the frequency flag
      await query(`UPDATE tenants SET garbage_fee_frequency = $2 WHERE tenant_code = $1 AND garbage_fee_frequency IS DISTINCT FROM $2`, [t.tenant_code, freq]);
      continue;
    }
    await query(`UPDATE tenants SET garbage_fee_amount = $2, garbage_fee_frequency = $3, updated_at = NOW() WHERE tenant_code = $1`,
      [t.tenant_code, amount, freq]);
    await query(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, details, created_at)
       VALUES ('admin-approval', 'CORRECT', 'tenant', $1, $2, NOW())`,
      [t.tenant_code, JSON.stringify({
        previous_value: { garbage_fee_amount: beforeAmt },
        corrected_value: { garbage_fee_amount: amount, garbage_fee_frequency: freq },
        reason: `Garbage fee configuration per management (2026-11-07): ${houseName} = ${label}. Applied to every active unit of the house so the fee is billed consistently (one-time 2,000 for Mariana/Blue House/Sunview/Cream House - charged ONCE; 200 monthly elsewhere; Matangi pays no garbage fee).`,
        date: '2026-11-07', actor: 'admin-approval',
      })]
    );
    changed++;
    console.log(`OK ${t.tenant_code} (${houseName}): garbage ${beforeAmt} -> ${amount} (${freq})`);
  }
  console.log(`tenants changed: ${changed} of ${tenants.length}`);

  const chk = (await query(
    `SELECT property_name, garbage_fee_amount, garbage_fee_frequency, COUNT(*) AS n
       FROM tenants WHERE status <> 'Vacant'
      GROUP BY property_name, garbage_fee_amount, garbage_fee_frequency
      ORDER BY property_name, garbage_fee_amount`)).rows;
  console.log('\nconfiguration after sweep:');
  for (const c of chk) console.log(` ${c.property_name}: ${c.n} units @ ${c.garbage_fee_amount} (${c.garbage_fee_frequency})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
