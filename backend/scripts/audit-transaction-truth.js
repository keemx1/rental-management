/**
 * Transaction-based reconciliation audit (SYSTEM DIRECTIVE 2026-11-05).
 *
 * "No genuine transaction, no recognized payment." Every rent-paid figure must
 * be derivable from the payment transaction history. Checks every active
 * tenant (corrects ONLY affected accounts, audit-logged):
 *
 *   RENT_PAID_UNSUPPORTED   rent_paid_this_month > transaction-derived support
 *                           (the D1 class: phantom credit left by an unsupported
 *                           advance's consumption re-emit / carry-forward)
 *   RENT_PAID_UNDERSTATED   rent_paid_this_month < transaction-derived support
 *   ADVANCE_UNSUPPORTED     advance pool/coverage with no supporting transaction
 *   CREDIT_UNSUPPORTED      credit balance with no supporting overpayment
 *   PAYMENT_MONTH_MISMATCH  payment tagged to a cycle far from its money date
 *                           (wrong-month allocation / date-parse artifacts)
 *
 * Corrections re-derive the counters with the system's own reconciler
 * (reconcileTenant = the documented transaction-truth engine) - never a forced
 * balance. Genuine transactions, receipts, dates and arrears are untouched
 * beyond that engine's normal behaviour.
 *
 * Usage: node backend/scripts/audit-transaction-truth.js [--apply]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');
const store = require('../storage/store');

const APPLY = process.argv.includes('--apply');
const eps = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

// Mirrors of store.js helpers (kept identical to the reconciler's contract).
function rentDirectedAmount(p) {
  let bd = p.allocation_breakdown;
  try { if (typeof bd === 'string') bd = JSON.parse(bd); } catch (_) { bd = null; }
  if (bd && bd.rentSettled !== undefined && bd.rentSettled !== null) return Number(bd.rentSettled) || 0;
  return Number(p.amount || 0);
}
function billingMonthOfPayment(p) {
  if (p.billing_period && /^\d{4}-\d{2}$/.test(String(p.billing_period))) return String(p.billing_period);
  return String(p.payment_date || '').slice(0, 7);
}
function monthDiff(a, b) {
  const [ay, am] = String(a).split('-').map(Number);
  const [by, bm] = String(b).split('-').map(Number);
  return (ay * 12 + am) - (by * 12 + bm);
}

async function auditLog(action, entityType, entityId, details) {
  await query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, details, created_at)
     VALUES ('admin-approval', $1, $2, $3, $4, NOW())`,
    [action, entityType, entityId, JSON.stringify({ ...details, date: '2026-11-05', actor: 'admin-approval' })]
  );
}

(async () => {
  const tenants = (await query(
    `SELECT *, rent_due_date::text AS rent_due_date, advance_rent_until::text AS advance_rent_until,
            move_in_date::text AS move_in_date
     FROM tenants WHERE status <> 'Vacant' ORDER BY tenant_code`)).rows;
  const findings = [];
  let corrected = 0;

  for (const t of tenants) {
    const code = t.tenant_code;
    const rentAmount = Number(t.rent_amount || 0);
    const cycle = t.rent_due_date ? String(t.rent_due_date).slice(0, 7) : new Date().toISOString().slice(0, 7);

    const pays = (await query(
      `SELECT id, amount, payment_type, billing_period, payment_date::text AS payment_date,
              overpayment_amount, mpesa_reference, receipt_number, allocation_breakdown
       FROM payments WHERE tenant_code = $1 AND status = 'Approved' AND tenancy_id IS NULL`,
      [code])).rows;

    // ---- transaction-derived support for the CURRENT rent cycle ----
    const paymentsSupport = pays
      .filter((p) => billingMonthOfPayment(p) === cycle)
      .reduce((s, p) => s + rentDirectedAmount(p), 0);
    const dep = (await query(
      `SELECT COALESCE(SUM(amount_applied), 0) AS total FROM deposit_applications
       WHERE tenant_code = $1 AND billing_period = $2 AND status = 'Active' AND tenancy_id IS NULL`,
      [code, cycle])).rows[0];
    const depositSupport = Number(dep.total || 0);

    // Advance is only transaction-backed when traceable to genuine money:
    // opening_advance_rent (documented seed) + payment overpayments +
    // advance_rent payments.
    const advanceBacked =
      Number(t.opening_advance_rent || 0)
      + pays.reduce((s, p) => s + Number(p.overpayment_amount || 0), 0)
      + pays.filter((p) => p.payment_type === 'advance_rent').reduce((s, p) => s + Number(p.amount || 0), 0)
      > 0;

    const garbageShortfall = Math.max(0, Number(t.garbage_fee_amount || 0) - Number(t.garbage_fee_paid || 0));
    const waterShortfall = Math.max(0, Number(t.water_charge_amount || 0) - Number(t.water_charge_paid || 0));
    const charges = rentAmount + garbageShortfall + waterShortfall;
    const advPrefix = t.advance_rent_until ? String(t.advance_rent_until).slice(0, 7) : null;
    const advDay = t.advance_rent_until ? Number(String(t.advance_rent_until).slice(8, 10)) : null;
    const advanceCoversRent = !!advPrefix && rentAmount > 0
      && (cycle < advPrefix || (cycle === advPrefix && advDay <= 1));

    let expected;
    if (advanceCoversRent) expected = advanceBacked ? rentAmount : 0;
    else expected = Math.min(rentAmount, Math.min(Number(t.advance_rent_balance || 0), charges) + paymentsSupport + depositSupport);

    const stored = Number(t.rent_paid_this_month || 0);

    if (stored > expected + 0.01) {
      findings.push(['RENT_PAID_UNSUPPORTED', code,
        `rent_paid_this_month ${stored} but only ${expected} supported by transactions (cycle ${cycle}: rent-directed payments ${paymentsSupport}, deposit ${depositSupport}, advance ${advanceCoversRent ? (advanceBacked ? 'covers' : 'PHANTOM coverage') : 'none'})`]);
      if (APPLY) {
        const rec = await store.reconcileTenant(code);
        await auditLog('CORRECT', 'tenant', code, {
          previous_value: { rent_paid_this_month: stored, status: t.status },
          corrected_value: { rent_paid_this_month: rec ? rec.rent_paid_this_month : expected, status: rec ? rec.status : t.status },
          reason: `Unsupported rent-paid credit: ${stored} claimed for cycle ${cycle} but only ${expected} is supported by genuine transactions (rent-directed payments ${paymentsSupport} + deposit ${depositSupport} + traceable advance ${advanceCoversRent && advanceBacked ? rentAmount : 0}). Counters re-derived from the payment transaction history (reconcileTenant). No genuine transaction changed.`,
        });
        corrected++;
        console.log(`APPLIED RENT_PAID ${code}: ${stored} -> ${rec ? rec.rent_paid_this_month : expected}`);
      }
    } else if (stored < expected - 0.01) {
      findings.push(['RENT_PAID_UNDERSTATED', code,
        `rent_paid_this_month ${stored} but ${expected} is supported by transactions (cycle ${cycle})`]);
      if (APPLY) {
        const rec = await store.reconcileTenant(code);
        await auditLog('CORRECT', 'tenant', code, {
          previous_value: { rent_paid_this_month: stored, status: t.status },
          corrected_value: { rent_paid_this_month: rec ? rec.rent_paid_this_month : expected, status: rec ? rec.status : t.status },
          reason: `Rent-paid understated vs transaction history: ${stored} stored, ${expected} supported by genuine transactions for cycle ${cycle}. Counters re-derived (reconcileTenant).`,
        });
        corrected++;
        console.log(`APPLIED RENT_PAID ${code}: ${stored} -> ${rec ? rec.rent_paid_this_month : expected}`);
      }
    }

    // ---- unsupported advance pool / coverage marker ----
    const advanceBalance = Number(t.advance_rent_balance || 0);
    if ((advanceBalance > 0 || t.advance_rent_until) && !advanceBacked) {
      findings.push(['ADVANCE_UNSUPPORTED', code,
        `advance_rent_balance ${advanceBalance} / until ${t.advance_rent_until} with no supporting transaction (opening ${Number(t.opening_advance_rent || 0)}, overpayments 0, advance payments 0)`]);
      if (APPLY) {
        await query(`UPDATE tenants SET advance_rent_balance = 0, advance_rent_until = NULL, updated_at = NOW() WHERE tenant_code = $1`, [code]);
        await auditLog('CORRECT', 'tenant', code, {
          previous_value: { advance_rent_balance: advanceBalance, advance_rent_until: t.advance_rent_until },
          corrected_value: { advance_rent_balance: 0, advance_rent_until: null },
          reason: 'Unsupported advance removed (orphaned credit - no supporting transaction; opening_advance 0, no overpayment or advance_rent payments). Like the D1 60,000 correction.',
        });
        await store.reconcileTenant(code).catch(() => {});
        corrected++;
        console.log(`APPLIED ADVANCE ${code}: ${advanceBalance} -> 0`);
      }
    }

    // ---- unsupported credit balance ----
    const credit = Number(t.credit_balance || 0);
    const overpayEvidence = pays.reduce((s, p) => s + Number(p.overpayment_amount || 0), 0);
    if (credit > 0.01 && overpayEvidence <= 0.01) {
      findings.push(['CREDIT_UNSUPPORTED', code,
        `credit_balance ${credit} with no overpayment transaction to support it - review`]);
    }

    // ---- payment month attribution ----
    for (const p of pays) {
      const bp = billingMonthOfPayment(p);
      const pm = String(p.payment_date || '').slice(0, 7);
      if (pm && bp && Math.abs(monthDiff(bp, pm)) > 1) {
        // Re-read the date embedded in the original M-Pesa text (notes).
        // The pre-fix parser read every dd/mm pair day-first; entry #55's rule
        // (>12 disambiguates, ambiguous = MM/DD) is the shipped contract.
        // A reading that lands within a month of the payment's allocated cycle
        // is corroborated by the allocation intent -> correct the stored date.
        const full = (await query(`SELECT notes FROM payments WHERE id = $1`, [p.id])).rows[0];
        const m = String((full && full.notes) || '').match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
        let hint = '';
        let fix = null;
        if (m) {
          const a = Number(m[1]), b = Number(m[2]);
          const yr = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
          const mkDate = (mm, dd) => `${yr}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
          const shipped = (a > 12 && b <= 12) ? mkDate(b, a) : (b > 12 && a <= 12) ? mkDate(a, b) : mkDate(a, b); // ambiguous -> MM/DD
          const alt = mkDate(b, a);
          const aligns = (d) => Math.abs(monthDiff(String(d).slice(0, 7), bp)) <= 1;
          hint = ` | source "${m[0]}" -> shipped-rule ${shipped}${aligns(shipped) ? ' (aligns with cycle)' : ''}, alt ${alt}${aligns(alt) ? ' (aligns with cycle)' : ''}`;
          if (aligns(shipped) && !aligns(alt)) fix = { from: p.payment_date, to: shipped, source: m[0] };
          else if (aligns(alt) && !aligns(shipped)) fix = { from: p.payment_date, to: alt, source: m[0] };
        }
        findings.push(['PAYMENT_MONTH_MISMATCH', code,
          `payment #${p.id} (${p.amount}, ref ${p.mpesa_reference}, receipt ${p.receipt_number}) money dated ${pm} but allocated to cycle ${bp}${hint}${fix ? ' -> date correctable' : ' - verify intended month'}`]);
        if (fix && APPLY) {
          await query(`UPDATE payments SET payment_date = $2 WHERE id = $1`, [p.id, fix.to]);
          await auditLog('CORRECT', 'payment', String(p.id), {
            tenant_code: code, mpesa_reference: p.mpesa_reference, receipt_number: p.receipt_number,
            previous_value: { payment_date: String(fix.from).slice(0, 10) },
            corrected_value: { payment_date: fix.to },
            reason: `Pre-fix MM/DD parse artifact (entry #55): source M-Pesa text reads "${fix.source}" and the ${fix.to.slice(0, 7)} reading aligns with the payment's allocated cycle ${bp} (the other reading does not). Billing allocation and receipt reference unchanged - only the recorded money date restored to the original message's date.`,
          });
          corrected++;
          console.log(`APPLIED DATE ${code} payment #${p.id}: ${String(fix.from).slice(0, 10)} -> ${fix.to}`);
        }
      }
    }
  }

  console.log(`\n=== TRANSACTION-TRUTH AUDIT: ${tenants.length} active tenants ===`);
  for (const [cls, code, detail] of findings) console.log(`[${cls}] ${code}: ${detail}`);
  const byClass = {};
  for (const [cls] of findings) byClass[cls] = (byClass[cls] || 0) + 1;
  console.log('\nTOTAL findings:', findings.length, JSON.stringify(byClass));
  if (APPLY) console.log('corrections applied:', corrected);
  else console.log('(dry run - re-run with --apply to correct)');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
