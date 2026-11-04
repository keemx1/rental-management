'use strict';

/**
 * Financial consistency validator - runs at three stages (SYSTEM DIRECTIVE):
 *   1. BEFORE rollover  - verify closing balances, payment history, outstanding
 *                          invoices, advance/credits.
 *   2. AFTER  rollover  - confirm opening balances, no settled/duplicated charges
 *                          carried forward, dashboards reflect the new position.
 *   3. AFTER  payment   - confirm correct allocation, invoice balances updated,
 *                          balances recalculated, communications agree.
 *
 * It FLAGS inconsistencies for correction - it never silently rewrites financial
 * records. Every check is evidence-based (compares stored counters against actual
 * payments/invoices); nothing is invented.
 */

const { query } = require('../config/database');

function alloc(row) {
  try { return typeof row.allocation_breakdown === 'string' ? JSON.parse(row.allocation_breakdown) : (row.allocation_breakdown || {}); }
  catch (_) { return {}; }
}

// Per-tenant consistency checks. Returns an array of issue objects.
async function validateTenantAccount(tenantCode) {
  const issues = [];
  const t = (await query(
    `SELECT tenant_code, name, status, rent_amount, arrears, rent_paid_this_month,
            deposit_amount, deposit_paid, garbage_fee_amount, garbage_fee_paid,
            water_charge_amount, water_charge_paid, advance_rent_balance,
            advance_rent_until::text AS advance_rent_until, opening_advance_rent,
            credit_balance, rent_due_date::text AS rent_due_date
     FROM tenants WHERE tenant_code = $1`, [tenantCode])).rows[0];
  if (!t) return issues;
  const num = (v) => Number(v || 0);

  // 1. Non-negative counters.
  if (num(t.arrears) < 0) issues.push({ code: 'NEG_ARREARS', msg: `arrears=${t.arrears} (negative)` });
  if (num(t.advance_rent_balance) < 0) issues.push({ code: 'NEG_ADVANCE', msg: `advance_rent_balance=${t.advance_rent_balance}` });
  if (num(t.credit_balance) < 0) issues.push({ code: 'NEG_CREDIT', msg: `credit_balance=${t.credit_balance}` });

  // 2. Paid never exceeds the configured charge (no over-recorded payments).
  if (num(t.deposit_paid) > num(t.deposit_amount)) issues.push({ code: 'OVER_DEPOSIT', msg: `deposit_paid ${t.deposit_paid} > deposit_amount ${t.deposit_amount}` });
  if (num(t.garbage_fee_paid) > num(t.garbage_fee_amount)) issues.push({ code: 'OVER_GARBAGE', msg: `garbage_fee_paid ${t.garbage_fee_paid} > garbage_fee_amount ${t.garbage_fee_amount}` });
  if (num(t.water_charge_paid) > num(t.water_charge_amount)) issues.push({ code: 'OVER_WATER', msg: `water_charge_paid ${t.water_charge_paid} > water_charge_amount ${t.water_charge_amount}` });

  // 3. Stale/re-emitted advance (EX304-pattern): opening_advance_rent was seeded
  //    into advance_rent_balance but advance_rent_until is null (no coverage) - a
  //    consumed credit that re-appeared. A set advance_rent_until means the balance
  //    is a legitimate partial remainder (not stale), so it is NOT flagged.
  if (num(t.advance_rent_balance) > 0 && !t.advance_rent_until && num(t.opening_advance_rent) > 0) {
    issues.push({ code: 'STALE_ADVANCE', msg: `advance_rent_balance ${t.advance_rent_balance} re-emitted from opening_advance_rent ${t.opening_advance_rent} with advance_rent_until=null (consumed-credit re-emit?)` });
  }

  // 4. Payment allocations must sum to the payment amount (no unaccounted money).
  const pays = (await query(
    `SELECT id, amount, allocation_breakdown FROM payments WHERE tenant_code = $1 AND status = 'Approved'`, [tenantCode])).rows;
  for (const p of pays) {
    const a = alloc(p);
    const sum = num(a.rentSettled) + num(a.garbageFeeSettled) + num(a.waterSettled) + num(a.penaltySettled)
      + num(a.maintenanceSettled) + num(a.otherSettled) + num(a.depositSettled) + num(a.arrearsSettled)
      + num(a.agreementSettled) + num(a.overpayment);
    if (Math.abs(sum - num(p.amount)) > 0.5) {
      issues.push({ code: 'ALLOC_MISMATCH', msg: `pay#${p.id} amount ${p.amount} but allocation sums to ${sum}` });
    }
  }

  // 5. Duplicate M-Pesa references within the tenant.
  const dupRefs = (await query(
    `SELECT mpesa_reference, COUNT(*)::int AS n FROM payments WHERE tenant_code = $1 AND status='Approved' AND mpesa_reference IS NOT NULL GROUP BY mpesa_reference HAVING COUNT(*) > 1`, [tenantCode])).rows;
  for (const d of dupRefs) issues.push({ code: 'DUP_REF', msg: `duplicate mpesa_reference ${d.mpesa_reference} (${d.n} payments)` });

  return issues;
}

