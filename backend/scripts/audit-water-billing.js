/**
 * Water billing audit + evidence-based correction of legacy bundled invoices.
 *
 * Background: the old "MONTHLY RENT & UTILITY" water rows bundled rent +
 * garbage + water into one total. Water billing now uses WATER-ONLY invoices
 * (no rent/garbage/non-water component); bundled rows are excluded from every
 * billing figure. This script audits every water invoice against its
 * invoice_register twin and the tenant's payments, then (with --apply)
 * corrects only what the evidence proves:
 *
 *   CLASS A - reopen:  water-only row marked Paid with NO supporting payment
 *             (e.g. marked by a since-deleted payment) -> back to Sent.
 *   CLASS B - discharge: bundled row whose rent+garbage+water components were
 *             fully collected by the tenant's payment for its payment_month
 *             -> Paid. Plus named management write-offs (SS6).
 *   Everything else stays untouched and is FLAGGED for management review.
 *
 * Usage: node backend/scripts/audit-water-billing.js [--apply]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

const APPLY = process.argv.includes('--apply');
const eps = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

function component(w) {
  const num = (v) => Number(v || 0);
  return {
    rent: num(w.rent_amount),
    garbage: num(w.garbage_fee),
    water: Math.max(0, num(w.total_amount_payable || w.total_amount)
      - num(w.rent_amount) - num(w.garbage_fee)
      - num(w.rent_arrears) - num(w.garbage_arrears) - num(w.other_arrears)
      - Math.max(0, num(w.total_previous_outstanding) - num(w.water_arrears))),
  };
}
const isBundled = (w) => Number(w.rent_amount || 0) > 0 || Number(w.garbage_fee || 0) > 0
  || Number(w.rent_arrears || 0) > 0 || Number(w.garbage_arrears || 0) > 0 || Number(w.other_arrears || 0) > 0;

async function auditLog(actor, action, entityType, entityId, details) {
  await query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, details, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [actor, action, entityType, entityId, JSON.stringify(details)]
  );
}

(async () => {
  const rows = (await query(`
    SELECT w.*, ir.id AS twin_id, ir.amount AS twin_amount, ir.amount_paid AS twin_paid,
           GREATEST(0, COALESCE(ir.amount, 0) - COALESCE(ir.amount_paid, 0)) AS twin_balance, COALESCE(ir.voided, false) AS twin_voided,
           ir.voided_reason AS twin_voided_reason
    FROM water_invoices w
    LEFT JOIN invoice_register ir ON ir.invoice_number = w.wtr_number AND ir.invoice_type = 'water'
    ORDER BY w.tenant_code, w.billing_month, w.id`)).rows;

  const bundled = rows.filter(isBundled);
  const only = rows.filter((w) => !isBundled(w));
  console.log(`\n=== WATER INVOICE AUDIT (${rows.length} rows: ${bundled.length} legacy bundled, ${only.length} water-only) ===\n`);

  // ---------- water-only integrity ----------
  const issues = [];
  for (const w of only) {
    const label = `${w.tenant_code} ${w.wtr_number}`;
    if (!w.twin_id) issues.push(['ORPHAN_ROW', label, `water-only row has no invoice_register twin (status ${w.status}, payable ${w.total_amount_payable})`]);
    else if (w.twin_voided && w.status !== 'Void') issues.push(['TWIN_VOIDED', label, `register twin voided but row status=${w.status}`]);
    else if (!w.twin_voided) {
      const bal = Number(w.twin_balance || 0);
      const paid = Number(w.twin_paid || 0);
      if (w.status === 'Paid' && bal > 0) issues.push(['STATUS_DESYNC', label, `status=Paid but register balance_due=${bal} (paid ${paid})`]);
      if (w.status !== 'Paid' && w.status !== 'Void' && bal <= 0 && paid > 0) issues.push(['STATUS_DESYNC', label, `status=${w.status} but register fully settled (paid ${paid})`]);
    }
    const total = Number(w.total_amount_payable || w.total_amount || 0);
    if (eps(total, 0)) issues.push(['ZERO_INVOICE', label, 'water-only invoice with zero total']);
  }

  // supporting-payment evidence per tenant
  const pays = (await query(
    `SELECT tenant_code, id, amount, billing_period, payment_date::text AS payment_date,
            receipt_number, allocation_breakdown
     FROM payments WHERE status = 'Approved' AND tenancy_id IS NULL`)).rows;
  const payByTenant = {};
  for (const p of pays) (payByTenant[p.tenant_code] = payByTenant[p.tenant_code] || []).push(p);
  const allocSum = (p) => {
    const a = p.allocation_breakdown || {};
    return ['rentSettled', 'garbageFeeSettled', 'waterSettled', 'penaltySettled', 'maintenanceSettled', 'otherSettled', 'arrearsSettled', 'agreementSettled']
      .reduce((s, k) => s + Number(a[k] || 0), 0);
  };
  const totalWaterSettled = (code) => (payByTenant[code] || [])
    .reduce((s, p) => s + Number((p.allocation_breakdown || {}).waterSettled || 0), 0);

  // ---------- CLASS A: unsupported Paid water-only rows ----------
  const classA = [];
  const classC = [];
  for (const w of only) {
    if (w.status !== 'Paid' || !w.twin_id || w.twin_voided) continue;
    const bal = Number(w.twin_balance || 0);
    if (!(bal > 0)) continue;
    const links = (await query(
      `SELECT COUNT(*)::int AS n FROM invoice_payment_links WHERE invoice_id = $1`, [w.twin_id])).rows[0].n;
    const waterPays = (payByTenant[w.tenant_code] || []).filter((p) => Number((p.allocation_breakdown || {}).waterSettled || 0) > 0);
    const exact = waterPays.length === 1
      && eps(Number((waterPays[0].allocation_breakdown || {}).waterSettled || 0), bal)
      && waterPays[0].tenant_code === w.tenant_code;
    const noOtherOpen = only.filter((x) => x.tenant_code === w.tenant_code && x !== w
      && x.status !== 'Void' && x.status !== 'Paid' && Number(x.twin_balance || 0) > 0
      && Number(x.id) < Number(w.id)).length === 0;
    if (links === 0 && waterPays.length === 0) {
      classA.push(w);
      issues.push(['CLASS_A_REOPEN', `${w.tenant_code} ${w.wtr_number}`, `Paid with no supporting payment/link (register balance ${bal}) -> reopen to Sent`]);
    } else if (links === 0 && exact && noOtherOpen) {
      classC.push({ w, pay: waterPays[0] });
      issues.push(['CLASS_C_RELINK', `${w.tenant_code} ${w.wtr_number}`,
        `Paid by payment #${waterPays[0].id} (${waterPays[0].receipt_number}) waterSettled ${bal} but the invoice link is missing -> restore link + settle register`]);
    } else {
      issues.push(['REVIEW', `${w.tenant_code} ${w.wtr_number}`, `Paid but register balance ${bal} (links=${links}, waterPays=${waterPays.length}) - manual review`]);
    }
  }

  // ---------- CLASS D: water row out of sync with a voided register twin ----------
  const classD = [];
  for (const w of only) {
    if (w.twin_voided && w.status !== 'Void') {
      classD.push(w);
      issues.push(['CLASS_D_VOID_SYNC', `${w.tenant_code} ${w.wtr_number}`, `register twin voided (${w.twin_voided_reason || 'no reason recorded'}) but row status=${w.status} -> Void`]);
    }
  }

  // ---------- CLASS B: bundled rows with full settlement evidence ----------
  const classB = [];
  const named = {
    SS6: 'Management write-off 2026-11-05: rent 9,000 + garbage 200 collected via GEHPM-RCT-202610-001366 (9,200); water 100.80 not owed per management (verified outstanding = Nov billing 12,380 incl. water-only GEHPM-WTR-202610-000123 180).',
  };
  for (const w of bundled) {
    if (w.status === 'Paid' || w.status === 'Void') continue;
    const total = Number(w.total_amount_payable || w.total_amount || 0);
    const payM = String(w.payment_month || w.billing_month || '').slice(0, 7);
    const candidate = (payByTenant[w.tenant_code] || []).find((p) => {
      const sameCycle = String(p.billing_period || '').slice(0, 7) === payM;
      return sameCycle && allocSum(p) + 0.01 >= total;
    });
    if (candidate) {
      classB.push({ w, candidate });
      issues.push(['CLASS_B_DISCHARGE', `${w.tenant_code} ${w.wtr_number}`,
        `bundled ${total} fully collected by payment #${candidate.id} (${candidate.receipt_number}) alloc ${allocSum(candidate)} -> Paid`]);
    } else if (named[w.tenant_code] && w.billing_month === '2026-09') {
      classB.push({ w, candidate: null });
      issues.push(['CLASS_B_WRITEOFF', `${w.tenant_code} ${w.wtr_number}`, named[w.tenant_code]]);
    } else {
      issues.push(['OPEN_BUNDLED', `${w.tenant_code} ${w.wtr_number}`,
        `legacy bundled ${total} (rent ${Number(w.rent_amount || 0)}, garbage ${Number(w.garbage_fee || 0)}, water ${component(w).water}) still open - excluded from billing; management review`]);
    }
  }

  // ---------- current billing verification (all occupied tenants) ----------
  const tenants = (await query(`
    SELECT tenant_code, name, property_name, house_paybill_number, status, rent_amount,
           rent_paid_this_month, garbage_fee_amount, garbage_fee_paid, water_charge_amount,
           water_charge_paid, arrears, rent_due_date::text AS rent_due_date
    FROM tenants WHERE status <> 'Vacant'
    ORDER BY property_name, tenant_code`)).rows;
  console.log('--- current-billing water verification (occupied tenants) ---');
  let bad = 0;
  for (const t of tenants) {
    const open = only.filter((w) => w.tenant_code === t.tenant_code && w.status !== 'Paid' && w.status !== 'Void');
    const openBundled = bundled.filter((w) => w.tenant_code === t.tenant_code && w.status !== 'Paid' && w.status !== 'Void');
    const waterOwed = Math.max(0, Number(t.water_charge_amount || 0) - Number(t.water_charge_paid || 0))
      + open.reduce((s, w) => s + (w.twin_id
        ? Number(w.twin_balance || 0)
        : Number(w.total_amount_payable ?? w.total_amount ?? 0)), 0);
    const billing = Number(t.rent_amount || 0) + Math.max(0, Number(t.garbage_fee_amount || 0) - Number(t.garbage_fee_paid || 0)) + waterOwed;
    if (openBundled.length || open.length) {
      console.log(`  ${t.tenant_code} (${t.property_name}): water owed ${waterOwed} | current billing ${billing}`
        + ` | open water-only: ${open.map((w) => w.wtr_number).join(',') || '-'}`
        + ` | OPEN BUNDLED: ${openBundled.map((w) => w.wtr_number + '=' + w.total_amount_payable).join(',') || '-'}`);
    }
    if (openBundled.length) bad++;
  }
  console.log(`  (${bad} occupied tenants still carry open legacy bundled rows)\n`);

  // ---------- report ----------
  for (const [code, label, detail] of issues) console.log(`[${code}] ${label}: ${detail}`);
  console.log(`\nTOTAL findings: ${issues.length} (reopen ${classA.length}, discharge ${classB.length}, `
    + `relink ${classC.length}, void-sync ${classD.length}, `
    + `review/open ${issues.filter((i) => i[0] === 'REVIEW' || i[0] === 'OPEN_BUNDLED').length}, integrity ${issues.filter((i) => ['ORPHAN_ROW', 'TWIN_VOIDED', 'STATUS_DESYNC', 'ZERO_INVOICE'].includes(i[0])).length})`);

  if (!APPLY) {
    console.log('\n(dry run - re-run with --apply to write the CLASS A/B corrections)');
    process.exit(0);
  }

  // ---------- apply ----------
  for (const w of classA) {
    const before = w.status;
    await query(`UPDATE water_invoices SET status = 'Sent', updated_at = NOW() WHERE id = $1`, [w.id]);
    await auditLog('admin-approval', 'CORRECT', 'water_invoice', String(w.id), {
      wtr_number: w.wtr_number, tenant_code: w.tenant_code,
      previous_value: before, corrected_value: 'Sent',
      reason: 'Status Paid had no supporting payment (invoice links none, tenant waterSettled 0) - e.g. marked by a since-deleted payment. Reopened; register balance_due ' + Number(w.twin_balance || 0) + ' remains owed.',
      date: '2026-11-05', actor: 'admin-approval',
    });
    console.log(`APPLIED CLASS A: ${w.tenant_code} ${w.wtr_number} Paid -> Sent`);
  }
  for (const { w, pay } of classC) {
    const amount = Number(w.twin_balance || 0);
    await query(
      `INSERT INTO invoice_payment_links (invoice_id, payment_id, amount)
       VALUES ($1, $2, $3)
       ON CONFLICT (invoice_id, payment_id) DO UPDATE SET amount = invoice_payment_links.amount + EXCLUDED.amount`,
      [w.twin_id, pay.id, amount]);
    await query(
      `UPDATE invoice_register SET amount_paid = COALESCE(amount_paid, 0) + $2,
             balance_due = COALESCE(amount, 0) - (COALESCE(amount_paid, 0) + $2),
             last_payment_id = $3, updated_at = NOW()
       WHERE id = $1`, [w.twin_id, amount, pay.id]);
    await query(
      `UPDATE invoice_register SET balance_due = COALESCE(amount, 0) - COALESCE(amount_paid, 0) WHERE id = $1`,
      [w.twin_id]);
    await auditLog('admin-approval', 'CORRECT', 'water_invoice', String(w.id), {
      wtr_number: w.wtr_number, tenant_code: w.tenant_code,
      previous_value: `register unpaid (amount_paid 0) with water_invoices status Paid`,
      corrected_value: `register settled ${amount} via payment #${pay.id} + link restored`,
      reason: `Payment ${pay.id} (${pay.receipt_number}, ref ${pay.mpesa_reference}) was approved with allocation waterSettled=${amount} (the full invoice) but the Invoice Center link was never written (invoice predates linking / link lost). Money was collected - restoring the link and the register balance to match the approved payment.`,
      date: '2026-11-05', actor: 'admin-approval',
    });
    console.log(`APPLIED CLASS C: ${w.tenant_code} ${w.wtr_number} linked to payment #${pay.id} (${amount})`);
  }
  for (const w of classD) {
    await query(`UPDATE water_invoices SET status = 'Void', void_reason = COALESCE(void_reason, $2), updated_at = NOW() WHERE id = $1`,
      [w.id, `Register twin voided${w.twin_voided_reason ? `: ${w.twin_voided_reason}` : ''} - status synced 2026-11-05.`]);
    await auditLog('admin-approval', 'CORRECT', 'water_invoice', String(w.id), {
      wtr_number: w.wtr_number, tenant_code: w.tenant_code,
      previous_value: w.status, corrected_value: 'Void',
      reason: `Register twin is voided (${w.twin_voided_reason || 'no reason recorded'}) but the water row still showed ${w.status}. Status synced so the row is excluded from billing/listings like its twin.`,
      date: '2026-11-05', actor: 'admin-approval',
    });
    console.log(`APPLIED CLASS D: ${w.tenant_code} ${w.wtr_number} ${w.status} -> Void`);
  }
  for (const { w, candidate } of classB) {
    const before = w.status;
    await query(`UPDATE water_invoices SET status = 'Paid', updated_at = NOW() WHERE id = $1`, [w.id]);
    await auditLog('admin-approval', 'CORRECT', 'water_invoice', String(w.id), {
      wtr_number: w.wtr_number, tenant_code: w.tenant_code,
      previous_value: before, corrected_value: 'Paid',
      reason: candidate
        ? `Legacy bundled rent+utility invoice fully collected by payment #${candidate.id} (${candidate.receipt_number}, alloc ${allocSum(candidate)} = ${Number(w.total_amount_payable || w.total_amount || 0)}). Excluded from water billing (rent/garbage charged in the rent cycle).`
        : named[w.tenant_code],
      date: '2026-11-05', actor: 'admin-approval',
    });
    console.log(`APPLIED CLASS B: ${w.tenant_code} ${w.wtr_number} ${before} -> Paid`);
  }
  for (const [code, label, detail] of issues.filter((i) => i[0] === 'REVIEW' || i[0] === 'OPEN_BUNDLED' || i[0] === 'STATUS_DESYNC' || i[0] === 'ORPHAN_ROW')) {
    await auditLog('admin-approval', 'FLAGGED_INCONSISTENCY', 'water_invoice', label, {
      code, detail, date: '2026-11-05', actor: 'admin-approval',
    });
  }
  console.log('Done.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
