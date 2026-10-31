/**
 * Acceptance test — Tenant–Unit integrity audit + water-invoice validation.
 *
 *  1. Audit is READ-ONLY management-only diagnostic (no records change)
 *  2. Detects each inconsistency class: occupied-without-identity, missing
 *     unit records, vacant-with-live-payments, orphan payments, water
 *     invoices pointing at missing tenants, duplicate unit labels,
 *     lookup_failed (the BH18 class), reserved-vs-occupied
 *  3. Correctly functioning units are NOT flagged
 *  4. Water invoice generation validates the tenant-unit relationship:
 *     missing tenant → 409 (override allowed + audited); vacant/anonymous
 *     → warnings + audit; find-tenant returns integrity flags
 *  5. Occupied statuses (Overdue / Partially Paid) are retrievable — the
 *     BH18 root-cause fix
 *  6. Admin-only endpoint; operators blocked
 *
 * Fixtures: houses 999975/999974, tenants ZZTI-*, removed afterwards.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const { validateTenantForBilling } = require('../backend/services/tenantUnitIntegrity');

const H1 = '999975'; // good house (2 units)
const H2 = '999974'; // house with a missing unit record + orphans

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ` -> ${JSON.stringify(extra)}` : '')); }
}

async function cleanup() {
  const P = [H1, H2];
  for (const sql of [
    `DELETE FROM water_invoices WHERE tenant_code LIKE 'ZZTI-%' OR house_paybill_number IN ($1,$2)`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZTI-%'`,
    `DELETE FROM documents WHERE tenant_code LIKE 'ZZTI-%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZTI-%'`,
    `DELETE FROM future_tenancies WHERE tenant_name ILIKE 'ZZTI%' OR tenant_code LIKE 'ZZTI%' OR house_paybill IN ($1,$2)`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZTI%'`,
    `DELETE FROM houses WHERE paybill_number IN ($1,$2)`,
    `DELETE FROM audit_log WHERE entity_id LIKE '%ZZTI%' OR (details::text LIKE '%ZZTI%' AND action LIKE 'water_invoice_integrity%')`,
  ]) {
    const nums = (sql.match(/\$(\d+)/g) || []).map((x) => Number(x.slice(1)));
    const n = nums.length ? Math.max(...nums) : 0;
    try { await query(sql, n ? P.slice(0, n) : []); } catch (e) { console.error('[cleanup]', e.message); }
  }
}

async function main() {
  await cleanup();
  // H1: two healthy occupied units (different statuses — BH18 class covered)
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status) VALUES ($1, 'ZZTI Good House', 2, 'unknown')`, [H1]);
  await store.createTenant({
    tenant_code: 'ZZTI-A1', name: 'ZZTI Alpha', phone_number: '+254700002001', property_name: 'ZZTI Good House',
    house_id: H1, rent_amount: 9000, deposit_amount: 4000, move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  await store.createTenant({
    tenant_code: 'ZZTI-A2', name: 'ZZTI Bravo', phone_number: '+254700002002', property_name: 'ZZTI Good House',
    house_id: H1, rent_amount: 9000, deposit_amount: 4000, move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Partially Paid',
  });
  await query(`UPDATE tenants SET status = 'Overdue' WHERE tenant_code = 'ZZTI-A2'`); // occupied, non-standard status

  // H2: configured for 3 units but only 1 record + orphan payment + vacant with money + anonymous occupant
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status) VALUES ($1, 'ZZTI Broken House', 5, 'unknown')`, [H2]);
  await store.createTenant({
    tenant_code: 'ZZTI-B1', name: 'ZZTI Beta', phone_number: '+254700002003', property_name: 'ZZTI Broken House',
    house_id: H2, rent_amount: 8000, deposit_amount: 4000, move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  // Orphan payment: normally IMPOSSIBLE (FK RESTRICT) — attempt a direct
  // constraint bypass for the test; if the DB owner rights deny it, the
  // orphan assertions are skipped (the audit check remains as defense).
  let orphanFixture = false;
  try {
    await query(`ALTER TABLE payments DISABLE TRIGGER ALL`);
    await query(
      `INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, payment_mode, tenancy_id)
       VALUES ('ZZTI-GHOST', 3000, '2026-10-05', 'Approved', 'rent', 'R-GHOST', 'MPGHOST', 'M-Pesa', NULL)`
    );
    orphanFixture = true;
  } catch (_) {
    console.warn('[fixture] orphan payment fixture skipped (FK/TRIGGER guard active — production-safe)');
  } finally {
    try { await query(`ALTER TABLE payments ENABLE TRIGGER ALL`); } catch (_) {}
  }
  // Vacant unit still holding live money (payment taken while occupied,
  // then the unit was vacated without sealing — the inconsistency).
  await store.createTenant({
    tenant_code: 'ZZTI-V1', name: 'ZZTI Vacant', phone_number: '+254700002004', property_name: 'ZZTI Broken House',
    house_id: H2, rent_amount: 8000, deposit_amount: 4000, move_in_date: '2026-01-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  await query(
    `INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, payment_mode, tenancy_id)
     VALUES ('ZZTI-V1', 2000, '2026-09-05', 'Approved', 'deposit', 'R-VAC', 'MPVAC', 'M-Pesa', NULL)`
  );
  await query(`UPDATE tenants SET status = 'Vacant' WHERE tenant_code = 'ZZTI-V1'`);
  // Occupied but anonymous (no name)
  await store.createTenant({
    tenant_code: 'ZZTI-N1', name: 'ZZTI Noname', phone_number: '+254700002005', property_name: 'ZZTI Broken House',
    house_id: H2, rent_amount: 8000, deposit_amount: 4000, move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  await query(`UPDATE tenants SET name = '' WHERE tenant_code = 'ZZTI-N1'`);
  // Water invoice pointing at a missing tenant — also impossible normally
  // (enforce_valid_tenant_property); bypass for the fixture, else skip.
  let ghostInvoiceFixture = false;
  try {
    await query(`ALTER TABLE water_invoices DISABLE TRIGGER ALL`);
    await query(
      `INSERT INTO water_invoices (wtr_number, tenant_code, billing_month, units_used, total_amount, due_date, status, tenancy_id, house_paybill_number)
       VALUES ('WTR-GHOST', 'ZZTI-GHOST2', '2026-10', 3, 150, '2026-11-05', 'Finalized', NULL, $1)`,
      [H2]
    );
    ghostInvoiceFixture = true;
  } catch (_) {
    console.warn('[fixture] ghost water-invoice fixture skipped (integrity trigger active — production-safe)');
  } finally {
    try { await query(`ALTER TABLE water_invoices ENABLE TRIGGER ALL`); } catch (_) {}
  }

  const countsBefore = (await query(
    `SELECT (SELECT COUNT(*) FROM tenants)::int AS t, (SELECT COUNT(*) FROM payments)::int AS p,
            (SELECT COUNT(*) FROM water_invoices)::int AS w, (SELECT COUNT(*) FROM houses)::int AS h`
  )).rows[0];

  const app = express();
  app.use(express.json());
  app.use('/api/financial', require('../backend/routes/financial'));
  app.use('/api/water-invoices', require('../backend/routes/waterInvoices'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const PORT = srv.address().port;
  const admin = (await query(`SELECT id, username, role FROM users WHERE role = 'admin' AND is_active IS DISTINCT FROM false ORDER BY id LIMIT 1`)).rows[0];
  const adminToken = jwt.sign({ sub: admin.id, username: admin.username, role: admin.role }, process.env.JWT_SECRET, { expiresIn: '15m' });
  await query(`INSERT INTO users (username, password_hash, display_name, role, is_active)
    VALUES ('zzti-ops', 'x', 'ZZTI Operator', 'operator', true)
    ON CONFLICT (username) DO UPDATE SET role = 'operator', is_active = true`);
  const ops = (await query(`SELECT id, username, role FROM users WHERE username = 'zzti-ops'`)).rows[0];
  const opsToken = jwt.sign({ sub: ops.id, username: ops.username, role: ops.role }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const call = async (method, p, body, token = adminToken, base = '/api/financial') => {
    const res = await fetch(`http://127.0.0.1:${PORT}${base}${p}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };

  try {
    // ═══ 1/2/3. Audit detects each class; healthy units untouched ════════
    const audit = (await call('GET', '/unit-integrity')).json;
    check(audit && audit.read_only === true, `1. audit returns read-only report (HTTP ok)`);
    const types = (audit.exceptions || []).map((e) => e.type);
    check(types.includes('occupied_without_identity'), `2. anonymous occupant flagged (${types.filter((t) => t === 'occupied_without_identity').length})`);
    check(types.includes('missing_unit_records'), '2b. property with fewer unit records than configured flagged');
    check(types.includes('orphan_payments') === orphanFixture || !orphanFixture,
      `2c. orphan payments flagged when fixture possible (${orphanFixture})`, types);
    check(types.includes('vacant_with_live_payments'), '2d. vacant unit holding live money flagged');
    check(types.includes('invoice_tenant_missing') === ghostInvoiceFixture || !ghostInvoiceFixture,
      `2e. water invoice with missing tenant flagged when fixture possible (${ghostInvoiceFixture})`, types);
    check(!types.includes('lookup_failed'), '2f. healthy occupied units (Active + Overdue) are retrievable — NO false lookup failures');
    const goodA1 = (audit.exceptions || []).find((e) => e.unit === 'ZZTI-A1');
    const goodA2 = (audit.exceptions || []).find((e) => e.unit === 'ZZTI-A2');
    check(!goodA1 && !goodA2, '3. correctly functioning units are NOT in the exception list');
    check(audit.summary.properties_checked >= 2 && audit.summary.tenants_checked >= 5, '3b. audit scoped across properties/tenants');

    // Read-only proof
    const countsAfter = (await query(
      `SELECT (SELECT COUNT(*) FROM tenants)::int AS t, (SELECT COUNT(*) FROM payments)::int AS p,
              (SELECT COUNT(*) FROM water_invoices)::int AS w, (SELECT COUNT(*) FROM houses)::int AS h`
    )).rows[0];
    check(JSON.stringify(countsAfter) === JSON.stringify(countsBefore),
      `1b. audit changed NOTHING (${JSON.stringify(countsAfter)})`, countsBefore);

    // ═══ 4/5. Water-invoice validation ══════════════════════════════════
    // BH18-class fix: Overdue / Partially Paid occupants ARE retrievable
    const foundOverdue = await store.findTenantByPropertyAndUnit(H1, 'ZZTI-A2');
    check(foundOverdue && foundOverdue.tenant_code === 'ZZTI-A2',
      `5. Overdue occupant retrievable by unit lookup (got ${foundOverdue && foundOverdue.status})`);

    // find-tenant returns integrity flags (warnings for vacant etc.)
    const ft = await call('GET', `/find-tenant/${H1}/ZZTI-A1`, {}, adminToken, '/api/water-invoices');
    check(ft.status === 200 && ft.json.integrity && ft.json.integrity.ok === true,
      '4. find-tenant returns integrity flags', ft.json.integrity);

    // Missing tenant → 409 with a clear code; override proceeds + audits
    let r = await call('POST', '/', {
      tenant_code: 'ZZTI-NOBODY', billing_month: '2026-10', previous_reading: 0, current_reading: 5, rate_per_unit: 50,
    }, adminToken, '/api/water-invoices');
    check(r.status === 409 && r.json.code === 'TENANT_MISSING',
      `4b. billing a missing tenant refused (HTTP ${r.status})`, r.json);
    r = await call('POST', '/', {
      tenant_code: 'ZZTI-NOBODY', billing_month: '2026-10', previous_reading: 0, current_reading: 5, rate_per_unit: 50, override: true,
    }, adminToken, '/api/water-invoices');
    // Override path: either created (if other validations pass) or another
    // guard rejects — but never silently proceeds without an audit trail.
    const ovrAudit = (await query(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'water_invoice_integrity_override' AND entity_id = 'ZZTI-NOBODY'`
    )).rows[0].n;
    check(ovrAudit === 1, `4c. override path audited (${ovrAudit})`, r.json);

    // Property/unit mismatch refused
    r = await call('POST', '/', {
      tenant_code: 'ZZTI-A1', billing_month: '2026-10', previous_reading: 0, current_reading: 5, rate_per_unit: 50,
      house_paybill_number: H2,
    }, adminToken, '/api/water-invoices');
    check(r.status === 409 && r.json.code === 'PROPERTY_MISMATCH',
      `4d. tenant billed against the wrong property refused (HTTP ${r.status})`);

    // Valid billing works normally (healthy flow unchanged)
    r = await call('POST', '/', {
      tenant_code: 'ZZTI-A1', billing_month: '2026-10', previous_reading: 10, current_reading: 20, rate_per_unit: 60,
    }, adminToken, '/api/water-invoices');
    check(r.status === 201 && r.json.water_invoice, `4e. healthy unit bills normally (HTTP ${r.status})`, r.json);

    // ═══ 6. Access control ═══════════════════════════════════════════════
    const op = await call('GET', '/unit-integrity', {}, opsToken);
    check(op.status === 403, `6. operator blocked from the audit (HTTP ${op.status})`);
    const noAuth = await fetch(`http://127.0.0.1:${PORT}/api/financial/unit-integrity`);
    check(noAuth.status === 401, `6b. unauthenticated blocked (HTTP ${noAuth.status})`);

    // Frontend markers
    const idx = await (await fetch('http://127.0.0.1:3003/')).text();
    check(idx.includes('Unit–Tenant Integrity Audit') && idx.includes('id="fin-integrity-tbody"'),
      '7. integrity audit panel served in the Financial view');
    const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js')).text();
    check(appJs.includes('loadUnitIntegrity') && appJs.includes('finUnitIntegrity'),
      '7b. audit loader served');

    console.log('\n(diagnostic only — no records modified)');
  } finally {
    srv.close();
  }
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n===============================\nRESULT: ${pass} passed, ${fail} failed`);
    if (failures.length) console.log('FAILURES:\n - ' + failures.join('\n - '));
    process.exit(fail ? 1 : 0);
  })
  .catch(async (e) => {
    console.error(e);
    try { await cleanup(); } catch (_) {}
    process.exit(1);
  });
