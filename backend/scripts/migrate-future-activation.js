/**
 * Future tenancy activation repair.
 * 1. payments.future_payment_id — lineage link so booking payments move to the
 *    activated tenancy exactly once (UNIQUE prevents duplicate moves).
 * 2. future_tenancies.activated_tenant_code — the activated tenant's code
 *    (the old activated_tenant_id INTEGER column can never hold codes).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { query } = require('../config/database');

(async () => {
  try {
    await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS future_payment_id INTEGER NULL REFERENCES future_payments(id) ON DELETE SET NULL`);
    console.log('Column future_payment_id added to payments.');
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_future_payment_id ON payments (future_payment_id)`);
    console.log('Unique index uq_payments_future_payment_id created.');
    await query(`ALTER TABLE future_tenancies ADD COLUMN IF NOT EXISTS activated_tenant_code VARCHAR(32) NULL`);
    console.log('Column activated_tenant_code added to future_tenancies.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exitCode = 1;
  } finally {
    process.exit(0);
  }
})();
