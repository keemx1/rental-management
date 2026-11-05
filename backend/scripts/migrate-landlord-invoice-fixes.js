/**
 * Landlord commission fixes (2026-11-06):
 *  1. Detach-not-delete requires nullable landlord_id on the commission
 *     ledgers - they were created NOT NULL, so the landlord delete could never
 *     detach rows (and the swallowed failure aborted the transaction, killing
 *     the delete with "current transaction is aborted").
 *  2. Commission invoice payment method (Till / Paybill) - the figure filled in
 *     at generation and printed on the invoice.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

(async () => {
  const ddl = [
    `ALTER TABLE commission_invoices ALTER COLUMN landlord_id DROP NOT NULL`,
    `ALTER TABLE commission_payments ALTER COLUMN landlord_id DROP NOT NULL`,
    `ALTER TABLE landlord_remittance_payments ALTER COLUMN landlord_id DROP NOT NULL`,
    `ALTER TABLE commission_invoices ADD COLUMN IF NOT EXISTS payment_method VARCHAR(16)`,
    `ALTER TABLE commission_invoices ADD COLUMN IF NOT EXISTS payment_number VARCHAR(32)`,
    `ALTER TABLE commission_invoices ADD COLUMN IF NOT EXISTS payment_account_name VARCHAR(128)`,
  ];
  for (const sql of ddl) {
    try { await query(sql); console.log('OK ', sql); }
    catch (e) { console.log('FAIL', sql, '->', e.message); }
  }
  const cols = (await query(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='commission_invoices' AND column_name LIKE 'payment%'`)).rows;
  console.log('commission_invoices payment columns:', cols);
  process.exit(0);
})();
