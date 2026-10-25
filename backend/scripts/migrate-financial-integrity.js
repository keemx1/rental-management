/**
 * migrate-financial-integrity.js — database-level relationship validation and
 * audit logging for every financial record.
 *
 * 1. payments.source — records the ORIGIN of each payment
 *    (manual | mpesa_parse | booking | ledger_adjustment | ...).
 * 2. Pre-repair: documents/message_logs rows pointing at deleted tenants are
 *    detached safely (with an audit note) so constraints can be enforced.
 * 3. Foreign keys switched/added with ON DELETE RESTRICT so no tenant or
 *    tenancy row that anchors financial history can ever be deleted under it.
 * 4. BEFORE INSERT OR UPDATE OF tenant_code triggers reject any financial
 *    record whose tenant is missing, nameless or has no valid property —
 *    and block re-linking a payment to a different tenant_code.
 *    (NOT plain UPDATE: sealing/vacating legitimately UPDATEs other columns
 *    of rows whose tenant is already archived.)
 * 5. AFTER INSERT triggers write audit_log rows (financial origin) for every
 *    payment, exit invoice and deposit refund; payments also audit approval.
 *
 * Run: node backend/scripts/migrate-financial-integrity.js   (idempotent)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

const VALID_FN = 'enforce_valid_tenancy';
const AUDIT_FN = 'audit_financial_write';

async function columnExists(table, column) {
  const r = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column]
  );
  return r.rows.length > 0;
}

async function fkName(table, column) {
  const r = await query(
    `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f'
        AND c.conrelid = to_regclass($1)
        AND a.attname = $2`,
    [table, column]
  );
  return r.rows[0] ? r.rows[0].conname : null;
}

async function ensureFk(table, column, refTable, refCol, onDelete) {
  const rows = await query(
    `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f'
        AND c.conrelid = to_regclass($1)
        AND a.attname = $2`,
    [table, column]
  );
  for (const r of rows.rows) {
    const def = (await query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1`, [r.conname]
    )).rows[0].d;
    if (def.toUpperCase().includes(`ON DELETE ${onDelete.toUpperCase()}`) && def.includes(`${refTable}(`)) {
      console.log(`  = ${table}.${column} FK ok (${def})`);
      return; // desired constraint present
    }
    await query(`ALTER TABLE ${table} DROP CONSTRAINT ${r.conname}`);
    console.log(`  - dropped old FK ${r.conname} (${def})`);
  }
  await query(
    `ALTER TABLE ${table} ADD CONSTRAINT ${table}_${column}_fkey
     FOREIGN KEY (${column}) REFERENCES ${refTable}(${refCol}) ON DELETE ${onDelete}`
  );
  console.log(`  + ${table}.${column} -> ${refTable}(${refCol}) ON DELETE ${onDelete}`);
}

const VALID_FN_SQL = `
  CREATE OR REPLACE FUNCTION ${VALID_FN}() RETURNS trigger AS $fn$
  BEGIN
    -- Existing records are permanently tied to their tenant: any UPDATE that
    -- rewrites tenant_code is rejected outright (re-linking history is never
    -- allowed), while ordinary updates (status, amounts, sealing) pass through.
    IF TG_OP = 'UPDATE' THEN
      IF NEW.tenant_code IS DISTINCT FROM OLD.tenant_code THEN
        RAISE EXCEPTION 'Financial record cannot be re-linked: % -> % (records stay tied to their original tenant)', OLD.tenant_code, NEW.tenant_code
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.tenant_code IS NULL OR NOT EXISTS (
      SELECT 1 FROM tenants t
       WHERE t.tenant_code = NEW.tenant_code
         AND COALESCE(TRIM(t.name), '') <> ''
         AND t.status <> 'Vacant'
         AND t.house_paybill_number IS NOT NULL
         AND EXISTS (SELECT 1 FROM houses h WHERE h.paybill_number = t.house_paybill_number)
    ) THEN
      RAISE EXCEPTION 'Financial record rejected: tenant_code % is missing, incomplete (no tenant name), vacant or has no valid property', NEW.tenant_code
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END $fn$ LANGUAGE plpgsql;`;

// Lenient variant for water invoices: utility rows legitimately exist for
// vacant units (caretaker/cleaning/construction use) — requires only that the
// unit row exists and belongs to a real property.
const WATER_VALID_FN = 'enforce_valid_tenant_property';
const WATER_VALID_FN_SQL = `
  CREATE OR REPLACE FUNCTION ${WATER_VALID_FN}() RETURNS trigger AS $fn$
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.tenant_code IS DISTINCT FROM OLD.tenant_code THEN
        RAISE EXCEPTION 'Water invoice cannot be re-linked: % -> %', OLD.tenant_code, NEW.tenant_code
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.tenant_code IS NULL OR NOT EXISTS (
      SELECT 1 FROM tenants t
       WHERE t.tenant_code = NEW.tenant_code
         AND t.house_paybill_number IS NOT NULL
         AND EXISTS (SELECT 1 FROM houses h WHERE h.paybill_number = t.house_paybill_number)
    ) THEN
      RAISE EXCEPTION 'Water invoice rejected: unit % does not exist or has no valid property', NEW.tenant_code
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END $fn$ LANGUAGE plpgsql;`;

async function ensureValidationTrigger(table, fnName = VALID_FN, fnSql = VALID_FN_SQL) {
  await query(fnSql);
  const trg = `${table}_validate_tenancy_trg`;
  await query(`DROP TRIGGER IF EXISTS ${trg} ON ${table}`);
  // INSERT always validates; UPDATE only when tenant_code is (re)written —
  // sealing/vacating update other columns and must never be blocked.
  await query(
    `CREATE TRIGGER ${trg} BEFORE INSERT OR UPDATE OF tenant_code ON ${table}
     FOR EACH ROW EXECUTE FUNCTION ${fnName}()`
  );
  console.log(`  + validation trigger ${trg} (${fnName})`);
}

const AUDIT_FN_SQL = `
  CREATE OR REPLACE FUNCTION ${AUDIT_FN}() RETURNS trigger AS $fn$
    DECLARE v JSONB; v_tenancy TEXT;
    BEGIN
      v := to_jsonb(NEW);
      v_tenancy := v->>'tenancy_id';
      INSERT INTO audit_log (actor, action, entity_type, entity_id, details)
      VALUES (
        COALESCE(v->>'source', 'system'),
        TG_ARGV[0],
        TG_ARGV[1],
        COALESCE(v->>'id', ''),
        jsonb_build_object(
          'origin', COALESCE(v->>'source', 'system'),
          'tenant_code', COALESCE(v->>'tenant_code', ''),
          'amount', COALESCE(v->>'amount', COALESCE(v->>'refundable_amount', '0')),
          'reference', COALESCE(v->>'mpesa_reference', COALESCE(v->>'exit_number', COALESCE(v->>'receipt_number', ''))),
          'tenancy_id', CASE WHEN v_tenancy IS NULL THEN NULL ELSE v_tenancy::int END,
          'recorded_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SSOF')
        )::text
      );
      RETURN NEW;
    END $fn$ LANGUAGE plpgsql;`;

async function ensureAuditTrigger(table, kind) {
  await query(AUDIT_FN_SQL);
  const trg = `${table}_audit_${kind}_trg`;
  const action = kind === 'approved' ? 'financial_payment_approved' : 'financial_record_inserted';
  await query(`DROP TRIGGER IF EXISTS ${trg} ON ${table}`);
  if (kind === 'approved') {
    await query(
      `CREATE TRIGGER ${trg} AFTER UPDATE OF status ON ${table}
         FOR EACH ROW
         WHEN (NEW.status = 'Approved' AND OLD.status IS DISTINCT FROM 'Approved')
       EXECUTE FUNCTION ${AUDIT_FN}('${action}', '${table}')`
    );
  } else {
    await query(
      `CREATE TRIGGER ${trg} AFTER INSERT ON ${table}
         FOR EACH ROW EXECUTE FUNCTION ${AUDIT_FN}('${action}', '${table}')`
    );
  }
  console.log(`  + audit trigger ${trg}`);
}

async function detachDangling(table) {
  const r = await query(
    `UPDATE ${table} SET tenant_code = NULL
      WHERE tenant_code IS NOT NULL
        AND tenant_code NOT IN (SELECT tenant_code FROM tenants)`
  );
  if (r.rowCount) {
    console.log(`  ~ ${table}: detached ${r.rowCount} row(s) pointing at deleted tenants`);
    await query(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, details)
       VALUES ('integrity-migration', 'dangling_reference_detached', $1, $2, $3)`,
      [table, 'pre-fk-repair', JSON.stringify({ detached: r.rowCount, reason: 'tenant_code referenced a deleted tenant; detached before enforcing ON DELETE RESTRICT' })]
    );
  } else {
    console.log(`  = ${table}: no dangling tenant references`);
  }
}

async function main() {
  console.log('[migrate-financial-integrity] starting');

  // ── 1. payments.source — traceable origin ──────────────────────────────────
  if (!(await columnExists('payments', 'source'))) {
    await query(`ALTER TABLE payments ADD COLUMN source VARCHAR(32) NOT NULL DEFAULT 'manual'`);
    console.log('  + payments.source');
  } else {
    console.log('  = payments.source present');
  }
  await query(`CREATE INDEX IF NOT EXISTS idx_payments_source ON payments (source)`);

  // ── 2. Pre-repair dangling references (documents / message_logs) ───────────
  console.log('[pre-repair]');
  await detachDangling('documents');
  await detachDangling('message_logs');

  // ── 3. Relationship constraints (RESTRICT = history can never be orphaned) ─
  console.log('[constraints]');
  await ensureFk('payments', 'tenant_code', 'tenants', 'tenant_code', 'RESTRICT');
  await ensureFk('penalties', 'tenant_code', 'tenants', 'tenant_code', 'RESTRICT');
  await ensureFk('tenancy_agreements', 'tenant_code', 'tenants', 'tenant_code', 'RESTRICT');
  await ensureFk('documents', 'tenant_code', 'tenants', 'tenant_code', 'RESTRICT');
  await ensureFk('message_logs', 'tenant_code', 'tenants', 'tenant_code', 'RESTRICT');
  await ensureFk('water_invoices', 'tenant_code', 'tenants', 'tenant_code', 'RESTRICT');
  await ensureFk('exit_invoices', 'tenant_code', 'tenants', 'tenant_code', 'RESTRICT');
  await ensureFk('deposit_refunds', 'tenant_code', 'tenants', 'tenant_code', 'RESTRICT');
  await ensureFk('payments', 'tenancy_id', 'tenancy_archive', 'id', 'RESTRICT');
  await ensureFk('penalties', 'tenancy_id', 'tenancy_archive', 'id', 'RESTRICT');

  // ── 4. Tenancy validation triggers (DB-level) ──────────────────────────────
  console.log('[validation triggers]');
  for (const t of ['payments', 'penalties', 'exit_invoices', 'deposit_refunds']) {
    await ensureValidationTrigger(t);
  }
  await ensureValidationTrigger('water_invoices', WATER_VALID_FN, WATER_VALID_FN_SQL);

  // ── 5. Financial audit trail (DB-level origin logging) ─────────────────────
  console.log('[audit triggers]');
  await ensureAuditTrigger('payments', 'insert');
  await ensureAuditTrigger('payments', 'approved');
  await ensureAuditTrigger('exit_invoices', 'insert');
  await ensureAuditTrigger('deposit_refunds', 'insert');

  console.log('[migrate-financial-integrity] done');
  process.exit(0);
}

main().catch((e) => { console.error('[migrate-financial-integrity] FAILED:', e); process.exit(1); });
