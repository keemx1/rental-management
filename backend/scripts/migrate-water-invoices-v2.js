/**
 * Migration: Add payment_month and payment_terms to water_invoices
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  console.log('Running water invoice v2 migration...');

  try {
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'water_invoices' AND column_name = 'payment_month'
        ) THEN
          ALTER TABLE water_invoices ADD COLUMN payment_month VARCHAR(20) NULL;
        END IF;
      END $$;
    `);
    console.log('  + water_invoices.payment_month');
  } catch (e) { console.log('  ~ payment_month:', e.code); }

  try {
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'water_invoices' AND column_name = 'payment_terms'
        ) THEN
          ALTER TABLE water_invoices ADD COLUMN payment_terms TEXT NULL;
        END IF;
      END $$;
    `);
    console.log('  + water_invoices.payment_terms');
  } catch (e) { console.log('  ~ payment_terms:', e.code); }

  console.log('Water invoice v2 migration complete.');
  await pool.end();
})().catch(async (err) => {
  console.error('Migration failed:', err);
  await pool.end();
  process.exit(1);
});
