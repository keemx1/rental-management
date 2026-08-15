const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[DB] DATABASE_URL is not set in environment.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('supabase.com')
    ? { rejectUnauthorized: false }
    : undefined,
});

async function query(text, params) {
  return pool.query(text, params);
}

async function runSchemaSql() {
  const schemaPath = path.resolve(__dirname, '../../schema.sql');
  if (fs.existsSync(schemaPath)) {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(sql);
    console.log('[DB] Schema initialized successfully.');
  } else {
    console.warn('[DB] schema.sql not found.');
  }
}

async function seedDefaultData() {
  // Check if users table has rows
  const usersRes = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(usersRes.rows[0].count, 10) === 0) {
    const username = process.env.SEED_ADMIN_USERNAME || 'admin';
    const password = process.env.SEED_ADMIN_PASSWORD || 'admin123';
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(password, 12);
    await pool.query(
      `INSERT INTO users (username, password_hash, display_name, role, is_active)
       VALUES ($1, $2, $3, $4, $5)`,
      [username, hash, 'Administrator', 'admin', true]
    );
    console.log(`[DB] Seeded admin user: ${username}`);
  }

  // Check if houses table has rows
  const housesRes = await pool.query('SELECT COUNT(*) FROM houses');
  const shouldSeedDemo = String(process.env.SEED_DEMO_TENANTS || '').toLowerCase() === 'true';
  if (parseInt(housesRes.rows[0].count, 10) === 0 && shouldSeedDemo) {
    // Seed a single house (building) with multiple units
    const h1 = await pool.query(
      `INSERT INTO houses (paybill_number, house_name, total_units, notes)
       VALUES ($1, $2, $3, $4) RETURNING paybill_number`,
      ['H001', 'Sunrise Apartments', 2, '']
    );
    console.log('[DB] Seeded demo house.');

    const h1Id = h1.rows[0].paybill_number;

    // Seed tenants with distinct unit labels
    const addDaysISO = (days) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      return d.toISOString().slice(0, 10);
    };

    await pool.query(
      `INSERT INTO tenants (tenant_code, name, phone_number, house_paybill_number, property_name, unit_label, rent_amount, rent_due_date, rent_due_time, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      ['T001', 'Jane Wanjiku', '254712345678', h1Id, 'Sunrise Apartments', 'A4', 15000, addDaysISO(5), '23:59:00', 'Active']
    );
    await pool.query(
      `INSERT INTO tenants (tenant_code, name, phone_number, house_paybill_number, property_name, unit_label, rent_amount, rent_due_date, rent_due_time, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      ['T002', 'Peter Ochieng', '254723456789', h1Id, 'Sunrise Apartments', 'B2', 12000, addDaysISO(-2), '18:00:00', 'Overdue']
    );
    console.log('[DB] Seeded demo tenants.');
  }

  // Check templates
  const templatesRes = await pool.query('SELECT COUNT(*) FROM message_templates');
  if (parseInt(templatesRes.rows[0].count, 10) === 0) {
    await pool.query(
      `INSERT INTO message_templates (key, name, body) VALUES
       ($1, $2, $3),
       ($4, $5, $6),
       ($7, $8, $9)`,
      [
        'gentle_reminder', 'Gentle Rent Reminder', 'Hello {{client_name}}, this is a gentle reminder from {{house_name}} {{house_number}} that your rent payment is due soon. Please reach out if you need support.',
        'maintenance_notice', 'Maintenance Notice', 'Hello {{client_name}}, kindly note there will be maintenance at {{house_name}} {{house_number}} tomorrow from 9:00 AM to 2:00 PM. Thank you for your cooperation.',
        'security_update', 'Security Update', 'Hello {{client_name}}, this is a security update for residents of {{house_name}} {{house_number}}. Please ensure your doors are locked and report suspicious activity immediately.'
      ]
    );
    console.log('[DB] Seeded demo message templates.');
  }
}

async function testConnection() {
  try {
    const client = await pool.connect();
    client.release();
    console.log('[DB] Supabase PostgreSQL connected.');
    
    // Auto-run schema and seed
    await runSchemaSql();
    await seedDefaultData();
  } catch (err) {
    console.error('[DB] Database connection / initialization failed:', err.message);
    process.exit(1);
  }
}

function usingPostgres() {
  return true;
}

module.exports = {
  pool,
  query,
  testConnection,
  usingPostgres,
  get store() {
    return require('../storage/store');
  },
};
