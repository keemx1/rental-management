/**
 * one-off: repair the pre-lock race damage in the agreements inbox.
 *  1) duplicate (tenant_code, filename) rows -> keep lowest id, delete the
 *     extra row AND its Supabase blob
 *  2) suffix-noise files (NAME-<13digits>.pdf in _unmatched) -> delete when
 *     the base name is already stored, else rename back to NAME.pdf
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { query } = require('../config/database');
const agreements = require('../services/tenantAgreements');

async function main() {
  // 1. duplicates
  const dups = await query(
    `SELECT tenant_code, filename, array_agg(id ORDER BY id) AS ids
       FROM tenancy_agreements GROUP BY tenant_code, filename HAVING COUNT(*) > 1`
  );
  console.log('duplicate groups:', dups.rows.length);
  let removed = 0;
  for (const g of dups.rows) {
    const keep = g.ids[0];
    for (const id of g.ids.slice(1)) {
      const row = (await query(`SELECT file_path FROM tenancy_agreements WHERE id = $1`, [id])).rows[0];
      if (row && row.file_path) {
        try { await agreements.deleteAgreementFile(row.file_path); } catch (e) { console.log('blob delete failed:', e.message); }
      }
      await query(`DELETE FROM tenancy_agreements WHERE id = $1`, [id]);
      await query(
        `INSERT INTO audit_log (actor, action, entity_type, entity_id, details)
         VALUES ('agreements-inbox', 'agreement_inbox_deduplicated', 'tenancy_agreement', $1, $2)`,
        [String(id), JSON.stringify({ kept_id: keep, tenant_code: g.tenant_code, filename: g.filename, reason: 'pre-lock race double-store' })]
      ).catch(() => {});
      removed++;
    }
  }
  console.log('duplicate rows removed:', removed);

  // 2. suffix noise in _unmatched
  const root = path.join(__dirname, '..', '..', 'agreements_inbox');
  const umRoot = path.join(root, '_unmatched');
  let deleted = 0, renamed = 0;
  if (fs.existsSync(umRoot)) {
    for (const folder of fs.readdirSync(umRoot)) {
      const dir = path.join(umRoot, folder);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^(.+)-\d{13}(\.[a-z]+)$/i);
        if (!m) continue;
        const base = m[1] + m[2];
        const stored = (await query(
          `SELECT id FROM tenancy_agreements WHERE filename = $1 LIMIT 1`, [base]
        )).rows[0];
        const dest = path.join(root, folder, base);
        if (stored || fs.existsSync(dest)) {
          try { fs.unlinkSync(path.join(dir, f)); deleted++; } catch (e) { console.log('noise delete failed', f, e.message); }
        } else {
          try { fs.renameSync(path.join(dir, f), dest); renamed++; } catch (e) { console.log('noise rename failed', f, e.message); }
        }
      }
    }
  }
  console.log('suffix-noise: deleted(dup)=', deleted, 'renamed(to base)=', renamed);
  const tot = await query(`SELECT COUNT(*)::int AS n FROM tenancy_agreements`);
  console.log('agreements rows now:', tot.rows[0].n);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
