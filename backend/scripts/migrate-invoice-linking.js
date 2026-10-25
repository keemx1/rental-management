/**
 * Invoice Center payment linking.
 * 1. invoice_register.amount_paid / balance_due / last_payment_id — paid
 *    tracking per invoice. Delivery `status` is intentionally untouched.
 * 2. Backfill: every existing invoice starts fully outstanding
 *    (balance_due = amount), since nothing was ever recorded against them.
 * 3. invoice_payment_links — exact per-payment applications (audit + exact
 *    reversal on payment delete). UNIQUE prevents double application.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { query } = require('../config/database');

(async () => {
  try {
    await query(`ALTER TABLE invoice_register ADD COLUMN IF NOT EXISTS amount_paid DECIMAL(10, 2) NOT NULL DEFAULT 0`);
    console.log('Column amount_paid added to invoice_register.');
    await query(`ALTER TABLE invoice_register ADD COLUMN IF NOT EXISTS balance_due DECIMAL(10, 2) NULL`);
    console.log('Column balance_due added to invoice_register.');
    await query(`ALTER TABLE invoice_register ADD COLUMN IF NOT EXISTS last_payment_id INTEGER NULL`);
    console.log('Column last_payment_id added to invoice_register.');
    const back = await query(
      `UPDATE invoice_register SET balance_due = COALESCE(amount, 0) - COALESCE(amount_paid, 0)
       WHERE balance_due IS NULL`
    );
    console.log(`Backfilled balance_due on ${back.rowCount} rows.`);
    await query(`
      CREATE TABLE IF NOT EXISTS invoice_payment_links (
        id SERIAL PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES invoice_register(id) ON DELETE CASCADE,
        payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
        amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (invoice_id, payment_id)
      )`);
    console.log('Table invoice_payment_links ready.');
    await query(`CREATE INDEX IF NOT EXISTS idx_invpay_payment ON invoice_payment_links (payment_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_invpay_invoice ON invoice_payment_links (invoice_id)`);
    console.log('Link indexes created.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exitCode = 1;
  } finally {
    process.exit(0);
  }
})();
