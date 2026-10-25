/**
 * Offline-first Phase 2 migration.
 *
 * 1. `client_txn_id` (device UUID) + UNIQUE index on work_orders,
 *    maintenance_invoices, water_invoices, exit_invoices — offline creates
 *    uploaded twice can never duplicate.
 * 2. New `inspections` table — property inspections conducted offline.
 * 3. New `media_attachments` table — compressed photos linked to records.
 * 4. `client_txn_id` + UNIQUE index on whatsapp_message_queue — offline
 *    notices (Pending Send) delivered exactly once on sync.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { query } = require('../config/database');

(async () => {
  try {
    for (const table of ['work_orders', 'maintenance_invoices', 'water_invoices', 'exit_invoices']) {
      await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS client_txn_id TEXT NULL`);
      console.log(`Column client_txn_id added to ${table}.`);
      const idx = `uq_${table}_client_txn_id`;
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${table} (client_txn_id)`);
      console.log(`Unique index ${idx} created.`);
    }

    await query(`
      CREATE TABLE IF NOT EXISTS inspections (
        id SERIAL PRIMARY KEY,
        client_txn_id TEXT NULL,
        tenant_code VARCHAR(32) NULL,
        property_name VARCHAR(128) NOT NULL DEFAULT '',
        house_paybill_number VARCHAR(32) NULL,
        unit_label VARCHAR(64) NULL,
        inspection_date DATE NOT NULL DEFAULT CURRENT_DATE,
        checklist JSONB NOT NULL DEFAULT '{}',
        photos_count INTEGER NOT NULL DEFAULT 0,
        notes TEXT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'Draft',
        created_by VARCHAR(128) NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        synced_at TIMESTAMPTZ NULL
      )`);
    console.log('Table inspections ready.');
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_inspections_client_txn_id ON inspections (client_txn_id)`);
    console.log('Unique index uq_inspections_client_txn_id created.');

    await query(`
      CREATE TABLE IF NOT EXISTS media_attachments (
        id SERIAL PRIMARY KEY,
        client_txn_id TEXT NULL,
        linked_type VARCHAR(32) NOT NULL,
        linked_client_txn_id TEXT NULL,
        linked_id INTEGER NULL,
        filename VARCHAR(255) NOT NULL DEFAULT '',
        mimetype VARCHAR(64) NOT NULL DEFAULT 'image/jpeg',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        storage_path TEXT NOT NULL DEFAULT '',
        created_by VARCHAR(128) NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    console.log('Table media_attachments ready.');
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_media_client_txn_id ON media_attachments (client_txn_id)`);
    console.log('Unique index uq_media_client_txn_id created.');

    await query(`ALTER TABLE whatsapp_message_queue ADD COLUMN IF NOT EXISTS client_txn_id TEXT NULL`);
    console.log('Column client_txn_id added to whatsapp_message_queue.');
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_queue_client_txn_id ON whatsapp_message_queue (client_txn_id)`);
    console.log('Unique index uq_wa_queue_client_txn_id created.');

    await query(`ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS client_txn_id TEXT NULL`);
    console.log('Column client_txn_id added to message_logs.');
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_message_logs_client_txn_id ON message_logs (client_txn_id)`);
    console.log('Unique index uq_message_logs_client_txn_id created.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exitCode = 1;
  } finally {
    process.exit(0);
  }
})();
