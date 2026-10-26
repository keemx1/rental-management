/**
 * Acceptance test — Landlord Commission Management (per-property accounts).
 *
 * Verifies (client spec):
 *  1. Landlord profile links many properties; each property keeps its OWN
 *     independent commission account (a payment for A never touches B)
 *  2. Automatic calculation from actual rent collected × property rate
 *     (Property A: 300,000 @5% = 15,000; Property B: 200,000 @4% = 8,000)
 *  3. Commission invoice per property (rent collected, rate, commission,
 *     previous balance, payments applied, amount payable) with a PDF
 *  4. Record payment posted against the correct property only
 *  5. Automatic carry-forward (Oct: prev 5,000 + 10,000 − payments; Nov
 *     previous balance = Oct's closing — no manual opening balances)
 *  6. Per-property statement (ledger with running balance) + PDF
 *  7. Regeneration-safe duplicate protection (one active invoice per
 *     property-month) and voiding
 *  8. Landlord mismatch payments refused (409); unassigned property refused
 *  9. Landlord overview shows property-by-property outstanding + total
 *
 * Fixtures: houses 999992/999991/999990, tenants ZZLL-*, removed afterwards.
 * No real messages sent.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const commission = require('../backend/services/landlordCommission');

const HOUSE_A = '999992';
const HOUSE_B = '999991';
const HOUSE_C = '999990'; // unassigned

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ` -> ${JSON.stringify(extra)}` : '')); }
}

async function cleanup() {
  let filePaths = [];
  try {
    const docs = await query(`SELECT file_path FROM documents WHERE (house_paybill_number IN ($1,$2,$3) OR doc_number LIKE 'GEHPM-COM-%') AND file_path IS NOT NULL`, [HOUSE_A, HOUSE_B, HOUSE_C]);
    filePaths = docs.rows.map((r) => r.file_path).filter(Boolean);
  } catch (_) {}
  for (const sql of [
    `DELETE FROM commission_payments WHERE house_paybill_number IN ($1,$2,$3)`,
    `DELETE FROM commission_invoices WHERE house_paybill_number IN ($1,$2,$3)`,
    `DELETE FROM documents WHERE house_paybill_number IN ($1,$2,$3)`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZLL-%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZLL-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZLL-%'`,
    `DELETE FROM houses WHERE paybill_number IN ($1,$2,$3)`,
    `DELETE FROM landlords WHERE name LIKE 'ZZLL Landlord%'`,
  ]) {
    try { await query(sql, sql.includes('$1') ? [HOUSE_A, HOUSE_B, HOUSE_C] : []); } catch (e) { console.error('[cleanup]', e.message); }
  }
  for (const p of filePaths) { try { fs.unlinkSync(p); } catch (_) {} }
}

async function makeToken() {
  const u = (await query(
    `SELECT id, username, role FROM users WHERE is_active IS DISTINCT FROM false ORDER BY (role = 'admin') DESC, id LIMIT 1`
  )).rows[0];
  return jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '20m' });
}

const pay = (tenant, date, amount, month) => query(
  `INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode, tenancy_id)
   VALUES ($1,$2,$3,'Approved','rent',$4,$5,$6,'M-Pesa',NULL)`,
  [tenant, amount, date, `R-${tenant}-${date}`, `MP-${tenant}-${date}`, month]
);

async function main() {
  await cleanup();
  for (const [hp, name] of [[HOUSE_A, 'ZZLL House A'], [HOUSE_B, 'ZZLL House B'], [HOUSE_C, 'ZZLL House C']]) {
    await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status) VALUES ($1, $2, 4, 'unknown')`, [hp, name]);
  }
  await store.createTenant({
    tenant_code: 'ZZLL-01', name: 'ZZLL Tenant A1', phone_number: '+254700001101',
    property_name: 'ZZLL House A', house_id: HOUSE_A, rent_amount: 300000, deposit_amount: 5000,
    move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  await store.createTenant({
    tenant_code: 'ZZLL-03', name: 'ZZLL Tenant B1', phone_number: '+254700001103',
    property_name: 'ZZLL House B', house_id: HOUSE_B, rent_amount: 200000, deposit_amount: 5000,
    move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  await pay('ZZLL-01', '2026-09-05', 300000, '2026-09');   // A: Sept collected 300k
  await pay('ZZLL-01', '2026-10-05', 200000, '2026-10');   // A: Oct collected 200k
  await pay('ZZLL-03', '2026-10-05', 200000, '2026-10');   // B: Oct collected 200k

  const app = express();
  app.use(express.json());
  app.use('/api/landlords', require('../backend/routes/landlords'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const PORT = srv.address().port;
  const token = await makeToken();
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/landlords${p}`, {
      method, headers: auth, body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };

  try {
    // ── 1. Landlord + property assignment ──────────────────────────────────
    let r = await call('POST', '/', { name: 'ZZLL Landlord One', phone: '+254700001100' });
    check(r.status === 201 && r.json.landlord, `1. landlord created (HTTP ${r.status})`, r.json);
    const LL = r.json.landlord.id;
    r = await call('POST', `/${LL}/assign-house`, { house_paybill_number: HOUSE_A });
    check(r.status === 200 && r.json.ok, '1b. Property A assigned');
    r = await call('POST', `/${LL}/assign-house`, { house_paybill_number: HOUSE_B });
    check(r.status === 200, '1c. Property B assigned (same landlord, separate accounts)');
    await store.setCommissionRate(HOUSE_A, 5, 'test');
    await store.setCommissionRate(HOUSE_B, 4, 'test');

    // ── 2. Property A: 300,000 @ 5% = 15,000 ───────────────────────────────
    r = await call('POST', `/${LL}/properties/${HOUSE_A}/commission-invoice`, { billing_month: '2026-09' });
    check(r.status === 200 && r.json.invoice, `2. Property A Sep invoice generated (HTTP ${r.status})`, r.json);
    let invA = r.json.invoice;
    check(Number(invA.rent_collected) === 300000 && Number(invA.commission_rate) === 5,
      `2b. rent collected 300,000 @ 5% (got ${invA.rent_collected} @ ${invA.commission_rate}%)`);
    check(Number(invA.commission_amount) === 15000, `2c. commission = 15,000 (got ${invA.commission_amount})`);
    check(Number(invA.previous_balance) === 0 && Number(invA.total_payable) === 15000,
      `2d. payable 15,000 (got ${invA.total_payable})`);
    check(/GEHPM-COM/.test(invA.invoice_number), `2e. invoice number issued (${invA.invoice_number})`);
    check(!!invA.document_id && fs.existsSync((await query(`SELECT file_path FROM documents WHERE id = $1`, [invA.document_id])).rows[0].file_path),
      '2f. commission invoice PDF generated');

    // ── 3. Property B: 200,000 @ 4% = 8,000 — SEPARATE account ─────────────
    r = await call('POST', `/${LL}/properties/${HOUSE_B}/commission-invoice`, { billing_month: '2026-10' });
    const invB = r.json.invoice;
    check(Number(invB.rent_collected) === 200000 && Number(invB.commission_rate) === 4 && Number(invB.commission_amount) === 8000,
      `3. Property B: 200,000 @ 4% = 8,000 (got ${invB.commission_amount})`);
    check(Number(invB.total_payable) === 8000 && Number(invB.previous_balance) === 0,
      '3b. Property B payable is B-only (never mixed with A)');

    // ── 4. Payments post to the correct property only ──────────────────────
    r = await call('POST', `/${LL}/properties/${HOUSE_A}/commission-payments`, {
      payment_date: '2026-09-20', amount: 10000, method: 'M-Pesa', reference: 'MP-LL-A1',
    });
    check(r.status === 200 && Number(r.json.outstanding) === 5000,
      `4. A pays 10,000 → A outstanding 5,000 (got ${r.json.outstanding})`);
    let ledB = await commission.getLedger(HOUSE_B);
    check(ledB.summary.outstanding === 8000, `4b. B untouched by A's payment (still 8,000, got ${ledB.summary.outstanding})`);

    // ── 5. Carry-forward: Oct A invoice ────────────────────────────────────
    r = await call('POST', `/${LL}/properties/${HOUSE_A}/commission-invoice`, { billing_month: '2026-10' });
    invA = r.json.invoice;
    check(Number(invA.previous_balance) === 5000,
      `5. Oct previous balance carried = 5,000 (got ${invA.previous_balance})`);
    check(Number(invA.commission_amount) === 10000, `5b. Oct commission on 200k @5% = 10,000 (got ${invA.commission_amount})`);
    check(Number(invA.total_payable) === 15000,
      `5c. Oct payable = 5,000 + 10,000 = 15,000 (got ${invA.total_payable})`);
    r = await call('POST', `/${LL}/properties/${HOUSE_A}/commission-payments`, {
      payment_date: '2026-10-10', amount: 7000, method: 'Bank', reference: 'BNK-LL-A2',
    });
    check(Number(r.json.outstanding) === 8000,
      `5d. A pays 7,000 → remaining 8,000 carries forward (got ${r.json.outstanding})`);
    ledB = await commission.getLedger(HOUSE_B);
    check(ledB.summary.outstanding === 8000, '5e. Property B balance unchanged by A activity');
    r = await call('POST', `/${LL}/properties/${HOUSE_B}/commission-payments`, {
      payment_date: '2026-10-15', amount: 3000, method: 'M-Pesa', reference: 'MP-LL-B1',
    });
    check(Number(r.json.outstanding) === 5000, `5f. B pays 3,000 → B outstanding 5,000 (got ${r.json.outstanding})`);
    let ledA = await commission.getLedger(HOUSE_A);
    check(ledA.summary.outstanding === 8000, `5g. A unaffected by B's payment (still 8,000, got ${ledA.summary.outstanding})`);

    // ── 6. Statement ledger with running balance ───────────────────────────
    r = await call('POST', `/${LL}/properties/${HOUSE_A}/statement`);
    check(r.status === 200 && r.json.ledger && r.json.document, `6. statement + PDF (HTTP ${r.status})`);
    const events = r.json.ledger.events;
    check(events.length === 4, `6b. A ledger has 2 invoices + 2 payments (${events.length} rows)`);
    check(events[events.length - 1].balance === 8000,
      `6c. running balance ends at 8,000 (got ${events[events.length - 1].balance})`);
    const stmtPdf = (await query(`SELECT file_path FROM documents WHERE id = $1`, [r.json.document.id])).rows[0];
    check(fs.existsSync(stmtPdf.file_path), '6d. statement PDF file exists');

    // ── 7. Duplicate protection + void ─────────────────────────────────────
    r = await call('POST', `/${LL}/properties/${HOUSE_A}/commission-invoice`, { billing_month: '2026-09' });
    check(r.json.regenerated === true && Number(r.json.invoice.commission_amount) === 15000,
      '7. regenerating Sep refreshes the SAME invoice (no duplicate)');
    const invCount = (await query(
      `SELECT COUNT(*)::int AS n FROM commission_invoices WHERE house_paybill_number = $1 AND billing_month = '2026-09' AND status = 'Issued'`,
      [HOUSE_A]
    )).rows[0].n;
    check(invCount === 1, `7b. exactly ONE active invoice per property-month (${invCount})`);

    // ── 8. Guards: mismatch + unassigned ───────────────────────────────────
    r = await call('POST', `/${LL}/properties/${HOUSE_A}/commission-payments`, {
      payment_date: '2026-10-20', amount: 100, landlord_id: 999999,
    });
    check(r.status === 409 && r.json.code === 'LANDLORD_MISMATCH',
      `8. mismatched landlord payment refused (HTTP ${r.status})`);
    r = await call('POST', `/999999/properties/${HOUSE_C}/commission-invoice`, { billing_month: '2026-10' });
    check(r.status === 404 || r.status === 409, `8b. unassigned property cannot generate (HTTP ${r.status})`, r.json);

    // ── 9. Overview: property-by-property + combined ───────────────────────
    r = await call('GET', `/${LL}?month=2026-10`);
    check(r.status === 200 && r.json.properties.length === 2,
      `9. landlord overview lists both properties (${r.json.properties.length})`);
    const pA = r.json.properties.find((p) => p.house_paybill_number === HOUSE_A);
    const pB = r.json.properties.find((p) => p.house_paybill_number === HOUSE_B);
    check(pA && pA.outstanding === 8000 && pB && pB.outstanding === 5000,
      `9b. overview keeps accounts separate (A 8,000 / B 5,000)`, { a: pA && pA.outstanding, b: pB && pB.outstanding });
    check(r.json.total_outstanding === 13000, `9c. combined convenience total = 13,000 (got ${r.json.total_outstanding})`);

    // ── 10. Void corrects the ledger (Σ Issued only) ───────────────────────
    const sepA = (await query(
      `SELECT id FROM commission_invoices WHERE house_paybill_number = $1 AND billing_month = '2026-09' AND status = 'Issued'`, [HOUSE_A]
    )).rows[0];
    r = await call('POST', `/commission-invoices/${sepA.id}/void`);
    check(r.status === 200 && r.json.invoice.status === 'Void', `10. invoice voided (HTTP ${r.status})`);
    ledA = await commission.getLedger(HOUSE_A);
    check(ledA.summary.outstanding === -7000,
      `10b. balance recomputed without voided invoice (25,000−17,000−15,000 = −7,000, got ${ledA.summary.outstanding})`);

    // ── 11. Frontend markers ───────────────────────────────────────────────
    const idx = await (await fetch('http://127.0.0.1:3003/')).text();
    check(idx.includes('data-nav="landlords"') && idx.includes('id="global-search"'),
      '11. Landlords nav + global search bar served');
    const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js')).text();
    check(appJs.includes('openLandlordProfile') && appJs.includes('generateLandlordInvoiceNow')
      && appJs.includes('handleSearchResultGo') && appJs.includes('openPreExitForUnit'),
      '11b. landlord + search + preexit-link logic served');

    console.log('\n(no real messages were sent)');
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
