const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[purge-demo-tenants] DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  const client = await pool.connect();
  try {
    const tenantCodes = ['T001', 'T002'];
    const houseCodes = ['H001', 'H002'];

    const tenantsRes = await client.query(
      `DELETE FROM tenants WHERE tenant_code = ANY($1::text[]) RETURNING id, tenant_code, name`,
      [tenantCodes]
    );

    const removedTenants = tenantsRes.rows || [];
    console.log(`[purge-demo-tenants] Removed tenants: ${removedTenants.length}`);
    for (const t of removedTenants) console.log(`- ${t.tenant_code}: ${t.name}`);

    if (process.argv.includes('--houses')) {
       const housesRes = await client.query(
         `DELETE FROM houses WHERE paybill_number = ANY($1::text[]) RETURNING id, paybill_number, house_name, total_units`,
         [houseCodes]
       );
       const removedHouses = housesRes.rows || [];
       console.log(`[purge-demo-tenants] Removed houses: ${removedHouses.length}`);
       for (const h of removedHouses) console.log(`- ${h.paybill_number}: ${h.house_name} ${h.total_units}`);
    } else {
      console.log('[purge-demo-tenants] (Tip) Run with --houses to also remove demo houses H001/H002.');
    }
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('[purge-demo-tenants] Failed:', err.message);
    pool.end().finally(() => process.exit(1));
  });

