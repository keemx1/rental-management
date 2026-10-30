'use strict';

/**
 * Agreements Inbox — drop-folder automation for tenancy agreement PDFs.
 *
 * FOLDER CONTRACT (the only thing management needs to remember):
 *   agreements_inbox/<House Name or Paybill>/<unit or tenant code>.pdf
 *   agreements_inbox/_processed/...   ← successfully stored files (kept)
 *   agreements_inbox/_unmatched/...   ← files that could not be matched
 *
 * Match order: folder → house (name OR paybill, case-insensitive) →
 * ACTIVE tenant by unit label or tenant code (scoped to that house).
 * Matched files are stored in the tenant's existing private Agreements
 * store (Supabase per-tenant prefix) with a tenancy_agreements row —
 * duplicates (same filename already stored) are skipped.
 *
 * NO automatic sending: WhatsApp is never touched. Management shares
 * from the tenant's Agreements section exactly as today.
 *
 * Safety: files younger than 3s are skipped (mid-copy); every outcome is
 * audited; processed files are MOVED (never re-processed on the next run).
 */

const fs = require('fs');
const path = require('path');

const ROOT = () => process.env.AGREEMENTS_INBOX_DIR
  || path.join(__dirname, '..', '..', 'agreements_inbox');
const PROCESSED = '_processed';
const UNMATCHED = '_unmatched';
const MIN_AGE_MS = 3000;
const EXT = /\.(pdf|jpe?g|png)$/i;

let _timer = null;
let _lastRun = null;
let _running = false;

async function findHouse(name) {
  const { query } = require('../config/database');
  const r = (await query(
    `SELECT paybill_number, house_name FROM houses
      WHERE UPPER(TRIM(house_name)) = UPPER(TRIM($1)) OR paybill_number = TRIM($1)
      LIMIT 1`,
    [name]
  )).rows[0];
  return r || null;
}

