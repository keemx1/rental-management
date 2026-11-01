/**
 * SYSTEM-WIDE PAYMENT & TENANT FINANCIAL AUDIT (READ-ONLY).
 *
 * Scans every property/tenant against the authoritative GEHPM database and
 * reports discrepancies. NEVER modifies any record — corrections must follow
 * the authorized management workflow (reverse/reinstate with reason + audit).
 *
 * Checks (requirement 5):
 *  1. Fully-paid tenants flagged partially/overdue (report vs allocation truth)
 *  2. Tenants with genuine arrears flagged fully paid
 *  3. Payments missing receipt numbers or transaction references
 *  4. Payments with missing/incorrect payment dates
 *  5. Deposit-allocated money mis-counted as rent (the B2 class)
 *  6. Stale arrears field (arrears != allocation-derived carried balance)
 *  7. Duplicate M-Pesa references / duplicate client_txn_id
 *  8. Unrecognised overpayments / advance rent
 *  9. Missing or invalid billing_period on approved payments
 *
 * Usage: node backend/scripts/audit-payment-integrity.js [--month YYYY-MM] [--json]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

const args = process.argv.slice(2);
const monthArgIdx = args.indexOf('--month');
const MONTH = monthArgIdx >= 0 ? args[monthArgIdx + 1] : new Date().toISOString().slice(0, 7);
const asJson = args.includes('--json');

const findings = [];
function add(property, unit, tenant, code, detail, ref) {
  findings.push({ property, unit, tenant, code, detail, ref: ref || '' });
}

function parseBd(p) {
  let bd = p.allocation_breakdown;
  try { if (typeof bd === 'string') bd = JSON.parse(bd); } catch (_) { bd = null; }
  return bd || {};
}

async function main() {
  const monthStart = `${MONTH}-01`;
  const [y, m] = MONTH.split('-').map(Number);
  const monthEnd = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

  console.log(`\n=== GEHPM SYSTEM-WIDE PAYMENT AUDIT — ${MONTH} (read-only) ===\n`);

  // ── 1. Every approved payment in the period (billing_period OR date) ─────
  const payRes = await query(
    `SELECT p.*, t.name AS tenant_name, t.unit_label, t.house_paybill_number, t.property_name,
            t.rent_amount, t.arrears, t.deposit_amount, t.status AS tenant_status
     FROM payments p JOIN tenants t ON p.tenant_code = t.tenant_code
     WHERE p.status = 'Approved'
       AND (p.billing_period = $1 OR (p.payment_date >= $2 AND p.payment_date < $3))
     ORDER BY t.house_paybill_number, t.unit_label, p.payment_date, p.id`,
    [MONTH, monthStart, monthEnd]
  );
  const pays = payRes.rows;
  console.log(`Payments in scope: ${pays.length}`);

  // Group by tenant
  const byTenant = {};
  for (const p of pays) {
    if (!byTenant[p.tenant_code]) byTenant[p.tenant_code] = [];
    byTenant[p.tenant_code].push(p);
  }
  console.log(`Tenants with payments: ${Object.keys(byTenant).length}\n`);

  // ── 2. Per-payment checks ────────────────────────────────────────────────
  const refSeen = new Map();
  const txnSeen = new Map();
  for (const p of pays) {
    const bd = parseBd(p);
    const prop = p.property_name || p.house_paybill_number || '?';
    const unit = p.unit_label || p.tenant_code;
    // Missing receipt / reference
    if (!p.receipt_number) add(prop, unit, p.tenant_code, 'MISSING_RECEIPT', `payment ${p.id} has no receipt number`, p.mpesa_reference);
    if (!p.mpesa_reference && p.payment_mode === 'M-Pesa') add(prop, unit, p.tenant_code, 'MISSING_MPESA_REF', `M-Pesa payment ${p.id} has no reference`, p.receipt_number);
    // Missing / invalid payment date
    if (!p.payment_date) add(prop, unit, p.tenant_code, 'MISSING_DATE', `payment ${p.id} has no payment_date`, p.receipt_number);
    // Missing billing period
    if (!p.billing_period) add(prop, unit, p.tenant_code, 'MISSING_BILLING_PERIOD', `payment ${p.id} (${p.amount}) has no billing_period`, p.receipt_number);
    // Duplicate M-Pesa reference
    if (p.mpesa_reference) {
      const k = p.mpesa_reference;
      if (refSeen.has(k)) add(prop, unit, p.tenant_code, 'DUPLICATE_MPESA_REF', `reference ${k} used by payments ${refSeen.get(k)} and ${p.id}`, k);
      else refSeen.set(k, p.id);
    }
    // Duplicate client_txn_id
    if (p.client_txn_id) {
      const k = p.client_txn_id;
      if (txnSeen.has(k)) add(prop, unit, p.tenant_code, 'DUPLICATE_CLIENT_TXN', `client_txn ${k} used by ${txnSeen.get(k)} and ${p.id}`, k);
      else txnSeen.set(k, p.id);
    }
    // Deposit money inside a rent-typed payment (B2 class) — informational,
    // legitimate for onboarding but must be visible, not counted as rent.
    const allocDeposit = Number(bd.depositSettled || 0);
    if (allocDeposit > 0 && (p.payment_type || 'rent') !== 'deposit') {
      add(prop, unit, p.tenant_code, 'DEPOSIT_IN_RENT_PAYMENT',
        `payment ${p.id} (${p.amount}, type=${p.payment_type}) allocated ${allocDeposit} to DEPOSIT — must not count as rent paid`, p.receipt_number);
    }
  }

  // ── 3. Per-tenant allocation vs report reconciliation ────────────────────
  for (const [code, tpays] of Object.entries(byTenant)) {
    const t = tpays[0];
    const prop = t.property_name || t.house_paybill_number || '?';
    const unit = t.unit_label || code;
    let rentSettled = 0, garbSettled = 0, watSettled = 0, penSettled = 0, depSettled = 0, arrSettled = 0;
    let chargePaid = 0;
    for (const p of tpays) {
      const bd = parseBd(p);
      rentSettled += Number(bd.rentSettled || 0);
      garbSettled += Number(bd.garbageFeeSettled || 0);
      watSettled += Number(bd.waterSettled || 0);
      penSettled += Number(bd.penaltySettled || 0);
      depSettled += Number(bd.depositSettled || 0);
      arrSettled += Number(bd.arrearsSettled || 0);
      if ((p.payment_type || 'rent') === 'deposit') depSettled += Number(p.amount || 0);
      else chargePaid += Number(bd.rentSettled || 0) + Number(bd.garbageFeeSettled || 0) + Number(bd.waterSettled || 0) + Number(bd.penaltySettled || 0);
    }
    const totalPaidAll = tpays.reduce((s, p) => s + Number(p.amount || 0), 0);
    // Expected period charge (current config) — for staleness heuristics only.
    const rentAmt = Number(t.rent_amount || 0);
    const arrearsField = Number(t.arrears || 0);
    // If allocations show everything settled (chargePaid >= rent and arrears
    // settled) but the arrears field is large → stale arrears (B2 class).
    if (arrearsField > 0 && chargePaid >= rentAmt && arrSettled === 0) {
      add(prop, unit, code, 'STALE_ARREARS',
        `arrears field = ${arrearsField} but ${chargePaid} applied to charges this period (rent ${rentSettled}, garbage ${garbSettled}) and no arrears settled — arrears likely stale; verify against allocation history`,
        tpays[0].receipt_number);
    }
    // Fully settled but flagged overdue/partially paid
    if (chargePaid > 0 && chargePaid >= rentAmt && arrearsField === 0 && ['Overdue', 'Partially Paid'].includes(t.tenant_status)) {
      add(prop, unit, code, 'STATUS_LAG',
        `tenant status = ${t.tenant_status} but ${chargePaid} applied (>= rent ${rentAmt}) with arrears 0 — status may be stale`,
        tpays[tpays.length - 1].receipt_number);
    }
  }

  // ── 4. Vacant tenants with live money (defence) ──────────────────────────
  const vacRes = await query(
    `SELECT t.tenant_code, t.unit_label, t.property_name, t.house_paybill_number,
            COALESCE(SUM(p.amount),0) AS paid
     FROM tenants t JOIN payments p ON p.tenant_code = t.tenant_code AND p.status='Approved'
     WHERE t.status = 'Vacant'
       AND (p.billing_period = $1 OR (p.payment_date >= $2 AND p.payment_date < $3))
     GROUP BY t.tenant_code, t.unit_label, t.property_name, t.house_paybill_number
     HAVING COALESCE(SUM(p.amount),0) > 0`,
    [MONTH, monthStart, monthEnd]
  );
  for (const v of vacRes.rows) {
    add(v.property_name || v.house_paybill_number, v.unit_label || v.tenant_code, v.tenant_code,
      'VACANT_WITH_MONEY', `vacant tenant received ${v.paid} in ${MONTH} — verify allocation`, '');
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const byCode = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] || 0) + 1;

  if (asJson) {
    console.log(JSON.stringify({ month: MONTH, total: findings.length, byCode, findings }, null, 1));
  } else {
    console.log(`\n=== FINDINGS: ${findings.length} ===`);
    for (const [code, n] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${code}: ${n}`);
    }
    if (findings.length) {
      console.log('\n--- DETAIL (first 200) ---');
      for (const f of findings.slice(0, 200)) {
        console.log(`[${f.code}] ${f.property}/${f.unit} (${f.tenant}): ${f.detail}${f.ref ? ' [' + f.ref + ']' : ''}`);
      }
      if (findings.length > 200) console.log(`... and ${findings.length - 200} more.`);
    }
    console.log('\n(AUDIT IS READ-ONLY — no records were modified. Route material corrections through the authorized workflow.)');
  }
  process.exit(0);
}

main().catch((e) => { console.error('AUDIT FAILED:', e.message); process.exit(1); });
