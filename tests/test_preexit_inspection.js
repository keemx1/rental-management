/**
 * Acceptance test — Pre-Exit Inspection Inventory.
 *
 * Verifies (client requirements):
 *  1. Unit lookup auto-populates the correct tenant/tenancy (historical
 *     tenancy selectable; never silently assigned to a new occupant)
 *  2. Items: add / edit / delete with server-side total recalculation
 *     (qty × cost), batch Save, live grand totals
 *  3. Statuses Draft → Shared (via Share with Tenant, real PDF + WhatsApp
 *     stub) → Agreed; edits after sharing are flagged
 *  4. PDF: PRE-EXIT INSPECTION INVENTORY with the exact mandated disclaimer,
 *     no finalized refund/deduction figures, none of the forbidden phrases
 *  5. Transfer: agreed items move into the Exit Invoice EXACTLY ONCE —
 *     repeat/refresh retries transfer nothing new; partial transfers work;
 *     transferred items are locked (edit/delete refused by the server);
 *     unagreed items never transfer; finalized Exit Invoice refuses (409)
 *  6. Records survive re-letting: inventory sealed to the tenancy archive
 *  7. Existing Exit Invoice untouched apart from receiving lines through
 *     its own existing update process
 *
 * Fixtures: house 999996, tenant ZZPEI-*, fully removed afterwards.
 * WhatsApp sender stubbed — no real messages.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const whatsapp = require('../backend/config/whatsapp');

const CODE = 'ZZPEI-01';
const HOUSE = '999996';

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra ? ` -> ${JSON.stringify(extra)}` : '')); }
}

const DISCLAIMER = "This document records items identified during pre-exit inspection for review. It is not a final Exit Invoice, does not confirm final deposit deductions, and does not determine the tenant's deposit refund. Any agreed items may subsequently be transferred to the existing Exit Invoice for final processing.";

const sharedPdfs = [];
whatsapp.sendDocumentSmart = async (phone, filePath, caption) => {
  sharedPdfs.push({ phone, filePath, caption, exists: fs.existsSync(filePath) });
  return { status: 'Sent', channel: 'stub', mediaDelivered: true, messageId: 'PEI-STUB' };
};

async function cleanup() {
  // Collect PDF paths BEFORE deleting the document rows.
  let filePaths = [];
  try {
    const docs = await query(`SELECT file_path FROM documents WHERE tenant_code LIKE 'ZZPEI-%' AND file_path IS NOT NULL`);
    filePaths = docs.rows.map((r) => r.file_path).filter(Boolean);
  } catch (_) {}
  const stmts = [
    `DELETE FROM preexit_inspections WHERE tenant_code LIKE 'ZZPEI-%'`,
    `DELETE FROM deposit_refunds WHERE tenant_code LIKE 'ZZPEI-%'`,
    `DELETE FROM exit_invoices WHERE tenant_code LIKE 'ZZPEI-%'`,
    `DELETE FROM tenancy_archive WHERE tenant_code LIKE 'ZZPEI-%'`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZPEI-%'`,
    `DELETE FROM penalties WHERE tenant_code LIKE 'ZZPEI-%'`,
    `DELETE FROM documents WHERE tenant_code LIKE 'ZZPEI-%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZPEI-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZPEI-%'`,
    `DELETE FROM houses WHERE paybill_number = $1`,
    `DELETE FROM audit_log WHERE entity_id LIKE 'ZZPEI-%'`,
  ];
  for (const sql of stmts) {
    try { await query(sql, sql.includes('$1') ? [HOUSE] : undefined); } catch (_) {}
  }
  for (const p of filePaths) { try { fs.unlinkSync(p); } catch (_) {} }
}

function pick(it) {
  return {
    id: it.id, description: it.description, quantity: it.quantity,
    cost_per_qty: it.cost_per_qty, remarks: it.remarks || '', agreed: !!it.agreed,
  };
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
     VALUES ($1, 'ZZPEI House', 4, 'unknown')`, [HOUSE]
  );
  await store.createTenant({
    tenant_code: CODE, name: 'ZZPEI Tenant Alpha', phone_number: '+254700000701',
    property_name: 'ZZPEI House', house_id: HOUSE,
    rent_amount: 10000, deposit_amount: 5000,
    move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });

  const app = express();
  app.use(express.json());
  app.use('/api/preexit', require('../backend/routes/preexitInspection'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const PORT = srv.address().port;
  const token = await makeToken();
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/preexit${p}`, {
      method, headers: auth, body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json, headers: res.headers };
  };

  try {
    // ── 1. Lookup ────────────────────────────────────────────────────────────
    let r = await call('GET', `/lookup?unit=${encodeURIComponent(CODE)}`);
    check(r.status === 200 && r.json.live_tenant && r.json.live_tenant.name === 'ZZPEI Tenant Alpha',
      '1. lookup loads the correct tenant', r.json.live_tenant);
    check(r.json.live_tenant.occupied === true && (r.json.inventories || []).length === 0,
      '1b. occupied unit, no inventories yet');
    r = await call('GET', '/lookup?unit=NOPE-999');
    check(r.status === 200 && !r.json.live_tenant && (r.json.archived_tenancies || []).length === 0,
      '1c. unknown unit -> empty lookup (no crash)');

    // ── 2. Create + items with server-side math (spec example) ──────────────
    r = await call('POST', '/', { unit: CODE, inspection_date: '2026-10-20' });
    check(r.status === 201 && r.json.inspection, `2. inventory created (HTTP ${r.status})`, r.json);
    const invId = r.json.inspection.id;
    check(r.json.inspection.status === 'Draft' && r.json.inspection.tenant_name === 'ZZPEI Tenant Alpha',
      '2b. Draft status + correct tenant snapshot');
    check(r.json.inspection.tenancy_id == null, '2c. bound to the CURRENT tenancy (tenancy_id null)');

    r = await call('PUT', `/${invId}`, {
      inspection_date: '2026-10-20',
      items: [
        { description: 'Broken door', quantity: 1, cost_per_qty: 8000, remarks: 'main entrance', total: 999999 },
        { description: 'Damaged window glass', quantity: 2, cost_per_qty: 2500, remarks: '' },
        { description: 'Missing bulb', quantity: 3, cost_per_qty: 500, remarks: 'bedroom' },
      ],
    });
    check(r.status === 200, `3. items saved (HTTP ${r.status})`, r.json);
    const items1 = r.json.inspection.items;
    check(items1.length === 3, '3b. three items stored');
    check(Number(items1[0].total) === 8000, `3c. server recalculates total (bogus 999999 -> ${items1[0].total})`);
    check(Number(items1[1].total) === 5000 && Number(items1[2].total) === 1500, '3d. qty × cost totals');
    check(Number(r.json.inspection.total_estimated) === 14500,
      `3e. overall estimated = 14,500 (spec example) got ${r.json.inspection.total_estimated}`);

    // Edit + delete via batch save (recalc)
    r = await call('PUT', `/${invId}`, {
      inspection_date: '2026-10-20',
      items: items1.map((it) => it.id === items1[1].id
        ? { ...pick(it), quantity: 4 }              // window 2 -> 4 => 10,000
        : pick(it)),
    });
    check(Number(r.json.inspection.total_estimated) === 19500,
      `4. edit recalculates (19,500) got ${r.json.inspection.total_estimated}`);

    // ── 3. Share (Draft -> Shared) with real PDF + WhatsApp stub ────────────
    r = await call('PUT', `/${invId}/status`, { status: 'Shared' });
    check(r.status === 400, `4b. Shared cannot be set manually (HTTP ${r.status})`);

    r = await call('POST', `/${invId}/share`);
    const sharedInsp = (r.json || {}).inspection || {};
    check(r.status === 200 && r.json.inspection, `5. share OK (HTTP ${r.status})`, r.json);
    check(sharedInsp.status === 'Shared' && sharedInsp.shared_at,
      '5b. status Shared + shared_at stamped');
    check(!!sharedInsp.document_id, '5c. document registered (Documents hub)');
    check(sharedPdfs.length === 1 && sharedPdfs[0].exists && sharedPdfs[0].filePath.toLowerCase().endsWith('.pdf'),
      '5d. PDF generated and sent via WhatsApp', sharedPdfs[0] && sharedPdfs[0].filePath);
    const pdfBytes = fs.readFileSync(sharedPdfs[0].filePath);
    check(pdfBytes.slice(0, 5).toString() === '%PDF-', '5e. valid PDF file');
    check(sharedPdfs[0].caption.includes('PRE-EXIT INSPECTION INVENTORY'), '5f. PDF caption carries the title', sharedPdfs[0].caption);
    check(sharedPdfs[0].phone === '+254700000701', '5g. sent to the correct tenant phone');

    // PDF download endpoint
    const pdfRes = await fetch(`http://127.0.0.1:${PORT}/api/preexit/${invId}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    check(pdfRes.status === 200 && pdfBuf.slice(0, 5).toString() === '%PDF-',
      `5h. PDF download endpoint (HTTP ${pdfRes.status})`);

    // Template content rules
    const tpl = fs.readFileSync(path.join(__dirname, '../backend/templates/preexit_inspection.html'), 'utf8');
    check(tpl.includes('PRE-EXIT INSPECTION INVENTORY'), '5i. template title present');
    check(tpl.includes(DISCLAIMER), '5j. EXACT mandated disclaimer present');
    check(!tpl.includes('discussion between management and the tenant'),
      '5k. forbidden phrase absent');
    check(!tpl.includes('Final Settlement') && !tpl.includes('Net Refund') && !tpl.includes('Refundable'),
      '5l. no finalized refund/deduction figures on the inspection PDF');

    // ── 4. Edit after share is flagged ──────────────────────────────────────
    const fresh = (await call('GET', `/${invId}`)).json.inspection;
    r = await call('PUT', `/${invId}`, {
      inspection_date: '2026-10-21',
      items: fresh.items.map((it) => pick(it)),
    });
    check(r.json.inspection.edited_after_share === true,
      '6. changes after sharing are flagged');
    check(r.json.inspection.shared_at, '6b. shared_at retained (latest version saved)');
    check(r.json.inspection.status === 'Shared', '6c. status remains Shared');

    // ── 5. Agreed + transfer exactly once ───────────────────────────────────
    let cur = (await call('GET', `/${invId}`)).json.inspection;
    r = await call('PUT', `/${invId}`, {
      inspection_date: cur.inspection_date,
      items: cur.items.map((it) => ({ ...pick(it), agreed: true })),
    });
    cur = r.json.inspection;
    check(cur.items.every((it) => it.agreed), '7. all items marked agreed');

    r = await call('PUT', `/${invId}/status`, { status: 'Agreed' });
    check(r.json.inspection.status === 'Agreed', '7b. status Agreed');

    r = await call('POST', `/${invId}/transfer`);
    check(r.status === 200 && r.json.transferred.length === 3,
      `8. transfer of 3 agreed items (${r.json.transferred && r.json.transferred.length}/3)`, r.json);
    const exitId = r.json.invoice_id;
    check(!!r.json.exit_number, '8b. draft Exit Invoice created/used', r.json.exit_number);

    const linesOf = async () => {
      const inv = await store.getExitInvoice(exitId);
      return inv.lines || [];
    };
    let lines = await linesOf();
    check(lines.length === 3, `8c. Exit Invoice has exactly 3 lines (${lines.length})`);
    check(lines.every((l) => l.source === 'preexit_inspection' && l.pei_item_id),
      '8d. lines carry inventory links (pei_item_id)');

    // Repeat click / refresh / retry
    r = await call('POST', `/${invId}/transfer`);
    check(r.status === 200 && (r.json.transferred || []).length === 0,
      `9. repeat transfer moves nothing (${(r.json.transferred || []).length})`, r.json.message);
    r = await call('POST', `/${invId}/transfer`, { item_ids: cur.items.map((i) => i.id) });
    check((r.json.transferred || []).length === 0, '9b. explicit id retry also moves nothing');
    lines = await linesOf();
    check(lines.length === 3, `9c. Exit Invoice STILL has exactly 3 lines (${lines.length}) — no duplicates`);

    // Partial: add a 4th agreed item later + transfer only it
    r = await call('PUT', `/${invId}`, {
      inspection_date: cur.inspection_date,
      items: [
        ...cur.items.map((it) => pick(it)),
        { description: 'Leaking tap', quantity: 1, cost_per_qty: 1200, remarks: 'kitchen', agreed: true },
      ],
    });
    check(r.status === 200 && r.json.inspection.items.length === 4, '10. fourth agreed item added');
    check(r.json.preserved_transferred.length === 3,
      `10b. 3 transferred items preserved untouched (${r.json.preserved_transferred.length})`);

    r = await call('POST', `/${invId}/transfer`);
    check(r.json.transferred.length === 1, `10c. retry transfers ONLY the new item (${r.json.transferred.length})`, r.json);
    lines = await linesOf();
    check(lines.length === 4, `10d. Exit Invoice now has 4 lines (${lines.length})`);

    // Locked: deleting/editing transferred items through save is refused
    cur = (await call('GET', `/${invId}`)).json.inspection;
    r = await call('PUT', `/${invId}`, {
      inspection_date: cur.inspection_date,
      items: cur.items.filter((it) => it.transfer_status !== 'Transferred').map((it) => pick(it)), // drop all transferred
    });
    const afterAttempt = (await call('GET', `/${invId}`)).json.inspection;
    check(afterAttempt.items.filter((it) => it.transfer_status === 'Transferred').length === 4,
      '11. transferred items cannot be deleted via save');
    r = await call('PUT', `/${invId}`, {
      inspection_date: cur.inspection_date,
      items: cur.items.map((it) => it.transfer_status === 'Transferred'
        ? { ...pick(it), description: 'HACKED' } : pick(it)),
    });
    const afterEdit = (await call('GET', `/${invId}`)).json.inspection;
    check(!afterEdit.items.some((it) => it.description === 'HACKED' && it.transfer_status === 'Transferred'),
      '11b. transferred items cannot be edited via save');

    // Unagreed item never transfers
    r = await call('PUT', `/${invId}`, {
      inspection_date: afterEdit.inspection_date,
      items: [
        ...afterEdit.items.map((it) => pick(it)),
        { description: 'Cosmetic scratch', quantity: 1, cost_per_qty: 100, remarks: '', agreed: false },
      ],
    });
    r = await call('POST', `/${invId}/transfer`);
    check((r.json.transferred || []).length === 0 && r.json.message === 'No new items to transfer',
      '12. unagreed item is NOT eligible for transfer', r.json);
    lines = await linesOf();
    check(lines.length === 4, `12b. lines unchanged (${lines.length})`);

    // ── 6. Finalized Exit Invoice refuses transfers ─────────────────────────
    // Add one more AGREED item so there is something eligible to transfer,
    // then finalize — the transfer must be refused with 409 (no bypass).
    cur = (await call('GET', `/${invId}`)).json.inspection;
    r = await call('PUT', `/${invId}`, {
      inspection_date: cur.inspection_date,
      items: [
        ...cur.items.map((it) => pick(it)),
        { description: 'Late repair', quantity: 1, cost_per_qty: 900, remarks: 'found late', agreed: true },
      ],
    });
    check(r.status === 200 && r.json.inspection.items.length === 6, '13. extra agreed item added pre-finalize');
    const fin = await store.finalizeExitInvoice(exitId, { move_out_date: '2026-10-25' }, 'test');
    check(fin && fin.status === 'Finalized', '13. exit invoice finalized (existing process)');
    r = await call('POST', `/${invId}/transfer`);
    check(r.status === 409 && r.json.code === 'EXIT_INVOICE_FINALIZED',
      `13b. transfer to FINALIZED invoice refused (HTTP ${r.status})`, r.json);
    lines = await linesOf();
    check(lines.length === 4, `13c. finalized invoice untouched (${lines.length} lines)`);

    // ── 7. Tenancy binding survives re-letting ──────────────────────────────
    await store.vacateTenancy(CODE, { move_out_date: '2026-10-25', reason: 'test exit', exit_invoice_id: exitId, archived_by: 'test' });
    const sealed = (await call('GET', `/${invId}`)).json.inspection;
    check(sealed.tenancy_id != null, '14. inventory sealed to the tenancy archive on vacate', sealed.tenancy_id);
    const arch = await store.getTenancyArchive(sealed.tenancy_id);
    check(arch && Array.isArray(arch.preexit_inspections) && arch.preexit_inspections.length === 1,
      '14b. tenancy archive exposes the inventory (with items)', arch && arch.preexit_inspections.length);

    // Re-let: a NEW inventory for the new occupant is never auto-bound to the old tenancy
    await store.resetTenancyFinancials(CODE);
    await store.updateTenant(CODE, {
      name: 'ZZPEI Tenant Beta', phone_number: '+254700000702', status: 'Active',
      rent_amount: 9500, deposit_amount: 4500, move_in_date: '2026-11-01',
      rent_due_date: '2026-12-05', deposit_paid: 0, arrears: 0, rent_paid_this_month: 0,
    });
    r = await call('POST', '/', { unit: CODE, inspection_date: '2026-11-20' });
    check(r.status === 201 && r.json.inspection.tenancy_id == null
      && r.json.inspection.tenant_name === 'ZZPEI Tenant Beta',
      '15. new occupant gets their OWN inventory (not attached to the old tenancy)', r.json.inspection && {
        tenancy_id: r.json.inspection.tenancy_id, name: r.json.inspection.tenant_name,
      });
    const oldInv = (await call('GET', `/${invId}`)).json.inspection;
    check(oldInv.tenancy_id === sealed.tenancy_id && oldInv.tenant_name === 'ZZPEI Tenant Alpha',
      '15b. previous tenancy inventory unchanged (name + binding intact)');

    // Historical tenancy explicitly selectable (occupied unit allows archive choice)
    r = await call('POST', '/', { unit: CODE, inspection_date: '2026-10-01', tenancy_id: sealed.tenancy_id });
    check(r.status === 201 && r.json.inspection.tenancy_id === sealed.tenancy_id,
      '16. historical tenancy can be chosen explicitly', r.json.inspection && r.json.inspection.tenancy_id);

    // ── 8. Frontend markers ──────────────────────────────────────────────────
    const idx = await (await fetch('http://127.0.0.1:3003/')).text();
    check(idx.includes('data-nav="preexit-inspection"') && idx.includes('id="pei-items"'),
      '17. nav entry + inventory editor served');
    const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js?v=71')).text();
    check(appJs.includes('peiTransfer') && appJs.includes('preexitResetView'),
      '17b. editor logic served');

    console.log('\n(no real WhatsApp messages were sent — sender stubbed)');
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
