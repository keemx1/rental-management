require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { query } = require('../config/database');

(async () => {
  try {
    await query(`ALTER TABLE exit_invoices ADD COLUMN IF NOT EXISTS water_charges DECIMAL(10, 2) NOT NULL DEFAULT 0`);
    console.log('Column water_charges added to exit_invoices.');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    process.exit(0);
  }
})();
