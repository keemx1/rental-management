/**
 * Acceptance test — transient session-file lock retry on WhatsApp sends.
 *
 * Root cause of "message delivered but shown as Failed": Windows (Defender
 * real-time scan) transiently locks Baileys session JSON files; the send
 * path threw EPERM "operation not permitted, open ...session-*.json" and
 * recorded Failed. The failure happens BEFORE any bytes are relayed, so a
 * short retry (wrapped around every provider send in session-manager) fixes
 * the false failures and cannot duplicate a message.
 *
 * Verifies:
 *  - lock-class errors are detected (EPERM-open / EBUSY / EACCES)
 *  - non-lock errors are NOT retried (no masking of real failures)
 *  - a lock on attempt 1 is retried and the send succeeds (2 provider calls)
 *  - persistent locks fail after the bounded attempts
 *  - the real session-manager sendText path applies the retry end-to-end
 *    (provider stubbed — no real messages)
 */
const sm = require('../backend/whatsapp/session-manager');

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra ? ` -> ${JSON.stringify(extra)}` : '')); }
}

const EPERM_OPEN = Object.assign(
  new Error("EPERM: operation not permitted, open 'C:\\apps\\rental_messaging\\backend\\whatsapp\\sessions\\session-123_1.4.json'"),
  { code: 'EPERM' }
);

async function main() {
  const isLock = sm.isTransientLockError;
  const retry = sm.withSessionLockRetry;
  check(typeof isLock === 'function' && typeof retry === 'function', '1. helpers exported on the session manager');

  // 1. Classification
  check(isLock(EPERM_OPEN), '2. EPERM-open classified as transient lock');
  check(isLock(Object.assign(new Error('resource busy'), { code: 'EBUSY' })), '2b. EBUSY classified');
  check(!isLock(new Error('WhatsApp session is not connected')), '2c. real failures NOT classified as locks');
  check(!isLock(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' })), '2d. timeouts NOT retried');

  // 2. Retry behaviour
  let calls = 0;
  const failOnce = async () => { calls++; if (calls === 1) throw EPERM_OPEN; return { success: true, id: 'MSG-1' }; };
  const r1 = await retry(failOnce);
  check(r1 && r1.id === 'MSG-1' && calls === 2, `3. lock retried once then succeeded (${calls} calls)`);

  calls = 0;
  const genericFail = async () => { calls++; throw new Error('hard failure'); };
  let threw = null;
  try { await retry(genericFail); } catch (e) { threw = e; }
  check(threw && calls === 1, `4. non-lock error NOT retried (${calls} call)`);

  calls = 0;
  const alwaysLock = async () => { calls++; throw EPERM_OPEN; };
  threw = null;
  try { await retry(alwaysLock); } catch (e) { threw = e; }
  check(threw && calls === 3, `5. persistent lock fails after bounded attempts (${calls} calls)`);

  // 3. End-to-end through the real session-manager.sendText (provider stubbed)
  const origProvider = sm._provider;
  const origState = sm._state;
  try {
    sm._state = 'CONNECTED';
    let providerCalls = 0;
    sm._provider = {
      sendText: async (phone, text) => {
        providerCalls++;
        if (providerCalls === 1) throw EPERM_OPEN;
        return { success: true, id: 'WA-RETRY-OK' };
      },
    };
    const sent = await sm.sendText('+254700000000', 'retry integration test');
    check(sent && sent.id === 'WA-RETRY-OK' && providerCalls === 2,
      `6. sendText recovers from a session-file lock (${providerCalls} provider calls)`);

    // Real failure still surfaces immediately
    providerCalls = 0;
    sm._provider.sendText = async () => { providerCalls++; throw new Error('hard failure inside provider'); };
    let err = null;
    try { await sm.sendText('+254700000000', 'should fail'); } catch (e) { err = e; }
    check(err && /hard failure/.test(err.message) && providerCalls === 1,
      `6b. real provider failure surfaces after 1 attempt (${providerCalls})`);

    // Not-connected state still short-circuits before any provider call
    sm._state = 'DISCONNECTED';
    providerCalls = 0;
    err = null;
    try { await sm.sendText('+254700000000', 'no session'); } catch (e) { err = e; }
    check(err && /not connected/.test(err.message) && providerCalls === 0,
      '6c. disconnected state guard untouched');
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
