/**
 * migrate-deposit-reinstatement.js — Cancel unpaid refunds, restore the
 * original deposit, reinstate the tenancy / reassign a vacant unit.
 *
 * - deposit_refunds: cancellation fields + 'cancelled_reinstated' status
 * - payments: ORIGIN snapshot (immutable: where the money was first
 *   received) + CURRENT ALLOCATION columns (where it sits now) + link to
 *   the reinstatement — money received once, allocation can change
 * - deposit_reinstatements: one row per cancelled refund (UNIQUE refund id
 *   = duplicate-restoration proof) with the full auditable chain
 *
 * Run: node backend/scripts/migrate-deposit-reinstatement.js (idempotent)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

async function main() {
  console.log('[migrate-deposit-reinstatement] starting');

  await query(`ALTER TABLE deposit_refunds ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
  await query(`ALTER TABLE deposit_refunds ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(128)`);
  await query(`ALTER TABLE deposit_refunds ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`);
  await query(`ALTER TABLE deposit_refunds DROP CONSTRAINT IF EXISTS deposit_refunds_refund_status_check`);
  await query(`
    ALTER TABLE deposit_refunds ADD CONSTRAINT deposit_refunds_refund_status_check
      CHECK (refund_status IN ('pending','due_soon','due_today','overdue','refunded',
                               'partially_refunded','no_refund_due','cancelled_reinstated'))`);

  // Original payment source (never overwritten) vs current allocation.
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS origin_house_paybill VARCHAR(32)`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS origin_unit VARCHAR(64)`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS origin_tenant_code VARCHAR(32)`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS allocation_house_paybill VARCHAR(32)`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS allocation_unit VARCHAR(64)`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS allocation_tenant_code VARCHAR(32)`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS allocation_date DATE`);
  await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS reinstatement_id INTEGER`);

  await query(`
    CREATE TABLE IF NOT EXISTS deposit_reinstatements (
      id SERIAL PRIMARY KEY,
      deposit_refund_id INTEGER NOT NULL UNIQUE REFERENCES deposit_refunds(id) ON DELETE RESTRICT,
      exit_invoice_id INTEGER REFERENCES exit_invoices(id) ON DELETE SET NULL,
      refund_invoice_number VARCHAR(64),
      archive_id INTEGER REFERENCES tenancy_archive(id) ON DELETE SET NULL,
      original_payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
      original_tenant_code VARCHAR(32) NOT NULL,
      original_tenant_name VARCHAR(160),
      original_house_paybill VARCHAR(32),
      original_unit VARCHAR(64),
      original_amount NUMERIC(14,2) NOT NULL,
      original_receipt_number VARCHAR(64),
      original_reference VARCHAR(120),
      original_payment_date DATE,
      original_payment_method VARCHAR(64),
      outcome VARCHAR(30) NOT NULL CHECK (outcome IN ('REINSTATED_SAME_UNIT','REASSIGNED','DEPOSIT_ONLY')),
      new_tenant_code VARCHAR(32),
      new_house_paybill VARCHAR(32),
      new_unit VARCHAR(64),
      new_rent NUMERIC(14,2),
      refundable_amount NUMERIC(14,2),
      deposit_restored NUMERIC(14,2) NOT NULL,
      reason TEXT NOT NULL,
      actor VARCHAR(128),
      reinstated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      receipt_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL
    )`);
  await query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payments_reinstatement') THEN
        ALTER TABLE payments ADD CONSTRAINT fk_payments_reinstatement
          FOREIGN KEY (reinstatement_id) REFERENCES deposit_reinstatements(id) ON DELETE SET NULL;
      END IF; END $$`);

  console.log('[migrate-deposit-reinstatement] done');
  process.exit(0);
}

main().catch((e) => { console.error('[migrate-deposit-reinstatement] FAILED:', e); process.exit(1); });
