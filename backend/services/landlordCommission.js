'use strict';

/**
 * Landlord Commission Management — per-property financial accounts.
 *
 * ONE landlord -> MANY properties; each property's commission ledger is
 * fully independent (a payment for Property A never touches Property B).
 *
 * Ledger model (carry-forward like the tenant financial ledger):
 *   balance_before(month) = Σ Issued invoices (billing_month < month)
 *                           − Σ payments (payment_date < month start)
 *   commission(month)     = commissionable rent collected × rate%
 *   payments_in(month)    = payments dated within the month
 *   invoice.total_payable = balance_before + commission − payments_in
 *   running balance       = Σ all commissions − Σ all payments (statement)
 * Outstanding never needs a manual opening balance — it carries forward.
 */

const store = require('../storage/store');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const monthStart = (m) => `${m}-01`;
const monthEndExclusive = (m) => {
  const [y, mo] = String(m).split('-').map(Number);
  return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
};

// Same commission base rule as the existing monthly commission report:
// receipts for the property's month, minus settled deposit/garbage/water.
async function rentCollectedForMonth(housePaybill, month) {
  const { query } = require('../config/database');
  const res = await query(
    `SELECT p.amount, p.payment_type, p.allocation_breakdown
       FROM payments p
       JOIN tenants t ON t.tenant_code = p.tenant_code
      WHERE p.status = 'Approved' AND p.billing_period = $1 AND t.house_paybill_number = $2
      ORDER BY p.approved_at`,
    [month, housePaybill]
  );
  let collected = 0;
  let nonRent = 0;
  for (const p of res.rows) {
    const amount = Number(p.amount || 0);
    collected += amount;
    if (p.payment_type === 'deposit') {
      nonRent += amount;
      continue;
    }
    let alloc = null;
    try { alloc = typeof p.allocation_breakdown === 'string' ? JSON.parse(p.allocation_breakdown) : p.allocation_breakdown; } catch (_) { alloc = null; }
    if (alloc) {
      nonRent += Number(alloc.depositSettled || 0) + Number(alloc.garbageFeeSettled || 0) + Number(alloc.waterSettled || 0);
    }
  }
  return { collected: round2(collected), commissionable: round2(Math.max(0, collected - nonRent)) };
}

async function rateForHouse(housePaybill) {
  const rates = await store.getCommissionRates();
  return Number(rates[housePaybill] || 0);
}

// Historical rate for a billing month: prefer the rate SNAPPED on that
// month's (or the latest prior) commission invoice so changing the current
// agreement never silently rewrites historical accounts.
async function rateForMonth(housePaybill, month) {
  const { query } = require('../config/database');
  const inv = (await query(
    `SELECT commission_rate FROM commission_invoices
      WHERE house_paybill_number = $1 AND status = 'Issued' AND billing_month <= $2
      ORDER BY billing_month DESC LIMIT 1`,
    [housePaybill, month]
  )).rows[0];
  if (inv) return Number(inv.commission_rate || 0);
  return rateForHouse(housePaybill);
}

function clampDay(day, y, mo) {
  const d = Number(day);
  if (!(d >= 1 && d <= 31)) return null;
  return Math.min(d, new Date(y, mo, 0).getDate());
}

// Agreed terms: per-property override wins, else landlord default.
function effectiveRemittanceDay(house, landlord) {
  return (house && house.landlord_remittance_day) || (landlord && landlord.default_remittance_day) || null;
}
function effectiveMfiDueDay(house, landlord) {
  return (house && house.landlord_mfi_due_day) || (landlord && landlord.default_mfi_due_day) || null;
}

