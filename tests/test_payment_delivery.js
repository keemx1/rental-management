/**
 * Acceptance test — WhatsApp delivery status + PDF receipt automation.
 *
 * Verifies (client requirements):
 *  1. Approval returns a real delivery status; GET /payments/:id/delivery-status
 *     reflects the Baileys delivery-receipt callback: Sent -> Delivered
 *     automatically (the callback is exercised for real against message_logs)
 *  2. For EVERY payment type the tenant receives BOTH the confirmation text
 *     AND the PDF receipt automatically:
 *       normal rent · advanced/next-month (advance_rent) · overpayment ·
 *       partial payment · payment that clears arrears
 *     (the overpayment/advance branches previously skipped the PDF send)
 *  3. Existing workflow/allocation untouched: overpayment still reports
 *     'Pending Overpayment Resolution'
 *
 * Runs the real routers in-process with a stubbed WhatsApp sender — NO real
 * messages are ever sent.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const sm = require('../backend/whatsapp/session-manager');
const whatsapp = require('../backend/config/whatsapp');

const A = 'ZZDLV-A1';
const B = 'ZZDLV-B1';
const HOUSE = '999998';
const PHONE_A = '+254700000501';
const PHONE_B = '+254700000502';
const BASE = 'http://127.0.0.1:3003/api';

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra ? ` -> ${JSON.stringify(extra)}` : '')); }
}

// ── Stubs (in this process only; the real WhatsApp session is untouched) ────
const sentTexts = [];
let textSeq = 0;
sm.sendText = async (phone, body) => {
  textSeq += 1;
  sentTexts.push({ phone, body, id: 'TESTMSG-' + textSeq });
  return { success: true, id: 'TESTMSG-' + textSeq };
};
const sentDocs = [];
whatsapp.sendDocumentSmart = async (phone, filePath, caption) => {
  sentDocs.push({ phone, filePath, caption, existed: fs.existsSync(filePath), bytes: fs.existsSync(filePath) ? fs.readFileSync(filePath) : null });
  return { status: 'Sent', channel: 'stub', mediaDelivered: true, messageId: 'TESTDOC-' + sentDocs.length };
};

async function cleanup() {
  const stmts = [
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZDLV-%'`,
    `DELETE FROM penalties WHERE tenant_code LIKE 'ZZDLV-%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZDLV-%' OR message_body LIKE '%ZZDLV%'`,
    `DELETE FROM whatsapp_message_queue WHERE phone_number LIKE '+2547000005%'`,
    `DELETE FROM deposit_refunds WHERE tenant_code LIKE 'ZZDLV-%'`,
    `DELETE FROM exit_invoices WHERE tenant_code LIKE 'ZZDLV-%'`,
    `DELETE FROM tenancy_archive WHERE tenant_code LIKE 'ZZDLV-%'`,
    `DELETE FROM documents WHERE tenant_code LIKE 'ZZDLV-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZDLV-%'`,
    `DELETE FROM houses WHERE paybill_number = $1`,
    `DELETE FROM audit_log WHERE entity_id LIKE 'ZZDLV-%'`,
  ];
  for (const sql of stmts) {
    try { await query(sql, sql.includes('$1') ? [HOUSE] : undefined); } catch (_) {}
  }
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
     VALUES ($1, 'ZZ Delivery House', 5, 'unknown')`, [HOUSE]
  );
  const mk = (code, phone) => store.createTenant({
    tenant_code: code, name: `ZZDLV Tenant ${code.slice(-1)}`, phone_number: phone,
    property_name: 'ZZ Delivery House', house_id: HOUSE,
    rent_amount: 10000, deposit_amount: 5000, garbage_fee_amount: 0, water_charge_amount: 0,
    move_in_date: '2026-10-01', rent_due_date: '2026-11-05', status: 'Active',
  });
  await mk(A, PHONE_A);
  await mk(B, PHONE_B);

  // In-process server with the REAL payments router
  const app = express();
  app.use(express.json());
  app.use('/api/payments', require('../backend/routes/payments'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const PORT = srv.address().port;
  const token = await makeToken();
  const post = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/payments${p}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };
  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/payments${p}`, { headers: { Authorization: `Bearer ${token}` } });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };

  try {
    // ── 1. Normal rent payment: text + PDF + live delivery status ──────────
    const created = await post('', { tenant_id: A, amount: 4000, payment_type: 'rent', payment_mode: 'M-Pesa', mpesa_reference: 'ZZDLV-R1' });
    check(created.status === 201 && created.json.payment, '1. payment created', created.json);
    const payId = created.json.payment.id;

    const apr = await post(`/${payId}/approve`);
    check(apr.status === 200 && apr.json.success, `1b. approve OK (HTTP ${apr.status})`, apr.json);
    check(apr.json.whatsapp && apr.json.whatsapp.status === 'Sent',
      '1c. confirmation text sent (status Sent)', apr.json.whatsapp);
    check(apr.json.pdf && apr.json.pdf.status === 'Sent',
      '1d. PDF receipt sent automatically', apr.json.pdf);
    check(sentTexts.length >= 1 && sentTexts[0].body.includes('successfully received'),
      '1e. confirmation text content delivered to sender', sentTexts.length && sentTexts[0].body.slice(0, 60));
    check(sentDocs.length >= 1 && sentDocs[0].filePath.toLowerCase().endsWith('.pdf') && sentDocs[0].existed,
      '1f. receipt PDF file attached', sentDocs[0] && sentDocs[0].filePath);

    // Delivery status: initially Sent (from the send result logged with id)
    const st1 = await get(`/${payId}/delivery-status`);
    check(st1.status === 200 && st1.json.delivery && st1.json.delivery.status === 'Sent',
      '1g. delivery-status returns Sent with provider id', st1.json.delivery);

    // ── 2. WhatsApp confirms delivery -> status updates automatically ──────
    const provId = st1.json.delivery.whatsapp_message_id;
    await sm._applyReceipt({ id: provId, status: 'delivered' }).catch(() => {});
    const st2 = await get(`/${payId}/delivery-status`);
    check(st2.status === 200 && st2.json.delivery.status === 'Delivered',
      '2. delivery-status flips to Delivered after the callback', st2.json.delivery);
    const stRow = await query(`SELECT status FROM message_logs WHERE whatsapp_message_id = $1`, [provId]);
    check(stRow.rows[0] && stRow.rows[0].status === 'Delivered',
      '2b. message_logs row upgraded to Delivered by the callback', stRow.rows[0]);
    // Read upgrade also works
    await sm._applyReceipt({ id: provId, status: 'read' }).catch(() => {});
    const st3 = await get(`/${payId}/delivery-status`);
    check(st3.json.delivery.status === 'Read', '2c. delivery-status upgrades to Read', st3.json.delivery);

    // ── 3. Overpayment: text AND PDF (previously PDF was skipped) ─────────
    const ov = await post('', { tenant_id: A, amount: 60000, payment_type: 'rent', payment_mode: 'M-Pesa', mpesa_reference: 'ZZDLV-OV' });
    const ovApr = await post(`/${ov.json.payment.id}/approve`);
    check(ovApr.status === 200 && Number(ovApr.json.overpayment || 0) > 0,
      '3. overpayment branch reached', ovApr.json && ovApr.json.overpayment);
    check(ovApr.json.whatsapp && ovApr.json.whatsapp.overpayment_resolution === 'Pending Overpayment Resolution',
      '3b. workflow unchanged (overpayment still flagged for resolution)', ovApr.json.whatsapp);
    check(ovApr.json.whatsapp && ovApr.json.whatsapp.status === 'Sent',
      '3c. confirmation TEXT also sent on OVERPAYMENT (was missing)', ovApr.json.whatsapp);
    check(ovApr.json.pdf && ovApr.json.pdf.status === 'Sent',
      '3d. PDF receipt sent on OVERPAYMENT (was missing)', ovApr.json.pdf);
    check(!!ovApr.json.receipt, '3e. receipt document linked in response', ovApr.json.receipt);
    check(sentTexts.length >= 2, `3f. confirmation texts so far: ${sentTexts.length} (>= 2)`);

    // ── 4. Advanced/next-month payment: text AND PDF ───────────────────────
    const adv = await post('', { tenant_id: A, amount: 3000, payment_type: 'advance_rent', payment_mode: 'M-Pesa', mpesa_reference: 'ZZDLV-ADV' });
    const advApr = await post(`/${adv.json.payment.id}/approve`);
    check(advApr.status === 200 && advApr.json.success, '4. advance payment approved', advApr.json);
    check(advApr.json.pdf && advApr.json.pdf.status === 'Sent',
      '4b. PDF receipt sent on ADVANCED payment (was missing)', advApr.json.pdf);

    // ── 5. Partial payment + arrears-clearing payment: text AND PDF ────────
    await store.updateTenant(B, { arrears: 2000 });
    const part = await post('', { tenant_id: B, amount: 1500, payment_type: 'rent', payment_mode: 'M-Pesa', mpesa_reference: 'ZZDLV-PT' });
    const partApr = await post(`/${part.json.payment.id}/approve`);
    check(partApr.status === 200 && partApr.json.success, '5. partial payment approved', partApr.json);
    check(partApr.json.pdf && partApr.json.pdf.status === 'Sent',
      '5b. PDF receipt sent on PARTIAL payment', partApr.json.pdf);

    const arr = await post('', { tenant_id: B, amount: 2500, payment_type: 'rent', payment_mode: 'M-Pesa', mpesa_reference: 'ZZDLV-AR' });
    const arrApr = await post(`/${arr.json.payment.id}/approve`);
    check(arrApr.status === 200 && arrApr.json.success, '5c. arrears-clearing payment approved', arrApr.json);
    check(arrApr.json.pdf && arrApr.json.pdf.status === 'Sent',
      '5d. PDF receipt sent on ARREARS-CLEARING payment', arrApr.json.pdf);

    // Totals: every approval above produced a document send
    const docCount = new Set(sentDocs.map((d) => d.filePath)).size;
    check(docCount >= 5, `5e. every payment type produced a PDF send (${docCount} files)`, docCount);

    // ── 6. delivery-status edge cases ──────────────────────────────────────
    const missing = await get('/99999999/delivery-status');
    check(missing.status === 404, `6. unknown payment -> 404 (got ${missing.status})`);
    const pending = await post('', { tenant_id: B, amount: 100, payment_type: 'rent' });
    const pendSt = await get(`/${pending.json.payment.id}/delivery-status`);
    check(pendSt.status === 200 && pendSt.json.delivery.reason === 'not_approved',
      '6b. unapproved payment -> reason not_approved', pendSt.json.delivery);

    // ── 7. Frontend markers ────────────────────────────────────────────────
    const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js?v=68')).text();
    check(appJs.includes('trackPaymentDelivery') && appJs.includes('waMessagesRefreshCount'),
      '7. live delivery tracker + messages auto-refresh served');
    const apiJs = await (await fetch('http://127.0.0.1:3003/js/api.js')).text();
    check(apiJs.includes('paymentDeliveryStatus'), '7b. api.paymentDeliveryStatus served');

    console.log('\n(no real WhatsApp messages were sent — sender was stubbed)');
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
