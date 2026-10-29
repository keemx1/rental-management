/**
 * migrate-landlord-agreements.js — Landlord Ledger enhancement (v77):
 * agreements/terms, transfer verification, reconciliation, monthly
 * finalization, reviews, false-payment reversal support.
 *
 *  - landlords: default remittance/MFI due days + approved payment details
 *  - houses: per-property MFI due-day override
 *  - landlord_remittance_payments: verification workflow
 *    (Pending Verification -> Verified; ONLY Verified reduces balances)
 *  - landlord_ledger_finalizations: one final row per property-month
 *  - landlord_reviews: Under Review / Resolved dispute trail
 *
 * Run: node backend/scripts/migrate-landlord-agreements.js  (idempotent)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

async function main() {
  console.log('[migrate-landlord-agreements] starting');

  // ── Agreement terms + payment details on the landlord ────────────────────
  await query(`ALTER TABLE landlords ADD COLUMN IF NOT EXISTS default_remittance_day INTEGER CHECK (default_remittance_day BETWEEN 1 AND 31)`);
  await query(`ALTER TABLE landlords ADD COLUMN IF NOT EXISTS default_mfi_due_day INTEGER CHECK (default_mfi_due_day BETWEEN 1 AND 31)`);
  await query(`ALTER TABLE landlords ADD COLUMN IF NOT EXISTS mpesa_number VARCHAR(32)`);
  await query(`ALTER TABLE landlords ADD COLUMN IF NOT EXISTS bank_name VARCHAR(80)`);
  await query(`ALTER TABLE landlords ADD COLUMN IF NOT EXISTS bank_account VARCHAR(80)`);
  await query(`ALTER TABLE landlords ADD COLUMN IF NOT EXISTS payment_details_note TEXT`);

  // Per-property override of the management-fee invoice due day.
  await query(`ALTER TABLE houses ADD COLUMN IF NOT EXISTS landlord_mfi_due_day INTEGER CHECK (landlord_mfi_due_day BETWEEN 1 AND 31)`);

  // Snapshot the agreed due date onto each management-fee invoice.
  await query(`ALTER TABLE commission_invoices ADD COLUMN IF NOT EXISTS due_date DATE`);

  // ── Transfer verification workflow ────────────────────────────────────────
  await query(`ALTER TABLE landlord_remittance_payments
    ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'Pending Verification'`);
  await query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'landlord_remittance_payments_status_check') THEN
      ALTER TABLE landlord_remittance_payments ADD CONSTRAINT landlord_remittance_payments_status_check
        CHECK (status IN ('Pending Verification', 'Verified'));
    END IF; END $$`);
  await query(`ALTER TABLE landlord_remittance_payments ADD COLUMN IF NOT EXISTS proof_note TEXT`);
  await query(`ALTER TABLE landlord_remittance_payments ADD COLUMN IF NOT EXISTS recipient_details TEXT`);
  await query(`ALTER TABLE landlord_remittance_payments ADD COLUMN IF NOT EXISTS verified_by VARCHAR(128)`);
  await query(`ALTER TABLE landlord_remittance_payments ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ`);
  await query(`ALTER TABLE landlord_remittance_payments ADD COLUMN IF NOT EXISTS authorized_by VARCHAR(128)`);

  // Existing transfers were already treated as real money — mark Verified.
  await query(`
    UPDATE landlord_remittance_payments
       SET status = 'Verified',
           verified_by = COALESCE(created_by, 'migration'),
           verified_at = COALESCE(created_at, NOW())
     WHERE status = 'Pending Verification' AND created_at < NOW() - interval '1 minute'`);

  // ── Monthly finalization (protected months) ──────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS landlord_ledger_finalizations (
      id SERIAL PRIMARY KEY,
      house_paybill_number VARCHAR(32) NOT NULL REFERENCES houses(paybill_number) ON DELETE RESTRICT,
      billing_month VARCHAR(7) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Finalized' CHECK (status IN ('Finalized')),
      finalized_by VARCHAR(128),
      finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reopened_by VARCHAR(128),
      reopened_at TIMESTAMPTZ
    )`);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_landlord_ledger_final
      ON landlord_ledger_finalizations (house_paybill_number, billing_month) WHERE status = 'Finalized'`);

  // ── Disputes / Under Review trail ────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS landlord_reviews (
      id SERIAL PRIMARY KEY,
      house_paybill_number VARCHAR(32) NOT NULL REFERENCES houses(paybill_number) ON DELETE RESTRICT,
      billing_month VARCHAR(7),
      target_type VARCHAR(40) NOT NULL DEFAULT 'ledger',
      target_id VARCHAR(80),
      status VARCHAR(20) NOT NULL DEFAULT 'Under Review' CHECK (status IN ('Under Review', 'Resolved')),
      reason TEXT NOT NULL,
      evidence_note TEXT,
      created_by VARCHAR(128),
      resolved_by VARCHAR(128),
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_landlord_reviews_house ON landlord_reviews (house_paybill_number, status)`);

  console.log('[migrate-landlord-agreements] done');
  process.exit(0);
}

main().catch((e) => { console.error('[migrate-landlord-agreements] FAILED:', e); process.exit(1); });
