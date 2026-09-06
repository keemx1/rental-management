require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  try {
    const check = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='tenants' AND column_name='arrears_manually_set'");
    if (check.rows.length === 0) {
      await pool.query('ALTER TABLE tenants ADD COLUMN arrears_manually_set BOOLEAN NOT NULL DEFAULT FALSE');
      console.log('Column arrears_manually_set added successfully');
    } else {
      console.log('Column arrears_manually_set already exists');
    }
  } catch(e) { console.error('Error:', e.message); }
  finally { await pool.end(); }
})();
