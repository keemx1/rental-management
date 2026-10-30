/**
 * migrate-financial-phase1.js — Financial Management foundation (Phase 1).
 *
 *  - houses.financial_arrangement: ALL existing properties = 'A'
 *    (management decision: tenants pay landlords directly), switchable
 *    per property later; changing it never rewrites history (classification
 *    is captured at posting time in the journals)
 *  - chart_of_accounts + journal_entries/journal_lines: REAL double-entry
 *    foundation — every entry must balance (deferred constraint trigger),
 *    one posted entry per source (idempotent auto-posting), corrections by
 *    reversal only (originals preserved)
 *  - expense_categories (configurable) + other_income register table
 *
 * Run: node backend/scripts/migrate-financial-phase1.js (idempotent)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

const ACCOUNTS = [
  ['1010', 'Cash on Hand', 'asset'], ['1020', 'M-Pesa Account', 'asset'], ['1030', 'Bank Account', 'asset'],
  ['1100', 'Tenant Receivables', 'asset'], ['1110', 'Commission Receivable (Landlords)', 'asset'],
  ['1120', 'Employee Advances (Receivable)', 'asset'], ['1130', 'Landlord Advances (Receivable)', 'asset'],
  ['1190', 'Direct Rent Collection Memo (non-cash)', 'asset'],
  ['2000', 'Tenant Deposits (Liability)', 'liability'], ['2100', 'Landlord Payable', 'liability'],
  ['2200', 'Accounts Payable (Suppliers)', 'liability'], ['2300', 'Salaries Payable', 'liability'],
  ['2400', 'Reimbursements Payable', 'liability'], ['2500', 'Deposit Refunds Payable', 'liability'],
  ['3000', "Owner's Equity", 'equity'], ['3900', 'Retained Earnings', 'equity'],
  ['4000', 'Management Commission Income', 'income'], ['4010', 'Administrative & Agreement Fees', 'income'],
  ['4020', 'Utility & Garbage Income', 'income'], ['4090', 'Other Legitimate Income', 'income'],
  ['5000', 'Salaries & Wages', 'expense'], ['5100', 'Casual Labour & Allowances', 'expense'],
  ['5200', 'Office & Administration', 'expense'], ['5300', 'Maintenance & Repairs', 'expense'],
  ['5400', 'Property Operating Expenses', 'expense'], ['5500', 'Transport & Field Operations', 'expense'],
  ['5600', 'Professional & Business Expenses', 'expense'], ['5700', 'Bank & Transaction Charges', 'expense'],
];

async function main() {
  console.log('[migrate-financial-phase1] starting');

  // Arrangement: ALL existing properties are Arrangement A (direct to landlord).
  await query(`ALTER TABLE houses ADD COLUMN IF NOT EXISTS financial_arrangement VARCHAR(2) NOT NULL DEFAULT 'A' CHECK (financial_arrangement IN ('A','B'))`);
  await query(`UPDATE houses SET financial_arrangement = 'A'`);

  await query(`
    CREATE TABLE IF NOT EXISTS chart_of_accounts (
      code VARCHAR(10) PRIMARY KEY,
      name VARCHAR(140) NOT NULL,
      type VARCHAR(20) NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
      is_system BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  for (const [code, name, type] of ACCOUNTS) {
    await query(
      `INSERT INTO chart_of_accounts (code, name, type) VALUES ($1,$2,$3)
       ON CONFLICT (code) DO NOTHING`,
      [code, name, type]
    );
  }

  await query(`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id SERIAL PRIMARY KEY,
      entry_number VARCHAR(32) NOT NULL UNIQUE,
      entry_date DATE NOT NULL,
      period VARCHAR(7) NOT NULL,
      memo TEXT,
      source_type VARCHAR(40) NOT NULL,
      source_id VARCHAR(60) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Posted' CHECK (status IN ('Posted','Reversed')),
      reversed_by VARCHAR(128),
      reversal_reason TEXT,
      created_by VARCHAR(128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // One POSTED entry per source => auto-posting can never double-post.
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_source_posted
      ON journal_entries (source_type, source_id) WHERE status = 'Posted'`);

  await query(`
    CREATE TABLE IF NOT EXISTS journal_lines (
      id SERIAL PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_code VARCHAR(10) NOT NULL REFERENCES chart_of_accounts(code),
      debit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
      credit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
      house_paybill VARCHAR(32),
      tenant_code VARCHAR(32),
      memo TEXT,
      CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines (account_code)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_journal_lines_house ON journal_lines (house_paybill)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_journal_entries_period ON journal_entries (period, entry_date)`);

  // Every entry must balance — enforced at COMMIT (deferred), so partial
  // inserts during construction cannot produce an unbalanced entry.
  await query(`
    CREATE OR REPLACE FUNCTION fn_journal_balanced() RETURNS trigger AS $fn$
    DECLARE d NUMERIC; c NUMERIC;
    BEGIN
      SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) INTO d, c
        FROM journal_lines WHERE entry_id = NEW.entry_id;
      IF d = 0 OR d <> c THEN
        RAISE EXCEPTION 'Journal entry % is unbalanced (debit % <> credit %)', NEW.entry_id, d, c
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NULL;
    END $fn$ LANGUAGE plpgsql`);
  await query(`DROP TRIGGER IF EXISTS trg_journal_balanced ON journal_lines`);
  await query(`
    CREATE CONSTRAINT TRIGGER trg_journal_balanced
      AFTER INSERT ON journal_lines
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fn_journal_balanced()`);

  // Configurable expenditure categories (proposal §6).
  await query(`
    CREATE TABLE IF NOT EXISTS expense_categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL UNIQUE,
      group_name VARCHAR(60) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_system BOOLEAN NOT NULL DEFAULT TRUE
    )`);
  const CATS = [
    ['Salaries', 'Salaries and staff'], ['Casual Labour', 'Salaries and staff'], ['Staff Allowances', 'Salaries and staff'],
    ['Employee Advances', 'Advances'], ['Landlord Advances', 'Advances'],
    ['Office Rent', 'Office and administration'], ['Electricity', 'Office and administration'],
    ['Water', 'Office and administration'], ['Internet & Wi-Fi', 'Office and administration'],
    ['Telephone & Communication', 'Office and administration'], ['Printing & Photocopying', 'Office and administration'],
    ['Stationery', 'Office and administration'], ['Cleaning', 'Office and administration'],
    ['Furniture & Equipment', 'Office and administration'], ['Licences & Subscriptions', 'Office and administration'],
    ['Software & ICT', 'Office and administration'], ['Bank Charges', 'Office and administration'],
    ['Plumbing', 'Maintenance and repairs'], ['Electrical Repairs', 'Maintenance and repairs'],
    ['Painting', 'Maintenance and repairs'], ['Roofing & Structural', 'Maintenance and repairs'],
    ['Renovations', 'Maintenance and repairs'], ['Emergency Repairs', 'Maintenance and repairs'], ['Contractor Payments', 'Maintenance and repairs'],
    ['Garbage Collection', 'Property operating'], ['Security', 'Property operating'],
    ['Common-area Cleaning', 'Property operating'], ['Landscaping', 'Property operating'], ['Pest Control', 'Property operating'],
    ['Fuel', 'Transport and field'], ['Vehicle Maintenance', 'Transport and field'], ['Public Transport', 'Transport and field'], ['Site Inspections', 'Transport and field'],
    ['Marketing', 'Business and professional'], ['Legal Fees', 'Business and professional'],
    ['Professional Services', 'Business and professional'], ['Training', 'Business and professional'], ['Photography & Branding', 'Business and professional'],
  ];
  for (const [name, group] of CATS) {
    await query(`INSERT INTO expense_categories (name, group_name, sort_order) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
      [name, group, CATS.findIndex((c) => c[0] === name)]);
  }

  // Other legitimate income register (proposal §5).
  await query(`
    CREATE TABLE IF NOT EXISTS other_income (
      id SERIAL PRIMARY KEY,
      income_date DATE NOT NULL,
      period VARCHAR(7),
      category VARCHAR(80) NOT NULL,
      description TEXT,
      source_client VARCHAR(140),
      house_paybill VARCHAR(32),
      amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      received BOOLEAN NOT NULL DEFAULT FALSE,
      method VARCHAR(40),
      reference VARCHAR(100),
      recorded_by VARCHAR(128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  // Expense invoices can carry a register category (existing flow keeps working).
  await query(`ALTER TABLE maintenance_invoices ADD COLUMN IF NOT EXISTS category VARCHAR(80)`);

  console.log('[migrate-financial-phase1] done');
  process.exit(0);
}

main().catch((e) => { console.error('[migrate-financial-phase1] FAILED:', e); process.exit(1); });
