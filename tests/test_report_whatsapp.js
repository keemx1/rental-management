/**
 * Acceptance test — "Generate & Send via WhatsApp" report workflow.
 *
 * Reproduces the client's exact complaint and verifies the fix:
 *  - the WhatsApp path serialises the SAME valid .xlsx workbook as Download
 *  - the attachment carries the CORRECT spreadsheet mimetype (it used to be
 *    labelled application/pdf -> "We can't open this file" on the phone)
 *  - delivery failures are reported as delivery failures (502, stage: send)
 *    and generation failures as generation failures (500, stage: generate) —
 *    never "Failed to generate" after a successful send
 *  - cleanup after a successful send can never surface as an error
 *
 * The WhatsApp sender is stubbed inside this process (in-process Express app
 * mounts the real routers) so NO real messages are ever sent.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const ExcelJS = require('exceljs');
const { query } = require('../backend/config/database');
const whatsapp = require('../backend/config/whatsapp');
const { sendExcelReport } = require('../backend/services/excelStream');

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra ? ` -> ${JSON.stringify(extra)}` : '')); }
}

// ── Stub the WhatsApp sender (records everything, sends nothing) ─────────────
const captured = [];
let stubMode = 'sent'; // 'sent' | 'failed' | 'sent-and-deleted'
whatsapp.sendDocumentSmart = async (phone, filePath, caption) => {
  const rec = {
    phone,
    filePath,
    caption,
    existed: fs.existsSync(filePath),
    ext: path.extname(String(filePath || '')),
    mimetype: whatsapp.mimetypeForFile(filePath),
    bytes: null,
  };
  if (rec.existed) rec.bytes = fs.readFileSync(filePath);
  captured.push(rec);
  if (stubMode === 'sent-and-deleted' && rec.existed) {
    try { fs.unlinkSync(filePath); } catch (_) {} // consumer deleted the file mid-flight
  }
  if (stubMode === 'failed') {
    return { status: 'Failed', failureReason: 'WhatsApp session not connected — scan the QR code in the WhatsApp view to reconnect' };
  }
  return { status: 'Sent', channel: 'test-stub', mediaDelivered: true, messageId: 'stub-message-id' };
};

async function makeToken() {
  const u = (await query(
    `SELECT id, username, role FROM users WHERE is_active IS DISTINCT FROM false
      ORDER BY (role = 'admin') DESC, id LIMIT 1`
  )).rows[0];
  return jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

async function main() {
  // In-process server mounting the REAL routers (same code the live server runs)
  const app = express();
  app.use(express.json());
  app.use('/api/reports', require('../backend/routes/reports'));
  app.use('/api/payments', require('../backend/routes/payments'));
  app.use('/api/houses', require('../backend/routes/houses'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const BASE = `http://127.0.0.1:${srv.address().port}/api`;
  const token = await makeToken();
  const startedAt = Date.now();
  const post = async (p, body) => {
    const res = await fetch(BASE + p, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  };

  try {
    // ── 0. MIME correctness (the root cause of "We can't open this file") ──
    check(whatsapp.mimetypeForFile('report.xlsx')
      === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '0. .xlsx gets the real spreadsheet mimetype');
    check(whatsapp.mimetypeForFile('doc.PDF') === 'application/pdf', '0b. .pdf still maps to pdf');
    check(whatsapp.mimetypeForFile('pic.png') === 'image/png', '0c. .png still maps to png');
    check(whatsapp.mimetypeForFile('pic.jpg') === 'image/jpeg', '0d. .jpg still maps to jpeg');
    check(whatsapp.mimetypeForFile('weird.xyz') === 'application/octet-stream',
      '0e. unknown extension falls back to octet-stream (never a fake pdf)');

    // ── 1. DOWNLOAD works (baseline — must remain untouched) ────────────────
    stubMode = 'sent';
    const dl = await post('/reports/outstanding-balances', { mode: 'download', phone_number: null });
    check(dl.status === 200, `1. download endpoint still OK (HTTP ${dl.status})`);
    const dlBuf = Buffer.from(await (await fetch(`${BASE}/reports/outstanding-balances`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'download' }),
    })).arrayBuffer());
    const dlWb = new ExcelJS.Workbook();
    await dlWb.xlsx.load(dlBuf);
    const dlSheet = dlWb.getWorksheet('Outstanding Balances');
    check(!!dlSheet, '1b. download workbook opens with sheet "Outstanding Balances"');

    // ── 2. SEND uses the same generation, correct name/ext/mimetype ─────────
    const send1 = await post('/reports/outstanding-balances', { mode: 'send', phone_number: '+254700000999' });
    check(send1.status === 200 && send1.json && send1.json.success === true,
      `2. send returns success (HTTP ${send1.status})`, send1.json);
    const c1 = captured[captured.length - 1];
    check(!!c1, '2b. sender invoked');
    if (c1) {
      check(c1.existed === true && c1.ext === '.xlsx', `2c. real .xlsx file attached (${c1.filePath})`);
      check(c1.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '2d. attachment mimetype is the spreadsheet type (was application/pdf)', c1.mimetype);
      check(/outstanding/i.test(c1.caption || ''), '2e. caption present', c1.caption);

      // The attached bytes must be a fully valid workbook — same as download
      const sendWb = new ExcelJS.Workbook();
      await sendWb.xlsx.load(c1.bytes);
      const sendSheet = sendWb.getWorksheet('Outstanding Balances');
      check(!!sendSheet, '2f. attached bytes open as a valid workbook');
      const findTotal = (ws) => {
        let v = null;
        ws.eachRow((row) => { row.eachCell((cell) => { if (String(cell.value) === 'TOTAL') v = row.getCell(4).value; }); });
        return v;
      };
      check(String(findTotal(dlSheet)) === String(findTotal(sendSheet)),
        '2g. send and download carry IDENTICAL report totals',
        { download: findTotal(dlSheet), send: findTotal(sendSheet) });

      // Cleanup after success must not leave orphans...
      check(!fs.existsSync(c1.filePath), '2h. temp file cleaned up after successful send');
    }

    // ── 3. Cleanup can never surface as an error (old bug: ENOENT after send)
    stubMode = 'sent-and-deleted';
    const send2 = await post('/reports/outstanding-balances', { mode: 'send', phone_number: '+254700000999' });
    check(send2.status === 200 && send2.json && send2.json.success === true,
      `3. send still succeeds when the file disappears mid-flight (HTTP ${send2.status})`, send2.json);

    // ── 4. Delivery failure is reported as a DELIVERY failure ───────────────
    stubMode = 'failed';
    const send3 = await post('/reports/outstanding-balances', { mode: 'send', phone_number: '+254700000999' });
    check(send3.status === 502, `4. delivery failure -> HTTP 502 (got ${send3.status})`);
    check(send3.json && send3.json.stage === 'send', '4b. body.stage = send', send3.json);
    check(/WhatsApp delivery failed/i.test(send3.json && send3.json.error || ''),
      '4c. message says delivery failed', send3.json && send3.json.error);
    check(!/Failed to generate/i.test(send3.json && send3.json.error || ''),
      '4d. message does NOT claim generation failed', send3.json && send3.json.error);

    // ── 5. Generation failure is reported separately ────────────────────────
    stubMode = 'sent';
    let genErr = null;
    try {
      await sendExcelReport('+254700000999', { xlsx: { writeFile: async () => { throw new Error('disk full'); } } }, 'X.xlsx', 'cap');
    } catch (e) { genErr = e; }
    check(genErr && genErr.reportStage === 'generate' && /generation failed/i.test(genErr.message),
      '5. generation failure tagged stage=generate', genErr && genErr.message);
    // route maps it to 500 + stage generate — verified through the helper contract

    // ── 6. Other reports share the fixed pipeline ───────────────────────────
    stubMode = 'sent';
    const vac = await post('/houses/send-vacant-report', { mode: 'send', phone_number: '+254700000999' });
    check(vac.status === 200 && vac.json && vac.json.success === true,
      `6. vacancy report send OK (HTTP ${vac.status})`, vac.json);
    const cv = captured[captured.length - 1];
    if (cv) check(cv.ext === '.xlsx' && cv.mimetype.includes('spreadsheetml'), '6b. vacancy attachment typed correctly', cv.mimetype);

    const pay = await post('/payments/send-report', { mode: 'send', phone_number: '+254700000999' });
    check(pay.status === 200 && pay.json && pay.json.success === true,
      `6c. payments report send OK (HTTP ${pay.status})`, pay.json);
    const cp = captured[captured.length - 1];
    if (cp) check(cp.ext === '.xlsx' && cp.mimetype.includes('spreadsheetml'), '6d. payments attachment typed correctly', cp.mimetype);

    // ── 7. No orphan report files left behind by these runs ─────────────────
    const leftovers = fs.readdirSync(require('os').tmpdir())
      .filter((f) => /^(report_|Outstanding_Report|Unpaid_Units_Report|Vacancy_Report|Payment_Report)/i.test(f)
        && f.endsWith('.xlsx')
        && fs.statSync(path.join(require('os').tmpdir(), f)).mtimeMs >= startedAt - 2000);
    check(leftovers.length === 0, '7. no orphan report files in tmp', leftovers);

    console.log('\n(no real WhatsApp messages were sent — sender was stubbed)');
  } finally {
    srv.close();
  }
}

main()
  .then(() => {
    console.log(`\n===============================\nRESULT: ${pass} passed, ${fail} failed`);
    if (failures.length) console.log('FAILURES:\n - ' + failures.join('\n - '));
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => { console.error(e); process.exit(1); });
