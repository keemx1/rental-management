/**
 * Migration: Water Bill Invoice system
 * - Create water_invoices table
 * - Add water_rate_per_unit to houses
 * - Seed GEHPM-WTR counter
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run(label, sql) {
  try {
    await pool.query(sql);
    console.log(`  + ${label}`);
  } catch (err) {
    if (err.code === '42710' || err.code === '42P07' || err.code === '23505') {
      console.log(`  ~ ${label} (already exists)`);
    } else {
      console.error(`  ! ${label}: ${err.message}`);
    }
  }
}

(async () => {
  console.log('Running water invoice migration...');

  await run('houses.water_rate_per_unit', `
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'houses' AND column_name = 'water_rate_per_unit'
      ) THEN
        ALTER TABLE houses ADD COLUMN water_rate_per_unit DECIMAL(10, 2) NOT NULL DEFAULT 0;
      END IF;
    END $$;
  `);

  await run('water_invoices table', `
    CREATE TABLE IF NOT EXISTS water_invoices (
      id SERIAL PRIMARY KEY,
      wtr_number VARCHAR(32) NOT NULL UNIQUE,
      tenant_code VARCHAR(32) NOT NULL,
      tenant_name VARCHAR(128) NOT NULL DEFAULT '',
      property_name VARCHAR(128) NOT NULL DEFAULT '',
      house_paybill_number VARCHAR(32) NULL REFERENCES houses(paybill_number) ON DELETE SET NULL,
      unit_label VARCHAR(64) NULL,
      billing_month VARCHAR(20) NOT NULL,
      previous_reading NUMERIC(10, 2) NOT NULL DEFAULT 0,
      current_reading NUMERIC(10, 2) NOT NULL DEFAULT 0,
      units_used NUMERIC(10, 2) NOT NULL DEFAULT 0,
      rate_per_unit DECIMAL(10, 2) NOT NULL DEFAULT 0,
      total_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
      due_date DATE NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'Draft'
        CHECK (status IN ('Draft', 'Finalized', 'Sent', 'Downloaded', 'Downloaded & Sent', 'Paid', 'Void')),
      void_reason TEXT NULL,
      notes TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await run('idx_wtrinv_tenant', `CREATE INDEX IF NOT EXISTS idx_wtrinv_tenant ON water_invoices (tenant_code);`);
  await run('idx_wtrinv_house', `CREATE INDEX IF NOT EXISTS idx_wtrinv_house ON water_invoices (house_paybill_number);`);
  await run('idx_wtrinv_status', `CREATE INDEX IF NOT EXISTS idx_wtrinv_status ON water_invoices (status);`);
  await run('idx_wtrinv_billing', `CREATE INDEX IF NOT EXISTS idx_wtrinv_billing ON water_invoices (billing_month);`);
  await run('idx_wtrinv_number', `CREATE INDEX IF NOT EXISTS idx_wtrinv_number ON water_invoices (wtr_number);`);

  await run('water_rate_history table', `
    CREATE TABLE IF NOT EXISTS water_rate_history (
      id SERIAL PRIMARY KEY,
      house_paybill VARCHAR(32) NOT NULL REFERENCES houses(paybill_number) ON DELETE CASCADE,
      old_rate DECIMAL(10, 2) NOT NULL,
      new_rate DECIMAL(10, 2) NOT NULL,
      effective_month VARCHAR(20) NOT NULL,
      changed_by VARCHAR(128) NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await run('GEHPM-WTR counter', `
    INSERT INTO invoice_counters (prefix, next_number) VALUES ('GEHPM-WTR', 1) ON CONFLICT (prefix) DO NOTHING;
  `);

  console.log('Water invoice migration complete.');
  await pool.end();
})().catch(async (err) => {
  console.error('Migration failed:', err);
  await pool.end();
  process.exit(1);
});
