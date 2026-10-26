/**
 * Acceptance test — message channel selection: WhatsApp | SMS | Both.
 *
 * Verifies (client requirement):
 *  - the compose flow can send via WhatsApp only, SMS only, or both
 *  - each requested channel is actually dispatched (stubbed senders, no
 *    real messages) and reported individually in the response
 *  - SMS history lands in the message_logs rows the SMS tab shows (type
 *    starts with 'SMS'); WhatsApp history keeps its 'Custom Message' rows
 *  - SMS not configured -> clear 400 (SMS-only) or per-channel failure (both)
 *  - all-channels-failed -> 502; at least one channel up -> 200 with details
 *  - client_txn_id idempotency still holds for replays
 *  - default channel remains WhatsApp (backward compatible), offline replay
 *    forwards the chosen channel
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const whatsapp = require('../backend/config/whatsapp');
const smsService = require('../backend/services/smsBytewave');

const CODE = 'ZZMSG-01';
const HOUSE = '999997';
const PHONE = '+254700000601';

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra ? ` -> ${JSON.stringify(extra)}` : '')); }
}

// ── Stubs (in this process; nothing reaches a real gateway) ─────────────────
const waCalls = [];
let waMode = 'ok'; // ok | fail
whatsapp.sendTextMessage = async (phone, body) => {
  waCalls.push({ phone, body });
  if (waMode === 'fail') return { status: 'Failed', messageId: null, failureReason: 'stub whatsapp down' };
  return { status: 'Sent', messageId: 'WA-' + waCalls.length };
};

const smsCalls = [];
let smsMode = 'ok'; // ok | not_configured | fail
smsService.getSmsSettings = async () => (smsMode === 'not_configured' ? { api_token: null } : { api_token: 'stub-token', api_base: 'https://stub', sender_id: 'GEHPM' });
smsService.sendSms = async ({ to, message }) => {
  smsCalls.push({ to, message });
  if (smsMode === 'fail') throw new Error('stub gateway rejected');
  return { data: { uid: 'SMS-' + smsCalls.length } };
};

async function cleanup() {
  const stmts = [
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZMSG-%' OR message_body LIKE '%ZZMSG%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZMSG-%'`,
    `DELETE FROM houses WHERE paybill_number = $1`,
    `DELETE FROM audit_log WHERE entity_id LIKE 'ZZMSG-%'`,
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
     VALUES ($1, 'ZZ Channel House', 3, 'unknown')`, [HOUSE]
  );
  await require('../backend/storage/store').createTenant({
    tenant_code: CODE, name: 'ZZMSG Channel Tenant', phone_number: PHONE,
    property_name: 'ZZ Channel House', house_id: HOUSE,
    rent_amount: 5000, deposit_amount: 1000,
    move_in_date: '2026-10-01', rent_due_date: '2026-11-05', status: 'Active',
  });

  const app = express();
  app.use(express.json());
  app.use('/api/tenants', require('../backend/routes/tenants'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const PORT = srv.address().port;
  const token = await makeToken();
  const send = async (body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/tenants/${CODE}/send-message`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };

  try {
    // 1. Default (no channel) = WhatsApp only — backward compatible
    let r = await send({ message: 'ZZMSG default channel test' });
    check(r.status === 200 && r.json.success === true, `1. default send OK (HTTP ${r.status})`, r.json);
    check(r.json.channel === 'whatsapp', '1b. default channel = whatsapp', r.json.channel);
    check(r.json.whatsapp.status === 'Sent' && r.json.sms && r.json.sms.status === 'Skipped',
      '1c. WhatsApp dispatched, SMS skipped', { wa: r.json.whatsapp, sms: r.json.sms });
    check(waCalls.length === 1 && smsCalls.length === 0, `1d. exactly 1 WhatsApp call, 0 SMS (${waCalls.length}/${smsCalls.length})`);

    // 2. Explicit WhatsApp
    r = await send({ message: 'ZZMSG whatsapp only', channel: 'whatsapp' });
    check(r.json.whatsapp.status === 'Sent' && r.json.sms.status === 'Skipped',
      '2. explicit whatsapp: SMS skipped', r.json.sms);
    check(waCalls.length === 2 && smsCalls.length === 0, '2b. dispatch counts (2 wa / 0 sms)');

    // 3. SMS only
    r = await send({ message: 'ZZMSG sms only', channel: 'sms' });
    check(r.status === 200 && r.json.success === true, `3. sms send OK (HTTP ${r.status})`, r.json);
    check(r.json.sms.status === 'Sent' && r.json.whatsapp.status === 'Skipped',
      '3b. SMS dispatched, WhatsApp skipped', r.json);
    check(smsCalls.length === 1 && smsCalls[0].to.startsWith('254') && smsCalls[0].message.includes('ZZMSG'),
      '3c. SMS gateway called with normalized phone', smsCalls[0]);
    check(waCalls.length === 2 && smsCalls.length === 1, '3d. dispatch counts (2 wa / 1 sms)');
    const smsLog = await query(
      `SELECT status FROM message_logs WHERE tenant_code = $1 AND message_type LIKE 'SMS%' ORDER BY id DESC LIMIT 1`,
      [CODE]
    );
    check(smsLog.rows.length === 1 && smsLog.rows[0].status === 'Sent',
      '3e. SMS history row logged (visible in SMS tab)', smsLog.rows[0]);

    // 4. Both channels
    r = await send({ message: 'ZZMSG both channels', channel: 'both' });
    check(r.status === 200 && r.json.success === true, `4. both send OK (HTTP ${r.status})`, r.json);
    check(r.json.whatsapp.status === 'Sent' && r.json.sms.status === 'Sent',
      '4b. both channels dispatched and reported Sent', { wa: r.json.whatsapp.status, sms: r.json.sms.status });
    check(waCalls.length === 3 && smsCalls.length === 2, `4c. dispatch counts (3 wa / 2 sms)`, { wa: waCalls.length, sms: smsCalls.length });
    const bothLogs = await query(
      `SELECT message_type FROM message_logs WHERE tenant_code = $1 AND message_body LIKE '%ZZMSG both channels%'`,
      [CODE]
    );
    check(bothLogs.rows.length === 2, `4d. both channels logged (${bothLogs.rows.length}/2 rows)`, bothLogs.rows.map((x) => x.message_type));

    // 5. SMS-only while not configured -> clear 400
    smsMode = 'not_configured';
    r = await send({ message: 'ZZMSG no sms config', channel: 'sms' });
    check(r.status === 400 && /not configured/i.test(r.json && r.json.error || ''),
      `5. sms-only without config -> 400 (got ${r.status})`, r.json);
    check(smsCalls.length === 2, '5b. no SMS call attempted when unconfigured');

    // 6. Both while SMS not configured -> WhatsApp succeeds, SMS reported failed
    r = await send({ message: 'ZZMSG both no sms config', channel: 'both' });
    check(r.status === 200 && r.json.whatsapp.status === 'Sent' && r.json.sms.status === 'Failed'
      && /not configured/i.test(r.json.sms.failureReason || ''),
      '6. both with SMS unconfigured: WhatsApp Sent, SMS Failed w/ reason', r.json);

    // 7. Both with SMS gateway failure -> 200 + per-channel detail
    smsMode = 'fail';
    r = await send({ message: 'ZZMSG both sms fail', channel: 'both' });
    check(r.status === 200 && r.json.whatsapp.status === 'Sent' && r.json.sms.status === 'Failed'
      && /rejected/i.test(r.json.sms.failureReason || ''),
      '7. both with SMS gateway down: WhatsApp Sent, SMS Failed w/ reason', r.json);

    // 8. All requested channels failing -> 502
    smsMode = 'fail';
    waMode = 'fail';
    r = await send({ message: 'ZZMSG all fail', channel: 'both' });
    check(r.status === 502 && /All channels failed/i.test(r.json && r.json.error || ''),
      `8. all channels failed -> 502 (got ${r.status})`, r.json);
    waMode = 'ok';
    smsMode = 'ok';

    // 9. Idempotency: replaying a client_txn_id does not double-send
    const before = { wa: waCalls.length, sms: smsCalls.length };
    const txn = 'zzmsg-txn-1';
    const first = await send({ message: 'ZZMSG idempotent', channel: 'both', client_txn_id: txn });
    const mid = { wa: waCalls.length, sms: smsCalls.length };
    const second = await send({ message: 'ZZMSG idempotent', channel: 'both', client_txn_id: txn });
    check(mid.wa > before.wa && mid.sms > before.sms, '9. first idempotent send dispatched');
    check(second.json && second.json.already_synced === true, '9b. replay answered already_synced', second.json);
    check(waCalls.length === mid.wa && smsCalls.length === mid.sms, '9c. replay sent nothing new');

    // 10. Frontend markers
    const idx = await (await fetch('http://127.0.0.1:3003/')).text();
    check(idx.includes('id="message-channel"') && idx.includes('WhatsApp + SMS (Both)'),
      '10. channel selector served in the compose modal');
    const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js?v=70')).text();
    check(appJs.includes('message-channel') && appJs.includes("api.sendMessage(tenantId, message, undefined, channel)"),
      '10b. compose handler passes the selected channel');
    check(appJs.includes('Send via Both') && appJs.includes('Send via SMS'),
      '10c. channel-aware send button labels (tenants-section modal)');
    check(appJs.includes('Send Message: ') && !appJs.includes('Send WhatsApp: '),
      '10d. modal title no longer hardcodes WhatsApp');
    const se = await (await fetch('http://127.0.0.1:3003/js/sync-engine.js')).text();
    check(se.includes('p.channel'), '10e. offline replay forwards the channel');

    console.log('\n(no real WhatsApp or SMS messages were sent — both gateways stubbed)');
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