async function findActiveTenant(housePaybill, token) {
  const { query } = require('../config/database');
  // Occupied = anything that is not Vacant (Active, Paid, Overdue,
  // Partially Paid …) — matching how the dashboard treats occupancy.
  const r = (await query(
    `SELECT tenant_code, name, unit_label FROM tenants
      WHERE house_paybill_number = $1 AND COALESCE(status, '') <> 'Vacant'
        AND (UPPER(tenant_code) = UPPER($2) OR UPPER(COALESCE(unit_label, '')) = UPPER($2))
      LIMIT 1`,
    [housePaybill, token]
  )).rows[0];
  return r || null;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Collision-safe move (same-name files keep a unique suffix in _processed).
function moveFile(src, destDir, label = '') {
  ensureDir(destDir);
  const base = path.basename(src);
  let dest = path.join(destDir, base);
  if (fs.existsSync(dest)) {
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    dest = path.join(destDir, `${stem}-${Date.now()}${ext}`);
  }
  fs.renameSync(src, dest);
  return dest;
}

async function storeFileForTenant(tenantCode, filePath, originalName, actor) {
  const buffer = fs.readFileSync(filePath);
  if (!buffer.length) throw new Error('Empty file');
  if (buffer.length > 12 * 1024 * 1024) throw new Error('File exceeds the 12 MB limit');
  // Module-level call so tests can stub the Supabase-backed uploader.
  const agreements = require('./tenantAgreements');
  const stored = await agreements.uploadAgreement({
    tenantCode, buffer, mimetype: 'application/pdf', originalName,
  });
  const { query } = require('../config/database');
  const row = (await query(
    `INSERT INTO tenancy_agreements (tenant_code, file_path, filename, mimetype, size_bytes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [tenantCode, stored.path, String(originalName).slice(0, 255), stored.mimetype, stored.size, actor || 'agreements-inbox']
  )).rows[0];
  const store = require('../storage/store');
  await store.logAudit({
    actor: actor || 'agreements-inbox',
    action: 'agreement_inbox_stored',
    entityType: 'tenancy_agreement',
    entityId: String(row.id),
    details: { tenant_code: tenantCode, filename: originalName, size: stored.size },
  }).catch(() => {});
  return row;
}

async function auditUnmatched(file, folder, reason, actor) {
  try {
    const store = require('../storage/store');
    await store.logAudit({
      actor: actor || 'agreements-inbox',
      action: 'agreement_inbox_unmatched',
      entityType: 'agreement_inbox',
      entityId: file,
      details: { folder, reason },
    });
  } catch (_) {}
}

async function runInboxOnce({ actor } = {}) {
  const root = ROOT();
  ensureDir(root);
  const summary = {
    ran_at: new Date().toISOString(),
    root,
    scanned: 0,
    processed: [],
    duplicates: [],
    unmatched: [],
    skipped_recent: [],
    errors: [],
  };

  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) {
    summary.errors.push({ file: root, error: e.message });
    return summary;
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === PROCESSED || ent.name === UNMATCHED) continue;
    const dir = path.join(root, ent.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => EXT.test(f)); } catch (_) { continue; }

    for (const f of files) {
      summary.scanned++;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (Date.now() - st.mtimeMs < MIN_AGE_MS) {
          summary.skipped_recent.push(`${ent.name}/${f}`);
          continue;
        }
        const base = path.basename(f, path.extname(f));
        const house = await findHouse(ent.name);
        if (!house) {
          const reason = 'Folder does not match any property — use the exact house name or paybill number.';
          const dest = moveFile(full, path.join(root, UNMATCHED, ent.name));
          summary.unmatched.push({ file: `${ent.name}/${f}`, reason, moved: dest });
          await auditUnmatched(`${ent.name}/${f}`, ent.name, reason, actor);
          continue;
        }
        // Exact match first, then space-insensitive ("MB 9.pdf" -> MB9).
        const tenant = (await findActiveTenant(house.paybill_number, base))
          || (await findActiveTenant(house.paybill_number, base.replace(/\s+/g, '')));
        if (!tenant) {
          const reason = `No ACTIVE tenant in ${house.house_name} with unit/code "${base}".`;
          const dest = moveFile(full, path.join(root, UNMATCHED, ent.name));
          summary.unmatched.push({ file: `${ent.name}/${f}`, reason, moved: dest });
          await auditUnmatched(`${ent.name}/${f}`, ent.name, reason, actor);
          continue;
        }
        // Duplicate guard: same filename already stored for this tenant.
        const { query } = require('../config/database');
        const dup = (await query(
          `SELECT id FROM tenancy_agreements WHERE tenant_code = $1 AND filename = $2 LIMIT 1`,
          [tenant.tenant_code, f]
        )).rows[0];
        if (dup) {
          const dest = moveFile(full, path.join(root, PROCESSED, ent.name));
          summary.duplicates.push({ file: `${ent.name}/${f}`, tenant: tenant.tenant_code, agreement_id: dup.id, moved: dest });
          continue;
        }
        const row = await storeFileForTenant(tenant.tenant_code, full, f, actor);
        const dest = moveFile(full, path.join(root, PROCESSED, ent.name));
        summary.processed.push({
          file: `${ent.name}/${f}`, tenant: tenant.tenant_code, tenant_name: tenant.name,
          agreement_id: row.id, moved: dest,
        });
      } catch (err) {
        summary.errors.push({ file: `${ent.name}/${f}`, error: err.message });
      }
    }
  }

  _lastRun = summary;
  return summary;
}

// Serialised: the 60s watcher and a manual POST /process can NEVER run the
// scan concurrently (a racing pair double-stored files before the lock).
let _inflight = null;
async function processInbox(opts = {}) {
  if (_inflight) return _inflight;
  _inflight = runInboxOnce(opts).finally(() => { _inflight = null; });
  return _inflight;
}

function startWatcher(intervalMs = 60000) {
  if (_timer) return _timer;
  ensureDir(ROOT());
  const tick = async () => {
    if (_running) return;
    _running = true;
    try {
      const s = await processInbox({ actor: 'agreements-inbox' });
      if (s.processed.length || s.unmatched.length || s.errors.length) {
        console.log(`[AgreementsInbox] ${s.processed.length} stored, ${s.unmatched.length} unmatched, ${s.errors.length} errors`);
      }
    } catch (e) {
      console.error('[AgreementsInbox] run failed:', e.message);
    } finally {
      _running = false;
    }
  };
  _timer = setInterval(tick, intervalMs);
  if (typeof _timer.unref === 'function') _timer.unref();
  setTimeout(tick, 15000).unref?.();
  console.log(`[AgreementsInbox] watching ${ROOT()} every ${Math.round(intervalMs / 1000)}s (store-only, no sending)`);
  return _timer;
}

function stopWatcher() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function status() {
  return { watching: !!_timer, root: ROOT(), last_run: _lastRun };
}

module.exports = { processInbox, startWatcher, stopWatcher, status, ROOT };
