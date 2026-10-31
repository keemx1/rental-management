/**
 * audit-tenant-unit-integrity.js — READ-ONLY system-wide diagnostic.
 *
 * Compares every property's unit accounting against active tenant records
 * and lists exceptions (occupied-without-identity, missing unit records,
 * vacant-with-live-money, orphan payments, water invoices pointing at
 * missing/vacant tenants — the BH18 pattern — duplicate unit labels,
 * missing phones, reserved-vs-occupied collisions).
 *
 * NEVER modifies anything. Run:
 *   node backend/scripts/audit-tenant-unit-integrity.js          (table)
 *   node backend/scripts/audit-tenant-unit-integrity.js --json   (JSON)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { unitIntegrityAudit } = require('../services/tenantUnitIntegrity');

async function main() {
  const audit = await unitIntegrityAudit();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(audit, null, 1));
    process.exit(0);
  }
  console.log('GEHPM TENANT–UNIT INTEGRITY AUDIT (read-only diagnostic)');
  console.log(`generated: ${audit.generated_at}`);
  console.log(`properties: ${audit.summary.properties_checked} · tenants: ${audit.summary.tenants_checked}`);
  console.log(`EXCEPTIONS: ${audit.summary.exceptions} (${audit.summary.errors} errors, ${audit.summary.warnings} warnings)`);
  console.log('by type:', JSON.stringify(audit.summary.by_type));
  if (!audit.exceptions.length) {
    console.log('\nALL UNITS CONSISTENT — no exceptions found.');
    process.exit(0);
  }
  console.log('\n--- EXCEPTION LIST (management review required; nothing was modified) ---');
  for (const e of audit.exceptions) {
    console.log(`[${e.severity.toUpperCase()}] ${e.type} | ${e.property} | unit ${e.unit} | occupancy ${e.occupancy} | tenant: ${e.tenant_name || '(none)'} | ${e.tenancy_status || '—'}`);
    console.log(`    → ${e.reason}`);
  }
  process.exit(audit.summary.errors > 0 ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
