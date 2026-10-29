'use strict';

/**
 * Central Notification Bar — LIVE detection from existing records.
 *
 * Principles (per proposal):
 *  - alerts are COMPUTED from underlying records; this module never changes
 *    any financial balance, approval or ledger — it only reports and links
 *  - viewing an alert never resolves it; only the underlying record clearing
 *    does (auto-resolve on the next scan)
 *  - one Open row per issue identity (deduped); resolved rows keep history
 *  - emergency (pulsing red) = any critical OR overdue alert
 */

const store = require('../storage/store');
const commission = require('./landlordCommission');

const PRIORITIES = ['critical', 'overdue', 'due_soon', 'pending', 'review'];
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

function alert(priority, issue_type, key, title, details, amount, link) {
  return { priority, issue_type, key, title, details: details || {}, amount: amount != null ? round2(amount) : null, link };
}

// ── Detection across existing modules ───────────────────────────────────────
async function detect() {
  const { query } = require('../config/database');
  const alerts = [];
  const t = today();

  // A. Tenant rent arrears / partial balances (dashboard arithmetic)
  try {
    const rows = (await query(
      `SELECT tenant_code, name, property_name, arrears, rent_amount, rent_paid_this_month, rent_due_date::text AS rent_due_date, status
         FROM tenants
        WHERE status <> 'Vacant' AND arrears > 0
        ORDER BY arrears DESC LIMIT 25`
    )).rows;
    for (const r of rows) {
      const remaining = Math.max(0, Number(r.rent_amount || 0) - Number(r.rent_paid_this_month || 0));
      alerts.push(alert('overdue', 'tenant_arrears', `arrears:${r.tenant_code}`,
        `Rent arrears — ${r.name}`,
        {
          issue_type: 'Tenant rent arrears',
          property: r.property_name || '', unit: r.tenant_code, party: r.name,
          amount: Number(r.arrears), due_date: r.rent_due_date || null,
          balance: round2(Number(r.arrears) + remaining),
          reason: `Arrears of KES ${Number(r.arrears).toLocaleString()} carried on the tenant account`,
          status: r.status, action: 'Review the tenant ledger and collect or correct the balance.',
        },
        Number(r.arrears), { kind: 'tenant', id: r.tenant_code }));
    }
  } catch (_) {}

  // B. Payments awaiting approval
  try {
    const rows = (await query(
      `SELECT p.id, p.tenant_code, p.amount, p.payment_date::text AS payment_date, p.mpesa_reference, t.name, t.property_name
         FROM payments p LEFT JOIN tenants t ON t.tenant_code = p.tenant_code
        WHERE p.status = 'Pending' ORDER BY p.payment_date ASC LIMIT 20`
    )).rows;
    for (const r of rows) {
      alerts.push(alert('pending', 'payment_approval', `pending_payment:${r.id}`,
        `Payment awaiting approval — ${r.name || r.tenant_code}`,
        {
          issue_type: 'Payment awaiting approval',
          property: r.property_name || '', unit: r.tenant_code, party: r.name || r.tenant_code,
          amount: Number(r.amount), date: r.payment_date, reference: r.mpesa_reference || null,
          reason: 'Approved payments feed rent collections; this one is still Pending.',
          status: 'Awaiting Approval', action: 'Open Payments, review and approve or reject.',
        },
        Number(r.amount), { kind: 'payments' }));
    }
  } catch (_) {}

  // C/D. Landlord accounts: remittances, MFI invoices, reconciliation, reviews
  const houses = (await query(
    `SELECT h.paybill_number, h.house_name, h.landlord_id FROM houses h WHERE h.landlord_id IS NOT NULL`
  )).rows;
  const openReviewsByHouse = {};
  try {
    const revs = (await query(
      `SELECT id, house_paybill_number, billing_month, reason FROM landlord_reviews WHERE status = 'Under Review'`
    )).rows;
    for (const rv of revs) (openReviewsByHouse[rv.house_paybill_number] ||= []).push(rv);
    for (const rv of revs) {
      alerts.push(alert('review', 'landlord_review', `review:${rv.id}`,
        `Under review — ${rv.house_paybill_number}`,
        {
          issue_type: 'Disputed statement / financial review',
          property: rv.house_paybill_number, billing_month: rv.billing_month || null,
          reason: rv.reason, status: 'Under Review',
          action: 'Investigate, resolve the review in the landlord ledger.',
        }, null, { kind: 'landlord_ledger', paybill: rv.house_paybill_number }));
    }
  } catch (_) {}

  for (const h of houses) {
    // Remittance side
    try {
      const rem = await commission.remittanceLedger(h.paybill_number, h.landlord_id);
      if (rem && rem.summary.outstanding > 0) {
        const day = rem.remittance_day;
        const overdue = day && new Date().getDate() > Number(day);
        const next = rem.next_agreed_date;
        const soon = next && !overdue && daysBetween(t, next) >= 0 && daysBetween(t, next) <= 3;
        if (overdue) {
          alerts.push(alert('overdue', 'landlord_remittance', `remittance:${h.paybill_number}`,
            `Overdue landlord remittance — ${h.house_name || h.paybill_number}`,
            {
              issue_type: 'Landlord remittance past agreed date',
              property: h.house_name || h.paybill_number, account: h.paybill_number,
              due_date: next || null, agreed_day: day,
              amount: rem.summary.total_net, transferred: rem.summary.total_paid,
              balance: rem.summary.outstanding,
              reason: `Agreed payment day ${day} of the month has passed with an outstanding balance.`,
              status: rem.summary.pending_verification > 0 ? 'Partially Paid — Overdue (verification pending)' : 'Overdue',
              action: 'Review the remittance ledger and record/verify the remaining payment.',
            },
            rem.summary.outstanding,
            { kind: 'landlord_ledger', landlord_id: h.landlord_id, paybill: h.paybill_number }));
        } else if (soon) {
          alerts.push(alert('due_soon', 'landlord_remittance_due', `remittance_due:${h.paybill_number}`,
            `Landlord remittance due soon — ${h.house_name || h.paybill_number}`,
            {
              issue_type: 'Approaching landlord remittance deadline',
              property: h.house_name || h.paybill_number, account: h.paybill_number,
              due_date: next, amount: rem.summary.total_net, balance: rem.summary.outstanding,
              reason: `Agreed payment date ${next} is within 3 days.`,
              status: 'Due Soon', action: 'Prepare the transfer and record it on the agreed date.',
            },
            rem.summary.outstanding,
            { kind: 'landlord_ledger', landlord_id: h.landlord_id, paybill: h.paybill_number }));
        }
      }
      // Pending verification exists regardless of the outstanding balance
      // (e.g., an over-payment still awaiting proof) — always surface it.
      if (rem && rem.summary.pending_verification > 0) {
        alerts.push(alert('pending', 'remittance_verification', `remittance_pending:${h.paybill_number}`,
          `Transfers awaiting verification — ${h.house_name || h.paybill_number}`,
          {
            issue_type: 'Landlord transfer awaiting verification',
            property: h.house_name || h.paybill_number, account: h.paybill_number,
            amount: rem.summary.pending_verification,
            reason: 'Recorded transfers with Pending Verification status do not reduce the balance yet.',
            status: 'Awaiting Verification', action: 'Verify the transfer with proof in the landlord ledger.',
          },
          rem.summary.pending_verification,
          { kind: 'landlord_ledger', landlord_id: h.landlord_id, paybill: h.paybill_number }));
      }
    } catch (_) {}

    // Management-fee invoices due/overdue
    try {
      const invs = (await query(
        `SELECT id, invoice_number, billing_month, total_payable, due_date::text AS due_date
           FROM commission_invoices
          WHERE house_paybill_number = $1 AND status = 'Issued' AND total_payable > 0 AND due_date IS NOT NULL`,
        [h.paybill_number]
      )).rows;
      for (const inv of invs) {
        const days = daysBetween(t, inv.due_date);
        if (days < 0) {
          alerts.push(alert('overdue', 'mfi_invoice', `mfi:${inv.id}`,
            `Overdue management-fee invoice ${inv.invoice_number}`,
            {
              issue_type: 'Management-fee invoice past due date',
              property: h.house_name || h.paybill_number, account: h.paybill_number,
              invoice: inv.invoice_number, billing_month: inv.billing_month,
              due_date: inv.due_date, amount: Number(inv.total_payable),
              reason: `Invoice due ${inv.due_date} remains unpaid.`,
              status: 'Unpaid — Overdue', action: 'Open the landlord ledger and follow up on payment.',
            },
            Number(inv.total_payable),
            { kind: 'landlord_ledger', landlord_id: h.landlord_id, paybill: h.paybill_number }));
        } else if (days <= 3) {
          alerts.push(alert('due_soon', 'mfi_invoice_due', `mfi_due:${inv.id}`,
            `Management-fee invoice due soon ${inv.invoice_number}`,
            {
              issue_type: 'Approaching management-fee invoice due date',
              property: h.house_name || h.paybill_number, account: h.paybill_number,
              invoice: inv.invoice_number, due_date: inv.due_date, amount: Number(inv.total_payable),
              reason: `Invoice due in ${days} day(s).`, status: 'Due Soon',
              action: 'Remind the landlord and prepare to record payment.',
            },
            Number(inv.total_payable),
            { kind: 'landlord_ledger', landlord_id: h.landlord_id, paybill: h.paybill_number }));
        }
      }
    } catch (_) {}

    // Reconciliation discrepancies (current + previous month)
    try {
      const [cy, cm] = t.split('-').map(Number);
      const prev = cm === 1 ? `${cy - 1}-12` : `${cy}-${String(cm - 1).padStart(2, '0')}`;
      for (const month of [t.slice(0, 7), prev]) {
        const rec = await commission.reconciliation(h.paybill_number, month);
        if (rec && rec.status === 'review') {
          const hasReview = (openReviewsByHouse[h.paybill_number] || []).length > 0;
          alerts.push(alert(hasReview ? 'review' : 'critical', 'reconciliation', `recon:${h.paybill_number}:${month}`,
            `${hasReview ? 'Reconciliation under review' : 'Reconciliation discrepancy'} — ${h.house_name || h.paybill_number} (${month})`,
            {
              issue_type: 'Financial reconciliation discrepancy',
              property: h.house_name || h.paybill_number, account: h.paybill_number,
              billing_month: month,
              items: rec.items.filter((i) => i.severity === 'blocker').map((i) => i.message),
              reason: rec.items.filter((i) => i.severity === 'blocker').map((i) => i.message).join('; '),
              difference: rec.items.find((i) => i.difference != null)?.difference ?? null,
              status: hasReview ? 'Under Review' : 'Needs Investigation',
              action: 'Open reconciliation in the landlord ledger; flag Under Review or correct the source records.',
            },
            rec.items.find((i) => i.difference != null)?.difference ?? null,
            { kind: 'landlord_ledger', landlord_id: h.landlord_id, paybill: h.paybill_number }));
        }
      }
    } catch (_) {}
  }

  // E. Work orders: overdue deadlines + awaiting approval
  try {
    const rows = (await query(
      `SELECT id, wo_number, property_name, house_paybill_number, status, expected_completion::text AS expected_completion, total_cost
         FROM work_orders
        WHERE status IN ('Assigned','Pending')
        ORDER BY expected_completion NULLS LAST LIMIT 25`
    )).rows;
    for (const w of rows) {
      const base = {
        issue_type: w.status === 'Pending' ? 'Maintenance request awaiting approval' : 'Work order past expected completion',
        property: w.property_name || w.house_paybill_number || '', account: w.house_paybill_number || '',
        reference: w.wo_number, amount: Number(w.total_cost || 0), due_date: w.expected_completion || null,
        status: w.status,
      };
      if (w.status === 'Pending') {
        alerts.push(alert('pending', 'work_order_approval', `wo_pending:${w.id}`,
          `Maintenance awaiting approval — ${w.wo_number}`, {
            ...base,
            reason: 'Work order is Pending and needs management approval.',
            action: 'Open Work Orders and approve or assign.',
          }, Number(w.total_cost || 0), { kind: 'work_order', id: w.id }));
      } else if (w.expected_completion && w.expected_completion < t) {
        alerts.push(alert('overdue', 'work_order_overdue', `wo_overdue:${w.id}`,
          `Overdue work order — ${w.wo_number}`, {
            ...base,
            reason: `Expected completion ${w.expected_completion} has passed.`,
            action: 'Open Work Orders and chase completion.',
          }, Number(w.total_cost || 0), { kind: 'work_order', id: w.id }));
      }
    }
  } catch (_) {}

  // F. Failed sends / system processes (last 24h, single aggregate alert)
  try {
    const f = (await query(
      `SELECT COUNT(*)::int AS n, MAX(logged_at)::text AS last_at
         FROM message_logs WHERE status IN ('Failed','failed') AND logged_at > NOW() - interval '24 hours'`
    )).rows[0];
    if (f.n > 0) {
      alerts.push(alert('pending', 'failed_sends', `failed_sends:24h`,
        `${f.n} message/document send(s) failed in the last 24h`, {
          issue_type: 'Failed system process (send)',
          amount: null, last_at: f.last_at, count: f.n,
          reason: `${f.n} send(s) recorded as Failed — financial confirmations may not have reached tenants.`,
          status: 'Action Required', action: 'Open WhatsApp/Message history, resend where needed.',
        }, null, { kind: 'whatsapp' }));
    }
  } catch (_) {}

  return alerts;
}

