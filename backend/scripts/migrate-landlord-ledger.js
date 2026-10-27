/**
 * migrate-landlord-ledger.js — Landlord rent remittance side of the
 * Landlord Ledger Dashboard (extends the v75 commission system).
 *
 * Adds:
 *  - houses.landlord_remittance_day: per-property agreed payment day (1-31)
 *  - landlord_remittance_payments: payments made TO the landlord against a
 *    property's remittance balance (partial + multiple per month allowed)
 *
 * Rent collected / commission / net payable are COMPUTED from existing
 * records (payments.billing_period + commission_rates) — no new monthly
 * tables, so duplicate remittance entries are structurally impossible.
 * Commission and remittance balances stay separate (no auto-offsetting).
 *
 * Run: node backend/scripts/migrate-landlord-ledger.js   (idempotent)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

async function main() {
  console.log('[migrate-landlord-ledger] starting');

  await query(`ALTER TABLE houses ADD COLUMN IF NOT EXISTS landlord_remittance_day INTEGER CHECK (landlord_remittance_day BETWEEN 1 AND 31)`);

  await query(`
    CREATE TABLE IF NOT EXISTS landlord_remittance_payments (
      id SERIAL PRIMARY KEY,
      landlord_id INTEGER NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
      house_paybill_number VARCHAR(32) NOT NULL REFERENCES houses(paybill_number) ON DELETE RESTRICT,
      billing_month VARCHAR(7) NOT NULL,
      payment_date DATE NOT NULL,
      amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      method VARCHAR(40) NOT NULL DEFAULT 'M-Pesa',
      reference VARCHAR(80),
      notes TEXT,
      created_by VARCHAR(128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_rem_pay_house ON landlord_remittance_payments (house_paybill_number, billing_month)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_rem_pay_date ON landlord_remittance_payments (house_paybill_number, payment_date)`);

  console.log('[migrate-landlord-ledger] done');
  process.exit(0);
}

main().catch((e) => { console.error('[migrate-landlord-ledger] FAILED:', e); process.exit(1); });
