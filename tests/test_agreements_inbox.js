/**
 * Acceptance test — Agreements Inbox (drop-folder, store-only, per-house).
 *
 * Folder contract:
 *   agreements_inbox/<House Name or Paybill>/<unit or tenant code>.pdf
 *   _processed/ (kept)   _unmatched/ (auto-sorted)
 *
 *  1. Per-house folders resolved by house NAME and by PAYBILL (either works)
 *  2. Files matched by unit label OR tenant code, scoped to that house only
 *     (a unit from another house is unmatched — no cross-house confusion)
 *  3. Matched files stored in the tenant's Agreements section
 *     (tenancy_agreements row + uploader called with the tenant + PDF bytes)
 *  4. NO automatic sending — WhatsApp/session manager never invoked,
 *     zero message_logs from this feature
 *  5. Vacant units and unknown folders → _unmatched with an audited reason
 *  6. Mid-copy protection: fresh files skipped this run, processed next run
 *  7. Duplicates skipped (same filename already stored) — no second copy
 *  8. Files MOVED (never re-processed); collision-safe names in _processed
 *  9. Status + manual process endpoints (authenticated)
 *
 * Fixtures: houses 999979/999978, tenants ZZAG-* (removed afterwards).
 * Supabase uploader stubbed — no network.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const agreements = require('../backend/services/tenantAgreements');
const whatsapp = require('../backend/config/whatsapp');
const sessionManager = require('../backend/whatsapp/session-manager');

const ROOT_DIR = path.join(__dirname, '..', 'agreements_inbox_test');
process.env.AGREEMENTS_INBOX_DIR = ROOT_DIR;
const inbox = require('../backend/services/agreementsInbox');

const HOUSE_A = '999979';
const HOUSE_A_NAME = 'ZZAG Test House';
const HOUSE_B = '999978';

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ` -> ${JSON.stringify(extra)}` : '')); }
}

// ── Stubs: no Supabase, NO sends ever ───────────────────────────────────────
const uploads = [];
agreements.uploadAgreement = async ({ tenantCode, buffer, originalName }) => {
  uploads.push({ tenantCode, originalName, head: buffer.slice(0, 5).toString('latin1'), size: buffer.length });
  return { path: `${tenantCode}/inbox-${uploads.length}.pdf`, mimetype: 'application/pdf', size: buffer.length };
};
const forbidden = [];
whatsapp.sendDocumentSmart = async () => { forbidden.push('sendDocumentSmart'); return { status: 'Sent' }; };
sessionManager.sendText = async () => { forbidden.push('sendText'); return { id: 'x' }; };

function writePdf(rel, { age = 'old' } = {}) {
  const full = path.join(ROOT_DIR, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '%PDF-1.4 fake agreement bytes');
  if (age === 'old') {
    const t = new Date(Date.now() - 60000);
    fs.utimesSync(full, t, t);
  }
  return full;
}

async function cleanup() {
  try { fs.rmSync(ROOT_DIR, { recursive: true, force: true }); } catch (_) {}
  for (const sql of [
    `DELETE FROM tenancy_agreements WHERE tenant_code LIKE 'ZZAG-%'`,
    `DELETE FROM audit_log WHERE action LIKE 'agreement_inbox%' AND (entity_id LIKE '%ZZAG%' OR details::text LIKE '%ZZAG%' OR details::text LIKE '%999979%' OR details::text LIKE '%NoSuchHouse%')`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZAG-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZAG-%'`,
    `DELETE FROM houses WHERE paybill_number IN ('999979','999978')`,
  ]) {
    try { await query(sql, []); } catch (e) { console.error('[cleanup]', e.message); }
  }
}

async function main() {
  await cleanup();
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status) VALUES ($1, $2, 4, 'unknown')`, [HOUSE_A, HOUSE_A_NAME]);
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status) VALUES ($1, 'ZZAG House Two', 4, 'unknown')`, [HOUSE_B]);
  await store.createTenant({
    tenant_code: 'ZZAG-01', name: 'ZZAG Active Tenant', phone_number: '+254700001901',
    property_name: HOUSE_A_NAME, house_id: HOUSE_A, unit_label: 'AG1',
    rent_amount: 9000, deposit_amount: 4000, move_in_date: '2026-09-01',
    rent_due_date: '2026-12-05', status: 'Active',
  });
  await store.createTenant({
    tenant_code: 'ZZAG-02', name: 'ZZAG Vacant Tenant', phone_number: '+254700001902',
    property_name: HOUSE_A_NAME, house_id: HOUSE_A, unit_label: 'AG9',
    rent_amount: 9000, deposit_amount: 4000, move_in_date: '2026-01-01',
    rent_due_date: '2026-12-05', status: 'Vacant',
  });
  await store.createTenant({
    tenant_code: 'ZZAG-03', name: 'ZZAG House2 Tenant', phone_number: '+254700001903',
    property_name: 'ZZAG House Two', house_id: HOUSE_B, unit_label: 'H2A',
    rent_amount: 9000, deposit_amount: 4000, move_in_date: '2026-09-01',
    rent_due_date: '2026-12-05', status: 'Active',
  });
  // createTenant does not persist unit_label — set it so BOTH match routes
  // (unit label AND tenant code) are exercised, as in production data.
  await query(`UPDATE tenants SET unit_label = 'AG1' WHERE tenant_code = 'ZZAG-01'`);
  await query(`UPDATE tenants SET unit_label = 'AG9' WHERE tenant_code = 'ZZAG-02'`);

  // Folder layout (the contract we will document)
  writePdf(`${HOUSE_A_NAME}/AG1.pdf`, { age: 'fresh' });     // fresh -> skipped this run
  writePdf(`${HOUSE_A_NAME}/AG9.pdf`);                        // vacant -> unmatched
  writePdf(`${HOUSE_A_NAME}/H2A.pdf`);                        // unit of ANOTHER house -> unmatched
  writePdf(`${HOUSE_A}/ZZAG-01.pdf`);                         // paybill folder + tenant-code name -> matched
  writePdf(`NoSuchHouse/Z9.pdf`);                             // unknown folder -> unmatched

  try {
    // ── Run 1 ──────────────────────────────────────────────────────────────
    let s = await inbox.processInbox({ actor: 'tester' });
    const s1 = s;
    check(s.scanned === 5, `1. five files scanned (${s.scanned})`);
    check(s.skipped_recent.some((f) => f.includes('AG1.pdf')),
      '6. fresh (mid-copy) file skipped this run', s.skipped_recent);
    check(s.processed.length === 1 && s.processed[0].tenant === 'ZZAG-01'
      && s.processed[0].file === `${HOUSE_A}/ZZAG-01.pdf`,
      '1b. PAYBILL folder matched + stored to the ACTIVE tenant', s.processed);
    check(s.errors.length === 0, `1c. no processing errors (${s.errors.length})`, s.errors);
    // Unmatched outcomes (run 1 did the bulk of them)
    check(s.unmatched.length === 3, `5. unmatched sorted (${s.unmatched.length}/3)`, s.unmatched.map((u) => u.file));
    const reasons = s.unmatched.map((u) => u.reason).join(' | ');
    check(reasons.includes('No ACTIVE tenant'), '5b. vacant unit reason explains it');
    check(reasons.includes('does not match any property'), '5c. unknown folder reason explains it');
    check(reasons.includes('"H2A"') && reasons.includes('ZZAG Test House'),
      '5d. cross-house unit explicitly refused (house scoping)');
    check(fs.existsSync(path.join(ROOT_DIR, '_unmatched', HOUSE_A_NAME, 'AG9.pdf'))
      && fs.existsSync(path.join(ROOT_DIR, '_unmatched', 'NoSuchHouse', 'Z9.pdf')),
      '5e. unmatched files moved to _unmatched/<folder>/');

    // ── Run 2: backdate AG1 now ───────────────────────────────────────────
    const t = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(ROOT_DIR, HOUSE_A_NAME, 'AG1.pdf'), t, t);
    s = await inbox.processInbox({ actor: 'tester' });
    check(s.processed.length === 1 && s.processed[0].tenant === 'ZZAG-01'
      && s.processed[0].file === `${HOUSE_A_NAME}/AG1.pdf`,
      '2. processed next run; house-NAME folder matched too', s.processed);
    check(uploads.length === 2 && uploads.every((u) => u.tenantCode === 'ZZAG-01' && u.head === '%PDF-'),
      `3. stored into tenant's Agreements (uploads: ${uploads.map((u) => u.originalName).join(', ')})`);
    const rows = (await query(
      `SELECT filename, uploaded_by FROM tenancy_agreements WHERE tenant_code = 'ZZAG-01' ORDER BY id`
    )).rows;
    check(rows.length === 2 && rows.every((r) => r.uploaded_by === 'tester'),
      `3b. tenancy_agreements rows created (${rows.map((r) => r.filename).join(', ')})`);

    // ── Processed files moved (never re-processed) ────────────────────────
    check(fs.existsSync(path.join(ROOT_DIR, '_processed', HOUSE_A, 'ZZAG-01.pdf'))
      && fs.existsSync(path.join(ROOT_DIR, '_processed', HOUSE_A_NAME, 'AG1.pdf')),
      '8. processed files moved to _processed/<folder>/');
    check(!fs.existsSync(path.join(ROOT_DIR, HOUSE_A_NAME, 'AG1.pdf')),
      '8b. original folder emptied of processed files');

    // ── Duplicate: same filename again ────────────────────────────────────
    writePdf(`${HOUSE_A_NAME}/AG1.pdf`);
    s = await inbox.processInbox({ actor: 'tester' });
    check(s.duplicates.length === 1 && s.duplicates[0].tenant === 'ZZAG-01',
      `7. duplicate filename skipped (${s.duplicates.length})`, s.duplicates);
    const rowsAfter = (await query(
      `SELECT COUNT(*)::int AS n FROM tenancy_agreements WHERE tenant_code = 'ZZAG-01'`
    )).rows[0].n;
    check(rowsAfter === 2, `7b. still exactly 2 stored agreements (${rowsAfter})`);
    check(fs.existsSync(path.join(ROOT_DIR, '_processed', HOUSE_A_NAME))
      && fs.readdirSync(path.join(ROOT_DIR, '_processed', HOUSE_A_NAME)).some((f) => f.startsWith('AG1') && f !== 'AG1.pdf'),
      '8c. colliding duplicate renamed safely in _processed');

    // ── 4. NO sends, ever ──────────────────────────────────────────────────
    check(forbidden.length === 0, `4. WhatsApp NEVER invoked (calls: ${forbidden.length})`);
    const logCount = (await query(
      `SELECT COUNT(*)::int AS n FROM message_logs WHERE tenant_code LIKE 'ZZAG-%'`
    )).rows[0].n;
    check(logCount === 0, `4b. zero message_logs from the inbox (${logCount})`);

    // ── Audit trail ────────────────────────────────────────────────────────
    const audits = (await query(
      `SELECT action, COUNT(*)::int AS n FROM audit_log
        WHERE action IN ('agreement_inbox_stored','agreement_inbox_unmatched') GROUP BY action`
    )).rows;
    const byAction = Object.fromEntries(audits.map((a) => [a.action, a.n]));
    check(byAction.agreement_inbox_stored >= 2 && byAction.agreement_inbox_unmatched >= 3,
      `audit: ${byAction.agreement_inbox_stored} stored + ${byAction.agreement_inbox_unmatched} unmatched recorded`);

    // ── 9. Endpoints ───────────────────────────────────────────────────────
    const app = express();
    app.use(express.json());
    app.use('/api/agreements-inbox', require('../backend/routes/agreementsInbox'));
    const srv = await new Promise((resolve) => { const x = app.listen(0, () => resolve(x)); });
    const PORT = srv.address().port;
    const u = (await query(
      `SELECT id, username, role FROM users WHERE role = 'admin' AND is_active IS DISTINCT FROM false ORDER BY id LIMIT 1`
    )).rows[0];
    const token = jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '10m' });
    try {
      const st = await (await fetch(`http://127.0.0.1:${PORT}/api/agreements-inbox/status`,
        { headers: { Authorization: `Bearer ${token}` } })).json();
      check(st.status || st.root, '9. status endpoint responds');
      const pr = await (await fetch(`http://127.0.0.1:${PORT}/api/agreements-inbox/process`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      })).json();
      check(Array.isArray(pr.processed) && pr.processed.length === 0 && pr.errors.length === 0,
        `9b. manual process endpoint runs clean (processed ${pr.processed.length}, errors ${pr.errors.length})`);
      const noAuth = await fetch(`http://127.0.0.1:${PORT}/api/agreements-inbox/status`);
      check(noAuth.status === 401, `9c. auth required (HTTP ${noAuth.status})`);
    } finally {
      srv.close();
    }

    console.log('\n(store-only: no WhatsApp, no Supabase — uploader stubbed)');
  } finally {
    // cleanup in then()
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
