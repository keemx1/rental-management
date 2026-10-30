'use strict';

/**
 * Consolidated monthly financial report (Phase 1 · Priority 2).
 * Sections A-F of the proposal — computed from the SAME underlying records
 * (journals + registers + existing modules). Never invents figures:
 * opening balances show "NOT CONFIGURED" until management enters them.
 */

const { query } = require('../config/database');
const journal = require('./journal');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

async function getOpeningBalances() {
  const row = (await query(`SELECT value FROM app_config WHERE key = 'financial_opening_balances'`)).rows[0];
  if (!row) return { configured: false };
  try {
    const v = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    if (!v || !v.as_of) return { configured: false };
    return { configured: true, cash: Number(v.cash || 0), mpesa: Number(v.mpesa || 0), bank: Number(v.bank || 0), as_of: v.as_of };
  } catch (_) {
    return { configured: false };
  }
}

async function saveOpeningBalances({ cash, mpesa, bank, as_of, actor }) {
  if (!as_of) return { error: 'as_of (effective date) is required', code: 'VALIDATION' };
  const value = JSON.stringify({
    cash: Number(cash || 0), mpesa: Number(mpesa || 0), bank: Number(bank || 0), as_of: String(as_of).slice(0, 10),
  });
  await query(
    `INSERT INTO app_config (key, value) VALUES ('financial_opening_balances', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [value]
  );
  const store = require('../storage/store');
  await store.logAudit({
    actor: actor || 'system', action: 'opening_balances_configured',
    entityType: 'app_config', entityId: 'financial_opening_balances',
    details: { cash, mpesa, bank, as_of },
  }).catch(() => {});
  return getOpeningBalances();
}

function monthBounds(month) {
  const [y, m] = String(month).split('-').map(Number);
  const start = `${month}-01`;
  const end = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  return { start, end, prev: m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}` };
}

