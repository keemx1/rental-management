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
              updated_at = NOW()
        WHERE id = $7 RETURNING *`,
      [commissionable, rate, commission, balance_before, payments_in_month, totalPayable, existing.id]
    )).rows[0];
  } else {
    const invoiceNumber = await store.generateCommissionInvoiceNumber();
    invoice = (await query(
      `INSERT INTO commission_invoices
         (invoice_number, landlord_id, house_paybill_number, billing_month, rent_collected,
          commission_rate, commission_amount, previous_balance, payments_applied, total_payable,
          status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Issued',$11)
       RETURNING *`,
      [invoiceNumber, landlord.id, housePaybill, billingMonth, commissionable,
        rate, commission, balance_before, payments_in_month, totalPayable, actor || null]
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
    `SELECT paybill_number, house_name, landlord_remittance_day FROM houses WHERE landlord_id = $1 ORDER BY house_name`,
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
      remittance_day: h.landlord_remittance_day || null,
      remittance_net_month: rem.monthRows.find((r) => r.billing_month === m)?.net_payable || 0,
      remittance_paid: rem.summary.total_paid,
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
    const commission = round2((commissionable * rate) / 100);
    const deductions = await otherDeductionsForMonth(housePaybill, m);
    const net = round2(commissionable - commission - deductions);
    const paidInMonth = round2(payAll.filter((p) => p.billing_month === m).reduce((s, p) => s + Number(p.amount), 0));
    cumulative = round2(cumulative + net - paidInMonth);
    monthRows.push({
      billing_month: m,
      rent_collected: commissionable,
      commission_earned: commission,
      other_deductions: deductions,
      net_payable: net,
      paid_in_month: paidInMonth,
      outstanding_after: cumulative,
    });
  }

  // Chronological payment history with running remittance balance.
  let balance = 0;
  const events = [];
  const rowByMonth = new Map(monthRows.map((r) => [r.billing_month, r]));
  // Merge: walk months, inserting the month's net row then its payments.
  for (const r of monthRows) {
    balance = round2(balance + r.net_payable);
    events.push({
      type: 'net', date: `${r.billing_month}-01`, billing_month: r.billing_month,
      rent_collected: r.rent_collected, commission_earned: r.commission_earned,
      other_deductions: r.other_deductions, amount: r.net_payable, balance,
    });
    for (const p of payAll.filter((x) => x.billing_month === r.billing_month)) {
      balance = round2(balance - Number(p.amount));
      events.push({
        type: 'payment', date: p.payment_date, billing_month: p.billing_month,
        amount: Number(p.amount), method: p.method, reference: p.reference,
        notes: p.notes || null, id: p.id, balance,
      });
    }
  }
  // Payments whose month has no computed row (defensive)
  for (const p of payAll) {
    if (!rowByMonth.has(p.billing_month)) {
      balance = round2(balance - Number(p.amount));
      events.push({
        type: 'payment', date: p.payment_date, billing_month: p.billing_month,
        amount: Number(p.amount), method: p.method, reference: p.reference,
        notes: p.notes || null, id: p.id, balance,
      });
    }
  }

  const totalNet = round2(monthRows.reduce((s, r) => s + r.net_payable, 0));
  const totalPaid = round2(payAll.reduce((s, p) => s + Number(p.amount), 0));
  const day = house.landlord_remittance_day || null;

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
      outstanding: round2(totalNet - totalPaid),
    },
  };
}

async function recordRemittancePayment({ house_paybill_number, landlord_id, declared_landlord_id, billing_month, payment_date, amount, method, reference, notes, actor }) {
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

  const payment = (await query(
    `INSERT INTO landlord_remittance_payments (landlord_id, house_paybill_number, billing_month, payment_date, amount, method, reference, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [house.landlord_id, house_paybill_number, billing_month, String(payment_date).slice(0, 10), round2(amt),
      method || 'M-Pesa', reference || null, notes || null, actor || null]
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
  return {
    month: m,
    house: commissionLedger.house,
    landlord: commissionLedger.landlord,
    rate_percent: rate,
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
};
