/**
 * Documents Hub letter templates (additive only).
 * 1. documents.template_key — which letter template a row was made from.
 * 2. documents.status — 'Draft' | 'Finalized' (existing rows → Finalized).
 * 3. documents.body_text — editable letter body (drafts; frozen on finalize).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { query } = require('../config/database');

(async () => {
  try {
    await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS template_key VARCHAR(64) NULL`);
    console.log('Column template_key added to documents.');
    await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'Finalized'`);
    console.log('Column status added to documents.');
    await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS body_text TEXT NULL`);
    console.log('Column body_text added to documents.');
    await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS resolved_recipient TEXT NULL`);
    console.log('Column resolved_recipient added to documents.');
    await query(`CREATE INDEX IF NOT EXISTS idx_documents_template ON documents (template_key)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status)`);
    console.log('Letter indexes created.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exitCode = 1;
  } finally {
    process.exit(0);
  }
})();
