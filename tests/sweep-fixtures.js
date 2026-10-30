/**
 * sweep-fixtures.js — delete ALL test records the suites may leave behind.
 *
 * Every suite cleans up after itself; this is the safety net for CRASHES
 * (a killed mid-run test can never complete its own cleanup). Run it after
 * any test session:
 *
 *      node tests/sweep-fixtures.js          (report)
 *      node tests/sweep-fixtures.js --apply  (delete)
 *
 * ONLY touches records that match the test-fixture markers:
 *   houses 999979-999999 and house_name 'ZZ%'
 *   tenants/tenancies tenant_code 'ZZ%'
 *   landlord fixtures named 'ZZ%', test users zz*-staff/ops
 * Real records (B1, EX001, BH46, 198, 201 …) are never matched.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { query } = require('../backend/config/database');

const APPLY = process.argv.includes('--apply');
const HOUSE_IN = `('999979','999980','999981','999982','999983','999984','999985','999986','999987','999988','999989','999990','999991','999992','999993','999994','999995','999996','999997','999998','999999')`;

// Order respects FKs (children first). Every statement is best-effort.
const STAGES = [
  ['landlord_reviews', `DELETE FROM landlord_reviews WHERE house_paybill_number IN ${HOUSE_IN}`],
  ['landlord_remittance_payments', `DELETE FROM landlord_remittance_payments WHERE house_paybill_number IN ${HOUSE_IN}`],
  ['landlord_ledger_finalizations', `DELETE FROM landlord_ledger_finalizations WHERE house_paybill_number IN ${HOUSE_IN}`],
  ['commission_payments', `DELETE FROM commission_payments WHERE house_paybill_number IN ${HOUSE_IN}`],
  ['commission_invoices', `DELETE FROM commission_invoices WHERE house_paybill_number IN ${HOUSE_IN}`],
  ['notification_log', `DELETE FROM notification_log WHERE alert_key LIKE '%9999%' OR title ILIKE 'ZZ%' OR title ILIKE '%ZZ %'`],
  ['preexit_inspections', `DELETE FROM preexit_inspections WHERE tenant_code LIKE 'ZZ%' OR tenant_code IN (SELECT tenant_code FROM tenants WHERE tenant_code LIKE 'ZZ%')`],
  ['deposit_refunds', `DELETE FROM deposit_refunds WHERE tenant_code LIKE 'ZZ%'`],
  ['exit_invoices', `DELETE FROM exit_invoices WHERE tenant_code LIKE 'ZZ%' OR house_paybill_number IN ${HOUSE_IN}`],
  ['penalties', `DELETE FROM penalties WHERE tenant_code LIKE 'ZZ%'`],
  ['water_invoices', `DELETE FROM water_invoices WHERE tenant_code LIKE 'ZZ%' OR house_paybill_number IN ${HOUSE_IN}`],
  ['maintenance_charges', `DELETE FROM maintenance_charges WHERE tenant_code LIKE 'ZZ%' OR wo_number LIKE 'ZZ%'`],
  ['work_orders', `DELETE FROM work_orders WHERE wo_number LIKE 'ZZ%' OR house_paybill_number IN ${HOUSE_IN}`],
  ['future_payments', `DELETE FROM future_payments WHERE future_tenancy_id IN (SELECT id FROM future_tenancies WHERE tenant_name ILIKE 'ZZ%' OR tenant_code LIKE 'ZZ%' OR house_paybill IN ${HOUSE_IN})`],
  ['future_tenancies', `DELETE FROM future_tenancies WHERE tenant_name ILIKE 'ZZ%' OR tenant_code LIKE 'ZZ%' OR house_paybill IN ${HOUSE_IN}`],
  ['credit_allocations', `DELETE FROM credit_allocations WHERE tenant_code LIKE 'ZZ%'`],
  ['tenancy_archive', `DELETE FROM tenancy_archive WHERE tenant_code LIKE 'ZZ%' OR house_paybill_number IN ${HOUSE_IN}`],
  ['documents', `DELETE FROM documents WHERE tenant_code LIKE 'ZZ%' OR house_paybill_number IN ${HOUSE_IN}`],
  ['message_logs', `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZ%'`],
  ['whatsapp_message_log', `DELETE FROM whatsapp_message_log WHERE tenant_code LIKE 'ZZ%' OR phone_number IN ('+254700001101','+254700001102','+254700001103','+254700001201','+254700001300','+254700001301','+254700001302','+254700001400','+254700001401','+254700001501','+254700001601','+254700001701','+254700001702','+254700001801','+254700001901','+254700001902','+254700001903','+254700001904')`],
  ['tenancy_agreements', `DELETE FROM tenancy_agreements WHERE tenant_code LIKE 'ZZ%'`],
  ['payments', `DELETE FROM payments WHERE tenant_code LIKE 'ZZ%'`],
  ['sync_queue/other', `DELETE FROM notice_queue WHERE tenant_code LIKE 'ZZ%'`],
  ['users', `DELETE FROM users WHERE username LIKE 'zz%-staff' OR username LIKE 'zz%-ops' OR username LIKE 'zz%-test'`],
  ['landlords', `DELETE FROM landlords WHERE name ILIKE 'ZZ%'`],
  ['tenants', `DELETE FROM tenants WHERE tenant_code LIKE 'ZZ%' OR name ILIKE 'ZZ %'`],
  ['houses', `DELETE FROM houses WHERE paybill_number IN ${HOUSE_IN} OR house_name ILIKE 'ZZ%'`],
  ['audit_log', `DELETE FROM audit_log WHERE entity_id LIKE '%ZZ%' OR entity_id LIKE '%9999%' OR details::text LIKE '%ZZ-%' OR details::text LIKE '%99998%' OR details::text LIKE '%99999%'`],
  ['water_rates', `DELETE FROM water_rates WHERE house_paybill IN ${HOUSE_IN}`],
  ['rate history', `DELETE FROM water_rate_history WHERE house_paybill IN ${HOUSE_IN}`],
];

async function main() {
  let total = 0;
  for (const [label, sql] of STAGES) {
    try {
      if (APPLY) {
        const r = await query(sql);
        if (r.rowCount) {
          total += r.rowCount;
          console.log(`DELETED ${String(r.rowCount).padStart(4)}  ${label}`);
        }
      } else {
        // Read-only: rewrite DELETE -> COUNT(*) so a dry run never mutates.
        const countSql = sql.replace(/^DELETE FROM /, 'SELECT COUNT(*) AS n FROM ');
        const r = await query(countSql);
        const n = Number(r.rows[0]?.n || 0);
        if (n) {
          total += n;
          console.log(`would delete ${String(n).padStart(4)}  ${label}`);
        }
      }
    } catch (_) {
      // Table may not exist in some environments — never fail the sweep.
    }
  }
  if (!APPLY) {
    console.log(`\nDRY RUN total: ${total} row(s) — re-run with --apply to delete.`);
  }
  const h = await query(`SELECT COUNT(*)::int AS n FROM houses WHERE paybill_number LIKE '9999%' OR house_name ILIKE 'ZZ%'`);
  const t = await query(`SELECT COUNT(*)::int AS n FROM tenants WHERE tenant_code LIKE 'ZZ%' OR name ILIKE 'ZZ %'`);
  console.log(`fixture residue check -> houses: ${h.rows[0].n}, tenants: ${t.rows[0].n} ${h.rows[0].n + t.rows[0].n === 0 ? '(CLEAN)' : '(DIRTY)'}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
