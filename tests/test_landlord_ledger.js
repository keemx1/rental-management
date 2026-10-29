/**
 * Acceptance test — Landlord Ledger Dashboard: commission + rent remittance.
 *
 * Verifies (client spec):
 *  1. Property dashboard summary uses ACTUAL rent collected + the EXISTING
 *     commission rate/calculation (no manual re-entry)
 *  2. Spec example reproduces exactly: rent 100,000 − commission 5,000 −
 *     other approved deductions 2,000 = net payable 93,000; pay 80,000 →
 *     outstanding 13,000 (never marked fully paid on a partial payment)
 *  3. Carry-forward: next month's net stacks onto the previous outstanding
 *  4. Two DISTINCT balances: commission (GEHPM) and remittance (landlord)
 *     never offset each other; payments for one property never touch another
 *  5. Agreed landlord payment date per property (different days) + next due
 *  6. Partial + multiple remittance payments against the same month
 *  7. Commission invoice view/download/share (WhatsApp share via the
 *     existing documents pipeline, stubbed) + both statements as PDFs
 *  8. Guards: mismatched-landlord remittance refused, day validation
 *  9. Overview exposes per-property remittance outstanding + combined total
 * 10. Frontend dashboard surface served
 *
 * Fixtures: houses 999987/999986, landlord ZZLD-*, removed afterwards.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const commission = require('../backend/services/landlordCommission');
const whatsapp = require('../backend/config/whatsapp');

const HOUSE_A = '999987';
const HOUSE_B = '999986';

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ` -> ${JSON.stringify(extra)}` : '')); }
}

const sharedDocs = [];
whatsapp.sendDocumentSmart = async (phone, filePath, caption) => {
  sharedDocs.push({ phone, filePath, caption, exists: fs.existsSync(filePath) });
  return { status: 'Sent', messageId: 'LD-SHARE-1' };
};

async function cleanup() {
  let filePaths = [];
  try {
    const docs = await query(`SELECT file_path FROM documents WHERE house_paybill_number IN ($1,$2) AND file_path IS NOT NULL`, [HOUSE_A, HOUSE_B]);
    filePaths = docs.rows.map((r) => r.file_path).filter(Boolean);
  } catch (_) {}
  for (const sql of [
    `DELETE FROM landlord_remittance_payments WHERE house_paybill_number IN ($1,$2)`,
    `DELETE FROM commission_payments WHERE house_paybill_number IN ($1,$2)`,
    `DELETE FROM commission_invoices WHERE house_paybill_number IN ($1,$2)`,
    `DELETE FROM documents WHERE house_paybill_number IN ($1,$2)`,
    `DELETE FROM maintenance_charges WHERE tenant_code LIKE 'ZZLD-%' OR wo_number LIKE 'ZZLD-%'`,
    `DELETE FROM work_orders WHERE wo_number LIKE 'ZZLD-%'`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZLD-%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZLD-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZLD-%'`,
    `DELETE FROM houses WHERE paybill_number IN ($1,$2)`,
    `DELETE FROM landlords WHERE name LIKE 'ZZLD Landlord%'`,
  ]) {
    try { await query(sql, sql.includes('$1') ? [HOUSE_A, HOUSE_B] : []); } catch (e) { console.error('[cleanup]', e.message); }
  }
  for (const p of filePaths) { try { fs.unlinkSync(p); } catch (_) {} }
}

async function makeToken() {
  const u = (await query(
    `SELECT id, username, role FROM users WHERE is_active IS DISTINCT FROM false ORDER BY (role = 'admin') DESC, id LIMIT 1`
  )).rows[0];
  return jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '20m' });
}

async function main() {
  await cleanup();
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status) VALUES ($1, 'ZZLD House A', 4, 'unknown')`, [HOUSE_A]);
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status) VALUES ($1, 'ZZLD House B', 4, 'unknown')`, [HOUSE_B]);
  await store.createTenant({
    tenant_code: 'ZZLD-01', name: 'ZZLD Tenant', phone_number: '+254700001301',
    property_name: 'ZZLD House A', house_id: HOUSE_A, rent_amount: 100000, deposit_amount: 5000,
    move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  await query(
    `INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode, tenancy_id)
     VALUES ('ZZLD-01', 100000, '2026-10-05', 'Approved', 'rent', 'R-LD-OCT', 'MPLDOCT1', '2026-10', 'M-Pesa', NULL)`
  );
  await query(
    `INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode, tenancy_id)
     VALUES ('ZZLD-01', 50000, '2026-11-05', 'Approved', 'rent', 'R-LD-NOV', 'MPLDNOV1', '2026-11', 'M-Pesa', NULL)`
  );
  await store.createTenant({
    tenant_code: 'ZZLD-02', name: 'ZZLD Tenant B', phone_number: '+254700001302',
    property_name: 'ZZLD House B', house_id: HOUSE_B, rent_amount: 60000, deposit_amount: 5000,
    move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  await query(
    `INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode, tenancy_id)
     VALUES ('ZZLD-02', 60000, '2026-10-06', 'Approved', 'rent', 'R-LD-B-OCT', 'MPLDBOCT1', '2026-10', 'M-Pesa', NULL)`
  );
  // "Other approved deductions": an existing landlord-responsibility charge
  // (maintenance_charges requires a work order).
  let deductionsExpected = 2000;
  try {
    const wo = (await query(
      `INSERT INTO work_orders (wo_number, property_name, house_paybill_number, status, date_requested)
       VALUES ('ZZLD-WO-1', 'ZZLD House A', $1, 'Completed', '2026-10-08') RETURNING id`, [HOUSE_A]
    )).rows[0];
    await query(
      `INSERT INTO maintenance_charges (work_order_id, issue_no, wo_number, tenant_code, tenant_name, problem, amount_charged, charge_month, responsible_party, recovery_status)
       VALUES ($1, 1, 'ZZLD-WO-1', 'ZZLD-01', 'ZZLD Tenant', 'Landlord-responsibility repair', 2000, '2026-10', 'landlord', 'Pending')`,
      [wo.id]
    );
  } catch (e) {
    console.warn('[fixture] maintenance insert failed, deductions = 0:', e.message);
    deductionsExpected = 0;
  }

  const ll = (await query(`INSERT INTO landlords (name, phone) VALUES ('ZZLD Landlord', '+254700001300') RETURNING id`)).rows[0];
  await query(`UPDATE houses SET landlord_id = $1 WHERE paybill_number = $2`, [ll.id, HOUSE_A]);
  await query(`UPDATE houses SET landlord_id = $1 WHERE paybill_number = $2`, [ll.id, HOUSE_B]);
  await store.setCommissionRate(HOUSE_A, 5, 'test');
  await store.setCommissionRate(HOUSE_B, 5, 'test');

  const app = express();
  app.use(express.json());
  app.use('/api/landlords', require('../backend/routes/landlords'));
  app.use('/api/documents', require('../backend/routes/documents'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const PORT = srv.address().port;
  const token = await makeToken();
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (method, p, body, base = '/api/landlords') => {
    const res = await fetch(`http://127.0.0.1:${PORT}${base}${p}`, {
      method, headers: auth, body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };

  try {
    // ── 1. Dashboard summary (spec example, October) ───────────────────────
    await call('PUT', `/${ll.id}/properties/${HOUSE_A}/remittance-day`, { day: 10 });
    let r = await call('GET', `/${ll.id}/properties/${HOUSE_A}/dashboard?month=2026-10`);
    check(r.status === 200 && r.json.summary, `1. property dashboard loads (HTTP ${r.status})`, r.json);
    let s = r.json.summary;
    const netExpected = 100000 - 5000 - deductionsExpected; // 93,000 with the2,000 deduction
    check(s.rent_collected === 100000, `1b. actual rent collected = 100,000 (got ${s.rent_collected})`);
    check(s.commission_earned === 5000, `1c. commission at EXISTING 5% = 5,000 (got ${s.commission_earned})`);
    check(s.other_deductions === deductionsExpected, `1d. other approved deductions = ${deductionsExpected} (got ${s.other_deductions})`);
    check(s.net_payable_month === netExpected,
      `1e. net payable = ${netExpected} (spec: 93,000) (got ${s.net_payable_month})`);
    check(s.remittance_day === 10 && s.next_agreed_date === '2026-11-10',
      `1f. agreed day 10 + next due 2026-11-10 (today Oct 26) got ${s.next_agreed_date}`);

    // ── 2. Commission side (existing calc) ─────────────────────────────────
    r = await call('POST', `/${ll.id}/properties/${HOUSE_A}/commission-invoice`, { billing_month: '2026-10' });
    check(r.status === 200 && Number(r.json.invoice.commission_amount) === 5000,
      `2. commission invoice from existing rate (5,000)`, r.json.invoice && r.json.invoice.commission_amount);
    const invoiceDocId = r.json.invoice.document_id;
    r = await call('GET', `/${ll.id}/properties/${HOUSE_A}/dashboard?month=2026-10`);
    s = r.json.summary;
    check(s.commission_invoiced === 5000 && s.commission_outstanding === 5000,
      `2b. invoiced 5,000 / outstanding 5,000 (got ${s.commission_invoiced}/${s.commission_outstanding})`);

    // ── 3. Partial remittance: 80,000 of 93,000 → October row shows 13,000 ─
    r = await call('POST', `/${ll.id}/properties/${HOUSE_A}/remittance-payments`, {
      billing_month: '2026-10', payment_date: '2026-10-10', amount: 80000, method: 'M-Pesa', reference: 'MPLDREM1',
    });
      check(r.status === 200, `3. payment of 80,000 accepted (HTTP ${r.status})`);
      await call('POST', `/remittance-payments/${r.json.payment.id}/verify`); // v77: only Verified reduces balances
      r = await call('GET', `/${ll.id}/properties/${HOUSE_A}/dashboard?month=2026-10`);
      let octRow = r.json.remittance_month_rows.find((x) => x.billing_month === '2026-10');
    // Spec example: 93,000 − 80,000 = 13,000 (October's own month balance)
    check(octRow && octRow.outstanding_after === 13000,
      `3b. October row: 93,000 − 80,000 = 13,000 (got ${octRow && octRow.outstanding_after})`);
    // Cumulative outstanding also carries November's net (correct carry-forward)
    check(r.json.summary.remittance_outstanding === 60500,
      `3c. cumulative outstanding includes Nov net (got ${r.json.summary.remittance_outstanding})`);
    // Second partial payment against the SAME month
    r = await call('POST', `/${ll.id}/properties/${HOUSE_A}/remittance-payments`, {
        billing_month: '2026-10', payment_date: '2026-10-20', amount: 5000, method: 'Bank', reference: 'BNKLDREM1',
      });
      await call('POST', `/remittance-payments/${r.json.payment.id}/verify`);
      r = await call('GET', `/${ll.id}/properties/${HOUSE_A}/dashboard?month=2026-10`);
    octRow = r.json.remittance_month_rows.find((x) => x.billing_month === '2026-10');
    check(octRow && octRow.outstanding_after === 8000,
      `3d. second partial payment → October row 8,000 (got ${octRow && octRow.outstanding_after})`);

    // ── 4. Balances stay DISTINCT (no offsetting) + isolation ──────────────
    s = r.json.summary;
    check(s.commission_outstanding === 5000 && s.remittance_outstanding === 55500,
      `4. two balances: commission 5,000 + remittance 55,500 cumulative (never offset)`,
      { c: s.commission_outstanding, r: s.remittance_outstanding });
    r = await call('POST', `/${ll.id}/properties/${HOUSE_B}/remittance-payments`, {
        billing_month: '2026-10', payment_date: '2026-10-12', amount: 1000, method: 'M-Pesa', reference: 'MPLDBREM1',
      });
      check(r.status === 200, `4b. Property B payment accepted`);
      await call('POST', `/remittance-payments/${r.json.payment.id}/verify`);
    r = await call('GET', `/${ll.id}/properties/${HOUSE_A}/dashboard?month=2026-10`);
    check(r.json.summary.remittance_outstanding === 55500,
      `4c. A untouched by B's payment (still 55,500, got ${r.json.summary.remittance_outstanding})`);

    // ── 5. Carry-forward into November ─────────────────────────────────────
    r = await call('GET', `/${ll.id}/properties/${HOUSE_A}/dashboard?month=2026-11`);
    const rows = r.json.remittance_month_rows;
    const oct = rows.find((x) => x.billing_month === '2026-10');
    const nov = rows.find((x) => x.billing_month === '2026-11');
    check(oct && oct.outstanding_after === 8000, `5. Oct closes at 8,000 (got ${oct && oct.outstanding_after})`);
    check(nov && nov.rent_collected === 50000 && nov.net_payable === 47500,
      `5b. Nov net = 50,000 − 2,500 = 47,500 (got ${nov && nov.net_payable})`);
    check(nov && nov.outstanding_after === 55500,
      `5c. Nov carries 8,000 + 47,500 = 55,500 (got ${nov && nov.outstanding_after})`);

    // ── 6. Statements (both sides) + invoice share ─────────────────────────
    r = await call('POST', `/${ll.id}/properties/${HOUSE_A}/remittance-statement`);
    check(r.status === 200 && r.json.document, `6. remittance statement PDF (HTTP ${r.status})`);
    const remDoc = (await query(`SELECT file_path FROM documents WHERE id = $1`, [r.json.document.id])).rows[0];
    check(!!remDoc && fs.existsSync(remDoc.file_path), '6b. remittance PDF file exists');
    if (remDoc) {
      const head = Buffer.alloc(5);
      const fd = fs.openSync(remDoc.file_path, 'r'); fs.readSync(fd, head, 0, 5, 0); fs.closeSync(fd);
      check(head.toString() === '%PDF-', '6c. valid remittance PDF');
    }
    r = await call('POST', `/${ll.id}/properties/${HOUSE_A}/statement`);
    check(r.status === 200 && r.json.document, '6d. commission statement still works (regression)');

    // Share the commission invoice via the EXISTING documents pipeline
    check(!!invoiceDocId, '6e. invoice has a document id for sharing');
    if (invoiceDocId) {
      r = await call('POST', `/${invoiceDocId}/share-whatsapp`, { phone_number: '+254700001300' }, '/api/documents');
      check(r.status === 200 && r.json.whatsapp && r.json.whatsapp.status === 'Sent',
        `6f. share invoice via WhatsApp pipeline (HTTP ${r.status})`, r.json);
      check(sharedDocs.length === 1 && sharedDocs[0].exists && sharedDocs[0].phone === '+254700001300',
        '6g. shared PDF exists, sent to the LANDLORD phone', sharedDocs[0]);
    }

    // ── 7. Guards ──────────────────────────────────────────────────────────
    r = await call('POST', `/${ll.id}/properties/${HOUSE_A}/remittance-payments`, {
      billing_month: '2026-11', payment_date: '2026-11-05', amount: 100, landlord_id: 999999,
    });
    check(r.status === 409 && r.json.code === 'LANDLORD_MISMATCH',
      `7. mismatched landlord refused (HTTP ${r.status})`);
    r = await call('PUT', `/${ll.id}/properties/${HOUSE_A}/remittance-day`, { day: 99 });
    check(r.status === 400, `7b. invalid agreed day rejected (HTTP ${r.status})`);

    // ── 8. Overview: per-property remittance + combined ────────────────────
    r = await call('GET', `/${ll.id}?month=2026-11`);
    check(r.status === 200 && r.json.properties.length === 2, '8. overview lists both properties');
    const pA = r.json.properties.find((p) => p.house_paybill_number === HOUSE_A);
    const pB = r.json.properties.find((p) => p.house_paybill_number === HOUSE_B);
    check(pA && pA.remittance_outstanding === 55500,
      `8b. A remittance outstanding 55,500 in overview (got ${pA && pA.remittance_outstanding})`);
    check(pB && pB.remittance_outstanding > 0 && pB.remittance_outstanding !== pA.remittance_outstanding,
      '8c. B has its OWN remittance balance (never mixed)', pB && pB.remittance_outstanding);
    check(r.json.total_remittance_outstanding === round2(pA.remittance_outstanding + pB.remittance_outstanding),
      `8d. combined convenience total (got ${r.json.total_remittance_outstanding})`);

    // ── 9. Frontend surface ────────────────────────────────────────────────
    const idx = await (await fetch('http://127.0.0.1:3003/')).text();
    check(idx.includes('id="ll-ledger-modal"') && idx.includes('ll-dash-summary')
      && idx.includes('id="ll-remittance-modal"') && idx.includes('Record Landlord Remittance')
      && /app\.js\?v=\d+/.test(idx),
      '9. dashboard modal + remittance surface served');
    const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js')).text();
    check(appJs.includes('openRemittanceModal') && appJs.includes('saveRemittancePayment')
      && appJs.includes('dashViewInvoice') && appJs.includes('ll-rem-tbody'),
      '9b. dashboard logic served');

    console.log('\n(no real messages were sent — sender stubbed)');
  } finally {
    srv.close();
  }
}

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

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
