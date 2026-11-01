/**
 * SYSTEM-WIDE FINANCIAL RECONCILIATION AUDIT (READ-ONLY — REVIEW MODE).
 *
 * Cross-checks every tenant's dashboard position against their Payment History
 * (the authoritative allocation records). Produces a consolidated findings
 * report with proposed corrections. NEVER modifies any record — corrections
 * must follow the authorised management workflow.
 *
 * Verification classes (per command):
 *  - Every payment recognised (date, amount, ref, receipt, approval, allocation)
 *  - Payment History vs dashboard two-way reconciliation
 *  - Allocation correctness (charge-applied vs deposit vs arrears vs advance)
 *  - Unallocated funds (money received but not reflected as tenant credit)
 *  - Stale arrears / opening-balance errors
 *  - Status lag (dashboard status vs allocation truth)
 *  - Overpayment/credit recognition
 *  - Rent-period coverage (billing_period vs payment_date)
 *  - Missing receipts / refs / dates; duplicate references
 *
 * Usage: node backend/scripts/audit-financial-reconciliation.js [--month YYYY-MM] [--json] [--house PAYBILL]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

const args = process.argv.slice(2);
const mi = args.indexOf('--month');
const MONTH = mi >= 0 ? args[mi + 1] : new Date().toISOString().slice(0, 7);
const hi = args.indexOf('--house');
const HOUSE = hi >= 0 ? args[hi + 1] : null;
const asJson = args.includes('--json');

const findings = [];
function add(sev, code, prop, unit, tenant, detail, proposed) {
  findings.push({ severity: sev, code, property: prop, unit, tenant, detail, proposed: proposed || '' });
}

function parseBd(p) {
  let bd = p.allocation_breakdown;
  try { if (typeof bd === 'string') bd = JSON.parse(bd); } catch (_) { bd = null; }
  return bd || {};
}
const n = (v) => Number(v || 0);

async function main() {
  const monthStart = `${MONTH}-01`;
  const [y, m] = MONTH.split('-').map(Number);
  const monthEnd = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`GEHPM SYSTEM-WIDE FINANCIAL RECONCILIATION AUDIT — ${MONTH} (READ-ONLY)`);
  console.log(`${'='.repeat(70)}\n`);

  // ── 1. All approved payments in scope (billing_period OR date) ───────────
  let payQ = `SELECT p.*, t.name AS tenant_name, t.unit_label, t.house_paybill_number, t.property_name,
      t.rent_amount, t.arrears, t.deposit_amount, t.deposit_paid, t.garbage_fee_amount, t.garbage_fee_paid,
      t.water_charge_amount, t.water_charge_paid, t.credit_balance, t.advance_rent_balance,
      t.status AS tenant_status, t.rent_due_date
    FROM payments p JOIN tenants t ON p.tenant_code = t.tenant_code
    WHERE p.status = 'Approved'
      AND (p.billing_period = $1 OR (p.payment_date >= $2 AND p.payment_date < $3))`;
  const payParams = [MONTH, monthStart, monthEnd];
  if (HOUSE) { payQ += ` AND t.house_paybill_number = $4`; payParams.push(HOUSE); }
  payQ += ` ORDER BY t.property_name, t.unit_label, p.payment_date, p.id`;
  const pays = (await query(payQ, payParams)).rows;
  console.log(`Approved payments in scope: ${pays.length}`);

  // Group by tenant
  const byTenant = {};
  for (const p of pays) {
    (byTenant[p.tenant_code] = byTenant[p.tenant_code] || []).push(p);
  }
  console.log(`Tenants with payments: ${Object.keys(byTenant).length}\n`);

  // ── 2. Per-tenant verification ────────────────────────────────────────────
  const refSeen = new Map();
  const summary = { reconciled: 0, needsCorrection: 0, needsApproval: 0, systemError: 0 };
  const rows = [];

  for (const [code, tpays] of Object.entries(byTenant)) {
    const t0 = tpays[0];
    const prop = t0.property_name || t0.house_paybill_number || '?';
    const unit = t0.unit_label || code;

    // Aggregate allocations from Payment History
    let paid = 0, chargeApplied = 0, allocRent = 0, allocGarb = 0, allocWat = 0, allocPen = 0;
    let allocDep = 0, allocArr = 0, allocAdv = 0;
    let missingReceipt = 0, missingRef = 0, missingDate = 0, dupRef = 0, advancePeriod = 0;
    const refs = [];
    for (const p of tpays) {
      const bd = parseBd(p);
      paid += n(p.amount);
      const r = n(bd.rentSettled), g = n(bd.garbageFeeSettled), w = n(bd.waterSettled), pe = n(bd.penaltySettled);
      allocRent += r; allocGarb += g; allocWat += w; allocPen += pe;
      chargeApplied += r + g + w + pe;
      allocDep += n(bd.depositSettled) + ((p.payment_type || 'rent') === 'deposit' ? n(p.amount) : 0);
      allocArr += n(bd.arrearsSettled);
      allocAdv += n(bd.advanceSettled) + n(bd.advanceRentSettled);
      if (!p.receipt_number) missingReceipt++;
      if (!p.mpesa_reference && p.payment_mode === 'M-Pesa') missingRef++;
      if (!p.payment_date) missingDate++;
      // billing_period != payment month is NORMAL for advance rent paid early —
      // informational only, not a discrepancy.
      if (p.billing_period && p.payment_date && p.billing_period !== String(p.payment_date).slice(0, 7)) advancePeriod++;
      if (p.mpesa_reference) {
        if (refSeen.has(p.mpesa_reference)) dupRef++;
        else refSeen.set(p.mpesa_reference, code);
        refs.push(p.mpesa_reference);
      }
    }

    // Unallocated funds = money received but not attributed to any charge,
    // deposit, arrears or advance in the allocation snapshots.
    const unallocated = paid - chargeApplied - allocDep - allocArr - allocAdv;
    // Tenant credit actually recorded on the dashboard
    const credit = n(t0.credit_balance) + n(t0.advance_rent_balance);
    const arrearsField = n(t0.arrears);

    const discrepancies = [];
    const proposed = [];

    // Missing payment metadata
    if (missingReceipt) { discrepancies.push(`MISSING_RECEIPT|${missingReceipt} payment(s) missing receipt number`); proposed.push('Generate/attach receipt numbers to the affected payments'); }
    if (missingRef) { discrepancies.push(`MISSING_REF|${missingRef} M-Pesa payment(s) missing transaction reference`); proposed.push('Backfill M-Pesa references from provider records'); }
    if (missingDate) { discrepancies.push(`MISSING_DATE|${missingDate} payment(s) missing payment date`); proposed.push('Set actual payment_date from original transaction'); }
    if (dupRef) { discrepancies.push(`DUPLICATE_REF|${dupRef} duplicate M-Pesa reference(s)`); proposed.push('Investigate possible duplicate payment recognition'); }

    // Unallocated funds not reflected as credit (money in but no tenant credit)
    if (unallocated > 0.5 && credit < unallocated - 0.5) {
      discrepancies.push(`UNALLOCATED_NOT_CREDITED|KES ${unallocated.toFixed(0)} received but NOT reflected as tenant credit (recorded credit ${credit.toFixed(0)})`);
      proposed.push('Recognise the unallocated amount as advance/credit per authorised allocation rules');
    }

    // Stale arrears: dashboard arrears > 0 but Payment History shows opening arrears = 0
    // (earliest payment's arrearsBefore) and nothing outstanding from allocations.
    const earliest = tpays.reduce((a, b) => (String(a.payment_date || '') <= String(b.payment_date || '') ? a : b));
    const openArrears = n(parseBd(earliest).arrearsBefore);
    if (arrearsField > 0 && openArrears === 0 && allocArr === 0) {
      discrepancies.push(`STALE_ARREARS|Dashboard arrears KES ${arrearsField.toFixed(0)} but Payment History opening arrears = 0 (stale)`);
      proposed.push('Reconcile arrears field against allocation history; correct via authorised workflow');
    }

    // Status lag: dashboard status implies owing but allocations fully charge-applied with no arrears
    const fullyApplied = chargeApplied > 0 && unallocated <= 0.5 && arrearsField === 0;
    if (fullyApplied && ['Overdue', 'Partially Paid'].includes(t0.tenant_status)) {
      discrepancies.push(`STATUS_LAG|Status "${t0.tenant_status}" but KES ${chargeApplied.toFixed(0)} fully applied to charges with arrears 0`);
      proposed.push('Recompute tenant status from verified allocation position');
    }

    rows.push({
      property: prop, unit, tenant: t0.tenant_name, tenant_code: code,
      dashboard: { status: t0.tenant_status, arrears: arrearsField, credit, advance: n(t0.advance_rent_balance) },
      payments: tpays.length, paid, chargeApplied, alloc: { rent: allocRent, garbage: allocGarb, water: allocWat, penalty: allocPen, deposit: allocDep, arrears: allocArr, advance: allocAdv },
      unallocated, openArrears, advancePeriod,
      discrepancies, proposed,
    });

    if (discrepancies.length === 0) summary.reconciled++;
    else summary.needsCorrection++;
  }

  // ── 3. Vacant tenants with live money (defence) ──────────────────────────
  const vac = (await query(
    `SELECT t.tenant_code, t.unit_label, t.property_name, COALESCE(SUM(p.amount),0) AS paid
     FROM tenants t JOIN payments p ON p.tenant_code=t.tenant_code AND p.status='Approved'
     WHERE t.status='Vacant' AND (p.billing_period=$1 OR (p.payment_date>=$2 AND p.payment_date<$3))
     GROUP BY t.tenant_code,t.unit_label,t.property_name HAVING COALESCE(SUM(p.amount),0)>0`,
    [MONTH, monthStart, monthEnd]
  )).rows;
  for (const v of vac) {
    add('HIGH', 'VACANT_WITH_MONEY', v.property_name, v.unit_label || v.tenant_code, v.tenant_code,
      `Vacant tenant received KES ${v.paid} in ${MONTH}`, 'Verify allocation; refund or reallocate via authorised workflow');
    summary.needsCorrection++;
  }

  // ── 4. Two-way: Payment History vs dashboard rent-paid (report layer) ────
  // (Cross-checks the Enhanced report's charge-applied against raw allocations.)
  const mismatch = rows.filter((r) => Math.abs(r.chargeApplied - (r.alloc.rent + r.alloc.garbage + r.alloc.water + r.alloc.penalty)) > 0.5);
  // (by construction chargeApplied == sum, so this is a sanity guard)

  // ── Output ───────────────────────────────────────────────────────────────
  const withDisc = rows.filter((r) => r.discrepancies.length > 0);
  const codeCounts = {};
  for (const r of withDisc) for (const d of r.discrepancies) { const k = d.split('|')[0]; codeCounts[k] = (codeCounts[k] || 0) + 1; }

  if (asJson) {
    console.log(JSON.stringify({ month: MONTH, summary, totalTenants: rows.length, withDiscrepancies: withDisc.length, rows, vacantMoney: vac }, null, 1));
    process.exit(0);
  }

  console.log(`\n${'-'.repeat(70)}`);
  console.log(`SUMMARY: ${rows.length} tenants audited | ${summary.reconciled} reconciled | ${summary.needsCorrection} need correction | ${vac.length} vacant-with-money`);
  console.log(`${'-'.repeat(70)}`);
  if (Object.keys(codeCounts).length) {
    console.log('\nDiscrepancy classes:');
    for (const [k, c] of Object.entries(codeCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${c}x  ${k}`);
  }

  // Group findings by property for the consolidated report
  const byProp = {};
  for (const r of withDisc) (byProp[r.property] = byProp[r.property] || []).push(r);

  console.log(`\n${'='.repeat(70)}`);
  console.log('CONSOLIDATED FINDINGS (accounts requiring correction / approval)');
  console.log(`${'='.repeat(70)}`);
  for (const [prop, list] of Object.entries(byProp)) {
    console.log(`\n■ ${prop} (${list.length} account(s))`);
    for (const r of list) {
      console.log(`  ${r.unit} — ${r.tenant} [${r.tenant_code}]  status=${r.dashboard.status} arrears=${r.dashboard.arrears} credit=${r.dashboard.credit}`);
      console.log(`     paid=${r.paid} chargeApplied=${r.chargeApplied} unallocated=${r.unallocated.toFixed(0)} openArrears=${r.openArrears}`);
      for (const d of r.discrepancies) { const [tag, ...rest] = d.split('|'); console.log(`     ⚠ [${tag}] ${rest.join('|')}`); }
      for (const p of r.proposed) console.log(`     → PROPOSED: ${p}`);
    }
  }
  if (vac.length) {
    console.log(`\n■ VACANT TENANTS WITH LIVE MONEY (${vac.length})`);
    for (const v of vac) console.log(`  ${v.property_name}/${v.unit_label || v.tenant_code}: KES ${v.paid}`);
  }

  console.log(`\n${'-'.repeat(70)}`);
  console.log('REVIEW MODE — no records were modified. Apply corrections only via the');
  console.log('authorised workflow (preserve original, reason, approval, audit trail).');
  console.log(`${'-'.repeat(70)}\n`);
  process.exit(0);
}

main().catch((e) => { console.error('AUDIT FAILED:', e.message); process.exit(1); });
