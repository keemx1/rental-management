const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { pool } = require('../config/database');

const TYPE_BY_DOC_TYPE = {
  invoice: 'other',
  rent_invoice: 'rent',
  maintenance_invoice: 'maintenance',
  exit_invoice: 'exit',
};

async function main() {
  try {
    const docs = await pool.query(
      `SELECT d.id AS document_id, d.doc_number, d.doc_type, d.tenant_code, d.house_paybill_number,
              d.property_name, d.unit_label, d.amount, d.doc_date,
              t.name AS tenant_name, d.created_at
       FROM documents d
       LEFT JOIN tenants t ON t.tenant_code = d.tenant_code
       WHERE d.doc_type IN ('invoice','rent_invoice','maintenance_invoice','exit_invoice')
         AND NOT EXISTS (
           SELECT 1 FROM invoice_register r WHERE r.document_id = d.id
         )
       ORDER BY d.created_at ASC`
    );

    let inserted = 0;
    let skipped = 0;
    for (const row of docs.rows) {
      const invoiceType = TYPE_BY_DOC_TYPE[row.doc_type];
      if (!invoiceType) { skipped += 1; continue; }
      const res = await pool.query(
        `INSERT INTO invoice_register
           (document_id, invoice_number, invoice_type, generated_at, generated_by,
            tenant_code, tenant_name, property_name, house_paybill_number, unit_label,
            amount, status, downloaded_at, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Generated',NULL,NULL)
         ON CONFLICT (document_id) DO NOTHING
         RETURNING id`,
        [
          row.document_id, row.doc_number, invoiceType,
          row.created_at, null,
          row.tenant_code, row.tenant_name, row.property_name,
          row.house_paybill_number, row.unit_label, row.amount,
        ]
      );
      if (res.rowCount > 0) inserted += 1;
    }

    console.log(`[Backfill] Invoice register backfill done. Inserted: ${inserted}, skipped: ${skipped}, existing unregistered: ${docs.rows.length}`);
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('[Backfill] Failed:', err.message);
    await pool.end();
    process.exit(1);
  }
}

main();
