/**
 * Acceptance test — Universal Global Search.
 *
 * Verifies (client spec):
 *  One search covers the ENTIRE system: tenants, former tenants, properties,
 *  landlords, rent/water/exit invoices, pre-exit inspections, payments +
 *  M-Pesa references (with receipt deep links), penalties, work orders,
 *  maintenance records, management expense invoices, documents/receipts/
 *  reports, landlord commission invoices + payments, deposit refunds —
 *  every result carries a kind for DIRECT navigation to the exact record.
 *
 * Fixtures: house 999989, tenant ZZGS-*, removed afterwards.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');

const CODE = 'ZZGS-01';
const HOUSE = '999989';

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ` -> ${JSON.stringify(extra)}` : '')); }
}

const groupKeys = (res) => (res.groups || []).map((g) => g.key);
const findItem = (res, key) => {
  const g = (res.groups || []).find((x) => x.key === key);
  return g ? g.items[0] : null;
};

async function cleanup() {
  for (const sql of [
    `DELETE FROM preexit_inspections WHERE tenant_code LIKE 'ZZGS-%'`,
    `DELETE FROM commission_payments WHERE house_paybill_number = $1`,
    `DELETE FROM commission_invoices WHERE house_paybill_number = $1`,
    `DELETE FROM landlords WHERE name LIKE 'ZZGS Landlord%'`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZGS-%'`,
    `DELETE FROM penalties WHERE tenant_code LIKE 'ZZGS-%'`,
    `DELETE FROM water_invoices WHERE tenant_code LIKE 'ZZGS-%'`,
    `DELETE FROM exit_invoices WHERE tenant_code LIKE 'ZZGS-%'`,
    `DELETE FROM tenancy_archive WHERE tenant_code LIKE 'ZZGS-%'`,
    `DELETE FROM documents WHERE tenant_code LIKE 'ZZGS-%' OR house_paybill_number = $1`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZGS-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZGS-%'`,
    `DELETE FROM houses WHERE paybill_number = $1`,
  ]) {
    try { await query(sql, sql.includes('$1') ? [HOUSE] : undefined); } catch (_) {}
  }
}

async function main() {
  await cleanup();
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status) VALUES ($1, 'ZZGS House Alpha', 4, 'unknown')`, [HOUSE]);
  await store.createTenant({
    tenant_code: CODE, name: 'ZZGS Tenant Searchable', phone_number: '+254700001201',
    property_name: 'ZZGS House Alpha', house_id: HOUSE, rent_amount: 10000, deposit_amount: 5000,
    move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  await query(
    `INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode, tenancy_id)
     VALUES ($1, 5000, '2026-10-05', 'Approved', 'rent', 'R-GS-1', 'MPGSREF1', '2026-10', 'M-Pesa', NULL)`, [CODE]
  );
  await query(
    `INSERT INTO documents (doc_type, doc_number, title, filename, file_path, tenant_code, house_paybill_number, amount, doc_date)
     VALUES ('receipt', 'R-GS-1', 'Receipt R-GS-1', 'receipt-R-GS-1.pdf', 'C:/nonexistent-r-gs-1.pdf', $1, $2, 5000, '2026-10-05')`, [CODE, HOUSE]
  );
  await query(
    `INSERT INTO penalties (tenant_code, description, amount, invoice_date, status, category, invoice_number, tenancy_id)
     VALUES ($1, 'ZZGS late penalty', 500, '2026-10-10', 'Pending', 'penalty', 'INV-GS-1', NULL)`, [CODE]
  );
  await query(
    `INSERT INTO water_invoices (wtr_number, tenant_code, billing_month, units_used, total_amount, due_date, status, tenancy_id)
     VALUES ('WTR-GS-1', $1, '2026-10', 5, 250, '2026-11-05', 'Finalized', NULL)`, [CODE]
  );
  await query(
    `INSERT INTO tenancy_archive (tenant_code, tenant_name, property_name, unit_label, house_paybill_number, move_in_date, move_out_date, archived_at)
     VALUES ($1, 'ZZGS Former Tenant', 'ZZGS House Alpha', $1, $2, '2025-01-01', '2025-12-31', NOW())`, [CODE, HOUSE]
  );
  await query(
    `INSERT INTO preexit_inspections (tenant_code, tenancy_id, house_paybill_number, property_name, unit_label, tenant_name, inspection_date, status)
     VALUES ($1, NULL, $2, 'ZZGS House Alpha', $1, 'ZZGS Tenant Searchable', '2026-10-20', 'Draft')`, [CODE, HOUSE]
  );
  const ll = (await query(`INSERT INTO landlords (name, phone) VALUES ('ZZGS Landlord', '+254700001200') RETURNING id`)).rows[0];
  await query(`UPDATE houses SET landlord_id = $1 WHERE paybill_number = $2`, [ll.id, HOUSE]);
  await query(
    `INSERT INTO commission_invoices (invoice_number, landlord_id, house_paybill_number, billing_month, rent_collected, commission_rate, commission_amount, previous_balance, payments_applied, total_payable, status)
     VALUES ('GEHPM-COM-GS', $1, $2, '2026-10', 10000, 5, 500, 0, 0, 500, 'Issued')`, [ll.id, HOUSE]
  );
  await query(
    `INSERT INTO commission_payments (landlord_id, house_paybill_number, payment_date, amount, method, reference)
     VALUES ($1, $2, '2026-10-10', 200, 'M-Pesa', 'MPCOMMGS1')`, [ll.id, HOUSE]
  );

  const exitInv = await store.createExitInvoice(CODE, { reason: 'test search' });

  // ════ store.globalSearch across every entity ══════════════════════════════
  let res = await store.globalSearch('ZZGS Tenant Searchable');
  check(findItem(res, 'tenants') && findItem(res, 'tenants').id === CODE,
    '1. tenant by name', groupKeys(res));

  res = await store.globalSearch('zzgs-01'); // case-insensitive
  const keys = groupKeys(res);
  check(keys.includes('tenants') && keys.includes('penalties') && keys.includes('water_invoices')
    && keys.includes('preexit_inspections') && keys.includes('former_tenants'),
    '2. unit code hits tenants + penalties + water + pre-exit + archive', keys);
  check(findItem(res, 'preexit_inspections') && findItem(res, 'preexit_inspections').kind === 'preexit',
    '2b. pre-exit inspection form findable (kind preexit)');

  res = await store.globalSearch('ZZGS House Alpha');
  check(groupKeys(res).includes('properties'), '3. property by name');
  const prop = findItem(res, 'properties');
  check(prop && prop.kind === 'house', '3b. property kind = direct house deep link');

  res = await store.globalSearch('ZZGS Former Tenant');
  check(groupKeys(res).includes('former_tenants'), '4. former tenant from archive');

  res = await store.globalSearch('R-GS-1');
  const payItem = findItem(res, 'payments');
  check(payItem && payItem.kind === 'payment', '5. payment by receipt number');
  check(payItem && Number(payItem.receipt_document_id) > 0,
    '5b. payment carries receipt document id for direct PDF deep link', payItem);
  check(groupKeys(res).includes('documents'), '5c. receipt also found in documents');

  res = await store.globalSearch('MPGSREF1');
  check(findItem(res, 'payments') && findItem(res, 'payments').label.includes('5,000'),
    '6. payment by M-Pesa reference');

  res = await store.globalSearch('WTR-GS-1');
  check(findItem(res, 'water_invoices') && findItem(res, 'water_invoices').kind === 'water_invoice',
    '7. water invoice by number');

  res = await store.globalSearch('INV-GS-1');
  check(findItem(res, 'penalties') && findItem(res, 'penalties').kind === 'penalty',
    '8. penalty by invoice number');

  res = await store.globalSearch(exitInv.exit_number);
  check(findItem(res, 'exit_invoices') && findItem(res, 'exit_invoices').kind === 'exit_invoice'
    && findItem(res, 'exit_invoices').tenant_code === CODE,
    '9. exit invoice by number (with tenant for deep link)');

  res = await store.globalSearch('ZZGS Landlord');
  check(groupKeys(res).includes('landlords'), '10. landlord by name');
  check(groupKeys(res).includes('landlords') && groupKeys(res).includes('commission_invoices')
    && groupKeys(res).includes('commission_payments'),
    '10b. landlord search also surfaces commission invoices + payments', keys);

  res = await store.globalSearch('GEHPM-COM-GS');
  check(findItem(res, 'commission_invoices') && findItem(res, 'commission_invoices').kind === 'commission_invoice',
    '11. commission invoice by invoice number');

  res = await store.globalSearch('MPCOMMGS1');
  check(findItem(res, 'commission_payments') && findItem(res, 'commission_payments').kind === 'commission_payment',
    '12. commission payment by M-Pesa reference');

  res = await store.globalSearch('DOC-GS-MISSING');
  check((res.groups || []).length === 0, '13. no false matches');
  res = await store.globalSearch('x');
  check((res.groups || []).length === 0 && res.q === 'x', '14. under 2 chars -> empty (no scan)');

  // ════ HTTP route + auth ═══════════════════════════════════════════════════
  const u = (await query(`SELECT id, username, role FROM users WHERE is_active IS DISTINCT FROM false ORDER BY (role = 'admin') DESC, id LIMIT 1`)).rows[0];
  const token = jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '20m' });
  const app = express();
  app.use(express.json());
  app.use('/api/search', require('../backend/routes/search'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const PORT = srv.address().port;
  try {
    let http = await fetch(`http://127.0.0.1:${PORT}/api/search?q=ZZGS%20Landlord`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    let json = await http.json();
    check(http.status === 200 && json.groups.some((g) => g.key === 'landlords'),
      `15. GET /api/search route works (HTTP ${http.status})`);
    http = await fetch(`http://127.0.0.1:${PORT}/api/search?q=zz`, { headers: {} });
    check(http.status === 401, `15b. search requires auth (HTTP ${http.status})`);

    // Frontend markers
    const idx = await (await fetch('http://127.0.0.1:3003/')).text();
    check(idx.includes('id="global-search"') && idx.includes('id="ne-bell"')
      && idx.includes('data-nav="preexit-inspection"') && idx.includes('id="btn-ei-preexit"'),
      '16. minimal search bar + bell + pre-exit placement served');
    const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js')).text();
    check(appJs.includes('handleSearchResultGo') && appJs.includes("case 'commission_invoice'")
      && appJs.includes("case 'preexit'") && appJs.includes('openPreExitForUnit'),
      '16b. direct deep-link dispatcher covers commissions + pre-exit');
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