// Management-fee invoice due date: agreed day of the month FOLLOWING the
// billing month (fee earned in month M, invoiced, due in M+1).
function mfiDueDate(billingMonth, dueDay) {
  const [y, m] = String(billingMonth || '').split('-').map(Number);
  if (!y || !m || !dueDay) return null;
  let dy = m + 1; let yy = y;
  if (dy > 12) { dy = 1; yy += 1; }
  const day = clampDay(dueDay, yy, dy);
  if (!day) return null;
  return `${yy}-${String(dy).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function isLedgerFinalized(housePaybill, month) {
  const { query } = require('../config/database');
  const r = (await query(
    `SELECT id FROM landlord_ledger_finalizations
      WHERE house_paybill_number = $1 AND billing_month = $2 AND status = 'Finalized'`,
    [housePaybill, month]
  )).rows[0];
  return r ? r.id : null;
}

// Reconciliation: compares the ledger's figures against the underlying
// records. NEVER changes anything — only flags discrepancies for review.
async function reconciliation(housePaybill, month) {
  const { query } = require('../config/database');
  const house = await store.getHouse(housePaybill);
  const { commissionable } = await rentCollectedForMonth(housePaybill, month);
  const rate = await rateForMonth(housePaybill, month);
  const invoice = (await query(
    `SELECT * FROM commission_invoices WHERE house_paybill_number = $1 AND billing_month = $2 AND status = 'Issued'`,
    [housePaybill, month]
  )).rows[0] || null;
  const pending = (await query(
    `SELECT id, amount, payment_date::text AS payment_date, reference FROM landlord_remittance_payments
      WHERE house_paybill_number = $1 AND billing_month = $2 AND status = 'Pending Verification'`,
    [housePaybill, month]
  )).rows;
  const openReviews = (await query(
    `SELECT * FROM landlord_reviews WHERE house_paybill_number = $1 AND status = 'Under Review'
       AND (billing_month = $2 OR billing_month IS NULL)`,
    [housePaybill, month]
  )).rows;

  const items = [];
  if (invoice) {
    const rentDiff = Math.round((Number(invoice.rent_collected) - commissionable) * 100) / 100;
    if (rentDiff !== 0) {
      items.push({
        type: 'rent_mismatch', severity: 'blocker',
        message: `Invoice rent collected ${rentDiff > 0 ? 'exceeds' : 'is below'} verified tenant payments`,
        invoice_value: Number(invoice.rent_collected), verified_value: commissionable, difference: rentDiff,
      });
    }
    const expectedCommission = Math.round((commissionable * Number(invoice.commission_rate || rate)) / 100 * 100) / 100;
    const commDiff = Math.round((Number(invoice.commission_amount) - expectedCommission) * 100) / 100;
    if (commDiff !== 0) {
      items.push({
        type: 'commission_mismatch', severity: 'blocker',
        message: `Commission on invoice differs from ${invoice.commission_rate}% of verified collections`,
        invoice_value: Number(invoice.commission_amount), verified_value: expectedCommission, difference: commDiff,
      });
    }
  } else if (commissionable > 0) {
    items.push({ type: 'invoice_missing', severity: 'info', message: 'Collections exist but no management-fee invoice generated yet', verified_value: commissionable });
  }
  if (pending.length) {
    items.push({ type: 'pending_verification', severity: 'info', message: `${pending.length} transfer(s) awaiting verification`, transfers: pending });
  }
  for (const rev of openReviews) {
    items.push({ type: 'open_review', severity: 'blocker', review_id: rev.id, message: `Under review: ${rev.reason}` });
  }

  const finalizedId = await isLedgerFinalized(housePaybill, month);
  return {
    house_paybill_number: housePaybill,
    billing_month: month,
    status: items.some((i) => i.severity === 'blocker') ? 'review' : 'ok',
    finalized: !!finalizedId,
    items,
  };
}

async function finalizeLedger(housePaybill, month, actor) {
  const { query } = require('../config/database');
  const rec = await reconciliation(housePaybill, month);
  if (rec.status !== 'ok') {
    return { error: 'Reconciliation must pass before finalizing this month.', code: 'RECONCILIATION', reconciliation: rec };
  }
  const existing = await isLedgerFinalized(housePaybill, month);
  if (existing) return { finalized_id: existing, already: true };
  const row = (await query(
    `INSERT INTO landlord_ledger_finalizations (house_paybill_number, billing_month, finalized_by)
     VALUES ($1,$2,$3) RETURNING *`,
    [housePaybill, month, actor || null]
  )).rows[0];
  return { finalization: row, reconciliation: rec };
}

async function reopenLedger(housePaybill, month, actor) {
  const { query } = require('../config/database');
  // Delete the finalization row (the unique partial index only covers
  // Finalized rows, so removal cleanly allows a later re-finalization).
  const result = await query(
    `DELETE FROM landlord_ledger_finalizations
      WHERE house_paybill_number = $1 AND billing_month = $2 AND status = 'Finalized'`,
    [housePaybill, month]
  );
  return { reopened: result.rowCount > 0, actor: actor || null };
}

async function flagReview({ house_paybill_number, billing_month, target_type, target_id, reason, evidence_note, actor }) {
  const { query } = require('../config/database');
  if (!reason || !String(reason).trim()) return { error: 'reason is required', code: 'VALIDATION' };
  const row = (await query(
    `INSERT INTO landlord_reviews (house_paybill_number, billing_month, target_type, target_id, reason, evidence_note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [house_paybill_number, billing_month || null, target_type || 'ledger', target_id || null,
      String(reason).trim(), evidence_note || null, actor || null]
  )).rows[0];
  return { review: row };
}

async function resolveReview(reviewId, actor) {
  const { query } = require('../config/database');
  const row = (await query(
    `UPDATE landlord_reviews SET status = 'Resolved', resolved_by = $1, resolved_at = NOW()
      WHERE id = $2 AND status = 'Under Review' RETURNING *`,
    [actor || null, Number(reviewId)]
  )).rows[0];
  if (!row) return { error: 'Review not found or already resolved', code: 'NOT_FOUND' };
  return { review: row };
}

