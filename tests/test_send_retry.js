/**
 * Acceptance test — WhatsApp sends: EXACTLY ONE attempt, never duplicates.
 *
 * Incident: the v66 lock-retry (added to fix false "Failed" statuses) turned
 * out to retry AFTER WhatsApp had accepted the message for relay — the
 * EPERM/EBUSY session-file errors surface post-relay — so every "failed"
 * send that actually delivered was re-sent once by the retry, and once MORE
 * by caller fallback paths (broadcasts try sessionManager -> catch ->
 * config.sendTextMessage -> sessionManager AGAIN). Recipients saw 2-4
 * copies while the logs recorded a single row.
 *
 * Fix under test: exactly one provider call per send, always. Lock-class
 * errors return a SOFT SUCCESS without an id ({ unconfirmed: true }) so:
 *   - the retry cannot re-send (no retry exists),
 *   - caller fallbacks never trigger (no throw for lock errors),
 *   - logs record Sent (unconfirmed), not a false Failed.
 * Real (non-lock) errors still throw after ONE attempt.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sm = require('../backend/whatsapp/session-manager');

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ` -> ${JSON.stringify(extra)}` : '')); }
}

const EPERM_OPEN = Object.assign(
  new Error("EPERM: operation not permitted, open 'C:\\apps\\rental_messaging\\backend\\whatsapp\\sessions\\session-123_1.4.json'"),
  { code: 'EPERM' }
);

async function main() {
  // 1. Classification (unchanged)
  check(typeof sm.isTransientLockError === 'function', '1. classifier exported');
  check(sm.isTransientLockError(EPERM_OPEN), '2. EPERM-open classified as lock');
  check(sm.isTransientLockError(Object.assign(new Error('resource busy'), { code: 'EBUSY' })), '2b. EBUSY classified');
  check(!sm.isTransientLockError(new Error('hard failure')), '2c. real failures NOT locks');

  // 2. The retry helper is GONE (it caused the duplicates)
  check(typeof sm.withSessionLockRetry === 'undefined',
    '3. withSessionLockRetry removed (the duplicate-send source)');

  // 3. End-to-end through the real session-manager.sendText (provider stubbed)
  const origProvider = sm._provider;
  const origState = sm._state;
  try {
    sm._state = 'CONNECTED';

    // THE regression: a lock error after WhatsApp accepted the message must
    // produce exactly ONE provider call and a soft success (never a retry).
    let providerCalls = 0;
    sm._provider = {
      sendText: async () => { providerCalls++; throw EPERM_OPEN; },
    };
    let result = null;
    let threw = null;
    try { result = await sm.sendText('+254700000000', 'lock test'); } catch (e) { threw = e; }
    check(threw === null, '4. lock error does NOT throw (no fallback re-send)', threw && threw.message);
    check(providerCalls === 1, `4b. EXACTLY ONE send attempt (${providerCalls}) — no retry, no duplicate`);
    check(result && result.unconfirmed === true && result.id === null,
      '4c. soft success without id (callers log Sent-unconfirmed, not Failed)', result);

    // Real errors still surface — but after ONE attempt only.
    providerCalls = 0;
    sm._provider.sendText = async () => { providerCalls++; throw new Error('hard failure'); };
    threw = null;
    try { await sm.sendText('+254700000000', 'should fail'); } catch (e) { threw = e; }
    check(threw && /hard failure/.test(threw.message) && providerCalls === 1,
      `5. real failure throws after ONE attempt (${providerCalls})`);

    // Normal success path untouched.
    providerCalls = 0;
    sm._provider.sendText = async () => { providerCalls++; return { id: 'WA-OK-1' }; };
    result = await sm.sendText('+254700000000', 'normal');
    check(result.id === 'WA-OK-1' && providerCalls === 1, '6. success path returns the id');

    // Documents (receipts/PDFs): same single-attempt rule.
    providerCalls = 0;
    sm._provider.sendDocument = async () => { providerCalls++; throw EPERM_OPEN; };
    result = await sm.sendDocument('+254700000000', Buffer.from('x'), 'application/pdf', 'r.pdf');
    check(result && result.unconfirmed === true && providerCalls === 1,
      `7. document lock: ONE attempt + soft success (${providerCalls})`);

    // Broadcast-style bulk: one call per recipient, lock on any of them
    // never doubles that recipient.
    providerCalls = 0;
    sm._provider.sendText = async (phone) => {
      providerCalls++;
      if (phone === '+254700000002') throw EPERM_OPEN;
      return { id: `WA-${providerCalls}` };
    };
    const bulk = await sm.sendBulk([
      { phone: '+254700000001', text: 'a' },
      { phone: '+254700000002', text: 'b' },
      { phone: '+254700000003', text: 'c' },
    ]);
    check(providerCalls === 3, `8. bulk = one attempt per recipient (${providerCalls} for 3)`);
    check(bulk[1].unconfirmed === true && bulk[0].id, '8b. bulk lock row soft, others normal');

    // The caller-level chain: config.sendTextMessage must report Sent (not
    // Failed) for a lock error and must NOT invoke any second send path.
    const whatsapp = require('../backend/config/whatsapp');
    providerCalls = 0;
    sm._provider.sendText = async () => { providerCalls++; throw EPERM_OPEN; };
    const cfg = await whatsapp.sendTextMessage('+254700000000', 'via config');
    check(cfg.status === 'Sent' && cfg.messageId === null,
      '9. config layer: Sent with null id (unconfirmed), not Failed', cfg);
    check(providerCalls === 1,
      `9b. full stack: ONE provider call end-to-end (${providerCalls}) — duplicates impossible`);

    // Disconnected state still short-circuits before any provider call.
    sm._state = 'DISCONNECTED';
    providerCalls = 0;
    threw = null;
    try { await sm.sendText('+254700000000', 'no session'); } catch (e) { threw = e; }
    check(threw && /not connected/.test(threw.message) && providerCalls === 0,
      '10. disconnected guard untouched');
  } finally {
    sm._provider = origProvider;
    sm._state = origState;
  }

  console.log('\n(no real WhatsApp messages were sent — provider stubbed)');
}

main()
  .then(() => {
    console.log(`\n===============================\nRESULT: ${pass} passed, ${fail} failed`);
    if (failures.length) console.log('FAILURES:\n - ' + failures.join('\n - '));
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => { console.error(e); process.exit(1); });
