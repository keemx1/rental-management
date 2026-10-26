/**
 * Acceptance test — SMS as a broadcast channel.
 *
 * Verifies:
 *  1. Channel selector semantics: whatsapp (default) | sms | both — same as
 *     the tenant message modal
 *  2. WhatsApp-only (default): WhatsApp sender called, SMS sender untouched,
 *     'Broadcast' log rows + whatsapp_message_log entries only
 *  3. SMS-only (configured): SMS sender called, WhatsApp untouched,
 *     'SMS Broadcast' log rows, NO whatsapp_message_log pollution
 *  4. Both: both senders called per recipient, log rows for each channel
 *  5. SMS-only + unconfigured token -> 400 with a clear message and ZERO
 *     sends; Both + unconfigured -> WhatsApp proceeds, SMS marked Failed
 *     per recipient with the reason
 *  6. Per-recipient SMS failure -> honest failed status + failure_reason
 *  7. House targeting still scoping recipients (never hits other tenants)
 *  8. Frontend: channel selector served with the send payload
 *
 * FIXTURE-ONLY targeting (target_type=house): 'all' is never used, so no
 * real tenant is touched. Senders are stubbed — no real messages.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const sessionManager = require('../backend/whatsapp/session-manager');
const smsService = require('../backend/services/smsBytewave');
const { normalizePhone } = require('../backend/whatsapp/phone');

const HOUSE = '999994';
const T1 = 'ZZBC-01';
const T2 = 'ZZBC-02';
const FAIL_PHONE = '+254700000902'; // T2's phone fails SMS in one test

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ` -> ${JSON.stringify(extra)}` : '')); }
}

// ── Sender stubs ────────────────────────────────────────────────────────────
const calls = { wa: [], sms: [] };
let smsConfigured = true;
let smsFailFor = new Set();

sessionManager.sendText = async (phone, text) => {
  calls.wa.push(phone);
  return { id: `WA-BC-${calls.wa.length}` };
};
smsService.getSmsSettings = async () => (smsConfigured ? { api_token: 'test-token' } : {});
smsService.sendSms = async ({ to, message }) => {
  if (smsFailFor.has(to)) throw new Error('provider rejected the number');
  calls.sms.push(to);
  return { data: { uid: `SMS-BC-${calls.sms.length}` } };
};

async function cleanup() {
  for (const sql of [
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZBC-%'`,
    `DELETE FROM whatsapp_message_log WHERE tenant_code LIKE 'ZZBC-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZBC-%'`,
    `DELETE FROM houses WHERE paybill_number = $1`,
  ]) {
    try { await query(sql, sql.includes('$1') ? [HOUSE] : undefined); } catch (_) {}
  }
}

const countLogs = async (type) => (await query(
  `SELECT COUNT(*)::int AS n FROM message_logs WHERE tenant_code LIKE 'ZZBC-%' AND message_type = $1`,
  [type]
)).rows[0].n;
const countWaLog = async () => (await query(
  `SELECT COUNT(*)::int AS n FROM whatsapp_message_log WHERE tenant_code LIKE 'ZZBC-%'`
)).rows[0].n;

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
     VALUES ($1, 'ZZBC House', 4, 'unknown')`, [HOUSE]
  );
  await store.createTenant({
    tenant_code: T1, name: 'ZZBC Tenant One', phone_number: '+254700000901',
    property_name: 'ZZBC House', house_id: HOUSE, rent_amount: 9000, deposit_amount: 4000,
    move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });
  await store.createTenant({
    tenant_code: T2, name: 'ZZBC Tenant Two', phone_number: FAIL_PHONE,
    property_name: 'ZZBC House', house_id: HOUSE, rent_amount: 9000, deposit_amount: 4000,
    move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
  });

  const app = express();
  app.use(express.json());
  app.use('/api/broadcasts', require('../backend/routes/broadcasts'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const PORT = srv.address().port;
  const token = await makeToken();
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const send = (body) => fetch(`http://127.0.0.1:${PORT}/api/broadcasts/send`, {
    method: 'POST', headers: auth, body: JSON.stringify({ target_type: 'house', house_id: HOUSE, message_body: 'Rent reminder for {{client_name}}', ...body }),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

  try {
    // ── 1. Default = WhatsApp only ─────────────────────────────────────────
    let r = await send({});
    check(r.status === 200 && r.json.channel === 'whatsapp', `1. default channel = whatsapp (HTTP ${r.status})`);
    check(r.json.sent === 2 && r.json.failed === 0, `1b. sent=2 failed=0 (got ${r.json.sent}/${r.json.failed})`);
    check(r.json.whatsapp && r.json.whatsapp.sent === 2 && r.json.sms === null,
      '1c. whatsapp breakdown present, sms null', { whatsapp: r.json.whatsapp, sms: r.json.sms });
    check(calls.wa.length === 2 && calls.sms.length === 0, `1d. only WhatsApp called (wa=${calls.wa.length}, sms=${calls.sms.length})`);
    check(await countLogs('Broadcast') === 2 && await countLogs('SMS Broadcast') === 0,
      '1e. only Broadcast log rows');
    check(await countWaLog() === 2, '1f. whatsapp_message_log written for WhatsApp legs');
    check(r.json.results.length === 2 && r.json.results.every(x => x.whatsapp && x.whatsapp.status === 'Sent'),
      '1g. per-recipient whatsapp status', r.json.results);
    check(r.json.results[0].tenant_name === 'ZZBC Tenant One', '1h. house targeting scoped to fixture house only');

    // ── 2. SMS only (configured) ───────────────────────────────────────────
    r = await send({ channel: 'sms' });
    check(r.status === 200 && r.json.channel === 'sms', `2. channel sms accepted (HTTP ${r.status})`);
    check(r.json.sms && r.json.sms.sent === 2 && r.json.whatsapp === null,
      '2b. sms breakdown present, whatsapp null');
    check(calls.wa.length === 2 && calls.sms.length === 2,
      `2c. only SMS called this round (wa=${calls.wa.length}, sms=${calls.sms.length})`);
    check(await countLogs('SMS Broadcast') === 2, '2d. SMS Broadcast log rows');
    check(await countWaLog() === 2, '2e. NO whatsapp_message_log pollution from SMS-only');
    check(r.json.results.every(x => x.sms && x.sms.status === 'Sent' && !x.whatsapp),
      '2f. per-recipient sms status (whatsapp absent)', r.json.results);

    // ── 3. Both channels ───────────────────────────────────────────────────
    r = await send({ channel: 'both' });
    check(r.status === 200 && r.json.channel === 'both', `3. channel both accepted (HTTP ${r.status})`);
    check(r.json.whatsapp.sent === 2 && r.json.sms.sent === 2, '3b. both legs counted');
    check(calls.wa.length === 4 && calls.sms.length === 4,
      `3c. both senders called per recipient (wa=${calls.wa.length}, sms=${calls.sms.length})`);
    check(await countLogs('Broadcast') === 4 && await countLogs('SMS Broadcast') === 4,
      '3d. log rows for both channels (4 + 4)');
    check(await countWaLog() === 4, '3e. whatsapp_message_log only for whatsapp legs (4)');
    check(r.json.results.every(x => x.whatsapp && x.sms), '3f. per-recipient statuses for both legs');

    // ── 4. SMS-only + unconfigured -> 400, zero sends ──────────────────────
    smsConfigured = false;
    const smsBefore = calls.sms.length;
    r = await send({ channel: 'sms' });
    check(r.status === 400 && /SMS is not configured/.test(r.json?.error || ''),
      `4. unconfigured SMS-only rejected (HTTP ${r.status})`, r.json);
    check(calls.sms.length === smsBefore, `4b. zero SMS sends attempted (${calls.sms.length})`);
    check(await countLogs('SMS Broadcast') === 4, '4c. no log rows from the rejected broadcast');

    // ── 5. Both + unconfigured -> WhatsApp proceeds, SMS failed per recipient
    r = await send({ channel: 'both' });
    check(r.status === 200 && r.json.whatsapp.sent === 2,
      `5. WhatsApp leg still delivered when SMS unconfigured (HTTP ${r.status})`);
    check(r.json.sms.failed === 2 && r.json.sms.sent === 0,
      `5b. SMS leg failed per recipient (sent=${r.json.sms.sent}, failed=${r.json.sms.failed})`);
    check(r.json.results.every(x => x.sms.status === 'Failed' && /not configured/i.test(x.sms.error || '')),
      '5c. failure reason recorded', r.json.results.map(x => x.sms.error));
    check(await countLogs('SMS Broadcast') === 6, '5d. failed SMS attempts logged with reason');

    // ── 6. Per-recipient SMS failure is honest ─────────────────────────────
    smsConfigured = true;
    smsFailFor = new Set([normalizePhone(FAIL_PHONE)]);
    r = await send({ channel: 'sms' });
    check(r.json.sms.sent === 1 && r.json.sms.failed === 1,
      `6. one recipient failed, one sent (sent=${r.json.sms.sent}, failed=${r.json.sms.failed})`);
    const failedEntry = r.json.results.find(x => x.tenant_name === 'ZZBC Tenant Two');
    check(failedEntry && failedEntry.sms.status === 'Failed' && /rejected/.test(failedEntry.sms.error || ''),
      '6b. failure reason surfaced per recipient', failedEntry && failedEntry.sms);
    const failedLog = (await query(
      `SELECT status, failure_reason FROM message_logs
        WHERE tenant_code = $1 AND message_type = 'SMS Broadcast'
        ORDER BY id DESC LIMIT 1`, [T2]
    )).rows[0];
    check(failedLog && failedLog.status === 'Failed' && /rejected/.test(failedLog.failure_reason || ''),
      '6c. failed log row carries the reason', failedLog);
    smsFailFor = new Set();

    // ── 7. Frontend markers ────────────────────────────────────────────────
    const idx = await (await fetch('http://127.0.0.1:3003/')).text();
    check(idx.includes('id="broadcast-channel"') && idx.includes('value="both"') && idx.includes('app.js?v=73'),
      '7. channel selector + v73 assets served');
    const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js?v=73')).text();
    check(appJs.includes("channel: document.getElementById('broadcast-channel')?.value || 'whatsapp'"),
      '7b. frontend sends the selected channel (default whatsapp)');

    console.log('\n(no real messages were sent — senders stubbed, fixture house only)');
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