async function monthlyReport(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) {
    return { error: 'month must be YYYY-MM', code: 'VALIDATION' };
  }
  const { start, end, prev } = monthBounds(month);
  const opening = await getOpeningBalances();

  // ── A. Income (from posted journals + commission module) ───────────────
  const incomeRows = (await query(
    `SELECT a.code, a.name, SUM(l.credit)::float8 AS earned
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'Posted'
       JOIN chart_of_accounts a ON a.code = l.account_code
      WHERE a.type = 'income' AND e.entry_date BETWEEN $1 AND $2
      GROUP BY a.code, a.name ORDER BY a.code`,
    [start, end]
  )).rows;
  const commissionEarned = round2(incomeRows.find((r) => r.code === '4000')?.earned || 0);
  const otherIncomeEarned = round2(incomeRows.filter((r) => r.code !== '4000').reduce((s, r) => s + Number(r.earned), 0));
  const commissionReceived = round2((await query(
    `SELECT COALESCE(SUM(amount),0)::float8 AS n FROM commission_payments
      WHERE payment_date BETWEEN $1 AND $2`, [start, end]
  )).rows[0].n);
  const commissionReceivable = round2((await query(
    `SELECT COALESCE(SUM(total_payable),0)::float8 AS n FROM commission_invoices
      WHERE status = 'Issued' AND total_payable > 0`
  )).rows[0].n);
  const otherIncomeReceived = round2((await query(
    `SELECT COALESCE(SUM(amount),0)::float8 AS n FROM other_income
      WHERE received = TRUE AND income_date BETWEEN $1 AND $2`, [start, end]
  )).rows[0].n);

  // ── B. Expenditure (incurred vs paid) ──────────────────────────────────
  const expenseIncurred = (await query(
    `SELECT a.code, a.name, SUM(l.debit)::float8 AS incurred
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'Posted'
       JOIN chart_of_accounts a ON a.code = l.account_code
      WHERE a.type = 'expense' AND e.entry_date BETWEEN $1 AND $2
      GROUP BY a.code, a.name ORDER BY a.code`,
    [start, end]
  )).rows.map((r) => ({ code: r.code, name: r.name, incurred: round2(r.incurred) }));
  const expensePaid = round2((await query(
    `SELECT COALESCE(SUM(l.credit),0)::float8 AS n
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'Posted'
      WHERE l.account_code IN ('1010','1020','1030') AND e.entry_date BETWEEN $1 AND $2
        AND EXISTS (SELECT 1 FROM journal_lines lx JOIN chart_of_accounts ax ON ax.code = lx.account_code
                     WHERE lx.entry_id = e.id AND ax.type = 'expense')`,
    [start, end]
  )).rows[0].n);
  const salariesPaid = round2((await query(
    `SELECT COALESCE(SUM(amount),0)::float8 AS n FROM salary_payments WHERE payment_date BETWEEN $1 AND $2`,
    [start, end]
  )).rows[0].n);

  // ── C. Cash position (journal movements + configured opening) ──────────
  const cashRows = (await query(
    `SELECT l.account_code, SUM(l.debit)::float8 AS dr, SUM(l.credit)::float8 AS cr
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'Posted'
      WHERE l.account_code IN ('1010','1020','1030') AND e.entry_date BETWEEN $1 AND $2
      GROUP BY l.account_code`, [start, end]
  )).rows;
  const cashMove = (code) => {
    const r = cashRows.find((x) => x.account_code === code);
    return round2((r ? Number(r.dr) - Number(r.cr) : 0));
  };
  const movements = { cash: cashMove('1010'), mpesa: cashMove('1020'), bank: cashMove('1030') };
  const movementTotal = round2(movements.cash + movements.mpesa + movements.bank);

  // ── D. Property & landlord reconciliation ──────────────────────────────
  const houses = (await query(
    `SELECT paybill_number, house_name, financial_arrangement FROM houses ORDER BY house_name`
  )).rows;
  const propertyRows = [];
  for (const h of houses) {
    const collected = round2((await query(
      `SELECT COALESCE(SUM(p.amount),0)::float8 AS n
         FROM payments p JOIN tenants t ON t.tenant_code = p.tenant_code
        WHERE t.house_paybill_number = $1 AND p.status = 'Approved'
          AND p.payment_date BETWEEN $2 AND $3`,
      [h.paybill_number, start, end]
    )).rows[0].n);
    if (!collected) continue;
    let commissionEarnedP = 0, commissionReceivedP = 0, commissionOutstandingP = 0;
    try {
      const earned = (await query(
        `SELECT COALESCE(SUM(commission_amount),0)::float8 AS n FROM commission_invoices
          WHERE house_paybill_number = $1 AND billing_month = $2 AND status = 'Issued'`,
        [h.paybill_number, month]
      )).rows[0].n;
      const received = (await query(
        `SELECT COALESCE(SUM(cp.amount),0)::float8 AS n FROM commission_payments cp
          JOIN landlords l ON l.id = cp.landlord_id
         WHERE cp.house_paybill_number = $1 AND cp.payment_date BETWEEN $2 AND $3`,
        [h.paybill_number, start, end]
      )).rows[0].n;
      const outstanding = (await query(
        `SELECT COALESCE(SUM(total_payable),0)::float8 AS n FROM commission_invoices
          WHERE house_paybill_number = $1 AND status = 'Issued'`,
        [h.paybill_number]
      )).rows[0].n;
      commissionEarnedP = round2(earned); commissionReceivedP = round2(received); commissionOutstandingP = round2(outstanding);
    } catch (_) {}
    propertyRows.push({
      house_paybill: h.paybill_number, house_name: h.house_name,
      arrangement: h.financial_arrangement || 'A',
      collected, // A: direct-to-landlord (memo, NOT GEHPM cash) / B: received
      commission_earned: commissionEarnedP,
      commission_received: commissionReceivedP,
      commission_outstanding: commissionOutstandingP,
    });
  }
  const landlordRemitted = round2((await query(
    `SELECT COALESCE(SUM(amount),0)::float8 AS n FROM landlord_remittance_payments
      WHERE payment_date BETWEEN $1 AND $2`, [start, end]
  )).rows[0].n);

  // ── E. Tenant & payment reconciliation ─────────────────────────────────
  const tenantRec = (await query(
    `SELECT
       COALESCE(SUM(CASE WHEN COALESCE(status,'') <> 'Vacant' THEN arrears ELSE 0 END),0)::float8 AS arrears,
       COALESCE(SUM(CASE WHEN COALESCE(status,'') <> 'Vacant' THEN credit_balance ELSE 0 END),0)::float8 AS credits,
       COALESCE(SUM(deposit_paid),0)::float8 AS deposits
     FROM tenants`
  )).rows[0];
  const unallocated = (await query(
    `SELECT COALESCE(SUM(amount),0)::float8 AS n FROM payments WHERE status = 'Pending'`
  )).rows[0].n;
  const refundsDue = round2((await query(
    `SELECT COALESCE(SUM(refundable_amount - COALESCE(amount_refunded,0)),0)::float8 AS n
       FROM deposit_refunds WHERE refund_status IN ('pending','due_soon','due_today','overdue')`
  )).rows[0].n);

  // ── F. Discrepancies (live flags, never altered) ───────────────────────
  const discrepancies = [];
  try {
    const noRef = (await query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE status = 'Approved'
        AND COALESCE(mpesa_reference,'') = '' AND COALESCE(receipt_number,'') = ''`
    )).rows[0].n;
    if (noRef) discrepancies.push({ type: 'missing_references', count: noRef, message: `${noRef} approved payment(s) with no reference or receipt` });
    const noDoc = (await query(
      `SELECT COUNT(*)::int AS n FROM payments p
        WHERE p.status = 'Approved' AND p.payment_date BETWEEN $1 AND $2
          AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.payment_id = p.id AND d.doc_type = 'receipt')`,
      [start, end]
    )).rows[0].n;
    if (noDoc) discrepancies.push({ type: 'missing_documents', count: noDoc, message: `${noDoc} payment(s) this month without a receipt document` });
    const reviews = (await query(`SELECT COUNT(*)::int AS n FROM landlord_reviews WHERE status = 'Under Review'`)).rows[0].n;
    if (reviews) discrepancies.push({ type: 'open_reviews', count: reviews, message: `${reviews} financial review(s) unresolved` });
    const pendingVerif = round2((await query(
      `SELECT COALESCE(SUM(amount),0)::float8 AS n FROM landlord_remittance_payments WHERE status = 'Pending Verification'`
    )).rows[0].n);
    if (pendingVerif > 0) discrepancies.push({ type: 'pending_verification', count: 1, message: `KES ${pendingVerif.toLocaleString()} of landlord transfers await verification` });
    const tb = await journal.trialBalance({});
    if (!tb.balanced) discrepancies.push({ type: 'unbalanced_ledger', count: 1, message: 'Journal is unbalanced — investigate immediately' });
  } catch (_) {}

  const tb = await journal.trialBalance({ from: start, to: end }).catch(() => null);

  return {
    month, generated_at: new Date().toISOString(),
    opening_balances: opening,
    income: {
      commission_earned: commissionEarned,
      other_income_earned: otherIncomeEarned,
      total_earned: round2(commissionEarned + otherIncomeEarned),
      commission_received: commissionReceived,
      other_income_received: otherIncomeReceived,
      total_received: round2(commissionReceived + otherIncomeReceived),
      commission_receivable: commissionReceivable,
      rows: incomeRows.map((r) => ({ code: r.code, name: r.name, earned: round2(r.earned) })),
    },
    expenditure: {
      incurred_total: round2(expenseIncurred.reduce((s, r) => s + r.incurred, 0)),
      paid_total: expensePaid,
      salaries_paid: salariesPaid,
      rows: expenseIncurred,
    },
    cash: {
      configured: opening.configured,
      opening: opening.configured ? { cash: opening.cash, mpesa: opening.mpesa, bank: opening.bank, as_of: opening.as_of } : null,
      movements,
      movement_total: movementTotal,
      closing: opening.configured
        ? { cash: round2(opening.cash + movements.cash), mpesa: round2(opening.mpesa + movements.mpesa), bank: round2(opening.bank + movements.bank) }
        : null,
      note: opening.configured ? null : 'Opening balances NOT CONFIGURED — closing balances cannot be verified until management enters them.',
    },
    properties: propertyRows,
    landlord_remitted: landlordRemitted,
    tenants: {
      arrears: round2(tenantRec.arrears),
      credits: round2(tenantRec.credits),
      deposit_liabilities: round2(tenantRec.deposits),
      unallocated_payments: round2(unallocated),
      refunds_due: refundsDue,
    },
    discrepancies,
    trial_balance: tb ? { total_debit: tb.total_debit, total_credit: tb.total_credit, balanced: tb.balanced } : null,
  };
}

module.exports = { monthlyReport, getOpeningBalances, saveOpeningBalances, monthBounds };
