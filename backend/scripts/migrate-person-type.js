require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { query } = require('../config/database');

(async () => {
  try {
    await query(`ALTER TABLE staff_advances ADD COLUMN IF NOT EXISTS person_type VARCHAR(50) DEFAULT 'Employee'`);
    console.log('Column person_type added to staff_advances.');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    process.exit(0);
  }
})();
