const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const bcrypt = require('bcryptjs');
const { testConnection, pool } = require('../config/database');
const store = require('../storage/store');

async function main() {
  try {
    await testConnection();
    const username = process.env.SEED_ADMIN_USERNAME || 'admin';
    const password = process.env.SEED_ADMIN_PASSWORD || 'admin123';
    const user = await store.findUserByUsername(username);
    if (!user) {
      console.error('No users found in database.');
      process.exit(1);
    }
    await store.updateUser(user.id, {
      password_hash: bcrypt.hashSync(password, 12),
      is_active: true,
      role: 'admin',
    });
    console.log(`[Seed] Admin "${username}" password updated.`);
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('[Seed] Failed:', err.message);
    process.exit(1);
  }
}

main();
