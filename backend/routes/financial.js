'use strict';

/**
 * Financial Management & Reconciliation — /api/financial (ADMIN ONLY).
 * Phase 1: Obligations Tracker (P1), Monthly Report + PDF/Excel (P2),
 * Registers (P3), trial balance, opening balances, arrangements, other
 * income, expense categories. Everything READS existing records.
 */

const express = require('express');
const { requireAuthActive, requireAdmin } = require('../middleware/auth');
const store = require('../storage/store');
const journal = require('../services/journal');
const obligations = require('../services/obligations');
const reporting = require('../services/financialReporting');

const router = express.Router();
router.use(requireAuthActive, requireAdmin);

const bounds = (from, to) => ({
  from: /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? String(from) : null,
  to: /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? String(to) : null,
});

// ── P1: Outstanding Obligations Tracker ────────────────────────────────────
router.get('/obligations', async (req, res) => {
  try {
    res.json(await obligations.getObligations());
  } catch (err) {
    res.status(500).json({ error: 'Obligations failed: ' + err.message });
  }
});

// ── P2: Monthly report (+ PDF + Excel) ────────────────────────────────────
router.get('/monthly-report', async (req, res) => {
  try {
    const report = await reporting.monthlyReport(req.query.month);
    if (report.error) return res.status(400).json(report);
    res.json({ report });
  } catch (err) {
    res.status(500).json({ error: 'Monthly report failed: ' + err.message });
  }
});

