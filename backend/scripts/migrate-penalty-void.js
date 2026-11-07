require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

(async () => {
  // 1. Allow 'Void' on penalties (unsupported charges are voided with audit,
  //    never deleted - same pattern as water_invoices).
  const cons = (await query(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'penalties'::regclass AND contype = 'c'`)).rows;
  for (const c of cons) {
    if (/status/i.test(c.def) && /Pending/.test(c.def)) {
      await query(`ALTER TABLE penalties DROP CONSTRAINT "${c.conname}"`);
      await query(`ALTER TABLE penalties ADD CONSTRAINT "${c.conname}" CHECK (status IN ('Pending', 'Paid', 'Void'))`);
      console.log('OK penalties status constraint now allows Void:', c.conname);
    }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
