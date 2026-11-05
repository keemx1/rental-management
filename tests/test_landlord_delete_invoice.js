/**
 * Regression - landlord delete (detach-not-delete) + commission invoice
 * payment method (2026-11-06).
 *
 * 1. Delete worked only by accident before: the detach UPDATEs targeted tables
 *    without landlord_id and swallowed the failure - which aborted the Postgres
 *    transaction and killed the delete with "current transaction is aborted".
 *    Now: only tables that carry landlord_id are detached (nullable columns),
 *    every detach must succeed, financial history is preserved (landlord_id
 *    NULL), houses are unassigned, the landlord row is removed and audited.
 * 2. The commission invoice prints the payment method filled in at generation
 *    (Buy Goods Till / M-PESA Paybill + number + account) instead of a
 *    hardcoded paybill block.
 *
 * Fixtures: house 999988, landlord ZZDL Landlord, tenants ZZDL-*. No sends.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const { buildCommissionInvoiceHtml } = require('../backend/services/documentStore');

const HOUSE = '999988';
let pass = 0, fail = 0;
const failures = [];
const check = (ok, label, extra) => {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};

async function cleanup() {
  for (const sql of [
    `DELETE FROM landlord_remittance_payments WHERE house_paybill_number = $1`,
    `DELETE FROM commission_payments WHERE house_paybill_number = $1`,
    `DELETE FROM commission_invoices WHERE house_paybill_number = $1`,
    `DELETE FROM documents WHERE house_paybill_number = $1`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZDL-%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZDL-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZDL-%'`,
    `DELETE FROM houses WHERE paybill_number = $1`,
    `DELETE FROM landlords WHERE name LIKE 'ZZDL%'`,
    `DELETE FROM audit_log WHERE entity_id LIKE '%ZZDL%' OR details::text LIKE '%ZZDL%'`,
  ]) {
    try { await query(sql, sql.includes('$1') ? [HOUSE] : undefined); } catch (e) { console.error('[cleanup]', e.message); }
  }
}

(async () => {
  await cleanup();
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status) VALUES ($1, 'ZZDL House', 2, 'unknown')`, [HOUSE]);
  await store.createTenant({
    tenant_code: 'ZZDL-01', name: 'ZZDL Tenant', phone_number: '+254700001801',
    property_name: 'ZZDL House', house_id: HOUSE, rent_amount: 10000, deposit_amount: 5000, deposit_paid: 5000,
    move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  await query(`UPDATE tenants SET rent_paid_this_month = 10000 WHERE tenant_code = 'ZZDL-01'`);
  await query(`INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode)
    VALUES ('ZZDL-01', 10000, '2026-11-05', 'Approved', 'rent', 'R-DL-1', 'MP-R-DL-1', '2026-11', 'M-Pesa')`);

  const app = express();
  app.use(express.json());
  app.use('/api/landlords', require('../backend/routes/landlords'));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const PORT = srv.address().port;
  const admin = (await query(`SELECT id, username, role FROM users WHERE role = 'admin' AND is_active IS DISTINCT FROM false ORDER BY id LIMIT 1`)).rows[0];
  const token = jwt.sign({ sub: admin.id, username: admin.username, role: admin.role }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/landlords${p}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };

  try {
    const l = (await call('POST', '/', { name: 'ZZDL Landlord', phone: '0721499999' })).json.landlord;
    check(!!l, 'setup landlord created');
    const a = await call('POST', `/${l.id}/assign-house`, { house_paybill_number: HOUSE });
    check(a.status === 200, 'setup property assigned');

    // ---- payment method on the invoice ----
    const inv1 = await call('POST', `/${l.id}/properties/${HOUSE}/commission-invoice`, {
      billing_month: '2026-11', payment_method: 'till', payment_number: '123456', payment_account_name: 'Gutenberg Elite',
    });
    check(inv1.status === 200 && inv1.json.invoice, `1. invoice generated (HTTP ${inv1.status})`, inv1.json && inv1.json.error);
    const row = (await query(`SELECT * FROM commission_invoices WHERE id = $1`, [inv1.json.invoice.id])).rows[0];
    check(row.payment_method === 'till' && row.payment_number === '123456',
      '2. filled-in payment method stored on the invoice', row);
    const landlordRow = (await query(`SELECT * FROM landlords WHERE id = $1`, [l.id])).rows[0];
    const houseRow = (await query(`SELECT * FROM houses WHERE paybill_number = $1`, [HOUSE])).rows[0];
    const html = buildCommissionInvoiceHtml(row, landlordRow, houseRow);
    check(html.includes('Buy Goods Till 123456') && html.includes('Gutenberg Elite'),
      '3. invoice PDF shows the chosen Till (not the hardcoded paybill block)', html.slice(0, 400));

    const inv2 = await call('POST', `/${l.id}/properties/${HOUSE}/commission-invoice`, {
      billing_month: '2026-11', payment_method: 'paybill', payment_number: '4086873', payment_account_name: 'ZZDL Landlord',
    });
    const row2 = (await query(`SELECT * FROM commission_invoices WHERE id = $1`, [inv2.json.invoice.id])).rows[0];
    const html2 = buildCommissionInvoiceHtml(row2, landlordRow, houseRow);
    check(html2.includes('M-PESA Paybill 4086873') && html2.includes('Account Number: ZZDL Landlord'),
      '4. paybill method renders as Paybill + account name', html2.slice(0, 400));

    // ---- delete: detach-not-delete (the old "current transaction is aborted") ----
    const del = await call('DELETE', `/${l.id}`);
    check(del.status === 200 && del.json.success, `5. landlord WITH commission history deletes cleanly (HTTP ${del.status})`, del.json);
    const lAfter = (await query(`SELECT * FROM landlords WHERE id = $1`, [l.id])).rows[0];
    check(!lAfter, '5b. landlord row removed');
    const det = (await query(`SELECT landlord_id FROM commission_invoices WHERE house_paybill_number = $1`, [HOUSE])).rows;
    check(det.length > 0 && det.every((r) => r.landlord_id === null),
      '5c. commission invoices PRESERVED with landlord link detached (not deleted)', det);
    const hAfter = (await query(`SELECT landlord_id FROM houses WHERE paybill_number = $1`, [HOUSE])).rows[0];
    check(hAfter.landlord_id === null, '5d. house unassigned from the deleted landlord', hAfter);
    const aud = (await query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'landlord_deleted' AND entity_id = $1`, [String(l.id)])).rows[0].n;
    check(aud === 1, `5e. deletion audited (${aud})`);

    // duplicate-style landlord with no properties still deletes
    const l2 = (await call('POST', '/', { name: 'ZZDL Landlord', phone: '0721499999' })).json.landlord;
    const del2 = await call('DELETE', `/${l2.id}`);
    check(del2.status === 200 && del2.json.success,
      `6. property-less duplicate landlord deletes (was the "current transaction is aborted" error) (HTTP ${del2.status})`, del2.json);
  } finally {
    srv.close();
  }

  await cleanup();
  console.log(`\n===============================\nRESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await cleanup(); } catch (_) {} process.exit(1); });
