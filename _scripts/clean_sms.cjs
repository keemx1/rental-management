require('dotenv').config({ path: 'C:/apps/rental_messaging/.env' });
const { Pool } = require('C:/apps/rental_messaging/node_modules/pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await p.query(`UPDATE sms_settings SET setting_value='' WHERE setting_key='api_token'`);
  await p.query(`UPDATE sms_settings SET setting_value='' WHERE setting_key='sender_id'`);
  const r = await p.query(`SELECT setting_key, setting_value FROM sms_settings ORDER BY setting_key`);
  console.log('cleaned; sms_settings =', JSON.stringify(r.rows));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
