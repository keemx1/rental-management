'use strict';

/**
 * Double-entry journal engine (Phase 1 foundation).
 *
 * - every approved transaction posts balanced debit/credit lines (balance
 *   enforced by a deferred DB trigger as the final guard)
 * - ONE posted entry per (source_type, source_id) => auto-posting idempotent
 * - corrections are REVERSALS: the original entry is kept, marked Reversed,
 *   and a mirrored reversal entry is recorded (never delete history)
 * - failures in posting NEVER break the host workflow; they surface via the
 *   caller's log + the monthly reconciliation flags missing postings
 */

const { query } = require('../config/database');

const CASH_BY_METHOD = (m) => {
  const v = String(m || '').toLowerCase();
  if (v.includes('bank')) return '1030';
  if (v.includes('cash')) return '1010';
  return '1020'; // M-Pesa / Pesa Link / default
};

// pg DATE columns arrive as local Date objects — normalise to YYYY-MM-DD.
const localDate = (v) => (v instanceof Date && !isNaN(v))
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : String(v || '').slice(0, 10);

async function entryNumber(run) {
  const exec = run || query;
  const res = await exec(
    `UPDATE invoice_counters SET next_number = next_number + 1 WHERE prefix = 'GEHPM-JE' RETURNING next_number - 1 AS num`
  ).catch(() => ({ rows: [] }));
  let num;
  if (!res.rows || !res.rows.length) {
    await (run || query)(
      `INSERT INTO invoice_counters (prefix, next_number) VALUES ('GEHPM-JE', 2)
       ON CONFLICT (prefix) DO UPDATE SET next_number = invoice_counters.next_number + 1 RETURNING 1 AS num`
    ).catch(() => {});
    num = 1;
  } else {
    num = res.rows[0].num;
  }
  return `GEHPM-JE-${String(num).padStart(6, '0')}`;
}

function normalizeLines(lines) {
  return (lines || [])
    .map((l) => ({
      account_code: l.account_code || l.code,
      debit: Math.round(Number(l.debit || 0) * 100) / 100,
      credit: Math.round(Number(l.credit || 0) * 100) / 100,
      house_paybill: l.house_paybill || null,
      tenant_code: l.tenant_code || null,
      memo: l.memo || null,
    }))
    .filter((l) => l.account_code && (l.debit > 0 || l.credit > 0));
}

/**
 * Post a journal entry inside ONE transaction (the deferred balance trigger
 * evaluates at COMMIT with all lines present). Idempotent per
 * (source_type, source_id): a repeat call returns { existing: true }.
 */
async function postJournal({ entry_date, period, memo, source_type, source_id, lines, actor }) {
  const norm = normalizeLines(lines);
  if (!norm.length) return { error: 'Journal entry has no lines', code: 'VALIDATION' };
  const debit = norm.reduce((s, l) => s + l.debit, 0);
  const credit = norm.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(debit - credit) > 0.009 || debit === 0) {
    return { error: `Unbalanced entry (debit ${debit} vs credit ${credit})`, code: 'UNBALANCED' };
  }
  const date = entry_date ? String(entry_date).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const per = period || date.slice(0, 7);

  const { pool } = require('../config/database');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exec = (sql, p) => client.query(sql, p);
    const num = await entryNumber(exec);
    const entry = (await client.query(
      `INSERT INTO journal_entries (entry_number, entry_date, period, memo, source_type, source_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [num, date, per, memo || null, source_type, String(source_id), actor || null]
    )).rows[0];
    for (const l of norm) {
      await client.query(
        `INSERT INTO journal_lines (entry_id, account_code, debit, credit, house_paybill, tenant_code, memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [entry.id, l.account_code, l.debit, l.credit, l.house_paybill, l.tenant_code, l.memo]
      );
    }
    await client.query('COMMIT');
    return { entry, lines: norm };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (err && err.code === '23505') {
      const existing = (await query(
        `SELECT * FROM journal_entries WHERE source_type = $1 AND source_id = $2 AND status = 'Posted'`,
        [source_type, String(source_id)]
      )).rows[0];
      return { entry: existing || null, existing: true };
    }
    return { error: err.message, code: 'JOURNAL_FAILED' };
  } finally {
    client.release();
  }
}

/** Reversal entry: original kept (marked Reversed), mirrored lines recorded. */
async function reverseJournal({ entry_id, source_type, source_id, reason, actor, entry_date }) {
  if (!reason || !String(reason).trim()) return { error: 'A reversal reason is required', code: 'VALIDATION' };
  const original = (await query(
    `SELECT * FROM journal_entries WHERE id = $1 AND status = 'Posted'`,
    [Number(entry_id)]
  )).rows[0];
  if (!original) return { error: 'Posted journal entry not found', code: 'NOT_FOUND' };
  const origLines = (await query(`SELECT * FROM journal_lines WHERE entry_id = $1`, [original.id])).rows;
  const mirrored = origLines.map((l) => ({
    account_code: l.account_code,
    debit: Number(l.credit), credit: Number(l.debit),
    house_paybill: l.house_paybill, tenant_code: l.tenant_code,
    memo: `Reversal of entry ${original.entry_number}: ${String(reason).trim()}`,
  }));
  const res = await postJournal({
    entry_date: entry_date || new Date().toISOString().slice(0, 10),
    period: original.period,
    memo: `REVERSAL of ${original.entry_number}: ${String(reason).trim()}`,
    source_type: `${original.source_type}:REVERSAL`,
    source_id: `${original.source_id}:${Date.now()}`,
    lines: mirrored,
    actor,
  });
  if (res.error) return res;
  await query(
    `UPDATE journal_entries SET status = 'Reversed', reversed_by = $1, reversal_reason = $2 WHERE id = $3 AND status = 'Posted'`,
    [actor || null, String(reason).trim(), original.id]
  );
  return { original, reversal: res.entry };
}