async function verifyRemittancePayment(paymentId, actor) {
  const { query } = require('../config/database');
  const row = (await query(
    `UPDATE landlord_remittance_payments
        SET status = 'Verified', verified_by = $1, verified_at = NOW(),
            authorized_by = COALESCE(authorized_by, $1)
      WHERE id = $2 AND status = 'Pending Verification'
      RETURNING *`,
    [actor || null, Number(paymentId)]
  )).rows[0];
  if (!row) {
    const existing = (await query(`SELECT * FROM landlord_remittance_payments WHERE id = $1`, [Number(paymentId)])).rows[0];
    if (existing && existing.status === 'Verified') return { payment: existing, already: true };
    return { error: 'Transfer not found', code: 'NOT_FOUND' };
  }
  return { payment: row };
}

// Reverse a FALSE tenant payment confirmation: excluded from all financial
// calculations (status no longer 'Approved'), original row + audit retained.
async function reverseFalsePayment(paymentId, { actor, reason, recompute = true } = {}) {
  const { query } = require('../config/database');
  if (!reason || !String(reason).trim()) return { error: 'reason is required', code: 'VALIDATION' };
  const p = (await query(`SELECT * FROM payments WHERE id = $1`, [Number(paymentId)])).rows[0];
  if (!p) return { error: 'Payment not found', code: 'NOT_FOUND' };
  if (String(p.status) === 'Reversed') return { payment: p, already: true };
  if (String(p.status) !== 'Approved') return { error: `Only Approved payments can be reversed (status: ${p.status})`, code: 'VALIDATION' };
  const upd = (await query(
    `UPDATE payments SET status = 'Reversed', notes = COALESCE(notes || ' | ', '') || $1 WHERE id = $2 RETURNING *`,
    [`[REVERSED as false by ${actor || 'system'}: ${String(reason).trim()}]`, Number(paymentId)]
  )).rows[0];
  await query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, details)
     VALUES ($1, 'payment_reversed_false', 'payments', $2, $3)`,
    [actor || 'system', String(paymentId), JSON.stringify({
      reason: String(reason).trim(),
      original: {
        tenant_code: p.tenant_code, amount: Number(p.amount), payment_date: p.payment_date,
        receipt_number: p.receipt_number, mpesa_reference: p.mpesa_reference, status: p.status,
      },
    })]
  );
  let tenantRepaired = false;
  if (recompute && p.tenant_code) {
    try {
      await store.syncHistoricalPayments();
      tenantRepaired = true;
    } catch (e) {
      console.error('[Landlord] historical recompute after reversal failed:', e.message);
    }
  }
  return { payment: upd, tenant_repaired: tenantRepaired };
}

// Main-dashboard totals: the two obligations kept separate + overdue +
// pending reviews (never combined into one number).
async function landlordAccountTotals() {
  const { query } = require('../config/database');
  const houses = (await query(
    `SELECT h.paybill_number, h.landlord_id, h.landlord_remittance_day, h.landlord_mfi_due_day,
            l.default_remittance_day, l.default_mfi_due_day
       FROM houses h JOIN landlords l ON l.id = h.landlord_id`
  )).rows;
  const today = new Date().toISOString().slice(0, 10);
  let mfiPayable = 0;
  let remittancesPayable = 0;
  let overdueRemCount = 0;
  let overdueRemAmount = 0;
  let overdueMfiCount = 0;
  let overdueMfiAmount = 0;
  for (const h of houses) {
    const led = await getLedger(h.paybill_number, h.landlord_id);
    const rem = await remittanceLedger(h.paybill_number, h.landlord_id);
    mfiPayable += Math.max(0, led.summary.outstanding);
    remittancesPayable += Math.max(0, rem.summary.outstanding);
    // Overdue = still outstanding AND this month's agreed payment day passed.
    const day = effectiveRemittanceDay(h, h);
    const todayDate = new Date().getDate();
    if (rem.summary.outstanding > 0 && day && todayDate > Number(day)) {
      overdueRemCount += 1;
      overdueRemAmount += rem.summary.outstanding;
    }
    const openInv = (await query(
      `SELECT due_date::text AS due_date, total_payable FROM commission_invoices
        WHERE house_paybill_number = $1 AND status = 'Issued' AND total_payable > 0 AND due_date IS NOT NULL AND due_date < $2`,
      [h.paybill_number, today]
    )).rows;
    for (const inv of openInv) {
      overdueMfiCount += 1;
      overdueMfiAmount += Number(inv.total_payable || 0);
    }
  }
  const pendingReviews = (await query(`SELECT COUNT(*)::int AS n FROM landlord_reviews WHERE status = 'Under Review'`)).rows[0].n;
  const pendingVerification = (await query(
    `SELECT COALESCE(SUM(amount), 0)::float8 AS total FROM landlord_remittance_payments WHERE status = 'Pending Verification'`
  )).rows[0].total;
  const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  return {
    properties: houses.length,
    mfi_payable_to_gehm: round2(mfiPayable),
    remittances_payable_to_landlords: round2(remittancesPayable),
    overdue_remittances_count: overdueRemCount,
    overdue_remittances_amount: round2(overdueRemAmount),
    overdue_mfi_count: overdueMfiCount,
    overdue_mfi_amount: round2(overdueMfiAmount),
    pending_reviews: pendingReviews,
    pending_verification_total: round2(pendingVerification),
  };
}

async function ledgerTotals(housePaybill, month) {
  const { query } = require('../config/database');
  const inv = await query(
    `SELECT COALESCE(SUM(commission_amount), 0)::float8 AS total
       FROM commission_invoices
      WHERE house_paybill_number = $1 AND status = 'Issued' AND billing_month < $2`,
    [housePaybill, month]
  );
  const payBefore = await query(
    `SELECT COALESCE(SUM(amount), 0)::float8 AS total
       FROM commission_payments
      WHERE house_paybill_number = $1 AND payment_date < $2`,
    [housePaybill, monthStart(month)]
  );
  const payInMonth = await query(
    `SELECT COALESCE(SUM(amount), 0)::float8 AS total
       FROM commission_payments
      WHERE house_paybill_number = $1 AND payment_date >= $2 AND payment_date < $3`,
    [housePaybill, monthStart(month), monthEndExclusive(month)]
  );
  return {
    balance_before: round2(Number(inv.rows[0].total) - Number(payBefore.rows[0].total)),
    payments_in_month: round2(payInMonth.rows[0].total),
  };
}

async function getLedger(housePaybill, landlordId = null) {
  const { query } = require('../config/database');
  const house = await store.getHouse(housePaybill);
  if (!house) return null;
  const landlord = landlordId
    ? (await query(`SELECT * FROM landlords WHERE id = $1`, [landlordId])).rows[0] || null
    : (await query(
        `SELECT l.* FROM landlords l WHERE l.id = (SELECT landlord_id FROM houses WHERE paybill_number = $1)`,
        [housePaybill]
      )).rows[0] || null;
  const rate = await rateForHouse(housePaybill);
  const invRows = (await query(
    `SELECT ci.*, d.file_path AS document_path FROM commission_invoices ci
       LEFT JOIN documents d ON d.id = ci.document_id
      WHERE ci.house_paybill_number = $1 ORDER BY ci.created_at ASC, ci.id ASC`,
    [housePaybill]
  )).rows;
  const payRows = (await query(
    `SELECT * FROM commission_payments WHERE house_paybill_number = $1 ORDER BY payment_date ASC, id ASC`,
    [housePaybill]
  )).rows;

  // Chronological ledger with a running balance (invoices add commission,
  // payments subtract — the balance is always the property's truth).
  const events = [
    ...invRows.filter((i) => i.status === 'Issued').map((i) => ({
      type: 'invoice', date: i.created_at, id: i.id, invoice_number: i.invoice_number,
      billing_month: i.billing_month, commission: Number(i.commission_amount),
      previous_balance: Number(i.previous_balance), total_payable: Number(i.total_payable),
      status: i.status, document_id: i.document_id || null, amount: Number(i.commission_amount),
    })),
    ...payRows.map((p) => ({
      type: 'payment', date: p.payment_date, id: p.id, amount: Number(p.amount),
      method: p.method, reference: p.reference, notes: p.notes || null,
    })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date) || (a.type === 'invoice' ? -1 : 1));

  let balance = 0;
  for (const e of events) {
    balance = round2(balance + (e.type === 'invoice' ? e.commission : -e.amount));
    e.balance = balance;
  }

  const totalCommission = round2(invRows.filter((i) => i.status === 'Issued').reduce((s, i) => s + Number(i.commission_amount), 0));
  const totalPaid = round2(payRows.reduce((s, p) => s + Number(p.amount), 0));

  return {
    house: {
      paybill_number: house.paybill_number,
      house_name: house.house_name,
      landlord_id: landlord ? landlord.id : null,
    },
    landlord: landlord ? { id: landlord.id, name: landlord.name, phone: landlord.phone, email: landlord.email } : null,
    rate_percent: rate,
    events,
    summary: {
      total_commission: totalCommission,
      total_paid: totalPaid,
      outstanding: round2(totalCommission - totalPaid),
    },
  };
}

async function generateCommissionInvoice(housePaybill, billingMonth, { actor } = {}) {
  const { query } = require('../config/database');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(billingMonth || ''))) {
    return { error: 'billing_month must be YYYY-MM', code: 'VALIDATION' };
  }
  const house = await store.getHouse(housePaybill);
  if (!house) return { error: 'Property not found', code: 'NOT_FOUND' };
  if (!house.landlord_id) {
    return { error: 'Assign a landlord to this property before generating commission invoices.', code: 'NO_LANDLORD' };
  }
  const landlord = (await query(`SELECT * FROM landlords WHERE id = $1`, [house.landlord_id])).rows[0];
  if (!landlord) return { error: 'Landlord record not found', code: 'NOT_FOUND' };

  const rate = await rateForHouse(housePaybill);
  const { commissionable } = await rentCollectedForMonth(housePaybill, billingMonth);
  const commission = round2((commissionable * rate) / 100);
  const { balance_before, payments_in_month } = await ledgerTotals(housePaybill, billingMonth);
  const totalPayable = round2(balance_before + commission - payments_in_month);
  const dueDay = effectiveMfiDueDay(house, landlord);
  const dueDate = mfiDueDate(billingMonth, dueDay);

  // Upsert: one ACTIVE invoice per property-month; regeneration refreshes it.
  const existing = (await query(
    `SELECT * FROM commission_invoices
      WHERE house_paybill_number = $1 AND billing_month = $2 AND status = 'Issued'`,
    [housePaybill, billingMonth]
  )).rows[0];
  let invoice;
  if (existing) {
    invoice = (await query(
      `UPDATE commission_invoices
          SET rent_collected = $1, commission_rate = $2, commission_amount = $3,
              previous_balance = $4, payments_applied = $5, total_payable = $6,
              due_date = COALESCE($7, due_date), updated_at = NOW()
        WHERE id = $8 RETURNING *`,
      [commissionable, rate, commission, balance_before, payments_in_month, totalPayable, dueDate, existing.id]
    )).rows[0];
  } else {
    const invoiceNumber = await store.generateCommissionInvoiceNumber();
    invoice = (await query(
      `INSERT INTO commission_invoices
         (invoice_number, landlord_id, house_paybill_number, billing_month, rent_collected,
          commission_rate, commission_amount, previous_balance, payments_applied, total_payable,
          due_date, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Issued',$12)
       RETURNING *`,
      [invoiceNumber, landlord.id, housePaybill, billingMonth, commissionable,
        rate, commission, balance_before, payments_in_month, totalPayable, dueDate, actor || null]
    )).rows[0];
  }

  // PDF via the shared document pipeline (searchable + downloadable).
  const { generateAndStoreCommissionInvoice } = require('./documentStore');
  let document = null;
  try {
    document = await generateAndStoreCommissionInvoice(invoice.id, actor);
    if (document && document.id) invoice.document_id = document.id;
  } catch (err) {
    console.error('[Landlord Commission] Invoice PDF failed:', err.message);
  }

  return { invoice, landlord, house, document, regenerated: !!existing };
}

async function recordCommissionPayment({ house_paybill_number, landlord_id, declared_landlord_id, payment_date, amount, method, reference, notes, actor }) {
  const { query } = require('../config/database');
  const house = await store.getHouse(house_paybill_number);
  if (!house) return { error: 'Property not found', code: 'NOT_FOUND' };
  if (!house.landlord_id) return { error: 'Property has no landlord assigned', code: 'NO_LANDLORD' };
  if (landlord_id && Number(landlord_id) !== Number(house.landlord_id)) {
    return { error: 'Payment landlord does not match the property landlord — posting refused (accounts are never mixed).', code: 'LANDLORD_MISMATCH' };
  }
  if (declared_landlord_id != null && Number(declared_landlord_id) !== Number(house.landlord_id)) {
    return { error: 'Payment landlord does not match the property landlord — posting refused (accounts are never mixed).', code: 'LANDLORD_MISMATCH' };
  }
  const amt = Number(amount);
  if (!(amt > 0)) return { error: 'amount must be greater than 0', code: 'VALIDATION' };
  if (!payment_date) return { error: 'payment_date is required', code: 'VALIDATION' };

  const payment = (await query(
    `INSERT INTO commission_payments (landlord_id, house_paybill_number, payment_date, amount, method, reference, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [house.landlord_id, house_paybill_number, String(payment_date).slice(0, 10), round2(amt),
      method || 'M-Pesa', reference || null, notes || null, actor || null]
  )).rows[0];
  const ledger = await getLedger(house_paybill_number);
  return { payment, outstanding: ledger.summary.outstanding, ledger_summary: ledger.summary };
}

