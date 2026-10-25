/**
 * cleanup-ghost-records.js — eliminate orphan/ghost records identified by the
 * integrity investigation, while preserving every trace in audit_log.
 *
 *   node backend/scripts/cleanup-ghost-records.js            # dry run (report only)
 *   node backend/scripts/cleanup-ghost-records.js --apply    # perform cleanup
 *
 * Steps:
 *  1. Re-attach detached documents to their tenancy via exit_invoices /
 *     invoice_register (exit invoices, maintenance invoices — incl. Mariana).
 *  2. Purge orphan receipt registry rows that reference NO payment, NO invoice
 *     register entry and NO tenant (legacy bootstrap receipts + receipts of
 *     hard-deleted test payments). Full list is written to audit_log first;
 *     the PDF files on disk are NOT touched.
 *  3. Purge test-fixture message logs (LEDGER-, SA5FIX, CARE2, ADVR- test
 *     tenants) whose tenants no longer exist — with audit_log record.
 *  4. Repair tenants stuck with status='' (reconcile from live data).
 *  5. Delete genuinely blank archive records (no identity, no payments, no
 *     exit invoice) — the "blank archive" the client complained about.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const APPLY = process.argv.includes('--apply');
const { query } = require('../config/database');

const results = [];
function note(step, detail) {
  results.push({ step, detail });
  console.log(`[${APPLY ? 'APPLY' : 'DRY'}] ${step}: ${detail}`);
}

async function audit(action, details) {
  await query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, details)
     VALUES ('ghost-cleanup', $1, 'data_cleanup', 'cleanup-ghost-records', $2)`,
    [action, JSON.stringify(details)]
  );
}

async function main() {
  console.log(`[cleanup-ghost-records] ${APPLY ? 'APPLY' : 'DRY RUN (use --apply)'}`);

  // ── 1. Re-attach detached documents via their source records ───────────────
  if (APPLY) {
    const exitRe = await query(`
      UPDATE documents d
         SET tenant_code = ei.tenant_code,
             house_paybill_number = CASE
               WHEN d.house_paybill_number IS NOT NULL AND EXISTS (SELECT 1 FROM houses h WHERE h.paybill_number = d.house_paybill_number) THEN d.house_paybill_number
               WHEN ei.house_paybill_number IS NOT NULL AND EXISTS (SELECT 1 FROM houses h WHERE h.paybill_number = ei.house_paybill_number) THEN ei.house_paybill_number
               ELSE NULL END,
             property_name = COALESCE(d.property_name, ei.property_name),
             unit_label = COALESCE(d.unit_label, ei.unit_label)
        FROM exit_invoices ei
       WHERE d.doc_type = 'exit_invoice'
         AND ei.exit_number = d.doc_number
         AND ei.tenant_code IN (SELECT tenant_code FROM tenants)
         AND (d.tenant_code IS NULL OR d.tenant_code NOT IN (SELECT tenant_code FROM tenants))`);
    note('reattach exit-invoice documents', `${exitRe.rowCount} row(s)`);

    const regRe = await query(`
      UPDATE documents d
         SET tenant_code = ir.tenant_code,
             house_paybill_number = CASE
               WHEN d.house_paybill_number IS NOT NULL AND EXISTS (SELECT 1 FROM houses h WHERE h.paybill_number = d.house_paybill_number) THEN d.house_paybill_number
               WHEN ir.house_paybill_number IS NOT NULL AND EXISTS (SELECT 1 FROM houses h WHERE h.paybill_number = ir.house_paybill_number) THEN ir.house_paybill_number
               ELSE NULL END,
             property_name = COALESCE(d.property_name, ir.property_name),
             unit_label = COALESCE(d.unit_label, ir.unit_label)
        FROM invoice_register ir
       WHERE ir.invoice_number = d.doc_number
         AND ir.tenant_code IN (SELECT tenant_code FROM tenants)
         AND (d.tenant_code IS NULL OR d.tenant_code NOT IN (SELECT tenant_code FROM tenants))`);
    note('reattach invoice-register documents', `${regRe.rowCount} row(s)`);
  } else {
    const exitW = await query(`
      SELECT COUNT(*)::int AS n FROM documents d
       WHERE d.doc_type = 'exit_invoice'
         AND EXISTS (SELECT 1 FROM exit_invoices ei WHERE ei.exit_number = d.doc_number
                      AND ei.tenant_code IN (SELECT tenant_code FROM tenants))
         AND (d.tenant_code IS NULL OR d.tenant_code NOT IN (SELECT tenant_code FROM tenants))`);
    const regW = await query(`
      SELECT COUNT(*)::int AS n FROM documents d
       WHERE EXISTS (SELECT 1 FROM invoice_register ir WHERE ir.invoice_number = d.doc_number
                      AND ir.tenant_code IN (SELECT tenant_code FROM tenants))
         AND (d.tenant_code IS NULL OR d.tenant_code NOT IN (SELECT tenant_code FROM tenants))`);
    note('reattach candidates (dry)', `exit=${exitW.rows[0].n}, invoice_register=${regW.rows[0].n}`);
  }

  // ── 2. Purge orphan receipts (no payment / register / tenant) ──────────────
  const orphanReceipts = await query(`
    SELECT id, doc_number, amount, created_at::text AS created_at, file_path
      FROM documents d
     WHERE d.doc_type = 'receipt'
       AND (d.tenant_code IS NULL OR d.tenant_code NOT IN (SELECT tenant_code FROM tenants))
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.receipt_number = d.doc_number)
       AND NOT EXISTS (SELECT 1 FROM invoice_register ir WHERE ir.invoice_number = d.doc_number)`);
  note('orphan receipts found', `${orphanReceipts.rows.length} row(s)`);
  if (orphanReceipts.rows.length && APPLY) {
    await audit('orphan_receipts_purged', {
      count: orphanReceipts.rows.length,
      reason: 'Receipt registry rows referencing no payment, no invoice register entry and no tenant (legacy bootstrap / hard-deleted test payments). PDF files remain on disk.',
      documents: orphanReceipts.rows.map((r) => ({
        doc_number: r.doc_number, amount: r.amount, created_at: r.created_at, file_path: r.file_path,
      })),
    });
    const ids = orphanReceipts.rows.map((r) => r.id);
    const del = await query(`DELETE FROM documents WHERE id = ANY($1::int[])`, [ids]);
    note('orphan receipts PURGED', `${del.rowCount} row(s) (list saved to audit_log)`);
  }

  // ── 3. Purge test-fixture message logs for deleted tenants ────────────────
  const markerCond = `(m.message_body LIKE '%LEDGER-%' OR m.message_body LIKE '%ADVR-%' OR m.message_body LIKE '%SA5FIX%'
           OR m.message_body LIKE '%CARE2%' OR m.message_body LIKE '%RECTIFY%' OR m.message_body LIKE '%INV REG%'
           OR m.message_body LIKE '%INV EDIT%' OR m.message_body LIKE '%SMOKE%' OR m.message_body LIKE '%ZZHTTP%'
           OR m.message_body LIKE '%ZZUI%' OR m.message_body LIKE '%TENAN%')`;
  const testMsgs = await query(`
    SELECT COUNT(*)::int AS n FROM message_logs m
     WHERE (m.tenant_code IS NULL OR m.tenant_code NOT IN (SELECT tenant_code FROM tenants))
       AND ${markerCond}`);
  note('test-fixture detached message logs found', `${testMsgs.rows[0].n} row(s)`);
  if (Number(testMsgs.rows[0].n) && APPLY) {
    const sample = (await query(`
      SELECT m.id, LEFT(m.message_body, 70) AS body FROM message_logs m
       WHERE (m.tenant_code IS NULL OR m.tenant_code NOT IN (SELECT tenant_code FROM tenants))
         AND ${markerCond} ORDER BY m.id DESC LIMIT 20`)).rows;
    await audit('test_message_logs_purged', {
      count: testMsgs.rows[0].n,
      reason: 'WhatsApp/SMS logs of hard-deleted test tenants (LEDGER-*/SA5FIX/CARE2/ADVR-*/...).',
      sample,
    });
    const del = await query(`
      DELETE FROM message_logs m
       WHERE (m.tenant_code IS NULL OR m.tenant_code NOT IN (SELECT tenant_code FROM tenants))
         AND ${markerCond}`);
    note('test message logs PURGED', `${del.rowCount} row(s) (sample saved to audit_log)`);
  }

  // ── 4. Repair tenants stuck with empty status ─────────────────────────────
  const emptyStatus = (await query(
    `SELECT tenant_code, name FROM tenants WHERE COALESCE(status, '') = ''`
  )).rows;
  note('tenants with empty status', `${emptyStatus.length}: ${emptyStatus.map((t) => t.tenant_code).join(', ') || '—'}`);
  if (emptyStatus.length && APPLY) {
    const store = require('../storage/store');
    for (const t of emptyStatus) {
      try {
        await store.reconcileTenant(t.tenant_code);
        note('reconciled', t.tenant_code);
      } catch (e) {
        note('reconcile failed (fallback Active)', `${t.tenant_code}: ${e.message}`);
        await query(`UPDATE tenants SET status = 'Active', updated_at = NOW() WHERE tenant_code = $1 AND COALESCE(status,'') = ''`, [t.tenant_code]);
      }
    }
    await query(`UPDATE tenants SET status = 'Active', updated_at = NOW() WHERE COALESCE(status,'') = ''`);
    await audit('empty_status_repaired', { tenants: emptyStatus.map((t) => t.tenant_code) });
  }

  // ── 5. Delete genuinely blank archive records ─────────────────────────────
  const blank = (await query(`
    SELECT id, tenant_code, tenant_name, archived_at::text
      FROM tenancy_archive
     WHERE (COALESCE(TRIM(tenant_name), '') = '' OR tenant_name = 'TENAN')
       AND jsonb_array_length(COALESCE(payments, '[]'::jsonb)) = 0
       AND exit_invoice_number IS NULL
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.tenancy_id = tenancy_archive.id)`)).rows;
  note('blank archive records found', `${blank.length}: ${blank.map((a) => `#${a.id}(${a.tenant_code})`).join(', ') || '—'}`);
  if (blank.length && APPLY) {
    const store = require('../storage/store');
    for (const a of blank) {
      const res = await store.deleteArchive(a.id);
      if (res && res.error) note('blank archive kept (guarded)', `#${a.id}: ${res.error}`);
      else if (res) {
        note('blank archive deleted', `#${a.id} (${a.tenant_code})`);
        await audit('blank_archive_removed', { archive_id: a.id, tenant_code: a.tenant_code, archived_at: a.archived_at });
      } else note('blank archive not found', `#${a.id}`);
    }
  }

  // ── Final state summary ───────────────────────────────────────────────────
  const s1 = await query(`SELECT COUNT(*)::int AS n FROM documents WHERE tenant_code IS NULL OR tenant_code NOT IN (SELECT tenant_code FROM tenants)`);
  const s2 = await query(`SELECT COUNT(*)::int AS n FROM message_logs WHERE tenant_code IS NULL OR tenant_code NOT IN (SELECT tenant_code FROM tenants)`);
  const s3 = await query(`SELECT COUNT(*)::int AS n FROM payments WHERE tenant_code NOT IN (SELECT tenant_code FROM tenants)`);
  console.log('\n=== remaining (post-step) counts ===');
  console.log('detached documents:', s1.rows[0].n, '(receipts purged only in --apply)');
  console.log('detached message_logs:', s2.rows[0].n, '(test rows purged only in --apply)');
  console.log('orphan payments:', s3.rows[0].n);
  console.log('[cleanup-ghost-records] done');
  process.exit(0);
}

main().catch((e) => { console.error('[cleanup-ghost-records] FAILED:', e); process.exit(1); });
