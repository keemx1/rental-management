'use strict';

/**
 * Outstanding Financial Obligations Tracker (Phase 1 · Priority 1).
 *
 * Computed LIVE from existing records (nothing stored/invented), grouped
 * into the four management buckets:
 *   owed_to_landlords | owed_to_gehpm | tenant_liabilities | company_expenses
 * Every row carries amount, due/status, party, property and a deep link.
 * Only ADMIN may read (route enforces).
 */

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

async function getObligations() {
  const { query } = require('../config/database');
  const t = today();
  const rows = [];
  const add = (bucket, key, o) => rows.push({ bucket, key, ...o });

  // ── A. Owed TO landlords ────────────────────────────────────────────────
  try {
    const houses = (await query(
      `SELECT h.paybill_number, h.house_name, h.landlord_id, h.landlord_remittance_day, h.landlord_mfi_due_day,
              l.name AS landlord_name, l.default_remittance_day
         FROM houses h JOIN landlords l ON l.id = h.landlord_id`
    )).rows;
    for (const h of houses) {
      const rem = await require('./landlordCommission').remittanceLedger(h.paybill_number, h.landlord_id);
      if (rem && rem.summary.outstanding > 0) {
        const day = rem.remittance_day;
        const overdue = day && new Date().getDate() > Number(day);
        add(overdue ? 'owed_to_landlords' : 'owed_to_landlords', `remittance:${h.paybill_number}`, {
          title: `${overdue ? 'Overdue' : 'Outstanding'} landlord remittance — ${h.house_name || h.paybill_number}`,
          amount: rem.summary.outstanding,
          party: h.landlord_name,
          property: h.house_name || h.paybill_number,
          due_date: rem.next_agreed_date,
          due: !!overdue,
          status: overdue ? 'Overdue' : (rem.summary.pending_verification > 0 ? 'Awaiting verification' : 'Awaiting payment'),
          source: 'Landlord remittance ledger',
          link: { kind: 'landlord_ledger', landlord_id: h.landlord_id, paybill: h.paybill_number },
        });
      }
    }
  } catch (_) {}

  // Landlord advances (person_type = landlord on the advances register)
  try {
    const adv = (await query(
      `SELECT id, employee_name, outstanding, expected_recovery_month, reason, person_type
         FROM staff_advances
        WHERE COALESCE(person_type,'') ILIKE '%landlord%' AND COALESCE(outstanding,0) > 0
        ORDER BY date_advanced`
    )).rows;
    for (const a of adv) {
      add('owed_to_landlords', `landlord_advance:${a.id}`, {
        title: `Landlord advance outstanding — ${a.employee_name}`,
        amount: Number(a.outstanding), party: a.employee_name,
        due_date: a.expected_recovery_month ? String(a.expected_recovery_month).slice(0, 10) : null,
        due: !!a.expected_recovery_month && String(a.expected_recovery_month).slice(0, 10) < t,
        status: a.status || 'Outstanding', source: 'Advance register',
        link: { kind: 'invoices', invoice_type: 'staff-advance' },
      });
    }
  } catch (_) {}

  // ── B. Owed TO GEHPM ────────────────────────────────────────────────────
  try {
    const invs = (await query(
      `SELECT ci.id, ci.invoice_number, ci.billing_month, ci.total_payable, ci.due_date::text AS due_date,
              l.name AS landlord_name, h.house_name
         FROM commission_invoices ci
         JOIN landlords l ON l.id = ci.landlord_id
         LEFT JOIN houses h ON h.paybill_number = ci.house_paybill_number
        WHERE ci.status = 'Issued' AND ci.total_payable > 0
        ORDER BY ci.due_date NULLS LAST`
    )).rows;
    for (const inv of invs) {
      const overdue = inv.due_date && inv.due_date < t;
      add('owed_to_gehpm', `commission_invoice:${inv.id}`, {
        title: `Management fee unpaid — ${inv.invoice_number} (${inv.billing_month})`,
        amount: Number(inv.total_payable), party: inv.landlord_name,
        property: inv.house_name || inv.house_paybill_number,
        due_date: inv.due_date, due: !!overdue,
        status: overdue ? 'Overdue' : 'Awaiting payment', source: 'Commission invoice',
        link: { kind: 'landlord_ledger', paybill: inv.house_paybill_number },
      });
    }
  } catch (_) {}

  // ── C. Tenant liabilities ───────────────────────────────────────────────
  try {
    const refunds = (await query(
      `SELECT dr.id, dr.tenant_code, dr.refundable_amount, dr.amount_refunded, dr.refund_status,
              dr.refund_due_date::text AS refund_due_date, ei.exit_number, t.name AS tenant_name,
              ei.property_name, ei.unit_label
         FROM deposit_refunds dr
         LEFT JOIN tenants t ON t.tenant_code = dr.tenant_code
         LEFT JOIN exit_invoices ei ON ei.id = dr.exit_invoice_id
        WHERE dr.refund_status IN ('pending','due_soon','due_today','overdue')
          AND (dr.refundable_amount - COALESCE(dr.amount_refunded,0)) > 0
        ORDER BY dr.refund_due_date NULLS LAST`
    )).rows;
    for (const r of refunds) {
      const overdue = r.refund_status === 'overdue' || (r.refund_due_date && r.refund_due_date < t);
      add('tenant_liabilities', `deposit_refund:${r.id}`, {
        title: `Deposit refund due — ${r.tenant_name || r.tenant_code}`,
        amount: round2(Number(r.refundable_amount) - Number(r.amount_refunded || 0)),
        party: r.tenant_name || r.tenant_code,
        property: [r.property_name, r.unit_label].filter(Boolean).join(' · '),
        due_date: r.refund_due_date, due: !!overdue,
        status: r.refund_status, source: r.exit_number ? `Exit ${r.exit_number}` : 'Deposit refund',
        link: { kind: 'deposit_refunds' },
      });
    }
    const credits = (await query(
      `SELECT COALESCE(SUM(credit_balance),0)::float8 AS c, COALESCE(SUM(advance_rent_balance),0)::float8 AS a
         FROM tenants WHERE COALESCE(status,'') <> 'Vacant'`
    )).rows[0];
    if (Number(credits.c) > 0 || Number(credits.a) > 0) {
      add('tenant_liabilities', 'tenant_credits', {
        title: 'Tenant credits & advance rent held (liability)',
        amount: round2(Number(credits.c) + Number(credits.a)),
        party: 'Tenants (aggregate)', status: 'Held',
        source: 'Tenant balances', link: { kind: 'payments' },
      });
    }
  } catch (_) {}

  // ── D. Company expenses ─────────────────────────────────────────────────
  try {
    const salaries = (await query(
      `SELECT id, employee_name, salary_month, outstanding, status
         FROM salary_records WHERE COALESCE(outstanding,0) > 0 ORDER BY salary_month`
    )).rows;
    for (const s of salaries) {
      add('company_expenses', `salary:${s.id}`, {
        title: `Unpaid salary — ${s.employee_name} (${s.salary_month})`,
        amount: Number(s.outstanding), party: s.employee_name,
        due_date: s.salary_month ? `${s.salary_month}-28` : null,
        due: !!s.salary_month && `${s.salary_month}-28` < t,
        status: s.status || 'Outstanding', source: 'Salary register',
        link: { kind: 'invoices', invoice_type: 'salary' },
      });
    }
  } catch (_) {}
  try {
    const expenses = (await query(
      `SELECT m.id, m.mnt_number, m.property_name, m.house_paybill_number, m.grand_total, m.paid_total, m.status, m.category
         FROM maintenance_invoices m
        WHERE COALESCE(m.paid_total,0) < COALESCE(m.grand_total,0)
          AND COALESCE(m.status,'') NOT ILIKE '%void%'
        ORDER BY m.created_at DESC LIMIT 40`
    )).rows;
    for (const e of expenses) {
      const outstanding = round2(Number(e.grand_total || 0) - Number(e.paid_total || 0));
      if (outstanding <= 0) continue;
      add('company_expenses', `expense_invoice:${e.id}`, {
        title: `Unpaid ${e.category || 'expense'} invoice — ${e.mnt_number}`,
        amount: outstanding, party: e.property_name || 'Supplier',
        property: e.house_paybill_number || null, due: false,
        status: e.status || 'Unpaid', source: 'Expense invoice',
        link: { kind: 'invoices', invoice_type: 'maintenance-invoice' },
      });
    }
  } catch (_) {}
  try {
    const advances = (await query(
      `SELECT id, employee_name, outstanding, expected_recovery_month, person_type, reason
         FROM staff_advances
        WHERE COALESCE(person_type,'') NOT ILIKE '%landlord%' AND COALESCE(outstanding,0) > 0
        ORDER BY date_advanced`
    )).rows;
    for (const a of advances) {
      add('company_expenses', `employee_advance:${a.id}`, {
        title: `Employee advance to recover — ${a.employee_name}`,
        amount: Number(a.outstanding), party: a.employee_name,
        due_date: a.expected_recovery_month ? String(a.expected_recovery_month).slice(0, 10) : null,
        due: !!a.expected_recovery_month && String(a.expected_recovery_month).slice(0, 10) < t,
        status: 'Outstanding', source: 'Advance register',
        link: { kind: 'invoices', invoice_type: 'staff-advance' },
      });
    }
  } catch (_) {}
  try {
    const utils = (await query(
      `SELECT w.id, w.wtr_number, w.tenant_code, w.tenant_name, w.unit_label, w.total_amount, w.due_date::text AS due_date, w.status
         FROM water_invoices w
        WHERE w.status NOT IN ('Paid','Void') AND COALESCE(w.total_amount,0) > 0
        ORDER BY w.due_date NULLS LAST LIMIT 40`
    )).rows;
    for (const u of utils) {
      const overdue = u.due_date && u.due_date < t;
      add('company_expenses', `utility:${u.id}`, {
        title: `Unpaid water utility — ${u.tenant_name || u.tenant_code}`,
        amount: Number(u.total_amount), party: u.tenant_name || u.tenant_code,
        property: u.unit_label || null, due_date: u.due_date, due: !!overdue,
        status: u.status, source: u.wtr_number,
        link: { kind: 'water_invoice', id: u.id },
      });
    }
  } catch (_) {}
  try {
    const reimb = (await query(
      `SELECT COALESCE(SUM(GREATEST(amount_claimed, amount_approved) - COALESCE(amount_reimbursed,0)),0)::float8 AS n,
              COUNT(*)::int AS c FROM reimbursements WHERE COALESCE(amount_reimbursed,0) < COALESCE(amount_approved, amount_claimed)`
    )).rows[0];
    if (reimb && Number(reimb.n) > 0) {
      add('company_expenses', 'reimbursements', {
        title: `Unpaid reimbursements (${reimb.c} claim(s))`,
        amount: round2(reimb.n), party: 'Staff / management', status: 'Outstanding',
        source: 'Reimbursement register', link: { kind: 'invoices', invoice_type: 'maintenance-invoice' },
      });
    }
  } catch (_) {}

  const summary = { owed_to_landlords: 0, owed_to_gehpm: 0, tenant_liabilities: 0, company_expenses: 0 };
  const counts = { owed_to_landlords: 0, owed_to_gehpm: 0, tenant_liabilities: 0, company_expenses: 0 };
  for (const r of rows) { summary[r.bucket] = round2((summary[r.bucket] || 0) + r.amount); counts[r.bucket]++; }
  return {
    generated_at: new Date().toISOString(),
    summary,
    counts,
    total: rows.length,
    overdue_count: rows.filter((r) => r.due).length,
    obligations: rows,
  };
}

module.exports = { getObligations };
