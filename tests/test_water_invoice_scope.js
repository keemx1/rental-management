/**
 * Acceptance test — Water Bill invoice deals with WATER ONLY (no rent).
 *
 * Client requirement: under Invoices, the Water Bill invoice must cover
 * water only — rent (and garbage / non-water arrears) must not be included.
 *
 * Verifies:
 *  1. Create via route: even when rent/garbage values are supplied, the
 *     totals are water-only (water bill + WATER arrears)
 *  2. The route never injects the tenant's rent_amount into the invoice
 *  3. Update recomputes water-only totals
 *  4. Rendered invoice HTML: title is WATER BILL INVOICE, no rent/garbage
 *     lines anywhere, water-only default notes, correct formatted totals
 *  5. PDF generation still works end-to-end
 *  6. Frontend: rent/garbage inputs gone, water arrears remains, v74 assets
 *
 * Fixtures: house 999993, tenant ZZWTR-*, removed afterwards. No sends.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const { buildWaterInvoiceHtml, generateAndStoreWaterInvoice } = require('../backend/services/documentStore');

const CODE = 'ZZWTR-01';
const HOUSE = '999993';

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
    const docs = await query(`SELECT file_path FROM documents WHERE tenant_code LIKE 'ZZWTR-%' AND file_path IS NOT NULL`);
    filePaths = docs.rows.map((r) => r.file_path).filter(Boolean);
  } catch (_) {}
  for (const sql of [
    `DELETE FROM water_invoices WHERE tenant_code LIKE 'ZZWTR-%'`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZWTR-%'`,
    `DELETE FROM documents WHERE tenant_code LIKE 'ZZWTR-%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZWTR-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZWTR-%'`,
    `DELETE FROM houses WHERE paybill_number = $1`,
  ]) {
    try { await query(sql, sql.includes('$1') ? [HOUSE] : undefined); } catch (_) {}
  }
  for (const p of filePaths) { try { fs.unlinkSync(p); } catch (_) {} }
}

async function makeToken() {
  const u = (await query(
    `SELECT id, username, role FROM users WHERE is_active IS DISTINCT FROM false
      ORDER BY (role = 'admin') DESC, id LIMIT 1`
  )).rows[0];
  return jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '20m' });
}

async function main() {
  await cleanup();
  await query(
    `INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status)
     VALUES ($1, 'ZZWTR House', 4, 'unknown')`, [HOUSE]
  );
  await store.createTenant({
    tenant_code: CODE, name: 'ZZWTR Tenant', phone_number: '+254700000601',
    property_name: 'ZZWTR House', house_id: HOUSE,
    rent_amount: 10000, deposit_amount: 5000, garbage_fee_amount: 2000,
    move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });

  const app = express();
  app.use(express.json());
  app.use('/api/water-invoices', require('../backend/routes/waterInvoices'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const PORT = srv.address().port;
  const token = await makeToken();
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/water-invoices${p}`, {
      method, headers: auth, body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };

  try {
    // ── 1. Even with rent/garbage supplied, totals are water-only ──────────
    let r = await call('POST', '/', {
      tenant_code: CODE, billing_month: '2026-10', payment_month: '2026-11',
      previous_reading: 100, current_reading: 110, rate_per_unit: 50,   // 10 units -> 500
      water_arrears: 400,
      rent_amount: 9999, garbage_fee: 888,                              // must be ignored in totals
      rent_arrears: 777, garbage_arrears: 666, other_arrears: 555,
      due_date: '2026-11-05',
    });
    check(r.status === 201 && r.json.water_invoice, `1. invoice created (HTTP ${r.status})`, r.json);
    let inv = r.json.water_invoice;
    check(Number(inv.total_amount) === 900,
      `1b. total = water 500 + water arrears 400 = 900 (got ${inv.total_amount})`, inv.total_amount);
    check(Number(inv.total_amount_payable) === 900 && Number(inv.total_previous_outstanding) === 400,
      `1c. payable 900 / previous outstanding = WATER arrears only (400, got ${inv.total_previous_outstanding})`);
    check(Number(inv.units_used) === 10 && Number(inv.rate_per_unit) === 50,
      '1d. readings and rate intact');

    // ── 2. Route never injects the tenant's rent ───────────────────────────
    r = await call('POST', '/', {
      tenant_code: CODE, billing_month: '2026-11',
      previous_reading: 110, current_reading: 125, rate_per_unit: 50,   // 15 units -> 750
      water_arrears: 0,
    });
    inv = r.json.water_invoice;
    check(r.status === 201, `2. second invoice created (HTTP ${r.status})`);
    check(Number(inv.rent_amount) === 0,
      `2b. tenant's 10,000 rent NOT injected (got rent_amount=${inv.rent_amount})`);
    check(Number(inv.total_amount) === 750,
      `2c. water-only total = 750 (got ${inv.total_amount})`);

    // ── 3. Update recomputes water-only ────────────────────────────────────
    const inv2Id = inv.id;
    r = await call('PUT', `/${inv2Id}`, { previous_reading: 110, current_reading: 130 }); // 20 units -> 1000
    inv = r.json.water_invoice;
    check(r.status === 200 && Number(inv.total_amount) === 1000,
      `3. update recomputes water-only (1000, got ${inv.total_amount})`, r.json);
    check(Number(inv.total_previous_outstanding) === 0 && Number(inv.total_amount_payable) === 1000,
      '3b. no non-water arrears after update');

    // ── 4. Rendered invoice: water only, correct totals ────────────────────
    const html = buildWaterInvoiceHtml(inv);
    check(html.includes('WATER BILL INVOICE'), '4. title = WATER BILL INVOICE');
    check(!html.includes('MONTHLY RENT & UTILITY INVOICE'), '4b. old rent+utility title gone');
    check(!html.includes('Monthly Rent') && !html.includes('>Rent<'), '4c. no rent line in the invoice');
    check(!html.includes('Garbage Fee'), '4d. no garbage line in the invoice');
    check(!html.includes('Rent Arrears') && !html.includes('Garbage Arrears') && !html.includes('Other Outstanding'),
      '4e. no non-water arrears rows');
    check(html.includes('Water Bill') && html.includes('Water Arrears'),
      '4f. water rows present');
    check(html.includes('This invoice covers water charges only.'),
      '4g. water-only default notes');
    check(!html.includes('also includes the applicable rent'),
      '4h. old rent-inclusive notes gone');
    check(html.includes('1,000.00'), `4i. total current charges formatted (1,000.00)`);
    check(html.includes('TOTAL AMOUNT PAYABLE'), '4j. payable total label present');
    check(html.includes('Water Consumption Details') && html.includes('Water Bill Calculation'),
      '4k. water calc section intact (design preserved)');

    // ── 5. PDF end-to-end ──────────────────────────────────────────────────
    const doc = await generateAndStoreWaterInvoice(inv.id, 'test');
    check(!!doc && fs.existsSync(doc.file_path), '5. PDF generated + registered');
    if (doc) {
      const head = Buffer.alloc(5);
      const fd = fs.openSync(doc.file_path, 'r');
      fs.readSync(fd, head, 0, 5, 0); fs.closeSync(fd);
      check(head.toString() === '%PDF-', '5b. valid PDF file');
    }

    // ── 6. Frontend ────────────────────────────────────────────────────────
    const idx = await (await fetch('http://127.0.0.1:3003/')).text();
    check(!idx.includes('id="wb-rent-amount"') && !idx.includes('id="wb-garbage-fee"')
      && !idx.includes('id="wb-rent-arrears"') && !idx.includes('id="wb-other-arrears"'),
      '6. rent/garbage inputs removed from the water form');
    check(idx.includes('id="wb-water-arrears"') && idx.includes('id="wb-rate"')
      && idx.includes('id="wb-curr-reading"'),
      '6b. water fields remain (arrears, rate, readings)');
    check(idx.includes('New Water Bill Invoice') && /app\.js\?v=\d+/.test(idx),
      '6c. water-only titles + versioned assets');
    const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js')).text();
    check(!appJs.includes('wb-rent-amount') && !appJs.includes('wb-garbage-arrears')
      && !appJs.includes('wb-other-arrears'),
      '6d. frontend no longer references removed fields');
    check(appJs.includes('water_arrears: waterArrears') && appJs.includes('Water Bill Invoice'),
      '6e. payload sends water arrears only, titles updated');
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