async function voidCommissionInvoice(id) {
  const { query } = require('../config/database');
  const inv = (await query(`SELECT * FROM commission_invoices WHERE id = $1`, [id])).rows[0];
  if (!inv) return null;
  const upd = (await query(
    `UPDATE commission_invoices SET status = 'Void', updated_at = NOW() WHERE id = $1 RETURNING *`, [id]
  )).rows[0];
  return upd;
}

async function landlordOverview(landlordId, month) {
  const { query } = require('../config/database');
  const landlord = (await query(`SELECT * FROM landlords WHERE id = $1`, [landlordId])).rows[0];
  if (!landlord) return null;
  const houses = (await query(
    `SELECT h.paybill_number, h.house_name, h.landlord_remittance_day, h.landlord_mfi_due_day,
            l.default_remittance_day, l.default_mfi_due_day
       FROM houses h JOIN landlords l ON l.id = h.landlord_id WHERE l.id = $1 ORDER BY h.house_name`,
    [landlordId]
  )).rows;
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || '')) ? String(month) : new Date().toISOString().slice(0, 7);
  const properties = [];
  let totalOutstanding = 0;
  let totalRemittanceOutstanding = 0;
  for (const h of houses) {
    const ledger = await getLedger(h.paybill_number, landlordId);
    const rem = await remittanceLedger(h.paybill_number, landlordId);
    const { commissionable } = await rentCollectedForMonth(h.paybill_number, m);
    const commission = round2((commissionable * ledger.rate_percent) / 100);
    properties.push({
      house_paybill_number: h.paybill_number,
      house_name: h.house_name,
      rate_percent: ledger.rate_percent,
      rent_collected: commissionable,
      commission_this_month: commission,
      total_commission: ledger.summary.total_commission,
      total_paid: ledger.summary.total_paid,
      outstanding: ledger.summary.outstanding,
      // Rent remittance side (kept fully separate from commission)
      remittance_day: effectiveRemittanceDay(h, landlord),
      remittance_net_month: rem.monthRows.find((r) => r.billing_month === m)?.net_payable || 0,
      remittance_paid: rem.summary.total_paid,
      remittance_pending: rem.summary.pending_verification,
      remittance_outstanding: rem.summary.outstanding,
      next_agreed_date: rem.next_agreed_date,
      landlord: ledger.landlord,
    });
    totalOutstanding += ledger.summary.outstanding;
    totalRemittanceOutstanding += rem.summary.outstanding;
  }
  return {
    landlord: { id: landlord.id, name: landlord.name, phone: landlord.phone, email: landlord.email, id_number: landlord.id_number, notes: landlord.notes },
    month: m,
    properties,
    total_outstanding: round2(totalOutstanding),
    total_remittance_outstanding: round2(totalRemittanceOutstanding),
  };
}

