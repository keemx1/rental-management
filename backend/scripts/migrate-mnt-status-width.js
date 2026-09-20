/**
 * Widen maintenance_invoices.status from VARCHAR(20) to VARCHAR(32)
 * so that 'Pending Reimbursement' (21 chars) fits.
 */
require('dotenv').config();
const { Pool } = require('pg');

async function run() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('ALTER TABLE maintenance_invoices ALTER COLUMN status TYPE VARCHAR(32)');
    console.log('OK: maintenance_invoices.status widened to VARCHAR(32)');
  } catch (err) {
    console.error('Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().then(() => process.exit(0)).catch(() => process.exit(1));
