/**
 * Offline-first Phase 3 migration.
 *
 * 1. `anomaly_flag` / `anomaly_detail` on water_invoices — unusual readings
 *    are flagged (warn) instead of silently posted.
 * 2. New `sync_conflicts` table — server-side record of rejected offline
 *    uploads (duplicate payments, occupied-unit move-ins, invalid readings)
 *    for the manager review queue. Resolutions flow back to devices.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { query } = require('../config/database');

(async () => {
  try {
    await query(`ALTER TABLE water_invoices ADD COLUMN IF NOT EXISTS anomaly_flag VARCHAR(16) NULL`);
    await query(`ALTER TABLE water_invoices ADD COLUMN IF NOT EXISTS anomaly_detail TEXT NULL`);
    console.log('Anomaly columns added to water_invoices.');

    await query(`
      CREATE TABLE IF NOT EXISTS sync_conflicts (
        id SERIAL PRIMARY KEY,
        client_txn_id TEXT NULL,
        op_type VARCHAR(32) NOT NULL DEFAULT '',
        tenant_code VARCHAR(32) NULL,
        summary JSONB NOT NULL DEFAULT '{}',
        reason TEXT NOT NULL DEFAULT '',
        existing_ref JSONB NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        resolution VARCHAR(16) NULL,
        resolved_by VARCHAR(128) NULL,
        resolved_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    console.log('Table sync_conflicts ready.');
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_conflicts_client_txn_id ON sync_conflicts (client_txn_id)`);
    console.log('Unique index uq_sync_conflicts_client_txn_id created.');
    await query(`CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status ON sync_conflicts (status)`);
    console.log('Index idx_sync_conflicts_status created.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exitCode = 1;
  } finally {
    process.exit(0);
  }
})();