// ─── Rent remittance payable to the landlord ────────────────────────────────
// Net payable per month = actual rent collected − commission earned − other
// approved deductions (existing landlord-responsibility maintenance records).
// Unpaid net carries forward automatically; commission and remittance
// balances are computed independently and NEVER offset each other.

async function otherDeductionsForMonth(housePaybill, month) {
  try {
    const { query } = require('../config/database');
    const r = await query(
      `SELECT COALESCE(SUM(mc.amount_charged), 0)::float8 AS total
         FROM maintenance_charges mc
         JOIN tenants t ON t.tenant_code = mc.tenant_code
        WHERE t.house_paybill_number = $1 AND mc.charge_month = $2
          AND LOWER(COALESCE(mc.responsible_party, '')) LIKE '%landlord%'`,
      [housePaybill, month]
    );
    return round2(r.rows[0].total);
  } catch (_) {
    return 0;
  }
}

function nextAgreedDate(day) {
  if (!day) return null;
  const d = Number(day);
  if (!(d >= 1 && d <= 31)) return null;
  const now = new Date();
  const clamp = (y, mo) => Math.min(d, new Date(y, mo, 0).getDate()); // handle short months
  let y = now.getFullYear();
  let mo = now.getMonth() + 1;
  if (now.getDate() > clamp(y, mo)) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
  const dayOfMonth = clamp(y, mo);
  return `${y}-${String(mo).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
}

async function remittanceLedger(housePaybill, landlordId = null) {
  const { query } = require('../config/database');
  const house = await store.getHouse(housePaybill);
  if (!house) return null;
  const landlord = house.landlord_id
    ? (await query(`SELECT * FROM landlords WHERE id = $1`, [house.landlord_id])).rows[0] || null
    : null;
  // Historical months use the rate snapped on their commission invoice.
  const rate = await rateForHouse(housePaybill);

  // Months that have activity: rent collections, commission invoices, payments.
  const monthSet = new Set();
  const payMonths = await query(
    `SELECT DISTINCT p.billing_period FROM payments p
       JOIN tenants t ON t.tenant_code = p.tenant_code
      WHERE t.house_paybill_number = $1 AND p.status = 'Approved'
        AND COALESCE(p.payment_type, 'rent') <> 'deposit' AND p.billing_period IS NOT NULL`,
    [housePaybill]
  );
  for (const r of payMonths.rows) monthSet.add(r.billing_period);
  const invMonths = await query(
    `SELECT DISTINCT billing_month FROM commission_invoices WHERE house_paybill_number = $1 AND status = 'Issued'`,
    [housePaybill]
  );
  for (const r of invMonths.rows) monthSet.add(r.billing_month);
  const payAll = (await query(
    `SELECT * FROM landlord_remittance_payments WHERE house_paybill_number = $1 ORDER BY payment_date ASC, id ASC`,
    [housePaybill]
  )).rows;
  for (const p of payAll) monthSet.add(p.billing_month);

  const months = [...monthSet].sort();
  const monthRows = [];
  let cumulative = 0;
  for (const m of months) {
    const { commissionable } = await rentCollectedForMonth(housePaybill, m);
    // Historical months: prefer the invoiced rate/amount (agreement of that
    // period) — changing the current agreement never rewrites history.
    const mRate = await rateForMonth(housePaybill, m);
    const invoiceM = (await query(
      `SELECT commission_amount, commission_rate FROM commission_invoices
        WHERE house_paybill_number = $1 AND billing_month = $2 AND status = 'Issued'`,
      [housePaybill, m]
    )).rows[0];
    const commission = invoiceM
      ? round2(invoiceM.commission_amount)
      : round2((commissionable * mRate) / 100);
    const deductions = await otherDeductionsForMonth(housePaybill, m);
    const net = round2(commissionable - commission - deductions);
    const paidInMonth = round2(payAll
      .filter((p) => p.billing_month === m && p.status === 'Verified')
      .reduce((s, p) => s + Number(p.amount), 0));
    const pendingInMonth = round2(payAll
      .filter((p) => p.billing_month === m && p.status === 'Pending Verification')
      .reduce((s, p) => s + Number(p.amount), 0));
    cumulative = round2(cumulative + net - paidInMonth);
    monthRows.push({
      billing_month: m,
      rent_collected: commissionable,
      commission_earned: commission,
      other_deductions: deductions,
      net_payable: net,
      paid_in_month: paidInMonth,
      pending_in_month: pendingInMonth,
      outstanding_after: cumulative,
    });
  }

  // Chronological events; ONLY Verified transfers reduce the running balance.
  let balance = 0;
  const events = [];
  for (const r of monthRows) {
    balance = round2(balance + r.net_payable);
    events.push({
      type: 'net', date: `${r.billing_month}-01`, billing_month: r.billing_month,
      rent_collected: r.rent_collected, commission_earned: r.commission_earned,
      other_deductions: r.other_deductions, amount: r.net_payable, balance,
    });
    for (const p of payAll.filter((x) => x.billing_month === r.billing_month)) {
      const verified = p.status === 'Verified';
      if (verified) balance = round2(balance - Number(p.amount));
      events.push({
        type: 'payment', date: p.payment_date, billing_month: p.billing_month,
        amount: Number(p.amount), method: p.method, reference: p.reference,
        notes: p.notes || null, id: p.id, balance,
        status: p.status, verified,
        verified_by: p.verified_by || null, proof_note: p.proof_note || null,
      });
    }
  }

  const totalNet = round2(monthRows.reduce((s, r) => s + r.net_payable, 0));
  const totalPaid = round2(payAll.filter((p) => p.status === 'Verified').reduce((s, p) => s + Number(p.amount), 0));
  const totalPending = round2(payAll.filter((p) => p.status === 'Pending Verification').reduce((s, p) => s + Number(p.amount), 0));
  const day = effectiveRemittanceDay(house, landlord);

  return {
    house: { paybill_number: house.paybill_number, house_name: house.house_name, landlord_id: house.landlord_id || null },
    rate_percent: rate,
    remittance_day: day,
    next_agreed_date: nextAgreedDate(day),
    monthRows,
    events,
    payments: payAll,
    summary: {
      total_net: totalNet,
      total_paid: totalPaid,
      pending_verification: totalPending,
      outstanding: round2(totalNet - totalPaid),
    },
  };
}

async function recordRemittancePayment({ house_paybill_number, landlord_id, declared_landlord_id, billing_month, payment_date, amount, method, reference, notes, proof_note, actor }) {
  const { query } = require('../config/database');
  const house = await store.getHouse(house_paybill_number);
  if (!house) return { error: 'Property not found', code: 'NOT_FOUND' };
  if (!house.landlord_id) return { error: 'Property has no landlord assigned', code: 'NO_LANDLORD' };
  if (landlord_id && Number(landlord_id) !== Number(house.landlord_id)) {
    return { error: 'Payment landlord does not match the property landlord — posting refused (accounts are never mixed).', code: 'LANDLORD_MISMATCH' };
  }
  if (declared_landlord_id != null && Number(declared_landlord_id) !== Number(house.landlord_id)) {
    return { error: 'Payment landlord does not match the property landlord — posting refused (accounts are never mixed).', code: 'LANDLORD_MISMATCH' };
  }
  const amt = Number(amount);
  if (!(amt > 0)) return { error: 'amount must be greater than 0', code: 'VALIDATION' };
  if (!payment_date) return { error: 'payment_date is required', code: 'VALIDATION' };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(billing_month || ''))) {
    return { error: 'billing_month must be YYYY-MM', code: 'VALIDATION' };
  }
  const finalizedId = await isLedgerFinalized(house_paybill_number, billing_month);
  if (finalizedId) {
    return { error: 'This month\'s landlord ledger is FINALIZED — reopen it before recording transfers.', code: 'FINALIZED' };
  }
  const landlord = (await query(`SELECT * FROM landlords WHERE id = $1`, [house.landlord_id])).rows[0] || {};
  const recipientSnapshot = [
    landlord.mpesa_number ? `M-Pesa ${landlord.mpesa_number}` : null,
    landlord.bank_name ? `Bank ${landlord.bank_name} ${landlord.bank_account || ''}`.trim() : null,
    landlord.payment_details_note || null,
  ].filter(Boolean).join(' · ') || 'not set';

  const payment = (await query(
    `INSERT INTO landlord_remittance_payments (landlord_id, house_paybill_number, billing_month, payment_date, amount, method, reference, notes, proof_note, recipient_details, status, authorized_by, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Pending Verification',$11,$11) RETURNING *`,
    [house.landlord_id, house_paybill_number, billing_month, String(payment_date).slice(0, 10), round2(amt),
      method || 'M-Pesa', reference || null, notes || null, proof_note || null, recipientSnapshot, actor || null]
  )).rows[0];
  const rem = await remittanceLedger(house_paybill_number);
  return { payment, outstanding: rem.summary.outstanding, ledger_summary: rem.summary };
}

