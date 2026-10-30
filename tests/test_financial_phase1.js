/**
 * Acceptance test — Financial Management Phase 1 (management decision sheet §6):
 *  P1 Obligations Tracker · P2 Monthly Report · P3 Registers
 *  + Arrangement A/B config + double-entry foundation (balanced journals,
 *    idempotent posting, reversals, trial balance) + opening balances +
 *  ADMIN-ONLY access (operators 403).
 *
 * Fixtures: house 999977, landlord ZZFM-*, tenant ZZFM-*, removed afterwards.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const express = require('express');
const { query } = require('../backend/config/database');
const store = require('../backend/storage/store');
const journal = require('../backend/services/journal');
const commission = require('../backend/services/landlordCommission');

const HOUSE = '999977';
const MONTH = '2026-09';

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra !== undefined ? ` -> ${JSON.stringify(extra)}` : '')); }
}

async function cleanup() {
  for (const sql of [
    `DELETE FROM journal_lines WHERE entry_id IN (
       SELECT e.id FROM journal_entries e
        WHERE e.memo ILIKE '%ZZFM%' OR e.source_id LIKE '%ZZFM%'
           OR e.source_id IN (SELECT id::text FROM commission_invoices WHERE house_paybill_number IN ($1,$2))
           OR e.source_id IN (SELECT id::text FROM commission_payments WHERE house_paybill_number IN ($1,$2))
           OR e.source_id IN (SELECT id::text FROM landlord_remittance_payments WHERE house_paybill_number IN ($1,$2))
           OR e.source_id IN (SELECT id::text FROM payments WHERE tenant_code LIKE 'ZZFM%')
           OR e.source_id LIKE ANY(ARRAY(SELECT id::text || ':%' FROM deposit_refunds WHERE tenant_code LIKE 'ZZFM%'))
           OR EXISTS (SELECT 1 FROM journal_lines lx WHERE lx.entry_id = e.id AND lx.house_paybill IN ($1,$2)))`,
    `DELETE FROM journal_entries WHERE id NOT IN (SELECT entry_id FROM journal_lines)
       AND (memo ILIKE '%ZZFM%' OR source_id LIKE '%ZZFM%'
            OR source_id IN (SELECT id::text FROM commission_invoices WHERE house_paybill_number IN ($1,$2))
            OR source_id IN (SELECT id::text FROM commission_payments WHERE house_paybill_number IN ($1,$2))
            OR source_id IN (SELECT id::text FROM landlord_remittance_payments WHERE house_paybill_number IN ($1,$2))
            OR source_id IN (SELECT id::text FROM payments WHERE tenant_code LIKE 'ZZFM%')
            OR source_id LIKE ANY(ARRAY(SELECT id::text || ':%' FROM deposit_refunds WHERE tenant_code LIKE 'ZZFM%')))`,
    // Orphans from PRIOR runs (their source rows are already gone): posted
    // entries whose source no longer exists anywhere.
    `DELETE FROM journal_lines WHERE entry_id IN (
       SELECT id FROM journal_entries
        WHERE status = 'Posted'
          AND ((source_type = 'commission_invoice' AND source_id NOT IN (SELECT id::text FROM commission_invoices))
            OR (source_type = 'commission_payment' AND source_id NOT IN (SELECT id::text FROM commission_payments))
            OR (source_type = 'landlord_remittance' AND source_id NOT IN (SELECT id::text FROM landlord_remittance_payments))
            OR (source_type = 'deposit_refund_paid' AND (SELECT COUNT(*) FROM deposit_refunds) > 0 AND source_id NOT LIKE ANY(ARRAY(SELECT id::text || ':%' FROM deposit_refunds)))))`,
    `DELETE FROM journal_entries WHERE id NOT IN (SELECT entry_id FROM journal_lines)
       AND status = 'Posted'
       AND ((source_type = 'commission_invoice' AND source_id NOT IN (SELECT id::text FROM commission_invoices))
         OR (source_type = 'commission_payment' AND source_id NOT IN (SELECT id::text FROM commission_payments))
         OR (source_type = 'landlord_remittance' AND source_id NOT IN (SELECT id::text FROM landlord_remittance_payments))
         OR (source_type = 'deposit_refund_paid' AND (SELECT COUNT(*) FROM deposit_refunds) > 0 AND source_id NOT LIKE ANY(ARRAY(SELECT id::text || ':%' FROM deposit_refunds))))`,
    `DELETE FROM other_income WHERE source_client ILIKE '%ZZFM%' OR description ILIKE '%ZZFM%'`,
    `DELETE FROM expense_categories WHERE name = 'ZZFM Custom'`,
    `DELETE FROM landlord_reviews WHERE house_paybill_number = $1`,
    `DELETE FROM landlord_remittance_payments WHERE house_paybill_number IN ($1,$2)`,
    `DELETE FROM commission_payments WHERE house_paybill_number IN ($1,$2)`,
    `DELETE FROM commission_invoices WHERE house_paybill_number IN ($1,$2)`,
    `DELETE FROM deposit_refunds WHERE tenant_code LIKE 'ZZFM%'`,
    `DELETE FROM exit_invoices WHERE tenant_code LIKE 'ZZFM%'`,
    `DELETE FROM documents WHERE tenant_code LIKE 'ZZFM%' OR house_paybill_number IN ($1,$2)`,
    `DELETE FROM salary_records WHERE employee_name LIKE 'ZZFM%'`,
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZFM%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZFM%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZFM%'`,
    `DELETE FROM houses WHERE paybill_number IN ($1,$2)`,
    `DELETE FROM landlords WHERE name LIKE 'ZZFM%'`,
    `DELETE FROM audit_log WHERE entity_id LIKE '%ZZFM%' OR details::text LIKE '%ZZFM%' OR action = 'financial_arrangement_changed' AND entity_id IN ($1,$2)`,
    `DELETE FROM users WHERE username = 'zzfm-ops'`,
    `DELETE FROM app_config WHERE key = 'financial_opening_balances'`,
  ]) {
    const P = [HOUSE, '999976'];
    const nums = (sql.match(/\$(\d+)/g) || []).map((x) => Number(x.slice(1)));
    const n = nums.length ? Math.max(...nums) : 0;
    try { await query(sql, n ? P.slice(0, n) : []); } catch (e) { console.error('[cleanup]', e.message); }
  }
}

async function main() {
  await cleanup();
  await query(`INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status)
    VALUES ($1, 'ZZFM House', 4, 'unknown')`, [HOUSE]);

  const app = express();
  app.use(express.json());
  app.use('/api/financial', require('../backend/routes/financial'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const PORT = srv.address().port;
  const admin = (await query(`SELECT id, username, role FROM users WHERE role = 'admin' AND is_active IS DISTINCT FROM false ORDER BY id LIMIT 1`)).rows[0];
  const adminToken = jwt.sign({ sub: admin.id, username: admin.username, role: admin.role }, process.env.JWT_SECRET, { expiresIn: '20m' });
  await query(`INSERT INTO users (username, password_hash, display_name, role, is_active)
    VALUES ('zzfm-ops', 'x', 'ZZFM Operator', 'operator', true)
    ON CONFLICT (username) DO UPDATE SET role = 'operator', is_active = true, display_name = 'ZZFM Operator'`);
  const ops = (await query(`SELECT id, username, role FROM users WHERE username = 'zzfm-ops'`)).rows[0];
  const opsToken = jwt.sign({ sub: ops.id, username: ops.username, role: ops.role }, process.env.JWT_SECRET, { expiresIn: '20m' });
  const call = async (method, p, body, token = adminToken, base = '/api/financial') => {
    const res = await fetch(`http://127.0.0.1:${PORT}${base}${p}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    const ct = res.headers.get('Content-Type') || '';
    if (ct.includes('json')) {
      let json = null; try { json = await res.json(); } catch (_) {}
      return { status: res.status, json, headers: res.headers };
    }
    const b = await res.blob();
    return { status: res.status, json: null, blob: { type: ct, size: b.size }, headers: res.headers };
  };

  try {
    // ═══ Arrangement A/B ═════════════════════════════════════════════════
    let arr = (await query(`SELECT financial_arrangement FROM houses WHERE paybill_number = $1`, [HOUSE])).rows[0];
    check(arr.financial_arrangement === 'A', `1. new property defaults to Arrangement A (got ${arr.financial_arrangement})`);
    const paymentsBefore = await query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float8 AS s FROM payments WHERE tenant_code LIKE 'ZZFM%'`);

    // ═══ Journal foundation ═══════════════════════════════════════════════
    const ok = await journal.postJournal({
      entry_date: `${MONTH}-02`, period: MONTH, memo: 'ZZFM test entry', source_type: 'test', source_id: 'ZZFM-1',
      lines: [{ account_code: '1020', debit: 5000 }, { account_code: '4000', credit: 5000 }],
    });
    check(ok.entry && !ok.error, `2. balanced entry posted (${ok.entry && ok.entry.entry_number})`, ok.error);
    const unbal = await journal.postJournal({
      entry_date: `${MONTH}-02`, period: MONTH, memo: 'ZZFM unbalanced', source_type: 'test', source_id: 'ZZFM-2',
      lines: [{ account_code: '1020', debit: 999 }],
    });
    check(unbal.error === 'Unbalanced entry (debit 999 vs credit 0)', '2b. unbalanced entry rejected pre-insert', unbal);
    // DB-level deferred trigger: a raw single-sided line must fail at commit.
    let triggerBlocked = false;
    try {
      const e = (await query(
        `INSERT INTO journal_entries (entry_number, entry_date, period, memo, source_type, source_id)
         VALUES ('ZZFM-JE-X','${MONTH}-03',$1,'ZZFM raw','test','ZZFM-3') RETURNING id`, [MONTH]
      )).rows[0];
      await query(`INSERT INTO journal_lines (entry_id, account_code, debit, credit) VALUES ($1,'1020',777,0)`, [e.id]);
    } catch (err) { triggerBlocked = /unbalanced/.test(err.message); }
    check(triggerBlocked, '2c. DB trigger blocks single-sided entries');
    const dup = await journal.postJournal({
      entry_date: `${MONTH}-02`, period: MONTH, memo: 'ZZFM dup', source_type: 'test', source_id: 'ZZFM-1',
      lines: [{ account_code: '1020', debit: 5000 }, { account_code: '4000', credit: 5000 }],
    });
    check(dup.existing === true, '2d. idempotent: same source never posts twice');
    const rev = await journal.reverseJournal({ entry_id: ok.entry.id, reason: 'ZZFM correction', actor: 'test' });
    const origAfter = (await query(`SELECT * FROM journal_entries WHERE id = $1`, [ok.entry.id])).rows[0];
    check(rev.reversal && origAfter.status === 'Reversed' && !!origAfter.reversal_reason,
      '2e. reversal keeps the original (marked Reversed) + records a mirrored entry', rev.error || rev.reversal && rev.reversal.entry_number);
    const tb0 = await journal.trialBalance({});
    check(tb0.balanced && Math.abs(tb0.total_debit - tb0.total_credit) < 0.01,
      `2f. trial balance balances (Dr ${tb0.total_debit} = Cr ${tb0.total_credit})`);

    // ═══ Auto-posting hooks ═══════════════════════════════════════════════
    await store.createTenant({
      tenant_code: 'ZZFM-01', name: 'ZZFM Tenant', phone_number: '+254700001801',
      property_name: 'ZZFM House', house_id: HOUSE, rent_amount: 100000, deposit_amount: 5000,
      move_in_date: '2026-09-01', rent_due_date: '2026-12-05', status: 'Active',
    });
    await query(
      `INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, payment_mode, tenancy_id)
       VALUES ('ZZFM-01', 10000, '${MONTH}-05', 'Approved', 'deposit', 'R-FM-DEP', 'MPFMDEP', 'M-Pesa', NULL)`
    );
    const ll = (await query(`INSERT INTO landlords (name, phone) VALUES ('ZZFM Landlord', '+254700001800') RETURNING id`)).rows[0];
    await query(`UPDATE houses SET landlord_id = $1 WHERE paybill_number = $2`, [ll.id, HOUSE]);
    await store.setCommissionRate(HOUSE, 5, 'test');
    await query(
      `INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode, tenancy_id)
       VALUES ('ZZFM-01', 100000, '${MONTH}-05', 'Approved', 'rent', 'R-FM-RENT', 'MPFMRENT', '${MONTH}', 'M-Pesa', NULL)`
    );
    // Separate payment reserved for the reversal test (keeps R-FM-RENT
    // Approved so the collections register still reflects it).
    await query(
      `INSERT INTO payments (tenant_code, amount, payment_date, status, payment_type, receipt_number, mpesa_reference, billing_period, payment_mode, tenancy_id)
       VALUES ('ZZFM-01', 500, '${MONTH}-10', 'Approved', 'rent', 'R-FM-REVR', 'MPFMREVR', '${MONTH}', 'M-Pesa', NULL)`
    );

    // A. Payment approval posting (arrangement A: rent NEVER GEHPM cash)
    const payRow = (await query(`SELECT * FROM payments WHERE receipt_number = 'R-FM-RENT'`)).rows[0];
    const depRow = (await query(`SELECT * FROM payments WHERE receipt_number = 'R-FM-DEP'`)).rows[0];
    const postA = await journal.postPaymentApproval({
      payment: payRow, arrangement: 'A', house_paybill: HOUSE,
      allocation: { depositSettled: 4000, waterSettled: 500, garbageFeeSettled: 0 },
    });
    check(postA.entry && !postA.error, `3. A-arrangement posting ok (${postA.entry && postA.entry.entry_number})`, postA.error);
    const aLines = (await query(`SELECT * FROM journal_lines WHERE entry_id = $1`, [postA.entry.id])).rows;
    const cashDr = aLines.filter((l) => l.account_code === '1010' || l.account_code === '1020').reduce((s, l) => s + Number(l.debit), 0);
    check(cashDr === 4500, `3b. GEHPM cash = deposit+utility ONLY (4,500, rent excluded) (got ${cashDr})`);
    check(!aLines.some((l) => l.account_code === '2100'), '3c. NO landlord payable in Arrangement A (rent not GEHPM money)');
    const postB = await journal.postPaymentApproval({
      payment: { ...payRow, id: 'ZZFM-BTEST', payment_mode: 'M-Pesa' }, arrangement: 'B', house_paybill: HOUSE,
      allocation: { depositSettled: 4000, waterSettled: 500, garbageFeeSettled: 0 },
    });
    const bLines = (await query(`SELECT * FROM journal_lines WHERE entry_id = $1`, [postB.entry.id])).rows;
    check(bLines.some((l) => l.account_code === '2100' && Number(l.credit) > 0),
      `3d. B-arrangement credits landlord payable (rent held) (got ${bLines.find((l) => l.account_code === '2100') && bLines.find((l) => l.account_code === '2100').credit})`);

    // B. Commission invoice earned + commission payment received (Arrangement A)
    const invRes = await commission.generateCommissionInvoice(HOUSE, MONTH, { actor: 'test' });
    check(invRes.invoice && !invRes.error, `4. commission invoice created (${invRes.invoice && invRes.invoice.invoice_number})`, invRes.error);
    const earnEntry = (await query(
      `SELECT * FROM journal_entries WHERE source_type = 'commission_invoice' AND source_id = $1 AND status = 'Posted'`,
      [String(invRes.invoice.id)]
    )).rows[0];
    check(!!earnEntry, '4b. commission EARNED auto-posted (receivable ↔ income)');
    const commPay = await commission.recordCommissionPayment({
      house_paybill_number: HOUSE, landlord_id: ll.id, billing_month: MONTH,
      payment_date: `${MONTH}-20`, amount: 3000, method: 'Bank', reference: 'ZZFM-COMM', actor: 'test',
    });
    check(commPay.payment && !commPay.error, '4c. commission payment recorded');
    const cashEntry = (await query(
      `SELECT * FROM journal_entries WHERE source_type = 'commission_payment' AND source_id = $1 AND status = 'Posted'`,
      [String(commPay.payment.id)]
    )).rows[0];
    check(!!cashEntry, '4d. commission RECEIVED auto-posted (cash ↔ receivable)');

    // C. Deposit refund paid
    const exitF = await store.createExitInvoice('ZZFM-01', { reason: 'test exit' });
    await query(
      `INSERT INTO deposit_refunds (tenant_code, exit_invoice_id, deposit_amount, deposit_paid, refundable_amount, refund_status, refund_due_date)
       VALUES ('ZZFM-01', $1, 5000, 5000, 5000, 'pending', $2)`,
      [exitF.id, `${MONTH}-25`]
    );
    // A separate STILL-PENDING refund for the obligations tracker (the one
    // above gets paid by the reversal test below).
    const exitF2 = await store.createExitInvoice('ZZFM-01', { reason: 'test exit 2' });
    await query(
      `INSERT INTO deposit_refunds (tenant_code, exit_invoice_id, deposit_amount, deposit_paid, refundable_amount, refund_status, refund_due_date)
       VALUES ('ZZFM-01', $1, 3000, 3000, 3000, 'pending', $2)`,
      [exitF2.id, `${MONTH}-27`]
    );
    const refund = (await query(`SELECT * FROM deposit_refunds WHERE tenant_code = 'ZZFM-01' ORDER BY id LIMIT 1`)).rows[0];
    const refunded = await store.recordDepositRefund(refund.id, {
      amount: 5000, paymentMethod: 'M-Pesa', transactionReference: 'ZZFM-REFUND',
      refundDate: `${MONTH}-24`, actor: 'test',
    });
    check(refunded && !refunded.error && refunded.refund_status === 'refunded',
      `5. deposit refund paid (status ${refunded && refunded.refund_status})`);
    const refundEntry = (await query(
      `SELECT * FROM journal_entries WHERE source_type = 'deposit_refund_paid' AND source_id LIKE $1 AND status = 'Posted'`,
      [`${refund.id}:%`]
    )).rows[0];
    check(!!refundEntry, '5b. refund auto-posted (deposit liability ↓, cash ↓ — never an expense)');

    // D. Remittance posting only for Arrangement B
    await query(`UPDATE houses SET financial_arrangement = 'A' WHERE paybill_number = $1`, [HOUSE]);
    const remA = await commission.recordRemittancePayment({
      house_paybill_number: HOUSE, landlord_id: ll.id, billing_month: MONTH,
      payment_date: `${MONTH}-25`, amount: 100, method: 'M-Pesa', reference: 'ZZFM-REMA', actor: 'test',
    });
    const remEntriesA = (await query(
      `SELECT COUNT(*)::int AS n FROM journal_entries WHERE source_type = 'landlord_remittance' AND source_id = $1`,
      [String(remA.payment.id)]
    )).rows[0].n;
    check(remEntriesA === 0, `6. Arrangement A remittance posts NO journal (A holds no rent) (${remEntriesA})`);
    await query(`UPDATE houses SET financial_arrangement = 'B' WHERE paybill_number = $1`, [HOUSE]);
    const remB = await commission.recordRemittancePayment({
      house_paybill_number: HOUSE, landlord_id: ll.id, billing_month: MONTH,
      payment_date: `${MONTH}-26`, amount: 500, method: 'Bank', reference: 'ZZFM-REMB', actor: 'test',
    });
    const remEntriesB = (await query(
      `SELECT COUNT(*)::int AS n FROM journal_entries WHERE source_type = 'landlord_remittance' AND source_id = $1`,
      [String(remB.payment.id)]
    )).rows[0].n;
    check(remEntriesB === 1, `6b. Arrangement B remittance posts (payable ↓, cash ↓) (${remEntriesB})`);
    await query(`UPDATE houses SET financial_arrangement = 'A' WHERE paybill_number = $1`, [HOUSE]);

    // E. False-payment reversal → journal reversal (uses the dedicated
    // reversal fixture so the collections register keeps R-FM-RENT Approved)
    const testPayment = (await query(`SELECT * FROM payments WHERE receipt_number = 'R-FM-REVR'`)).rows[0];
    await journal.postPaymentApproval({ payment: testPayment, arrangement: 'B', house_paybill: HOUSE, allocation: { depositSettled: 500 } });
    const { reverseFalsePayment } = commission;
    const revRes = await reverseFalsePayment(testPayment.id, { actor: 'test', reason: 'ZZFM forged reference', recompute: false });
    check(revRes.payment && revRes.payment.status === 'Reversed', `7. false payment reversed (HTTP-level status ${revRes.payment && revRes.payment.status})`);
    const reversedEntry = (await query(
      `SELECT * FROM journal_entries WHERE source_type = 'payment' AND source_id = $1 AND status = 'Reversed'`,
      [String(testPayment.id)]
    )).rows[0];
    check(!!reversedEntry, '7b. original journal entry marked Reversed (history preserved)');
    const revMirror = (await query(
      `SELECT * FROM journal_entries WHERE source_type LIKE 'payment:REVERSAL%' AND source_id LIKE $1 ORDER BY id DESC LIMIT 1`,
      [`${testPayment.id}:%`]
    )).rows[0];
    check(!!revMirror, '7c. mirrored reversal entry recorded (balanced)');

    // ═══ P1: Obligations Tracker ═════════════════════════════════════════
    await query(`UPDATE houses SET landlord_remittance_day = 1 WHERE paybill_number = $1`, [HOUSE]);
    await query(
      `INSERT INTO salary_records (employee_name, salary_month, expected_salary, previous_balance, total_paid, outstanding, status)
       VALUES ('ZZFM Emp', '2026-09', 20000, 0, 12000, 8000, 'Partially Paid')`
    );
    const obligations = (await call('GET', '/obligations')).json;

    check(obligations && obligations.obligations?.length > 0, `8. obligations tracked (${obligations && obligations.obligations.length})`);
    const bk = (k) => obligations.obligations.filter((o) => o.bucket === k);
    check(bk('owed_to_gehpm').some((o) => o.key.startsWith('commission_invoice:')),
      '8b. unpaid management fee tracked as Owed TO GEHPM');
    check(bk('company_expenses').some((o) => o.key === 'salary:...' || o.title.includes('Unpaid salary — ZZFM Emp')),
      '8c. unpaid salary tracked as Company Expense', bk('company_expenses').map((x) => x.title));
    check(bk('tenant_liabilities').some((o) => o.key.startsWith('deposit_refund:')),
      '8d. pending deposit refund tracked as Tenant Liability');
    check(bk('owed_to_landlords').length >= 0 && obligations.summary && typeof obligations.summary.owed_to_landlords === 'number',
      '8e. landlord bucket + totals present');
    check(obligations.obligations.every((o) => o.link && o.link.kind), '8f. every obligation carries a deep link');
    const overdueRem = bk('owed_to_landlords').find((o) => o.key === `remittance:${HOUSE}`);
    check(overdueRem && overdueRem.due === true && overdueRem.link.kind === 'landlord_ledger',
      '8g. fixture remittance flagged due + links to ledger', overdueRem && { due: overdueRem.due });

    // ═══ P2: Monthly report ══════════════════════════════════════════════
    let rpt = (await call('GET', `/monthly-report?month=${MONTH}`)).json;
    let report = rpt.report;
    check(report && report.month === MONTH, `9. monthly report built (${report && report.month})`);
    check(report.income.commission_earned === Number(invRes.invoice.commission_amount),
      `9b. income section = JOURNALED commission earned (${report.income.commission_earned})`);
    check(report.income.commission_received === 3000, `9c. commission received = 3,000 (got ${report.income.commission_received})`);
    check(report.income.commission_receivable > 0, '9d. receivable (earned − received) tracked separately');
    check(report.opening_balances.configured === false && /NOT CONFIGURED/.test(report.cash.note || ''),
      '9e. opening balances shown NOT CONFIGURED (never fake zero)', report.cash);
    check(Array.isArray(report.properties) && report.properties.some((p) => p.house_paybill === HOUSE && p.arrangement === 'A'),
      '9f. property reconciliation with arrangement flag', report.properties);
    check(Array.isArray(report.discrepancies), '9g. discrepancy section present');
    check(report.trial_balance && report.trial_balance.balanced, '9h. trial balance embedded + balanced');
    // Configure opening balances → closing computed
    const saved = (await call('POST', '/opening-balances', { cash: 50000, mpesa: 20000, bank: 300000, as_of: `${MONTH}-01` })).json;
    check(saved.configured === true && saved.cash === 50000, `9i. opening balances saved (${saved.cash})`);
    report = (await call('GET', `/monthly-report?month=${MONTH}`)).json.report;
    check(report.cash.configured && report.cash.closing && typeof report.cash.closing.cash === 'number',
      '9j. closing computed after configuration', report.cash.closing);
    // PDF + Excel
    const pdf = await call('POST', '/monthly-report/pdf', { month: MONTH });
    check(pdf.status === 200 && pdf.blob && pdf.blob.type.includes('pdf') && pdf.blob.size > 1000,
      `9k. report PDF downloads (${pdf.blob && pdf.blob.size} bytes)`);
    const xls = await call('POST', '/monthly-report/excel', { month: MONTH });
    check(xls.status === 200 && xls.blob && xls.blob.type.includes('spreadsheetml'),
      '9l. report Excel downloads (xlsx, editable)');

    // ═══ P3: Registers ═══════════════════════════════════════════════════
    const coll = (await call('GET', `/register/collections?from=${MONTH}-01&to=${MONTH}-30`)).json;
    check(coll.rows?.some((r) => r.tenant_code === 'ZZFM-01' && r.arrangement === 'A'
      && (r.treatment || '').includes('NOT GEHPM cash')),
      '10. collections register: arrangement A flagged as NOT GEHPM cash', coll.rows && coll.rows[0]);
    const inc = (await call('GET', '/register/income')).json;
    check(inc.earned?.some((r) => r.invoice_number === invRes.invoice.invoice_number),
      '10b. income register lists commission earned (receivable)');
    check(inc.received?.some((r) => r.reference === 'ZZFM-COMM'), '10c. income register lists commission received');
    const newIncome = (await call('POST', '/other-income', {
      income_date: `${MONTH}-10`, category: 'Agreement / documentation fee', amount: 2500,
      received: true, source_client: 'ZZFM Tenant', reference: 'ZZFM-FEE', description: 'Agreement fee',
    })).json;
    check(newIncome.income?.id, '10d. other legitimate income recorded');
    const inc2 = (await call('GET', '/register/income')).json;
    check(inc2.other?.some((r) => r.amount === 2500 && r.received === true), '10e. income register includes other income');
    const exp = (await call('GET', `/register/expenditure?from=${MONTH}-01&to=${MONTH}-30`)).json;
    check(exp.pending?.some((r) => r.employee_name === 'ZZFM Emp' && Number(r.amount) === 8000),
      '10f. expenditure register: outstanding salary (incurred-not-paid)', exp.pending);
    const cashReg = (await call('GET', `/register/cash?from=${MONTH}-01&to=${MONTH}-30`)).json;
    check((cashReg.rows || []).length > 0, `10g. cash register from JOURNAL movements (${cashReg.rows?.length} rows)`);
    const cats = (await call('GET', '/expense-categories')).json;
    check((cats.categories || []).length >= 30, `10h. seeded expense categories (${cats.categories?.length})`);
    const newCat = (await call('POST', '/expense-categories', { name: 'ZZFM Custom', group_name: 'Transport and field' })).json;
    check(newCat.category?.id, '10i. management can add expenditure categories');
    // Trial balance endpoint
    const tb = (await call('GET', '/trial-balance')).json;
    check(tb.balanced === true, `10j. trial balance endpoint balanced (Dr ${tb.total_debit})`);

    // ═══ Access control (§5) ══════════════════════════════════════════════
    const op1 = await call('GET', '/obligations', {}, opsToken);
    check(op1.status === 403, `11. operator blocked from obligations (HTTP ${op1.status})`);
    const op2 = await call('GET', `/monthly-report?month=${MONTH}`, {}, opsToken);
    check(op2.status === 403, `11b. operator blocked from monthly reports (HTTP ${op2.status})`);
    const op3 = await call('GET', '/trial-balance', {}, opsToken);
    check(op3.status === 403, `11c. operator blocked from trial balance (HTTP ${op3.status})`);
    const noAuth = await fetch(`http://127.0.0.1:${PORT}/api/financial/obligations`);
    check(noAuth.status === 401, `11d. unauthenticated blocked (HTTP ${noAuth.status})`);

    // History intact: arrangement switch never rewrote payments
    // fixtures: deposit 10,000 + rent 100,000 + reversal fixture 500
    const paymentsAfter = await query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float8 AS s FROM payments WHERE tenant_code LIKE 'ZZFM%'`);
    check(paymentsAfter.rows[0].n === paymentsBefore.rows[0].n + 3 && paymentsAfter.rows[0].s === paymentsBefore.rows[0].s + 110500,
      `12. arrangement switches never altered payments (${paymentsAfter.rows[0].n} rows / ${paymentsAfter.rows[0].s})`,
      { before: paymentsBefore.rows[0], after: paymentsAfter.rows[0] });

    // ═══ Frontend markers ════════════════════════════════════════════════
    const idx = await (await fetch('http://127.0.0.1:3003/')).text();
    check(idx.includes('id="nav-financial"') && idx.includes('data-view="financial-management"')
      && idx.includes('id="fin-shortcut"') && idx.includes('id="fin-ob-tbody"'),
      '13. financial nav + view + dashboard shortcut served');
    const appJs = await (await fetch('http://127.0.0.1:3003/js/app.js')).text();
    check(appJs.includes('loadFinancialView') && appJs.includes('finObligations')
      && appJs.includes('loadArrangements') && appJs.includes('downloadFinancial'),
      '13b. financial view logic served');

    console.log('\n(operators blocked; existing workflows untouched)');
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
