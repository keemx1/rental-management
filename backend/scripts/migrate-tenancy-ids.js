/**
 * migrate-tenancy-ids.js — Bind every financial/tenancy record to the
 * specific tenancy (occupancy period) it belongs to.
 *
 * Adds a nullable `tenancy_id` column (→ tenancy_archive.id) to every table
 * that carries a tenant's money or documents. NULL means "belongs to the
 * CURRENT live tenancy of this unit code"; a non-NULL value permanently binds
 * the row to a completed tenancy that can never be altered by whoever moves
 * into the unit afterwards.
 *
 * Backfill: rows already recorded before an archived tenancy closed are
 * stamped to that archive (payment/invoice/document dated on or before the
 * tenancy's move-out, or recorded before the archive snapshot was taken).
 * Rows recorded after the close belong to the next/current tenancy and stay
 * NULL.
 *
 * Run: node backend/scripts/migrate-tenancy-ids.js   (idempotent)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

const TABLES = [
  { table: 'payments', ts: 'recorded_at', date: 'payment_date' },
  { table: 'penalties', ts: 'created_at', date: 'invoice_date' },
  { table: 'documents', ts: 'created_at', date: null },
  { table: 'water_invoices', ts: 'created_at', date: 'billing_month' },
  { table: 'deposit_applications', ts: 'created_at', date: 'billing_period' },
  { table: 'credit_allocations', ts: 'applied_at', date: null },
  { table: 'message_logs', ts: 'logged_at', date: null },
  { table: 'tenancy_agreements', ts: 'created_at', date: null },
  { table: 'inspections', ts: 'created_at', date: null },
  { table: 'maintenance_charges', ts: 'created_at', date: null },
];

async function columnExists(table, column) {
  const r = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column]
  );
  return r.rows.length > 0;
}

async function main() {
  console.log('[migrate-tenancy-ids] starting');

  for (const { table } of TABLES) {
    if (!(await columnExists(table, 'tenancy_id'))) {
      await query(`ALTER TABLE ${table} ADD COLUMN tenancy_id INTEGER`);
      console.log(`  + ${table}.tenancy_id`);
    } else {
      console.log(`  = ${table}.tenancy_id already present`);
    }
    await query(`CREATE INDEX IF NOT EXISTS idx_${table}_tenancy ON ${table} (tenancy_id)`);
  }

  // Backfill: stamp rows that provably belonged to an archived tenancy.
  for (const { table, ts, date } of TABLES) {
    const dateClause = date ? ` OR ${date}::text <= COALESCE(a.move_out_date::text, '')` : '';
    const r = await query(
      `UPDATE ${table} r SET tenancy_id = a.id
         FROM tenancy_archive a
        WHERE r.tenant_code = a.tenant_code
          AND r.tenancy_id IS NULL
          AND (r.${ts} <= a.archived_at${dateClause})
          AND NOT EXISTS (
            SELECT 1 FROM tenancy_archive a2
             WHERE a2.tenant_code = a.tenant_code
               AND (a2.archived_at > a.archived_at)
               AND (r.${ts} <= a2.archived_at${date ? ` OR ${date}::text <= COALESCE(a2.move_out_date::text, '')` : ''})
          )`
    );
    if (r.rowCount) console.log(`  ~ ${table}: stamped ${r.rowCount} row(s)`);
  }

  const counts = await query(
    `SELECT 'payments' AS tbl, COUNT(*)::int AS sealed FROM payments WHERE tenancy_id IS NOT NULL
     UNION ALL SELECT 'penalties', COUNT(*)::int FROM penalties WHERE tenancy_id IS NOT NULL
     UNION ALL SELECT 'documents', COUNT(*)::int FROM documents WHERE tenancy_id IS NOT NULL
     UNION ALL SELECT 'water_invoices', COUNT(*)::int FROM water_invoices WHERE tenancy_id IS NOT NULL`
  );
  console.log('[migrate-tenancy-ids] sealed rows:', counts.rows);
  console.log('[migrate-tenancy-ids] done');
  process.exit(0);
}

main().catch((e) => { console.error('[migrate-tenancy-ids] FAILED:', e); process.exit(1); });