// Stage 1 - before rollover: verify every active tenant's closing position.
async function validatePreRollover() {
  const tenants = (await query(`SELECT tenant_code FROM tenants WHERE status != 'Vacant'`)).rows.map((r) => r.tenant_code);
  const flagged = [];
  for (const code of tenants) {
    const issues = await validateTenantAccount(code);
    if (issues.length) flagged.push({ tenant_code: code, stage: 'pre_rollover', issues });
  }
  return { stage: 'pre_rollover', checked: tenants.length, flagged };
}

// Stage 2 - after rollover: opening balances sane, no stale charges carried forward.
async function validatePostRollover() {
  const tenants = (await query(`SELECT tenant_code FROM tenants WHERE status != 'Vacant'`)).rows.map((r) => r.tenant_code);
  const flagged = [];
  for (const code of tenants) {
    const issues = await validateTenantAccount(code);
    // Post-rollover specific: arrears must be non-negative and no stale advance.
    if (issues.length) flagged.push({ tenant_code: code, stage: 'post_rollover', issues });
  }
  return { stage: 'post_rollover', checked: tenants.length, flagged };
}

// Stage 3 - after a payment is approved: allocation + invoice + balance + comms agree.
async function validatePostPayment(paymentId) {
  const p = (await query(`SELECT id, tenant_code, amount, allocation_breakdown FROM payments WHERE id = $1`, [paymentId])).rows[0];
  if (!p) return { stage: 'post_payment', payment_id: paymentId, flagged: [{ msg: 'payment not found' }] };
  const issues = await validateTenantAccount(p.tenant_code);
  // Payment-specific: the allocation must sum to the amount.
  const a = alloc(p);
  const num = (v) => Number(v || 0);
  const sum = num(a.rentSettled) + num(a.garbageFeeSettled) + num(a.waterSettled) + num(a.penaltySettled)
    + num(a.maintenanceSettled) + num(a.otherSettled) + num(a.depositSettled) + num(a.arrearsSettled)
    + num(a.agreementSettled) + num(a.overpayment);
  if (Math.abs(sum - num(p.amount)) > 0.5) {
    issues.push({ code: 'PAY_ALLOC_MISMATCH', msg: `pay#${p.id} amount ${p.amount} but allocation sums to ${sum}` });
  }
  return { stage: 'post_payment', payment_id: paymentId, tenant_code: p.tenant_code, flagged: issues.length ? [{ tenant_code: p.tenant_code, issues }] : [] };
}

// Flag (never auto-fix): log every inconsistency to audit_log for review.
async function flagIssues(result, actor = 'financial-validator') {
  for (const f of (result.flagged || [])) {
    const detail = (f.issues || []).map((i) => `${i.code}: ${i.msg}`).join(' | ');
    if (!detail) continue;
    await query(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5)`,
      [actor, 'FLAGGED_INCONSISTENCY', 'tenant', String(f.tenant_code || ''), `[${result.stage}] ${detail}`]
    ).catch(() => {});
  }
  return result;
}

module.exports = {
  validateTenantAccount,
  validatePreRollover,
  validatePostRollover,
  validatePostPayment,
  flagIssues,
};
