/**
 * Tenancy agreement metadata (Supabase Storage holds the bytes).
 * Ownership = tenant_code on every row; every access re-verifies it,
 * so one tenant's dashboard can never reach another tenant's files.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { query } = require('../config/database');

(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS tenancy_agreements (
        id SERIAL PRIMARY KEY,
        tenant_code VARCHAR(32) NOT NULL REFERENCES tenants(tenant_code) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        filename VARCHAR(255) NOT NULL DEFAULT '',
        mimetype VARCHAR(64) NOT NULL DEFAULT 'application/pdf',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        uploaded_by VARCHAR(128) NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    console.log('Table tenancy_agreements ready.');
    await query(`CREATE INDEX IF NOT EXISTS idx_tenancy_agreements_tenant ON tenancy_agreements (tenant_code)`);
    console.log('Index created.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exitCode = 1;
  } finally {
    process.exit(0);
  }
})();