async function setRemittanceDay(housePaybill, day) {
  const { query } = require('../config/database');
  const d = Number(day);
  if (!(d >= 1 && d <= 31)) return { error: 'day must be 1-31', code: 'VALIDATION' };
  const house = await store.getHouse(housePaybill);
  if (!house) return { error: 'Property not found', code: 'NOT_FOUND' };
  await query(`UPDATE houses SET landlord_remittance_day = $1, updated_at = NOW() WHERE paybill_number = $2`, [d, housePaybill]);
  const rem = await remittanceLedger(housePaybill);
  return { remittance_day: d, next_agreed_date: rem.next_agreed_date };
}

async function propertyDashboard(housePaybill, landlordId, month) {
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || '')) ? String(month) : new Date().toISOString().slice(0, 7);
  const commissionLedger = await getLedger(housePaybill, landlordId);
  if (!commissionLedger) return null;
  const rem = await remittanceLedger(housePaybill, landlordId);
  const monthRow = rem.monthRows.find((r) => r.billing_month === m) || null;
  const rate = commissionLedger.rate_percent;
  const rentCollected = monthRow ? monthRow.rent_collected : (await rentCollectedForMonth(housePaybill, m)).commissionable;
  const commissionEarned = monthRow ? monthRow.commission_earned : round2((rentCollected * rate) / 100);
  const commissionInvoiced = commissionLedger.summary.total_commission;
  const latestInvoice = commissionLedger.events.filter((e) => e.type === 'invoice').slice(-1)[0] || null;
  const recon = await reconciliation(housePaybill, m).catch(() => null);
  const finalizedId = await isLedgerFinalized(housePaybill, m).catch(() => null);
  const { query } = require('../config/database');
  const houseRow = (await query(`SELECT * FROM houses WHERE paybill_number = $1`, [housePaybill])).rows[0] || null;
  const landlordRow = commissionLedger.landlord
    ? (await query(`SELECT * FROM landlords WHERE id = $1`, [commissionLedger.landlord.id])).rows[0] || null
    : null;
  return {
    month: m,
    house: commissionLedger.house,
    landlord: commissionLedger.landlord,
    rate_percent: rate,
    reconciliation: recon,
    finalized: !!finalizedId,
    mfi_due_day: effectiveMfiDueDay(houseRow, landlordRow),
    summary: {
      // Month figures
      rent_collected: rentCollected,
      commission_earned: commissionEarned,
      other_deductions: monthRow ? monthRow.other_deductions : 0,
      net_payable_month: monthRow ? monthRow.net_payable : 0,
      // Commission account (cumulative)
      commission_invoiced: commissionInvoiced,
      commission_paid: commissionLedger.summary.total_paid,
      commission_outstanding: commissionLedger.summary.outstanding,
      // Remittance account (cumulative)
      remittance_net_total: rem.summary.total_net,
      remittance_paid: rem.summary.total_paid,
      remittance_pending_verification: rem.summary.pending_verification,
      remittance_outstanding: rem.summary.outstanding,
      // Agreed dates
      remittance_day: rem.remittance_day,
      next_agreed_date: rem.next_agreed_date,
      latest_commission_invoice: latestInvoice,
    },
    commission_events: commissionLedger.events,
    remittance_events: rem.events,
    remittance_month_rows: rem.monthRows,
  };
}

module.exports = {
  rentCollectedForMonth,
  rateForHouse,
  ledgerTotals,
  getLedger,
  generateCommissionInvoice,
  recordCommissionPayment,
  voidCommissionInvoice,
  landlordOverview,
  otherDeductionsForMonth,
  nextAgreedDate,
  remittanceLedger,
  recordRemittancePayment,
  setRemittanceDay,
  propertyDashboard,
  rateForMonth,
  effectiveRemittanceDay,
  effectiveMfiDueDay,
  mfiDueDate,
  isLedgerFinalized,
  reconciliation,
  finalizeLedger,
  reopenLedger,
  flagReview,
  resolveReview,
  verifyRemittancePayment,
  reverseFalsePayment,
  landlordAccountTotals,
};
