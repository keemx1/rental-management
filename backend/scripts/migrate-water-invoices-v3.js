/**
 * Water Invoices v3 — Monthly Rent & Utility Invoice
 * Adds rent, garbage, and outstanding balance fields to water_invoices.
 */
require('dotenv').config();
const { Pool } = require('pg');

async function run() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cols = [
      `ALTER TABLE water_invoices ADD COLUMN IF NOT EXISTS rent_amount DECIMAL(12,2) NOT NULL DEFAULT 0`,
      `ALTER TABLE water_invoices ADD COLUMN IF NOT EXISTS garbage_fee DECIMAL(12,2) NOT NULL DEFAULT 0`,
      `ALTER TABLE water_invoices ADD COLUMN IF NOT EXISTS rent_arrears DECIMAL(12,2) NOT NULL DEFAULT 0`,
      `ALTER TABLE water_invoices ADD COLUMN IF NOT EXISTS water_arrears DECIMAL(12,2) NOT NULL DEFAULT 0`,
      `ALTER TABLE water_invoices ADD COLUMN IF NOT EXISTS garbage_arrears DECIMAL(12,2) NOT NULL DEFAULT 0`,
      `ALTER TABLE water_invoices ADD COLUMN IF NOT EXISTS other_arrears DECIMAL(12,2) NOT NULL DEFAULT 0`,
      `ALTER TABLE water_invoices ADD COLUMN IF NOT EXISTS total_previous_outstanding DECIMAL(12,2) NOT NULL DEFAULT 0`,
      `ALTER TABLE water_invoices ADD COLUMN IF NOT EXISTS total_amount_payable DECIMAL(12,2) NOT NULL DEFAULT 0`,
    ];

    for (const sql of cols) {
      await client.query(sql);
      console.log('  OK:', sql.replace(/ALTER TABLE water_invoices ADD COLUMN IF NOT EXISTS /, ''));
    }

    await client.query('COMMIT');
    console.log('Water invoices v3 migration complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().then(() => process.exit(0)).catch(() => process.exit(1));
