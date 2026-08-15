const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { pool } = require('../config/database');

async function main() {
  try {
    const schemaPath = path.resolve(__dirname, '../../schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(sql);
    console.log('[Schema] Applied schema.sql successfully.');
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('[Schema] Failed:', err.message);
    process.exit(1);
  }
}

main();
