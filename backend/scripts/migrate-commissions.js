/**
 * Commissions migration.
 * 1. payments.allocation_breakdown JSONB — persist the per-payment allocation
 *    (deposit/garbage/water/rent settled) at approval time so commission
 *    reports can split collections precisely per house per month.
 * 2. commission_rates — per-house agent commission percentage.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { query } = require('../config/database');

(async () => {
  try {
    await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS allocation_breakdown JSONB NULL`);
    console.log('Column allocation_breakdown added to payments.');
    await query(`
      CREATE TABLE IF NOT EXISTS commission_rates (
        house_paybill_number VARCHAR(32) PRIMARY KEY,
        rate_percent DECIMAL(5, 2) NOT NULL DEFAULT 0,
        updated_by VARCHAR(128) NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    console.log('Table commission_rates ready.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exitCode = 1;
  } finally {
    process.exit(0);
  }
})();