/** Trial balance over a period (or all time when omitted). */
async function trialBalance({ from, to } = {}) {
  const rows = (await query(
    `SELECT a.code, a.name, a.type,
            COALESCE(SUM(l.debit),0)::float8 AS debit,
            COALESCE(SUM(l.credit),0)::float8 AS credit
       FROM chart_of_accounts a
       LEFT JOIN journal_lines l ON l.account_code = a.code
       LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'Posted'
      WHERE ($1::date IS NULL OR e.entry_date >= $1)
        AND ($2::date IS NULL OR e.entry_date <= $2)
      GROUP BY a.code, a.name, a.type
      HAVING COALESCE(SUM(l.debit),0) <> 0 OR COALESCE(SUM(l.credit),0) <> 0
      ORDER BY a.code`,
    [from || null, to || null]
  )).rows;
  const totalDebit = rows.reduce((s, r) => s + Number(r.debit), 0);
  const totalCredit = rows.reduce((s, r) => s + Number(r.credit), 0);
  return { rows, total_debit: Math.round(totalDebit * 100) / 100, total_credit: Math.round(totalCredit * 100) / 100, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
}

/** Entry that failed to post — reconciliation surface. */
async function missingPostings(sources) {
  const out = [];
  for (const s of sources) {
    const r = (await query(
      `SELECT 1 FROM journal_entries WHERE source_type = $1 AND source_id = $2 AND status = 'Posted'`,
      [s.source_type, String(s.source_id)]
    )).rows[0];
    if (!r) out.push(s);
  }
  return out;
}

/**
 * Payment approval posting (proposal §4/§27):
 *  Arrangement A — rent + overpayment are the LANDLORD's money (paid direct
 *    to the landlord) → NEVER posted as GEHPM cash/income; only the
 *    deposit / utility portions (GEHPM-held money) post to cash + liabilities.
 *  Arrangement B — GEHPM receives everything: cash up, deposit liability,
 *    utility income and landlord payable (rent incl. overpayment).
 */
async function postPaymentApproval({ payment, allocation, arrangement, house_paybill }) {
  const amt = Number(payment?.amount || 0);
  if (!(amt > 0)) return { skipped: 'no amount' };
  const depositSettled = Number(allocation?.depositSettled || 0);
  const waterSettled = Number(allocation?.waterSettled || 0);
  const garbageSettled = Number(allocation?.garbageFeeSettled || 0);
  const rentHeld = Math.round((amt - depositSettled - waterSettled - garbageSettled) * 100) / 100;
  const cash = CASH_BY_METHOD(payment.payment_mode);
  const lines = [];
  if (arrangement === 'B') {
    if (amt > 0) lines.push({ account_code: cash, debit: amt, house_paybill, memo: 'Rent received by GEHPM' });
    if (depositSettled > 0) lines.push({ account_code: '2000', credit: depositSettled, memo: 'Tenant deposit liability' });
    if (waterSettled > 0) lines.push({ account_code: '4020', credit: waterSettled, memo: 'Water charges' });
    if (garbageSettled > 0) lines.push({ account_code: '4020', credit: garbageSettled, memo: 'Garbage charges' });
    if (rentHeld > 0) lines.push({ account_code: '2100', credit: rentHeld, house_paybill, memo: 'Landlord payable (rent held by GEHPM)' });
  } else {
    // Arrangement A: only GEHPM-held components are cash; rent/overpayment
    // stays a memo (never GEHPM income or cash).
    const gehpmCash = Math.round((depositSettled + waterSettled + garbageSettled) * 100) / 100;
    if (gehpmCash > 0) {
      lines.push({ account_code: cash, debit: gehpmCash, memo: 'Deposit/utility received by GEHPM' });
      if (depositSettled > 0) lines.push({ account_code: '2000', credit: depositSettled, memo: 'Tenant deposit liability' });
      if (waterSettled > 0) lines.push({ account_code: '4020', credit: waterSettled, memo: 'Water charges' });
      if (garbageSettled > 0) lines.push({ account_code: '4020', credit: garbageSettled, memo: 'Garbage charges' });
    }
  }
  if (!lines.length) return { skipped: 'arrangement A rent-only payment (memo only — no GEHPM cash movement)' };
  const pDate = localDate(payment.payment_date);
  return postJournal({
    entry_date: pDate,
    period: pDate.slice(0, 7),
    memo: `Payment ${payment.receipt_number || payment.id} (${arrangement === 'B' ? 'received by GEHPM' : 'direct-to-landlord components'})`,
    source_type: 'payment',
    source_id: String(payment.id),
    lines,
  });
}

module.exports = { postJournal, reverseJournal, trialBalance, missingPostings, CASH_BY_METHOD, normalizeLines, postPaymentApproval };
