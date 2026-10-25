const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { pool } = require('../config/database');

async function main() {
  try {
    await pool.query(`ALTER TABLE staff_advance_payments ADD COLUMN IF NOT EXISTS payment_time TIME NULL`);
    console.log('[Migration] Added payment_time column to staff_advance_payments.');
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('[Migration] Failed:', err.message);
    process.exit(1);
  }
}

main();
