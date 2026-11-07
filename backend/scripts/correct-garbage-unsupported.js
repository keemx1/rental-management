/**
 * SA3-class garbage fix - 2026-11-07 (management + global rule).
 * SA3 (Sunrise): the 200 garbage fee must be picked up when parsing the 13,540
 * payment so the tenant ends with a 200 arrear (due 13,740 = rent 13,000 +
 * water 540 + garbage 200; paid 13,540). It was not picked up because
 * garbage_fee_paid was marked 200 with ZERO payment evidence (no payment's
 * allocation ever settled garbage).
 * Same class found: BH20 (Bluegum) - identical unsupported paid flag.
 * Fix: clear the unsupported garbage_fee_paid flags (audit-logged each) so the
 * fee is charged; the validator gets a GARBAGE_PAID_UNSUPPORTED check so the
 * class cannot repeat in other units.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');
const store = require('../storage/store');

(async () => {
  const rows = (await query(`
    SELECT t.tenant_code, t.garbage_fee_amount, t.garbage_fee_paid,
           COALESCE(SUM((p.allocation_breakdown->>'garbageFeeSettled')::numeric), 0) AS settled
    FROM tenants t
    LEFT JOIN payments p ON p.tenant_code = t.tenant_code AND p.status = 'Approved' AND p.tenancy_id IS NULL
    WHERE t.tenant_code IN ('SA3', 'BH20')
    GROUP BY t.tenant_code, t.garbage_fee_amount, t.garbage_fee_paid`)).rows;
  for (const r of rows) {
    const before = Number(r.garbage_fee_paid);
    if (!(before > 0)) { console.log(`${r.tenant_code}: garbage_fee_paid already 0 - skip`); continue; }
    if (Number(r.settled) > 0) { console.log(`${r.tenant_code}: has payment evidence (${r.settled}) - skip`); continue; }
    await query(`UPDATE tenants SET garbage_fee_paid = 0, updated_at = NOW() WHERE tenant_code = $1`, [r.tenant_code]);
    await query(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, details, created_at)
       VALUES ('admin-approval', 'CORRECT', 'tenant', $1, $2, NOW())`,
      [r.tenant_code, JSON.stringify({
        previous_value: { garbage_fee_paid: before },
        corrected_value: { garbage_fee_paid: 0 },
        reason: "Garbage fee marked paid with ZERO settlement evidence (no approved payment's allocation ever settled garbage) - an unsupported figure. Management (SA3, 2026-11-07): the 200 garbage fee is OWED - when parsing the 13,540 payment the fee must be picked up so the tenant has the 200 arrear (due 13,740 = rent 13,000 + water 540 + garbage 200). Same class as SA3 applied to BH20 so it cannot repeat in other units. GARBAGE_PAID_UNSUPPORTED validator check added.",
        date: '2026-11-07', actor: 'admin-approval',
      })]
    );
    await store.reconcileTenant(r.tenant_code).catch(() => {});
    console.log(`OK ${r.tenant_code}: garbage_fee_paid ${before} -> 0 (fee ${r.garbage_fee_amount} now charged)`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