router.post('/monthly-report/pdf', async (req, res) => {
  try {
    const report = await reporting.monthlyReport(req.body?.month);
    if (report.error) return res.status(400).json(report);
    const { generateMonthlyFinancialReportPdf } = require('../services/documentStore');
    const pdf = await generateMonthlyFinancialReportPdf(report, req.user?.username);
    if (!pdf) return res.status(500).json({ error: 'PDF generation failed' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${pdf.filename}"`);
    return res.sendFile(pdf.file_path);
  } catch (err) {
    res.status(500).json({ error: 'PDF failed: ' + err.message });
  }
});

router.post('/monthly-report/excel', async (req, res) => {
  try {
    const report = await reporting.monthlyReport(req.body?.month);
    if (report.error) return res.status(400).json(report);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const sum = wb.addWorksheet('Monthly Summary');
    sum.addRow([`GEHPM Monthly Financial Report — ${report.month}`]).font = { bold: true, size: 14 };
    sum.addRow([]);
    sum.addRow(['SECTION', 'ITEM', 'AMOUNT']);
    sum.getRow(3).font = { bold: true };
    sum.addRow(['Income', 'Commission earned', report.income.commission_earned]);
    sum.addRow(['Income', 'Other income earned', report.income.other_income_earned]);
    sum.addRow(['Income', 'Commission received', report.income.commission_received]);
    sum.addRow(['Income', 'Commission receivable', report.income.commission_receivable]);
    sum.addRow(['Expenditure', 'Incurred total', report.expenditure.incurred_total]);
    sum.addRow(['Expenditure', 'Paid total', report.expenditure.paid_total]);
    sum.addRow(['Cash', 'Movement total (period)', report.cash.movement_total]);
    sum.addRow(['Cash', 'Opening configured', report.opening_balances.configured ? 'Yes' : 'NOT CONFIGURED']);
    if (report.cash.closing) {
      sum.addRow(['Cash', 'Closing cash', report.cash.closing.cash]);
      sum.addRow(['Cash', 'Closing M-Pesa', report.cash.closing.mpesa]);
      sum.addRow(['Cash', 'Closing bank', report.cash.closing.bank]);
    }
    sum.addRow(['Tenants', 'Arrears', report.tenants.arrears]);
    sum.addRow(['Tenants', 'Credits held', report.tenants.credits]);
    sum.addRow(['Tenants', 'Deposit liabilities', report.tenants.deposit_liabilities]);
    sum.addRow(['Tenants', 'Unallocated payments', report.tenants.unallocated_payments]);
    sum.addRow(['Landlords', 'Remitted this month', report.landlord_remitted]);
    for (const d of report.discrepancies || []) sum.addRow(['Discrepancy', d.message, d.count]);

    const prop = wb.addWorksheet('Properties');
    prop.addRow(['Property', 'House', 'Arrangement', 'Collected', 'Commission earned', 'Commission received', 'Commission outstanding']);
    prop.getRow(1).font = { bold: true };
    for (const p of report.properties || []) {
      prop.addRow([p.house_paybill, p.house_name, p.arrangement, p.collected, p.commission_earned, p.commission_received, p.commission_outstanding]);
    }

    const exp = wb.addWorksheet('Expenditure');
    exp.addRow(['Account', 'Category', 'Incurred']);
    exp.getRow(1).font = { bold: true };
    for (const e of report.expenditure.rows || []) exp.addRow([e.code, e.name, e.incurred]);

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="GEHPM-Monthly-${report.month}.xlsx"`);
    return res.send(Buffer.from(buf));
  } catch (err) {
    res.status(500).json({ error: 'Excel failed: ' + err.message });
  }
});

// ── Opening balances (never faked as zero) ────────────────────────────────
router.get('/opening-balances', async (req, res) => {
  try { res.json(await reporting.getOpeningBalances()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/opening-balances', async (req, res) => {
  try {
    const result = await reporting.saveOpeningBalances({ ...(req.body || {}), actor: req.user?.username });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Trial balance (double-entry foundation) ───────────────────────────────
router.get('/trial-balance', async (req, res) => {
  try {
    const b = bounds(req.query.from, req.query.to);
    res.json(await journal.trialBalance(b));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Registers (P3) — read models over existing records ────────────────────
router.get('/register/collections', async (req, res) => {
  try {
    const b = bounds(req.query.from, req.query.to);
    const rows = (await require('../config/database').query(
      `SELECT p.id, p.tenant_code, t.name AS tenant_name, t.house_paybill_number, h.house_name,
              h.financial_arrangement, p.amount, p.payment_date::text AS payment_date, p.payment_type,
              p.payment_mode, p.mpesa_reference, p.receipt_number, p.status, p.allocation_breakdown,
              COALESCE(p.overpayment_amount,0)::float8 AS overpayment
         FROM payments p
         LEFT JOIN tenants t ON t.tenant_code = p.tenant_code
         LEFT JOIN houses h ON h.paybill_number = t.house_paybill_number
        WHERE p.status = 'Approved'
          AND ($1::date IS NULL OR p.payment_date >= $1)
          AND ($2::date IS NULL OR p.payment_date <= $2)
        ORDER BY p.payment_date DESC LIMIT 300`,
      [b.from, b.to]
    )).rows;
    res.json({
      register: 'collections',
      rows: rows.map((r) => ({
        ...r,
        arrangement: r.financial_arrangement || 'A',
        treatment: (r.financial_arrangement || 'A') === 'A'
          ? 'Direct to landlord (memo — NOT GEHPM cash)'
          : 'Received by GEHPM',
        allocated: !!(r.allocation_breakdown),
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/register/income', async (req, res) => {
  try {
    const b = bounds(req.query.from, req.query.to);
    const db = require('../config/database');
    const earned = (await db.query(
      `SELECT ci.id, ci.invoice_number, ci.billing_month, ci.commission_amount::float8 AS amount,
              ci.total_payable::float8 AS outstanding, ci.due_date::text AS due_date, ci.status,
              l.name AS landlord_name, h.house_name, 'Commission earned (receivable)' AS kind
         FROM commission_invoices ci
         JOIN landlords l ON l.id = ci.landlord_id
         LEFT JOIN houses h ON h.paybill_number = ci.house_paybill_number
        WHERE ci.status = 'Issued'
        ORDER BY ci.billing_month DESC LIMIT 200`
    )).rows;
    const received = (await db.query(
      `SELECT cp.id, cp.reference, cp.payment_date::text AS payment_date, cp.amount::float8 AS amount,
              cp.method, substr(cp.payment_date::text,1,7) AS billing_month, l.name AS landlord_name, h.house_name, 'Commission received (cash)' AS kind
         FROM commission_payments cp
         JOIN landlords l ON l.id = cp.landlord_id
         LEFT JOIN houses h ON h.paybill_number = cp.house_paybill_number
        WHERE ($1::date IS NULL OR cp.payment_date >= $1)
          AND ($2::date IS NULL OR cp.payment_date <= $2)
        ORDER BY cp.payment_date DESC LIMIT 200`,
      [b.from, b.to]
    )).rows;
    const other = (await db.query(
      `SELECT id, income_date::text AS income_date, category, description, source_client,
              amount::float8 AS amount, received, method, reference, 'Other income' AS kind
         FROM other_income
        WHERE ($1::date IS NULL OR income_date >= $1)
          AND ($2::date IS NULL OR income_date <= $2)
        ORDER BY income_date DESC LIMIT 200`,
      [b.from, b.to]
    )).rows;
    res.json({ register: 'income', earned, received, other });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/register/expenditure', async (req, res) => {
  try {
    const b = bounds(req.query.from, req.query.to);
    const db = require('../config/database');
    const invoices = (await db.query(
      `SELECT m.id, m.mnt_number, m.created_at::text AS created_at, m.property_name, m.house_paybill_number,
              m.category, m.grand_total::float8 AS amount, m.paid_total::float8 AS paid,
              GREATEST(m.grand_total - COALESCE(m.paid_total,0),0)::float8 AS outstanding, m.status, 'Expense invoice' AS kind
         FROM maintenance_invoices m
        WHERE COALESCE(m.status,'') NOT ILIKE '%void%'
          AND ($1::date IS NULL OR m.created_at >= $1)
          AND ($2::date IS NULL OR m.created_at <= $2)
        ORDER BY m.created_at DESC LIMIT 200`,
      [b.from, b.to]
    )).rows;
    const salaries = (await db.query(
      `SELECT sp.id, sr.employee_name, sr.salary_month, sp.amount::float8 AS amount, sp.payment_date::text AS payment_date,
              sp.payment_method, sp.reference, 'Salary payment' AS kind
         FROM salary_payments sp JOIN salary_records sr ON sr.id = sp.salary_record_id
        WHERE ($1::date IS NULL OR sp.payment_date >= $1)
          AND ($2::date IS NULL OR sp.payment_date <= $2)
        ORDER BY sp.payment_date DESC LIMIT 200`,
      [b.from, b.to]
    )).rows;
    const pendingSalaries = (await db.query(
      `SELECT id, employee_name, salary_month, outstanding::float8 AS amount, status, 'Salary outstanding (incurred)' AS kind
         FROM salary_records WHERE COALESCE(outstanding,0) > 0 ORDER BY salary_month LIMIT 100`
    )).rows;
    res.json({ register: 'expenditure', invoices, salaries, pending: pendingSalaries });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/register/cash', async (req, res) => {
  try {
    const b = bounds(req.query.from, req.query.to);
    const rows = (await require('../config/database').query(
      `SELECT e.entry_number, e.entry_date::text AS entry_date, e.memo, e.source_type, e.source_id,
              l.account_code, a.name AS account_name, l.debit::float8 AS debit, l.credit::float8 AS credit
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'Posted'
         JOIN chart_of_accounts a ON a.code = l.account_code
        WHERE l.account_code IN ('1010','1020','1030')
          AND ($1::date IS NULL OR e.entry_date >= $1)
          AND ($2::date IS NULL OR e.entry_date <= $2)
        ORDER BY e.entry_date DESC, e.id DESC LIMIT 300`,
      [b.from, b.to]
    )).rows;
    res.json({ register: 'cash', rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Other income CRUD (register entry, admin) ─────────────────────────────
router.get('/other-income', async (req, res) => {
  try {
    const rows = (await require('../config/database').query(
      `SELECT * FROM other_income ORDER BY income_date DESC LIMIT 300`
    )).rows;
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/other-income', async (req, res) => {
  try {
    const { income_date, category, description, source_client, house_paybill, amount, received, method, reference } = req.body || {};
    if (!income_date || !category || !(Number(amount) > 0)) {
      return res.status(400).json({ error: 'income_date, category and a positive amount are required' });
    }
    const row = (await require('../config/database').query(
      `INSERT INTO other_income (income_date, period, category, description, source_client, house_paybill, amount, received, method, reference, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [String(income_date).slice(0, 10), String(income_date).slice(0, 7), category, description || null,
        source_client || null, house_paybill || null, Number(amount), received === true,
        method || null, reference || null, req.user?.username]
    )).rows[0];
    await store.logAudit({
      actor: req.user?.username, action: 'other_income_recorded',
      entityType: 'other_income', entityId: String(row.id), details: { category, amount, received },
    });
    res.status(201).json({ income: row });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Expense categories (configurable, §6) ─────────────────────────────────
router.get('/expense-categories', async (req, res) => {
  try {
    const rows = (await require('../config/database').query(
      `SELECT * FROM expense_categories ORDER BY sort_order, name`
    )).rows;
    res.json({ categories: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/expense-categories', async (req, res) => {
  try {
    const { name, group_name } = req.body || {};
    if (!name || !group_name) return res.status(400).json({ error: 'name and group_name are required' });
    const row = (await require('../config/database').query(
      `INSERT INTO expense_categories (name, group_name, sort_order, is_system)
       VALUES ($1,$2,(SELECT COALESCE(MAX(sort_order),0)+1 FROM expense_categories), FALSE)
       ON CONFLICT (name) DO UPDATE SET group_name = EXCLUDED.group_name
       RETURNING *`,
      [String(name).trim(), String(group_name).trim()]
    )).rows[0];
    await store.logAudit({
      actor: req.user?.username, action: 'expense_category_added',
      entityType: 'expense_categories', entityId: String(row.id), details: { name: row.name, group: row.group_name },
    });
    res.status(201).json({ category: row });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Property arrangements (A/B) ──────────────────────────────────────────
router.get('/arrangements', async (req, res) => {
  try {
    const rows = (await require('../config/database').query(
      `SELECT h.paybill_number, h.house_name, h.financial_arrangement, l.name AS landlord_name
         FROM houses h LEFT JOIN landlords l ON l.id = h.landlord_id ORDER BY h.house_name`
    )).rows;
    res.json({ properties: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/arrangements', async (req, res) => {
  try {
    const { house_paybill, arrangement } = req.body || {};
    if (!house_paybill || !['A', 'B'].includes(arrangement)) {
      return res.status(400).json({ error: 'house_paybill and arrangement (A or B) are required' });
    }
    const before = (await require('../config/database').query(
      `SELECT financial_arrangement FROM houses WHERE paybill_number = $1`, [house_paybill]
    )).rows[0];
    if (!before) return res.status(404).json({ error: 'Property not found' });
    await require('../config/database').query(
      `UPDATE houses SET financial_arrangement = $1, updated_at = NOW() WHERE paybill_number = $2`,
      [arrangement, house_paybill]
    );
    await store.logAudit({
      actor: req.user?.username, action: 'financial_arrangement_changed',
      entityType: 'house', entityId: house_paybill,
      details: { from: before.financial_arrangement, to: arrangement, historical_transactions: 'unchanged (classification captured at posting time)' },
    });
    res.json({ house_paybill, arrangement, previous: before.financial_arrangement });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
