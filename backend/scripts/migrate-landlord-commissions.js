/**
 * migrate-landlord-commissions.js — Landlord profiles + per-property
 * commission ledger.
 *
 * Accounting model (per client spec):
 *  - ONE landlord profile -> MANY properties
 *  - EACH property has its OWN independent commission account:
 *    commission rate (existing commission_rates table), rent collected,
 *    commission invoiced, payments received, running outstanding balance
 *  - balances carry forward automatically (previous balance = ledger truth;
 *    no manual opening balances)
 *
 * Run: node backend/scripts/migrate-landlord-commissions.js   (idempotent)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

async function main() {
  console.log('[migrate-landlord-commissions] starting');

  await query(`
    CREATE TABLE IF NOT EXISTS landlords (
      id SERIAL PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      phone VARCHAR(32),
      email VARCHAR(120),
      id_number VARCHAR(40),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_landlords_name ON landlords (name)`);

  await query(`ALTER TABLE houses ADD COLUMN IF NOT EXISTS landlord_id INTEGER REFERENCES landlords(id) ON DELETE SET NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_houses_landlord ON houses (landlord_id)`);

  // Per-property commission invoice (one active per property-month).
  await query(`
    CREATE TABLE IF NOT EXISTS commission_invoices (
      id SERIAL PRIMARY KEY,
      invoice_number VARCHAR(32) NOT NULL UNIQUE,
      landlord_id INTEGER NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
      house_paybill_number VARCHAR(32) NOT NULL REFERENCES houses(paybill_number) ON DELETE RESTRICT,
      billing_month VARCHAR(7) NOT NULL,
      rent_collected NUMERIC(14,2) NOT NULL DEFAULT 0,
      commission_rate NUMERIC(6,3) NOT NULL DEFAULT 0,
      commission_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      previous_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
      payments_applied NUMERIC(14,2) NOT NULL DEFAULT 0,
      total_payable NUMERIC(14,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'Issued' CHECK (status IN ('Issued', 'Void')),
      document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
      created_by VARCHAR(128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_comm_inv_house ON commission_invoices (house_paybill_number, billing_month)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_comm_inv_landlord ON commission_invoices (landlord_id)`);
  // Regeneration-safe duplicate protection: one ACTIVE invoice per property-month.
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_comm_inv_house_month_active
      ON commission_invoices (house_paybill_number, billing_month) WHERE status = 'Issued'`);

  // Payments posted against a PROPERTY's commission account (never mixed).
  await query(`
    CREATE TABLE IF NOT EXISTS commission_payments (
      id SERIAL PRIMARY KEY,
      landlord_id INTEGER NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
      house_paybill_number VARCHAR(32) NOT NULL REFERENCES houses(paybill_number) ON DELETE RESTRICT,
      payment_date DATE NOT NULL,
      amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      method VARCHAR(40) NOT NULL DEFAULT 'M-Pesa',
      reference VARCHAR(80),
      notes TEXT,
      created_by VARCHAR(128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_comm_pay_house ON commission_payments (house_paybill_number, payment_date)`);

  console.log('[migrate-landlord-commissions] done');
  process.exit(0);
}

main().catch((e) => { console.error('[migrate-landlord-commissions] FAILED:', e); process.exit(1); });