// ── Sync into the lifecycle log, then report ────────────────────────────────
async function getNotifications() {
  const { query } = require('../config/database');
  const alerts = await detect();

  const detectedKeys = new Set(alerts.map((a) => a.key));
  for (const a of alerts) {
    await query(
      `INSERT INTO notification_log (alert_key, priority, issue_type, title, details, amount, status, first_seen, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,'Open',NOW(),NOW())
       ON CONFLICT (alert_key) WHERE status = 'Open'
       DO UPDATE SET priority = EXCLUDED.priority, title = EXCLUDED.title,
             details = EXCLUDED.details, amount = EXCLUDED.amount, last_seen = NOW()`,
      [a.key, a.priority, a.issue_type, a.title, JSON.stringify(a.details), a.amount]
    );
  }
  // Auto-resolve: Open rows whose underlying issue is gone (viewing never
  // resolves — only the underlying record clearing does).
  const openRows = (await query(`SELECT id, alert_key, title FROM notification_log WHERE status = 'Open'`)).rows;
  for (const row of openRows) {
    if (!detectedKeys.has(row.alert_key)) {
      await query(
        `UPDATE notification_log SET status = 'Resolved', resolved_at = NOW(),
                resolution = 'Auto-resolved: underlying issue cleared'
          WHERE id = $1 AND status = 'Open'`,
        [row.id]
      );
    }
  }

  const summary = { total: alerts.length, critical: 0, overdue: 0, due_soon: 0, pending: 0, review: 0 };
  for (const a of alerts) summary[a.priority] = (summary[a.priority] || 0) + 1;
  summary.emergency = summary.critical + summary.overdue > 0;
  summary.open_logged = (await query(`SELECT COUNT(*)::int AS n FROM notification_log WHERE status = 'Open'`)).rows[0].n;

  const priorityOrder = { critical: 0, overdue: 1, due_soon: 2, review: 3, pending: 4 };
  alerts.sort((a, b) => (priorityOrder[a.priority] - priorityOrder[b.priority]) || String(a.title).localeCompare(String(b.title)));

  return { generated_at: new Date().toISOString(), summary, alerts };
}

async function getHistory({ status = 'Resolved', limit = 50 } = {}) {
  const { query } = require('../config/database');
  const lim = Math.min(Number(limit) || 50, 200);
  const rows = (await query(
    `SELECT id, alert_key, priority, issue_type, title, details, amount, status,
            first_seen::text AS first_seen, last_seen::text AS last_seen,
            resolved_at::text AS resolved_at, resolution
       FROM notification_log
      WHERE ($1 = '' OR status = $1)
      ORDER BY COALESCE(resolved_at, last_seen) DESC LIMIT $2`,
    [status || '', lim]
  )).rows;
  return { notifications: rows };
}

module.exports = { detect, getNotifications, getHistory, PRIORITIES };
