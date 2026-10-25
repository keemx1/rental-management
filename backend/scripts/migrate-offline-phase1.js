/**
 * Offline-first Phase 1 migration: idempotency key for payments.
 *
 * Adds `client_txn_id` (UUID generated on the device) to `payments` with a
 * UNIQUE constraint so an offline payment that is uploaded twice (retry,
 * double sync, two sync attempts) can never create a duplicate row.
 * Existing rows keep NULL (Postgres allows multiple NULLs in a UNIQUE column).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { query } = require('../config/database');

(async () => {
  try {
    await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS client_txn_id TEXT NULL`);
    console.log('Column client_txn_id added to payments.');
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_client_txn_id ON payments (client_txn_id)`);
    console.log('Unique index uq_payments_client_txn_id created.');
    // Speed up the M-Pesa duplicate-reference check used during sync.
    await query(`CREATE INDEX IF NOT EXISTS idx_payments_mpesa_reference ON payments (mpesa_reference)`);
    console.log('Index idx_payments_mpesa_reference created.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exitCode = 1;
  } finally {
    process.exit(0);
  }
})();
