/**
 * migrate-preexit-inspection.js — Pre-Exit Inspection Inventory tables.
 *
 * Records inspection findings per TENANCY before the Exit Invoice exists,
 * tracks per-item agreement and one-time transfer into the Exit Invoice, and
 * stays bound to the tenancy (sealed to the archive at vacate via
 * TENANCY_SCOPED_TABLES) so a later occupant of the unit can never touch it.
 *
 * Duplicate-transfer protection at the database level:
 *  - trigger refuses any second transition of an item to 'Transferred'
 *  - unique transfer_ref (PEI-{inspection}-{item}) idempotency key
 *
 * Run: node backend/scripts/migrate-preexit-inspection.js   (idempotent)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

async function main() {
  console.log('[migrate-preexit-inspection] starting');

  await query(`
    CREATE TABLE IF NOT EXISTS preexit_inspections (
      id SERIAL PRIMARY KEY,
      tenant_code VARCHAR(32) NOT NULL REFERENCES tenants(tenant_code) ON DELETE RESTRICT,
      tenancy_id INTEGER REFERENCES tenancy_archive(id) ON DELETE SET NULL,
      house_paybill_number VARCHAR(32) REFERENCES houses(paybill_number) ON DELETE SET NULL,
      property_name VARCHAR(128),
      unit_label VARCHAR(64),
      tenant_name VARCHAR(128) NOT NULL,
      inspection_date DATE NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Shared', 'Agreed')),
      shared_at TIMESTAMPTZ,
      edited_after_share BOOLEAN NOT NULL DEFAULT FALSE,
      document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
      created_by VARCHAR(128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_preexit_tenant ON preexit_inspections (tenant_code)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_preexit_tenancy ON preexit_inspections (tenancy_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS preexit_inspection_items (
      id SERIAL PRIMARY KEY,
      inspection_id INTEGER NOT NULL REFERENCES preexit_inspections(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      quantity NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
      cost_per_qty NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost_per_qty >= 0),
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      remarks TEXT,
      agreed BOOLEAN NOT NULL DEFAULT FALSE,
      transfer_status VARCHAR(20) NOT NULL DEFAULT 'Not Transferred'
        CHECK (transfer_status IN ('Not Transferred', 'Transferred')),
      transferred_at TIMESTAMPTZ,
      exit_invoice_id INTEGER REFERENCES exit_invoices(id) ON DELETE SET NULL,
      transfer_ref VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_preexit_items_inspection ON preexit_inspection_items (inspection_id)`);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_preexit_transfer_ref
      ON preexit_inspection_items (transfer_ref) WHERE transfer_ref IS NOT NULL`);

  // Database-level duplicate-transfer protection: an item can transition to
  // 'Transferred' exactly once, ever.
  await query(`
    CREATE OR REPLACE FUNCTION preexit_prevent_double_transfer() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.transfer_status = 'Transferred' AND OLD.transfer_status = 'Transferred' THEN
        RAISE EXCEPTION 'Inspection item % was already transferred to exit invoice % (duplicate transfer blocked)',
          OLD.id, OLD.exit_invoice_id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $fn$ LANGUAGE plpgsql`);
  await query(`DROP TRIGGER IF EXISTS trg_preexit_no_double_transfer ON preexit_inspection_items`);
  await query(`
    CREATE TRIGGER trg_preexit_no_double_transfer
      BEFORE UPDATE OF transfer_status ON preexit_inspection_items
      FOR EACH ROW EXECUTE FUNCTION preexit_prevent_double_transfer()`);

  console.log('[migrate-preexit-inspection] done');
  process.exit(0);
}

main().catch((e) => { console.error('[migrate-preexit-inspection] FAILED:', e); process.exit(1); });
