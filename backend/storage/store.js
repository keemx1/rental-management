/**
 * PostgreSQL Database Storage layer.
 */
const { query, pool } = require('../config/database');

async function init() {
  // No-op: Table creation and seeding is handled on startup in database.js
}

// Run a query on a transaction client if one is provided (allows a batch of
// writes to be committed atomically / rolled back together), otherwise fall
// back to the shared pool's auto-commit query.
async function runOrQuery(run, sql, params) {
  if (typeof run === 'function') return run(sql, params);
  return query(sql, params);
}

async function findUserByUsername(username) {
  const res = await query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  return res.rows[0] || null;
}

async function findUserById(id) {
  const res = await query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function updateUser(id, patch) {
  const fields = [];
  const values = [];
  let index = 1;
  
  for (const [key, val] of Object.entries(patch)) {
    if (key === 'id') continue;
    fields.push(`${key} = $${index++}`);
    values.push(val);
  }
  
  if (fields.length === 0) return findUserById(id);
  
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const q = `UPDATE users SET ${fields.join(', ')} WHERE id = $${index} RETURNING *`;
  const res = await query(q, values);
  return res.rows[0] || null;
}

async function listUsers() {
  const res = await query('SELECT id, username, display_name, role, is_active, created_at, last_login_at FROM users ORDER BY username ASC');
  return res.rows;
}

async function createUser(data) {
  const res = await query(
    `INSERT INTO users (username, password_hash, display_name, role, is_active)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      data.username,
      data.password_hash,
      data.display_name || '',
      data.role || 'operator',
      data.is_active !== false
    ]
  );
  return res.rows[0];
}

async function deleteUser(id) {
  await query('DELETE FROM users WHERE id = $1', [id]);
  return { ok: true };
}

async function listHouses(filters = {}) {
  let q = 'SELECT *, paybill_number AS id FROM houses';
  const params = [];
  if (filters.q) {
    q += ' WHERE LOWER(house_name) LIKE $1 OR LOWER(paybill_number) LIKE $1';
    params.push(`%${filters.q.toLowerCase()}%`);
  }
  q += ' ORDER BY house_name ASC';
  const res = await query(q, params);
  return res.rows;
}

async function getHouse(paybill_number, run) {
  const res = await runOrQuery(run, 'SELECT *, paybill_number AS id FROM houses WHERE paybill_number = $1', [paybill_number]);
  return res.rows[0] || null;
}

async function createHouse(data) {
  const res = await query(
    `INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status, notes, garbage_fee_enabled, payment_method, payment_paybill, account_number_format, till_number, till_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *, paybill_number AS id`,
    [
      data.paybill_number,
      data.house_name || 'General',
      data.total_units,
      data.occupancy_status || 'unknown',
      data.notes || '',
      data.garbage_fee_enabled || false,
      data.payment_method || 'paybill',
      data.payment_paybill || null,
      data.account_number_format || null,
      data.till_number || null,
      data.till_name || null,
    ]
  );
  return res.rows[0];
}

async function updateHouse(paybill_number, patch) {
  const fields = [];
  const values = [];
  let index = 1;
  
  for (const [key, val] of Object.entries(patch)) {
    if (key === 'paybill_number') continue;
    fields.push(`${key} = $${index++}`);
    values.push(val);
  }
  
  if (fields.length === 0) return getHouse(paybill_number);
  
  fields.push(`updated_at = NOW()`);
  values.push(paybill_number);
  const q = `UPDATE houses SET ${fields.join(', ')} WHERE paybill_number = $${index} RETURNING *, paybill_number AS id`;
  const res = await query(q, values);
  return res.rows[0] || null;
}

async function deleteHouse(paybill_number) {
  const assignedRes = await query('SELECT COUNT(*) FROM tenants WHERE house_paybill_number = $1', [paybill_number]);
  const assigned = parseInt(assignedRes.rows[0].count, 10);
  if (assigned > 0) return { ok: false, reason: 'House has clients assigned' };
  
  await query('DELETE FROM houses WHERE paybill_number = $1', [paybill_number]);
  return { ok: true };
}

async function listTenants(filters = {}) {
  let q = `SELECT t.*, t.tenant_code AS id, t.house_paybill_number AS house_id, t.rent_due_date::text AS rent_due_date, h.payment_method, h.payment_paybill, h.account_number_format, h.till_number, h.till_name FROM tenants t LEFT JOIN houses h ON t.house_paybill_number = h.paybill_number`;
  const conditions = [];
  const params = [];
  let index = 1;
  
  if (filters.status) {
    conditions.push(`status = $${index++}`);
    params.push(filters.status);
  } else if (filters.exclude_vacant !== false) {
    conditions.push(`status != 'Vacant'`);
  }
  if (filters.house_id) {
    conditions.push(`house_paybill_number = $${index++}`);
    params.push(String(filters.house_id));
  }
  if (filters.q) {
    conditions.push(`(LOWER(name) LIKE $${index} OR LOWER(tenant_code) LIKE $${index} OR phone_number LIKE $${index})`);
    params.push(`%${filters.q.toLowerCase()}%`);
    index++;
  }
  
  if (conditions.length > 0) {
    q += ' WHERE ' + conditions.join(' AND ');
  }
  q += ' ORDER BY name ASC';
  
  const res = await query(q, params);
  return res.rows.map(r => ({ ...r, rent_amount: Number(r.rent_amount), arrears: Number(r.arrears || 0), deposit_amount: Number(r.deposit_amount || 0), deposit_paid: Number(r.deposit_paid || 0), garbage_fee_amount: Number(r.garbage_fee_amount || 0), garbage_fee_paid: Number(r.garbage_fee_paid || 0), water_charge_amount: Number(r.water_charge_amount || 0), water_charge_paid: Number(r.water_charge_paid || 0), rent_paid_this_month: Number(r.rent_paid_this_month || 0), credit_balance: Number(r.credit_balance || 0), advance_rent_balance: Number(r.advance_rent_balance || 0), opening_advance_rent: Number(r.opening_advance_rent || 0), agreement_charge: Number(r.agreement_charge || 0), agreement_paid: Number(r.agreement_paid || 0), agreement_outstanding: Number(r.agreement_outstanding || 0) }));
}

async function getTenant(id, run) {
  const res = await runOrQuery(run,
    `SELECT t.tenant_code AS id, t.tenant_code, t.name, t.phone_number, t.national_id, t.house_paybill_number AS house_id, t.property_name, t.unit_label, t.rent_amount, t.arrears, t.arrears_manually_set, t.deposit_amount, t.deposit_paid, t.garbage_fee_amount, t.garbage_fee_paid, t.water_charge_amount, t.water_charge_paid, t.rent_paid_this_month, t.credit_balance, t.advance_rent_until::text AS advance_rent_until, t.advance_rent_balance, t.opening_advance_rent, t.agreement_charge, t.agreement_paid, t.agreement_outstanding, t.move_in_date::text AS move_in_date, t.move_out_date::text AS move_out_date, t.notice_to_vacate_date::text AS notice_to_vacate_date, t.exit_reason, t.rent_due_date::text AS rent_due_date, t.rent_due_time, t.status, t.created_at, t.updated_at, t.guardian_name, t.guardian_id, t.guardian_phone, t.guardian_relationship, t.standard_monthly_rent, t.first_billing_method, t.first_billing_charge, t.first_billing_reason, t.first_billing_days, h.payment_method, h.payment_paybill, h.account_number_format, h.till_number, h.till_name
     FROM tenants t LEFT JOIN houses h ON t.house_paybill_number = h.paybill_number WHERE t.tenant_code = $1`,
    [id]
  );
  if (!res.rows[0]) return null;
  return { ...res.rows[0], rent_amount: Number(res.rows[0].rent_amount), arrears: Number(res.rows[0].arrears || 0), deposit_amount: Number(res.rows[0].deposit_amount || 0), deposit_paid: Number(res.rows[0].deposit_paid || 0), garbage_fee_amount: Number(res.rows[0].garbage_fee_amount || 0), garbage_fee_paid: Number(res.rows[0].garbage_fee_paid || 0), water_charge_amount: Number(res.rows[0].water_charge_amount || 0), water_charge_paid: Number(res.rows[0].water_charge_paid || 0), rent_paid_this_month: Number(res.rows[0].rent_paid_this_month || 0), credit_balance: Number(res.rows[0].credit_balance || 0), advance_rent_balance: Number(res.rows[0].advance_rent_balance || 0), opening_advance_rent: Number(res.rows[0].opening_advance_rent || 0), agreement_charge: Number(res.rows[0].agreement_charge || 0), agreement_paid: Number(res.rows[0].agreement_paid || 0), agreement_outstanding: Number(res.rows[0].agreement_outstanding || 0) };
}

async function createTenant(data) {
  let property_name = data.property_name || 'General';
  let garbageFeeEnabled = false;
  let houseCharges = [];
  if (data.house_id) {
    const house = await getHouse(data.house_id);
    if (house) {
      property_name = house.house_name;
      garbageFeeEnabled = house.garbage_fee_enabled === true || house.garbage_fee_enabled === 't';
    }
    // Also load charges from the new house_charges table
    try {
      const chargeRes = await query(
        `SELECT * FROM house_charges WHERE house_paybill = $1 AND enabled = TRUE ORDER BY sort_order, id`,
        [data.house_id]
      );
      houseCharges = chargeRes.rows;
    } catch (_) {}
  }
  
  // Compute garbage fee: explicit override > house_charges > legacy garbage_fee_enabled > 0
  let garbageFeeAmount = data.garbage_fee_amount != null && Number(data.garbage_fee_amount) > 0
    ? Number(data.garbage_fee_amount)
    : (garbageFeeEnabled ? 2000 : 0);

  // Compute water charge: explicit override > house_charges > 0
  let waterChargeAmount = Number(data.water_charge_amount) || 0;

  // Apply enabled one-time charges from house_charges
  for (const hc of houseCharges) {
    const name = (hc.charge_name || '').toLowerCase();
    if (name.includes('garbage') && garbageFeeAmount === 0) {
      garbageFeeAmount = Number(hc.amount) || 2000;
    } else if (name.includes('water') && waterChargeAmount === 0) {
      waterChargeAmount = Number(hc.amount) || 0;
    }
  }

  const openingArrears = Number(data.arrears || data.opening_arrears || 0);
  const openingAdvance = Number(data.opening_advance_rent || 0);
  if (openingArrears > 0 && openingAdvance > 0) {
    throw new Error('A tenant cannot have both Opening Arrears and Opening Advance Rent at the same time');
  }

  const agreementCharge = Number(data.agreement_charge || 0);
  const agreementPaid = Number(data.agreement_paid || 0);
  const agreementOutstanding = Math.max(0, agreementCharge - agreementPaid);

  const res = await query(
    `INSERT INTO tenants (tenant_code, name, phone_number, national_id, house_paybill_number, property_name, rent_amount, deposit_amount, garbage_fee_amount, water_charge_amount, move_in_date, rent_due_date, rent_due_time, status, arrears, opening_advance_rent, agreement_charge, agreement_paid, agreement_outstanding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING *, tenant_code AS id, house_paybill_number AS house_id, rent_due_date::text AS rent_due_date, move_in_date::text AS move_in_date`,
    [
      data.tenant_code,
      data.name,
      data.phone_number,
      data.national_id || null,
      data.house_id ? String(data.house_id) : null,
      property_name,
      Number(data.rent_amount) || 0,
      Number(data.deposit_amount) || 0,
      garbageFeeAmount,
      waterChargeAmount,
      data.move_in_date || null,
      data.rent_due_date,
      data.rent_due_time || '23:59:00',
      data.status || 'Active',
      openingArrears,
      openingAdvance,
      agreementCharge,
      agreementPaid,
      agreementOutstanding
    ]
  );

  if (openingAdvance > 0) {
    await seedOpeningAdvance(data.tenant_code, openingAdvance);
  }

  return { ...res.rows[0], rent_amount: Number(res.rows[0].rent_amount), deposit_amount: Number(res.rows[0].deposit_amount || 0), garbage_fee_amount: Number(res.rows[0].garbage_fee_amount || 0) };
}

/**
 * Opening advance rent (migration) seeds the advance rent system so that
 * the opening balance reduces the current month's rent and any remainder
 * reduces future shortfalls during monthly rollover.
 */
async function seedOpeningAdvance(tenantCode, amount) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;
  const rent = Number(tenant.rent_amount || 0);
  if (rent <= 0 || amount <= 0) return null;

  const now = new Date();
  const currentMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const fullMonths = Math.floor(amount / rent);
  const partial = Number((amount - fullMonths * rent).toFixed(2));

  let advanceUntil = null;
  if (fullMonths > 0) {
    advanceUntil = addMonths(currentMonthStart, fullMonths - 1);
  }
  if (partial > 0) {
    const partialMonthStart = fullMonths > 0 ? addMonths(currentMonthStart, fullMonths) : currentMonthStart;
    const d = new Date(partialMonthStart + 'T12:00:00');
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const coveredDays = Math.ceil((partial / rent) * daysInMonth);
    const partialDate = new Date(d.getFullYear(), d.getMonth(), Math.min(coveredDays, daysInMonth));
    advanceUntil = partialDate.toISOString().slice(0, 10);
  }

  await updateTenant(tenantCode, {
    rent_paid_this_month: Math.min(rent, amount),
    advance_rent_until: advanceUntil,
    advance_rent_balance: partial,
  });

  return { advanceRentUntil: advanceUntil, advanceRentBalance: partial, fullMonths };
}

async function updateTenant(id, patch, run) {
  const updatePatch = { ...patch };
  if (updatePatch.house_id !== undefined && updatePatch.house_id !== null && updatePatch.house_id !== '') {
    const house = await getHouse(updatePatch.house_id, run);
    if (house) {
      updatePatch.property_name = house.house_name;
      // unit_label is no longer used
      updatePatch.house_paybill_number = String(updatePatch.house_id);
      delete updatePatch.house_id;
    }
  } else if (updatePatch.house_id === null || updatePatch.house_id === '') {
    updatePatch.house_paybill_number = null;
    delete updatePatch.house_id;
  }
  
  // Remove unit_label from updatePatch if present (since we don't store it anymore)
  delete updatePatch.unit_label;

  // Recalculate agreement_outstanding if agreement_charge or agreement_paid changes
  if (updatePatch.agreement_charge !== undefined || updatePatch.agreement_paid !== undefined) {
    const current = await getTenant(id, run);
    if (current) {
      const charge = Number(updatePatch.agreement_charge !== undefined ? updatePatch.agreement_charge : current.agreement_charge);
      const paid = Number(updatePatch.agreement_paid !== undefined ? updatePatch.agreement_paid : current.agreement_paid);
      updatePatch.agreement_outstanding = Math.max(0, charge - paid);
    }
  }
  
  const fields = [];
  const values = [];
  let index = 1;
  
  for (const [key, val] of Object.entries(updatePatch)) {
    if (key === 'id') continue;
    fields.push(`${key} = $${index++}`);
    values.push(val);
  }
  
  if (fields.length === 0) return getTenant(id, run);
  
  fields.push(`updated_at = NOW()`);
  values.push(id);
  
  const q = `UPDATE tenants SET ${fields.join(', ')} WHERE tenant_code = $${index} RETURNING *, tenant_code AS id, house_paybill_number AS house_id, rent_due_date::text AS rent_due_date`;
  const res = await runOrQuery(run, q, values);
  if (!res.rows[0]) return null;
  return { ...res.rows[0], rent_amount: Number(res.rows[0].rent_amount) };
}

async function deleteTenant(id, actor = null) {
  const tenant = await getTenant(id);
  if (!tenant) return false;

  // Anything real — identity or financial/document/message history — is
  // ARCHIVED as a complete tenancy instead of being deleted (requirement:
  // deleting/vacating must archive the full history, never leave a blank or
  // destroyed record). Hard deletion is only allowed for truly empty unit
  // placeholders (no name, no history).
  const hasIdentity = String(tenant.name || '').trim() !== '';
  let historyCount = 0;
  try {
    const hist = await query(
      `SELECT (
         (SELECT COUNT(*) FROM payments WHERE tenant_code = $1) +
         (SELECT COUNT(*) FROM penalties WHERE tenant_code = $1) +
         (SELECT COUNT(*) FROM documents WHERE tenant_code = $1) +
         (SELECT COUNT(*) FROM water_invoices WHERE tenant_code = $1) +
         (SELECT COUNT(*) FROM message_logs WHERE tenant_code = $1) +
         (SELECT COUNT(*) FROM tenancy_agreements WHERE tenant_code = $1) +
         (SELECT COUNT(*) FROM exit_invoices WHERE tenant_code = $1) +
         (SELECT COUNT(*) FROM deposit_refunds WHERE tenant_code = $1) +
         (SELECT COUNT(*) FROM tenancy_archive WHERE tenant_code = $1)
       )::int AS n`,
      [id]
    );
    historyCount = Number(hist.rows[0].n);
  } catch (_) { historyCount = hasIdentity ? 1 : 0; }

  if (!hasIdentity && historyCount === 0) {
    // Empty placeholder unit row — nothing exists to preserve.
    const res = await query('DELETE FROM tenants WHERE tenant_code = $1', [id]);
    return res.rowCount > 0;
  }

  const today = new Date().toISOString().slice(0, 10);
  const vac = await vacateTenancy(id, {
    reason: 'Tenant record deleted — complete tenancy history archived',
    move_out_date: tenant.move_out_date || today,
    archived_by: actor || 'system',
  });
  if (vac && vac.error) return vac;
  if (!vac || !vac.archive) {
    return { error: 'Could not archive this tenancy — delete refused to protect its history.', code: 'ARCHIVE_FAILED' };
  }
  return {
    archived: true,
    archive_id: vac.archive.id,
    message: 'Tenant archived — complete tenancy and financial history preserved in Archive.',
  };
}

async function markUnitVacant(tenantCode) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;

  // Never destroy history: bind the tenancy's records to a permanent archive
  // record instead of deleting them (legacy behaviour hard-deleted them here).
  await sealStrayTenancyRows(tenantCode);

  // Vacancy reset: auto-close live payment arrangements for this unit.
  // History rows stay under the old tenant_code for audit; a new tenant
  // (new code) always starts with none.
  try { await closeArrangementsForVacancy(tenantCode, 'system'); } catch (_) {}

  const res = await query(
    `UPDATE tenants SET
        name = '', phone_number = '', status = 'Vacant',
       arrears = 0, deposit_paid = 0, garbage_fee_paid = 0, rent_paid_this_month = 0,
       credit_balance = 0, advance_rent_until = NULL, advance_rent_balance = 0,
       opening_advance_rent = 0, agreement_charge = 0, agreement_paid = 0, agreement_outstanding = 0,
       move_in_date = NULL, updated_at = NOW()
     WHERE tenant_code = $1
     RETURNING *, tenant_code AS id, house_paybill_number AS house_id, rent_due_date::text AS rent_due_date, move_in_date::text AS move_in_date`,
    [tenantCode]
  );
  if (!res.rows[0]) return null;
  const r = res.rows[0];
  return { ...r, rent_amount: Number(r.rent_amount), arrears: Number(r.arrears || 0), deposit_amount: Number(r.deposit_amount || 0), deposit_paid: Number(r.deposit_paid || 0), garbage_fee_amount: Number(r.garbage_fee_amount || 0), garbage_fee_paid: Number(r.garbage_fee_paid || 0), rent_paid_this_month: Number(r.rent_paid_this_month || 0) };
}

async function listPayments(filters = {}) {
  // History stays visible (sealed payments keep the name of the tenant who
  // actually paid, via the tenancy archive), but sealed PENDING rows are
  // hidden — they can no longer be approved and belong to a closed tenancy.
  let q = `
    SELECT p.*, p.tenant_code AS tenant_id, p.payment_date::text AS payment_date,
           CASE WHEN p.tenancy_id IS NOT NULL
                THEN COALESCE(NULLIF(a.tenant_name, ''), t.name, p.tenant_code)
                ELSE t.name END AS tenant_name,
           t.tenant_code
    FROM payments p
    LEFT JOIN tenants t ON p.tenant_code = t.tenant_code
    LEFT JOIN tenancy_archive a ON a.id = p.tenancy_id
    WHERE (p.tenancy_id IS NULL OR p.status = 'Approved')
  `;
  const params = [];
  if (filters.status) {
    params.push(filters.status);
    q += ` AND p.status = $${params.length}`;
  }
  if (filters.house_id) {
    params.push(filters.house_id);
    q += ` AND t.house_paybill_number = $${params.length}`;
  }
  q += ' ORDER BY p.recorded_at DESC';
  
  const res = await query(q, params);
  return res.rows.map(r => ({ ...r, amount: Number(r.amount) }));
}

async function findPaymentByReference(reference) {
  if (!reference) return null;
  const res = await query(
    `SELECT p.*, p.tenant_code AS tenant_id, p.payment_date::text AS payment_date,
            t.name AS tenant_name, t.tenant_code, t.property_name, t.unit_label
     FROM payments p
     LEFT JOIN tenants t ON p.tenant_code = t.tenant_code
     WHERE p.mpesa_reference = $1
     ORDER BY p.recorded_at DESC
     LIMIT 1`,
    [reference]
  );
  return res.rows[0] || null;
}

async function findPaymentById(id) {
  const res = await query(
    `SELECT p.*, p.tenant_code AS tenant_id, p.payment_date::text AS payment_date, t.name AS tenant_name, t.tenant_code, t.property_name, t.unit_label
     FROM payments p LEFT JOIN tenants t ON p.tenant_code = t.tenant_code
     WHERE p.id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

async function findPaymentByClientTxnId(clientTxnId) {
  if (!clientTxnId) return null;
  const res = await query(
    `SELECT p.*, p.tenant_code AS tenant_id, p.payment_date::text AS payment_date,
            t.name AS tenant_name, t.tenant_code, t.property_name, t.unit_label
     FROM payments p
     LEFT JOIN tenants t ON p.tenant_code = t.tenant_code
     WHERE p.client_txn_id = $1
     LIMIT 1`,
    [String(clientTxnId)]
  );
  return res.rows[0] || null;
}

// ─── Offline-first idempotency (Phase 2) ────────────────────────────────────
// Generic replay lookup for offline-created records. Table names are
// whitelisted — never interpolate raw caller input into SQL.
const OFFLINE_IDEMPOTENT_TABLES = new Set([
  'work_orders', 'maintenance_invoices', 'water_invoices', 'exit_invoices',
  'inspections', 'media_attachments',
]);

async function findRecordByClientTxnId(table, clientTxnId) {
  if (!clientTxnId || !OFFLINE_IDEMPOTENT_TABLES.has(table)) return null;
  const res = await query(
    `SELECT * FROM ${table} WHERE client_txn_id = $1 LIMIT 1`,
    [String(clientTxnId)]
  );
  return res.rows[0] || null;
}

// ─── Property inspections (offline-first) ───────────────────────────────────

async function createInspection(data) {
  if (data.client_txn_id) {
    const existing = await findRecordByClientTxnId('inspections', data.client_txn_id);
    if (existing) return { ...existing, _idempotentReplay: true };
  }
  const res = await query(
    `INSERT INTO inspections
       (client_txn_id, tenant_code, property_name, house_paybill_number, unit_label,
        inspection_date, checklist, photos_count, notes, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *, inspection_date::text AS inspection_date`,
    [
      data.client_txn_id || null,
      data.tenant_code || null,
      data.property_name || '',
      data.house_paybill_number || null,
      data.unit_label || null,
      data.inspection_date || new Date().toISOString().slice(0, 10),
      JSON.stringify(data.checklist || {}),
      Number(data.photos_count || 0),
      data.notes || null,
      data.status || 'Draft',
      data.created_by || null,
    ]
  );
  return res.rows[0];
}

async function listInspections({ limit = 100, offset = 0 } = {}) {
  const res = await query(
    `SELECT *, inspection_date::text AS inspection_date FROM inspections
     ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [Number(limit), Number(offset)]
  );
  return res.rows;
}

// ─── Media attachments (offline photos) ─────────────────────────────────────

async function createMediaAttachment(data) {
  if (data.client_txn_id) {
    const existing = await findRecordByClientTxnId('media_attachments', data.client_txn_id);
    if (existing) return { ...existing, _idempotentReplay: true };
  }
  const res = await query(
    `INSERT INTO media_attachments
       (client_txn_id, linked_type, linked_client_txn_id, linked_id,
        filename, mimetype, size_bytes, storage_path, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      data.client_txn_id || null,
      data.linked_type || 'general',
      data.linked_client_txn_id || null,
      data.linked_id != null ? Number(data.linked_id) : null,
      data.filename || '',
      data.mimetype || 'image/jpeg',
      Number(data.size_bytes || 0),
      data.storage_path || '',
      data.created_by || null,
    ]
  );
  return res.rows[0];
}

async function listMediaAttachments(linkedType, linkedId) {
  const res = await query(
    `SELECT id, linked_type, linked_client_txn_id, linked_id, filename, mimetype,
            size_bytes, storage_path, created_by, created_at
     FROM media_attachments WHERE linked_type = $1 AND linked_id = $2 ORDER BY created_at`,
    [linkedType, Number(linkedId)]
  );
  return res.rows;
}

// ─── Sync conflicts (manager review queue, Phase 3) ─────────────────────────
// When the server rejects an offline upload (duplicate, occupied unit,
// invalid reading), the rejection is recorded here instead of vanishing.
// Managers resolve centrally; devices pull resolutions on the next sync.

async function recordSyncConflict({ clientTxnId, opType, tenantCode, summary, reason, existingRef }) {
  const res = await query(
    `INSERT INTO sync_conflicts (client_txn_id, op_type, tenant_code, summary, reason, existing_ref, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending')
     ON CONFLICT (client_txn_id) DO UPDATE SET
       reason = EXCLUDED.reason,
       existing_ref = EXCLUDED.existing_ref,
       summary = EXCLUDED.summary,
       status = 'pending',
       resolution = NULL, resolved_by = NULL, resolved_at = NULL
     RETURNING *`,
    [
      clientTxnId || null,
      opType || '',
      tenantCode || null,
      JSON.stringify(summary || {}),
      reason || '',
      existingRef ? JSON.stringify(existingRef) : null,
    ]
  );
  return res.rows[0];
}

async function listSyncConflicts(status) {
  const where = status ? ' WHERE status = $1' : '';
  const params = status ? [status] : [];
  const res = await query(
    `SELECT * FROM sync_conflicts${where} ORDER BY created_at DESC LIMIT 500`,
    params
  );
  return res.rows;
}

async function resolveSyncConflict(id, { resolution, by }) {
  if (!['dismissed', 'retry'].includes(resolution)) {
    throw new Error(`resolution must be 'dismissed' or 'retry'`);
  }
  const res = await query(
    `UPDATE sync_conflicts SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = NOW()
     WHERE id = $1 RETURNING *`,
    [Number(id), resolution, by || null]
  );
  return res.rows[0] || null;
}

async function getConflictResolutions(clientTxnIds) {
  const ids = (Array.isArray(clientTxnIds) ? clientTxnIds : []).map(String).filter(Boolean).slice(0, 200);
  if (!ids.length) return {};
  const res = await query(
    `SELECT client_txn_id, status, resolution FROM sync_conflicts WHERE client_txn_id = ANY($1)`,
    [ids]
  );
  const out = {};
  for (const r of res.rows) {
    if (r.client_txn_id) out[r.client_txn_id] = { status: r.status, resolution: r.resolution };
  }
  return out;
}

/**
 * Tenancy completeness check for anything financial: the tenant must exist,
 * belong to an actual person (non-blank name), be occupied (not Vacant) and
 * be linked to a property that exists. Returns null when valid, otherwise an
 * error object { error, code: 'INCOMPLETE_TENANCY' }.
 */
async function validateTenancyForFinancials(tenantCode) {
  const code = String(tenantCode || '').trim();
  if (!code) {
    return { error: 'Rejected: no unit/tenant specified for this financial record.', code: 'INCOMPLETE_TENANCY' };
  }
  const t = await getTenant(code);
  if (!t) {
    return { error: `Rejected: unit/tenant "${code}" does not exist.`, code: 'INCOMPLETE_TENANCY' };
  }
  if (!String(t.name || '').trim()) {
    return { error: `Rejected: unit "${code}" has no tenant assigned — incomplete tenancy record.`, code: 'INCOMPLETE_TENANCY' };
  }
  if (String(t.status || '').trim() === 'Vacant') {
    return { error: `Rejected: unit "${code}" is vacant — assign a tenant before recording financial activity.`, code: 'INCOMPLETE_TENANCY' };
  }
  const houseId = t.house_id || t.house_paybill_number;
  if (!houseId) {
    return { error: `Rejected: tenant "${code}" is not linked to a property.`, code: 'INCOMPLETE_TENANCY' };
  }
  const house = await getHouse(houseId);
  if (!house) {
    return { error: `Rejected: tenant "${code}" references a property that does not exist.`, code: 'INCOMPLETE_TENANCY' };
  }
  return null;
}

async function createPayment(data) {
  // Idempotency: an offline device may upload the same payment twice
  // (retry after timeout, double sync). The client_txn_id UUID identifies
  // the device-side transaction — return the existing row instead of
  // creating a duplicate.
  if (data.client_txn_id) {
    const existing = await findPaymentByClientTxnId(data.client_txn_id);
    if (existing) return { ...existing, amount: Number(existing.amount), _idempotentReplay: true };
  }
  // Every payment must tie to a complete, occupied tenancy (manual entry,
  // M-Pesa parsing, offline sync and imports all funnel through here).
  const invalid = await validateTenancyForFinancials(data.tenant_id);
  if (invalid) return invalid;
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const res = await query(
    `INSERT INTO payments (tenant_code, amount, mpesa_reference, status, payment_date, notes, payment_type, payment_mode, sender_account, receiver_account, cheque_number, payment_datetime, client_txn_id, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *, tenant_code AS tenant_id, payment_date::text AS payment_date`,
    [
      String(data.tenant_id),
      Number(data.amount),
      data.mpesa_reference || null,
      data.status || 'Pending',
      data.payment_date || todayISO(),
      data.notes || null,
      data.payment_type || 'rent',
      data.payment_mode || null,
      data.sender_account || null,
      data.receiver_account || null,
      data.cheque_number || null,
      data.payment_datetime || null,
      data.client_txn_id || null,
      data.source || 'manual'
    ]
  );
  return { ...res.rows[0], amount: Number(res.rows[0].amount) };
}

async function approvePayment(id) {
  const existing = await query(
    `SELECT * FROM payments WHERE id = $1`,
    [id]
  );
  const existingPayment = existing.rows[0];
  if (!existingPayment) return null;

  // Payments bound to a completed tenancy are permanent history — never
  // (re-)approved, repaired or re-allocated.
  if (existingPayment.tenancy_id != null) {
    return {
      error: 'This payment belongs to a completed (archived) tenancy and is permanently preserved — it cannot be approved or re-processed.',
      code: 'TENANCY_SEALED',
    };
  }

  // The tenancy must still be complete at approval time: a Pending payment
  // whose tenant left (or was wiped) must never produce a receipt,
  // allocation or WhatsApp confirmation.
  const invalidTenancy = await validateTenancyForFinancials(existingPayment.tenant_code);
  if (invalidTenancy) return invalidTenancy;

  if (existingPayment.status === 'Approved') {
    // Repair path: previously-approved payments that were never marked synced
    // (created before Phase 1) are recomputed and marked synced on approval.
    const needsRepair = existingPayment.sync_status !== 'synced';
    if (needsRepair && existingPayment.tenant_code) {
      await recalculateAll(existingPayment.tenant_code);
      await query(
        `UPDATE payments SET sync_status = 'synced', synced_at = COALESCE(synced_at, NOW()) WHERE id = $1`,
        [id]
      );
    }
    const tenant = await getTenant(existingPayment.tenant_code);
    const repaired = await query(`SELECT * FROM payments WHERE id = $1`, [id]);
    const row = repaired.rows[0] || existingPayment;
    return {
      payment: { ...row, amount: Number(row.amount), tenant_id: row.tenant_code, overpayment_amount: Number(row.overpayment_amount || 0) },
      tenant,
      alreadyApproved: true,
      sync: { status: row.sync_status || 'synced', repaired: needsRepair }
    };
  }

  // Approval runs inside a single DB transaction so every module write
  // (payment -> tenant -> penalties) commits or rolls back together. On any
  // failure the payment stays Pending and the approval is retried
  // automatically (max 3 attempts) before erroring out.
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await approvePaymentOnce(id);
    } catch (err) {
      lastError = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 150 * attempt));
    }
  }
  throw lastError;
}

async function approvePaymentOnce(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = (sql, params) => client.query(sql, params);
    const currentMonth = new Date().toISOString().slice(0, 7);

    const receiptNumber = await generateReceiptNumber(run);

    // Compute billing_period from the tenant's rent cycle (rent_due_date), NOT from
    // payment date or current calendar date. Payment date = when the tenant paid.
    // Billing period = which rent cycle/month the payment covers.
    const preRes = await run(
      `SELECT p.payment_type, p.payment_date::text AS payment_date, p.amount, p.tenant_code, p.tenancy_id,
              t.rent_due_date::text AS rent_due_date
       FROM payments p JOIN tenants t ON t.tenant_code = p.tenant_code
       WHERE p.id = $1`, [id]);
    const prePay = preRes.rows[0];

    // Payments bound to a completed tenancy are permanent — never
    // re-approved, re-allocated or otherwise re-processed.
    if (prePay && prePay.tenancy_id != null) {
      await client.query('ROLLBACK');
      return {
        error: 'This payment belongs to a completed (archived) tenancy and is permanently preserved — it cannot be approved or re-processed.',
        code: 'TENANCY_SEALED',
      };
    }

    // Derive billing_period from the tenant's rent_due_date.
    // rent_due_date always points to the NEXT due date (updated by rollover).
    // The billing period is always the month of rent_due_date — the payment date
    // only determines whether it's early or late, not which month it covers.
    // advance_rent payments (checked below) are the exception — they go to next month.
    let billingPeriod = currentMonth;
    if (prePay && prePay.rent_due_date) {
      billingPeriod = prePay.rent_due_date.slice(0, 7);
    }

    if (prePay && prePay.payment_type === 'advance_rent') {
      // Explicit advance rent → next billing cycle
      billingPeriod = nextMonthKey(billingPeriod);
    }
    // For regular rent and deposit: billingPeriod is based on tenant's rent cycle

    const res = await run(
      `UPDATE payments SET status = 'Approved', approved_at = NOW(), receipt_number = $2, sync_status = 'pending_sync', billing_period = $3 WHERE id = $1 AND status = 'Pending' RETURNING *, tenant_code AS tenant_id, payment_date::text AS payment_date`,
      [id, receiptNumber, billingPeriod]
    );
    const payment = res.rows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      return null;
    }

    const tenant = await getTenant(payment.tenant_id, run);
    let allocation = null;
    const expected = {};

  if (tenant) {
    const paymentType = payment.payment_type || 'rent';

    if (paymentType === 'deposit') {
      const newDepositPaid = Number(tenant.deposit_paid) + Number(payment.amount);
      const depositPaidTarget = Math.min(newDepositPaid, Number(tenant.deposit_amount));
      await updateTenant(tenant.id, {
        deposit_paid: depositPaidTarget,
        status: 'Active'
      }, run);
      expected.deposit_paid = depositPaidTarget;
      const depositShortfall = Math.max(0, Number(tenant.deposit_amount || 0) - Number(tenant.deposit_paid || 0));
      const arrearsBefore = Number(tenant.arrears || 0);
      const rentAmount = Number(tenant.rent_amount || 0);
      const rentPaidThisMonth = Number(tenant.rent_paid_this_month || 0);
      const remainingRentForMonth = Math.max(0, rentAmount - rentPaidThisMonth);
      const outstandingCharges = await getOutstandingPenalties(payment.tenant_id, null, run);
      const garbageFeeShortfall = Math.max(0, Number(tenant.garbage_fee_amount || 0) - Number(tenant.garbage_fee_paid || 0));
      const waterChargeShortfall = Math.max(0, Number(tenant.water_charge_amount || 0) - Number(tenant.water_charge_paid || 0));
      const remainingDeposit = Math.max(0, depositShortfall - Number(payment.amount));
      const depositSettled = Math.min(depositShortfall, Number(payment.amount));
      const remainingBalance = remainingDeposit + arrearsBefore + remainingRentForMonth + garbageFeeShortfall + waterChargeShortfall + outstandingCharges;
      const approvedBefore = await getApprovedPaymentCount(payment.tenant_id, payment.id, run);
      const hasRentPaymentBefore = await hasApprovedRentPaymentFor(payment.tenant_id, payment.id, run);
      const onboarding = !hasRentPaymentBefore && depositShortfall > 0;

      allocation = {
        paymentType: 'deposit',
        depositShortfallBefore: depositShortfall,
        arrearsBefore,
        rentDue: remainingRentForMonth,
        rentAmount,
        rentPaidBefore: rentPaidThisMonth,
        depositSettled,
        arrearsSettled: 0,
        rentSettled: 0,
        remainingDeposit,
        remainingArrears: arrearsBefore,
        remainingRent: remainingRentForMonth,
        remainingGarbage: garbageFeeShortfall,
        remainingWater: waterChargeShortfall,
        remainingBalance,
        onboarding: onboarding || null,
        firstPayment: approvedBefore === 0,
        onboardingTotal: depositShortfall + remainingRentForMonth + garbageFeeShortfall + waterChargeShortfall,
        overpayment: Math.max(0, Number(payment.amount) - depositShortfall),
      };
    } else {
      const amountPaid = Number(payment.amount);
      const rentAmount = Number(tenant.rent_amount);
      const rentPaidThisMonth = Number(tenant.rent_paid_this_month || 0);
      const remainingRentForMonth = Math.max(0, rentAmount - rentPaidThisMonth);
      let arrears = Number(tenant.arrears || 0);
      let remaining = amountPaid;

      const depositAmount = Number(tenant.deposit_amount || 0);
      let depositPaid = Number(tenant.deposit_paid || 0);
      const depositShortfall = Math.max(0, depositAmount - depositPaid);

      const garbageFeeAmount = Number(tenant.garbage_fee_amount || 0);
      let garbageFeePaid = Number(tenant.garbage_fee_paid || 0);
      const garbageFeeShortfall = Math.max(0, garbageFeeAmount - garbageFeePaid);

      const waterChargeAmount = Number(tenant.water_charge_amount || 0);
      let waterChargePaid = Number(tenant.water_charge_paid || 0);
      const waterChargeShortfall = Math.max(0, waterChargeAmount - waterChargePaid);

      let arrearsSettled = 0;
      let penaltySettled = 0;
      let maintenanceSettled = 0;
      let otherSettled = 0;
      let garbageFeeSettled = 0;
      let waterSettled = 0;
      let rentSettled = 0;
      let depositSettled = 0;

      const penaltyBefore = await getOutstandingPenalties(payment.tenant_id, 'penalty', run);
      const maintenanceBefore = await getOutstandingPenalties(payment.tenant_id, 'maintenance', run);
      const otherBefore = await getOutstandingPenalties(payment.tenant_id, 'other', run);

      // Allocation chain (spec): opening balances (arrears) -> penalties ->
      // maintenance -> garbage -> other charges -> water -> current-month rent
      // -> deposit (new tenancy only). Deposit can never become an overpayment.
      // Whatever remains after the chain is the OVERPAYMENT and is never
      // auto-allocated; it must be resolved (advance rent / credit balance) or
      // left pending.
      const approvedBefore = await getApprovedPaymentCount(payment.tenant_id, payment.id, run);
      const hasRentPaymentBefore = await hasApprovedRentPaymentFor(payment.tenant_id, payment.id, run);
      const onboarding = !hasRentPaymentBefore && depositShortfall > 0;

      // 0) Tenancy agreement fee — one-time charge, deducted before everything else
      let agreementSettled = 0;
      let agreementOutstanding = Number(tenant.agreement_outstanding || 0);
      if (agreementOutstanding > 0 && remaining > 0) {
        agreementSettled = Math.min(agreementOutstanding, remaining);
        remaining -= agreementSettled;
        agreementOutstanding -= agreementSettled;
      }

      // 1) Opening balances / arrears
      if (arrears > 0 && remaining > 0) {
        const settle = Math.min(arrears, remaining);
        arrears -= settle;
        arrearsSettled = settle;
        remaining -= settle;
      }

      // 2) Penalties (oldest first)
      if (remaining > 0) {
        const result = await payPenaltiesFromPayment(payment.tenant_id, remaining, 'penalty', run);
        penaltySettled = result.penaltySettled;
        remaining = result.remaining;
      }

      // 3) Maintenance invoices (oldest first)
      if (remaining > 0) {
        const result = await payPenaltiesFromPayment(payment.tenant_id, remaining, 'maintenance', run);
        maintenanceSettled = result.penaltySettled;
        remaining = result.remaining;
      }

      // 4) Garbage fee
      if (garbageFeeShortfall > 0 && remaining > 0) {
        const settle = Math.min(garbageFeeShortfall, remaining);
        garbageFeePaid += settle;
        garbageFeeSettled = settle;
        remaining -= settle;
      }

      // 5) Other outstanding charges
      if (remaining > 0) {
        const result = await payPenaltiesFromPayment(payment.tenant_id, remaining, 'other', run);
        otherSettled = result.penaltySettled;
        remaining = result.remaining;
      }

      // 6) Water charge
      if (waterChargeShortfall > 0 && remaining > 0) {
        const settle = Math.min(waterChargeShortfall, remaining);
        waterChargePaid += settle;
        waterSettled = settle;
        remaining -= settle;
      }

      // 7) Current month rent
      if (remainingRentForMonth > 0 && remaining > 0) {
        const settle = Math.min(remainingRentForMonth, remaining);
        rentSettled = settle;
        remaining -= settle;
      }

      // 8) Deposit — last resort before overpayment. A deposit shortfall is
      // an applicable outstanding charge like any other: leftover money
      // settles it instead of spilling to overpayment. (Onboarding merely
      // determines messaging/first-payment flags, never eligibility.)
      if (depositShortfall > 0 && remaining > 0) {
        const settle = Math.min(depositShortfall, remaining);
        depositPaid += settle;
        depositSettled = settle;
        remaining -= settle;
      }

      const newRentPaidThisMonth = rentPaidThisMonth + rentSettled;

      await updateTenant(tenant.id, {
        deposit_paid: Math.min(depositPaid, depositAmount),
        garbage_fee_paid: Math.min(garbageFeePaid, garbageFeeAmount),
        water_charge_paid: Math.min(waterChargePaid, waterChargeAmount),
        arrears: Math.max(0, arrears),
        rent_paid_this_month: newRentPaidThisMonth,
        agreement_paid: Number(tenant.agreement_paid || 0) + agreementSettled,
        agreement_outstanding: agreementOutstanding,
        status: 'Active'
      }, run);
      expected.deposit_paid = Math.min(depositPaid, depositAmount);
      expected.garbage_fee_paid = Math.min(garbageFeePaid, garbageFeeAmount);
      expected.water_charge_paid = Math.min(waterChargePaid, waterChargeAmount);
      expected.arrears = Math.max(0, arrears);
      expected.rent_paid_this_month = newRentPaidThisMonth;

      const remainingArrears = Math.max(0, arrears);
      const remainingPenalties = Math.max(0, penaltyBefore - penaltySettled);
      const remainingMaintenance = Math.max(0, maintenanceBefore - maintenanceSettled);
      const remainingOther = Math.max(0, otherBefore - otherSettled);
      const remainingGarbage = Math.max(0, garbageFeeShortfall - garbageFeeSettled);
      const remainingWater = Math.max(0, waterChargeShortfall - waterSettled);
      const remainingRent = Math.max(0, remainingRentForMonth - rentSettled);
      const remainingDeposit = Math.max(0, depositShortfall - depositSettled);
      const remainingBalance = remainingDeposit + remainingArrears + remainingPenalties + remainingMaintenance + remainingOther + remainingGarbage + remainingWater + remainingRent;

      allocation = {
        paymentType: 'rent',
        depositShortfallBefore: depositShortfall,
        arrearsBefore: Number(tenant.arrears || 0),
        garbageFeeBefore: garbageFeeShortfall,
        waterChargeBefore: waterChargeShortfall,
        agreementBefore: Number(tenant.agreement_outstanding || 0),
        rentDue: remainingRentForMonth,
        rentAmount,
        rentPaidBefore: rentPaidThisMonth,
        penaltiesBefore: penaltyBefore + maintenanceBefore + otherBefore,
        penaltyBefore,
        maintenanceBefore,
        otherBefore,
        agreementSettled,
        depositSettled,
        arrearsSettled,
        garbageFeeSettled,
        waterSettled,
        rentSettled,
        penaltySettled,
        maintenanceSettled,
        otherSettled,
        remainingAgreement: agreementOutstanding,
        remainingArrears,
        remainingPenalties,
        remainingMaintenance,
        remainingOther,
        remainingGarbage,
        remainingWater,
        remainingRent,
        remainingDeposit,
        remainingBalance,
        onboarding: onboarding || null,
        firstPayment: approvedBefore === 0,
        onboardingTotal: depositShortfall + remainingRentForMonth + garbageFeeShortfall + waterChargeShortfall,
        overpayment: Math.max(0, remaining),
      };
    }
  }

    const updatedTenant = await getTenant(payment.tenant_id, run);
    const overpayment = allocation ? Math.max(0, Number(allocation.overpayment || 0)) : 0;
    await run(`UPDATE payments SET overpayment_amount = $2, allocation_breakdown = $3 WHERE id = $1`, [id, overpayment, allocation ? JSON.stringify(allocation) : null]);

    // CRITICAL FIX: If there is an overpayment, automatically convert it to
    // advance rent on the tenant so it covers future billing cycles.
    // The excess is added to advance_rent_balance and advance_rent_until is
    // set to cover the next billing period.
    if (overpayment > 0 && payment.payment_type !== 'deposit') {
      const tenantAfterAlloc = await getTenant(payment.tenant_id, run);
      const currentAdvance = Number(tenantAfterAlloc.advance_rent_balance || 0);
      const newAdvanceBalance = currentAdvance + overpayment;
      const nextPeriod = nextMonthKey(currentMonth);
      const daysInMonth = new Date(Number(nextPeriod.split('-')[0]), Number(nextPeriod.split('-')[1]), 0).getDate();
      const newAdvanceUntil = `${nextPeriod}-${String(daysInMonth).padStart(2, '0')}`;

      await run(
        `UPDATE tenants SET advance_rent_balance = $2, advance_rent_until = $3, updated_at = NOW() WHERE tenant_code = $1`,
        [payment.tenant_id, newAdvanceBalance, newAdvanceUntil]
      );
    }

    const validation = validatePaymentSync(updatedTenant, expected, allocation);
    if (!validation.valid) {
      throw new Error('Payment synchronization validation failed: ' + validation.mismatches.join(', '));
    }

    // Every module updated and validated — only now commit as synced.
    await run(
      `UPDATE payments SET sync_status = 'synced', synced_at = NOW() WHERE id = $1`,
      [id]
    );

    // Mirror settled buckets onto outstanding Invoice Center rows (Paid /
    // Partially Paid tracking only). Allocation itself is untouched, and a
    // linking failure must never break the approval — log and continue.
    try {
      await applyPaymentToInvoices({ ...payment, tenant_code: payment.tenant_id }, allocation, updatedTenant, run);
    } catch (linkErr) {
      console.error(`[InvoiceLink] Linking failed for payment ${id} (approval unaffected):`, linkErr.message);
    }

    const finalRes = await run(`SELECT * FROM payments WHERE id = $1`, [id]);
    const paymentRow = finalRes.rows[0];
    await client.query('COMMIT');

    // Reconcile the tenant's full financial position (outside the transaction)
    try {
      await reconcileTenant(payment.tenant_id);
    } catch (err) {
      console.error(`[Reconcile] Post-approval reconciliation failed for ${payment.tenant_id}:`, err.message);
    }

    return {
      payment: { ...paymentRow, amount: Number(paymentRow.amount), tenant_id: paymentRow.tenant_code, overpayment_amount: overpayment, sync_status: 'synced' },
      tenant: updatedTenant,
      allocation,
      sync: { status: 'synced', synced_at: paymentRow.synced_at },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function approxEqual(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) < 0.005;
}

// Rent-directed portion of one approved payment: the allocation snapshot's
// rent share when present, else the full amount (legacy rows predate
// allocation snapshots — preserved as-is).
function rentDirectedAmount(p) {
  const amt = Number((p && p.amount) || 0);
  let bd = p ? p.allocation_breakdown : null;
  try { if (typeof bd === 'string') bd = JSON.parse(bd); } catch (_) { bd = null; }
  if (bd && bd.rentSettled !== undefined && bd.rentSettled !== null) return Number(bd.rentSettled) || 0;
  return amt;
}

// Billing month a payment belongs to: the approval-time billing_period when
// present (derived from the tenant's rent cycle), else the payment date.
function billingMonthOfPayment(p) {
  if (p && p.billing_period && /^\d{4}-\d{2}$/.test(String(p.billing_period))) return String(p.billing_period);
  const pd = p ? p.payment_date : null;
  if (pd instanceof Date && !Number.isNaN(pd.getTime())) {
    return `${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, '0')}`;
  }
  return String(pd || '').slice(0, 7);
}

function validatePaymentSync(tenant, expected, allocation) {
  const mismatches = [];
  if (!tenant) {
    return { valid: false, mismatches: ['tenant row missing after approval'] };
  }
  if (expected.deposit_paid !== undefined && !approxEqual(tenant.deposit_paid, expected.deposit_paid)) {
    mismatches.push(`deposit_paid ${Number(tenant.deposit_paid)} != ${expected.deposit_paid}`);
  }
  if (expected.garbage_fee_paid !== undefined && !approxEqual(tenant.garbage_fee_paid, expected.garbage_fee_paid)) {
    mismatches.push(`garbage_fee_paid ${Number(tenant.garbage_fee_paid)} != ${expected.garbage_fee_paid}`);
  }
  if (expected.water_charge_paid !== undefined && !approxEqual(tenant.water_charge_paid, expected.water_charge_paid)) {
    mismatches.push(`water_charge_paid ${Number(tenant.water_charge_paid)} != ${expected.water_charge_paid}`);
  }
  if (expected.arrears !== undefined && !approxEqual(tenant.arrears, expected.arrears)) {
    mismatches.push(`arrears ${Number(tenant.arrears)} != ${expected.arrears}`);
  }
  if (expected.rent_paid_this_month !== undefined && !approxEqual(tenant.rent_paid_this_month, expected.rent_paid_this_month)) {
    mismatches.push(`rent_paid_this_month ${Number(tenant.rent_paid_this_month)} != ${expected.rent_paid_this_month}`);
  }
  return { valid: mismatches.length === 0, mismatches };
}

/**
 * One-time historical payment recovery (Phase 1): recomputes every tenant's
 * derived balances from its approved payment history (recalculateAll) and
 * marks all approved payments as 'synced'. Returns counts so the UI can
 * display "Historical payment synchronization completed successfully."
 */
async function syncHistoricalPayments() {
  const countRes = await query(`SELECT COUNT(*)::int AS c FROM payments WHERE status = 'Approved'`);
  const totalApproved = countRes.rows[0]?.c || 0;

  const tenantRes = await query(
    `SELECT t.tenant_code, t.name, COALESCE(p.cnt, 0)::int AS approved_count
     FROM tenants t
     LEFT JOIN (SELECT tenant_code, COUNT(*)::int AS cnt FROM payments WHERE status = 'Approved' GROUP BY tenant_code) p
       ON p.tenant_code = t.tenant_code
     WHERE t.status != 'Vacant'
     ORDER BY t.name`
  );
  const tenants = tenantRes.rows;
  let syncedPayments = 0;
  let tenantsRepaired = 0;
  const failed = [];

  // Batch-mark all existing approved payments as synced (fast single UPDATE
  // for the common case where balances are already correct).
  const batchRes = await query(
    `UPDATE payments SET sync_status = 'synced', synced_at = COALESCE(synced_at, NOW())
     WHERE status = 'Approved' AND sync_status IS DISTINCT FROM 'synced'`
  );
  syncedPayments = batchRes.rowCount || 0;

  // Re-run recalculateAll only for tenants that have approved payments,
  // then reconcile so status/arrears/advance-covered positions (which the
  // replay deliberately cannot reconstruct) are re-derived too.
  for (const t of tenants) {
    if (!t.tenant_code || t.approved_count === 0) continue;
    try {
      await recalculateAll(t.tenant_code);
      try {
        await reconcileTenant(t.tenant_code);
      } catch (recErr) {
        failed.push({ tenant_code: t.tenant_code, tenant_name: t.name || null, error: 'reconcile: ' + recErr.message });
      }
      tenantsRepaired++;
    } catch (err) {
      failed.push({ tenant_code: t.tenant_code, tenant_name: t.name || null, error: err.message });
    }
  }

  return { totalApproved, syncedPayments, tenantsRepaired, failed };
}

// ===========================================================================
// CENTRAL PAYMENT & BILLING RECONCILIATION ENGINE
// Single source of truth for every tenant's financial position.
// Called after every payment approval, deletion, reversal, and rollover.
// ===========================================================================

function monthKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function nextMonthKey(mk) {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(y, m, 1); // m is 1-indexed → next month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function isAdvanceCoveringMonth(tenant, month) {
  if (!tenant.advance_rent_until) return false;
  const advPrefix = String(tenant.advance_rent_until).slice(0, 7);
  const advDay = Number(String(tenant.advance_rent_until).slice(8, 10)) || 1;
  return month < advPrefix || (month === advPrefix && advDay <= 1);
}

function iterMonths(from, to) {
  const months = [];
  let cur = from;
  while (cur <= to) {
    months.push(cur);
    cur = nextMonthKey(cur);
  }
  return months;
}

/**
 * Reconcile a single tenant's financial position.
 * Computes the TRUE outstanding balance from charges vs. payments/advances
 * across all billing periods, then updates tenant fields + status.
 * Returns the reconciled position.
 */
async function reconcileTenant(tenantCode) {
  const tenant = await getTenant(tenantCode);
  if (!tenant || tenant.status === 'Vacant') return null;

  const rentAmount = Number(tenant.rent_amount || 0);
  const depositAmount = Number(tenant.deposit_amount || 0);
  const depositPaid = Number(tenant.deposit_paid || 0);
  const garbageFeeAmount = Number(tenant.garbage_fee_amount || 0);
  const waterChargeAmount = Number(tenant.water_charge_amount || 0);
  const moveIn = tenant.move_in_date ? monthKey(tenant.move_in_date) : null;

  // All approved payments for this tenant
  const payRes = await query(
    `SELECT id, amount, payment_date::text AS payment_date, payment_type, billing_period,
            overpayment_amount, mpesa_reference, receipt_number, allocation_breakdown
     FROM payments WHERE tenant_code = $1 AND status = 'Approved' AND tenancy_id IS NULL ORDER BY payment_date ASC, id ASC`,
    [tenantCode]
  );
  const allPayments = payRes.rows;

  // Billing periods: the tenant's CURRENT RENT CYCLE (month of rent_due_date)
  // plus the following cycle. Billing always follows rent_due_date — the same
  // convention approvePayment (billing_period), recalculateAll (cycleMonth) and
  // rollover use — so payment snapshots land in the same period here. Using the
  // calendar month instead clobbered rent_paid_this_month for paid-up tenants
  // whose cycle had already rolled forward (payments looked "forgotten").
  // Past cycles are settled by rollover — their arrears are carried forward.
  const calendarMonth = new Date().toISOString().slice(0, 7);
  const currentMonth = tenant.rent_due_date
    ? String(tenant.rent_due_date).slice(0, 7)
    : calendarMonth;
  const nextMonth = nextMonthKey(currentMonth);
  const billingPeriods = [currentMonth, nextMonth];

  // Build a map of payments by their effective billing_period.
  // For payments without billing_period, infer from payment_date + payment_type.
  // For advance_rent, always assign to the next month after payment_date.
  const paymentsByPeriod = {};
  for (const p of allPayments) {
    let bp = p.billing_period;
    if (!bp) {
      if (p.payment_type === 'advance_rent') {
        bp = nextMonthKey(monthKey(p.payment_date));
      } else {
        bp = monthKey(p.payment_date);
      }
    }
    if (!paymentsByPeriod[bp]) paymentsByPeriod[bp] = [];
    paymentsByPeriod[bp].push(p);
  }

  // Advance/credit pools are owned by the approval, rollover and resolution
  // flows (they spend them when months actually close). Reconciliation only
  // projects with a working copy — it must persist the pools UNCHANGED,
  // otherwise a mere status recompute would evaporate real advance money
  // (and destroy the until-marker rollover relies on).
  let runningAdvance = Number(tenant.advance_rent_balance || 0);

  // Auto-seed: if opening_advance_rent exists but advance was never seeded
  // (advance_rent_until is null, balance is 0, no approved payments yet),
  // seed the advance now so it's available for current/future billing.
  const openingAdvance = Number(tenant.opening_advance_rent || 0);
  if (openingAdvance > 0 && !tenant.advance_rent_until && runningAdvance === 0 && allPayments.length === 0) {
    const rentAmount = Number(tenant.rent_amount || 0);
    if (rentAmount > 0) {
      const fullMonths = Math.floor(openingAdvance / rentAmount);
      const partial = Number((openingAdvance - fullMonths * rentAmount).toFixed(2));
      const currentMonthStart = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`;
      let advanceUntil = null;
      if (fullMonths > 0 && partial > 0) {
        // Covers N full months + partial into month N+1
        // advanceUntil = first day of month N+2 (the first uncovered month)
        advanceUntil = addMonths(currentMonthStart, fullMonths + 1);
      } else if (fullMonths > 0) {
        // Covers exactly N full months
        advanceUntil = addMonths(currentMonthStart, fullMonths);
      }
      // partial-only (fullMonths=0): no advanceUntil needed, just runningAdvance

      // Set runningAdvance to the partial remainder only.
      // Full months are covered by advance_rent_until (isFullyCoveredMonth).
      // The partial amount is what's left over and needs to be tracked as balance.
      runningAdvance = partial > 0 ? partial : 0;
      // Store the seeded advance
      await query(
        `UPDATE tenants SET advance_rent_until = $2, advance_rent_balance = $3, updated_at = NOW() WHERE tenant_code = $1`,
        [tenantCode, advanceUntil, runningAdvance]
      );
      tenant.advance_rent_until = advanceUntil;
      tenant.advance_rent_balance = runningAdvance;
    }
  }

  // Existing arrears from past rollovers — may be stale if advance payments
  // were not properly allocated. We'll recompute them below.
  let existingArrears = Number(tenant.arrears || 0);
  let currentMonthPaid = 0;
  let currentMonthDue = 0;

  const periodResults = [];

  // Pre-fetch deposit applications for all billing periods
  const daRes = await query(
    `SELECT billing_period, COALESCE(SUM(amount_applied), 0) AS total
     FROM deposit_applications WHERE tenant_code = $1 AND status = 'Active' AND tenancy_id IS NULL
     GROUP BY billing_period`,
    [tenantCode]
  );
  const depositByPeriod = {};
  for (const r of daRes.rows) depositByPeriod[r.billing_period] = Number(r.total || 0);

  // Pre-fetch rent losses for all billing periods
  const lossRes = await query(
    `SELECT billing_period, COALESCE(SUM(rent_loss_amount), 0) AS total
     FROM deposit_applications WHERE tenant_code = $1 AND status = 'Active' AND rent_loss_amount > 0 AND tenancy_id IS NULL
     GROUP BY billing_period`,
    [tenantCode]
  );
  const lossByPeriod = {};
  for (const r of lossRes.rows) lossByPeriod[r.billing_period] = Number(r.total || 0);

  for (const bp of billingPeriods) {
    // Total charges for this billing period: rent + garbage shortfall + water shortfall
    const garbageShortfall = Math.max(0, garbageFeeAmount - Number(tenant.garbage_fee_paid || 0));
    const waterShortfall = Math.max(0, waterChargeAmount - Number(tenant.water_charge_paid || 0));
    let charges = rentAmount + (bp === currentMonth ? garbageShortfall + waterShortfall : 0);

    // Check if this billing period is fully covered by advance_rent_until.
    // If the advance covers this entire month, the rent portion is already
    // settled by the opening advance — only garbage/water remain as charges.
    let advanceCoversRent = false;
    if (tenant.advance_rent_until && rentAmount > 0) {
      const advPrefix = String(tenant.advance_rent_until).slice(0, 7);
      const advDay = Number(String(tenant.advance_rent_until).slice(8, 10)) || 1;
      const isFullyCovered = bp < advPrefix || (bp === advPrefix && advDay <= 1);
      if (isFullyCovered) {
        advanceCoversRent = true;
        charges = (bp === currentMonth ? garbageShortfall + waterShortfall : 0);
      }
    }

    // Advance from previous period (partial remainder carried forward).
    // When advanceCoversRent is true, rent is already excluded from charges,
    // so don't consume runningAdvance — it's the partial remainder for future months.
    const advanceApplied = advanceCoversRent ? 0 : Math.min(runningAdvance, charges);
    const afterAdvance = charges - advanceApplied;

    // Payments allocated to this billing period — rent-directed portions only.
    // Counting full payment amounts here overstates rent-paid whenever one
    // payment also settled arrears/penalties/deposit (the uncounted shortfall
    // would then vanish instead of persisting as debt).
    const periodPayments = (paymentsByPeriod[bp] || []);
    let paymentsApplied = 0;
    for (const p of periodPayments) {
      paymentsApplied += rentDirectedAmount(p);
    }

    // Deposit applied to this billing period
    const depositApplied = depositByPeriod[bp] || 0;

    // Rent loss written off for this billing period
    const rentLoss = lossByPeriod[bp] || 0;

    const totalApplied = advanceApplied + paymentsApplied + depositApplied;
    const outstanding = Math.max(0, afterAdvance - paymentsApplied - depositApplied - rentLoss);

    let status = 'Unpaid';
    if (advanceCoversRent && outstanding === 0) {
      // Rent fully covered by opening advance; any remaining charges (garbage/water) paid
      status = 'Paid — Advance Applied';
    } else if (charges === 0 && !advanceCoversRent) {
      status = 'Active';
    } else if (outstanding === 0 && totalApplied + rentLoss >= charges) {
      status = depositApplied > 0 && paymentsApplied === 0 ? 'Paid — Deposit Applied'
        : depositApplied > 0 ? 'Paid — Deposit Applied'
        : 'Paid';
    } else if (totalApplied > 0) {
      status = 'Partially Paid';
    }

    // Excess from this period becomes advance for the next.
    // When advanceCoversRent, runningAdvance (partial remainder) is preserved.
    const excess = advanceCoversRent ? runningAdvance : Math.max(0, totalApplied - charges);
    runningAdvance = excess;

    periodResults.push({
      billing_period: bp,
      charges,
      advance_applied: advanceApplied,
      payments_applied: paymentsApplied,
      deposit_applied: depositApplied,
      rent_loss: rentLoss,
      outstanding,
      status,
      excess,
      advance_covers_rent: advanceCoversRent,
    });

    if (bp === currentMonth) {
      // When advance covers rent, rent_paid_this_month should reflect the full
      // rent amount (the advance satisfied the obligation). Otherwise, it's the
      // sum of payments + advance + deposit applied to this period.
      currentMonthPaid = advanceCoversRent ? rentAmount : totalApplied;
      currentMonthDue = charges;
    }
  }

  // Current month status from the period results
  const currentPeriod = periodResults.find(r => r.billing_period === currentMonth);
  const currentStatus = currentPeriod ? currentPeriod.status : 'Active';
  const currentOutstanding = currentPeriod ? currentPeriod.outstanding : 0;

  // Correct stale arrears: if the current month is fully covered by
  // advance + payments, any existing arrears that were created by a
  // previous rollover (before the advance was recognized) should be cleared.
  // This handles the MD10 case: July payment was advance for August, rollover
  // created arrears thinking July was unpaid, but August is actually PAID.
  // Manual arrears (rent_due_manually_set) are operator truth — rollover
  // preserves them, so this heuristic must never wipe them either.
  const isCurrentPaid = currentStatus.startsWith('Paid');
  if (isCurrentPaid && existingArrears > 0 && !tenant.arrears_manually_set) {
    // Check if the arrears correspond to a period that is now covered
    // by advance payments. If the payment for the arrears period was
    // actually an advance for the current month, the arrears are stale.
    const arrearsPayments = allPayments.filter(p => {
      const pMonth = monthKey(p.payment_date);
      return pMonth < calendarMonth && Number(p.amount || 0) > 0;
    });
    const arrearsPaid = arrearsPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
    if (arrearsPaid >= existingArrears) {
      existingArrears = 0; // Arrears were covered by payments
    }
  }

  // Overall tenant status — uses corrected arrears + current month status
  let tenantStatus = 'Active';
  if (existingArrears > 0) {
    tenantStatus = 'Overdue';
  } else if (isCurrentPaid) {
    tenantStatus = 'Paid';
  } else if (currentStatus === 'Partially Paid') {
    tenantStatus = 'Partially Paid';
  } else if (currentStatus === 'Unpaid' && currentMonthDue > 0) {
    // Check if current month is past due (rent_due_date < today)
    const dueDate = tenant.rent_due_date ? new Date(tenant.rent_due_date) : null;
    if (dueDate && dueDate < new Date()) {
      tenantStatus = 'Overdue';
    }
  }

  // Garbage/water/deposit shortfalls
  const garbagePaid = Number(tenant.garbage_fee_paid || 0);
  const waterPaid = Number(tenant.water_charge_paid || 0);

  // Update tenant with reconciled values. Advance/credit pools persist
  // UNCHANGED here (see above) — only status, arrears and the current
  // month's rent-paid display are recomputed.
  await updateTenant(tenantCode, {
    arrears: Math.max(0, existingArrears),
    rent_paid_this_month: Math.min(currentMonthPaid, rentAmount),
    status: tenantStatus,
  });

  return {
    tenant_code: tenantCode,
    status: tenantStatus,
    arrears: Math.max(0, existingArrears),
    rent_paid_this_month: Math.min(currentMonthPaid, rentAmount),
    current_month_outstanding: currentOutstanding,
    advance_balance: Number(tenant.advance_rent_balance || 0),
    periods: periodResults,
  };
}

/**
 * Reconcile all active tenants. Called during historical recovery and rollover.
 */
async function reconcileAllTenants() {
  const tenants = await query(
    `SELECT tenant_code FROM tenants WHERE status != 'Vacant' ORDER BY tenant_code`
  );
  let reconciled = 0;
  const errors = [];
  for (const t of tenants.rows) {
    try {
      await reconcileTenant(t.tenant_code);
      reconciled++;
    } catch (err) {
      errors.push({ tenant_code: t.tenant_code, error: err.message });
    }
  }
  return { reconciled, total: tenants.rows.length, errors };
}

// ===========================================================================
// DEPOSIT-TO-RENT AUTHORIZATION & RENT LOSS MANAGEMENT
// ===========================================================================

/**
 * Preview what would happen if deposit is applied to a billing period.
 * Returns data for the authorization confirmation dialog.
 */
async function getDepositApplicationPreview(tenantCode, billingPeriod) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;

  const depositAmount = Number(tenant.deposit_amount || 0);
  const depositPaid = Number(tenant.deposit_paid || 0);
  const availableDeposit = Math.max(0, depositPaid);

  // Get approved payments for this billing period
  const payRes = await query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
     WHERE tenant_code = $1 AND status = 'Approved' AND billing_period = $2 AND tenancy_id IS NULL`,
    [tenantCode, billingPeriod]
  );
  const paymentsApplied = Number(payRes.rows[0]?.total || 0);

  // Get existing deposit applications for this billing period
  const daRes = await query(
    `SELECT COALESCE(SUM(amount_applied), 0) AS total FROM deposit_applications
     WHERE tenant_code = $1 AND billing_period = $2 AND status = 'Active' AND tenancy_id IS NULL`,
    [tenantCode, billingPeriod]
  );
  const depositAlreadyApplied = Number(daRes.rows[0]?.total || 0);

  const rentAmount = Number(tenant.rent_amount || 0);
  const outstanding = Math.max(0, rentAmount - paymentsApplied - depositAlreadyApplied);
  const maxCanApply = Math.min(availableDeposit, outstanding);

  return {
    tenant_code: tenantCode,
    tenant_name: tenant.name,
    unit_code: tenantCode,
    property_name: tenant.property_name,
    billing_period: billingPeriod,
    rent_due: rentAmount,
    payments_applied: paymentsApplied,
    deposit_already_applied: depositAlreadyApplied,
    outstanding_rent: outstanding,
    deposit_amount: depositAmount,
    deposit_paid: depositPaid,
    available_deposit: availableDeposit,
    max_can_apply: maxCanApply,
  };
}

/**
 * Apply deposit to rent for a specific billing period.
 * Creates an audit trail and updates tenant deposit balance.
 * If writeOffAmount is provided, records the remainder as landlord loss.
 */
async function applyDepositToRent(tenantCode, amount, billingPeriod, authorizedBy, reason, writeOffAmount = 0) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) throw new Error('Tenant not found');

  const depositPaid = Number(tenant.deposit_paid || 0);
  const numAmount = Number(amount);
  const numWriteOff = Number(writeOffAmount || 0);

  if (numAmount <= 0) throw new Error('Amount must be positive');
  if (numAmount > depositPaid) throw new Error('Amount exceeds available deposit');

  const rentAmount = Number(tenant.rent_amount || 0);

  // Create the deposit application record
  const res = await query(
    `INSERT INTO deposit_applications (
       tenant_code, tenant_name, unit_code, property_name, house_paybill_number,
       original_deposit, deposit_paid_before, amount_applied, billing_period,
       rent_due, remaining_rent_after, rent_loss_amount, rent_loss_reason,
       deposit_remaining, authorized_by, reason, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'Active')
     RETURNING *`,
    [
      tenantCode, tenant.name, tenantCode, tenant.property_name, tenant.house_id,
      Number(tenant.deposit_amount || 0), depositPaid, numAmount, billingPeriod,
      rentAmount, Math.max(0, rentAmount - numAmount), numWriteOff,
      numWriteOff > 0 ? (reason || 'Unrecoverable rent') : null,
      depositPaid - numAmount, authorizedBy, reason || null,
    ]
  );
  const application = res.rows[0];

  // Reduce tenant's deposit_paid
  await updateTenant(tenantCode, {
    deposit_paid: depositPaid - numAmount,
  });

  // Reconcile to update balances and status
  await reconcileTenant(tenantCode);

  // Log audit
  await logAudit({
    actor: authorizedBy,
    action: 'deposit_applied_to_rent',
    entityType: 'tenant',
    entityId: tenantCode,
    details: {
      amount_applied: numAmount,
      billing_period: billingPeriod,
      deposit_remaining: depositPaid - numAmount,
      rent_loss: numWriteOff,
      reason,
    },
  });

  return application;
}

/**
 * Record a rent loss (write-off) for unrecovered rent.
 */
async function recordRentLoss(tenantCode, amount, billingPeriod, authorizedBy, reason) {
  // Record as a deposit application with 0 amount_applied but rent_loss_amount set
  const tenant = await getTenant(tenantCode);
  if (!tenant) throw new Error('Tenant not found');

  const res = await query(
    `INSERT INTO deposit_applications (
       tenant_code, tenant_name, unit_code, property_name, house_paybill_number,
       original_deposit, deposit_paid_before, amount_applied, billing_period,
       rent_due, remaining_rent_after, rent_loss_amount, rent_loss_reason,
       deposit_remaining, authorized_by, reason, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12,$13,$14,$15,'Active')
     RETURNING *`,
    [
      tenantCode, tenant.name, tenantCode, tenant.property_name, tenant.house_id,
      Number(tenant.deposit_amount || 0), Number(tenant.deposit_paid || 0),
      billingPeriod, Number(tenant.rent_amount || 0),
      Math.max(0, Number(tenant.rent_amount || 0) - Number(amount)),
      Number(amount), reason || 'Unrecoverable rent',
      Number(tenant.deposit_paid || 0), authorizedBy, reason || 'Rent loss write-off',
    ]
  );

  // Reconcile
  await reconcileTenant(tenantCode);

  await logAudit({
    actor: authorizedBy,
    action: 'rent_loss_recorded',
    entityType: 'tenant',
    entityId: tenantCode,
    details: { amount: Number(amount), billing_period: billingPeriod, reason },
  });

  return res.rows[0];
}

async function getDepositApplications(tenantCode) {
  const res = await query(
    `SELECT * FROM deposit_applications WHERE tenant_code = $1 AND tenancy_id IS NULL ORDER BY created_at DESC`,
    [tenantCode]
  );
  return res.rows;
}

async function deletePayment(id, actor) {
  const target = await query('SELECT * FROM payments WHERE id = $1', [id]);
  const deleted = target.rows[0];
  if (!deleted) return { deleted: false };
  // Payments bound to a completed tenancy are permanent history.
  if (deleted.tenancy_id != null) {
    return {
      deleted: false,
      error: 'This payment belongs to a completed (archived) tenancy and is permanently preserved — it cannot be deleted.',
      code: 'TENANCY_SEALED',
    };
  }
  const auditBase = {
    payment_id: deleted.id,
    amount: Number(deleted.amount || 0),
    tenant_code: deleted.tenant_code,
    payment_type: deleted.payment_type,
    payment_date: deleted.payment_date,
    mpesa_reference: deleted.mpesa_reference,
    receipt_number: deleted.receipt_number,
    status_before: deleted.status,
  };

  // Approved payments carrying their approval allocation are reversed
  // surgically (exact deltas). Anything else falls back to the legacy path.
  if (deleted.status === 'Approved' && deleted.tenant_code && deleted.allocation_breakdown) {
    const out = await reversePaymentAllocation(deleted);
    try {
      await logAudit({
        actor: actor ?? null, action: 'payment_deleted', entityType: 'payment', entityId: String(deleted.id),
        details: { ...auditBase, reversed_allocations_only: true, warnings: out.warnings || [] },
      });
    } catch (_) {}
    return out;
  }

  if (deleted.status === 'Approved' && deleted.tenant_code) {
    // Rebuild BEFORE deleting: if the rebuild throws, the payment row and
    // all counters stay exactly as they were (nothing is lost halfway).
    const rec = await recalculateAll(deleted.tenant_code, deleted.id);
    await query('DELETE FROM payments WHERE id = $1', [id]);

    // Reconcile after deletion to update status across all modules
    try {
      await reconcileTenant(deleted.tenant_code);
    } catch (err) {
      console.error(`[Reconcile] Post-deletion reconciliation failed for ${deleted.tenant_code}:`, err.message);
    }
    try {
      await logAudit({
        actor: actor ?? null, action: 'payment_deleted', entityType: 'payment', entityId: String(deleted.id),
        details: { ...auditBase, fallback_rebuild: true, warnings: (rec && rec.warnings) || [] },
      });
    } catch (_) {}
    const warnings = [...((rec && rec.warnings) || [])];
    if (!deleted.allocation_breakdown) {
      warnings.push('Deleted payment predates allocation snapshots — counters rebuilt from survivors; verify B/F arrears and pools.');
    }
    return { deleted: true, reversed: false, fallback: !deleted.allocation_breakdown && deleted.status === 'Approved', warnings };
  }

  await query('DELETE FROM payments WHERE id = $1', [id]);
  try {
    await logAudit({
      actor: actor ?? null, action: 'payment_deleted', entityType: 'payment', entityId: String(deleted.id),
      details: { ...auditBase, unapproved_no_reversal: true },
    });
  } catch (_) {}
  return { deleted: true, reversed: false, fallback: !deleted.allocation_breakdown && deleted.status === 'Approved' };
}

// Full rollback of one approved payment using the allocation snapshot taken
// at approval time (payments.allocation_breakdown). Every counter the
// approval moved is moved back by exactly that delta:
//   deposit_paid, garbage_fee_paid, water_charge_paid, arrears,
//   rent_paid_this_month, agreement_paid/outstanding, advance pool,
//   credit pool, penalty rows (LIFO per category), pending-overpayment rows.
// Receipt PDFs, invoice-register entries and message logs are history and
// are intentionally kept. rent_due_date is untouched by approval, so the
// rent period needs no correction beyond rent_paid_this_month.
async function reversePaymentAllocation(payment) {
  const num = (v) => Number(v || 0);
  let alloc = null;
  try {
    alloc = typeof payment.allocation_breakdown === 'string'
      ? JSON.parse(payment.allocation_breakdown)
      : payment.allocation_breakdown;
  } catch (_) { alloc = null; }
  if (!alloc) {
    const rec = await recalculateAll(payment.tenant_code, payment.id);
    await query('DELETE FROM payments WHERE id = $1', [payment.id]);
    try { await reconcileTenant(payment.tenant_code); } catch (_) {}
    const warnings = [...((rec && rec.warnings) || [])];
    warnings.push('Deleted payment predates allocation snapshots — counters rebuilt from survivors; verify B/F arrears and pools.');
    return { deleted: true, reversed: false, fallback: true, warnings };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = (sql, params) => client.query(sql, params);
    const tenantCode = payment.tenant_code;
    const warnings = [];

    const tRes = await run(`SELECT * FROM tenants WHERE tenant_code = $1`, [tenantCode]);
    const tenant = tRes.rows[0] || null;

    // Overpayment resolutions tied to this payment (rows vanish via CASCADE
    // on delete — read them first to unwind their effects).
    const poRes = await run(`SELECT * FROM pending_overpayments WHERE payment_id = $1`, [payment.id]);
    const resolved = poRes.rows.find((r) => String(r.status || '').toLowerCase() === 'resolved' || r.resolution_type);
    const resolutionChoice = resolved ? String(resolved.resolution_type || '').toLowerCase() : null;
    // Advance vs credit wording varies ('advance_rent' / 'credit_balance').
    const isCreditResolution = resolved && /credit/.test(resolutionChoice || '');
    const overpayment = Math.max(0, num(payment.overpayment_amount || alloc.overpayment));

    if (tenant) {
      const dep = num(alloc.depositSettled);
      const gar = num(alloc.garbageFeeSettled);
      const wat = num(alloc.waterSettled);
      const arr = num(alloc.arrearsSettled);
      const rent = num(alloc.rentSettled);
      const agr = num(alloc.agreementSettled);
      const pen = num(alloc.penaltySettled);
      const mnt = num(alloc.maintenanceSettled);
      const oth = num(alloc.otherSettled);

      const next = {
        deposit_paid: Math.min(Math.max(0, num(tenant.deposit_paid) - dep), num(tenant.deposit_amount)),
        garbage_fee_paid: Math.min(Math.max(0, num(tenant.garbage_fee_paid) - gar), num(tenant.garbage_fee_amount)),
        water_charge_paid: Math.min(Math.max(0, num(tenant.water_charge_paid) - wat), num(tenant.water_charge_amount)),
        arrears: num(tenant.arrears) + arr,
        rent_paid_this_month: Math.max(0, num(tenant.rent_paid_this_month) - rent),
        agreement_paid: Math.max(0, num(tenant.agreement_paid) - agr),
        agreement_outstanding: num(tenant.agreement_outstanding) + agr,
      };

      if (!resolved) {
        // Approval auto-converted the overpayment into the advance pool.
        next.advance_rent_balance = Math.max(0, num(tenant.advance_rent_balance) - overpayment);
        if (next.advance_rent_balance === 0) next.advance_rent_until = null;
      } else if (isCreditResolution) {
        // Resolution had moved the overpayment advance -> credit pool.
        next.credit_balance = Math.max(0, num(tenant.credit_balance) - overpayment);
      } else {
        // Months/advance resolution reshaped advance + rent top-up in ways
        // without snapshots — approximate the rent top-up, leave the pool.
        next.rent_paid_this_month = Math.max(0, next.rent_paid_this_month - overpayment);
        warnings.push('A months/advance resolution had reshaped this payment; rent top-up reversed approximately — verify advance balance and rent status.');
      }

      const fields = [];
      const values = [];
      let idx = 1;
      for (const [k, v] of Object.entries(next)) {
        fields.push(`${k} = $${idx++}`);
        values.push(v);
      }
      values.push(tenantCode);
      await run(`UPDATE tenants SET ${fields.join(', ')}, updated_at = NOW() WHERE tenant_code = $${idx}`, values);

      // Penalties: approval flips oldest-Pending rows to Paid per category
      // (exact category match — NULL categories are never touched by it).
      // Reverse newest-first up to each settled sum. Rows paid later by other
      // payments are flagged so states can be verified.
      const approvalDay = payment.approved_at || payment.payment_date || payment.recorded_at || null;
      for (const [cat, settled] of [['penalty', pen], ['maintenance', mnt], ['other', oth]]) {
        let need = num(settled);
        if (!(need > 0)) continue;
        const rows = await run(
          `SELECT id, amount, paid_date::text AS paid_date FROM penalties
           WHERE tenant_code = $1 AND category = $2 AND status = 'Paid'
           ORDER BY paid_date DESC NULLS LAST, id DESC`,
          [tenantCode, cat]
        );
        for (const row of rows.rows) {
          if (!(need > 0)) break;
          await run(`UPDATE penalties SET status = 'Pending', paid_date = NULL, updated_at = NOW() WHERE id = $1`, [row.id]);
          need = Math.max(0, need - num(row.amount));
          // Revert the linked maintenance-charge recovery this flip caused.
          await run(
            `UPDATE maintenance_charges SET recovery_status = 'Pending', amount_recovered = 0, updated_at = NOW()
             WHERE penalty_id = $1 AND recovery_status = 'Paid'`,
            [row.id]
          ).catch(() => {});
          if (approvalDay && row.paid_date && row.paid_date > String(approvalDay).slice(0, 10)) {
            warnings.push(`A ${cat} penalty paid after this payment was re-opened — verify penalty states.`);
          }
        }
        if (need > 0) {
          warnings.push(`Could not fully reverse ${cat} penalties (KES ${need.toFixed(2)} unmatched) — verify penalty states.`);
        }
      }
    }

    // Reverse Invoice Center links made by this payment (exact per-link
    // amounts), restoring each invoice's paid/balance state.
    try {
      await reverseInvoiceLinks(payment.id, run);
    } catch (linkErr) {
      warnings.push('Invoice links could not be fully reversed — verify invoice balances.');
      console.error(`[InvoiceLink] Reversal failed for payment ${payment.id}:`, linkErr.message);
    }

    await run(`DELETE FROM payments WHERE id = $1`, [payment.id]);
    await client.query('COMMIT');

    try {
      await reconcileTenant(tenantCode);
    } catch (err) {
      console.error(`[Reconcile] Post-reversal reconciliation failed for ${tenantCode}:`, err.message);
    }
    return { deleted: true, reversed: true, warnings };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function recalculateAll(tenantCode, excludeId = null) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return { warnings: [] };
  const warnings = [];

  // Unpay all penalties for this tenant (rebuilt below from survivors)
  await query(
    `UPDATE penalties SET status = 'Pending', paid_date = NULL, updated_at = NOW() WHERE tenant_code = $1 AND status = 'Paid'`,
    [tenantCode]
  );

  // Remaining approved payments, oldest first, WITH their snapshots.
  // excludeId (fallback-before-delete) keeps the doomed payment out of the
  // replay so counters are rebuilt before its row disappears.
  const payRes = await query(
    `SELECT * FROM payments WHERE tenant_code = $1 AND status = 'Approved' AND tenancy_id IS NULL${excludeId ? ' AND id <> $2' : ''} ORDER BY payment_date ASC, recorded_at ASC`,
    excludeId ? [tenantCode, excludeId] : [tenantCode]
  );

  const rentAmount = Number(tenant.rent_amount);
  const depositAmount = Number(tenant.deposit_amount || 0);
  const garbageFeeAmount = Number(tenant.garbage_fee_amount || 0);
  const waterChargeAmount = Number(tenant.water_charge_amount || 0);
  const agreementCharge = Number(tenant.agreement_charge || 0);
  // Current rent cycle (approval convention: billing follows rent_due_date)
  const cycleMonth = tenant.rent_due_date ? String(tenant.rent_due_date).slice(0, 7) : new Date().toISOString().slice(0, 7);

  // Exact replay from each survivor's OWN allocation snapshot (sums commute,
  // caps mirror approval). B/F arrears and advance/credit pools are rollover
  // and resolution state no payment history can reconstruct — preserved
  // as-is, never zeroed.
  let depositPaid = 0, garbageFeePaid = 0, waterChargePaid = 0, agreementPaid = 0, rentPaidCycle = 0;
  let legacyCount = 0;
  // Chronological rent-type tracking mirrors hasApprovedRentPaymentFor
  // (approval-time onboarding excludes the payment itself and later rows).
  let seenRent = false;

  for (const row of payRes.rows) {
    const bd = allocationOf(row);
    const amount = Number(row.amount || 0);
    const num = (v) => Number(v || 0);
    if (!bd) {
      // Legacy row without a snapshot: simulate approval order against live
      // counters. Arrears are deliberately NOT replayed — B/F belongs to
      // rollover history, not to this rebuild.
      legacyCount++;
      let remaining = amount;
      const ptype = row.payment_type || 'rent';
      if (ptype === 'deposit') {
        const settle = Math.min(Math.max(0, depositAmount - depositPaid), remaining);
        depositPaid += settle;
        remaining -= settle;
      } else {
        for (const cat of ['penalty', 'maintenance', 'other']) {
          if (!(remaining > 0)) break;
          const res = await payPenaltiesFromPayment(tenantCode, remaining, cat);
          remaining = res.remaining;
        }
        if (Math.max(0, garbageFeeAmount - garbageFeePaid) > 0 && remaining > 0) {
          const settle = Math.min(Math.max(0, garbageFeeAmount - garbageFeePaid), remaining);
          garbageFeePaid += settle;
          remaining -= settle;
        }
        if (Math.max(0, waterChargeAmount - waterChargePaid) > 0 && remaining > 0) {
          const settle = Math.min(Math.max(0, waterChargeAmount - waterChargePaid), remaining);
          waterChargePaid += settle;
          remaining -= settle;
        }
        if (rentPaidCycle < rentAmount && remaining > 0) {
          const settle = Math.min(rentAmount - rentPaidCycle, remaining);
          rentPaidCycle += settle;
          remaining -= settle;
        }
        // Deposit shortfall absorbs leftovers (mirrors approval step 8).
        if (Math.max(0, depositAmount - depositPaid) > 0 && remaining > 0) {
          const settle = Math.min(Math.max(0, depositAmount - depositPaid), remaining);
          depositPaid += settle;
          remaining -= settle;
        }
      }
      if (ptype === 'rent') seenRent = true;
      continue;
    }
    depositPaid = Math.min(depositAmount, depositPaid + num(bd.depositSettled));
    garbageFeePaid = Math.min(garbageFeeAmount, garbageFeePaid + num(bd.garbageFeeSettled));
    waterChargePaid = Math.min(waterChargeAmount, waterChargePaid + num(bd.waterSettled));
    agreementPaid = agreementPaid + num(bd.agreementSettled);
    if (billingMonthOfPayment(row) === cycleMonth) {
      rentPaidCycle = Math.min(rentAmount, rentPaidCycle + num(bd.rentSettled));
    }
    for (const [cat, key] of [['penalty', 'penaltySettled'], ['maintenance', 'maintenanceSettled'], ['other', 'otherSettled']]) {
      const total = num(bd[key]);
      if (total > 0) await payPenaltiesFromPayment(tenantCode, total, cat);
    }
    if ((row.payment_type || 'rent') === 'rent') seenRent = true;
  }

  if (legacyCount > 0) {
    warnings.push(`${legacyCount} payment(s) predate allocation snapshots — replayed approximately; verify arrears and pools.`);
  }
  if (Number(tenant.arrears || 0) > 0 || Number(tenant.advance_rent_balance || 0) > 0 || Number(tenant.credit_balance || 0) > 0) {
    warnings.push('B/F arrears and advance/credit pools preserved as-is (not recomputable from payments alone) — verify.');
  }

  // Recorded money that history cannot reconstruct is a FLOOR, never a wipe:
  // deposits/agreements are seeded at creation/activation and cash can be
  // recorded on the tenant row without a payment row (288+ such deposits).
  // The replay may RAISE these counters from history; it must not lower them
  // below what is already recorded. Deletion replays (excludeId set) skip the
  // floor so removing a payment can still lower its own counters.
  const keep = (replayed, stored) => (excludeId ? replayed : Math.max(Number(replayed || 0), Number(stored || 0)));

  const depositPaidFinal = keep(Math.min(depositPaid, depositAmount), tenant.deposit_paid);
  const garbagePaidFinal = keep(Math.min(garbageFeePaid, garbageFeeAmount), tenant.garbage_fee_paid);
  const waterPaidFinal = keep(Math.min(waterChargePaid, waterChargeAmount), tenant.water_charge_paid);
  const agreementPaidFinal = keep(agreementPaid, tenant.agreement_paid);
  const rentPaidFinal = keep(Math.min(rentPaidCycle, rentAmount), tenant.rent_paid_this_month);

  await updateTenant(tenantCode, {
    deposit_paid: depositPaidFinal,
    garbage_fee_paid: garbagePaidFinal,
    water_charge_paid: waterPaidFinal,
    agreement_paid: agreementPaidFinal,
    agreement_outstanding: Math.max(0, agreementCharge - agreementPaidFinal),
    rent_paid_this_month: rentPaidFinal,
  });
  return { warnings };
}

function allocationOf(row) {
  let bd = row ? row.allocation_breakdown : null;
  try { if (typeof bd === 'string') bd = JSON.parse(bd); } catch (_) { bd = null; }
  return bd || null;
}

function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

async function allocateAdvanceRent(tenantCode, excessAmount, selectedMonths = null) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;
  const rentAmount = Number(tenant.rent_amount || 0);
  if (rentAmount <= 0) return null;

  const rentPaidThisMonth = Number(tenant.rent_paid_this_month || 0);
  const remainingThisMonth = Math.max(0, rentAmount - rentPaidThisMonth);

  let leftover = excessAmount;
  const allocation = [];
  const now = new Date();
  const currentMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  // 1) Cover any remaining current-month rent first
  if (remainingThisMonth > 0 && leftover > 0) {
    const settle = Math.min(remainingThisMonth, leftover);
    allocation.push({ month: `${MONTHS[now.getMonth()]} ${now.getFullYear()}`, amount: settle });
    leftover -= settle;
  }

  let furthestDate = null;
  let partialAmount = 0;
  let fullMonths = 0;

  if (selectedMonths && selectedMonths.length) {
    // Allocate across the user-chosen months (treated as the range from the
    // earliest to the latest selected month, filling each month up to rent).
    const prefixes = selectedMonths
      .map((m) => String(m))
      .filter((m) => /^\d{4}-\d{2}$/.test(m))
      .sort();
    if (prefixes.length) {
      const [sy, sm] = prefixes[0].split('-').map(Number);
      const [ey, em] = prefixes[prefixes.length - 1].split('-').map(Number);
      const cur = new Date(sy, sm - 1, 1);
      const end = new Date(ey, em - 1, 1);
      const cursor = new Date(cur);

      while (cursor <= end && leftover > 0) {
        const d = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
        const settle = Math.min(rentAmount, leftover);
        const fullyPaid = settle >= rentAmount;
        const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        let monthLabel = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
        if (!fullyPaid) {
          const coveredDays = Math.ceil((settle / rentAmount) * daysInMonth);
          monthLabel += ` (partial: ${Math.min(coveredDays, daysInMonth)}/${daysInMonth} days)`;
          partialAmount = settle;
        } else {
          fullMonths++;
        }
        allocation.push({ month: monthLabel, amount: settle });
        if (!fullyPaid) {
          const coveredDays = Math.ceil((settle / rentAmount) * daysInMonth);
          const partialDate = new Date(d.getFullYear(), d.getMonth(), Math.min(coveredDays, daysInMonth));
          furthestDate = partialDate.toISOString().slice(0, 10);
        } else {
          furthestDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
        }
        leftover -= settle;
        cursor.setMonth(cursor.getMonth() + 1);
      }
    }
  } else {
    // Automatic allocation: consecutive future months from the current month.
    const autoFullMonths = Math.floor(leftover / rentAmount);
    const autoPartial = leftover - autoFullMonths * rentAmount;
    let baseDate = currentMonthStart;

    for (let i = 0; i < autoFullMonths; i++) {
      const nextMonth = addMonths(baseDate, 1);
      const d = new Date(nextMonth + 'T12:00:00');
      allocation.push({ month: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, amount: rentAmount });
      furthestDate = nextMonth;
      baseDate = nextMonth;
      fullMonths++;
    }

    if (autoPartial > 0) {
      const nextMonth = addMonths(baseDate, 1);
      const d = new Date(nextMonth + 'T12:00:00');
      const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const coveredDays = Math.ceil((autoPartial / rentAmount) * daysInMonth);
      const partialDate = new Date(d.getFullYear(), d.getMonth(), Math.min(coveredDays, daysInMonth));
      allocation.push({ month: `${MONTHS[d.getMonth()]} ${d.getFullYear()} (partial: ${coveredDays}/${daysInMonth} days)`, amount: autoPartial });
      furthestDate = partialDate.toISOString().slice(0, 10);
      partialAmount = autoPartial;
    }
  }

  // Any money that could not be placed into a month (e.g. selected months were
  // fully filled) stays as advance balance and is applied at the next rollover.
  const newAdvanceBalance = Number((partialAmount + Math.max(0, leftover)).toFixed(2));
  const newRentPaidThisMonth = Math.min(rentAmount, rentPaidThisMonth + excessAmount);

  await updateTenant(tenantCode, {
    rent_paid_this_month: newRentPaidThisMonth,
    advance_rent_until: furthestDate,
    advance_rent_balance: newAdvanceBalance,
  });

  return { allocation, advanceRentUntil: furthestDate, partialAmount, totalMonths: fullMonths, excessAmount };
}

async function allocateCreditBalance(tenantCode, excessAmount) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;
  const newCredit = Number(tenant.credit_balance || 0) + excessAmount;

  // Undo the auto-applied advance rent that was set during approvePayment.
  // The overpayment was already added to advance_rent_balance; subtract it back.
  const currentAdvance = Number(tenant.advance_rent_balance || 0);
  const newAdvance = Math.max(0, currentAdvance - excessAmount);
  const updates = { credit_balance: newCredit };
  if (newAdvance <= 0) {
    updates.advance_rent_balance = 0;
    updates.advance_rent_until = null;
  } else {
    updates.advance_rent_balance = newAdvance;
  }

  await updateTenant(tenantCode, updates);

  return { creditBalance: newCredit, advanceRentBalance: newAdvance };
}

async function getReceiptMode() {
  const res = await query(`SELECT value FROM app_config WHERE key = 'receipt_mode'`);
  return res.rows[0]?.value || 'test';
}

async function setReceiptMode(mode) {
  await query(`UPDATE app_config SET value = $1 WHERE key = 'receipt_mode'`, [mode]);
}

async function generateReceiptNumber(run) {

  const prefix = 'GEHPM-RCT';
  const datePart = `-${new Date().toISOString().slice(0, 7).replace('-', '')}`;

  const res = await runOrQuery(run,
    `UPDATE receipt_counters SET next_number = next_number + 1 WHERE prefix = $1 RETURNING next_number - 1 AS num`,
    [prefix]
  );

  let num;
  if (res.rows.length === 0) {
    await runOrQuery(run, `INSERT INTO receipt_counters (prefix, next_number) VALUES ($1, 2) ON CONFLICT (prefix) DO UPDATE SET next_number = next_number + 1 RETURNING 1 AS num`, [prefix]);
    num = 1;
  } else {
    num = res.rows[0].num;
  }

  return `${prefix}${datePart}-${String(num).padStart(6, '0')}`;
}

async function generateLetterNumber() {
  // Own series (GEHPM-DOC) on the shared counters table — existing receipt
  // and invoice series are untouched.
  const prefix = 'GEHPM-DOC';
  const datePart = `-${new Date().toISOString().slice(0, 7).replace('-', '')}`;

  const res = await query(
    `UPDATE receipt_counters SET next_number = next_number + 1 WHERE prefix = $1 RETURNING next_number - 1 AS num`,
    [prefix]
  );

  let num;
  if (res.rows.length === 0) {
    await query(`INSERT INTO receipt_counters (prefix, next_number) VALUES ($1, 2) ON CONFLICT (prefix) DO UPDATE SET next_number = receipt_counters.next_number + 1 RETURNING 1 AS num`, [prefix]);
    num = 1;
  } else {
    num = res.rows[0].num;
  }

  return `${prefix}${datePart}-${String(num).padStart(6, '0')}`;
}

async function generateInvoiceNumber() {
  const prefix = 'GEHPM-INV';
  const datePart = `-${new Date().toISOString().slice(0, 7).replace('-', '')}`;

  const res = await query(
    `UPDATE invoice_counters SET next_number = next_number + 1 WHERE prefix = $1 RETURNING next_number - 1 AS num`,
    [prefix]
  );

  let num;
  if (res.rows.length === 0) {
    await query(`INSERT INTO invoice_counters (prefix, next_number) VALUES ($1, 2) ON CONFLICT (prefix) DO UPDATE SET next_number = next_number + 1 RETURNING 1 AS num`, [prefix]);
    num = 1;
  } else {
    num = res.rows[0].num;
  }

  return `${prefix}${datePart}-${String(num).padStart(6, '0')}`;
}

async function generateStatementNumber() {
  const prefix = 'GEHPM-STMT';
  const datePart = `-${new Date().toISOString().slice(0, 7).replace('-', '')}`;

  const res = await query(
    `UPDATE statement_counters SET next_number = next_number + 1 WHERE prefix = $1 RETURNING next_number - 1 AS num`,
    [prefix]
  );

  let num;
  if (res.rows.length === 0) {
    await query(`INSERT INTO statement_counters (prefix, next_number) VALUES ($1, 2) ON CONFLICT (prefix) DO UPDATE SET next_number = next_number + 1 RETURNING 1 AS num`, [prefix]);
    num = 1;
  } else {
    num = res.rows[0].num;
  }

  return `${prefix}${datePart}-${String(num).padStart(6, '0')}`;
}

async function nextCounterNumber(counterTable, prefix) {
  const res = await query(
    `UPDATE ${counterTable} SET next_number = next_number + 1 WHERE prefix = $1 RETURNING next_number - 1 AS num`,
    [prefix]
  );

  let num;
  if (res.rows.length === 0) {
    await query(`INSERT INTO ${counterTable} (prefix, next_number) VALUES ($1, 2) ON CONFLICT (prefix) DO UPDATE SET next_number = next_number + 1 RETURNING 1 AS num`, [prefix]);
    num = 1;
  } else {
    num = res.rows[0].num;
  }

  const datePart = `-${new Date().toISOString().slice(0, 7).replace('-', '')}`;
  return `${prefix}${datePart}-${String(num).padStart(6, '0')}`;
}

async function generateMaintenanceInvoiceNumber() {
  return nextCounterNumber('invoice_counters', 'GEHPM-MNT');
}

async function generateWorkOrderNumber() {
  return nextCounterNumber('invoice_counters', 'GEHPM-WO');
}

async function createDocument({
  doc_type,
  doc_number,
  title,
  filename,
  file_path,
  tenant_code = null,
  house_paybill_number = null,
  property_name = null,
  unit_label = null,
  amount = null,
  doc_date = null,
  template_key = null,
  status = 'Finalized',
  body_text = null,
  resolved_recipient = null,
  payment_id = null,
  reuse_invoice_doc = false,
}) {
  // Opt-in dedupe for regenerated invoice PDFs: same (type, number) reuses
  // its document row (file overwritten in place) instead of triplicating.
  if (reuse_invoice_doc && doc_type && doc_number) {
    try {
      const reused = await reuseInvoiceDocument({
        doc_type, doc_number, file_path, filename, amount,
      });
      if (reused) return reused;
    } catch (_) {}
  }
  const res = await query(
    `INSERT INTO documents
       (doc_type, doc_number, title, filename, file_path, tenant_code, house_paybill_number, property_name, unit_label, amount, doc_date, template_key, status, body_text, resolved_recipient, payment_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *`,
    [
      doc_type,
      doc_number || null,
      title || null,
      filename,
      file_path,
      tenant_code || null,
      house_paybill_number || null,
      property_name || null,
      unit_label || null,
      amount != null ? Number(amount) : null,
      doc_date || null,
      template_key || null,
      status || 'Finalized',
      body_text || null,
      resolved_recipient || null,
      payment_id != null ? Number(payment_id) : null,
    ]
  );
  return res.rows[0] || null;
}

async function getDocument(id) {
  const res = await query(
    `SELECT d.*, d.doc_date::text AS doc_date, t.name AS tenant_name, t.phone_number AS tenant_phone, h.house_name AS house_name
     FROM documents d
     LEFT JOIN tenants t ON t.tenant_code = d.tenant_code
     LEFT JOIN houses h ON h.paybill_number = d.house_paybill_number
     WHERE d.id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

// Permanent payment <-> receipt-PDF link. Prefers the payment_id recorded at
// generation time; falls back to receipt-number matching for older receipts.
async function findReceiptDocument(paymentId) {  const pay = await query(`SELECT id, receipt_number, tenant_code FROM payments WHERE id = $1`, [paymentId]);
  const p = pay.rows[0];
  if (!p) return null;
  const byPay = await query(
    `SELECT * FROM documents WHERE payment_id = $1 AND doc_type = 'receipt' ORDER BY id DESC LIMIT 1`,
    [paymentId]
  );
  if (byPay.rows[0]) return byPay.rows[0];
  if (p.receipt_number) {
    const byNo = await query(
      `SELECT * FROM documents WHERE doc_type = 'receipt' AND doc_number = $1 AND (tenant_code = $2 OR tenant_code IS NULL) ORDER BY id DESC LIMIT 1`,
      [p.receipt_number, p.tenant_code]
    );
    if (byNo.rows[0]) return byNo.rows[0];
  }
  return null;
}

// Invoice PDF regeneration reuses the existing document row for the same
// (type, number) instead of triplicating it — invoice numbers are globally
// unique per sequence. The PDF file is overwritten in place; the row keeps
// its identity so all existing references stay valid.
async function reuseInvoiceDocument({ doc_type, doc_number, file_path, filename, amount }) {
  if (!doc_type || !doc_number) return null;
  const found = await query(
    `SELECT * FROM documents WHERE doc_type = $1 AND doc_number = $2 ORDER BY id DESC LIMIT 1`,
    [doc_type, doc_number]
  );
  if (!found.rows[0]) return null;
  const res = await query(
    `UPDATE documents SET file_path = $2, filename = COALESCE($3, filename),
       amount = COALESCE($4, amount), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [found.rows[0].id, file_path, filename || null, amount != null ? Number(amount) : null]
  );
  return res.rows[0] || null;
}

// A payment always has exactly ONE receipt row. When an overpayment
// resolution regenerates the receipt (advance rent / credit balance), the
// existing row is updated in place — same payment link, same receipt number —
// so the documents hub never accumulates duplicate receipts per payment.
async function updateReceiptDocument(id, { file_path, filename, amount }) {
  const res = await query(
    `UPDATE documents SET file_path = $2, filename = COALESCE($3, filename),
       amount = COALESCE($4, amount), updated_at = NOW()
     WHERE id = $1 AND doc_type = 'receipt' RETURNING *`,
    [id, file_path, filename || null, amount != null ? Number(amount) : null]
  );
  return res.rows[0] || null;
}

// Letters: drafts are editable; finalized rows are immutable (a new version
// means a new document row — history is never silently overwritten).
async function updateLetterDraft(id, { title, body_text, resolved_recipient }) {
  const res = await query(
    `UPDATE documents SET title = COALESCE($2, title), body_text = COALESCE($3, body_text),
       resolved_recipient = COALESCE($4, resolved_recipient), updated_at = NOW()
     WHERE id = $1 AND doc_type = 'letter' AND status = 'Draft'
     RETURNING *`,
    [id, title || null, body_text != null ? body_text : null, resolved_recipient != null ? resolved_recipient : null]
  );
  return res.rows[0] || null;
}

async function finalizeLetterDocument(id, { doc_number, filename, file_path }) {
  const res = await query(
    `UPDATE documents SET doc_number = $2, filename = $3, file_path = $4,
       status = 'Finalized', updated_at = NOW()
     WHERE id = $1 AND doc_type = 'letter' AND status = 'Draft'
     RETURNING *`,
    [id, doc_number, filename, file_path]
  );
  return res.rows[0] || null;
}

async function listDocuments({ doc_type, tenant_code, house_paybill_number, from, to, q, limit, offset } = {}) {
  const conditions = [];
  const values = [];
  let index = 1;

  if (doc_type) {
    conditions.push(`d.doc_type = $${index++}`);
    values.push(doc_type);
  }
  if (tenant_code) {
    conditions.push(`d.tenant_code = $${index++}`);
    values.push(tenant_code);
  }
  if (house_paybill_number) {
    conditions.push(`d.house_paybill_number = $${index++}`);
    values.push(house_paybill_number);
  }
  if (from) {
    conditions.push(`d.doc_date >= $${index++}`);
    values.push(from);
  }
  if (to) {
    conditions.push(`d.doc_date <= $${index++}`);
    values.push(to);
  }
  if (q) {
    conditions.push(`(d.title ILIKE $${index} OR d.doc_number ILIKE $${index} OR d.unit_label ILIKE $${index} OR COALESCE(t.name, '') ILIKE $${index})`);
    values.push(`%${q}%`);
    index++;
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitNum = Math.min(Number(limit) || 200, 500);
  const offsetNum = Math.max(Number(offset) || 0, 0);

  const countRes = await query(
    `SELECT COUNT(*) AS total
     FROM documents d
     LEFT JOIN tenants t ON t.tenant_code = d.tenant_code
     ${whereSql}`,
    values
  );

  const rowsRes = await query(
    `SELECT d.*, d.doc_date::text AS doc_date, t.name AS tenant_name, t.phone_number AS tenant_phone, h.house_name AS house_name
     FROM documents d
     LEFT JOIN tenants t ON t.tenant_code = d.tenant_code
     LEFT JOIN houses h ON h.paybill_number = d.house_paybill_number
     ${whereSql}
     ORDER BY d.doc_date DESC NULLS LAST, d.id DESC
     LIMIT $${index} OFFSET $${index + 1}`,
    [...values, limitNum, offsetNum]
  );

  return {
    documents: rowsRes.rows.map(d => ({
      ...d,
      amount: d.amount != null ? Number(d.amount) : null,
    })),
    total: Number(countRes.rows[0].total || 0),
  };
}

async function deleteDocument(id) {
  const res = await query('DELETE FROM documents WHERE id = $1 RETURNING *', [id]);
  return res.rows[0] || null;
}

// Delivery tracking for letters only (Draft / Finalized / Sent / Downloaded).
// Other document types keep whatever status they already carry.
async function markLetterDelivery(id, status) {
  if (!['Sent', 'Downloaded'].includes(status)) return null;
  const res = await query(
    `UPDATE documents SET status = $2, updated_at = NOW()
     WHERE id = $1 AND doc_type = 'letter' AND status IN ('Finalized', 'Sent', 'Downloaded')
     RETURNING *`,
    [id, status]
  );
  return res.rows[0] || null;
}

// ---- Permanent Invoice Register -----------------------------------------
// Every invoice generated by the system is recorded here immediately and
// never deleted. Download / WhatsApp-send events update the delivery status.

function mapInvoiceRegisterRow(r) {
  if (!r) return null;
  const amount = r.amount != null ? Number(r.amount) : null;
  const paid = Number(r.amount_paid || 0);
  const balance = r.balance_due != null ? Number(r.balance_due) : (amount != null ? amount - paid : null);
  let payment_state = null;
  if (amount != null && amount > 0) {
    payment_state = paid <= 0 ? 'Unpaid' : (balance > 0 ? 'Partially Paid' : 'Paid');
  }
  return {
    ...r,
    amount,
    deposit_paid: r.deposit_paid != null ? Number(r.deposit_paid) : null,
    deposit_refund: r.deposit_refund != null ? Number(r.deposit_refund) : null,
    deductions_total: r.deductions_total != null ? Number(r.deductions_total) : null,
    final_refund: r.final_refund != null ? Number(r.final_refund) : null,
    amount_paid: paid,
    balance_due: balance,
    last_payment_id: r.last_payment_id != null ? Number(r.last_payment_id) : null,
    payment_state,
  };
}

async function createInvoiceRegister(data = {}) {
  // Dedupe: regenerating the same invoice (view/download/send of one water,
  // exit or maintenance invoice) reuses its open register row instead of
  // triplicating it. Fresh numbers always insert.
  if (data.invoice_number && data.tenant_code) {
    const dup = await query(
      `SELECT * FROM invoice_register
       WHERE invoice_number = $1 AND tenant_code = $2 AND COALESCE(voided, false) = false
       ORDER BY id DESC LIMIT 1`,
      [data.invoice_number, data.tenant_code]
    );
    if (dup.rows[0]) {
      const r = await query(
        `UPDATE invoice_register SET
           document_id = COALESCE($2, document_id),
           tenant_name = COALESCE($3, tenant_name),
           property_name = COALESCE($4, property_name),
           house_paybill_number = COALESCE($5, house_paybill_number),
           unit_label = COALESCE($6, unit_label),
           amount = COALESCE($7, amount),
           balance_due = GREATEST(0, COALESCE($7, amount) - COALESCE(amount_paid, 0)),
           updated_at = NOW()
         WHERE id = $1
         RETURNING *, generated_at, move_out_date::text AS move_out_date`,
        [dup.rows[0].id, data.document_id || null, data.tenant_name || null,
         data.property_name || null, data.house_paybill_number || null, data.unit_label || null,
         data.amount != null ? Number(data.amount) : null]
      );
      return mapInvoiceRegisterRow(r.rows[0]);
    }
  }
  const res = await query(
    `INSERT INTO invoice_register
       (document_id, invoice_number, invoice_type, generated_at, generated_by,
        tenant_code, tenant_name, property_name, house_paybill_number, unit_label,
        amount, status, move_out_date, deposit_paid, deposit_refund,
        deductions_total, final_refund, approved_by)
     VALUES ($1, $2, $3, COALESCE($4, NOW()), $5, $6, $7, $8, $9, $10,
             $11, 'Generated', $12, $13, $14, $15, $16, $17)
     RETURNING *, generated_at, move_out_date::text AS move_out_date`,
    [
      data.document_id || null,
      data.invoice_number,
      data.invoice_type || 'other',
      data.generated_at || null,
      data.generated_by || null,
      data.tenant_code || null,
      data.tenant_name || null,
      data.property_name || null,
      data.house_paybill_number || null,
      data.unit_label || null,
      data.amount != null ? Number(data.amount) : null,
      data.move_out_date || null,
      data.deposit_paid != null ? Number(data.deposit_paid) : null,
      data.deposit_refund != null ? Number(data.deposit_refund) : null,
      data.deductions_total != null ? Number(data.deductions_total) : null,
      data.final_refund != null ? Number(data.final_refund) : null,
      data.approved_by || null,
    ]
  );
  return mapInvoiceRegisterRow(res.rows[0]);
}

async function getInvoiceRegister(id) {
  const res = await query(`SELECT *, generated_at, move_out_date::text AS move_out_date FROM invoice_register WHERE id = $1`, [id]);
  return mapInvoiceRegisterRow(res.rows[0]);
}

async function getInvoiceRegisterByDocument(documentId) {
  const res = await query(
    `SELECT *, generated_at, move_out_date::text AS move_out_date FROM invoice_register WHERE document_id = $1 ORDER BY id DESC LIMIT 1`,
    [documentId]
  );
  return mapInvoiceRegisterRow(res.rows[0]);
}

async function getInvoiceRegisterByNumber(invoiceNumber) {
  const res = await query(
    `SELECT *, generated_at, move_out_date::text AS move_out_date FROM invoice_register WHERE invoice_number = $1 ORDER BY id DESC LIMIT 1`,
    [invoiceNumber]
  );
  return mapInvoiceRegisterRow(res.rows[0]);
}

// Void every open register row for a tenant code (tenancy change). Rows stay
// for audit but leave all payment/allocation queries. Closed by vacancy or
// new occupancy — the code is reused by the next tenancy.
async function voidTenantInvoices(tenantCode, actor, reason) {
  const res = await query(
    `UPDATE invoice_register SET voided = true, voided_at = NOW(), voided_reason = $2, updated_at = NOW()
     WHERE tenant_code = $1 AND COALESCE(voided, false) = false
     RETURNING id`,
    [tenantCode, reason || (actor ? `Voided by ${actor}` : 'Tenancy changed')]
  );
  return res.rows.map((r) => r.id);
}

// Correct a register entry's amount. Balance recomputes from linked payments
// (never below zero); linked document amount follows. Payments, counters,
// receipts and allocations are untouched.
async function updateInvoiceRegister(id, patch = {}, actor) {
  const existing = await getInvoiceRegister(id);
  if (!existing) return null;
  if (patch.amount == null) throw new Error('amount required');
  const amount = Number(patch.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('amount must be a non-negative number');
  const paid = Number(existing.amount_paid || 0);
  const res = await query(
    `UPDATE invoice_register SET amount = $2,
       balance_due = GREATEST(0, $2 - COALESCE(amount_paid, 0)),
       updated_at = NOW()
     WHERE id = $1
     RETURNING *, generated_at, move_out_date::text AS move_out_date`,
    [id, amount]
  );
  const row = mapInvoiceRegisterRow(res.rows[0]);
  let documentUpdated = false;
  if (row && row.document_id) {
    const dres = await query(
      `UPDATE documents SET amount = $2, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [row.document_id, amount]
    );
    documentUpdated = (dres.rowCount || 0) > 0;
  }
  try {
    await logAudit({
      actor: actor ?? null, action: 'invoice_register_updated', entityType: 'invoice_register', entityId: String(id),
      details: { invoice_number: existing.invoice_number, amount_before: existing.amount, amount_after: amount, document_updated: documentUpdated },
    });
  } catch (_) {}
  return { register: row, document_updated: documentUpdated, clamped: paid > amount };
}

// Delete a register entry and everything created solely for it: its payment
// links, its linked document row + PDF file. Payments, counters, receipts,
// allocations and unrelated history are never touched.
async function deleteInvoiceRegister(id, actor) {
  const existing = await getInvoiceRegister(id);
  if (!existing) return null;
  const links = await query(`SELECT id, payment_id, amount FROM invoice_payment_links WHERE invoice_id = $1`, [id]);
  await query(`DELETE FROM invoice_payment_links WHERE invoice_id = $1`, [id]);
  let documentRemoved = false;
  let fileRemoved = false;
  if (existing.document_id) {
    const dres = await query(`SELECT id, file_path, filename FROM documents WHERE id = $1`, [existing.document_id]);
    const doc = dres.rows[0] || null;
    await query(`DELETE FROM documents WHERE id = $1`, [existing.document_id]);
    if (doc) {
      documentRemoved = true;
      try {
        const fs = require('fs');
        if (doc.file_path && fs.existsSync(doc.file_path)) { fs.unlinkSync(doc.file_path); fileRemoved = true; }
      } catch (_) {}
    }
  }
  await query(`DELETE FROM invoice_register WHERE id = $1`, [id]);
  try {
    await logAudit({
      actor: actor ?? null, action: 'invoice_register_deleted', entityType: 'invoice_register', entityId: String(id),
      details: { invoice_number: existing.invoice_number, tenant_code: existing.tenant_code, links_removed: links.rows.length, document_removed: documentRemoved, file_removed: fileRemoved },
    });
  } catch (_) {}
  return {
    deleted: true, id,
    invoice_number: existing.invoice_number,
    links_removed: links.rows.length,
    document_removed: documentRemoved,
    file_removed: fileRemoved,
  };
}

async function listInvoiceRegister(filters = {}) {
  const conditions = [];
  const values = [];
  let index = 1;

  if (filters.q) {
    conditions.push(
      `(invoice_number ILIKE $${index} OR COALESCE(tenant_name, '') ILIKE $${index} OR COALESCE(unit_label, '') ILIKE $${index} OR COALESCE(property_name, '') ILIKE $${index})`
    );
    values.push(`%${filters.q}%`);
    index++;
  }
  if (filters.invoice_type) {
    conditions.push(`invoice_type = $${index++}`);
    values.push(filters.invoice_type);
  }
  if (filters.status) {
    conditions.push(`status = $${index++}`);
    values.push(filters.status);
  }
  if (filters.tenant_code) {
    conditions.push(`tenant_code = $${index++}`);
    values.push(filters.tenant_code);
  }
  if (filters.house_paybill_number) {
    conditions.push(`house_paybill_number = $${index++}`);
    values.push(filters.house_paybill_number);
  }
  if (filters.unit_label) {
    conditions.push(`unit_label = $${index++}`);
    values.push(filters.unit_label);
  }
  if (filters.month) {
    conditions.push(`to_char(generated_at, 'YYYY-MM') = $${index++}`);
    values.push(filters.month);
  }
  if (filters.year) {
    conditions.push(`EXTRACT(YEAR FROM generated_at) = $${index++}`);
    values.push(filters.year);
  }
  if (filters.from) {
    conditions.push(`generated_at >= $${index++}::date`);
    values.push(filters.from);
  }
  if (filters.to) {
    conditions.push(`generated_at < ($${index++}::date + INTERVAL '1 day')`);
    values.push(filters.to);
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitNum = Math.min(Number(filters.limit) || 200, 500);
  const offsetNum = Math.max(Number(filters.offset) || 0, 0);

  const countRes = await query(
    `SELECT COUNT(*) AS total FROM invoice_register ${whereSql}`,
    values
  );

  const rowsRes = await query(
    `SELECT *, generated_at, move_out_date::text AS move_out_date
     FROM invoice_register
     ${whereSql}
     ORDER BY generated_at DESC, id DESC
     LIMIT $${index} OFFSET $${index + 1}`,
    [...values, limitNum, offsetNum]
  );

  return {
    records: rowsRes.rows.map(mapInvoiceRegisterRow),
    total: Number(countRes.rows[0].total || 0),
  };
}

async function listInvoiceRegisterMonthly() {
  const res = await query(
    `SELECT to_char(generated_at, 'YYYY-MM') AS month, invoice_type, COUNT(*) AS count
     FROM invoice_register
     GROUP BY 1, 2
     ORDER BY 1 DESC`
  );
  const byMonth = new Map();
  for (const r of res.rows) {
    const key = r.month;
    if (!byMonth.has(key)) {
      const [year, mon] = key.split('-').map(Number);
      byMonth.set(key, {
        month: key,
        year,
        label: new Date(year, mon - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
        counts: { rent: 0, maintenance: 0, penalty: 0, exit: 0, other: 0, total: 0 },
      });
    }
    const entry = byMonth.get(key);
    const type = r.invoice_type;
    const n = Number(r.count || 0);
    if (entry.counts[type] != null) entry.counts[type] += n;
    entry.counts.total += n;
  }
  return Array.from(byMonth.values());
}

async function markInvoiceRegister({ id, document_id, action } = {}) {
  let row = null;
  if (id != null) row = await getInvoiceRegister(id);
  else if (document_id != null) row = await getInvoiceRegisterByDocument(document_id);
  if (!row) return null;

  let downloaded = row.downloaded_at != null;
  let sent = row.sent_at != null;
  if (action === 'download') downloaded = true;
  if (action === 'send') sent = true;

  let status = 'Generated';
  if (downloaded && sent) status = 'Downloaded & Sent';
  else if (downloaded) status = 'Downloaded';
  else if (sent) status = 'Sent via WhatsApp';

  const res = await query(
    `UPDATE invoice_register SET
       status = $2,
       downloaded_at = CASE WHEN $3 THEN COALESCE(downloaded_at, NOW()) ELSE downloaded_at END,
       sent_at = CASE WHEN $4 THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
       updated_at = NOW()
     WHERE id = $1
     RETURNING *, generated_at, move_out_date::text AS move_out_date`,
    [row.id, status, downloaded, sent]
  );
  return mapInvoiceRegisterRow(res.rows[0]);
}

// ─── Invoice Center payment linking (read outstanding, apply, reverse) ─────
// Allocation rules are NEVER changed here: this only mirrors each settled
// bucket onto matching outstanding register rows (oldest first) so invoices
// show Paid / Partially Paid. Tenant counters remain the system of record.

// Bucket -> register types. Dedicated types first; rent invoices bundle
// rent+arrears+garbage(+water fallback), per getRentInvoiceData.
const INVOICE_BUCKET_TYPES = {
  water: [['water'], ['rent']],
  maintenance: [['maintenance']],
  other: [['other']],
  rentFamily: [['rent']],
};

async function listOutstandingRegisterInvoices(tenantCode, run) {
  const q = runOrQuery(run,
    `SELECT ir.*, ir.generated_at
     FROM invoice_register ir
     WHERE ir.tenant_code = $1
       AND ir.invoice_type <> 'exit'
       AND COALESCE(ir.voided, false) = false
       AND COALESCE(ir.balance_due, ir.amount, 0) > 0
     ORDER BY ir.generated_at ASC NULLS LAST, ir.id ASC`,
    [tenantCode]
  );
  const res = await q;
  return res.rows.map(mapInvoiceRegisterRow);
}

function splitAllocForLinking(allocation, paymentType) {
  const num = (v) => Number(v || 0);
  const get = (k) => (allocation ? num(allocation[k]) : 0);
  if (paymentType === 'deposit') {
    return [{ bucket: 'deposit', amount: get('depositSettled') }];
  }
  return [
    { bucket: 'water', amount: get('waterSettled') },
    { bucket: 'maintenance', amount: get('maintenanceSettled') },
    { bucket: 'other', amount: get('otherSettled') },
    {
      bucket: 'rentFamily',
      amount: get('arrearsSettled') + get('rentSettled') + get('garbageFeeSettled'),
    },
  ];
}

async function applyPaymentToInvoices(payment, allocation, tenant, run) {
  const tenantCode = payment.tenant_code || payment.tenant_id;
  if (!tenantCode || !allocation) return [];
  const applied = [];
  const outstanding = await listOutstandingRegisterInvoices(tenantCode, run);
  if (!outstanding.length) return applied;
  const byType = {};
  for (const inv of outstanding) {
    const t = String(inv.invoice_type || 'other');
    (byType[t] = byType[t] || []).push(inv);
  }
  const buckets = splitAllocForLinking(allocation, payment.payment_type);
  for (const { bucket, amount } of buckets) {
    let remaining = Number(amount || 0);
    if (!(remaining > 0)) continue;
    const typeGroups = INVOICE_BUCKET_TYPES[bucket] || [];
    for (const types of typeGroups) {
      if (!(remaining > 0)) break;
      for (const t of types) {
        if (!(remaining > 0)) break;
        for (const inv of (byType[t] || [])) {
          if (!(remaining > 0)) break;
          if (inv._consumed) continue;
          // Voided water invoices never absorb payments.
          if (t === 'water' && inv._voidChecked !== true) {
            inv._voidChecked = true;
            try {
              const chk = await runOrQuery(run,
                `SELECT status FROM water_invoices WHERE wtr_number = $1 LIMIT 1`,
                [inv.invoice_number]
              );
              if (chk.rows[0] && String(chk.rows[0].status || '') === 'Void') continue;
            } catch (_) {}
          }
          const balance = Number(inv.balance_due ?? inv.amount ?? 0) - Number(inv._applied || 0);
          if (!(balance > 0)) continue;
          const apply = Math.min(balance, remaining);
          inv._applied = Number(inv._applied || 0) + apply;
          remaining = Math.max(0, remaining - apply);
          applied.push({ invoice_id: inv.id, amount: apply });
        }
      }
    }
  }
  for (const a of applied) {
    await runOrQuery(run,
      `UPDATE invoice_register
       SET amount_paid = COALESCE(amount_paid, 0) + $2,
           balance_due = COALESCE(amount, 0) - (COALESCE(amount_paid, 0) + $2),
           last_payment_id = $3, updated_at = NOW()
       WHERE id = $1`,
      [a.invoice_id, a.amount, payment.id]
    );
    await runOrQuery(run,
      `INSERT INTO invoice_payment_links (invoice_id, payment_id, amount)
       VALUES ($1, $2, $3)
       ON CONFLICT (invoice_id, payment_id) DO UPDATE SET amount = invoice_payment_links.amount + EXCLUDED.amount`,
      [a.invoice_id, payment.id, a.amount]
    );
  }
  return applied;
}

// Exact reversal of the above (called from payment deletion, same tx).
async function reverseInvoiceLinks(paymentId, run) {
  const res = await runOrQuery(run, `SELECT * FROM invoice_payment_links WHERE payment_id = $1`, [paymentId]);
  for (const link of res.rows) {
    await runOrQuery(run, `DELETE FROM invoice_payment_links WHERE id = $1`, [link.id]);
    await runOrQuery(run,
      `UPDATE invoice_register SET
         amount_paid = GREATEST(0, COALESCE(amount_paid, 0) - $2),
         last_payment_id = (SELECT payment_id FROM invoice_payment_links WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1),
         updated_at = NOW()
       WHERE id = $1`,
      [link.invoice_id, Number(link.amount || 0)]
    );
    await runOrQuery(run,
      `UPDATE invoice_register SET balance_due = COALESCE(amount, 0) - COALESCE(amount_paid, 0) WHERE id = $1`,
      [link.invoice_id]
    );
  }
  return res.rows.length;
}

async function resetTestReceipts() {
  await query(`UPDATE receipt_counters SET next_number = 1 WHERE prefix = 'GHPM-TEST'`);
}

async function applyCreditBalance(tenantCode, amount, target, opts = {}) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;
  const available = Number(tenant.credit_balance || 0);
  if (amount <= 0 || amount > available) return null;

  const newCredit = available - amount;
  const patch = { credit_balance: newCredit };
  let description = '';
  let paymentType = 'rent';

  switch (target) {
    case 'rent': {
      const rentAmount = Number(tenant.rent_amount || 0);
      const rentPaid = Number(tenant.rent_paid_this_month || 0);
      const newRentPaid = Math.min(rentAmount, rentPaid + amount);
      patch.rent_paid_this_month = newRentPaid;
      description = `Credit applied to rent: KES ${amount}`;
      paymentType = 'rent';
      break;
    }
    case 'penalty': {
      const pending = await listPendingPenalties(tenantCode);
      let remaining = amount;
      for (const p of pending) {
        if (remaining <= 0) break;
        const settle = Math.min(p.amount, remaining);
        if (settle >= p.amount) {
          await query(`UPDATE penalties SET status = 'Paid', paid_date = CURRENT_DATE, updated_at = NOW() WHERE id = $1`, [p.id]);
        }
        remaining -= settle;
      }
      description = `Credit applied to penalties: KES ${amount}`;
      paymentType = 'penalty';
      break;
    }
    case 'garbage': {
      const garbagePaid = Number(tenant.garbage_fee_paid || 0);
      const garbageAmount = Number(tenant.garbage_fee_amount || 0);
      const newGarbagePaid = Math.min(garbageAmount, garbagePaid + amount);
      patch.garbage_fee_paid = newGarbagePaid;
      description = `Credit applied to garbage fee: KES ${amount}`;
      paymentType = 'garbage';
      break;
    }
    case 'deposit': {
      const depositPaid = Number(tenant.deposit_paid || 0);
      const depositAmount = Number(tenant.deposit_amount || 0);
      const newDepositPaid = Math.min(depositAmount, depositPaid + amount);
      patch.deposit_paid = newDepositPaid;
      description = `Credit applied to deposit: KES ${amount}`;
      paymentType = 'deposit';
      break;
    }
    default:
      return null;
  }

  await updateTenant(tenantCode, patch);

  const creditReceiptNumber = await generateReceiptNumber();

  await query(
    `INSERT INTO payments (tenant_code, amount, mpesa_reference, status, payment_date, notes, payment_type, receipt_number)
     VALUES ($1, $2, $3, 'Approved', CURRENT_DATE, $4, $5, $6)`,
    [tenantCode, amount, `CREDIT-${Date.now()}`, description, paymentType, creditReceiptNumber]
  );

  const reason = opts && opts.reason ? String(opts.reason).trim().slice(0, 500) : null;
  const actor = opts && opts.actor ? String(opts.actor).trim() : null;
  await query(
    `INSERT INTO credit_allocations (tenant_code, amount, target, reason, approved_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantCode, amount, target, reason, actor]
  );

  return { creditBalance: newCredit, target, amount, description, reason, approvedBy: actor };
}

async function logLedgerEntry(tenantCode, type, amount, description) {
  // Ledger adjustments are financial records too: same tenancy validation,
  // same origin tracking — never a raw INSERT.
  const row = await createPayment({
    tenant_id: tenantCode,
    amount,
    mpesa_reference: `LEDGER-${String(type || 'adj').toUpperCase()}-${Date.now()}`,
    notes: description,
    status: 'Approved',
    payment_type: 'rent',
    source: 'ledger_adjustment',
  });
  if (row && row.error) {
    console.error(`[Ledger] entry rejected for ${tenantCode}: ${row.error}`);
    return null;
  }
  try {
    await logAudit({
      actor: 'system', action: 'ledger_entry', entityType: 'payment',
      entityId: String(row.id), details: { type, amount, description },
    });
  } catch (_) {}
  return row;
}

function mapPendingOverpaymentRow(r) {
  return {
    ...r,
    payment_amount: Number(r.payment_amount || 0),
    overpayment_amount: Number(r.overpayment_amount || 0),
    payment_date: r.payment_date ? String(r.payment_date).slice(0, 10) : null,
    created_at: r.created_at,
    resolved_at: r.resolved_at,
  };
}

async function createPendingOverpayment({ payment, tenant, overpayment }) {
  if (!payment || !tenant) return null;
  const numOverpayment = Number(overpayment);
  if (!(numOverpayment > 0)) return null;
  const res = await query(
    `INSERT INTO pending_overpayments
       (tenant_code, tenant_name, property_name, unit_code, payment_id, payment_amount,
        overpayment_amount, receipt_number, transaction_reference, payment_date, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Pending Allocation')
     RETURNING *`,
    [
      tenant.tenant_code,
      String(tenant.name || 'Tenant').trim().slice(0, 128),
      String(tenant.property_name || 'General').trim().slice(0, 128),
      String(tenant.unit_label || tenant.tenant_code || '').trim().slice(0, 64),
      payment.id,
      Number(payment.amount || 0),
      numOverpayment,
      payment.receipt_number || null,
      payment.mpesa_reference || null,
      payment.payment_date || new Date().toISOString().slice(0, 10),
    ]
  );
  return mapPendingOverpaymentRow(res.rows[0]);
}

async function getPendingOverpayment(id) {
  const res = await query(`SELECT * FROM pending_overpayments WHERE id = $1`, [id]);
  return res.rows[0] ? mapPendingOverpaymentRow(res.rows[0]) : null;
}

async function listPendingOverpayments(filters = {}) {
  const params = [];
  let q = `SELECT * FROM pending_overpayments WHERE 1=1`;
  if (filters.status) {
    params.push(filters.status);
    q += ` AND status = $${params.length}`;
  }
  q += ` ORDER BY created_at DESC, id DESC`;
  const res = await query(q, params);
  return res.rows.map(mapPendingOverpaymentRow);
}

/**
 * Skip / Resolve Later: approve (already done) and record the excess as a
 * Pending Overpayment Allocation so it is never silently ignored.
 */
async function skipOverpayment(paymentId, overpayment, actor) {
  const payment = await findPaymentById(paymentId);
  if (!payment) return null;
  const tenant = await getTenant(payment.tenant_id || payment.tenant_code);
  if (!tenant) return null;

  const numOverpayment = Number(overpayment) > 0
    ? Number(overpayment)
    : Number(payment.overpayment_amount || 0);
  if (!(numOverpayment > 0)) return null;

  const record = await createPendingOverpayment({ payment, tenant, overpayment: numOverpayment });
  await logAudit({
    actor,
    action: 'overpayment_skipped',
    entityType: 'tenant',
    entityId: tenant.tenant_code,
    details: { payment_id: payment.id, overpayment: numOverpayment },
  });
  return { record, tenant, payment };
}

/**
 * Resolve a pending overpayment record: Allocate to Advance Rent or Move to
 * Credit Balance. Auto-updates tenant balances so dashboards/statements/reports
 * reflect the resolution immediately.
 */
async function resolvePendingOverpayment(id, choice, months, actor) {
  const record = await getPendingOverpayment(id);
  if (!record) return null;
  if (record.status === 'Resolved') return { alreadyResolved: true, record };

  const tenant = await getTenant(record.tenant_code);
  if (!tenant) return null;

  let result;
  if (choice === 'advance_rent') {
    result = await allocateAdvanceRent(record.tenant_code, record.overpayment_amount, months);
  } else if (choice === 'credit_balance') {
    result = await allocateCreditBalance(record.tenant_code, record.overpayment_amount);
  } else {
    return null;
  }

  await query(
    `UPDATE pending_overpayments SET status = 'Resolved', resolution_type = $2, resolved_at = NOW(), resolved_by = $3, updated_at = NOW() WHERE id = $1`,
    [id, choice, actor || null]
  );

  await logAudit({
    actor,
    action: 'overpayment_resolved',
    entityType: 'tenant',
    entityId: record.tenant_code,
    details: { pending_id: id, payment_id: record.payment_id, choice, overpayment: record.overpayment_amount, months: months || null },
  });

  const updatedRecord = await getPendingOverpayment(id);
  return { record: updatedRecord, result, tenant };
}

/**
 * Record an action in the audit trail (e.g. overpayment resolution, credit apply).
 */
async function logAudit({ actor, action, entityType, entityId, details }) {
  await query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [actor ?? null, action, entityType ?? null, entityId ?? null, details != null ? JSON.stringify(details) : null]
  );
}

async function listAuditLog(entityType, entityId, limit = 100) {

  const params = [];
  let q = `SELECT * FROM audit_log WHERE 1=1`;
  if (entityType) {
    params.push(entityType);
    q += ` AND entity_type = $${params.length}`;
  }
  if (entityId) {
    params.push(entityId);
    q += ` AND entity_id = $${params.length}`;
  }
  params.push(limit);
  q += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  const res = await query(q, params);
  return res.rows;
}

// ===========================================================================
// DASHBOARD — single source of truth for the Rental Command Center.
// The metric counts/amounts and the drilldown lists a card opens share the
// exact same WHERE predicates (DASH below), so a card can never disagree with
// its own list. Everything is derived from rent records + due dates — never
// from the possibly-stale tenants.status column. All interpolated dates are
// server-generated ISO strings (never user input).
// ===========================================================================

const DASH_TODAY = () => new Date().toISOString().slice(0, 10);
const DASH_ADD_DAYS = (isoDate, days) => {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const DASH_MONTH_LABEL = (ym) => {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const [y, m] = String(ym).split('-');
  return `${months[Number(m) - 1] || ''} ${y}`;
};

// Units under a live RESERVED booking are not vacant — same rule the
// per-building dashboards apply (routes/houses.js).
const DASH_NOT_RESERVED = `
  NOT EXISTS (
    SELECT 1 FROM future_tenancies ft
    WHERE ft.status = 'RESERVED'
      AND ft.house_paybill = t.house_paybill_number
      AND LOWER(TRIM(COALESCE(ft.unit_label, ''))) <> ''
      AND LOWER(TRIM(COALESCE(ft.unit_label, ''))) = LOWER(TRIM(COALESCE(t.unit_label, t.tenant_code, '')))
  )`;

const DASH_UNIT_DISPLAY = `COALESCE(NULLIF(TRIM(t.unit_label), ''), t.tenant_code)`;

// Per-tenant balance components — mirrors the tenant-profile balance formula
// (routes/tenants.js GET /:id/profile): arrears + unpaid current rent +
// pending penalties + garbage/water shortfalls. Deposits, agreement fees,
// credit balances and advance rent are deliberately EXCLUDED — allocation
// rules keep them out of rent arrears.
const DASH_BALANCE_COMPONENTS = `
  t.arrears AS arrears_bf,
  GREATEST(0, t.rent_amount - t.rent_paid_this_month) AS unpaid_rent,
  (SELECT COALESCE(SUM(pen.amount), 0) FROM penalties pen
    WHERE pen.tenant_code = t.tenant_code AND pen.status = 'Pending') AS penalties_pending,
  GREATEST(0, t.garbage_fee_amount - t.garbage_fee_paid) AS garbage_due,
  GREATEST(0, t.water_charge_amount - t.water_charge_paid) AS water_due`;

const DASH = {
  occupied: `t.status <> 'Vacant'`,
  vacant: () => `t.status = 'Vacant' AND ${DASH_NOT_RESERVED}`,
  // Overdue = carried B/F arrears OR current-cycle rent still unpaid after
  // its due date. Partial payments shrink the overdue rent immediately; a
  // fully cleared balance (and no other overdue amount) drops the unit off.
  overdue: (today) => `t.status <> 'Vacant' AND (t.arrears > 0 OR (t.rent_paid_this_month < t.rent_amount AND t.rent_due_date < '${today}'))`,
  // Rent falling due in the next 7 days (today through +7) that is not fully paid.
  due7: (today, limit) => `t.status <> 'Vacant' AND t.rent_due_date >= '${today}' AND t.rent_due_date <= '${limit}' AND t.rent_paid_this_month < t.rent_amount`,
};

function dashBalanceOf(r) {
  return Number(r.arrears_bf || 0) + Number(r.unpaid_rent || 0) + Number(r.penalties_pending || 0) +
    Number(r.garbage_due || 0) + Number(r.water_due || 0);
}

// When did this account start being overdue? The current cycle's due date if
// it has already passed; otherwise the arrears came from the previous closed
// cycle (rollover advances rent_due_date one month at a time), so anchor one
// month back. Derived entirely from rent_due_date in the database.
function dashOverdueAnchor(dueDateIso, today) {
  if (!dueDateIso) return null;
  const due = String(dueDateIso).slice(0, 10);
  if (due <= today) return due;
  const d = new Date(due + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

function dashDaysBetween(fromIso, toIso) {
  if (!fromIso) return 0;
  return Math.max(0, Math.round((new Date(toIso + 'T12:00:00Z') - new Date(fromIso + 'T12:00:00Z')) / 86400000));
}

// ── House collection position ────────────────────────────────────────────────
// Overall financial collection performance of ONE house for a billing period,
// computed LIVE from the existing billing/invoice/payment records — nothing is
// stored or entered manually, so every charge edit and every payment
// (record/approve/delete/allocation) is reflected on the next request.
//
// EXPECTED = all legitimate charges raised for the period:
//   rent (current occupancies covering the period; mid-period joiners use
//   their recorded first-billing charge) + new-tenant deposits raised in the
//   period + water (metered invoices for the period, else flat monthly
//   charges) + garbage + penalties invoiced in the period + maintenance
//   (work-order costs) charged to the period + exit-invoice charges raised in
//   the period (final rent + deduction lines; carried-forward arrears from
//   earlier periods are deliberately excluded to avoid double counting).
//
// COLLECTED = every approved payment for the house in the period, regardless
//   of category — the SAME period predicate the Collection Report uses
//   (billing_period, with payment_date fallback for legacy rows).
async function getHouseCollectionPosition(houseId, period) {
  const labels = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const cur = new Date().toISOString().slice(0, 7);
  const p = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || '')) ? String(period) : cur;
  const [py, pm] = p.split('-').map(Number);
  const periodStart = `${p}-01`;
  const periodEnd = `${pm === 12 ? py + 1 : py}-${String(pm === 12 ? 1 : pm + 1).padStart(2, '0')}-01`; // exclusive

  // ── Expected: rent + garbage + flat water (occupancies covering period) ──
  const occ = await query(
    `SELECT rent_amount, garbage_fee_amount, water_charge_amount,
            move_in_date::text AS move_in_date, first_billing_method, first_billing_charge
       FROM tenants
      WHERE house_paybill_number = $1
        AND status <> 'Vacant'
        AND COALESCE(TRIM(name), '') <> ''
        AND (move_in_date IS NULL OR move_in_date < $2)`,
    [houseId, periodEnd]
  );
  let rentExpected = 0;
  let garbageExpected = 0;
  let flatWater = 0;
  for (const t of occ.rows) {
    const joinedInPeriod = t.move_in_date && String(t.move_in_date) >= periodStart && String(t.move_in_date) < periodEnd;
    if (joinedInPeriod && t.first_billing_method != null && t.first_billing_charge != null) {
      rentExpected += Number(t.first_billing_charge); // recorded prorated/waived first charge
    } else {
      rentExpected += Number(t.rent_amount || 0);
    }
    garbageExpected += Number(t.garbage_fee_amount || 0);
    flatWater += Number(t.water_charge_amount || 0);
  }

  // New-tenant deposits raised during the period (paid or not).
  const dep = await query(
    `SELECT COALESCE(SUM(deposit_amount), 0)::float8 AS total FROM tenants
      WHERE house_paybill_number = $1 AND move_in_date >= $2 AND move_in_date < $3`,
    [houseId, periodStart, periodEnd]
  );
  const depositsExpected = Number(dep.rows[0].total || 0);

  // Water: metered invoices raised for the period win; else flat monthly charges.
  const winv = await query(
    `SELECT COALESCE(SUM(total_amount), 0)::float8 AS total, COUNT(*)::int AS n
       FROM water_invoices WHERE house_paybill_number = $1 AND billing_month = $2`,
    [houseId, p]
  );
  const waterExpected = Number(winv.rows[0].n) > 0 ? Number(winv.rows[0].total) : flatWater;

  // Penalties invoiced during the period.
  const pen = await query(
    `SELECT COALESCE(SUM(pe.amount), 0)::float8 AS total
       FROM penalties pe JOIN tenants t ON t.tenant_code = pe.tenant_code
      WHERE t.house_paybill_number = $1 AND pe.invoice_date >= $2 AND pe.invoice_date < $3`,
    [houseId, periodStart, periodEnd]
  );
  const penaltiesExpected = Number(pen.rows[0].total || 0);

  // Maintenance (work-order costs) charged to the period.
  const mc = await query(
    `SELECT COALESCE(SUM(mc.total_cost), 0)::float8 AS total
       FROM maintenance_charges mc JOIN work_orders wo ON wo.id = mc.work_order_id
      WHERE wo.house_paybill_number = $1 AND mc.charge_month = $2`,
    [houseId, p]
  );
  const maintenanceExpected = Number(mc.rows[0].total || 0);

  // Exit invoices raised during the period: final rent charged + deduction
  // lines. Carried-forward arrears (outstanding_balance) is NOT counted —
  // it was raised in an earlier period.
  const ex = await query(
    `SELECT rent_charged_amount, lines FROM exit_invoices
      WHERE house_paybill_number = $1 AND move_out_date >= $2 AND move_out_date < $3`,
    [houseId, periodStart, periodEnd]
  );
  let exitRent = 0;
  let exitLines = 0;
  for (const e of ex.rows) {
    exitRent += Number(e.rent_charged_amount || 0);
    let lines = e.lines;
    try { if (typeof lines === 'string') lines = JSON.parse(lines); } catch (_) { lines = []; }
    for (const l of Array.isArray(lines) ? lines : []) exitLines += Number(l.amount || 0);
  }

  const expectedBy = {
    rent: Math.round(rentExpected),
    deposits: Math.round(depositsExpected),
    water: Math.round(waterExpected),
    garbage: Math.round(garbageExpected),
    penalties: Math.round(penaltiesExpected),
    maintenance: Math.round(maintenanceExpected),
    exit_charges: Math.round(exitRent + exitLines),
  };
  const expected = Object.values(expectedBy).reduce((s, v) => s + v, 0);

  // ── Collected: every approved payment in the period (any category) ──────
  // Same predicate as the Collection Report: billing_period first, with a
  // payment_date fallback for legacy rows that never got a billing period.
  const periodPredicate = `(p.billing_period = $2 OR (p.billing_period IS NULL AND p.payment_date >= $3 AND p.payment_date < $4))`;
  const col = await query(
    `SELECT COALESCE(SUM(p.amount), 0)::float8 AS total
       FROM payments p JOIN tenants t ON t.tenant_code = p.tenant_code
      WHERE t.house_paybill_number = $1 AND p.status = 'Approved'
        AND ${periodPredicate}`,
    [houseId, p, periodStart, periodEnd]
  );
  const collected = Number(col.rows[0].total || 0);

  const colByType = await query(
    `SELECT COALESCE(NULLIF(p.payment_type, ''), 'other') AS type, COALESCE(SUM(p.amount), 0)::float8 AS total
       FROM payments p JOIN tenants t ON t.tenant_code = p.tenant_code
      WHERE t.house_paybill_number = $1 AND p.status = 'Approved'
        AND ${periodPredicate}
      GROUP BY 1 ORDER BY 2 DESC`,
    [houseId, p, periodStart, periodEnd]
  );

  const remaining = expected - collected;
  const percent = expected > 0 ? Math.round((collected / expected) * 1000) / 10 : 0;

  return {
    period: p,
    period_label: `${labels[pm - 1]} ${py}`,
    expected,
    expected_by: expectedBy,
    collected,
    collected_by_type: colByType.rows.map((r) => ({ type: r.type, amount: Math.round(Number(r.total)) })),
    remaining,
    over_collected: remaining < 0,
    percent,
  };
}

async function getDashboardMetrics() {
  const today = DASH_TODAY();
  const monthStart = today.slice(0, 8) + '01';
  const due7Limit = DASH_ADD_DAYS(today, 7);
  const period = today.slice(0, 7);

  // One pass over tenants: every card count uses the shared DASH predicates.
  const tenantStats = await query(`
    SELECT
      COUNT(*) FILTER (WHERE t.status <> 'Vacant') AS total,
      COUNT(*) FILTER (WHERE t.status = 'Active') AS active,
      COUNT(*) FILTER (WHERE ${DASH.vacant()}) AS vacant,
      COUNT(*) FILTER (WHERE ${DASH.overdue(today)}) AS overdue,
      COUNT(*) FILTER (WHERE ${DASH.due7(today, due7Limit)}) AS due_7d
    FROM tenants t
  `);

  // Collected (MTD) / pending payments — single-table aggregates over
  // payments rows, so no join can duplicate a row. Approved payments are
  // counted exactly once at their recorded payment date.
  const paymentStats = await query(`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE status = 'Approved' AND payment_date >= $1), 0) AS revenue_mtd,
      COALESCE(SUM(amount) FILTER (WHERE status = 'Pending'), 0) AS pending_amount,
      COUNT(*) FILTER (WHERE status = 'Pending') AS pending_count,
      COUNT(*) FILTER (WHERE status = 'Approved') AS paid_count
    FROM payments
  `, [monthStart]);

  // Arrears + collection progress in one pass over occupied units.
  // Collection progress (per tenant's current billing cycle, the system's
  // billing convention = month of rent_due_date):
  //   expected   = SUM(rent_amount)
  //   collected  = SUM(LEAST(rent_amount, rent_paid_this_month))
  //   outstanding= expected - collected  (identically = SUM(GREATEST(0, ...)))
  //   percent    = collected / expected * 100
  const arrearsStats = await query(`
    SELECT
      COALESCE(SUM(t.arrears), 0) AS arrears_bf,
      COALESCE(SUM(GREATEST(0, t.rent_amount - t.rent_paid_this_month)), 0) AS unpaid_rent,
      COALESCE(SUM(GREATEST(0, t.garbage_fee_amount - t.garbage_fee_paid)), 0) AS garbage_shortfall,
      COALESCE(SUM(GREATEST(0, t.water_charge_amount - t.water_charge_paid)), 0) AS water_shortfall,
      COALESCE(SUM(t.rent_amount), 0) AS expected,
      COALESCE(SUM(LEAST(t.rent_amount, t.rent_paid_this_month)), 0) AS collected,
      COALESCE((SELECT SUM(pen.amount) FROM penalties pen
                JOIN tenants tp ON tp.tenant_code = pen.tenant_code
                WHERE pen.status = 'Pending' AND tp.status <> 'Vacant'), 0) AS penalties_pending
    FROM tenants t
    WHERE t.status <> 'Vacant'
  `);

  const msgStats = await query(`
    SELECT COUNT(*) AS messages_today
    FROM message_logs
    WHERE logged_at::date = $1::date
  `, [today]);

  const ts = tenantStats.rows[0];
  const ps = paymentStats.rows[0];
  const ms = msgStats.rows[0];
  const as = arrearsStats.rows[0];

  const arrearsBf = Number(as.arrears_bf);
  const unpaidRent = Number(as.unpaid_rent);
  const penaltiesPending = Number(as.penalties_pending);
  const garbageShortfall = Number(as.garbage_shortfall);
  const waterShortfall = Number(as.water_shortfall);
  // Total outstanding = rent arrears + applicable charges (penalties,
  // garbage, water) per the allocation rules — deposits, agreement fees,
  // credit and advance balances never enter this figure.
  const totalArrears = arrearsBf + unpaidRent + penaltiesPending + garbageShortfall + waterShortfall;

  const expected = Number(as.expected);
  const collected = Number(as.collected);
  const outstanding = expected - collected;
  const percent = expected > 0 ? Math.round((collected / expected) * 1000) / 10 : 0;

  return {
    tenants: {
      total_tenants: parseInt(ts.total, 10) || 0,
      active_tenants: parseInt(ts.active, 10) || 0,
      vacant_units: parseInt(ts.vacant, 10) || 0,
      overdue_tenants: parseInt(ts.overdue, 10) || 0,
      due_7d: parseInt(ts.due_7d, 10) || 0,
    },
    revenue: {
      revenue_mtd: Number(ps.revenue_mtd),
      pending_amount: Number(ps.pending_amount),
      pending_count: parseInt(ps.pending_count, 10) || 0,
      paid_count: parseInt(ps.paid_count, 10) || 0,
      total_arrears: totalArrears,
      arrears_breakdown: {
        arrears_bf: arrearsBf,
        unpaid_rent: unpaidRent,
        penalties: penaltiesPending,
        garbage: garbageShortfall,
        water: waterShortfall,
      },
    },
    collection: {
      period,
      period_label: DASH_MONTH_LABEL(period),
      expected,
      collected,
      outstanding,
      percent,
    },
    messages_today: parseInt(ms.messages_today, 10) || 0,
  };
}

// The list a dashboard card opens. Same predicates as getDashboardMetrics —
// the count on the card is always the row count (or the sum) returned here.
async function getDashboardDrilldown(kind) {
  const today = DASH_TODAY();
  const monthStart = today.slice(0, 8) + '01';
  const due7Limit = DASH_ADD_DAYS(today, 7);
  const period = today.slice(0, 7);
  const generatedAt = new Date().toISOString();

  if (kind === 'vacant') {
    const res = await query(`
      SELECT t.tenant_code, t.property_name, t.unit_label, t.house_paybill_number,
             ${DASH_UNIT_DISPLAY} AS unit_display
      FROM tenants t
      WHERE ${DASH.vacant()}
      ORDER BY t.property_name NULLS LAST, unit_display`);
    return {
      kind, generated_at: generatedAt,
      totals: { units: res.rows.length },
      rows: res.rows,
    };
  }

  if (kind === 'overdue') {
    const res = await query(`
      SELECT t.tenant_code, t.name, t.property_name, t.status,
             ${DASH_UNIT_DISPLAY} AS unit_display,
             t.rent_due_date::text AS rent_due_date,
             t.rent_amount, t.rent_paid_this_month,
             ${DASH_BALANCE_COMPONENTS}
      FROM tenants t
      WHERE ${DASH.overdue(today)}
      ORDER BY (t.arrears + GREATEST(0, t.rent_amount - t.rent_paid_this_month)) DESC,
               t.property_name NULLS LAST, t.name`);
    const rows = res.rows.map((r) => {
      const anchor = dashOverdueAnchor(r.rent_due_date, today);
      return {
        ...r,
        overdue_rent: Number(r.arrears_bf || 0) + Number(r.unpaid_rent || 0),
        outstanding_balance: dashBalanceOf(r),
        overdue_since: anchor,
        overdue_days: dashDaysBetween(anchor, today),
      };
    });
    return {
      kind, generated_at: generatedAt,
      totals: {
        units: rows.length,
        overdue_rent: rows.reduce((s, r) => s + r.overdue_rent, 0),
        outstanding: rows.reduce((s, r) => s + r.outstanding_balance, 0),
      },
      rows,
    };
  }

  if (kind === 'due7') {
    const res = await query(`
      SELECT t.tenant_code, t.name, t.property_name,
             ${DASH_UNIT_DISPLAY} AS unit_display,
             t.rent_due_date::text AS rent_due_date,
             t.rent_amount, t.rent_paid_this_month,
             GREATEST(0, t.rent_amount - t.rent_paid_this_month) AS amount_due
      FROM tenants t
      WHERE ${DASH.due7(today, due7Limit)}
      ORDER BY t.rent_due_date, t.property_name NULLS LAST, t.name`);
    return {
      kind, generated_at: generatedAt,
      totals: {
        units: res.rows.length,
        amount_due: res.rows.reduce((s, r) => s + Number(r.amount_due || 0), 0),
      },
      rows: res.rows,
    };
  }

  if (kind === 'pending') {
    // Unapproved payment records (payments.status = 'Pending'). Unpaid rent
    // obligations are NOT here — those live under Total Arrears (the system's
    // existing definitions: a record becomes Approved on approval, leaves the
    // list on approval or deletion).
    const res = await query(`
      SELECT p.id, p.amount AS paid_amount, p.payment_date::text AS payment_date,
             p.mpesa_reference, p.payment_type, p.notes, p.recorded_at::text AS recorded_at,
             t.tenant_code, t.name, t.property_name,
             ${DASH_UNIT_DISPLAY} AS unit_display,
             ${DASH_BALANCE_COMPONENTS}
      FROM payments p
      LEFT JOIN tenants t ON t.tenant_code = p.tenant_code
      WHERE p.status = 'Pending'
      ORDER BY p.recorded_at DESC NULLS LAST, p.id DESC`);
    const rows = res.rows.map((r) => {
      const expected = dashBalanceOf(r); // tenant obligation before approval
      const paid = Number(r.paid_amount || 0);
      return {
        ...r,
        expected_amount: expected,
        remaining_balance: Math.max(0, expected - paid),
      };
    });
    return {
      kind, generated_at: generatedAt,
      totals: {
        records: rows.length,
        pending_amount: rows.reduce((s, r) => s + Number(r.paid_amount || 0), 0),
      },
      rows,
    };
  }

  if (kind === 'arrears') {
    const res = await query(`
      SELECT t.tenant_code, t.name, t.property_name, t.status,
             ${DASH_UNIT_DISPLAY} AS unit_display,
             t.rent_due_date::text AS rent_due_date,
             t.rent_amount, t.rent_paid_this_month,
             ${DASH_BALANCE_COMPONENTS}
      FROM tenants t
      WHERE ${DASH.occupied}
      ORDER BY t.tenant_code`);
    // Rows are filtered to outstanding > 0 and sorted in JS by the same
    // balance formula the card totals use (sum of rows == card figure).
    const rows = res.rows
      .map((r) => ({ ...r, outstanding_balance: dashBalanceOf(r) }))
      .filter((r) => r.outstanding_balance > 0)
      .sort((a, b) => b.outstanding_balance - a.outstanding_balance);
    return {
      kind, generated_at: generatedAt,
      totals: {
        units: rows.length,
        arrears_bf: rows.reduce((s, r) => s + Number(r.arrears_bf || 0), 0),
        unpaid_rent: rows.reduce((s, r) => s + Number(r.unpaid_rent || 0), 0),
        penalties: rows.reduce((s, r) => s + Number(r.penalties_pending || 0), 0),
        garbage: rows.reduce((s, r) => s + Number(r.garbage_due || 0), 0),
        water: rows.reduce((s, r) => s + Number(r.water_due || 0), 0),
        outstanding: rows.reduce((s, r) => s + r.outstanding_balance, 0),
      },
      rows,
    };
  }

  if (kind === 'revenue') {
    const res = await query(`
      SELECT p.id, p.amount, p.payment_date::text AS payment_date, p.mpesa_reference,
             p.receipt_number, p.payment_type, p.payment_mode,
             t.tenant_code,
             CASE WHEN p.tenancy_id IS NOT NULL
                  THEN COALESCE(NULLIF(a.tenant_name, ''), t.name, t.tenant_code)
                  ELSE t.name END AS tenant_name,
             COALESCE(a.property_name, t.property_name) AS property_name,
             ${DASH_UNIT_DISPLAY} AS unit_display
      FROM payments p
      LEFT JOIN tenants t ON t.tenant_code = p.tenant_code
      LEFT JOIN tenancy_archive a ON a.id = p.tenancy_id
      WHERE p.status = 'Approved' AND p.payment_date >= '${monthStart}'
      ORDER BY p.payment_date DESC, p.id DESC`);
    return {
      kind, generated_at: generatedAt,
      totals: {
        records: res.rows.length,
        total: res.rows.reduce((s, r) => s + Number(r.amount || 0), 0),
      },
      rows: res.rows,
    };
  }

  if (kind === 'progress') {
    const res = await query(`
      SELECT t.tenant_code, t.name, t.property_name, t.status,
             ${DASH_UNIT_DISPLAY} AS unit_display,
             t.rent_due_date::text AS rent_due_date,
             t.rent_amount AS expected,
             LEAST(t.rent_amount, t.rent_paid_this_month) AS collected,
             GREATEST(0, t.rent_amount - t.rent_paid_this_month) AS outstanding
      FROM tenants t
      WHERE ${DASH.occupied}
      ORDER BY GREATEST(0, t.rent_amount - t.rent_paid_this_month) DESC,
               t.property_name NULLS LAST, t.name`);
    const expected = res.rows.reduce((s, r) => s + Number(r.expected || 0), 0);
    const collected = res.rows.reduce((s, r) => s + Number(r.collected || 0), 0);
    return {
      kind, generated_at: generatedAt,
      period,
      period_label: DASH_MONTH_LABEL(period),
      totals: {
        units: res.rows.length,
        expected,
        collected,
        outstanding: expected - collected,
        percent: expected > 0 ? Math.round((collected / expected) * 1000) / 10 : 0,
      },
      rows: res.rows,
    };
  }

  const err = new Error('Unknown dashboard drilldown: ' + kind);
  err.status = 400;
  throw err;
}

async function logMessage({ tenantId, messageType, messageBody, status, whatsappMessageId, failureReason, clientTxnId }) {
  const res = await query(
    `INSERT INTO message_logs (tenant_code, message_type, message_body, status, whatsapp_message_id, failure_reason, client_txn_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [tenantId ?? null, messageType, messageBody, status, whatsappMessageId ?? null, failureReason ?? null, clientTxnId || null]
  );
  return res.rows[0]?.id;
}

/**
 * Live WhatsApp delivery status for an approved payment's confirmation
 * message. The confirmation log carries the provider message id, and the
 * Baileys delivery-receipt callback upgrades message_logs.status to
 * Delivered/Read — this reads whatever that callback has confirmed so far.
 * Returns null when the payment or its confirmation log cannot be found.
 */
async function getPaymentDeliveryStatus(paymentId) {
  const pay = await query(
    `SELECT id, tenant_code, receipt_number, status FROM payments WHERE id = $1`,
    [paymentId]
  );
  const p = pay.rows[0];
  if (!p) return null;
  if (p.status !== 'Approved' || !p.receipt_number) {
    return { status: null, payment_status: p.status, reason: 'not_approved' };
  }
  // Both confirmation texts (direct send + queued template) contain the
  // receipt number — track the most recent one for this tenant.
  const msg = await query(
    `SELECT id, message_type, status, whatsapp_message_id, logged_at
       FROM message_logs
      WHERE tenant_code = $1
        AND message_body LIKE '%' || $2 || '%'
      ORDER BY id DESC
      LIMIT 1`,
    [p.tenant_code, p.receipt_number]
  );
  const row = msg.rows[0];
  if (!row) {
    return { status: null, payment_status: p.status, reason: 'confirmation_not_logged' };
  }
  return {
    status: row.status,
    message_id: row.id,
    message_type: row.message_type,
    whatsapp_message_id: row.whatsapp_message_id,
    logged_at: row.logged_at,
    payment_status: p.status,
  };
}

async function findMessageByClientTxnId(clientTxnId) {
  if (!clientTxnId) return null;
  const res = await query(
    `SELECT * FROM message_logs WHERE client_txn_id = $1 LIMIT 1`,
    [String(clientTxnId)]
  );
  return res.rows[0] || null;
}

async function updateMessageDelivery(whatsappMessageId, status, failureReason) {
  if (!whatsappMessageId) return;
  const fields = ['status = $2'];
  const values = [whatsappMessageId, status];
  if (failureReason != null) {
    fields.push('failure_reason = $3');
    values.push(failureReason);
  }
  await query(
    `UPDATE message_logs SET ${fields.join(', ')} WHERE whatsapp_message_id = $1`,
    values
  );
}

async function tenantsDueInDays(days) {
  const addDaysISO = (d) => {
    const date = new Date();
    date.setDate(date.getDate() + d);
    return date.toISOString().slice(0, 10);
  };
  const target = addDaysISO(days);
  const res = await query(
    `SELECT *, tenant_code AS id, house_paybill_number AS house_id, rent_due_date::text AS rent_due_date 
     FROM tenants 
     WHERE rent_due_date = $1 AND status IN ('Active', 'Overdue')`,
    [target]
  );
  return res.rows.map(r => ({ ...r, rent_amount: Number(r.rent_amount), arrears: Number(r.arrears || 0) }));
}

async function findTenantsForPaymentLookup({ phoneNumber, tenantCode, paybillNumber } = {}) {
  const conditions = [];
  const params = [];
  let index = 1;

  if (tenantCode) {
    conditions.push(`LOWER(t.tenant_code) = LOWER($${index++})`);
    params.push(String(tenantCode).trim());
  }

  if (phoneNumber) {
    const raw = String(phoneNumber).trim();
    const digits = raw.replace(/\D/g, '');
    const last9 = digits.slice(-9);
    const cands = new Set();
    if (digits) cands.add(digits);
    if (last9.length === 9) {
      cands.add(`254${last9}`);
      cands.add(`0${last9}`);
      cands.add(last9);
    }
    const candList = Array.from(cands).filter(Boolean);
    if (candList.length) {
      conditions.push(`REGEXP_REPLACE(t.phone_number, '[^0-9]', '', 'g') = ANY($${index++}::text[])`);
      params.push(candList);
    }
  }

  if (paybillNumber) {
    conditions.push(`LOWER(h.paybill_number) = LOWER($${index++})`);
    params.push(String(paybillNumber).trim());
  }

  if (!conditions.length) return [];

  const q = `
    SELECT
      t.*,
      t.tenant_code AS id,
      t.house_paybill_number AS house_id,
      t.rent_due_date::text AS rent_due_date,
      h.house_name AS linked_house_name,
      '' AS linked_house_number
    FROM tenants t
    LEFT JOIN houses h ON t.house_paybill_number = h.paybill_number
    WHERE ${conditions.join(' OR ')}
    ORDER BY t.name ASC
    LIMIT 15
  `;

  const res = await query(q, params);
  return res.rows.map((r) => ({ ...r, rent_amount: Number(r.rent_amount), arrears: Number(r.arrears || 0), deposit_amount: Number(r.deposit_amount || 0), deposit_paid: Number(r.deposit_paid || 0) }));
}

async function listTemplates() {
  const res = await query('SELECT * FROM message_templates ORDER BY name ASC');
  return res.rows;
}

async function getTemplate(id) {
  const res = await query('SELECT * FROM message_templates WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function createTemplate(data) {
  const res = await query(
    `INSERT INTO message_templates (key, name, body)
     VALUES ($1, $2, $3) RETURNING *`,
    [data.key || `custom_${Date.now()}`, data.name, data.body]
  );
  return res.rows[0];
}

async function updateTemplate(id, patch) {
  const fields = [];
  const values = [];
  let index = 1;
  
  for (const [key, val] of Object.entries(patch)) {
    if (key === 'id') continue;
    fields.push(`${key} = $${index++}`);
    values.push(val);
  }
  
  if (fields.length === 0) return getTemplate(id);
  
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const q = `UPDATE message_templates SET ${fields.join(', ')} WHERE id = $${index} RETURNING *`;
  const res = await query(q, values);
  return res.rows[0] || null;
}

async function deleteTemplate(id) {
  const res = await query('DELETE FROM message_templates WHERE id = $1', [id]);
  return res.rowCount > 0;
}

/**
 * Generate a billing-cycle collection report for a property.
 * Returns all tenants (sorted by unit code), each with:
 *   rent, balance B/F, current rent due, other charges, total expected,
 *   amount paid, receipt numbers, date paid, balance C/F, status
 * Plus summary totals and individual payment transactions.
 */
async function getPropertyCollectionReport(houseId, billingMonth) {
  const house = houseId ? await getHouse(houseId) : null;
  const propertyName = house ? house.house_name : 'All Properties';

  // Get all tenants for this property (including vacant)
  const tenantFilter = houseId ? { house_id: houseId, exclude_vacant: false } : { exclude_vacant: false };
  const allTenants = await listTenants(tenantFilter);

  // Sort by unit code (natural alphanumeric sort)
  allTenants.sort((a, b) => {
    const aCode = a.tenant_code || '';
    const bCode = b.tenant_code || '';
    return aCode.localeCompare(bCode, undefined, { numeric: true, sensitivity: 'base' });
  });

  // Get all approved payments for the billing month
  const monthStart = `${billingMonth}-01`;
  const d = new Date(`${billingMonth}-15T12:00:00`);
  d.setMonth(d.getMonth() + 1);
  const monthEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

  // Payments with billing_period matching (or payment_date in month for legacy)
  let payQ = `
    SELECT p.*, p.tenant_code AS tenant_id, p.payment_date::text AS payment_date,
           CASE WHEN p.tenancy_id IS NOT NULL
                THEN COALESCE(NULLIF(a.tenant_name, ''), t.name, p.tenant_code)
                ELSE t.name END AS tenant_name,
           t.tenant_code
    FROM payments p
    LEFT JOIN tenants t ON p.tenant_code = t.tenant_code
    LEFT JOIN tenancy_archive a ON a.id = p.tenancy_id
    WHERE p.status = 'Approved'
      AND (p.billing_period = $1 OR (p.billing_period IS NULL AND p.payment_date >= $2 AND p.payment_date < $3))
  `;
  const payParams = [billingMonth, monthStart, monthEnd];
  if (houseId) {
    payQ += ` AND t.house_paybill_number = $4`;
    payParams.push(houseId);
  }
  payQ += ` ORDER BY t.tenant_code, p.payment_date ASC`;
  const payRes = await query(payQ, payParams);
  const allPayments = payRes.rows;

  // Group payments by tenant
  const paymentsByTenant = {};
  for (const p of allPayments) {
    const tc = p.tenant_code;
    if (!paymentsByTenant[tc]) paymentsByTenant[tc] = [];
    paymentsByTenant[tc].push(p);
  }

  // Get penalties (other charges) for each tenant
  const penaltyRes = await query(
    `SELECT tenant_code, COALESCE(SUM(amount), 0) AS total
     FROM penalties WHERE status = 'Pending'
     ${houseId ? `AND tenant_code IN (SELECT tenant_code FROM tenants WHERE house_paybill_number = $1)` : ''}
     GROUP BY tenant_code`,
    houseId ? [houseId] : []
  );
  const penaltiesByTenant = {};
  for (const r of penaltyRes.rows) penaltiesByTenant[r.tenant_code] = Number(r.total || 0);

  // Get garbage shortfall
  const garbageRes = await query(
    `SELECT tenant_code,
            COALESCE(SUM(garbage_fee_amount - garbage_fee_paid), 0) AS total
     FROM tenants WHERE status != 'Vacant' AND garbage_fee_amount > garbage_fee_paid
     ${houseId ? `AND house_paybill_number = $1` : ''}
     GROUP BY tenant_code`,
    houseId ? [houseId] : []
  );
  const garbageByTenant = {};
  for (const r of garbageRes.rows) garbageByTenant[r.tenant_code] = Math.max(0, Number(r.total || 0));

  // Get water shortfall (same one-time charge semantics as the tenant
  // profile / statement balance — water must appear in the ledger too)
  const waterRes = await query(
    `SELECT tenant_code,
            COALESCE(SUM(water_charge_amount - water_charge_paid), 0) AS total
     FROM tenants WHERE status != 'Vacant' AND water_charge_amount > water_charge_paid
     ${houseId ? `AND house_paybill_number = $1` : ''}
     GROUP BY tenant_code`,
    houseId ? [houseId] : []
  );
  const waterByTenant = {};
  for (const r of waterRes.rows) waterByTenant[r.tenant_code] = Math.max(0, Number(r.total || 0));

  // Build rows
  const rows = [];
  const transactions = [];
  let totalUnits = 0;
  let totalExpectedRent = 0;
  let totalOtherCharges = 0;
  let totalExpected = 0;
  let totalCollected = 0;
  let totalOutstanding = 0;
  let totalOverpayment = 0;
  let countPaid = 0;
  let countPartial = 0;
  let countUnpaid = 0;
  let countOverpaid = 0;

  for (const t of allTenants) {
    totalUnits++;
    const tc = t.tenant_code;
    const rentAmount = Number(t.rent_amount || 0);
    const arrears = Number(t.arrears || 0);
    const otherCharges = (penaltiesByTenant[tc] || 0) + (garbageByTenant[tc] || 0) + (waterByTenant[tc] || 0);
    const totalExpectedForTenant = arrears + rentAmount + otherCharges;

    const tenantPayments = paymentsByTenant[tc] || [];
    // Deposit-type money is reported through its own deposit columns, never
    // against rent/charges — a deposit payment must not read as rent
    // collected (it produced phantom OVERPAID/CREDIT statuses). The full
    // payment list (receipts, references, transactions) is unchanged.
    const amountPaid = tenantPayments
      .filter(p => (p.payment_type || 'rent') !== 'deposit')
      .reduce((s, p) => s + Number(p.amount || 0), 0);
    const receiptNumbers = tenantPayments.map(p => p.receipt_number).filter(Boolean).join(', ') || '—';
    const mpesaReferences = tenantPayments.map(p => p.mpesa_reference).filter(Boolean).join(', ') || '—';
    const datesPaid = tenantPayments.map(p => p.payment_date).filter(Boolean).join(', ') || '—';

    const balanceCF = amountPaid - totalExpectedForTenant;
    let status = 'UNPAID';
    if (totalExpectedForTenant === 0 && amountPaid === 0) {
      status = '—';
    } else if (balanceCF === 0 && amountPaid > 0) {
      status = 'PAID';
      countPaid++;
    } else if (balanceCF > 0) {
      status = 'OVERPAID / CREDIT';
      countOverpaid++;
    } else if (amountPaid > 0) {
      status = 'PARTIALLY PAID';
      countPartial++;
    } else {
      countUnpaid++;
    }

    totalExpectedRent += rentAmount;
    totalOtherCharges += otherCharges;
    totalExpected += totalExpectedForTenant;
    totalCollected += amountPaid;
    if (balanceCF < 0) totalOutstanding += Math.abs(balanceCF);
    if (balanceCF > 0) totalOverpayment += balanceCF;

    rows.push({
      unit: tc,
      tenant_name: t.name || '',
      rent: rentAmount,
      balance_bf: arrears,
      current_rent_due: rentAmount,
      other_charges: otherCharges,
      total_expected: totalExpectedForTenant,
      amount_paid: amountPaid,
      mpesa_references: mpesaReferences,
      receipt_numbers: receiptNumbers,
      dates_paid: datesPaid,
      balance_cf: balanceCF,
      status,
    });

    // Add individual payment transactions
    for (const p of tenantPayments) {
      transactions.push({
        date: p.payment_date || '',
        unit: tc,
        tenant_name: t.name || '',
        amount: Number(p.amount || 0),
        mpesa_reference: p.mpesa_reference || '',
        receipt_number: p.receipt_number || '',
        billing_period: p.billing_period || billingMonth,
        payment_type: p.payment_type || 'rent',
      });
    }
  }

  const collectionPercentage = totalExpected > 0 ? ((totalCollected / totalExpected) * 100) : 0;

  return {
    property_name: propertyName,
    house_id: houseId,
    billing_month: billingMonth,
    generated_at: new Date().toISOString(),
    rows,
    transactions,
    summary: {
      total_units: totalUnits,
      total_expected_rent: totalExpectedRent,
      total_other_charges: totalOtherCharges,
      total_expected: totalExpected,
      total_collected: totalCollected,
      total_outstanding: totalOutstanding,
      total_overpayment: totalOverpayment,
      collection_percentage: collectionPercentage,
      count_paid: countPaid,
      count_partial: countPartial,
      count_unpaid: countUnpaid,
      count_overpaid: countOverpaid,
    },
  };
}

async function getOutstandingBalances(house_id) {
  // Canonical balance (same formula as the Tenant Profile, Payment History and
  // Statement): arrears + current-cycle rent shortfall + garbage + water +
  // pending invoices. Deposit stays its own reported column — it is recorded
  // in Deposit Paid and never folded into the balance.
  let q = `
    SELECT t.tenant_code, t.name, t.unit_label, t.rent_amount, t.arrears,
           t.rent_paid_this_month, t.deposit_amount, t.deposit_paid,
           t.garbage_fee_amount, t.garbage_fee_paid,
           t.water_charge_amount, t.water_charge_paid,
           COALESCE((
             SELECT SUM(p.amount) FROM penalties p
             WHERE p.tenant_code = t.tenant_code AND p.status = 'Pending'
           ), 0) AS penalties_outstanding,
           GREATEST(0, COALESCE(t.rent_amount, 0) - COALESCE(t.rent_paid_this_month, 0)) AS rent_due,
           GREATEST(0, COALESCE(t.garbage_fee_amount, 0) - COALESCE(t.garbage_fee_paid, 0)) AS garbage_due,
           GREATEST(0, COALESCE(t.water_charge_amount, 0) - COALESCE(t.water_charge_paid, 0)) AS water_due,
           (COALESCE(t.arrears, 0)
             + GREATEST(0, COALESCE(t.rent_amount, 0) - COALESCE(t.rent_paid_this_month, 0))
             + GREATEST(0, COALESCE(t.garbage_fee_amount, 0) - COALESCE(t.garbage_fee_paid, 0))
             + GREATEST(0, COALESCE(t.water_charge_amount, 0) - COALESCE(t.water_charge_paid, 0))
             + COALESCE((
                 SELECT SUM(p.amount) FROM penalties p
                 WHERE p.tenant_code = t.tenant_code AND p.status = 'Pending'
               ), 0)
           ) AS outstanding,
           h.house_name
    FROM tenants t
    LEFT JOIN houses h ON t.house_paybill_number = h.paybill_number
    WHERE t.status != 'Vacant'
      AND (COALESCE(t.arrears, 0) > 0
           OR COALESCE(t.rent_amount, 0) - COALESCE(t.rent_paid_this_month, 0) > 0
           OR COALESCE(t.garbage_fee_amount, 0) - COALESCE(t.garbage_fee_paid, 0) > 0
           OR COALESCE(t.water_charge_amount, 0) - COALESCE(t.water_charge_paid, 0) > 0
           OR COALESCE(t.deposit_amount, 0) - COALESCE(t.deposit_paid, 0) > 0
           OR EXISTS (
             SELECT 1 FROM penalties p
             WHERE p.tenant_code = t.tenant_code AND p.status = 'Pending'
           ))
  `;
  const params = [];
  if (house_id) {
    params.push(String(house_id));
    q += ` AND t.house_paybill_number = $${params.length}`;
  }
  q += ' ORDER BY h.house_name ASC, t.tenant_code ASC';
  const res = await query(q, params);
  return res.rows.map(r => ({
    ...r,
    arrears: Number(r.arrears || 0),
    rent_due: Number(r.rent_due || 0),
    garbage_due: Number(r.garbage_due || 0),
    water_due: Number(r.water_due || 0),
    deposit_amount: Number(r.deposit_amount || 0),
    deposit_paid: Number(r.deposit_paid || 0),
    garbage_fee_amount: Number(r.garbage_fee_amount || 0),
    garbage_fee_paid: Number(r.garbage_fee_paid || 0),
    water_charge_amount: Number(r.water_charge_amount || 0),
    water_charge_paid: Number(r.water_charge_paid || 0),
    rent_amount: Number(r.rent_amount || 0),
    rent_paid_this_month: Number(r.rent_paid_this_month || 0),
    penalties_outstanding: Number(r.penalties_outstanding || 0),
    outstanding: Number(r.outstanding || 0),
  }));
}

async function getUnpaidUnits(house_id) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  const monthStr = startOfMonth.toISOString().slice(0, 10);

  let q = `
    SELECT t.tenant_code, t.name, t.unit_label, t.rent_amount,
           h.house_name
    FROM tenants t
    LEFT JOIN houses h ON t.house_paybill_number = h.paybill_number
    WHERE t.status != 'Vacant'
      AND t.tenant_code NOT IN (
        SELECT p.tenant_code FROM payments p
        WHERE p.status = 'Approved'
          AND (p.payment_type IS NULL OR p.payment_type = 'rent')
          AND p.payment_date >= $1
      )
  `;
  const params = [monthStr];
  if (house_id) {
    params.push(String(house_id));
    q += ` AND t.house_paybill_number = $${params.length}`;
  }
  q += ' ORDER BY h.house_name ASC, t.tenant_code ASC';
  const res = await query(q, params);
  return res.rows.map(r => ({
    ...r,
    rent_amount: Number(r.rent_amount || 0),
  }));
}

async function getDepositsAndNewTenants(house_id, month) {
  const startOfMonth = (month ? month + '-01' : new Date().toISOString().slice(0, 7) + '-01').slice(0, 10);
  const endOfMonth = new Date(startOfMonth);
  endOfMonth.setMonth(endOfMonth.getMonth() + 1);
  const endStr = endOfMonth.toISOString().slice(0, 10);

  let depositQ = `
    SELECT p.tenant_code, p.amount, p.payment_date::text AS payment_date,
           t.name AS tenant_name, t.unit_label, h.house_name
    FROM payments p
    LEFT JOIN tenants t ON p.tenant_code = t.tenant_code
    LEFT JOIN houses h ON t.house_paybill_number = h.paybill_number
    WHERE p.status = 'Approved' AND p.payment_type = 'deposit'
      AND p.payment_date >= $1 AND p.payment_date < $2
  `;
  const depositParams = [startOfMonth, endStr];
  if (house_id) {
    depositParams.push(String(house_id));
    depositQ += ` AND t.house_paybill_number = $${depositParams.length}`;
  }
  depositQ += ' ORDER BY p.payment_date ASC';

  let tenantQ = `
    SELECT t.tenant_code, t.name, t.unit_label, t.created_at::text AS created_at,
           t.deposit_amount, h.house_name
    FROM tenants t
    LEFT JOIN houses h ON t.house_paybill_number = h.paybill_number
    WHERE t.status != 'Vacant'
      AND t.created_at >= $1 AND t.created_at < $2
  `;
  const tenantParams = [startOfMonth, endStr];
  if (house_id) {
    tenantParams.push(String(house_id));
    tenantQ += ` AND t.house_paybill_number = $${tenantParams.length}`;
  }
  tenantQ += ' ORDER BY t.created_at ASC';

  const [depositsRes, tenantsRes] = await Promise.all([
    query(depositQ, depositParams),
    query(tenantQ, tenantParams),
  ]);

  return {
    deposits: depositsRes.rows.map(r => ({ ...r, amount: Number(r.amount || 0), deposit_amount: Number(r.deposit_amount || 0) })),
    newTenants: tenantsRes.rows.map(r => ({ ...r, deposit_amount: Number(r.deposit_amount || 0) })),
  };
}

async function getAppConfig(key) {
  const res = await query('SELECT value FROM app_config WHERE key = $1', [key]);
  return res.rows[0] ? res.rows[0].value : null;
}

async function setAppConfig(key, value) {
  await query(
    `INSERT INTO app_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

async function getLastRolloverMonth() {
  return getAppConfig('last_rollover_month');
}

async function getLastRolloverAt() {
  return getAppConfig('last_rollover_at');
}

async function getLastReminderMonth() {
  return getAppConfig('last_reminder_month');
}

async function setLastReminderMonth(month) {
  await setAppConfig('last_reminder_month', month);
}

// Arbitrary but stable Postgres advisory-lock key: serializes all rollover runs
// so the scheduled job and a manual run can never process tenants concurrently.
const ROLLOVER_LOCK_KEY = 73310001;

async function rolloverMonth() {
  const client = await pool.connect();
  let acquired = false;
  try {
    const locked = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [ROLLOVER_LOCK_KEY]);
    acquired = locked.rows[0].ok;
    if (!acquired) {
      // Another rollover (auto or manual) is running right now — do not race it.
      return { skipped: true, reason: 'already_running' };
    }

    const results = await rolloverBody();

    // Reconcile all active tenants after rollover to ensure correct balances
    let reconciliation = { reconciled: 0, errors: [] };
    try {
      reconciliation = await reconcileAllTenants();
    } catch (err) {
      console.error('[Rollover] Tenant reconciliation failed:', err.message);
    }

    // Determine the month being closed (the month before the current one)
    const now = new Date();
    const closingDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const closingMonth = `${closingDate.getFullYear()}-${String(closingDate.getMonth() + 1).padStart(2, '0')}`;
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Auto-generate and close monthly reports for the closing month
    let reports = [];
    try {
      reports = await closeAllMonthlyReports(closingMonth);
    } catch (err) {
      console.error('[Rollover] Monthly report generation failed:', err.message);
    }

    await setAppConfig('last_rollover_month', currentMonth);
    await setAppConfig('last_rollover_at', now.toISOString());

    return { skipped: false, tenants_updated: results.length, details: results, reports_generated: reports.length, closing_month: closingMonth };
  } finally {
    if (acquired) {
      await client.query('SELECT pg_advisory_unlock($1)', [ROLLOVER_LOCK_KEY]).catch(() => {});
    }
    client.release();
  }
}

async function rolloverBody() {
  // Find all active tenants whose rent_due_date is in the past
  const today = new Date();
  const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);

  const overdue = await query(
    `SELECT tenant_code, rent_amount, arrears, rent_due_date::text AS rent_due_date, advance_rent_balance, advance_rent_until,
            standard_monthly_rent, first_billing_method, move_in_date::text AS move_in_date, arrears_manually_set,
            garbage_fee_amount
     FROM tenants
     WHERE status != 'Vacant' AND rent_due_date < $1`,
    [firstOfThisMonth]
  );

  const results = [];
  for (const t of overdue.rows) {
    const manuallySet = t.arrears_manually_set === true;
    let arrears = Number(t.arrears || 0);
    const rentAmount = Number(t.rent_amount || 0);
    const garbageRate = Number(t.garbage_fee_amount || 0);
    let garbageRolled = 0;
    let dueDate = new Date(t.rent_due_date + 'T12:00:00');
    let advanceRentBalance = Number(t.advance_rent_balance || 0);
    let advanceRentUntil = t.advance_rent_until || null;

    // advance_rent_until is the start of the last fully covered month (day 01)
    // OR a date inside the partially covered month (day > 01, covered by balance).
    const advancePrefix = advanceRentUntil ? String(advanceRentUntil).slice(0, 7) : null;
    const advanceDay = advanceRentUntil ? Number(String(advanceRentUntil).slice(8, 10)) : null;
    const isFullyCoveredMonth = (prefix) =>
      !!advancePrefix && (prefix < advancePrefix || (prefix === advancePrefix && advanceDay <= 1));

    // Get approved payments for this tenant (with allocation snapshots so only
    // the rent-directed portion of each payment counts toward its month —
    // deposit/arrears/penalty money must never close a rent month).
    const paymentsRes = await query(
      `SELECT amount, payment_date::text AS payment_date, billing_period, allocation_breakdown FROM payments WHERE tenant_code = $1 AND status = 'Approved' AND tenancy_id IS NULL`,
      [t.tenant_code]
    );
    const approvedPayments = paymentsRes.rows;
    // Garbage-directed portion per payment (same snapshot rule; legacy rows
    // without snapshots contribute 0 — bounded, flagged by design).
    const garbageDirected = (p) => {
      let bd = p.allocation_breakdown;
      try { if (typeof bd === 'string') bd = JSON.parse(bd); } catch (_) { bd = null; }
      if (bd && bd.garbageFeeSettled !== undefined && bd.garbageFeeSettled !== null) return Number(bd.garbageFeeSettled) || 0;
      return 0;
    };

    // Loop to catch up multiple missed months. Date-only comparison: a
    // datetime compare double-rolls when run on/after the 5th.
    let monthsRolled = 0;
    const todayISO = today.toISOString().slice(0, 10);

    // If arrears were manually set, skip recalculation — just advance the due date
    if (manuallySet) {
      while (dueDate.toISOString().slice(0, 10) < todayISO) {
        dueDate.setMonth(dueDate.getMonth() + 1);
        dueDate.setDate(5);
        monthsRolled++;
      }
    } else {
      while (dueDate.toISOString().slice(0, 10) < todayISO) {
        const monthPrefix = `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, '0')}`;
        const monthPaid = approvedPayments
          .filter(p => billingMonthOfPayment(p) === monthPrefix)
          .reduce((sum, p) => sum + rentDirectedAmount(p), 0);
        // Recurring monthly garbage: the month's garbage-directed payments
        // against the configured rate. Unpaid garbage rolls to B/F once per
        // closed month (never duplicated — same single-pass loop).
        const monthGarbagePaid = approvedPayments
          .filter(p => billingMonthOfPayment(p) === monthPrefix)
          .reduce((sum, p) => sum + garbageDirected(p), 0);

        if (monthPaid < rentAmount) {
          const shortfall = rentAmount - monthPaid;
          if (isFullyCoveredMonth(monthPrefix)) {
            // Month already covered by advance rent — no arrears generated.
          } else if (advanceRentBalance > 0) {
            const applied = Math.min(advanceRentBalance, shortfall);
            advanceRentBalance -= applied;
            arrears += (shortfall - applied);
          } else {
            arrears += shortfall;
          }
        }
        if (!isFullyCoveredMonth(monthPrefix) && garbageRate > 0) {
          const gShort = Math.max(0, garbageRate - monthGarbagePaid);
          arrears += gShort;
          garbageRolled += gShort;
        }

        dueDate.setMonth(dueDate.getMonth() + 1);
        dueDate.setDate(5);
        monthsRolled++;
      }
    }

    if (monthsRolled > 0) {
      const newDueDate = dueDate.toISOString().slice(0, 10);
      // Keep the advance "paid up to" marker while it still covers future months.
      const newAdvanceUntil =
        advanceRentBalance > 0 || (advanceRentUntil && String(advanceRentUntil).slice(0, 7) >= newDueDate.slice(0, 7))
          ? advanceRentUntil
          : null;
      const newStatus = arrears > 0 ? 'Overdue' : 'Active';

      // After the first billing cycle, restore the standard monthly rent.
      // The first_billing_charge was a one-time amount; subsequent months
      // must use standard_monthly_rent (the master recurring rent).
      let rentUpdate = '';
      let extraParams = [];
      const stdRent = Number(t.standard_monthly_rent || 0);
      if (stdRent > 0 && Number(t.rent_amount || 0) !== stdRent) {
        rentUpdate = `, rent_amount = $7`;
        extraParams = [stdRent];
      }

      await query(
        `UPDATE tenants SET arrears = $1, rent_due_date = $2, rent_paid_this_month = 0, garbage_fee_paid = 0, status = $6, advance_rent_balance = $4, advance_rent_until = $5, updated_at = NOW()${rentUpdate} WHERE tenant_code = $3`,
        [manuallySet ? Number(t.arrears || 0) : Math.max(0, arrears), newDueDate, t.tenant_code, advanceRentBalance, newAdvanceUntil, newStatus, ...extraParams]
      );
      results.push({
        tenant_code: t.tenant_code,
        months_missed: monthsRolled,
        new_arrears: manuallySet ? Number(t.arrears || 0) : Math.max(0, arrears),
        manually_preserved: manuallySet,
        new_due_date: newDueDate,
        garbage_rolled: garbageRolled,
        advance_rent_applied: Number(t.advance_rent_balance || 0) - advanceRentBalance,
        rent_restored: rentUpdate ? stdRent : null,
      });

      // Re-derive the tenant's position for the NEW cycle from complete
      // payment history (the reconciliation engine's documented contract:
      // called after approval, deletion, reversal AND rollover). This is what
      // keeps rent_paid_this_month / status / advance-covered balances correct
      // right after the rollover reset — never wipe manual arrears.
      try {
        await reconcileTenant(t.tenant_code);
      } catch (err) {
        console.error(`[Reconcile] Post-rollover reconciliation failed for ${t.tenant_code}:`, err.message);
      }
    }
  }

  return results;
}

async function listPenalties(tenantCode) {
  const res = await query(
    `SELECT * FROM penalties WHERE tenant_code = $1 AND tenancy_id IS NULL ORDER BY created_at DESC`,
    [tenantCode]
  );
  return res.rows.map(r => ({ ...r, amount: Number(r.amount) }));
}

async function getPenalty(id) {
  const res = await query('SELECT * FROM penalties WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function createPenalty(data) {
  const invoiceNumber = await generateInvoiceNumber();
  const category = data.category || 'penalty';
  const res = await query(
    `INSERT INTO penalties (tenant_code, description, amount, invoice_date, status, category, invoice_number)
     VALUES ($1, $2, $3, $4, 'Pending', $5, $6) RETURNING *`,
    [data.tenant_code, data.description, Number(data.amount), data.invoice_date || new Date().toISOString().slice(0, 10), category, invoiceNumber]
  );
  return { ...res.rows[0], amount: Number(res.rows[0].amount) };
}

async function payPenalty(id) {
  const res = await query(
    `UPDATE penalties SET status = 'Paid', paid_date = CURRENT_DATE, updated_at = NOW() WHERE id = $1 AND status = 'Pending' RETURNING *`,
    [id]
  );
  const penalty = res.rows[0];
  if (penalty) {
    // Also update linked maintenance charge recovery status
    query(
      `UPDATE maintenance_charges SET recovery_status = 'Paid', amount_recovered = total_cost, updated_at = NOW()
       WHERE penalty_id = $1 AND recovery_status != 'Paid'`,
      [id]
    ).catch(() => {});
  }
  return penalty || null;
}

async function deletePenalty(id) {
  const res = await query('DELETE FROM penalties WHERE id = $1', [id]);
  return res.rowCount > 0;
}

async function getOutstandingPenalties(tenantCode, category, run) {
  let q = `SELECT COALESCE(SUM(amount), 0) AS total FROM penalties WHERE tenant_code = $1 AND status = 'Pending' AND tenancy_id IS NULL`;
  const params = [tenantCode];
  if (category) {
    params.push(category);
    q += ` AND category = $${params.length}`;
  }
  const res = await runOrQuery(run, q, params);
  return Number(res.rows[0]?.total || 0);
}

async function listPendingPenalties(tenantCode, category, run) {
  let q = `SELECT * FROM penalties WHERE tenant_code = $1 AND status = 'Pending' AND tenancy_id IS NULL`;
  const params = [tenantCode];
  if (category) {
    params.push(category);
    q += ` AND category = $${params.length}`;
  }
  q += ' ORDER BY invoice_date ASC, created_at ASC';
  const res = await runOrQuery(run, q, params);
  return res.rows.map(r => ({ ...r, amount: Number(r.amount) }));
}

async function getTenantExitSummary(tenantCode) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;
  const pending = await listPendingPenalties(tenantCode);
  const rentAmount = Number(tenant.rent_amount || 0);
  const unpaidRent = Math.max(0, rentAmount - Number(tenant.rent_paid_this_month || 0));
  const garbageShortfall = Math.max(0, Number(tenant.garbage_fee_amount || 0) - Number(tenant.garbage_fee_paid || 0));
  const arrears = Number(tenant.arrears || 0);
  const categoryLabels = { penalty: 'Penalty', maintenance: 'Maintenance Charge', other: 'Other Charge' };
  const outstanding = [];
  if (arrears > 0) outstanding.push({ type: 'arrears', category: 'arrears', description: 'Opening Arrears / Balance Brought Forward', amount: arrears });
  if (unpaidRent > 0) outstanding.push({ type: 'rent', category: 'rent', description: 'Unpaid Rent (Current Month)', amount: unpaidRent });
  for (const p of pending) {
    const label = categoryLabels[p.category] || 'Invoice';
    outstanding.push({
      type: 'invoice',
      category: p.category || 'penalty',
      description: p.description || `${label}${p.invoice_number ? ` (${p.invoice_number})` : ''}`,
      invoice_number: p.invoice_number || null,
      amount: Number(p.amount || 0),
    });
  }
  if (garbageShortfall > 0) outstanding.push({ type: 'garbage', category: 'garbage', description: 'Garbage Collection Fee', amount: garbageShortfall });
  const outstandingTotal = outstanding.reduce((s, i) => s + i.amount, 0);
  const penaltiesTotal = outstanding.filter(i => i.type === 'invoice').reduce((s, i) => s + i.amount, 0);
  return {
    tenant: {
      id: tenant.tenant_code,
      tenant_code: tenant.tenant_code,
      name: tenant.name,
      phone_number: tenant.phone_number,
      property_name: tenant.property_name,
      unit_label: tenant.unit_label,
      rent_amount: rentAmount,
      status: tenant.status,
    },
    deposit: {
      amount: Number(tenant.deposit_amount || 0),
      paid: Number(tenant.deposit_paid || 0),
      balance: Math.max(0, Number(tenant.deposit_amount || 0) - Number(tenant.deposit_paid || 0)),
    },
    outstanding,
    totals: {
      arrears,
      unpaid_rent: unpaidRent,
      garbage_fee: garbageShortfall,
      penalties: penaltiesTotal,
      outstanding_total: outstandingTotal,
    },
  };
}

async function getTenantStatement(tenantCode) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;
  const house = tenant.house_id ? await getHouse(tenant.house_id) : null;

  const paymentsRes = await query(
    `SELECT p.*, p.payment_date::text AS payment_date
     FROM payments p
     WHERE p.tenant_code = $1 AND p.status = 'Approved' AND p.tenancy_id IS NULL
     ORDER BY p.payment_date ASC, p.id ASC`,
    [tenantCode]
  );
  const payments = paymentsRes.rows.map(r => ({ ...r, amount: Number(r.amount) }));

  const invoices = await listPenalties(tenantCode);
  const pendingInvoices = invoices.filter(i => i.status !== 'Paid');

  const rentAmount = Number(tenant.rent_amount || 0);
  const rentPaidThisMonth = Number(tenant.rent_paid_this_month || 0);
  const remainingRentForMonth = Math.max(0, rentAmount - rentPaidThisMonth);
  const arrears = Number(tenant.arrears || 0);
  const garbageFeeAmount = Number(tenant.garbage_fee_amount || 0);
  const garbageFeePaid = Number(tenant.garbage_fee_paid || 0);
  const garbageShortfall = Math.max(0, garbageFeeAmount - garbageFeePaid);
  const pendingChargesTotal = pendingInvoices.reduce((s, i) => s + Number(i.amount || 0), 0);
  const pendingPenalties = pendingInvoices.filter(i => (i.category || 'penalty') === 'penalty').reduce((s, i) => s + Number(i.amount || 0), 0);
  const pendingMaintenance = pendingInvoices.filter(i => i.category === 'maintenance').reduce((s, i) => s + Number(i.amount || 0), 0);
  const pendingOther = pendingInvoices.filter(i => i.category === 'other').reduce((s, i) => s + Number(i.amount || 0), 0);
  const depositAmount = Number(tenant.deposit_amount || 0);
  const depositPaid = Number(tenant.deposit_paid || 0);
  const waterChargeAmount = Number(tenant.water_charge_amount || 0);
  const waterChargePaid = Number(tenant.water_charge_paid || 0);
  const waterShortfall = Math.max(0, waterChargeAmount - waterChargePaid);
  const creditBalance = Number(tenant.credit_balance || 0);
  const advanceRentUntil = tenant.advance_rent_until || null;
  const advanceRentBalance = Number(tenant.advance_rent_balance || 0);

  const totalCharges = arrears + remainingRentForMonth + garbageShortfall + waterShortfall + pendingChargesTotal;
  const paymentsTotal = payments.reduce((s, p) => s + p.amount, 0);
  const outstandingBalance = Math.max(0, arrears + remainingRentForMonth + garbageShortfall + waterShortfall + pendingChargesTotal);

  return {
    tenant: {
      id: tenant.tenant_code,
      tenant_code: tenant.tenant_code,
      name: tenant.name,
      phone_number: tenant.phone_number,
      property_name: house ? house.house_name : (tenant.property_name || ''),
      unit_label: tenant.unit_label,
      rent_amount: rentAmount,
      move_in_date: tenant.move_in_date,
      rent_due_date: tenant.rent_due_date,
      status: tenant.status,
    },
    house: {
      paybill_number: house ? house.paybill_number : (tenant.house_id || null),
      house_name: house ? house.house_name : null,
      payment_instructions: getPaymentInstructionsText(house, tenant.tenant_code),
    },
    summary: {
      arrears,
      rent_amount: rentAmount,
      rent_paid_this_month: rentPaidThisMonth,
      remaining_rent_for_month: remainingRentForMonth,
      garbage_fee_amount: garbageFeeAmount,
      garbage_fee_paid: garbageFeePaid,
      garbage_fee_balance: garbageShortfall,
      water_charge_amount: waterChargeAmount,
      water_charge_paid: waterChargePaid,
      water_charge_balance: waterShortfall,
      pending_charges: pendingChargesTotal,
      penalty_pending: pendingPenalties,
      maintenance_pending: pendingMaintenance,
      other_charges_pending: pendingOther,
      total_charges: totalCharges,
      total_payments: paymentsTotal,
      outstanding_balance: outstandingBalance,
      deposit_amount: depositAmount,
      deposit_paid: depositPaid,
      deposit_balance: Math.max(0, depositAmount - depositPaid),
      credit_balance: creditBalance,
      advance_rent_until: advanceRentUntil,
      advance_rent_balance: advanceRentBalance,
    },
    payments,
    invoices,
  };
}

async function getRentInvoiceData(tenantCode, billingPeriod) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;
  const house = tenant.house_id ? await getHouse(tenant.house_id) : null;

  const now = new Date();
  const period = billingPeriod || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [yearStr, monthStr] = String(period).split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const periodLabel = new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const fromDate = `${year}-${String(month).padStart(2, '0')}-01`;
  // Last day of billing month, timezone-safe (avoids toISOString UTC offset)
  const toDateEnd = `${year}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;

  const pending = await listPendingPenalties(tenantCode);
  const pendingByCat = { penalty: [], maintenance: [], other: [] };
  for (const p of pending) {
    const cat = pendingByCat[p.category || 'other'] ? p.category || 'other' : 'other';
    pendingByCat[cat].push(p);
  }
  const sum = arr => arr.reduce((s, i) => s + Number(i.amount || 0), 0);

  const paymentsRes = await query(
    `SELECT p.*, p.payment_date::text AS payment_date
     FROM payments p
     WHERE p.tenant_code = $1 AND p.status = 'Approved' AND COALESCE(p.payment_type, 'rent') <> 'deposit'
       AND p.payment_date >= $2 AND p.payment_date <= $3
     ORDER BY p.payment_date ASC, p.id ASC`,
    [tenantCode, fromDate, toDateEnd]
  );
  const payments = paymentsRes.rows.map(r => ({ ...r, amount: Number(r.amount) }));
  const paymentsReceived = payments.reduce((s, p) => s + p.amount, 0);

  const rentAmount = Number(tenant.rent_amount || 0);
  const garbageShortfall = Math.max(0, Number(tenant.garbage_fee_amount || 0) - Number(tenant.garbage_fee_paid || 0));
  const waterShortfall = Math.max(0, Number(tenant.water_charge_amount || 0) - Number(tenant.water_charge_paid || 0));

  const openingBalance = Number(tenant.arrears || 0);
  const charges = {
    rent: rentAmount,
    garbage: garbageShortfall,
    water: waterShortfall,
    penalties: sum(pendingByCat.penalty),
    maintenance: sum(pendingByCat.maintenance),
    other: sum(pendingByCat.other),
  };
  charges.subtotal = charges.rent + charges.garbage + charges.water + charges.penalties + charges.maintenance + charges.other;

  const totalDue = openingBalance + charges.subtotal;
  const creditBalance = Number(tenant.credit_balance || 0);
  const advanceRent = Number(tenant.advance_rent_balance || 0);
  const appliedCredits = creditBalance + advanceRent;
  const rawBalance = totalDue - paymentsReceived - appliedCredits;
  const closingBalance = Math.max(0, rawBalance);
  const overpayment = Math.max(0, -rawBalance);

  return {
    tenant: {
      id: tenant.tenant_code,
      tenant_code: tenant.tenant_code,
      name: tenant.name,
      phone_number: tenant.phone_number,
      property_name: tenant.property_name,
      unit_label: tenant.unit_label,
      rent_amount: rentAmount,
      move_in_date: tenant.move_in_date,
      rent_due_date: tenant.rent_due_date,
      status: tenant.status,
    },
    house: {
      paybill_number: house ? house.paybill_number : (tenant.house_id || null),
      house_name: house ? house.house_name : null,
      payment_instructions: getPaymentInstructionsText(house, tenant.tenant_code),
    },
    billing: { period, period_label: periodLabel, from_date: fromDate, to_date: toDateEnd },
    opening_balance: openingBalance,
    charges,
    total_due: totalDue,
    payments_received: paymentsReceived,
    credit_balance: creditBalance,
    advance_rent: advanceRent,
    overpayment,
    closing_balance: closingBalance,
    payments,
    pending_items: pending,
  };
}

function normalizeMaterial(m, idx) {
  return {
    id: m.id || idx + 1,
    name: m.name || '',
    quantity: Number(m.quantity || 0),
    unit_cost: Number(m.unit_cost || 0),
    total: Number(m.total || 0) || (Number(m.quantity || 0) * Number(m.unit_cost || 0)),
    supplier: m.supplier || '',
    purchase_date: m.purchase_date || '',
    receipt_ref: m.receipt_ref || '',
  };
}

function normalizeWorkItems(items) {
  const list = Array.isArray(items) ? items : [];
  return list.map((it, idx) => {
    const materials = Array.isArray(it.materials) ? it.materials.map((m, mi) => normalizeMaterial(m, mi)) : [];
    const materialCost = materials.reduce((s, m) => s + Number(m.total || 0), 0) || Number(it.material_cost || 0);
    const labourCost = Number(it.labour_cost || 0);
    return {
      issue_no: it.issue_no || idx + 1,
      unit_code: it.unit_code || '',
      problem: it.problem || '',
      work_required: it.work_required || '',
      work_done: it.work_done || '',
      materials: materials,
      material_names: it.material_names || (materials.length ? materials.map(m => m.name).filter(Boolean).join(', ') : (typeof it.materials === 'string' ? it.materials : '')),
      responsible_party: it.responsible_party || 'Pending Assessment',
      mgmt_note: it.mgmt_note || '',
      trade: it.trade || '',
      payment_status: it.payment_status || 'Pending Assessment',
      status: it.status || 'Pending',
      labour_cost: labourCost,
      material_cost: materialCost,
      total_cost: labourCost + materialCost,
      amount_paid: Number(it.amount_paid || 0),
    };
  });
}

async function createWorkOrder(data) {
  if (data.client_txn_id) {
    const existing = await findRecordByClientTxnId('work_orders', data.client_txn_id);
    if (existing) return { ...existing, _idempotentReplay: true };
  }
  const woNumber = await generateWorkOrderNumber();
  const items = normalizeWorkItems(data.items);
  const totalCost = items.reduce((s, it) => s + Number(it.labour_cost || 0) + Number(it.material_cost || 0), 0);
  const res = await query(
    `INSERT INTO work_orders (
       wo_number, property_name, house_paybill_number, unit_codes, caretaker_name,
       date_requested, date_work_started, date_completed,
       technician_name, technician_phone, date_assigned, expected_completion,
       status, priority, items, actual_work_completed, materials_used, labour_involved, total_cost, notes,
       client_txn_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
    [
      woNumber,
      data.property_name || '',
      data.house_paybill_number || null,
      data.unit_codes || null,
      data.caretaker_name || null,
      data.date_requested || null,
      data.date_work_started || null,
      data.date_completed || null,
      data.technician_name || null,
      data.technician_phone || null,
      data.date_assigned || null,
      data.expected_completion || null,
      data.status || 'Pending',
      data.priority || 'Medium',
      JSON.stringify(items),
      data.actual_work_completed || null,
      data.materials_used || null,
      data.labour_involved || null,
      data.total_cost != null ? Number(data.total_cost) : totalCost,
      data.notes || null,
      data.client_txn_id || null,
    ]
  );
  return res.rows[0];
}

async function getWorkOrder(id) {
  const res = await query('SELECT * FROM work_orders WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function listWorkOrders({ status, limit = 100, offset = 0 } = {}) {
  const params = [];
  let q = 'SELECT * FROM work_orders';
  if (status) {
    params.push(status);
    q += ` WHERE status = $${params.length}`;
  }
  q += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
  params.push(Number(limit), Number(offset));
  const res = await query(q, params);
  return res.rows;
}

async function updateWorkOrder(id, data) {
  const existing = await getWorkOrder(id);
  if (!existing) return null;

  let items = existing.items;
  if (data.items) items = normalizeWorkItems(data.items);

  const labourTotal = Array.isArray(items)
    ? items.reduce((s, it) => s + Number(it.labour_cost || 0), 0)
    : Number(existing.labour_total || 0);

  let totalCost = Number(data.total_cost);
  if (!Number.isFinite(totalCost) || totalCost <= 0) {
    totalCost = labourTotal + (Array.isArray(items) ? items.reduce((s, it) => s + Number(it.material_cost || 0), 0) : Number(existing.material_total || 0));
  }

  const res = await query(
    `UPDATE work_orders SET
       property_name = COALESCE($2, property_name),
       house_paybill_number = COALESCE($3, house_paybill_number),
       unit_codes = COALESCE($4, unit_codes),
       caretaker_name = COALESCE($5, caretaker_name),
       date_requested = COALESCE($6, date_requested),
       date_work_started = COALESCE($7, date_work_started),
       date_completed = COALESCE($8, date_completed),
       technician_name = COALESCE($9, technician_name),
       technician_phone = COALESCE($10, technician_phone),
       date_assigned = COALESCE($11, date_assigned),
       expected_completion = COALESCE($12, expected_completion),
       status = COALESCE($13, status),
       priority = COALESCE($14, priority),
       items = $15,
       actual_work_completed = COALESCE($16, actual_work_completed),
       materials_used = COALESCE($17, materials_used),
       labour_involved = COALESCE($18, labour_involved),
       total_cost = COALESCE($19, total_cost),
       notes = COALESCE($20, notes),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      id,
      data.property_name, data.house_paybill_number, data.unit_codes, data.caretaker_name,
      data.date_requested, data.date_work_started, data.date_completed,
      data.technician_name, data.technician_phone, data.date_assigned, data.expected_completion,
      data.status, data.priority, JSON.stringify(items),
      data.actual_work_completed, data.materials_used, data.labour_involved, totalCost, data.notes,
    ]
  );
  return res.rows[0] || null;
}

async function deleteWorkOrder(id) {
  const res = await query('DELETE FROM work_orders WHERE id = $1', [id]);
  return res.rowCount > 0;
}

// ===========================================================================
// MAINTENANCE CHARGES & MONTHLY REPORTS
// ===========================================================================

/**
 * Create maintenance_charges records for every issue in a completed work order.
 * For tenant-responsible issues, also creates a penalty (category='maintenance')
 * on the tenant so it enters the payment allocation chain.
 */
async function createMaintenanceChargesFromWO(woId) {
  const wo = await getWorkOrder(woId);
  if (!wo) return [];
  const items = Array.isArray(wo.items) ? wo.items : [];
  if (!items.length) return [];

  const chargeMonth = wo.date_completed
    ? new Date(wo.date_completed).toISOString().slice(0, 7)
    : new Date().toISOString().slice(0, 7);

  const charges = [];
  for (const it of items) {
    const materialCost = Number(it.material_cost || 0);
    const labourCost = Number(it.labour_cost || 0);
    const totalCost = materialCost + labourCost;
    const party = it.responsible_party || 'Pending Assessment';
    const isTenant = party.toLowerCase().includes('tenant');

    // Look up tenant by unit_code (unit_code matches tenant_code)
    let tenantCode = null;
    let tenantName = null;
    if (it.unit_code) {
      const tenant = await getTenant(it.unit_code);
      if (tenant) {
        tenantCode = tenant.tenant_code;
        tenantName = tenant.name;
      }
    }

    let penaltyId = null;
    let recoveryStatus = 'Pending Assessment';
    let amountCharged = 0;

    if (isTenant && tenantCode && totalCost > 0) {
      // Create a maintenance-category penalty on the tenant
      const penalty = await query(
        `INSERT INTO penalties (tenant_code, amount, category, description, status, invoice_date)
         VALUES ($1, $2, 'maintenance', $3, 'Pending', CURRENT_DATE)
         RETURNING id`,
        [tenantCode, totalCost, `WO ${wo.wo_number} Issue ${it.issue_no}: ${it.problem || ''}`]
      );
      penaltyId = penalty.rows[0]?.id || null;
      recoveryStatus = 'Pending';
      amountCharged = totalCost;
    } else if (party.toLowerCase().includes('management') || party.toLowerCase().includes('owner')) {
      recoveryStatus = 'N/A';
    }

    const res = await query(
      `INSERT INTO maintenance_charges (
         work_order_id, wo_number, issue_no, unit_code, tenant_code, tenant_name,
         problem, repair_description, material_cost, labour_cost, total_cost,
         responsible_party, recovery_status, amount_charged, amount_recovered,
         penalty_id, charge_month
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        woId, wo.wo_number, it.issue_no || 0, it.unit_code || null,
        tenantCode, tenantName, it.problem || null, it.work_required || null,
        materialCost, labourCost, totalCost, party, recoveryStatus,
        amountCharged, 0, penaltyId, chargeMonth,
      ]
    );
    charges.push(res.rows[0]);
  }
  return charges;
}

/**
 * Update charge recovery when a payment settles the linked penalty.
 * Called from the payment approval flow when a maintenance penalty is paid.
 */
async function updateChargeRecovery(penaltyId, paymentId, receiptNumber, mpesaRef) {
  const chargeRes = await query(
    `SELECT * FROM maintenance_charges WHERE penalty_id = $1`, [penaltyId]
  );
  const charge = chargeRes.rows[0];
  if (!charge) return null;

  const penaltyRes = await query(`SELECT amount FROM penalties WHERE id = $1`, [penaltyId]);
  const penaltyAmount = Number(penaltyRes.rows[0]?.amount || 0);
  const newRecovered = Number(charge.amount_recovered || 0) + penaltyAmount;
  const newStatus = newRecovered >= Number(charge.total_cost) ? 'Paid' : 'Partially Recovered';

  const res = await query(
    `UPDATE maintenance_charges SET
       recovery_status = $2, amount_recovered = $3, payment_id = $4,
       receipt_number = $5, transaction_reference = $6, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [charge.id, newStatus, newRecovered, paymentId, receiptNumber || null, mpesaRef || null]
  );
  return res.rows[0];
}

/**
 * Build the monthly report data for a given month and property.
 * Aggregates revenue, maintenance expenses, tenant recovery and outstanding.
 */
async function buildMonthlyReportData(month, housePaybill) {
  const monthStart = `${month}-01`;
  const d = new Date(`${month}-15T12:00:00`);
  d.setMonth(d.getMonth() + 1);
  const monthEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

  // Revenue: approved payments in this month
  let revenueQ = `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*)::int AS count FROM payments WHERE status = 'Approved' AND payment_date >= $1 AND payment_date < $2`;
  const revenueParams = [monthStart, monthEnd];
  if (housePaybill) {
    revenueQ += ` AND tenant_code IN (SELECT tenant_code FROM tenants WHERE house_paybill_number = $3)`;
    revenueParams.push(housePaybill);
  }
  const revenueRes = await query(revenueQ, revenueParams);
  const totalRevenue = Number(revenueRes.rows[0]?.total || 0);
  const paymentCount = revenueRes.rows[0]?.count || 0;

  // Deposits collected this month
  let depositQ = `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'Approved' AND payment_type = 'deposit' AND payment_date >= $1 AND payment_date < $2`;
  const depositParams = [monthStart, monthEnd];
  if (housePaybill) {
    depositQ += ` AND tenant_code IN (SELECT tenant_code FROM tenants WHERE house_paybill_number = $3)`;
    depositParams.push(housePaybill);
  }
  const depositRes = await query(depositQ, depositParams);
  const totalDeposits = Number(depositRes.rows[0]?.total || 0);

  // Deposit applications (deposit used for rent) this month
  let daQ = `SELECT COALESCE(SUM(amount_applied), 0) AS total, COALESCE(SUM(rent_loss_amount), 0) AS losses FROM deposit_applications WHERE billing_period = $1 AND status = 'Active'`;
  const daParams = [month];
  if (housePaybill) {
    daQ += ` AND house_paybill_number = $2`;
    daParams.push(housePaybill);
  }
  const daRes = await query(daQ, daParams);
  const totalDepositApplied = Number(daRes.rows[0]?.total || 0);
  const totalRentLoss = Number(daRes.rows[0]?.losses || 0);

  // Total expected rent for this month (sum of rent_amount for active tenants)
  let expectedQ = `SELECT COALESCE(SUM(rent_amount), 0) AS total FROM tenants WHERE status != 'Vacant'`;
  const expectedParams = [];
  if (housePaybill) {
    expectedQ += ` AND house_paybill_number = $1`;
    expectedParams.push(housePaybill);
  }
  const expectedRes = await query(expectedQ, expectedParams);
  const totalExpectedRent = Number(expectedRes.rows[0]?.total || 0);

  // Maintenance charges for this month — exclude orphaned charges (deleted work orders)
  let mcQ = `SELECT mc.* FROM maintenance_charges mc LEFT JOIN work_orders wo ON mc.work_order_id = wo.id WHERE mc.charge_month = $1 AND wo.id IS NOT NULL`;
  const mcParams = [month];
  if (housePaybill) {
    mcQ = `SELECT mc.* FROM maintenance_charges mc JOIN work_orders wo ON mc.work_order_id = wo.id WHERE mc.charge_month = $1 AND wo.house_paybill_number = $2`;
    mcParams.push(housePaybill);
  }
  const mcRes = await query(mcQ, mcParams);
  const allCharges = mcRes.rows;

  const mgmtExpenses = allCharges.filter(c => {
    const p = String(c.responsible_party || '').toLowerCase();
    return p.includes('management') || p.includes('owner');
  });
  const tenantCharges = allCharges.filter(c => {
    const p = String(c.responsible_party || '').toLowerCase();
    return p.includes('tenant');
  });

  const totalMaterialCosts = allCharges.reduce((s, c) => s + Number(c.material_cost || 0), 0);
  const totalLabourCosts = allCharges.reduce((s, c) => s + Number(c.labour_cost || 0), 0);
  const totalMaintenanceExpenses = allCharges.reduce((s, c) => s + Number(c.total_cost || 0), 0);
  const totalMgmtPaid = mgmtExpenses.reduce((s, c) => s + Number(c.total_cost || 0), 0);
  const totalTenantResponsible = tenantCharges.reduce((s, c) => s + Number(c.total_cost || 0), 0);
  const totalRecovered = tenantCharges.reduce((s, c) => s + Number(c.amount_recovered || 0), 0);
  const totalOutstanding = totalTenantResponsible - totalRecovered;

  // Maintenance charges raised (penalties created) and paid this month
  const chargesRaised = allCharges.reduce((s, c) => s + Number(c.amount_charged || 0), 0);
  const chargesPaid = allCharges.reduce((s, c) => s + Number(c.amount_recovered || 0), 0);

  // Work order details — skip deleted work orders
  const woDetails = [];
  const woIds = [...new Set(allCharges.map(c => c.work_order_id))];
  for (const woId of woIds) {
    const wo = await getWorkOrder(woId);
    if (!wo) continue;
    const woCharges = allCharges.filter(c => c.work_order_id === woId);
    woDetails.push({
      wo_number: wo.wo_number,
      property_name: wo.property_name,
      technician_name: wo.technician_name,
      date_completed: wo.date_completed,
      issues: woCharges.map(c => ({
        issue_no: c.issue_no, unit_code: c.unit_code, tenant_code: c.tenant_code,
        tenant_name: c.tenant_name, problem: c.problem, repair: c.repair_description,
        material_cost: Number(c.material_cost), labour_cost: Number(c.labour_cost),
        total_cost: Number(c.total_cost), responsible_party: c.responsible_party,
        recovery_status: c.recovery_status, amount_charged: Number(c.amount_charged),
        amount_recovered: Number(c.amount_recovered),
      })),
    });
  }

  // Occupancy stats
  let occQ = `SELECT
    COUNT(*) FILTER (WHERE status != 'Vacant') AS occupied,
    COUNT(*) FILTER (WHERE status = 'Vacant') AS vacant,
    COUNT(*) FILTER (WHERE move_in_date >= $1 AND move_in_date < $2) AS new_tenants,
    COUNT(*) FILTER (WHERE notice_to_vacate_date IS NOT NULL AND notice_to_vacate_date >= $1 AND notice_to_vacate_date < $2) AS exiting_tenants
    FROM tenants`;
  const occParams = [monthStart, monthEnd];
  if (housePaybill) {
    occQ += ` WHERE house_paybill_number = $3`;
    occParams.push(housePaybill);
  }
  const occRes = await query(occQ, occParams);
  const or = occRes.rows[0] || {};
  const occ = { occupied: Number(or.occupied || 0), vacant: Number(or.vacant || 0), new_tenants: Number(or.new_tenants || 0), exiting_tenants: Number(or.exiting_tenants || 0) };

  // Collection stats (paid / partial / unpaid)
  let colQ = `SELECT
    COUNT(*) FILTER (WHERE rent_paid_this_month >= rent_amount) AS paid,
    COUNT(*) FILTER (WHERE rent_paid_this_month > 0 AND rent_paid_this_month < rent_amount) AS partial,
    COUNT(*) FILTER (WHERE rent_paid_this_month = 0 OR rent_paid_this_month IS NULL) AS unpaid
    FROM tenants WHERE status != 'Vacant'`;
  const colParams = [];
  if (housePaybill) {
    colQ += ` AND house_paybill_number = $1`;
    colParams.push(housePaybill);
  }
  const colRes = await query(colQ, colParams);
  const cr = colRes.rows[0] || {};
  const col = { paid: Number(cr.paid || 0), partial: Number(cr.partial || 0), unpaid: Number(cr.unpaid || 0) };
  const totalActive = Number(col.paid || 0) + Number(col.partial || 0) + Number(col.unpaid || 0);
  const collectionPct = totalActive > 0 ? Math.round((Number(col.paid || 0) / totalActive) * 100) : 0;

  // Penalties for this month
  let penQ = `SELECT p.*, t.name AS tenant_name FROM penalties p LEFT JOIN tenants t ON p.tenant_code = t.tenant_code WHERE p.created_at >= $1 AND p.created_at < $2`;
  const penParams = [monthStart, monthEnd];
  if (housePaybill) {
    penQ += ` AND p.tenant_code IN (SELECT tenant_code FROM tenants WHERE house_paybill_number = $3)`;
    penParams.push(housePaybill);
  }
  penQ += ` ORDER BY p.created_at DESC`;
  const penRes = await query(penQ, penParams);
  const penalties = penRes.rows.map(p => ({
    tenant_name: p.tenant_name, description: p.description, category: p.category,
    amount: Number(p.amount || 0), status: p.status,
  }));

  // Exit invoices finalized this month
  let exitQ = `SELECT ei.*, t.name AS tenant_name FROM exit_invoices ei LEFT JOIN tenants t ON ei.tenant_code = t.tenant_code WHERE ei.finalized_at >= $1 AND ei.finalized_at < $2`;
  const exitParams = [monthStart, monthEnd];
  if (housePaybill) {
    exitQ += ` AND ei.house_paybill_number = $3`;
    exitParams.push(housePaybill);
  }
  exitQ += ` ORDER BY ei.finalized_at DESC`;
  const exitRes = await query(exitQ, exitParams);
  const exitInvoices = exitRes.rows.map(e => ({
    exit_number: e.exit_number, tenant_name: e.tenant_name, unit_label: e.unit_label,
    rent_treatment: e.rent_treatment, deductions_total: Number(e.deductions_total || 0),
    deposit_refund: Number(e.deposit_refund || 0), final_settlement: Number(e.final_settlement || 0),
    status: e.status,
  }));

  // Notices to vacate given this month
  let noticeQ = `SELECT name AS tenant_name, tenant_code, notice_to_vacate_date::text AS notice_date, move_out_date::text AS expected_vacate, status FROM tenants WHERE notice_to_vacate_date >= $1 AND notice_to_vacate_date < $2`;
  const noticeParams = [monthStart, monthEnd];
  if (housePaybill) {
    noticeQ += ` AND house_paybill_number = $3`;
    noticeParams.push(housePaybill);
  }
  noticeQ += ` ORDER BY notice_to_vacate_date DESC`;
  const noticeRes = await query(noticeQ, noticeParams);
  const noticesToVacate = noticeRes.rows;

  return {
    period: month,
    revenue: { total_collected: totalRevenue, payment_count: paymentCount, deposits_collected: totalDeposits },
    rent_reconciliation: {
      expected_rent: totalExpectedRent,
      cash_collected: totalRevenue,
      deposit_applied: totalDepositApplied,
      rent_loss: totalRentLoss,
      outstanding_recoverable: Math.max(0, totalExpectedRent - totalRevenue - totalDepositApplied - totalRentLoss),
    },
    maintenance: {
      total_expenses: totalMaintenanceExpenses,
      total_material_costs: totalMaterialCosts,
      total_labour_costs: totalLabourCosts,
      management_paid_repairs: totalMgmtPaid,
      tenant_responsible_repairs: totalTenantResponsible,
      recovered_from_tenants: totalRecovered,
      outstanding_recovery: totalOutstanding,
      charges_raised: chargesRaised,
      charges_paid: chargesPaid,
    },
    management_expenses: mgmtExpenses.map(c => ({
      wo_number: c.wo_number, issue_no: c.issue_no, unit: c.unit_code,
      problem: c.problem, repair: c.repair_description,
      material_cost: Number(c.material_cost), labour_cost: Number(c.labour_cost),
      total_cost: Number(c.total_cost), responsible_party: c.responsible_party,
      technician_paid: c.technician_paid,
    })),
    tenant_recoveries: tenantCharges.map(c => ({
      wo_number: c.wo_number, issue_no: c.issue_no, unit: c.unit_code,
      tenant: c.tenant_name, tenant_code: c.tenant_code, problem: c.problem,
      repair: c.repair_description, total_cost: Number(c.total_cost),
      amount_charged: Number(c.amount_charged), amount_recovered: Number(c.amount_recovered),
      recovery_status: c.recovery_status,
    })),
    work_orders: woDetails,
    occupancy: {
      occupied: Number(occ.occupied || 0),
      vacant: Number(occ.vacant || 0),
      new_tenants: Number(occ.new_tenants || 0),
      exiting_tenants: Number(occ.exiting_tenants || 0),
      paid_count: Number(col.paid || 0),
      partial_count: Number(col.partial || 0),
      unpaid_count: Number(col.unpaid || 0),
      collection_pct: collectionPct,
    },
    penalties,
    exit_invoices: exitInvoices,
    notices_to_vacate: noticesToVacate,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Generate (or update) the monthly report for a given month + property.
 * Saves a snapshot in monthly_reports that can be viewed/downloaded later.
 */
async function generateMonthlyReport(month, housePaybill) {
  const data = await buildMonthlyReportData(month, housePaybill);
  const propertyName = housePaybill
    ? (await getHouse(housePaybill))?.house_name || null
    : null;

  // Delete any existing row first (handles NULL house_paybill_number since NULL != NULL in UNIQUE)
  await query(
    `DELETE FROM monthly_reports WHERE month = $1 AND (house_paybill_number = $2 OR ($2 IS NULL AND house_paybill_number IS NULL))`,
    [month, housePaybill || null]
  );

  const res = await query(
    `INSERT INTO monthly_reports (month, property_name, house_paybill_number, status, report_data, updated_at)
     VALUES ($1, $2, $3, 'Active', $4, NOW())
     RETURNING *`,
    [month, propertyName, housePaybill || null, JSON.stringify(data, (_, v) => typeof v === 'bigint' ? Number(v) : v)]
  );
  return res.rows[0];
}

/**
 * Close a monthly report — it becomes a permanent archived snapshot.
 */
async function closeMonthlyReport(month, housePaybill) {
  const res = await query(
    `UPDATE monthly_reports SET status = 'Closed', closed_at = NOW(), updated_at = NOW()
     WHERE id = (
       SELECT id FROM monthly_reports WHERE month = $1 AND (house_paybill_number = $2 OR ($2 IS NULL AND house_paybill_number IS NULL))
       ORDER BY generated_at DESC LIMIT 1
     )
     RETURNING *`,
    [month, housePaybill || null]
  );
  return res.rows[0];
}

async function listMonthlyReports() {
  const res = await query(
    `SELECT id, month, property_name, house_paybill_number, status, generated_at, closed_at
     FROM monthly_reports ORDER BY month DESC, property_name ASC`
  );
  return res.rows;
}

async function getMonthlyReport(month, housePaybill) {
  const res = await query(
    `SELECT * FROM monthly_reports WHERE month = $1 AND (house_paybill_number = $2 OR ($2 IS NULL AND house_paybill_number IS NULL))
     ORDER BY generated_at DESC LIMIT 1`,
    [month, housePaybill || null]
  );
  return res.rows[0] || null;
}

/**
 * Build the enhanced monthly report data — unit-by-unit financial table,
 * work/maintenance summary, invoices issued, and monthly summary totals.
 */

// ─── Landlord pack (read-only aggregations for the enhanced Excel) ─────────
// Everything here only READS existing records. No workflow is touched.

function parseAllocation(row) {
  try {
    const a = row.allocation_breakdown;
    if (!a) return null;
    return typeof a === 'string' ? JSON.parse(a) : a;
  } catch (_) {
    return null;
  }
}

// Collections for a billing period, split by allocation component.
// Payments approved before allocation persistence fall back to full-rent.
async function getPeriodCollections(month, housePaybill = null) {
  const params = [month];
  let houseFilter = '';
  if (housePaybill) {
    houseFilter = ' AND t.house_paybill_number = $2';
    params.push(housePaybill);
  }
  const res = await query(
    `SELECT p.id, p.amount, p.payment_type, p.allocation_breakdown,
            t.tenant_code, t.name AS tenant_name, t.unit_label,
            t.house_paybill_number, h.house_name AS property_name
     FROM payments p
     JOIN tenants t ON t.tenant_code = p.tenant_code
     LEFT JOIN houses h ON h.paybill_number = t.house_paybill_number
     WHERE p.status = 'Approved' AND p.billing_period = $1${houseFilter}
     ORDER BY p.approved_at`,
    params
  );
  const zero = () => ({ collected: 0, rent: 0, arrears: 0, deposit: 0, garbage: 0, water: 0, penalty: 0, maintenance: 0, other: 0, agreement: 0, count: 0 });
  const totals = zero();
  const byTenant = {};
  for (const p of res.rows) {
    const amount = Number(p.amount || 0);
    const alloc = parseAllocation(p);
    const split = p.payment_type === 'deposit'
      ? { deposit: amount }
      : alloc
        ? {
            rent: Number(alloc.rentSettled || 0),
            arrears: Number(alloc.arrearsSettled || 0),
            deposit: Number(alloc.depositSettled || 0),
            garbage: Number(alloc.garbageFeeSettled || 0),
            water: Number(alloc.waterSettled || 0),
            penalty: Number(alloc.penaltySettled || 0),
            maintenance: Number(alloc.maintenanceSettled || 0),
            other: Number(alloc.otherSettled || 0),
            agreement: Number(alloc.agreementSettled || 0),
          }
        : { rent: amount };
    const entry = { collected: amount, rent: 0, arrears: 0, deposit: 0, garbage: 0, water: 0, penalty: 0, maintenance: 0, other: 0, agreement: 0, count: 1 };
    for (const k of ['rent', 'arrears', 'deposit', 'garbage', 'water', 'penalty', 'maintenance', 'other', 'agreement']) {
      entry[k] = Number(split[k] || 0);
      totals[k] += entry[k];
    }
    totals.collected += amount;
    const code = p.tenant_code;
    if (!byTenant[code]) {
      byTenant[code] = { ...zero(), tenant_code: code, tenant_name: p.tenant_name || '', unit_label: p.unit_label || '', property_name: p.property_name || '' };
    }
    const bt = byTenant[code];
    bt.collected += amount;
    bt.count += 1;
    for (const k of ['rent', 'arrears', 'deposit', 'garbage', 'water', 'penalty', 'maintenance', 'other', 'agreement']) {
      bt[k] += entry[k];
    }
  }
  return { totals, byTenant };
}

// Other property expenses = contractor/material/repair invoices recorded in
// the calendar month, EXCLUDING work-order-sourced ones (those already count
// under work-order expenses via the WO Source convention).
async function getOtherPropertyExpenses(month, housePaybill = null) {
  const monthStart = `${month}-01`;
  const d = new Date(`${month}-15T12:00:00`);
  d.setMonth(d.getMonth() + 1);
  const monthEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  const res = await query(
    `SELECT id, mnt_number, property_name, house_paybill_number, date_reported,
            status, grand_total, notes, created_at
     FROM maintenance_invoices
     WHERE created_at >= $1 AND created_at < $2
     ORDER BY created_at`,
    [monthStart, monthEnd]
  );
  let houseName = null;
  if (housePaybill) {
    const h = await getHouse(housePaybill);
    houseName = h ? String(h.house_name || '').toLowerCase() : null;
  }
  const rows = [];
  for (const r of res.rows) {
    if (housePaybill) {
      const matchPaybill = r.house_paybill_number && String(r.house_paybill_number) === String(housePaybill);
      const matchName = houseName && String(r.property_name || '').toLowerCase() === houseName;
      if (!matchPaybill && !matchName) continue;
    }
    if (/^\s*WO Source:/i.test(String(r.notes || ''))) continue;
    rows.push({
      id: r.id,
      mnt_number: r.mnt_number,
      property_name: r.property_name || '',
      date_reported: r.date_reported || null,
      status: r.status || '',
      amount: Number(r.grand_total || 0),
      notes: r.notes || '',
    });
  }
  return { rows, total: rows.reduce((s, r) => s + r.amount, 0) };
}

// Pending tenant penalties + agreement balances (current obligations).
async function getTenantChargeSummary(housePaybill = null) {
  const params = [];
  let where = '';
  if (housePaybill) {
    where = ' WHERE t.house_paybill_number = $1';
    params.push(housePaybill);
  }
  const res = await query(
    `SELECT t.tenant_code, t.name AS tenant_name, t.unit_label, t.status,
            t.deposit_amount, t.deposit_paid, t.agreement_outstanding,
            h.house_name AS property_name
     FROM tenants t
     LEFT JOIN houses h ON h.paybill_number = t.house_paybill_number${where}
     ORDER BY h.house_name, t.unit_label`,
    params
  );
  const penRes = await query(
    `SELECT p.tenant_code, COALESCE(SUM(CASE WHEN p.status = 'Pending' THEN p.amount ELSE 0 END), 0) AS pending_total,
            COUNT(*) FILTER (WHERE p.status = 'Pending') AS pending_count
     FROM penalties p GROUP BY p.tenant_code`
  );
  const penMap = {};
  for (const r of penRes.rows) {
    penMap[r.tenant_code] = { pending_total: Number(r.pending_total || 0), pending_count: Number(r.pending_count || 0) };
  }
  return res.rows.map((t) => {
    const pen = penMap[t.tenant_code] || { pending_total: 0, pending_count: 0 };
    const required = Number(t.deposit_amount || 0);
    const paid = Number(t.deposit_paid || 0);
    return {
      tenant_code: t.tenant_code,
      tenant_name: t.name || '',
      unit_label: t.unit_label || '',
      property_name: t.property_name || '',
      status: t.status || '',
      deposit_required: required,
      deposit_paid: paid,
      deposit_balance: Math.max(0, required - paid),
      penalties_pending: pen.pending_total,
      penalties_count: pen.pending_count,
      agreement_outstanding: Number(t.agreement_outstanding || 0),
    };
  });
}

// Compose every landlord-pack dataset for (month, house?) in one call.
async function buildLandlordPack(month, housePaybill = null) {
  const commission = await getCommissionReport(month, housePaybill);
  const collections = await getPeriodCollections(month, housePaybill);
  const otherExpenses = await getOtherPropertyExpenses(month, housePaybill);
  const charges = await getTenantChargeSummary(housePaybill);
  let houses = [];
  if (housePaybill) {
    const h = await getHouse(housePaybill);
    if (h) houses = [{ paybill_number: h.paybill_number || housePaybill, house_name: h.house_name || '' }];
  } else {
    const all = await listHouses({});
    houses = all.map((h) => ({ paybill_number: h.paybill_number || h.id, house_name: h.house_name || '' }));
  }
  const waterByHouse = [];
  for (const h of houses) {
    try {
      waterByHouse.push(await buildWaterBillReport({ house_paybill: h.paybill_number, billing_month: month }));
    } catch (_) {
      waterByHouse.push(null);
    }
  }
  const waterTotals = waterByHouse.filter(Boolean).reduce((s, w) => ({
    total_units: s.total_units + w.totals.total_units,
    occupied_units: s.occupied_units + w.totals.occupied_units,
    vacant_units: s.vacant_units + w.totals.vacant_units,
    total_consumption: s.total_consumption + w.totals.total_consumption,
    total_water_charges: s.total_water_charges + w.totals.total_water_charges,
  }), { total_units: 0, occupied_units: 0, vacant_units: 0, total_consumption: 0, total_water_charges: 0 });
  return { commission, collections, otherExpenses, charges, waterByHouse: waterByHouse.filter(Boolean), waterTotals };
}
async function buildEnhancedMonthlyReport(month, housePaybill) {
  const monthStart = `${month}-01`;
  const d = new Date(`${month}-15T12:00:00`);
  d.setMonth(d.getMonth() + 1);
  const monthEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

  // 1. All tenants for the property (or all)
  let tenantQ = `SELECT t.*, h.house_name FROM tenants t LEFT JOIN houses h ON t.house_paybill_number = h.paybill_number WHERE 1=1`;
  const tenantParams = [];
  if (housePaybill) { tenantQ += ` AND t.house_paybill_number = $1`; tenantParams.push(housePaybill); }
  tenantQ += ` ORDER BY t.house_paybill_number, t.unit_label`;
  const tenantRes = await query(tenantQ, tenantParams);

  // 2. All approved payments in the month
  let payQ = `SELECT p.*, t.name AS tenant_name, t.unit_label, t.house_paybill_number
    FROM payments p JOIN tenants t ON p.tenant_code = t.tenant_code
    WHERE p.status = 'Approved' AND p.payment_date >= $1 AND p.payment_date < $2`;
  const payParams = [monthStart, monthEnd];
  if (housePaybill) { payQ += ` AND t.house_paybill_number = $3`; payParams.push(housePaybill); }
  payQ += ` ORDER BY t.house_paybill_number, t.unit_label, p.payment_date`;
  const payRes = await query(payQ, payParams);

  // 3. All penalties in the month
  let penQ = `SELECT p.*, t.name AS tenant_name, t.unit_label, t.house_paybill_number
    FROM penalties p JOIN tenants t ON p.tenant_code = t.tenant_code
    WHERE p.created_at >= $1 AND p.created_at < $2`;
  const penParams = [monthStart, monthEnd];
  if (housePaybill) { penQ += ` AND t.house_paybill_number = $3`; penParams.push(housePaybill); }
  const penRes = await query(penQ, penParams);

  // 4. All maintenance charges + work orders in the month
  let mcQ = `SELECT mc.*, wo.wo_number, wo.property_name AS wo_property, wo.technician_name,
    wo.date_requested, wo.date_completed, wo.status AS wo_status,
    wo.actual_work_completed, wo.materials_used, wo.labour_involved
    FROM maintenance_charges mc
    JOIN work_orders wo ON mc.work_order_id = wo.id
    WHERE mc.charge_month = $1`;
  const mcParams = [month];
  if (housePaybill) { mcQ += ` AND wo.house_paybill_number = $2`; mcParams.push(housePaybill); }
  const mcRes = await query(mcQ, mcParams);

  // 5. Invoices issued in the month (from invoice_register)
  let invQ = `SELECT ir.* FROM invoice_register ir WHERE ir.generated_at >= $1 AND ir.generated_at < $2`;
  const invParams = [monthStart, monthEnd];
  if (housePaybill) { invQ += ` AND ir.house_paybill_number = $3`; invParams.push(housePaybill); }
  const invRes = await query(invQ, invParams);

  // 6. Future tenancies (booked units)
  let ftQ = `SELECT ft.*, h.house_name FROM future_tenancies ft LEFT JOIN houses h ON ft.house_paybill = h.paybill_number WHERE ft.allocated_month = $1 AND ft.status = 'RESERVED'`;
  const ftParams = [month];
  if (housePaybill) { ftQ += ` AND ft.house_paybill = $2`; ftParams.push(housePaybill); }
  const ftRes = await query(ftQ, ftParams);

  // Group payments by tenant
  const paymentsByTenant = {};
  for (const p of payRes.rows) {
    if (!paymentsByTenant[p.tenant_code]) paymentsByTenant[p.tenant_code] = [];
    paymentsByTenant[p.tenant_code].push(p);
  }

  // Group penalties by tenant
  const penaltiesByTenant = {};
  for (const p of penRes.rows) {
    if (!penaltiesByTenant[p.tenant_code]) penaltiesByTenant[p.tenant_code] = [];
    penaltiesByTenant[p.tenant_code].push(p);
  }

  // Build unit-by-unit table
  const units = [];
  const statusCounts = { CLEARED: 0, PARTIALLY_PAID: 0, UNPAID: 0, VACANT: 0, BOOKED: 0, OVERPAYMENT: 0 };
  let totalRentDue = 0, totalRentPaid = 0, totalDepositCollected = 0;
  let totalWaterCharges = 0, totalPenalties = 0, totalOutstanding = 0, totalAdvance = 0;

  for (const t of tenantRes.rows) {
    const tenantPayments = paymentsByTenant[t.tenant_code] || [];
    const tenantPenalties = penaltiesByTenant[t.tenant_code] || [];

    // Vacant unit
    if (t.status === 'Vacant') {
      units.push({
        unit_number: t.unit_label || t.tenant_code, tenant_name: '— VACANT —',
        telephone: '', deposit: 0, water: 0, penalty: 0, monthly_rent: Number(t.rent_amount || 0),
        balance_bf: 0, rent_due: 0, rent_paid: 0, receipt_no: '', transaction_ref: '',
        payment_date: '', balance: 0, status: 'VACANT', payment_mode: '',
      });
      statusCounts.VACANT++;
      continue;
    }

    const rentAmount = Number(t.rent_amount || 0);
    const waterCharge = Number(t.water_charge_amount || 0);
    const garbageCharge = Number(t.garbage_fee_amount || 0);
    const arrears = Number(t.arrears || 0);

    // Penalties this month for this tenant — only count Pending (unpaid) penalties
    const penaltyTotal = tenantPenalties.filter(p => p.status === 'Pending').reduce((s, p) => s + Number(p.amount || 0), 0);

    // One-time water charge: bill it in the month its money landed (from each
    // payment's allocation snapshot) plus whatever is still unpaid today.
    // Re-adding the full charge every month phantom-billed tenants forever
    // after the refundable water deposit was settled.
    let waterSettledThisMonth = 0;
    for (const p of tenantPayments) {
      let bd = p.allocation_breakdown;
      try { if (typeof bd === 'string') bd = JSON.parse(bd); } catch (_) { bd = null; }
      if (bd && bd.waterSettled != null) waterSettledThisMonth += Number(bd.waterSettled) || 0;
    }
    const waterStillOwed = Math.max(0, waterCharge - Number(t.water_charge_paid || 0));
    const waterDue = Math.min(waterCharge, waterSettledThisMonth + waterStillOwed);

    // Rent Due = rent + water + garbage + penalties
    const rentDue = rentAmount + waterDue + garbageCharge + penaltyTotal;

    // Payments this month. Deposit money is reported through the Deposit
    // column — it is not rent collected and must not offset rent/charges
    // (it produced phantom OVERPAYMENT/CLEARED statuses).
    const depositPaid = tenantPayments.filter(p => p.payment_type === 'deposit').reduce((s, p) => s + Number(p.amount || 0), 0);
    const totalPaid = tenantPayments.filter(p => (p.payment_type || 'rent') !== 'deposit').reduce((s, p) => s + Number(p.amount || 0), 0);

    // Latest payment for receipt/ref/date
    const latestPayment = tenantPayments.length > 0
      ? tenantPayments.reduce((latest, p) => (!latest || p.payment_date > latest.payment_date) ? p : latest, null)
      : null;

    // Balance = arrears + (rent_due - total_paid)
    const balance = arrears + rentDue - totalPaid;

    // Status
    let status;
    if (balance <= 0 && totalPaid >= rentDue + arrears) {
      status = balance < 0 ? 'OVERPAYMENT' : 'CLEARED';
    } else if (totalPaid > 0) {
      status = 'PARTIALLY PAID';
    } else {
      status = 'UNPAID';
    }

    // Payment mode from latest payment
    const paymentMode = latestPayment?.payment_mode || '';

    // Receipt and reference
    let receiptNo = '';
    let transactionRef = '';
    let paymentDate = '';
    if (latestPayment) {
      receiptNo = latestPayment.receipt_number || '';
      transactionRef = latestPayment.mpesa_reference || latestPayment.cheque_number || latestPayment.sender_account || '';
      paymentDate = latestPayment.payment_date || '';
    }

    units.push({
      unit_number: t.unit_label || t.tenant_code, tenant_name: t.name,
      telephone: t.phone_number || '', deposit: depositPaid, water: waterDue,
      penalty: penaltyTotal, monthly_rent: rentAmount, balance_bf: arrears,
      rent_due: rentDue, rent_paid: totalPaid, receipt_no: receiptNo,
      transaction_ref: transactionRef, payment_date: paymentDate,
      balance, status, payment_mode: paymentMode,
    });

    statusCounts[status] = (statusCounts[status] || 0) + 1;
    totalRentDue += rentDue;
    totalRentPaid += totalPaid;
    totalDepositCollected += depositPaid;
    totalWaterCharges += waterDue;
    totalPenalties += penaltyTotal;
    if (balance > 0) totalOutstanding += balance;
    if (balance < 0) totalAdvance += Math.abs(balance);
  }

  // Add booked future tenancies
  for (const ft of ftRes.rows) {
    units.push({
      unit_number: ft.house_paybill || '', tenant_name: ft.prospective_tenant_name || 'BOOKED',
      telephone: ft.prospective_phone || '', deposit: 0, water: 0, penalty: 0,
      monthly_rent: 0, balance_bf: 0, rent_due: 0, rent_paid: 0,
      receipt_no: '', transaction_ref: '', payment_date: '', balance: 0,
      status: 'BOOKED', payment_mode: '',
    });
    statusCounts.BOOKED = (statusCounts.BOOKED || 0) + 1;
  }

  // Work / maintenance summary
  const workSummary = mcRes.rows.map(mc => ({
    wo_number: mc.wo_number, unit: mc.unit_code, tenant: mc.tenant_name,
    problem: mc.problem, work_done: mc.repair_description,
    material_cost: Number(mc.material_cost || 0), labour_cost: Number(mc.labour_cost || 0),
    total_cost: Number(mc.total_cost || 0), responsible_party: mc.responsible_party || 'Pending',
    amount_recovered: Number(mc.amount_recovered || 0),
    outstanding_recovery: Number(mc.total_cost || 0) - Number(mc.amount_recovered || 0),
    status: mc.recovery_status || 'Pending',
  }));

  // Invoices issued
  const invoicesIssued = invRes.rows.map(inv => ({
    invoice_number: inv.invoice_number, invoice_type: inv.invoice_type,
    property: inv.property_name, unit: inv.unit_label,
    description: inv.invoice_type === 'exit' ? `Exit Invoice - ${inv.invoice_number}` :
      inv.invoice_type === 'rent' ? `Rent Invoice - ${inv.tenant_name || ''}` :
      inv.invoice_type === 'maintenance' ? `Maintenance Invoice - ${inv.invoice_number}` :
      inv.invoice_type === 'penalty' ? `Penalty Invoice - ${inv.tenant_name || ''}` :
      `${inv.invoice_type} Invoice`,
    amount: Number(inv.amount || 0), date_issued: inv.generated_at,
    responsible_party: inv.invoice_type === 'maintenance' ? 'Management' :
      inv.invoice_type === 'exit' ? 'Tenant' : 'Tenant',
    payment_status: inv.status || 'Generated',
    amount_paid: Number(inv.amount || 0),
    outstanding: 0,
  }));

  // Monthly summary
  const totalUnits = tenantRes.rows.length + ftRes.rows.length;
  const totalMaintenanceCost = workSummary.reduce((s, w) => s + w.total_cost, 0);
  const totalTenantRecoveries = workSummary.filter(w => w.responsible_party === 'Tenant').reduce((s, w) => s + w.total_cost, 0);
  const totalMgmtCost = workSummary.filter(w => w.responsible_party !== 'Tenant').reduce((s, w) => s + w.total_cost, 0);
  const totalRecovered = workSummary.reduce((s, w) => s + w.amount_recovered, 0);
  const totalInvoicesAmount = invoicesIssued.reduce((s, i) => s + i.amount, 0);

  // Penalty breakdown by status
  const totalPenaltiesPending = penRes.rows.filter(p => p.status === 'Pending').reduce((s, p) => s + Number(p.amount || 0), 0);
  const totalPenaltiesPaid = penRes.rows.filter(p => p.status === 'Paid').reduce((s, p) => s + Number(p.amount || 0), 0);

  const summary = {
    total_units: totalUnits, occupied_units: statusCounts.CLEARED + statusCounts.PARTIALLY_PAID + statusCounts.UNPAID + statusCounts.OVERPAYMENT,
    vacant_units: statusCounts.VACANT, booked_units: statusCounts.BOOKED,
    paid_units: statusCounts.CLEARED, partially_paid_units: statusCounts.PARTIALLY_PAID,
    unpaid_units: statusCounts.UNPAID, overpayment_units: statusCounts.OVERPAYMENT,
    new_tenants: 0, vacated_tenants: 0,
    total_rent_due: totalRentDue, total_rent_paid: totalRentPaid,
    total_deposit_collected: totalDepositCollected, total_water_charges: totalWaterCharges,
    total_penalties: totalPenaltiesPending, total_penalties_paid: totalPenaltiesPaid,
    total_outstanding: totalOutstanding,
    total_advance_overpayment: totalAdvance, total_credit_balance: 0,
    total_tenant_recoveries: totalRecovered, total_mgmt_maintenance_cost: totalMgmtCost,
    total_work_repair_cost: totalMaintenanceCost, total_invoices_issued: totalInvoicesAmount,
  };

  // Compute new/exiting tenants
  let ntQ = `SELECT
    COUNT(*) FILTER (WHERE move_in_date >= $1 AND move_in_date < $2) AS new_tenants,
    COUNT(*) FILTER (WHERE move_out_date >= $1 AND move_out_date < $2) AS vacated_tenants
    FROM tenants`;
  const ntParams = [monthStart, monthEnd];
  if (housePaybill) { ntQ += ` WHERE house_paybill_number = $3`; ntParams.push(housePaybill); }
  const ntRes = await query(ntQ, ntParams);
  summary.new_tenants = Number(ntRes.rows[0]?.new_tenants || 0);
  summary.vacated_tenants = Number(ntRes.rows[0]?.vacated_tenants || 0);

  // Credit balance total
  let cbQ = `SELECT COALESCE(SUM(credit_balance), 0) AS total FROM tenants WHERE credit_balance > 0`;
  const cbParams = [];
  if (housePaybill) { cbQ += ` AND house_paybill_number = $1`; cbParams.push(housePaybill); }
  const cbRes = await query(cbQ, cbParams);
  summary.total_credit_balance = Number(cbRes.rows[0]?.total || 0);

  return {
    period: month,
    property_filter: housePaybill || null,
    property_name: housePaybill ? (await getHouse(housePaybill))?.house_name || null : null,
    units,
    work_summary: workSummary,
    invoices_issued: invoicesIssued,
    summary,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Generate and close monthly reports for ALL properties for the given month.
 * Called at rollover time.
 */
async function closeAllMonthlyReports(month) {
  const housesRes = await query(`SELECT paybill_number FROM houses ORDER BY house_name`);
  const reports = [];
  for (const h of housesRes.rows) {
    const r = await generateMonthlyReport(month, h.paybill_number);
    await closeMonthlyReport(month, h.paybill_number);
    reports.push(r);
  }
  // Also generate a global report (all properties)
  const globalReport = await generateMonthlyReport(month, null);
  await closeMonthlyReport(month, null);
  reports.push(globalReport);
  return reports;
}

async function createMaintenanceInvoice(data) {
  if (data.client_txn_id) {
    const existing = await findRecordByClientTxnId('maintenance_invoices', data.client_txn_id);
    if (existing) return { ...existing, _idempotentReplay: true };
  }
  const mntNumber = await generateMaintenanceInvoiceNumber();
  const items = normalizeWorkItems(data.items);
  const labourTotal = items.reduce((s, it) => s + Number(it.labour_cost || 0), 0);
  const materialTotal = items.reduce((s, it) => s + Number(it.material_cost || 0), 0);
  const grandTotal = labourTotal + materialTotal;
  const res = await query(
    `INSERT INTO maintenance_invoices (
       mnt_number, property_name, house_paybill_number, unit_codes, caretaker_name,
       date_reported, date_work_started, date_completed,
       technician_name, technician_phone, status, items,
       labour_total, material_total, grand_total, notes, client_txn_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      mntNumber,
      data.property_name || '',
      data.house_paybill_number || null,
      data.unit_codes || null,
      data.caretaker_name || null,
      data.date_reported || null,
      data.date_work_started || null,
      data.date_completed || null,
      data.technician_name || null,
      data.technician_phone || null,
      data.status || 'Pending',
      JSON.stringify(items),
      labourTotal,
      materialTotal,
      grandTotal,
      data.notes || null,
      data.client_txn_id || null,
    ]
  );
  return res.rows[0];
}

async function getMaintenanceInvoice(id) {
  const res = await query('SELECT * FROM maintenance_invoices WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function listMaintenanceInvoices({ status, limit = 100, offset = 0 } = {}) {
  const params = [];
  let q = 'SELECT * FROM maintenance_invoices';
  if (status) {
    params.push(status);
    q += ` WHERE status = $${params.length}`;
  }
  q += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
  params.push(Number(limit), Number(offset));
  const res = await query(q, params);
  return res.rows;
}

async function updateMaintenanceInvoice(id, data) {
  const existing = await getMaintenanceInvoice(id);
  if (!existing) return null;

  let items = existing.items;
  if (data.items) items = normalizeWorkItems(data.items);

  const labourTotal = Array.isArray(items)
    ? items.reduce((s, it) => s + Number(it.labour_cost || 0), 0)
    : Number(existing.labour_total || 0);
  const materialTotal = Array.isArray(items)
    ? items.reduce((s, it) => s + Number(it.material_cost || 0), 0)
    : Number(existing.material_total || 0);
  const grandTotal = labourTotal + materialTotal;
  const paidTotal = Number(existing.paid_total || 0);

  let newStatus = data.status || existing.status;
  if (grandTotal !== Number(existing.grand_total || 0)) {
    if (paidTotal <= 0) newStatus = data.status || 'Pending';
    else if (paidTotal >= grandTotal) newStatus = 'Paid';
    else newStatus = 'Partially Paid';
  }

  const res = await query(
    `UPDATE maintenance_invoices SET
       property_name = COALESCE($2, property_name),
       house_paybill_number = COALESCE($3, house_paybill_number),
       unit_codes = COALESCE($4, unit_codes),
       caretaker_name = COALESCE($5, caretaker_name),
       date_reported = COALESCE($6, date_reported),
       date_work_started = COALESCE($7, date_work_started),
       date_completed = COALESCE($8, date_completed),
       technician_name = COALESCE($9, technician_name),
       technician_phone = COALESCE($10, technician_phone),
       status = $16,
       items = $11,
       labour_total = $12,
       material_total = $13,
       grand_total = $14,
       notes = COALESCE($15, notes),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      id,
      data.property_name, data.house_paybill_number, data.unit_codes, data.caretaker_name,
      data.date_reported, data.date_work_started, data.date_completed,
      data.technician_name, data.technician_phone,
      JSON.stringify(items),
      labourTotal, materialTotal, grandTotal, data.notes,
      newStatus,
    ]
  );
  return res.rows[0] || null;
}

async function deleteMaintenanceInvoice(id) {
  const res = await query('DELETE FROM maintenance_invoices WHERE id = $1', [id]);
  return res.rowCount > 0;
}

async function payPenaltiesFromPayment(tenantCode, remaining, category, run) {
  const pending = await listPendingPenalties(tenantCode, category, run);
  let penaltySettled = 0;
  for (const p of pending) {
    if (remaining <= 0) break;
    const settle = Math.min(p.amount, remaining);
    if (settle >= p.amount) {
      await runOrQuery(run,
        `UPDATE penalties SET status = 'Paid', paid_date = CURRENT_DATE, updated_at = NOW() WHERE id = $1`,
        [p.id]
      );
      // Update linked maintenance charge recovery (fire-and-forget)
      if (category === 'maintenance' || !category) {
        query(
          `UPDATE maintenance_charges SET recovery_status = 'Paid', amount_recovered = total_cost, updated_at = NOW()
           WHERE penalty_id = $1 AND recovery_status != 'Paid'`,
          [p.id]
        ).catch(() => {});
      }
    }
    penaltySettled += settle;
    remaining -= settle;
  }
  return { penaltySettled, remaining };
}

function getPaymentInstructionsText(house, tenantCode) {
  const method = (house && house.payment_method) || 'paybill';
  if (method === 'till') {
    const till = house.till_number || '—';
    const name = house.till_name || '';
    return `Kindly pay via Buy Goods Till ${till}${name ? ` (${name})` : ''}.`;
  }
  const paybill = house.payment_paybill || null;
  const defaultPaybill = '4186787';
  const accountFmt = house.account_number_format || '';
  const account = accountFmt ? accountFmt.replace(/\{\{tenant_code\}\}/g, tenantCode || '') : (tenantCode || '');
  if (paybill && account) {
    return `Kindly pay via M-PESA Paybill ${paybill}, Account ${account}.`;
  }
  if (paybill) {
    return `Kindly pay via M-PESA Paybill ${paybill}${account ? `, Account ${account}` : ''}.`;
  }
  if (account) {
    return `Kindly pay via M-PESA Paybill ${defaultPaybill}, Account ${account}.`;
  }
  return `Kindly pay via M-PESA Paybill ${defaultPaybill}${tenantCode ? `, Account ${tenantCode}` : ''}.`;
}

// ===========================================================================
// TENANCY LIFECYCLE / ARCHIVE
// ===========================================================================

async function getApprovedPaymentCount(tenantCode, excludeId = null, run) {
  const res = await runOrQuery(run,
    `SELECT COUNT(*)::int AS c FROM payments WHERE tenant_code = $1 AND status = 'Approved' AND tenancy_id IS NULL${excludeId ? ' AND id <> $2' : ''}`,
    excludeId ? [tenantCode, excludeId] : [tenantCode]
  );
  return res.rows[0]?.c || 0;
}

async function hasApprovedRentPaymentFor(tenantCode, excludeId = null, run) {
  const res = await runOrQuery(run,
    `SELECT COUNT(*)::int AS c FROM payments WHERE tenant_code = $1 AND status = 'Approved' AND tenancy_id IS NULL AND (payment_type IS NULL OR payment_type = 'rent')${excludeId ? ' AND id <> $2' : ''}`,
    excludeId ? [tenantCode, excludeId] : [tenantCode]
  );
  return (res.rows[0]?.c || 0) > 0;
}

// ===========================================================================
// PAYMENT ARRANGEMENTS — management-only approved payment dates.
// Internal controls only: original due date (tenants.rent_due_date) is NEVER
// written here, actual payment dates live on payments rows, and nothing in
// this section touches the rent ledger, allocation, invoices or statuses.
// ===========================================================================

const ARR_ACTIVE = ['Pending', 'Approved'];
const ARR_CLOSED = ['Declined', 'Cancelled', 'Expired'];

function arrDateOnly(v) {
  // pg DATE columns arrive as local-midnight Date objects (never strings).
  // Format in LOCAL time: toISOString() would shift the day for UTC+ zones.
  if (!v) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function normArrangementRow(row) {
  if (!row) return row;
  return { ...row, requested_date: arrDateOnly(row.requested_date), approved_date: arrDateOnly(row.approved_date) };
}

async function logArrangementEvent(arrangementId, { actor, action, prevStatus, newStatus, prevApprovedDate, newApprovedDate, reason }, run) {
  await runOrQuery(run,
    `INSERT INTO payment_arrangement_events (arrangement_id, actor, action, prev_status, new_status, prev_approved_date, new_approved_date, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [arrangementId, actor || null, action, prevStatus || null, newStatus || null, prevApprovedDate || null, newApprovedDate || null, reason || null]
  );
}

async function createArrangement({ tenant_code, billing_period, requested_date, approved_date, reason, created_by }) {
  const tenant = await getTenant(tenant_code);
  if (!tenant) throw new Error('Tenant not found');
  if (!tenant || tenant.status === 'Vacant') throw new Error('Arrangements require an active tenancy');
  const bp = /^\d{4}-\d{2}$/.test(String(billing_period || ''))
    ? String(billing_period)
    : String(tenant.rent_due_date || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const req = arrDateOnly(requested_date);
  const app = arrDateOnly(approved_date);
  const res = await query(
    `INSERT INTO payment_arrangements (tenant_code, billing_period, requested_date, approved_date, reason, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 'Pending', $6)
     RETURNING *`,
    [tenant_code, bp, req, app, reason ? String(reason).slice(0, 2000) : null, created_by || null]
  );
  const row = res.rows[0];
  await logArrangementEvent(row.id, { actor: created_by, action: 'created', newStatus: 'Pending', newApprovedDate: app, reason });
  return normArrangementRow(row);
}

async function getArrangement(id, run) {
  const res = await runOrQuery(run, `SELECT * FROM payment_arrangements WHERE id = $1`, [id]);
  return normArrangementRow(res.rows[0] || null);
}

async function getArrangementHistory(id) {
  const res = await query(
    `SELECT * FROM payment_arrangement_events WHERE arrangement_id = $1 ORDER BY created_at ASC, id ASC`,
    [id]
  );
  return res.rows.map((e) => ({
    ...e,
    prev_approved_date: arrDateOnly(e.prev_approved_date),
    new_approved_date: arrDateOnly(e.new_approved_date),
  }));
}

// Derived display state: base status + period payments. Fulfilled / Partially
// Paid / Overdue—Approved-Date-Passed are computed at read time so the stored
// record (and the ledger) is never rewritten by viewing it.
async function describeArrangement(row) {
  const tenant = await getTenant(row.tenant_code);
  const rent = tenant ? Number(tenant.rent_amount || 0) : 0;
  const dueDate = tenant && tenant.rent_due_date ? String(tenant.rent_due_date).slice(0, 10) : null;
  const payRes = await query(
    `SELECT COALESCE(SUM(amount), 0) AS paid, MAX(payment_date)::text AS last_paid
     FROM payments WHERE tenant_code = $1 AND status = 'Approved' AND tenancy_id IS NULL
       AND COALESCE(billing_period, LEFT(payment_date::text, 7)) = $2`,
    [row.tenant_code, row.billing_period]
  );
  const paid = Number(payRes.rows[0]?.paid || 0);
  const lastPaid = payRes.rows[0]?.last_paid || null;
  const outstanding = Math.max(0, rent - paid);
  const today = new Date().toISOString().slice(0, 10);
  const approvedDate = arrDateOnly(row.approved_date);
  const requestedDate = arrDateOnly(row.requested_date);
  let display = row.status;
  if (row.status === 'Approved') {
    if (paid >= rent && rent > 0) display = 'Fulfilled';
    else if (paid > 0) display = 'Partially Paid';
    else if (approvedDate && approvedDate < today && outstanding > 0) display = 'Overdue — Approved Date Passed';
  }
  return {
    ...row,
    requested_date: requestedDate,
    approved_date: approvedDate,
    rent_amount: rent,
    normal_due_date: dueDate,
    amount_paid: paid,
    outstanding,
    actual_payment_date: lastPaid,
    display_status: display,
  };
}

async function listArrangements(tenantCode) {
  const res = await query(
    `SELECT * FROM payment_arrangements WHERE tenant_code = $1 ORDER BY billing_period DESC, id DESC`,
    [tenantCode]
  );
  const out = [];
  for (const row of res.rows) out.push(await describeArrangement(row));
  const active = out.find((r) => ARR_ACTIVE.includes(r.status)) || null;
  return { arrangements: out, active };
}

async function transitionArrangement(id, { action, approved_date, requested_date, reason, actor }) {
  const row = await getArrangement(id);
  if (!row) throw new Error('Arrangement not found');
  const prevStatus = row.status;
  const prevDate = arrDateOnly(row.approved_date);
  let nextStatus = prevStatus;
  let nextDate = prevDate;
  const sets = [];
  const params = [null]; // $1 = nextStatus (filled below)

  if (action === 'approve') {
    if (prevStatus !== 'Pending') throw new Error('Only pending arrangements can be approved');
    const app = arrDateOnly(approved_date) || prevDate;
    if (!app) throw new Error('Approved payment date required');
    nextStatus = 'Approved';
    nextDate = app;
    sets.push(`approved_date = $${params.length + 1}`, `approved_by = $${params.length + 2}`, `approved_at = NOW()`);
    params.push(app, actor || null);
  } else if (action === 'decline') {
    if (prevStatus !== 'Pending') throw new Error('Only pending arrangements can be declined');
    nextStatus = 'Declined';
  } else if (action === 'modify') {
    if (!['Pending', 'Approved'].includes(prevStatus)) throw new Error('Only pending or approved arrangements can be modified');
    const app = arrDateOnly(approved_date);
    const req = arrDateOnly(requested_date);
    if (app) { sets.push(`approved_date = $${params.length + 1}`); params.push(app); nextDate = app; }
    if (req) { sets.push(`requested_date = $${params.length + 1}`); params.push(req); }
    if (reason !== undefined) { sets.push(`reason = $${params.length + 1}`); params.push(reason ? String(reason).slice(0, 2000) : null); }
    if (!sets.length) throw new Error('Nothing to modify');
  } else if (action === 'cancel') {
    if (!['Pending', 'Approved'].includes(prevStatus)) throw new Error('Only pending or approved arrangements can be cancelled');
    nextStatus = 'Cancelled';
  } else if (action === 'expire') {
    if (prevStatus !== 'Approved') throw new Error('Only approved arrangements can expire');
    nextStatus = 'Expired';
  } else {
    throw new Error('Unknown action');
  }

  params[0] = nextStatus;
  if (['Cancelled', 'Declined', 'Expired'].includes(nextStatus)) sets.push('closed_at = NOW()');
  // Status change + audit event commit atomically — never one without the other.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = (sql, p) => client.query(sql, p);
    await run(
      `UPDATE payment_arrangements SET status = $1, updated_at = NOW()${sets.length ? `, ${sets.join(', ')}` : ''} WHERE id = $${params.length + 1}`,
      [...params, id]
    );
    await logArrangementEvent(id, {
      actor, action, prevStatus, newStatus: nextStatus,
      prevApprovedDate: prevDate, newApprovedDate: nextDate,
      reason: reason !== undefined ? reason : row.reason,
    }, run);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return (await getArrangement(id)) || row;
}

// Vacancy reset: auto-close live arrangements for the vacated unit. History
// rows stay under the old tenant_code for audit; a new tenant (new code)
// always starts with none.
async function closeArrangementsForVacancy(tenantCode, actor) {
  const res = await query(
    `SELECT * FROM payment_arrangements WHERE tenant_code = $1 AND status IN ('Pending', 'Approved')`,
    [tenantCode]
  );
  if (!res.rows.length) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = (sql, p) => client.query(sql, p);
    for (const row of res.rows) {
      await run(`UPDATE payment_arrangements SET status = 'Cancelled', closed_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id]);
      await logArrangementEvent(row.id, {
        actor: actor || 'system', action: 'cancel', prevStatus: row.status, newStatus: 'Cancelled',
        prevApprovedDate: arrDateOnly(row.approved_date),
        newApprovedDate: null, reason: 'Tenancy vacated — arrangement auto-closed',
      }, run);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return res.rows.length;
}

// ---- Exit invoices ---------------------------------------------------------

async function generateExitInvoiceNumber() {
  return nextCounterNumber('invoice_counters', 'GEHPM-EXT');
}

/**
 * Compute exit settlement.
 * Refundable Amount = deposit_paid + water_charges
 * Total Deductions  = outstanding (arrears + rent + penalties + garbage) + user deduction lines
 * Net Refund        = Refundable Amount − Total Deductions
 * Returns: { rentCharged, outstanding, refundableAmount, totalDeductions, depositRefund, finalSettlement }
 */
function computeExitSettlement(opts) {
  const { tenant, summary, lines, deductionsTotal, depositAmount, depositPaid, waterCharges,
    rentTreatment, rentChargedAmount, proRatedDays } = opts;

  const rentAmount = Number(tenant.rent_amount || 0);
  const arrears = summary ? Number(summary.totals.arrears || 0) : 0;
  const penalties = summary ? Number(summary.totals.penalties || 0) : 0;
  const garbage = summary ? Number(summary.totals.garbage_fee || 0) : 0;

  // 1. Determine rent charged based on treatment
  let rentCharged = 0;
  if (rentTreatment === 'full_month') {
    rentCharged = rentAmount;
  } else if (rentTreatment === 'pro_rated' && proRatedDays) {
    const dailyRate = rentAmount / 30;
    rentCharged = Math.round(dailyRate * proRatedDays);
  } else if (rentTreatment === 'waived') {
    rentCharged = 0;
  } else if (rentChargedAmount != null) {
    rentCharged = rentChargedAmount;
  }

  // 2. Outstanding = arrears + rent charged + penalties + garbage
  const outstanding = arrears + rentCharged + penalties + garbage;

  // 3. Refundable amount = deposit paid + water charges
  const refundableAmount = Number(depositPaid || 0) + Number(waterCharges || 0);

  // 4. Total deductions = outstanding + user-added deduction lines
  const totalDeductions = outstanding + deductionsTotal;

  // 5. Net refund = refundable − deductions (negative = tenant owes; positive = refund)
  const finalSettlement = refundableAmount - totalDeductions;
  const depositRefund = Math.max(0, refundableAmount - totalDeductions);

  return {
    rentCharged,
    outstanding: Math.max(0, outstanding),
    refundableAmount,
    totalDeductions,
    depositRefund,
    finalSettlement,
  };
}

async function createExitInvoice(tenantCode, data = {}) {
  if (data.client_txn_id) {
    const existing = await findRecordByClientTxnId('exit_invoices', data.client_txn_id);
    if (existing) {
      const full = await getExitInvoice(existing.id);
      return { ...(full || existing), _idempotentReplay: true };
    }
  }
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;
  const exitNumber = await generateExitInvoiceNumber();
  const depositAmount = Number(tenant.deposit_amount || 0);
  const depositPaid = Number(tenant.deposit_paid || 0);
  // Refundable water credit = what was actually PAID (capped at the charge),
  // never the full charge when partially paid. Explicit overrides still win.
  const waterCharges = data.water_charges != null
    ? Number(data.water_charges)
    : Math.min(Number(tenant.water_charge_paid || 0), Number(tenant.water_charge_amount || 0));
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const deductionsTotal = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const summary = await getTenantExitSummary(tenantCode);

  // Management decision fields
  const rentTreatment = data.rent_treatment || 'full_month';
  const rentChargedAmount = data.rent_charged_amount != null ? Number(data.rent_charged_amount) : null;
  const proRatedDays = data.pro_rated_days ? Number(data.pro_rated_days) : null;

  // Compute settlement
  const settlement = computeExitSettlement({
    tenant, summary, lines, deductionsTotal, depositAmount, depositPaid, waterCharges,
    rentTreatment, rentChargedAmount, proRatedDays,
  });

  const res = await query(
    `INSERT INTO exit_invoices
      (exit_number, tenant_code, property_name, house_paybill_number, unit_label, status,
       lines, deductions_total, deposit_amount, deposit_paid, water_charges, deposit_refund,
       outstanding_balance, final_settlement, move_out_date, reason,
       rent_treatment, rent_charged_amount, pro_rated_days, rent_treatment_reason,
       deposit_treatment, deposit_applied_to_rent, deposit_applied_to_deductions, settlement_decision_reason,
       client_txn_id)
     VALUES ($1,$2,$3,$4,$5,'Draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     RETURNING *, move_out_date::text AS move_out_date`,
    [
      exitNumber, tenant.tenant_code, tenant.property_name || null,
      tenant.house_id || null, tenant.unit_label || tenant.tenant_code || null,
      JSON.stringify(lines), Number(deductionsTotal.toFixed(2)),
      depositAmount, depositPaid, waterCharges,
      Number(settlement.depositRefund.toFixed(2)),
      Number(settlement.outstanding.toFixed(2)),
      Number(settlement.finalSettlement.toFixed(2)),
      data.move_out_date || null, data.reason || null,
      rentTreatment,
      settlement.rentCharged, proRatedDays,
      data.rent_treatment_reason || null,
      data.deposit_treatment || 'refund',
      0, 0,
      data.settlement_decision_reason || null,
      data.client_txn_id || null,
    ]
  );
  return getExitInvoice(res.rows[0].id);
}

async function getExitInvoice(id) {
  const res = await query(
    `SELECT *, move_out_date::text AS move_out_date, finalized_at FROM exit_invoices WHERE id = $1`,
    [id]
  );
  if (!res.rows[0]) return null;
  const r = res.rows[0];
  return {
    ...r,
    lines: Array.isArray(r.lines) ? r.lines : [],
    deductions_total: Number(r.deductions_total || 0),
    deposit_amount: Number(r.deposit_amount || 0),
    deposit_paid: Number(r.deposit_paid || 0),
    water_charges: Number(r.water_charges || 0),
    deposit_refund: Number(r.deposit_refund || 0),
    outstanding_balance: Number(r.outstanding_balance || 0),
    final_settlement: Number(r.final_settlement || 0),
  };
}

async function listExitInvoices(tenantCode = null) {
  const where = tenantCode ? ' WHERE tenant_code = $1' : '';
  const params = tenantCode ? [tenantCode] : [];
  const res = await query(
    `SELECT *, move_out_date::text AS move_out_date FROM exit_invoices${where} ORDER BY created_at DESC`,
    params
  );
  return res.rows.map((r) => ({
    ...r,
    lines: Array.isArray(r.lines) ? r.lines : [],
    deductions_total: Number(r.deductions_total || 0),
    deposit_amount: Number(r.deposit_amount || 0),
    deposit_paid: Number(r.deposit_paid || 0),
    water_charges: Number(r.water_charges || 0),
    deposit_refund: Number(r.deposit_refund || 0),
    outstanding_balance: Number(r.outstanding_balance || 0),
    final_settlement: Number(r.final_settlement || 0),
  }));
}

async function updateExitInvoice(id, patch = {}) {
  const existing = await getExitInvoice(id);
  if (!existing) return null;
  // A finalized exit invoice is the permanent record of how a tenancy ended —
  // tenant details and every figure on it stay unchanged forever.
  if (existing.status === 'Finalized') {
    return {
      error: 'This exit invoice is finalized. Finalized exit invoices are permanent and cannot be edited — tenant details and financial figures stay unchanged.',
      code: 'EXIT_INVOICE_FINALIZED',
    };
  }
  const tenant = await getTenant(existing.tenant_code);
  const summary = tenant ? await getTenantExitSummary(existing.tenant_code) : null;
  const lines = Array.isArray(patch.lines) ? patch.lines : existing.lines;
  const deductionsTotal = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const depositAmount = patch.deposit_amount != null ? Number(patch.deposit_amount) : existing.deposit_amount;
  const depositPaid = patch.deposit_paid != null ? Number(patch.deposit_paid) : existing.deposit_paid;
  const waterCharges = patch.water_charges != null ? Number(patch.water_charges) : Number(existing.water_charges || 0);

  // Management decision fields (use patch value, or keep existing)
  const rentTreatment = patch.rent_treatment || existing.rent_treatment || 'full_month';
  const rentChargedAmount = patch.rent_charged_amount != null ? Number(patch.rent_charged_amount) : existing.rent_charged_amount;
  const proRatedDays = patch.pro_rated_days != null ? Number(patch.pro_rated_days) : existing.pro_rated_days;

  // Compute settlement
  const settlement = tenant ? computeExitSettlement({
    tenant, summary, lines, deductionsTotal, depositAmount, depositPaid, waterCharges,
    rentTreatment, rentChargedAmount, proRatedDays,
  }) : {
    rentCharged: rentChargedAmount || 0,
    outstanding: existing.outstanding_balance,
    refundableAmount: depositPaid + waterCharges,
    totalDeductions: existing.deductions_total + existing.outstanding_balance,
    depositRefund: existing.deposit_refund, finalSettlement: existing.final_settlement,
  };

  await query(
    `UPDATE exit_invoices SET
       lines = $2, deductions_total = $3, deposit_amount = $4, deposit_paid = $5,
       water_charges = $6, deposit_refund = $7, outstanding_balance = $8, final_settlement = $9,
       move_out_date = COALESCE($10, move_out_date), reason = COALESCE($11, reason),
       rent_treatment = $12, rent_charged_amount = $13, pro_rated_days = $14,
       rent_treatment_reason = COALESCE($15, rent_treatment_reason),
       deposit_treatment = $16, deposit_applied_to_rent = $17, deposit_applied_to_deductions = $18,
       settlement_decision_reason = COALESCE($19, settlement_decision_reason),
       updated_at = NOW()
     WHERE id = $1`,
    [
      id, JSON.stringify(lines), Number(deductionsTotal.toFixed(2)),
      depositAmount, depositPaid, waterCharges,
      Number(settlement.depositRefund.toFixed(2)),
      Number(settlement.outstanding.toFixed(2)),
      Number(settlement.finalSettlement.toFixed(2)),
      patch.move_out_date || null, patch.reason != null ? patch.reason : null,
      rentTreatment, settlement.rentCharged, proRatedDays,
      patch.rent_treatment_reason || null,
      patch.deposit_treatment || existing.deposit_treatment || 'refund',
      0, 0,
      patch.settlement_decision_reason || null,
    ]
  );
  const updated = await getExitInvoice(id);
  // If finalized, re-sync the deposit refund record
  if (updated && updated.status === 'Finalized') {
    const refundable = Number(updated.deposit_refund || 0);
    const exitDate = updated.move_out_date || null;
    let refundDueDate = null;
    if (exitDate) {
      const d = new Date(exitDate);
      d.setDate(d.getDate() + 30);
      refundDueDate = d.toISOString().slice(0, 10);
    }
    const refundStatus = refundable > 0 ? 'pending' : 'no_refund_due';
    await query(
      `INSERT INTO deposit_refunds
        (tenant_code, exit_invoice_id, archive_id, deposit_amount, deposit_paid, deductions_total,
         deposit_applied_to_rent, deposit_applied_to_deductions, refundable_amount, remaining_amount,
         exit_date, refund_due_date, refund_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (exit_invoice_id) DO UPDATE SET
         deposit_amount = EXCLUDED.deposit_amount, deposit_paid = EXCLUDED.deposit_paid,
         deductions_total = EXCLUDED.deductions_total,
         deposit_applied_to_rent = EXCLUDED.deposit_applied_to_rent,
         deposit_applied_to_deductions = EXCLUDED.deposit_applied_to_deductions,
         refundable_amount = EXCLUDED.refundable_amount, remaining_amount = EXCLUDED.refundable_amount,
         exit_date = EXCLUDED.exit_date, refund_due_date = EXCLUDED.refund_due_date,
         refund_status = EXCLUDED.refund_status`,
      [
        updated.tenant_code, updated.id, updated.archive_id || null,
        Number(updated.deposit_amount || 0), Number(updated.deposit_paid || 0),
        Number(updated.deductions_total || 0),
        0, 0,
        refundable, refundable, exitDate, refundDueDate, refundStatus,
      ]
    );
  }
  return updated;
}

async function finalizeExitInvoice(id, patch = {}, actor = null) {
  const existing = await getExitInvoice(id);
  if (!existing) return null;
  if (existing.status !== 'Draft') {
    return { error: 'Exit invoice is already finalized' };
  }
  await query(
    `UPDATE exit_invoices SET status = 'Finalized', finalized_at = NOW(),
       finalized_by = COALESCE($4, finalized_by),
       move_out_date = COALESCE($2, move_out_date), reason = COALESCE($3, reason),
       updated_at = NOW()
     WHERE id = $1`,
    [id, patch.move_out_date || null, patch.reason != null ? patch.reason : null, actor || null]
  );

  const updated = await getExitInvoice(id);
  if (updated) {
    const refundable = Number(updated.deposit_refund || 0);
    const exitDate = updated.move_out_date || null;
    let refundDueDate = null;
    if (exitDate) {
      const d = new Date(exitDate);
      d.setDate(d.getDate() + 30);
      refundDueDate = d.toISOString().slice(0, 10);
    }
    const status = refundable > 0 ? 'pending' : 'no_refund_due';
    await query(
      `INSERT INTO deposit_refunds
        (tenant_code, exit_invoice_id, archive_id, deposit_amount, deposit_paid, deductions_total,
         deposit_applied_to_rent, deposit_applied_to_deductions, refundable_amount, remaining_amount,
         exit_date, refund_due_date, refund_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (exit_invoice_id) DO UPDATE SET
         deposit_amount = EXCLUDED.deposit_amount, deposit_paid = EXCLUDED.deposit_paid,
         deductions_total = EXCLUDED.deductions_total,
         deposit_applied_to_rent = EXCLUDED.deposit_applied_to_rent,
         deposit_applied_to_deductions = EXCLUDED.deposit_applied_to_deductions,
         refundable_amount = EXCLUDED.refundable_amount, remaining_amount = EXCLUDED.refundable_amount,
         exit_date = EXCLUDED.exit_date, refund_due_date = EXCLUDED.refund_due_date,
         refund_status = EXCLUDED.refund_status`,
      [
        updated.tenant_code, id, updated.archive_id || null,
        Number(updated.deposit_amount || 0), Number(updated.deposit_paid || 0),
        Number(updated.deductions_total || 0),
        Number(updated.deposit_applied_to_rent || 0), Number(updated.deposit_applied_to_deductions || 0),
        refundable, refundable, exitDate, refundDueDate, status, actor || null,
      ]
    );
  }

  return updated;
}

async function deleteExitInvoice(id) {
  const existing = await getExitInvoice(id);
  if (!existing) return false;
  if (existing.status === 'Finalized') {
    return {
      error: 'This exit invoice is finalized and permanently preserved with its tenancy record. It cannot be deleted.',
      code: 'EXIT_INVOICE_FINALIZED',
    };
  }
  await query('DELETE FROM deposit_refunds WHERE exit_invoice_id = $1', [id]);
  await query('DELETE FROM exit_invoices WHERE id = $1', [id]);
  return true;
}

// ---- Tenancy archive -------------------------------------------------------

function groupPaymentsByMonth(payments) {
  const map = new Map();
  for (const p of payments) {
    const prefix = String(p.payment_date || '').slice(0, 7);
    if (!prefix) continue;
    map.set(prefix, (map.get(prefix) || 0) + Number(p.amount || 0));
  }
  return Array.from(map.entries())
    .map(([month, paid]) => ({ month, paid: Number(paid.toFixed(2)) }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

// ── Tenancy binding (permanence rules) ───────────────────────────────────────
// Every money/document record a tenant produces carries `tenancy_id`:
//   NULL               → belongs to the CURRENT live tenancy of this unit code
//   tenancy_archive.id → permanently bound to one completed tenancy
// Live tenant views only read NULL rows, and completed-tenancy rows are never
// deleted, merged or relinked — so a new occupant of the same unit can never
// alter the previous tenant's financial history.
const TENANCY_SCOPED_TABLES = [
  'payments', 'penalties', 'documents', 'water_invoices', 'deposit_applications',
  'credit_allocations', 'message_logs', 'tenancy_agreements', 'inspections', 'maintenance_charges',
  'preexit_inspections',
];

async function sealTenancyRows(tenantCode, archiveId) {
  for (const table of TENANCY_SCOPED_TABLES) {
    try {
      await query(
        `UPDATE ${table} SET tenancy_id = $1 WHERE tenant_code = $2 AND tenancy_id IS NULL`,
        [archiveId, tenantCode]
      );
    } catch (err) {
      console.error(`[Tenancy] seal ${table} failed for ${tenantCode}:`, err.message);
    }
  }
}

// Safety net used at transitions: any row still un-stamped that provably
// belonged to the PREVIOUS closed tenancy (recorded before that archive was
// taken, or dated on/before its move-out) is sealed to it — so late money can
// never bleed into the incoming tenancy. Rows newer than the previous close
// stay NULL (they belong to the current/incoming tenancy).
// allowCreate: when the unit has no archive at all (legacy re-let), create one
// so the history has a permanent home instead of being destroyed. Never pass
// allowCreate when an archive is about to be written anyway (vacate path).
async function sealStrayTenancyRows(tenantCode, { allowCreate = false } = {}) {
  try {
    let stray = 0;
    for (const table of TENANCY_SCOPED_TABLES) {
      try {
        const r = await query(
          `SELECT COUNT(*)::int AS c FROM ${table} WHERE tenant_code = $1 AND tenancy_id IS NULL`,
          [tenantCode]
        );
        stray += Number(r.rows[0].c);
      } catch (_) { /* table without the column yet */ }
    }
    if (!stray) return null;

    const prev = await query(
      `SELECT id, archived_at, move_out_date::text AS move_out_date FROM tenancy_archive
        WHERE tenant_code = $1 ORDER BY archived_at DESC LIMIT 1`,
      [tenantCode]
    );

    if (!prev.rows.length) {
      // No archive at all. Only auto-create one when explicitly allowed
      // (re-let of a legacy unit); the vacate path writes its own archive next.
      if (!allowCreate) return null;
      const legacy = await archiveTenancy(tenantCode, {
        reason: 'Auto-closed at re-let (legacy tenancy without archive)',
        archived_by: 'system',
      });
      if (legacy) {
        await sealTenancyRows(tenantCode, legacy.id);
        return legacy.id;
      }
      return null;
    }

    const a = prev.rows[0];
    const p = [a.id, tenantCode, a.archived_at, a.move_out_date || null];
    const stamp = async (sql, params = p) => {
      try { await query(sql, params); } catch (e) { console.error('[Tenancy] stray seal:', e.message); }
    };
    // Rows that existed when the snapshot was taken (recorded_at <= archived_at)
    // or are dated inside the closed tenancy (payment_date/invoice_date <=
    // move_out) are the previous tenancy's. Anything newer is the incoming
    // tenancy's and stays live.
    await stamp(`UPDATE payments SET tenancy_id = $1 WHERE tenant_code = $2 AND tenancy_id IS NULL AND (recorded_at <= $3 OR payment_date <= $4::date)`);
    await stamp(`UPDATE penalties SET tenancy_id = $1 WHERE tenant_code = $2 AND tenancy_id IS NULL AND (created_at <= $3 OR invoice_date <= $4::date)`);
    await stamp(`UPDATE documents SET tenancy_id = $1 WHERE tenant_code = $2 AND tenancy_id IS NULL AND created_at <= $3`, p.slice(0, 3));
    await stamp(`UPDATE water_invoices SET tenancy_id = $1 WHERE tenant_code = $2 AND tenancy_id IS NULL AND (created_at <= $3 OR billing_month <= LEFT($4::text, 7))`);
    await stamp(`UPDATE deposit_applications SET tenancy_id = $1 WHERE tenant_code = $2 AND tenancy_id IS NULL AND (created_at <= $3 OR billing_period <= LEFT($4::text, 7))`);
    await stamp(`UPDATE credit_allocations SET tenancy_id = $1 WHERE tenant_code = $2 AND tenancy_id IS NULL AND applied_at <= $3`, p.slice(0, 3));
    await stamp(`UPDATE message_logs SET tenancy_id = $1 WHERE tenant_code = $2 AND tenancy_id IS NULL AND logged_at <= $3`, p.slice(0, 3));
    await stamp(`UPDATE tenancy_agreements SET tenancy_id = $1 WHERE tenant_code = $2 AND tenancy_id IS NULL AND created_at <= $3`, p.slice(0, 3));
    await stamp(`UPDATE inspections SET tenancy_id = $1 WHERE tenant_code = $2 AND tenancy_id IS NULL AND created_at <= $3`, p.slice(0, 3));
    await stamp(`UPDATE maintenance_charges SET tenancy_id = $1 WHERE tenant_code = $2 AND tenancy_id IS NULL AND created_at <= $3`, p.slice(0, 3));
    return a.id;
  } catch (err) {
    console.error(`[Tenancy] sealStray failed for ${tenantCode}:`, err.message);
    return null;
  }
}

async function archiveTenancy(tenantCode, options = {}) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;

  // Snapshot only THIS tenancy's rows: previously sealed (tenancy_id NOT NULL)
  // rows belong to earlier tenancies of the same unit code.
  const paymentsRes = await query(
    `SELECT *, payment_date::text AS payment_date_text FROM payments WHERE tenant_code = $1 AND tenancy_id IS NULL ORDER BY payments.payment_date ASC, id ASC`,
    [tenantCode]
  );
  const payments = paymentsRes.rows.map((r) => ({ ...r, payment_date: r.payment_date_text, amount: Number(r.amount) }));

  const penaltiesRes = await query(
    `SELECT *, invoice_date::text AS invoice_date_text FROM penalties WHERE tenant_code = $1 AND tenancy_id IS NULL ORDER BY penalties.invoice_date ASC, id ASC`,
    [tenantCode]
  );
  const penalties = penaltiesRes.rows.map((r) => ({ ...r, invoice_date: r.invoice_date_text, amount: Number(r.amount) }));

  const docsRes = await query(
    `SELECT id, doc_type, doc_number, title, filename, amount, doc_date::text AS doc_date, created_at FROM documents WHERE tenant_code = $1 AND tenancy_id IS NULL ORDER BY created_at ASC`,
    [tenantCode]
  );
  const documents = docsRes.rows.map((r) => ({ ...r, amount: r.amount != null ? Number(r.amount) : null }));

  const msgsRes = await query(
    `SELECT id, message_type, message_body, status, whatsapp_message_id, failure_reason, logged_at FROM message_logs WHERE tenant_code = $1 AND tenancy_id IS NULL ORDER BY logged_at ASC`,
    [tenantCode]
  );
  const messageLogs = msgsRes.rows;

  let statement = null;
  try { statement = await getTenantStatement(tenantCode); } catch (_) { statement = null; }

  const exitSummary = await getTenantExitSummary(tenantCode);
  const exitInvoice = options.exit_invoice_id ? await getExitInvoice(options.exit_invoice_id) : null;

  const approvedPayments = payments.filter((p) => p.status === 'Approved');
  const rentHistory = groupPaymentsByMonth(approvedPayments);

  const moveOutDate = options.move_out_date || tenant.move_out_date || null;
  const depositPaid = Number(tenant.deposit_paid || 0);
  const deductionsTotal = exitInvoice ? Number(exitInvoice.deductions_total || 0) : 0;
  const outstandingBalance = exitInvoice
    ? Number(exitInvoice.outstanding_balance || 0)
    : (exitSummary ? Number(exitSummary.totals.outstanding_total || 0) : 0);
  const depositRefund = exitInvoice
    ? Number(exitInvoice.deposit_refund || 0)
    : Math.max(0, depositPaid - deductionsTotal - outstandingBalance);

  const financialSnapshot = {
    rent_amount: Number(tenant.rent_amount || 0),
    arrears: Number(tenant.arrears || 0),
    deposit_amount: Number(tenant.deposit_amount || 0),
    deposit_paid: depositPaid,
    garbage_fee_amount: Number(tenant.garbage_fee_amount || 0),
    garbage_fee_paid: Number(tenant.garbage_fee_paid || 0),
    water_charge_amount: Number(tenant.water_charge_amount || 0),
    water_charge_paid: Number(tenant.water_charge_paid || 0),
    rent_paid_this_month: Number(tenant.rent_paid_this_month || 0),
    credit_balance: Number(tenant.credit_balance || 0),
    advance_rent_until: tenant.advance_rent_until || null,
    advance_rent_balance: Number(tenant.advance_rent_balance || 0),
    opening_advance_rent: Number(tenant.opening_advance_rent || 0),
    // Agreement + first-billing state preserved with the tenancy so archived
    // records stay complete for later audits.
    agreement_charge: Number(tenant.agreement_charge || 0),
    agreement_paid: Number(tenant.agreement_paid || 0),
    agreement_outstanding: Number(tenant.agreement_outstanding || 0),
    first_billing_method: tenant.first_billing_method || null,
    first_billing_charge: tenant.first_billing_charge != null ? Number(tenant.first_billing_charge) : null,
    rent_history: rentHistory,
  };

  const res = await query(
    `INSERT INTO tenancy_archive
      (tenant_code, property_name, house_paybill_number, unit_label, tenant_name, phone_number, national_id,
       guardian_name, guardian_id, guardian_phone, guardian_relationship,
       move_in_date, move_out_date, rent_amount, deposit_amount, deposit_paid, deposit_refund,
       opening_balance, final_balance, exit_reason, exit_invoice_number,
       payments, penalties, documents, message_logs, statements, inspections, exit_invoice, financial_snapshot, archived_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
     RETURNING id`,
    [
      tenant.tenant_code,
      tenant.property_name || null,
      tenant.house_id || null,
      tenant.unit_label || tenant.tenant_code || null,
      tenant.name,
      tenant.phone_number || null,
      tenant.national_id || null,
      tenant.guardian_name || null,
      tenant.guardian_id || null,
      tenant.guardian_phone || null,
      tenant.guardian_relationship || null,
      tenant.move_in_date || null,
      moveOutDate,
      Number(tenant.rent_amount || 0),
      Number(tenant.deposit_amount || 0),
      depositPaid,
      Number(depositRefund.toFixed(2)),
      Number(tenant.opening_advance_rent || 0),
      Number((exitSummary ? exitSummary.totals.outstanding_total : 0).toFixed(2)),
      options.reason || tenant.exit_reason || null,
      exitInvoice ? exitInvoice.exit_number : null,
      JSON.stringify(payments),
      JSON.stringify(penalties),
      JSON.stringify(documents),
      JSON.stringify(messageLogs),
      JSON.stringify(statement ? [statement] : []),
      JSON.stringify([]),
      exitInvoice ? JSON.stringify(exitInvoice) : null,
      JSON.stringify(financialSnapshot),
      options.archived_by || null,
    ]
  );
  const archiveId = res.rows[0].id;

  // ── Permanence: bind every record of this tenancy to it ───────────────
  // From here on these rows are excluded from all live tenant views
  // (tenancy_id IS NULL filters) and can never be deleted, merged or
  // relinked by a future occupant of the same unit.
  await sealTenancyRows(tenantCode, archiveId);

  // Deposit refunds raised during this exit belong to this tenancy as well
  // (older refunds already carry their own archive_id).
  try {
    await query(
      `UPDATE deposit_refunds SET archive_id = $1 WHERE archive_id IS NULL AND tenant_code = $2`,
      [archiveId, tenantCode]
    );
  } catch (err) {
    console.error(`[Tenancy] deposit_refunds seal failed for ${tenantCode}:`, err.message);
  }

  return getTenancyArchive(archiveId);
}

async function getTenancyArchive(id) {
  const res = await query(
    `SELECT id, tenant_code, property_name, house_paybill_number, unit_label, tenant_name, phone_number, national_id,
       guardian_name, guardian_id, guardian_phone, guardian_relationship,
       move_in_date::text AS move_in_date, move_out_date::text AS move_out_date, rent_amount,
       deposit_amount, deposit_paid, deposit_refund, opening_balance, final_balance, exit_reason,
       exit_invoice_number, payments, penalties, documents, message_logs, statements, inspections,
       exit_invoice, financial_snapshot, archived_by, archived_at
     FROM tenancy_archive WHERE id = $1`,
    [id]
  );
  if (!res.rows[0]) return null;
  const r = res.rows[0];

  // Merge the snapshot with live rows still bound to this tenancy: the live
  // row wins for equal ids (fresher status/receipt), and rows recorded after
  // the snapshot (late payments, documents with files) are appended — so the
  // archive always shows the COMPLETE history of this one tenancy.
  const mergeById = (snap, live) => {
    const byId = new Map();
    for (const row of Array.isArray(snap) ? snap : []) {
      if (row && row.id != null) byId.set(row.id, row);
    }
    for (const row of live || []) {
      if (row && row.id != null) byId.set(row.id, row);
    }
    return Array.from(byId.values());
  };

  let livePayments = [];
  let livePenalties = [];
  let liveDocs = [];
  let refundRow = null;
  try {
    const [p, pe, d, dr] = await Promise.all([
      query(`SELECT *, payment_date::text AS payment_date_text FROM payments WHERE tenancy_id = $1 ORDER BY payment_date ASC, id ASC`, [id]),
      query(`SELECT *, invoice_date::text AS invoice_date_text FROM penalties WHERE tenancy_id = $1 ORDER BY invoice_date ASC, id ASC`, [id]),
      query(`SELECT id, doc_type, doc_number, title, filename, file_path, amount, doc_date::text AS doc_date, created_at FROM documents WHERE tenancy_id = $1 ORDER BY created_at ASC`, [id]),
      query(`SELECT * FROM deposit_refunds WHERE archive_id = $1 ORDER BY id DESC LIMIT 1`, [id]),
    ]);
    livePayments = p.rows.map((x) => ({ ...x, payment_date: x.payment_date_text, amount: Number(x.amount) }));
    livePenalties = pe.rows.map((x) => ({ ...x, invoice_date: x.invoice_date_text, amount: Number(x.amount) }));
    liveDocs = d.rows.map((x) => ({ ...x, amount: x.amount != null ? Number(x.amount) : null }));
    refundRow = dr.rows[0] || null;
  } catch (err) {
    console.error('[Tenancy] archive live merge failed:', err.message);
  }

  r.payments = mergeById(r.payments, livePayments);
  r.penalties = mergeById(r.penalties, livePenalties);
  r.documents = mergeById(r.documents, liveDocs);
  r.deposit_refund_row = refundRow;

  // Pre-Exit Inspection Inventories bound to this tenancy (sealed at vacate)
  // stay reachable from the archive forever — including after re-letting.
  try {
    const pei = await query(
      `SELECT i.*, COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', it.id, 'description', it.description, 'quantity', it.quantity,
           'cost_per_qty', it.cost_per_qty, 'total', it.total, 'agreed', it.agreed,
           'transfer_status', it.transfer_status, 'transferred_at', it.transferred_at,
           'exit_invoice_id', it.exit_invoice_id
         ) ORDER BY it.id)
         FROM preexit_inspection_items it WHERE it.inspection_id = i.id
       ), '[]'::jsonb) AS items
         FROM preexit_inspections i
        WHERE i.tenancy_id = $1
        ORDER BY i.inspection_date DESC, i.id DESC`,
      [id]
    );
    r.preexit_inspections = pei.rows;
  } catch (err) {
    console.error('[Tenancy] archive preexit merge failed:', err.message);
    r.preexit_inspections = [];
  }

  return {
    ...r,
    rent_amount: Number(r.rent_amount || 0),
    deposit_amount: Number(r.deposit_amount || 0),
    deposit_paid: Number(r.deposit_paid || 0),
    deposit_refund: Number(r.deposit_refund || 0),
    opening_balance: Number(r.opening_balance || 0),
    final_balance: Number(r.final_balance || 0),
  };
}

// ── Tenancy payment history (per-tenancy ledger reconstruction) ───────────────
// Rebuilds the COMPLETE financial history of ONE archived tenancy from
// immutable records only (charges posted during the tenancy + each payment's
// own allocation breakdown). Historical balances are computed forward from
// the tenancy's own events — never from the tenant's current balance — so
// every "balance after payment" reflects the account at that moment.
function tenancyMonthList(startIso, endIso) {
  if (!startIso) return [];
  const s = String(startIso).slice(0, 7);
  const e = String(endIso || startIso).slice(0, 7);
  const out = [];
  let [y, m] = s.split('-').map(Number);
  const [ey, em] = e.split('-').map(Number);
  while ((y < ey || (y === ey && m <= em)) && out.length < 240) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function tenancyDaysInMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function tenancyOverlapDays(startIso, endIso, monthKey) {
  const start = String(startIso).slice(0, 10);
  const end = String(endIso || startIso).slice(0, 10);
  const mStart = `${monthKey}-01`;
  const mEnd = `${monthKey}-${String(tenancyDaysInMonth(monthKey)).padStart(2, '0')}`;
  const from = start > mStart ? start : mStart;
  const to = end < mEnd ? end : mEnd;
  if (to < from) return 0;
  return Math.round((new Date(to + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / 86400000) + 1;
}

async function getTenancyPaymentHistory(archiveId) {
  const a = await getTenancyArchive(archiveId);
  if (!a) return null;

  const exitInv = a.exit_invoice
    ? (typeof a.exit_invoice === 'string' ? JSON.parse(a.exit_invoice) : a.exit_invoice)
    : null;
  const snap = a.financial_snapshot
    ? (typeof a.financial_snapshot === 'string' ? JSON.parse(a.financial_snapshot) : a.financial_snapshot)
    : {};
  const rentAmount = Number(a.rent_amount || snap.rent_amount || 0);
  const garbageMonthly = Number(snap.garbage_fee_amount || 0);
  const waterMonthly = Number(snap.water_charge_amount || 0);
  const depositPaid = Number(a.deposit_paid || snap.deposit_paid || 0);

  const moveIn = String(a.move_in_date || '').slice(0, 10);
  const moveOut = String(a.move_out_date || (exitInv && exitInv.move_out_date) || String(a.archived_at || '').slice(0, 10)).slice(0, 10);
  const months = tenancyMonthList(moveIn, moveOut);
  const firstMonth = months[0] || null;
  const lastMonth = months[months.length - 1] || null;

  // Rent charged for one month of this tenancy. The FINAL month follows the
  // exit invoice's rent treatment (full / pro-rated / waived) — that is the
  // system's own decision of record; the FIRST month is pro-rated when the
  // tenancy started mid-month (no other first-billing data survives archive).
  const rentForMonth = (m) => {
    const isLast = m === lastMonth;
    const isFirst = m === firstMonth;
    if (isLast && exitInv) {
      const t = exitInv.rent_treatment || 'full_month';
      if (t === 'waived') return 0;
      if (t === 'pro_rated') return Math.round(Number(exitInv.rent_charged_amount || 0));
      return rentAmount;
    }
    if (isFirst && isFirst !== isLast && moveIn && Number(moveIn.slice(8, 10)) > 1) {
      const dim = tenancyDaysInMonth(m);
      return Math.round((rentAmount * (dim - Number(moveIn.slice(8, 10)) + 1)) / dim);
    }
    if (isFirst && isLast && !exitInv && moveIn && moveOut) {
      const overlap = tenancyOverlapDays(moveIn, moveOut, m);
      return Math.round((rentAmount * overlap) / tenancyDaysInMonth(m));
    }
    return rentAmount;
  };

  const charges = []; // { date, type, label, amount, month }
  for (const m of months) {
    const dayAnchor = (m === firstMonth && moveIn)
      ? `${m}-${String(Math.min(Number(moveIn.slice(8, 10)) || 1, tenancyDaysInMonth(m))).padStart(2, '0')}`
      : `${m}-${String(Math.min(Number((moveOut || '01').slice(8, 10)) || 1, tenancyDaysInMonth(m))).padStart(2, '0')}`;
    const r = rentForMonth(m);
    if (r > 0) charges.push({ date: dayAnchor, type: 'rent', label: `Monthly rent — ${m}`, amount: r, month: m });
    if (garbageMonthly > 0) {
      let g = garbageMonthly;
      if (m === firstMonth && m !== lastMonth && moveIn && Number(moveIn.slice(8, 10)) > 1) {
        const dim = tenancyDaysInMonth(m);
        g = Math.round((garbageMonthly * (dim - Number(moveIn.slice(8, 10)) + 1)) / dim);
      }
      if (g > 0) charges.push({ date: dayAnchor, type: 'garbage', label: `Garbage — ${m}`, amount: g, month: m });
    }
    if (waterMonthly > 0) {
      let w = waterMonthly;
      if (m === firstMonth && m !== lastMonth && moveIn && Number(moveIn.slice(8, 10)) > 1) {
        const dim = tenancyDaysInMonth(m);
        w = Math.round((waterMonthly * (dim - Number(moveIn.slice(8, 10)) + 1)) / dim);
      }
      if (w > 0) charges.push({ date: dayAnchor, type: 'water', label: `Water charge — ${m}`, amount: w, month: m });
    }
  }

  // Metered water bills (exact, when the tenancy had invoices)
  const waterInv = await query(
    `SELECT billing_month, total_amount, created_at::text AS created_at
       FROM water_invoices WHERE tenancy_id = $1 ORDER BY billing_month, id`,
    [archiveId]
  );
  const hasMeteredWater = waterInv.rows.length > 0;
  for (const w of waterInv.rows) {
    charges.push({
      date: String(w.created_at || '').slice(0, 10) || `${w.billing_month}-01`,
      type: 'water',
      label: `Water bill — ${w.billing_month}`,
      amount: Number(w.total_amount || 0),
      month: w.billing_month,
    });
  }

  // Penalties invoiced during the tenancy (snapshot rows)
  const penalties = Array.isArray(a.penalties) ? a.penalties : [];
  for (const p of penalties) {
    const amt = Number(p.amount || 0);
    if (amt > 0) {
      charges.push({
        date: String(p.invoice_date || '').slice(0, 10) || moveIn,
        type: 'penalty',
        label: p.description || 'Penalty',
        amount: amt,
        month: null,
      });
    }
  }

  // Maintenance / other recorded charges bound to this tenancy
  try {
    const mc = await query(
      `SELECT created_at::text AS created_at, amount, description
         FROM maintenance_charges WHERE tenancy_id = $1 ORDER BY created_at`,
      [archiveId]
    );
    for (const m of mc.rows) {
      charges.push({
        date: String(m.created_at || '').slice(0, 10) || moveIn,
        type: 'other',
        label: m.description || 'Other charge',
        amount: Number(m.amount || 0),
        month: null,
      });
    }
  } catch (_) { /* table without rows */ }

  // Opening arrears B/F — taken from the first allocated payment's own
  // `arrearsBefore` snapshot (the system's record of the balance at that time).
  const payList = (Array.isArray(a.payments) ? a.payments : []).slice().sort((x, y) => {
    const dx = String(x.payment_date || ''); const dy = String(y.payment_date || '');
    return dx === dy ? Number(x.id || 0) - Number(y.id || 0) : (dx < dy ? -1 : 1);
  });
  let openingArrears = 0;
  for (const p of payList) {
    let bd = p.allocation_breakdown;
    try { if (typeof bd === 'string') bd = JSON.parse(bd); } catch (_) { bd = null; }
    if (bd && Number(bd.arrearsBefore || 0) > 0) { openingArrears = Number(bd.arrearsBefore); break; }
  }
  if (openingArrears > 0 && moveIn) {
    charges.push({ date: moveIn, type: 'arrears', label: 'Arrears brought forward (B/F)', amount: openingArrears, month: null });
  }

  // ── Build the chronological event stream ──────────────────────────────────
  const parseAlloc = (p) => {
    let bd = p.allocation_breakdown;
    try { if (typeof bd === 'string') bd = JSON.parse(bd); } catch (_) { bd = null; }
    if (bd && typeof bd === 'object') {
      return {
        recorded: true,
        rent: Number(bd.rentSettled || 0),
        arrears: Number(bd.arrearsSettled || 0),
        garbage: Number(bd.garbageFeeSettled || 0),
        penalty: Number(bd.penaltySettled || 0),
        maintenance: Number(bd.maintenanceSettled || 0),
        other: Number(bd.otherSettled || 0),
        agreement: Number(bd.agreementSettled || 0),
        water: Number(bd.waterSettled || 0),
        deposit: Number(bd.depositSettled || 0),
        advance: Number(bd.overpayment || 0),
      };
    }
    // Legacy payment (approved before allocation snapshots existed): map by
    // payment type and flag it — never invent split details.
    const amt = Number(p.amount || 0);
    const t = String(p.payment_type || 'rent');
    const map = { rent: 'rent', deposit: 'deposit', water: 'water', advance_rent: 'advance', garbage: 'garbage', other: 'other', maintenance: 'maintenance' };
    const bucket = map[t] || 'rent';
    return {
      recorded: false,
      rent: bucket === 'rent' ? amt : 0,
      arrears: 0,
      garbage: bucket === 'garbage' ? amt : 0,
      penalty: 0,
      maintenance: bucket === 'maintenance' ? amt : 0,
      other: bucket === 'other' ? amt : 0,
      agreement: 0,
      water: bucket === 'water' ? amt : 0,
      deposit: bucket === 'deposit' ? amt : 0,
      advance: bucket === 'advance' ? amt : 0,
    };
  };

  const events = [];
  for (const c of charges) events.push({ kind: 'charge', date: c.date, charge: c });
  payList.forEach((p, i) => events.push({ kind: 'payment', date: String(p.payment_date || '').slice(0, 10), pay: p, idx: i }));
  events.sort((x, y) => {
    if (x.date !== y.date) return x.date < y.date ? -1 : 1;
    if (x.kind !== y.kind) return x.kind === 'charge' ? -1 : 1; // charges post before same-day payments
    return Number((x.pay && x.pay.id) || x.idx) - Number((y.pay && y.pay.id) || y.idx);
  });

  // ── Running balances ──────────────────────────────────────────────────────
  // balance = rent + arrears + garbage + penalties + other charges owed
  // (water follows the system's exit semantics: charged/paid, refundable —
  //  never part of the outstanding balance; deposit and advance are held
  //  money, not debt).
  let balance = 0;
  let waterCharged = 0;
  let waterPaid = 0;
  let depositHeld = 0;
  let advanceHeld = 0;

  const paymentsOut = [];
  const chargesOut = [];
  const totals = {
    rent_charged: 0, rent_paid: 0,
    garbage_charged: 0, garbage_paid: 0,
    water_charged: 0, water_paid: 0,
    penalties_charged: 0, penalties_paid: 0,
    other_charged: 0, other_paid: 0,
    deposit_held: 0, advance_held: 0,
    total_payments: 0,
  };

  for (const ev of events) {
    if (ev.kind === 'charge') {
      const c = ev.charge;
      chargesOut.push(c);
      if (c.type === 'water') waterCharged += c.amount;
      else balance += c.amount;
      if (c.type === 'rent') totals.rent_charged += c.amount;
      if (c.type === 'garbage') totals.garbage_charged += c.amount;
      if (c.type === 'water') totals.water_charged += c.amount;
      if (c.type === 'penalty') totals.penalties_charged += c.amount;
      if (c.type === 'other') totals.other_charged += c.amount;
      continue;
    }

    const p = ev.pay;
    const alloc = parseAlloc(p);
    const amount = Number(p.amount || 0);
    const balanceBefore = balance;
    balance -= (alloc.rent + alloc.arrears + alloc.garbage + alloc.penalty + alloc.maintenance + alloc.other + alloc.agreement);
    waterPaid += alloc.water;
    depositHeld += alloc.deposit;
    advanceHeld += alloc.advance;
    totals.rent_paid += alloc.rent;
    totals.garbage_paid += alloc.garbage;
    totals.water_paid += alloc.water;
    totals.penalties_paid += alloc.penalty;
    totals.other_paid += (alloc.maintenance + alloc.other + alloc.agreement);
    totals.deposit_held += alloc.deposit;
    totals.advance_held += alloc.advance;
    totals.total_payments += amount;

    paymentsOut.push({
      id: p.id,
      payment_date: String(p.payment_date || '').slice(0, 10),
      reference: p.receipt_number || p.mpesa_reference || null,
      receipt_number: p.receipt_number || null,
      mpesa_reference: p.mpesa_reference || null,
      amount,
      payment_mode: p.payment_mode || null,
      payment_type: p.payment_type || 'rent',
      billing_period: p.billing_period || null,
      status: p.status || null,
      allocation_recorded: alloc.recorded,
      allocations: {
        rent: alloc.rent,
        arrears: alloc.arrears,
        garbage: alloc.garbage,
        penalty: alloc.penalty,
        maintenance: alloc.maintenance,
        other: alloc.other,
        agreement: alloc.agreement,
        water: alloc.water,
        deposit: alloc.deposit,
        advance: alloc.advance,
      },
      balance_before: balanceBefore,
      balance_after: balance,
    });
  }

  const refundRow = a.deposit_refund_row || null;
  const depositRefundable = refundRow
    ? Number(refundRow.refundable_amount || 0)
    : (exitInv ? Number(exitInv.deposit_refund || 0) : 0);
  const depositRefunded = refundRow
    ? Number(refundRow.amount_refunded || 0)
    : 0;
  const depositDeductions = exitInv ? Number(exitInv.deductions_total || 0) : 0;

  return {
    tenancy: {
      id: a.id,
      tenant_code: a.tenant_code,
      tenant_name: a.tenant_name,
      phone_number: a.phone_number,
      national_id: a.national_id,
      property_name: a.property_name,
      unit: a.unit_label || a.tenant_code,
      move_in_date: a.move_in_date,
      move_out_date: a.move_out_date,
      rent_amount: rentAmount,
      deposit_paid: depositPaid,
      deposit_amount: Number(a.deposit_amount || snap.deposit_amount || 0),
      water_deposit: null, // no separate water deposit concept in this system
      status: 'Archived — tenancy closed',
      exit_date: a.move_out_date,
      exit_reason: a.exit_reason,
      archived_at: a.archived_at,
      archived_by: a.archived_by,
    },
    payments: paymentsOut,
    charges: chargesOut,
    summary: {
      total_rent_charged: Math.round(totals.rent_charged),
      total_rent_paid: Math.round(totals.rent_paid),
      total_water_charges: Math.round(waterCharged),
      total_water_paid: Math.round(waterPaid),
      total_garbage_charged: Math.round(totals.garbage_charged),
      total_garbage_paid: Math.round(totals.garbage_paid),
      total_penalties: Math.round(totals.penalties_charged),
      total_penalties_paid: Math.round(totals.penalties_paid),
      total_other_charged: Math.round(totals.other_charged),
      total_other_paid: Math.round(totals.other_paid),
      deposit_paid: depositPaid,
      deposit_deductions: depositDeductions,
      deposit_refundable: depositRefundable,
      deposit_refunded: depositRefunded,
      final_outstanding: exitInv ? Number(exitInv.outstanding_balance || 0) : Math.max(0, Math.round(balance)),
      exit_invoice_amount: exitInv ? Number(exitInv.final_settlement || 0) : null,
      total_payments: Math.round(totals.total_payments),
      balance_after_last_payment: Math.max(0, Math.round(balance)),
      advance_held: Math.round(advanceHeld),
    },
    exit_invoice: exitInv ? {
      id: exitInv.id,
      exit_number: exitInv.exit_number,
      status: exitInv.status,
      move_out_date: exitInv.move_out_date,
      rent_treatment: exitInv.rent_treatment,
      deductions_total: Number(exitInv.deductions_total || 0),
      outstanding_balance: Number(exitInv.outstanding_balance || 0),
      deposit_refund: Number(exitInv.deposit_refund || 0),
      final_settlement: Number(exitInv.final_settlement || 0),
      finalized_at: exitInv.finalized_at || null,
    } : null,
    deposit_refund: refundRow,
    note: 'Balances are reconstructed from this tenancy\u2019s own charge postings and each payment\u2019s recorded allocation — never from the tenant\u2019s current balance.',
  };
}

async function searchArchive(filters = {}) {
  let q = `SELECT id, tenant_code, property_name, house_paybill_number, unit_label, tenant_name, phone_number, national_id,
     move_in_date::text AS move_in_date, move_out_date::text AS move_out_date, deposit_amount, deposit_paid, deposit_refund,
     opening_balance, final_balance, exit_reason, exit_invoice_number, archived_at
     FROM tenancy_archive`;
  const conditions = [];
  const params = [];
  let index = 1;
  if (filters.q) {
    conditions.push(
      `(LOWER(tenant_name) LIKE $${index} OR LOWER(tenant_code) LIKE $${index} OR phone_number LIKE $${index} OR LOWER(COALESCE(national_id,'')) LIKE $${index})`
    );
    params.push(`%${String(filters.q).toLowerCase()}%`);
    index++;
  }
  if (filters.property_name) {
    conditions.push(`LOWER(property_name) = $${index}`);
    params.push(String(filters.property_name).toLowerCase());
    index++;
  }
  if (filters.house_id) {
    conditions.push(`house_paybill_number = $${index}`);
    params.push(String(filters.house_id));
    index++;
  }
  if (filters.unit_code) {
    conditions.push(`tenant_code = $${index}`);
    params.push(String(filters.unit_code));
    index++;
  }
  if (filters.from) {
    conditions.push(`move_in_date >= $${index}`);
    params.push(filters.from);
    index++;
  }
  if (filters.to) {
    conditions.push(`move_out_date <= $${index}`);
    params.push(filters.to);
    index++;
  }
  if (conditions.length > 0) {
    q += ' WHERE ' + conditions.join(' AND ');
  }
  const limit = Math.min(Number(filters.limit || 200), 500);
  q += ' ORDER BY archived_at DESC LIMIT ' + limit;
  const res = await query(q, params);
  return res.rows.map((r) => ({
    ...r,
    deposit_amount: Number(r.deposit_amount || 0),
    deposit_paid: Number(r.deposit_paid || 0),
    deposit_refund: Number(r.deposit_refund || 0),
    opening_balance: Number(r.opening_balance || 0),
    final_balance: Number(r.final_balance || 0),
  }));
}

async function deleteArchive(id) {
  // Completed tenancies are permanent: refuse when the tenancy has a
  // finalized exit invoice OR when any financial/document rows are bound to
  // it (deleting would orphan them and erase the accountability trail).
  const guarded = await query(
    `SELECT 1 FROM tenancy_archive a
      WHERE a.id = $1
        AND (
          a.exit_invoice_number IS NOT NULL
          OR EXISTS (SELECT 1 FROM exit_invoices e WHERE e.archive_id = a.id AND e.status = 'Finalized')
          OR EXISTS (SELECT 1 FROM payments p WHERE p.tenancy_id = a.id)
          OR EXISTS (SELECT 1 FROM penalties pe WHERE pe.tenancy_id = a.id)
          OR EXISTS (SELECT 1 FROM documents d WHERE d.tenancy_id = a.id)
        )
      LIMIT 1`,
    [id]
  );
  if (guarded.rows.length) {
    return {
      error: 'This tenancy is closed and preserved as a permanent historical record (it has a finalized exit invoice or bound financial records). Completed tenancies cannot be deleted.',
      code: 'TENANCY_CLOSED',
    };
  }
  const res = await query('DELETE FROM tenancy_archive WHERE id = $1', [id]);
  return res.rowCount > 0;
}

async function getOccupancyHistory(housePaybillNumber) {
  const archiveRes = await query(
    `SELECT id, tenant_code, tenant_name, phone_number, national_id,
       move_in_date::text AS move_in_date, move_out_date::text AS move_out_date
     FROM tenancy_archive
     WHERE house_paybill_number = $1
     ORDER BY move_in_date ASC NULLS LAST, archived_at ASC`,
    [housePaybillNumber]
  );

  const currentRes = await query(
    `SELECT tenant_code, name, move_in_date::text AS move_in_date
     FROM tenants
     WHERE house_paybill_number = $1 AND status != 'Vacant' AND name != ''
     ORDER BY move_in_date ASC NULLS LAST`,
    [housePaybillNumber]
  );

  const byUnit = new Map();
  const add = (unit, entry) => {
    const arr = byUnit.get(unit) || [];
    arr.push(entry);
    byUnit.set(unit, arr);
  };

  for (const a of archiveRes.rows) {
    add(a.tenant_code, { ...a, status: 'Vacated' });
  }
  for (const c of currentRes.rows) {
    add(c.tenant_code, { ...c, move_out_date: null, status: 'Current' });
  }

  const units = [];
  for (const [unit, entries] of byUnit.entries()) {
    entries.sort((x, y) => String(x.move_in_date || '').localeCompare(String(y.move_in_date || '')));
    units.push({ unit_code: unit, occupants: entries });
  }
  units.sort((a, b) => String(a.unit_code).localeCompare(String(b.unit_code)));
  return units;
}

async function vacateTenancy(tenantCode, options = {}) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;

  // Never create a blank archive: a tenancy with no identity AND no financial
  // history has nothing to preserve — refuse instead of writing an empty
  // record that would pollute the archive.
  const hasIdentity = String(tenant.name || '').trim() !== '';
  if (!hasIdentity) {
    try {
      const hist = await query(
        `SELECT (
           (SELECT COUNT(*) FROM payments WHERE tenant_code = $1) +
           (SELECT COUNT(*) FROM penalties WHERE tenant_code = $1) +
           (SELECT COUNT(*) FROM water_invoices WHERE tenant_code = $1) +
           (SELECT COUNT(*) FROM exit_invoices WHERE tenant_code = $1) +
           (SELECT COUNT(*) FROM deposit_refunds WHERE tenant_code = $1) +
           (SELECT COUNT(*) FROM tenancy_archive WHERE tenant_code = $1)
         )::int AS n`,
        [tenantCode]
      );
      if (!Number(hist.rows[0].n)) {
        return {
          error: 'Nothing to archive: this unit has no tenant identity and no financial history — refusing to create a blank archive record.',
          code: 'NOTHING_TO_ARCHIVE',
        };
      }
    } catch (_) { /* fall through — archive with whatever exists */ }
  }

  // Seal strays from EARLIER tenancies first (money dated before the previous
  // move-out that was recorded late) so the snapshot below contains only THIS
  // tenancy's rows.
  await sealStrayTenancyRows(tenantCode, { allowCreate: false });

  const archive = await archiveTenancy(tenantCode, options);
  if (!archive) return null;

  if (options.exit_invoice_id) {
    await query(
      `UPDATE exit_invoices SET archive_id = $1, status = 'Finalized', finalized_by = COALESCE($3, finalized_by), finalized_at = COALESCE(finalized_at, NOW()) WHERE id = $2 AND status = 'Draft'`,
      [archive.id, options.exit_invoice_id, options.archived_by || null]
    );
  }

  // Close the account but DO NOT reset the unit's financial data — that reset
  // happens only when a new tenant occupies the unit. The archive holds the
  // permanent snapshot.
  const res = await query(
    `UPDATE tenants SET
       name = '', phone_number = '', national_id = '',
       status = 'Vacant', move_out_date = $2, exit_reason = $3,
       updated_at = NOW()
     WHERE tenant_code = $1
     RETURNING *, tenant_code AS id, house_paybill_number AS house_id, rent_due_date::text AS rent_due_date, move_in_date::text AS move_in_date, move_out_date::text AS move_out_date`,
    [tenantCode, options.move_out_date || null, options.reason || tenant.exit_reason || null]
  );
  const r = res.rows[0];
  if (!r) return null;

  // Vacancy reset: auto-close live payment arrangements for this unit.
  // Arrangement history stays under the old tenant_code for audit; a new
  // tenant (new code) always starts with none.
  try { await closeArrangementsForVacancy(tenantCode, options.archived_by || 'system'); } catch (err) {
    console.error(`[Arrangements] Vacancy auto-close failed for ${tenantCode}:`, err.message);
  }

  await logAudit({
    actor: options.archived_by || 'system',
    action: 'tenancy_archived',
    entityType: 'tenant',
    entityId: tenantCode,
    details: { archive_id: archive.id, reason: options.reason || null },
  });

  return { tenant: { ...r, rent_amount: Number(r.rent_amount) }, archive };
}

async function resetTenancyFinancials(tenantCode) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;
  // ── Permanence: the previous tenancy's records are NEVER deleted here ──
  // vacateTenancy/archiveTenancy seals them to that tenancy's archive id;
  // sealStrayTenancyRows is the safety net for anything un-stamped (legacy
  // rows, late-recorded money). Live views only read tenancy_id IS NULL, so
  // the new tenancy starts with a clean, separate financial profile while
  // the previous tenant's full history remains permanently intact.
  await sealStrayTenancyRows(tenantCode, { allowCreate: true });
  // New tenancy owns this code from here on: void the previous tenancy's
  // open register rows so they can never surface as the new tenant's
  // invoices (payment processing, suggestions, history). Rows stay for audit.
  try { await voidTenantInvoices(tenantCode, 'system', 'New tenancy started'); } catch (_) {}
  await query(
    `UPDATE tenants SET
       arrears = 0, deposit_amount = 0, deposit_paid = 0,
       garbage_fee_amount = 0, garbage_fee_paid = 0,
       water_charge_amount = 0, water_charge_paid = 0,
       rent_amount = 0, rent_paid_this_month = 0,
       credit_balance = 0, advance_rent_until = NULL, advance_rent_balance = 0,
       opening_advance_rent = 0, move_in_date = NULL, move_out_date = NULL,
       notice_to_vacate_date = NULL, exit_reason = NULL,
       name = '', phone_number = '', national_id = '',
       guardian_name = NULL, guardian_id = NULL, guardian_phone = NULL, guardian_relationship = NULL,
       standard_monthly_rent = NULL, first_billing_method = NULL, first_billing_charge = NULL,
       first_billing_reason = NULL, first_billing_days = NULL,
       status = 'Active', updated_at = NOW()
     WHERE tenant_code = $1`,
    [tenantCode]
  );
  return getTenant(tenantCode);
}

async function recordNoticeToVacate(tenantCode, date, reason = null) {
  const tenant = await updateTenant(tenantCode, {
    notice_to_vacate_date: date || null,
    exit_reason: reason != null ? reason : undefined,
  });
  if (!tenant) return null;
  await logAudit({
    actor: 'system',
    action: 'notice_to_vacate_recorded',
    entityType: 'tenant',
    entityId: tenantCode,
    details: { notice_to_vacate_date: date || null, reason },
  });
  return tenant;
}

// ============================================================
// DEPOSIT REFUNDS
// ============================================================

async function listDepositRefunds({ status, tenant, house, search, sort, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;
  if (status && status !== 'all') { conditions.push(`dr.refund_status = $${idx++}`); params.push(status); }
  if (tenant) { conditions.push(`(dr.tenant_code ILIKE $${idx} OR t.name ILIKE $${idx})`); params.push(`%${tenant}%`); idx++; }
  if (house) { conditions.push(`ei.house_paybill_number = $${idx++}`); params.push(house); }
  if (search) { conditions.push(`(t.name ILIKE $${idx} OR dr.tenant_code ILIKE $${idx} OR ei.exit_number ILIKE $${idx} OR dr.transaction_reference ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderMap = { 'due_asc': 'dr.refund_due_date ASC NULLS LAST', 'due_desc': 'dr.refund_due_date DESC NULLS LAST', 'exit_asc': 'dr.exit_date ASC NULLS LAST', 'exit_desc': 'dr.exit_date DESC NULLS LAST', 'amount_desc': 'dr.refundable_amount DESC', 'amount_asc': 'dr.refundable_amount ASC', 'tenant_asc': 't.name ASC NULLS LAST', 'tenant_desc': 't.name DESC NULLS LAST', 'status': `CASE dr.refund_status WHEN 'overdue' THEN 1 WHEN 'due_today' THEN 2 WHEN 'due_soon' THEN 3 WHEN 'pending' THEN 4 WHEN 'partially_refunded' THEN 5 WHEN 'refunded' THEN 6 WHEN 'no_refund_due' THEN 7 END`, 'newest': 'dr.created_at DESC', 'oldest': 'dr.created_at ASC' };
  const orderBy = orderMap[sort] || orderMap['status'];
  const sql = `SELECT dr.*, t.name AS tenant_name, t.phone_number AS tenant_phone, ei.exit_number, ei.house_paybill_number, ei.unit_label, ei.property_name FROM deposit_refunds dr LEFT JOIN tenants t ON t.tenant_code = dr.tenant_code LEFT JOIN exit_invoices ei ON ei.id = dr.exit_invoice_id ${where} ORDER BY ${orderBy} LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(limit, offset);
  const res = await query(sql, params);
  return res.rows;
}

async function getDepositRefund(id) {
  const res = await query(`SELECT dr.*, t.name AS tenant_name, t.phone_number AS tenant_phone, t.national_id AS tenant_national_id, ei.exit_number, ei.house_paybill_number, ei.unit_label, ei.property_name, ei.deposit_amount AS ei_deposit_amount, ei.deposit_paid AS ei_deposit_paid, ei.deductions_total AS ei_deductions_total, ei.deposit_refund AS ei_deposit_refund, ei.outstanding_balance AS ei_outstanding_balance, ei.final_settlement AS ei_final_settlement, ei.lines AS ei_lines, ei.move_out_date AS ei_move_out_date, ei.deposit_treatment, ei.deposit_applied_to_rent AS ei_dep_applied_rent, ei.deposit_applied_to_deductions AS ei_dep_applied_ded, ei.rent_treatment, ei.rent_charged_amount, ei.pro_rated_days FROM deposit_refunds dr LEFT JOIN tenants t ON t.tenant_code = dr.tenant_code LEFT JOIN exit_invoices ei ON ei.id = dr.exit_invoice_id WHERE dr.id = $1`, [id]);
  return res.rows[0] || null;
}

async function getDepositRefundByExitInvoice(exitInvoiceId) {
  const res = await query(`SELECT * FROM deposit_refunds WHERE exit_invoice_id = $1`, [exitInvoiceId]);
  return res.rows[0] || null;
}

async function updateDepositRefund(id, patch) {
  const fields = []; const vals = []; let idx = 1;
  const allowed = ['refund_status', 'amount_refunded', 'remaining_amount', 'refund_date', 'refund_time', 'payment_method', 'transaction_reference', 'remarks', 'refunded_by', 'archive_id'];
  for (const k of allowed) { if (patch[k] !== undefined) { fields.push(`${k} = $${idx++}`); vals.push(patch[k]); } }
  if (fields.length === 0) return getDepositRefund(id);
  fields.push(`updated_at = NOW()`); vals.push(id);
  await query(`UPDATE deposit_refunds SET ${fields.join(', ')} WHERE id = $${idx}`, vals);
  return getDepositRefund(id);
}

async function recordDepositRefund(id, { amount, paymentMethod, transactionReference, refundDate, refundTime, remarks, actor }) {
  const existing = await getDepositRefund(id);
  if (!existing) return { error: 'Deposit refund record not found' };
  const refundable = Number(existing.refundable_amount || 0);
  const previouslyRefunded = Number(existing.amount_refunded || 0);
  const newTotal = previouslyRefunded + Number(amount || 0);
  if (newTotal > refundable) return { error: `Refund amount exceeds outstanding balance. Outstanding: ${refundable - previouslyRefunded}` };
  const remaining = refundable - newTotal;
  const status = remaining <= 0 ? 'refunded' : 'partially_refunded';
  return updateDepositRefund(id, { refund_status: status, amount_refunded: newTotal, remaining_amount: remaining, payment_method: paymentMethod || null, transaction_reference: transactionReference || null, refund_date: refundDate || new Date().toISOString().slice(0, 10), refund_time: refundTime || new Date().toISOString().slice(11, 19), remarks: remarks || null, refunded_by: actor || null });
}

async function getDepositRefundSummary() {
  const res = await query(`SELECT refund_status, COUNT(*)::int AS count, COALESCE(SUM(refundable_amount), 0)::numeric AS total_amount, COALESCE(SUM(amount_refunded), 0)::numeric AS total_refunded FROM deposit_refunds GROUP BY refund_status`);
  const summary = { pending: 0, due_soon: 0, due_today: 0, overdue: 0, refunded: 0, partially_refunded: 0, no_refund_due: 0, pending_amount: 0, due_soon_amount: 0, due_today_amount: 0, overdue_amount: 0, refunded_amount: 0, outstanding_amount: 0 };
  for (const r of res.rows) {
    const s = r.refund_status; summary[s] = r.count;
    if (s === 'pending') summary.pending_amount = Number(r.total_amount);
    if (s === 'due_soon') summary.due_soon_amount = Number(r.total_amount);
    if (s === 'due_today') summary.due_today_amount = Number(r.total_amount);
    if (s === 'overdue') summary.overdue_amount = Number(r.total_amount);
    if (s === 'refunded') summary.refunded_amount = Number(r.total_refunded);
    if (['pending', 'due_soon', 'due_today', 'overdue', 'partially_refunded'].includes(s)) summary.outstanding_amount += Number(r.total_amount) - Number(r.total_refunded);
  }
  return summary;
}

async function createDepositRefund(data) {
  const res = await query(`INSERT INTO deposit_refunds (tenant_code, exit_invoice_id, archive_id, deposit_amount, deposit_paid, deductions_total, deposit_applied_to_rent, deposit_applied_to_deductions, refundable_amount, remaining_amount, exit_date, refund_due_date, refund_status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (exit_invoice_id) DO UPDATE SET refundable_amount = EXCLUDED.refundable_amount, remaining_amount = EXCLUDED.remaining_amount, updated_at = NOW() RETURNING *`,
    [data.tenant_code, data.exit_invoice_id, data.archive_id || null, data.deposit_amount || 0, data.deposit_paid || 0, data.deductions_total || 0, data.deposit_applied_to_rent || 0, data.deposit_applied_to_deductions || 0, data.refundable_amount || 0, data.remaining_amount || data.refundable_amount || 0, data.exit_date || null, data.refund_due_date || null, data.refund_status || 'pending', data.created_by || null]);
  return res.rows[0];
}

// ============================================================
// MANAGEMENT EXPENSES REPORT
// ============================================================

async function getManagementExpensesReport({ month, date_from, date_to, property, category, status, source, employee, wo_number, invoice_number } = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (month) {
    conditions.push(`date_reported >= $${idx} AND date_reported < $${idx + 1}`);
    params.push(`${month}-01`);
    const [y, m] = month.split('-').map(Number);
    const nextM = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    params.push(nextM);
    idx += 2;
  } else if (date_from || date_to) {
    if (date_from) { conditions.push(`date_reported >= $${idx++}`); params.push(date_from); }
    if (date_to) { conditions.push(`date_reported <= $${idx++}`); params.push(date_to); }
  }

  if (property) { conditions.push(`property_name ILIKE $${idx++}`); params.push(`%${property}%`); }
  if (status) { conditions.push(`status = $${idx++}`); params.push(status); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const invRes = await query(`SELECT * FROM maintenance_invoices ${where} ORDER BY date_reported DESC, id DESC`, params);
  let expenses = invRes.rows;

  if (category) {
    expenses = expenses.filter(inv => {
      const item = Array.isArray(inv.items) && inv.items.length ? inv.items[0] : {};
      return (item.work_required || 'other') === category;
    });
  }

  if (source === 'Salary') expenses = [];

  let salary_records = [];
  if (month || (!date_from && !date_to)) {
    const salWhere = month ? `WHERE salary_month = $1` : (date_from || date_to ? `WHERE salary_month >= $1` : '');
    const salParams = month ? [month] : (date_from ? [date_from.slice(0, 7)] : []);
    if (salWhere && salParams.length) {
      const salRes = await query(`SELECT * FROM salary_records ${salWhere} ORDER BY salary_month DESC, employee_name ASC`, salParams);
      salary_records = salRes.rows;
    }
  }
  if (employee) salary_records = salary_records.filter(s => s.employee_name && s.employee_name.toLowerCase().includes(employee.toLowerCase()));

  const expensesMapped = expenses.map(inv => {
    const item = Array.isArray(inv.items) && inv.items.length ? inv.items[0] : {};
    const catKey = item.work_required || 'other';
    const notes = inv.notes || '';
    const isWoSource = notes.startsWith('WO Source: ');
    const amount = Number(inv.grand_total || 0);
    const paid = Number(inv.paid_total || 0);
    return {
      invoice_number: inv.mnt_number,
      date_reported: inv.date_reported,
      category: catKey,
      description: item.problem || notes || 'Management expense',
      property_name: inv.property_name,
      source: isWoSource ? 'Work Order' : 'Manual',
      amount,
      paid,
      outstanding: Math.max(0, amount - paid),
      status: inv.status || 'Pending',
    };
  });

  const salaryMapped = salary_records.map(s => ({
    employee: s.employee_name,
    description: `Salary - ${s.employee_name}`,
    amount: Number(s.expected_salary || 0),
    previous_balance: Number(s.previous_balance || 0),
    total_paid: Number(s.total_paid || 0),
    outstanding: Number(s.outstanding || 0),
    status: s.status || 'Pending',
    source: 'Salary',
    salary_month: s.salary_month,
  }));

  const allExpenses = [...expensesMapped, ...salaryMapped];

  const totalIncurred = allExpenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const totalPaid = expensesMapped.reduce((s, e) => s + Number(e.paid || 0), 0) + salaryMapped.reduce((s, e) => s + Number(e.total_paid || 0), 0);
  const totalOutstanding = expensesMapped.reduce((s, e) => s + Number(e.outstanding || 0), 0) + salaryMapped.reduce((s, e) => s + Number(e.outstanding || 0), 0);

  const byCategory = {};
  allExpenses.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount || 0); });

  const bySource = {};
  allExpenses.forEach(e => { bySource[e.source || 'Manual'] = (bySource[e.source || 'Manual'] || 0) + Number(e.amount || 0); });

  const propertyExpenses = expensesMapped.filter(e => e.property_name).reduce((s, e) => s + Number(e.amount || 0), 0);
  const generalExpenses = totalIncurred - propertyExpenses;

  return {
    month: month || `${date_from || ''} to ${date_to || ''}`,
    summary: {
      total_incurred: totalIncurred,
      total_paid: totalPaid,
      total_outstanding: totalOutstanding,
      property_expenses: propertyExpenses,
      general_expenses: generalExpenses,
    },
    by_category: byCategory,
    by_source: bySource,
    expenses: expensesMapped,
    salary_records: salaryMapped,
  };
}

async function getPropertyExpenseReport(property, month, date_from, date_to) {
  const report = await getManagementExpensesReport({ month, date_from, date_to, property });
  return report;
}

// ============================================================
// ELIGIBLE MANAGEMENT EXPENSES (WO expenses not yet in an invoice)
// ============================================================

async function getEligibleManagementExpenses(house) {
  let q = `
    SELECT mc.*, wo.wo_number, wo.house_paybill_number, wo.house_name
    FROM maintenance_charges mc
    JOIN work_orders wo ON mc.work_order_id = wo.id
    WHERE mc.recovery_status = 'N/A'
      AND mc.management_expense_invoice_id IS NULL
  `;
  const params = [];
  if (house) {
    params.push(house);
    q += ` AND wo.house_paybill_number = $1`;
  }
  q += ` ORDER BY mc.created_at DESC`;
  const res = await query(q, params);
  return res.rows;
}

// ============================================================
// LINK WO EXPENSES TO MANAGEMENT INVOICE
// ============================================================

async function createManagementExpenseFromWO(woId, issueNos, invoiceId) {
  let q = `UPDATE maintenance_charges SET management_expense_invoice_id = $1, updated_at = NOW() WHERE work_order_id = $2`;
  const params = [invoiceId, woId];
  if (issueNos && issueNos.length) {
    q += ` AND issue_no = ANY($3)`;
    params.push(issueNos);
  }
  q += ` RETURNING *`;
  const res = await query(q, params);
  return res.rows;
}

async function unlinkManagementExpenseCharges(invoiceId) {
  await query(`UPDATE maintenance_charges SET management_expense_invoice_id = NULL, updated_at = NOW() WHERE management_expense_invoice_id = $1`, [invoiceId]);
}

// ============================================================
// MANAGEMENT EXPENSE PAYMENTS
// ============================================================

async function recordExpensePayment(invoiceId, { amount, payment_method, reference, notes, recorded_by }) {
  const res = await query(`INSERT INTO management_expense_payments (invoice_id, amount, payment_method, reference, notes, recorded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [invoiceId, amount, payment_method || null, reference || null, notes || null, recorded_by || null]);
  await recalcExpensePaidTotal(invoiceId);
  return res.rows[0];
}

async function getExpensePayments(invoiceId) {
  const res = await query(`SELECT * FROM management_expense_payments WHERE invoice_id = $1 ORDER BY payment_date ASC, id ASC`, [invoiceId]);
  return res.rows;
}

async function deleteExpensePayment(id) {
  const row = await query(`SELECT invoice_id FROM management_expense_payments WHERE id = $1`, [id]);
  const invoiceId = row.rows[0]?.invoice_id;
  await query(`DELETE FROM management_expense_payments WHERE id = $1`, [id]);
  if (invoiceId) await recalcExpensePaidTotal(invoiceId);
}

async function recalcExpensePaidTotal(invoiceId) {
  const sumRes = await query(`SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM management_expense_payments WHERE invoice_id = $1`, [invoiceId]);
  const paidTotal = Number(sumRes.rows[0]?.total || 0);
  const invRes = await query(`SELECT grand_total FROM maintenance_invoices WHERE id = $1`, [invoiceId]);
  const grandTotal = Number(invRes.rows[0]?.grand_total || 0);
  const newStatus = paidTotal <= 0 ? 'Pending' : paidTotal >= grandTotal ? 'Paid' : 'Partially Paid';
  await query(
    `UPDATE maintenance_invoices SET paid_total = $2, status = $3, updated_at = NOW() WHERE id = $1`,
    [invoiceId, paidTotal, newStatus]
  );
}

// ============================================================
// SALARY RECORDS
// ============================================================

async function listSalaryRecords({ employee_name, salary_month } = {}) {
  const conditions = []; const params = []; let idx = 1;
  if (employee_name) { conditions.push(`employee_name ILIKE $${idx++}`); params.push(`%${employee_name}%`); }
  if (salary_month) { conditions.push(`salary_month = $${idx++}`); params.push(salary_month); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await query(`SELECT * FROM salary_records ${where} ORDER BY salary_month DESC, employee_name ASC`, params);
  return res.rows;
}

async function getSalaryRecord(id) {
  const res = await query(`SELECT * FROM salary_records WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function createSalaryRecord({ employee_name, salary_month, expected_salary, previous_balance, notes }) {
  const outstanding = Number(expected_salary || 0) + Number(previous_balance || 0);
  const res = await query(`INSERT INTO salary_records (employee_name, salary_month, expected_salary, previous_balance, outstanding, notes) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (employee_name, salary_month) DO UPDATE SET expected_salary = EXCLUDED.expected_salary, previous_balance = EXCLUDED.previous_balance, outstanding = EXCLUDED.outstanding, updated_at = NOW() RETURNING *`, [employee_name, salary_month, expected_salary || 0, previous_balance || 0, outstanding, notes || null]);
  return res.rows[0];
}

async function updateSalaryRecord(id, patch) {
  const fields = []; const vals = []; let idx = 1;
  for (const k of ['employee_name', 'salary_month', 'expected_salary', 'previous_balance', 'notes', 'status']) {
    if (patch[k] !== undefined) { fields.push(`${k} = $${idx++}`); vals.push(patch[k]); }
  }
  if (fields.length === 0) return getSalaryRecord(id);
  fields.push(`updated_at = NOW()`); vals.push(id);
  await query(`UPDATE salary_records SET ${fields.join(', ')} WHERE id = $${idx}`, vals);
  if (patch.expected_salary !== undefined || patch.previous_balance !== undefined) {
    const rec = await getSalaryRecord(id);
    if (rec) {
      const totalPaid = Number(rec.total_paid || 0);
      const outstanding = Math.max(0, Number(rec.expected_salary || 0) + Number(rec.previous_balance || 0) - totalPaid);
      const status = outstanding <= 0 ? 'Fully Paid' : totalPaid > 0 ? 'Partially Paid' : 'Pending';
      await query(`UPDATE salary_records SET outstanding = $1, status = $2 WHERE id = $3`, [outstanding, status, id]);
    }
  }
  return getSalaryRecord(id);
}

async function deleteSalaryRecord(id) {
  await query(`DELETE FROM salary_records WHERE id = $1`, [id]);
}

async function recordSalaryPayment(salaryRecordId, { amount, payment_date, payment_method, reference, notes, recorded_by }) {
  const rec = await getSalaryRecord(salaryRecordId);
  if (!rec) return null;
  const res = await query(`INSERT INTO salary_payments (salary_record_id, amount, payment_date, payment_method, reference, notes, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [salaryRecordId, amount, payment_date || new Date().toISOString().slice(0, 10), payment_method || null, reference || null, notes || null, recorded_by || null]);
  const totalPaid = Number(rec.total_paid || 0) + Number(amount || 0);
  const outstanding = Math.max(0, Number(rec.expected_salary || 0) + Number(rec.previous_balance || 0) - totalPaid);
  const status = outstanding <= 0 ? 'Fully Paid' : totalPaid > 0 ? 'Partially Paid' : 'Pending';
  await query(`UPDATE salary_records SET total_paid = $1, outstanding = $2, status = $3, updated_at = NOW() WHERE id = $4`, [totalPaid, outstanding, status, salaryRecordId]);
  return res.rows[0];
}

async function getSalaryPayments(salaryRecordId) {
  const res = await query(`SELECT * FROM salary_payments WHERE salary_record_id = $1 ORDER BY payment_date ASC, id ASC`, [salaryRecordId]);
  return res.rows;
}

async function deleteSalaryPayment(id) {
  const pay = (await query(`SELECT * FROM salary_payments WHERE id = $1`, [id])).rows[0];
  if (!pay) return;
  await query(`DELETE FROM salary_payments WHERE id = $1`, [id]);
  const rec = await getSalaryRecord(pay.salary_record_id);
  if (rec) {
    const totalPaid = Math.max(0, Number(rec.total_paid || 0) - Number(pay.amount || 0));
    const outstanding = Math.max(0, Number(rec.expected_salary || 0) + Number(rec.previous_balance || 0) - totalPaid);
    const status = outstanding <= 0 ? 'Fully Paid' : totalPaid > 0 ? 'Partially Paid' : 'Pending';
    await query(`UPDATE salary_records SET total_paid = $1, outstanding = $2, status = $3, updated_at = NOW() WHERE id = $4`, [totalPaid, outstanding, status, pay.salary_record_id]);
  }
}

async function rollOverSalaries(fromMonth, toMonth, actor) {
  const prev = await query(`SELECT * FROM salary_records WHERE salary_month = $1`, [fromMonth]);
  let created = 0;
  for (const rec of prev.rows) {
    const outstanding = Number(rec.outstanding || 0);
    if (outstanding > 0) {
      await query(`INSERT INTO salary_records (employee_name, salary_month, expected_salary, previous_balance, outstanding, notes) VALUES ($1,$2,0,$3,$4,$5) ON CONFLICT (employee_name, salary_month) DO UPDATE SET previous_balance = salary_records.previous_balance + EXCLUDED.previous_balance, outstanding = salary_records.outstanding + EXCLUDED.outstanding, updated_at = NOW()`, [rec.employee_name, toMonth, outstanding, outstanding, `Rolled over from ${fromMonth}`]);
      created++;
    }
  }
  return { created };
}

async function getSalaryHistory(employeeName) {
  const res = await query(`SELECT * FROM salary_records WHERE employee_name = $1 ORDER BY salary_month DESC`, [employeeName]);
  return res.rows;
}

async function listSalaryEmployees() {
  const res = await query(`SELECT DISTINCT employee_name FROM salary_records ORDER BY employee_name`);
  return res.rows.map(r => r.employee_name);
}

// ============================================================
// STAFF ADVANCES
// ============================================================

async function listStaffAdvances({ employee_name, status } = {}) {
  const conditions = []; const params = []; let idx = 1;
  if (employee_name) { conditions.push(`employee_name ILIKE $${idx++}`); params.push(`%${employee_name}%`); }
  if (status && status !== 'all') { conditions.push(`status = $${idx++}`); params.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await query(`SELECT * FROM staff_advances ${where} ORDER BY created_at DESC`, params);
  return res.rows;
}

async function getStaffAdvance(id) {
  const res = await query(`SELECT * FROM staff_advances WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function createStaffAdvance(data) {
  const outstanding = Number(data.amount || 0) - Number(data.amount_recovered || 0);
  const res = await query(`INSERT INTO staff_advances (employee_name, person_type, date_advanced, amount, reason, property_name, unit_code, recovery_method, expected_recovery_month, amount_recovered, outstanding, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [data.employee_name, data.person_type || 'Employee', data.date_advanced || new Date().toISOString().slice(0, 10), data.amount || 0, data.reason || null, data.property_name || null, data.unit_code || null, data.recovery_method || 'salary_deduction', data.expected_recovery_month || null, data.amount_recovered || 0, outstanding, data.notes || null]);
  return res.rows[0];
}

async function updateStaffAdvance(id, patch) {
  const fields = []; const vals = []; let idx = 1;
  for (const k of ['employee_name', 'person_type', 'date_advanced', 'amount', 'reason', 'property_name', 'unit_code', 'recovery_method', 'expected_recovery_month', 'notes', 'status']) {
    if (patch[k] !== undefined) { fields.push(`${k} = $${idx++}`); vals.push(patch[k]); }
  }
  if (fields.length === 0) return getStaffAdvance(id);
  fields.push(`updated_at = NOW()`); vals.push(id);
  await query(`UPDATE staff_advances SET ${fields.join(', ')} WHERE id = $${idx}`, vals);
  if (patch.amount !== undefined) {
    const adv = await getStaffAdvance(id);
    if (adv) {
      const recovered = Number(adv.amount_recovered || 0);
      const outstanding = Math.max(0, Number(adv.amount || 0) - recovered);
      const status = outstanding <= 0 ? 'Fully Recovered' : recovered > 0 ? 'Partially Recovered' : 'Pending';
      await query(`UPDATE staff_advances SET outstanding = $1, status = $2 WHERE id = $3`, [outstanding, status, id]);
    }
  }
  return getStaffAdvance(id);
}

async function deleteStaffAdvance(id) {
  await query(`DELETE FROM staff_advances WHERE id = $1`, [id]);
}

async function recordStaffAdvancePayment(staffAdvanceId, { amount, payment_date, payment_time, payment_method, sender_account, reference, notes, recorded_by }) {
  const adv = await getStaffAdvance(staffAdvanceId);
  if (!adv) return null;
  const res = await query(`INSERT INTO staff_advance_payments (staff_advance_id, amount, payment_date, payment_time, payment_method, sender_account, reference, notes, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [staffAdvanceId, amount, payment_date || new Date().toISOString().slice(0, 10), payment_time || null, payment_method || null, sender_account || null, reference || null, notes || null, recorded_by || null]);
  const recovered = Number(adv.amount_recovered || 0) + Number(amount || 0);
  const outstanding = Math.max(0, Number(adv.amount || 0) - recovered);
  const status = outstanding <= 0 ? 'Fully Recovered' : recovered > 0 ? 'Partially Recovered' : 'Pending';
  await query(`UPDATE staff_advances SET amount_recovered = $1, outstanding = $2, status = $3, updated_at = NOW() WHERE id = $4`, [recovered, outstanding, status, staffAdvanceId]);
  return res.rows[0];
}

async function getStaffAdvancePayments(staffAdvanceId) {
  const res = await query(`SELECT * FROM staff_advance_payments WHERE staff_advance_id = $1 ORDER BY payment_date ASC, id ASC`, [staffAdvanceId]);
  return res.rows;
}

async function deleteStaffAdvancePayment(id) {
  const pay = (await query(`SELECT * FROM staff_advance_payments WHERE id = $1`, [id])).rows[0];
  if (!pay) return;
  await query(`DELETE FROM staff_advance_payments WHERE id = $1`, [id]);
  const adv = await getStaffAdvance(pay.staff_advance_id);
  if (adv) {
    const recovered = Math.max(0, Number(adv.amount_recovered || 0) - Number(pay.amount || 0));
    const outstanding = Math.max(0, Number(adv.amount || 0) - recovered);
    const status = outstanding <= 0 ? 'Fully Recovered' : recovered > 0 ? 'Partially Recovered' : 'Pending';
    await query(`UPDATE staff_advances SET amount_recovered = $1, outstanding = $2, status = $3, updated_at = NOW() WHERE id = $4`, [recovered, outstanding, status, pay.staff_advance_id]);
  }
}

async function listStaffAdvanceEmployees() {
  const res = await query(`SELECT DISTINCT employee_name FROM staff_advances ORDER BY employee_name`);
  return res.rows.map(r => r.employee_name);
}

// ============================================================
// EMPLOYEE RENT
// ============================================================

async function listEmployeeRent({ employee_name, rent_period, status } = {}) {
  const conditions = []; const params = []; let idx = 1;
  if (employee_name) { conditions.push(`employee_name ILIKE $${idx++}`); params.push(`%${employee_name}%`); }
  if (rent_period) { conditions.push(`rent_period = $${idx++}`); params.push(rent_period); }
  if (status && status !== 'all') { conditions.push(`status = $${idx++}`); params.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await query(`SELECT * FROM employee_rent ${where} ORDER BY rent_period DESC, employee_name ASC`, params);
  return res.rows;
}

async function getEmployeeRent(id) {
  const res = await query(`SELECT * FROM employee_rent WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function createEmployeeRent(data) {
  const outstanding = Number(data.monthly_rent || 0) + Number(data.previous_balance || 0);
  const res = await query(`INSERT INTO employee_rent (employee_name, property_name, unit_code, monthly_rent, rent_due_day, rent_period, previous_balance, outstanding) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (employee_name, property_name, unit_code, rent_period) DO UPDATE SET monthly_rent = EXCLUDED.monthly_rent, previous_balance = EXCLUDED.previous_balance, outstanding = EXCLUDED.outstanding, updated_at = NOW() RETURNING *`, [data.employee_name, data.property_name, data.unit_code, data.monthly_rent || 0, data.rent_due_day || 5, data.rent_period, data.previous_balance || 0, outstanding]);
  return res.rows[0];
}

async function updateEmployeeRent(id, patch) {
  const fields = []; const vals = []; let idx = 1;
  for (const k of ['employee_name', 'property_name', 'unit_code', 'monthly_rent', 'rent_due_day', 'rent_period', 'notes', 'status']) {
    if (patch[k] !== undefined) { fields.push(`${k} = $${idx++}`); vals.push(patch[k]); }
  }
  if (fields.length === 0) return getEmployeeRent(id);
  fields.push(`updated_at = NOW()`); vals.push(id);
  await query(`UPDATE employee_rent SET ${fields.join(', ')} WHERE id = $${idx}`, vals);
  if (patch.monthly_rent !== undefined || patch.previous_balance !== undefined) {
    const rec = await getEmployeeRent(id);
    if (rec) {
      const totalPaid = Number(rec.total_paid || 0);
      const outstanding = Math.max(0, Number(rec.previous_balance || 0) + Number(rec.monthly_rent || 0) - totalPaid - Number(rec.total_deducted || 0));
      const status = outstanding <= 0 ? 'Fully Paid' : totalPaid > 0 ? 'Partially Paid' : 'Pending';
      await query(`UPDATE employee_rent SET outstanding = $1, status = $2 WHERE id = $3`, [outstanding, status, id]);
    }
  }
  return getEmployeeRent(id);
}

async function deleteEmployeeRent(id) {
  await query(`DELETE FROM employee_rent WHERE id = $1`, [id]);
}

async function recordEmployeeRentPayment(employeeRentId, { amount, payment_date, payment_method, reference, notes, recorded_by }) {
  const rec = await getEmployeeRent(employeeRentId);
  if (!rec) return null;
  const res = await query(`INSERT INTO employee_rent_payments (employee_rent_id, amount, payment_date, payment_method, reference, notes, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [employeeRentId, amount, payment_date || new Date().toISOString().slice(0, 10), payment_method || null, reference || null, notes || null, recorded_by || null]);
  const totalPaid = Number(rec.total_paid || 0) + Number(amount || 0);
  const outstanding = Math.max(0, Number(rec.previous_balance || 0) + Number(rec.monthly_rent || 0) - totalPaid - Number(rec.total_deducted || 0));
  const status = outstanding <= 0 ? 'Fully Paid' : totalPaid > 0 ? 'Partially Paid' : 'Pending';
  await query(`UPDATE employee_rent SET total_paid = $1, outstanding = $2, status = $3, updated_at = NOW() WHERE id = $4`, [totalPaid, outstanding, status, employeeRentId]);
  return res.rows[0];
}

async function getEmployeeRentPayments(employeeRentId) {
  const res = await query(`SELECT * FROM employee_rent_payments WHERE employee_rent_id = $1 ORDER BY payment_date ASC, id ASC`, [employeeRentId]);
  return res.rows;
}

async function deleteEmployeeRentPayment(id) {
  const pay = (await query(`SELECT * FROM employee_rent_payments WHERE id = $1`, [id])).rows[0];
  if (!pay) return;
  await query(`DELETE FROM employee_rent_payments WHERE id = $1`, [id]);
  const rec = await getEmployeeRent(pay.employee_rent_id);
  if (rec) {
    const totalPaid = Math.max(0, Number(rec.total_paid || 0) - Number(pay.amount || 0));
    const outstanding = Math.max(0, Number(rec.previous_balance || 0) + Number(rec.monthly_rent || 0) - totalPaid - Number(rec.total_deducted || 0));
    const status = outstanding <= 0 ? 'Fully Paid' : totalPaid > 0 ? 'Partially Paid' : 'Pending';
    await query(`UPDATE employee_rent SET total_paid = $1, outstanding = $2, status = $3, updated_at = NOW() WHERE id = $4`, [totalPaid, outstanding, status, pay.employee_rent_id]);
  }
}

async function deductRentFromSalary(employeeRentId, { amount, salary_record_id, notes }) {
  const rec = await getEmployeeRent(employeeRentId);
  if (!rec) return null;
  const deducted = Number(rec.total_deducted || 0) + Number(amount || 0);
  const outstanding = Math.max(0, Number(rec.previous_balance || 0) + Number(rec.monthly_rent || 0) - Number(rec.total_paid || 0) - deducted);
  const status = outstanding <= 0 ? 'Fully Paid' : deducted > 0 ? 'Partially Paid' : 'Pending';
  await query(`UPDATE employee_rent SET total_deducted = $1, outstanding = $2, status = $3, updated_at = NOW() WHERE id = $4`, [deducted, outstanding, status, employeeRentId]);
  const ded = await query(`INSERT INTO salary_deductions (employee_name, salary_month, deduction_type, description, amount, amount_deducted, outstanding, related_id, status, notes) VALUES ($1,$2,'employee_rent',$3,$4,$5,$6,$7,'Fully Deducted',$8) RETURNING *`, [rec.employee_name, salary_record_id ? (await getSalaryRecord(salary_record_id))?.salary_month : new Date().toISOString().slice(0, 7), `Rent deduction: ${rec.property_name} ${rec.unit_code}`, amount, amount, 0, employeeRentId, notes || null]);
  return ded.rows[0];
}

async function listEmployeeRentEmployees() {
  const res = await query(`SELECT DISTINCT employee_name FROM employee_rent ORDER BY employee_name`);
  return res.rows.map(r => r.employee_name);
}

// ============================================================
// SALARY DEDUCTIONS
// ============================================================

async function listSalaryDeductions({ employee_name, salary_month, deduction_type } = {}) {
  const conditions = []; const params = []; let idx = 1;
  if (employee_name) { conditions.push(`employee_name ILIKE $${idx++}`); params.push(`%${employee_name}%`); }
  if (salary_month) { conditions.push(`salary_month = $${idx++}`); params.push(salary_month); }
  if (deduction_type) { conditions.push(`deduction_type = $${idx++}`); params.push(deduction_type); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await query(`SELECT * FROM salary_deductions ${where} ORDER BY salary_month DESC, employee_name ASC`, params);
  return res.rows;
}

async function getSalaryDeduction(id) {
  const res = await query(`SELECT * FROM salary_deductions WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function createSalaryDeduction(data) {
  const outstanding = Number(data.amount || 0) - Number(data.amount_deducted || 0);
  const res = await query(`INSERT INTO salary_deductions (employee_name, salary_month, deduction_type, description, amount, amount_deducted, outstanding, related_id, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [data.employee_name, data.salary_month, data.deduction_type, data.description || null, data.amount || 0, data.amount_deducted || 0, outstanding, data.related_id || null, data.status || 'Pending', data.notes || null]);
  return res.rows[0];
}

async function updateSalaryDeduction(id, patch) {
  const fields = []; const vals = []; let idx = 1;
  for (const k of ['description', 'amount', 'amount_deducted', 'outstanding', 'status', 'notes']) {
    if (patch[k] !== undefined) { fields.push(`${k} = $${idx++}`); vals.push(patch[k]); }
  }
  if (fields.length === 0) return getSalaryDeduction(id);
  fields.push(`updated_at = NOW()`); vals.push(id);
  await query(`UPDATE salary_deductions SET ${fields.join(', ')} WHERE id = $${idx}`, vals);
  return getSalaryDeduction(id);
}

async function deleteSalaryDeduction(id) {
  await query(`DELETE FROM salary_deductions WHERE id = $1`, [id]);
}

async function getSalaryDeductionsForMonth(employeeName, salaryMonth) {
  const res = await query(`SELECT * FROM salary_deductions WHERE employee_name = $1 AND salary_month = $2 ORDER BY id ASC`, [employeeName, salaryMonth]);
  return res.rows;
}

// ── Water Invoice ────────────────────────────────────────────────────────────

async function generateWaterInvoiceNumber() {
  return nextCounterNumber('invoice_counters', 'GEHPM-WTR');
}

async function createWaterInvoice(data) {
  if (data.client_txn_id) {
    const existing = await findRecordByClientTxnId('water_invoices', data.client_txn_id);
    if (existing) return { ...existing, _idempotentReplay: true };
  }
  const wtrNumber = await generateWaterInvoiceNumber();
  const unitsUsed = Number(data.current_reading || 0) - Number(data.previous_reading || 0);
  if (unitsUsed < 0) throw new Error('Current reading must be >= previous reading');
  const waterBill = unitsUsed * Number(data.rate_per_unit || 0);
  const rentAmount = Number(data.rent_amount || 0);
  const garbageFee = Number(data.garbage_fee || 0);
  const rentArrears = Number(data.rent_arrears || 0);
  const waterArrears = Number(data.water_arrears || 0);
  const garbageArrears = Number(data.garbage_arrears || 0);
  const otherArrears = Number(data.other_arrears || 0);
  const totalPreviousOutstanding = rentArrears + waterArrears + garbageArrears + otherArrears;
  const totalCurrentCharges = rentAmount + waterBill + garbageFee;
  const totalAmountPayable = totalCurrentCharges + totalPreviousOutstanding;
  const totalAmount = totalAmountPayable;
  const res = await query(
    `INSERT INTO water_invoices
       (wtr_number, tenant_code, tenant_name, property_name, house_paybill_number,
        unit_label, billing_month, payment_month, previous_reading, current_reading,
        units_used, rate_per_unit, total_amount, due_date, status, payment_terms, notes,
        rent_amount, garbage_fee, rent_arrears, water_arrears, garbage_arrears, other_arrears,
        total_previous_outstanding, total_amount_payable, client_txn_id,
        anomaly_flag, anomaly_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
     RETURNING *`,
    [
      wtrNumber, data.tenant_code, data.tenant_name || '', data.property_name || '',
      data.house_paybill_number || null, data.unit_label || '', data.billing_month,
      data.payment_month || null,
      Number(data.previous_reading || 0), Number(data.current_reading || 0),
      unitsUsed, Number(data.rate_per_unit || 0), totalAmount,
      data.due_date || null, data.status || 'Draft', data.payment_terms || null, data.notes || null,
      rentAmount, garbageFee, rentArrears, waterArrears, garbageArrears, otherArrears,
      totalPreviousOutstanding, totalAmountPayable,
      data.client_txn_id || null,
      data.anomaly_flag || null, data.anomaly_detail || null,
    ]
  );
  return res.rows[0];
}

async function getWaterInvoice(id) {
  const res = await query(`SELECT *, due_date::text AS due_date FROM water_invoices WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function listWaterInvoices(filters = {}) {
  let where = [];
  let params = [];
  let idx = 1;
  if (filters.tenant_code) { where.push(`tenant_code = $${idx++}`); params.push(filters.tenant_code); }
  if (filters.house_paybill_number) { where.push(`house_paybill_number = $${idx++}`); params.push(filters.house_paybill_number); }
  if (filters.status) { where.push(`status = $${idx++}`); params.push(filters.status); }
  if (filters.billing_month) { where.push(`billing_month = $${idx++}`); params.push(filters.billing_month); }
  if (filters.q) {
    where.push(`(wtr_number ILIKE $${idx} OR tenant_name ILIKE $${idx} OR unit_label ILIKE $${idx})`);
    params.push(`%${filters.q}%`);
    idx++;
  }
  const whereClause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const res = await query(
    `SELECT *, due_date::text AS due_date FROM water_invoices${whereClause} ORDER BY created_at DESC`,
    params
  );
  return res.rows;
}

async function updateWaterInvoice(id, patch) {
  const existing = await getWaterInvoice(id);
  if (!existing) return null;

  const prev = {
    previous_reading: patch.previous_reading != null ? Number(patch.previous_reading) : Number(existing.previous_reading),
    current_reading: patch.current_reading != null ? Number(patch.current_reading) : Number(existing.current_reading),
    rate_per_unit: patch.rate_per_unit != null ? Number(patch.rate_per_unit) : Number(existing.rate_per_unit),
    rent_amount: patch.rent_amount != null ? Number(patch.rent_amount) : Number(existing.rent_amount),
    garbage_fee: patch.garbage_fee != null ? Number(patch.garbage_fee) : Number(existing.garbage_fee),
    rent_arrears: patch.rent_arrears != null ? Number(patch.rent_arrears) : Number(existing.rent_arrears),
    water_arrears: patch.water_arrears != null ? Number(patch.water_arrears) : Number(existing.water_arrears),
    garbage_arrears: patch.garbage_arrears != null ? Number(patch.garbage_arrears) : Number(existing.garbage_arrears),
    other_arrears: patch.other_arrears != null ? Number(patch.other_arrears) : Number(existing.other_arrears),
  };
  const unitsUsed = prev.current_reading - prev.previous_reading;
  if (unitsUsed < 0) throw new Error('Current reading must be >= previous reading');
  const waterBill = unitsUsed * prev.rate_per_unit;
  const totalPreviousOutstanding = prev.rent_arrears + prev.water_arrears + prev.garbage_arrears + prev.other_arrears;
  const totalCurrentCharges = prev.rent_amount + waterBill + prev.garbage_fee;
  const totalAmountPayable = totalCurrentCharges + totalPreviousOutstanding;

  const fields = [];
  const vals = [];
  let idx = 1;
  const allowed = ['tenant_code', 'tenant_name', 'property_name', 'house_paybill_number', 'unit_label',
    'billing_month', 'payment_month', 'due_date', 'status', 'payment_terms', 'notes'];
  for (const k of allowed) {
    if (patch[k] !== undefined) { fields.push(`${k} = $${idx++}`); vals.push(patch[k]); }
  }
  fields.push(`previous_reading = $${idx++}`); vals.push(prev.previous_reading);
  fields.push(`current_reading = $${idx++}`); vals.push(prev.current_reading);
  fields.push(`units_used = $${idx++}`); vals.push(unitsUsed);
  fields.push(`rate_per_unit = $${idx++}`); vals.push(prev.rate_per_unit);
  fields.push(`rent_amount = $${idx++}`); vals.push(prev.rent_amount);
  fields.push(`garbage_fee = $${idx++}`); vals.push(prev.garbage_fee);
  fields.push(`rent_arrears = $${idx++}`); vals.push(prev.rent_arrears);
  fields.push(`water_arrears = $${idx++}`); vals.push(prev.water_arrears);
  fields.push(`garbage_arrears = $${idx++}`); vals.push(prev.garbage_arrears);
  fields.push(`other_arrears = $${idx++}`); vals.push(prev.other_arrears);
  fields.push(`total_previous_outstanding = $${idx++}`); vals.push(totalPreviousOutstanding);
  fields.push(`total_amount_payable = $${idx++}`); vals.push(totalAmountPayable);
  fields.push(`total_amount = $${idx++}`); vals.push(totalAmountPayable);
  fields.push(`updated_at = NOW()`); vals.push(id);

  const res = await query(
    `UPDATE water_invoices SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return res.rows[0] || null;
}

async function voidWaterInvoice(id, reason) {
  const res = await query(
    `UPDATE water_invoices SET status = 'Void', void_reason = $1, updated_at = NOW() WHERE id = $2 AND status != 'Paid' RETURNING *`,
    [reason || 'Voided', id]
  );
  return res.rows[0] || null;
}

// ─── Agent commissions (per house, per month) ───────────────────────────────
// commission = rate% × (collected − deposit − garbage − water)
// landlord payout = collected − commission
// Component splits come from the allocation persisted at approval time
// (payments.allocation_breakdown). Payments approved before that column
// existed fall back to treating the full amount as commissionable rent.

async function getCommissionRates() {
  const res = await query(`SELECT house_paybill_number, rate_percent FROM commission_rates`);
  const out = {};
  for (const r of res.rows) out[r.house_paybill_number] = Number(r.rate_percent || 0);
  return out;
}

async function setCommissionRate(housePaybill, ratePercent, updatedBy) {
  const rate = Math.max(0, Math.min(100, Number(ratePercent || 0)));
  await query(
    `INSERT INTO commission_rates (house_paybill_number, rate_percent, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (house_paybill_number) DO UPDATE SET rate_percent = $2, updated_by = $3, updated_at = NOW()`,
    [housePaybill, rate, updatedBy || null]
  );
  return { house_paybill_number: housePaybill, rate_percent: rate };
}

async function getCommissionReport(month, housePaybill = null) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) {
    throw new Error('month must be YYYY-MM');
  }
  const houses = await listHouses({});
  const rates = await getCommissionRates();
  const params = [month];
  let houseFilter = '';
  if (housePaybill) {
    houseFilter = ' AND t.house_paybill_number = $2';
    params.push(housePaybill);
  }
  const res = await query(
    `SELECT p.id, p.amount, p.payment_type, p.allocation_breakdown,
            t.house_paybill_number, t.property_name
     FROM payments p
     JOIN tenants t ON t.tenant_code = p.tenant_code
     WHERE p.status = 'Approved' AND p.billing_period = $1${houseFilter}
     ORDER BY p.approved_at`,
    params
  );
  const byHouse = {};
  const ensure = (hp, name) => {
    if (!byHouse[hp]) {
      byHouse[hp] = {
        house_paybill_number: hp,
        property_name: name || '',
        collected: 0, deposit: 0, garbage: 0, water: 0,
        payment_count: 0,
      };
    }
    return byHouse[hp];
  };
  for (const h of houses) {
    if (housePaybill && h.paybill_number !== housePaybill) continue;
    ensure(h.paybill_number, h.house_name);
  }
  for (const p of res.rows) {
    const hp = p.house_paybill_number || 'UNASSIGNED';
    const row = ensure(hp, p.property_name);
    const amount = Number(p.amount || 0);
    row.collected += amount;
    row.payment_count += 1;
    let alloc = null;
    try { alloc = typeof p.allocation_breakdown === 'string' ? JSON.parse(p.allocation_breakdown) : p.allocation_breakdown; } catch (_) { alloc = null; }
    if (p.payment_type === 'deposit') {
      row.deposit += amount;
    } else if (alloc) {
      row.deposit += Number(alloc.depositSettled || 0);
      row.garbage += Number(alloc.garbageFeeSettled || 0);
      row.water += Number(alloc.waterSettled || 0);
    }
    // No stored allocation (pre-column approvals): full amount counts as rent.
  }
  const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const rows = Object.values(byHouse).map((r) => {
    const commissionable = Math.max(0, r.collected - r.deposit - r.garbage - r.water);
    const rate = Number(rates[r.house_paybill_number] || 0);
    const commission = round2((commissionable * rate) / 100);
    return {
      house_paybill_number: r.house_paybill_number,
      property_name: r.property_name,
      payment_count: r.payment_count,
      collected: round2(r.collected),
      deposit: round2(r.deposit),
      garbage: round2(r.garbage),
      water: round2(r.water),
      commissionable: round2(commissionable),
      rate_percent: rate,
      commission,
      landlord_payout: round2(r.collected - commission),
    };
  }).sort((a, b) => String(a.property_name).localeCompare(String(b.property_name)));
  const totals = rows.reduce((s, r) => ({
    collected: s.collected + r.collected,
    deposit: s.deposit + r.deposit,
    garbage: s.garbage + r.garbage,
    water: s.water + r.water,
    commissionable: s.commissionable + r.commissionable,
    commission: s.commission + r.commission,
    landlord_payout: s.landlord_payout + r.landlord_payout,
    payment_count: s.payment_count + r.payment_count,
  }), { collected: 0, deposit: 0, garbage: 0, water: 0, commissionable: 0, commission: 0, landlord_payout: 0, payment_count: 0 });
  for (const k of Object.keys(totals)) {
    if (k !== 'payment_count') totals[k] = round2(totals[k]);
  }
  return { month, rows, totals };
}

async function deleteWaterInvoice(id) {
  await query(`DELETE FROM water_invoices WHERE id = $1 AND status NOT IN ('Paid','Void')`, [id]);
}

async function getWaterRate(housePaybill) {
  const res = await query(`SELECT water_rate_per_unit FROM houses WHERE paybill_number = $1`, [housePaybill]);
  return res.rows[0] ? Number(res.rows[0].water_rate_per_unit) : 0;
}

async function updateWaterRate(housePaybill, newRate, effectiveMonth, changedBy) {
  const oldRes = await query(`SELECT water_rate_per_unit FROM houses WHERE paybill_number = $1`, [housePaybill]);
  const oldRate = oldRes.rows[0] ? Number(oldRes.rows[0].water_rate_per_unit) : 0;

  await query(`UPDATE houses SET water_rate_per_unit = $1 WHERE paybill_number = $2`, [newRate, housePaybill]);
  await query(
    `INSERT INTO water_rate_history (house_paybill, old_rate, new_rate, effective_month, changed_by) VALUES ($1,$2,$3,$4,$5)`,
    [housePaybill, oldRate, newRate, effectiveMonth, changedBy]
  );
  return { old_rate: oldRate, new_rate: newRate };
}

async function getWaterRateHistory(housePaybill) {
  const res = await query(
    `SELECT * FROM water_rate_history WHERE house_paybill = $1 ORDER BY changed_at DESC`,
    [housePaybill]
  );
  return res.rows;
}

async function getLatestWaterReading(tenantCode) {
  const res = await query(
    `SELECT current_reading FROM water_invoices WHERE tenant_code = $1 AND tenancy_id IS NULL ORDER BY created_at DESC LIMIT 1`,
    [tenantCode]
  );
  return res.rows[0] ? Number(res.rows[0].current_reading) : 0;
}

/** Recent per-bill consumption figures (most recent first) for anomaly checks. */
async function getRecentWaterUnits(tenantCode, n = 6) {
  const res = await query(
    `SELECT (current_reading - previous_reading) AS units FROM water_invoices
     WHERE tenant_code = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantCode, Number(n) || 6]
  );
  return res.rows.map((r) => Number(r.units)).filter((u) => Number.isFinite(u) && u >= 0);
}

// ─── Water Bill Report (read-only reporting over recorded invoices) ─────────
// One row per unit of the property for the billing month. Vacant units are
// NEVER excluded: without a fresh invoice they carry forward their last
// known reading (previous = current, consumption 0); caretaker/construction
// use recorded in an invoice still computes normally from its readings.
async function buildWaterBillReport({ house_paybill, billing_month, unit = null }) {
  if (!house_paybill) throw new Error('house_paybill required');
  if (!/^\d{4}-\d{2}$/.test(String(billing_month || ''))) throw new Error('billing_month must be YYYY-MM');
  const house = await getHouse(house_paybill);
  if (!house) throw new Error('Property not found');
  const houseRate = Number(house.water_rate_per_unit || 0);

  const tenantRes = await query(
    `SELECT tenant_code, name, unit_label, status FROM tenants WHERE house_paybill_number = $1`,
    [house_paybill]
  );
  const invRes = await query(
    `SELECT * FROM water_invoices WHERE house_paybill_number = $1 AND billing_month <= $2 ORDER BY billing_month DESC, created_at DESC`,
    [house_paybill, billing_month]
  );
  const monthInvoices = invRes.rows.filter((r) => r.billing_month === billing_month);
  const keyOf = (r) => String(r.unit_label || r.tenant_code || '').toUpperCase();
  const latestByUnit = {};
  for (const r of invRes.rows) {
    const key = keyOf(r);
    if (key && !latestByUnit[key]) latestByUnit[key] = r;
  }
  const tenantByUnit = {};
  for (const t of tenantRes.rows) {
    const key = String(t.unit_label || t.tenant_code || '').toUpperCase();
    if (key) tenantByUnit[key] = t;
  }
  const unitKeys = [...new Set([
    ...Object.keys(tenantByUnit),
    ...Object.keys(latestByUnit),
  ])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const wanted = unit ? String(unit).toUpperCase() : null;

  const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const rows = [];
  for (const key of unitKeys) {
    if (wanted && key !== wanted) continue;
    const tenant = tenantByUnit[key] || null;
    const occupied = !!tenant && String(tenant.status || '') !== 'Vacant';
    const inv = monthInvoices.find((r) =>
      String(r.unit_label || '').toUpperCase() === key ||
      String(r.tenant_code || '').toUpperCase() === key
    ) || null;
    let previous, current, rate, usageNote;
    if (inv) {
      previous = Number(inv.previous_reading || 0);
      current = Number(inv.current_reading || 0);
      rate = Number(inv.rate_per_unit || 0) || houseRate;
      usageNote = !occupied && inv.notes ? String(inv.notes) : null;
    } else {
      const last = latestByUnit[key];
      const baseline = last ? Number(last.current_reading || 0) : 0;
      previous = baseline;
      current = baseline;
      rate = (last && Number(last.rate_per_unit || 0)) || houseRate;
      usageNote = null;
    }
    const consumption = round2(Math.max(0, current - previous));
    rows.push({
      unit: tenant?.unit_label || inv?.unit_label || key,
      tenant_name: occupied ? (tenant.name || '') : '',
      occupancy: occupied ? 'Occupied' : 'Vacant',
      previous_reading: round2(previous),
      current_reading: round2(current),
      consumption,
      rate_per_unit: round2(rate),
      water_charge: round2(consumption * rate),
      usage_note: usageNote,
      has_invoice: !!inv,
    });
  }
  const totals = rows.reduce((s, r) => ({
    total_units: s.total_units + 1,
    occupied_units: s.occupied_units + (r.occupancy === 'Occupied' ? 1 : 0),
    vacant_units: s.vacant_units + (r.occupancy === 'Vacant' ? 1 : 0),
    total_consumption: round2(s.total_consumption + r.consumption),
    total_water_charges: round2(s.total_water_charges + r.water_charge),
  }), { total_units: 0, occupied_units: 0, vacant_units: 0, total_consumption: 0, total_water_charges: 0 });
  const [yr, mo] = billing_month.split('-').map(Number);
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return {
    property_name: house.house_name || '',
    house_paybill_number: house_paybill,
    billing_month,
    billing_month_label: `${monthNames[mo - 1]} ${yr}`,
    water_rate: houseRate,
    generated_at: new Date().toISOString(),
    rows,
    totals,
  };
}

async function findTenantByPropertyAndUnit(housePaybill, unitLabel) {
  const res = await query(
    `SELECT t.tenant_code AS id, t.tenant_code, t.name, t.phone_number, t.house_paybill_number AS house_id,
            t.property_name, t.unit_label, t.rent_amount, t.status
     FROM tenants t
     WHERE t.house_paybill_number = $1
       AND (t.unit_label = $2 OR t.tenant_code ILIKE $2)
       AND t.status IN ('Active', 'Paid')
     ORDER BY CASE WHEN t.unit_label = $2 THEN 0 ELSE 1 END
     LIMIT 1`,
    [housePaybill, unitLabel]
  );
  return res.rows[0] || null;
}

async function getTenantInvoiceData(tenantCode) {
  const res = await query(
    `SELECT tenant_code, name, property_name, unit_label, house_paybill_number,
            rent_amount, garbage_fee_amount, arrears, arrears_manually_set
     FROM tenants WHERE tenant_code = $1`,
    [tenantCode]
  );
  return res.rows[0] || null;
}

module.exports = {
  init,
  findUserByUsername,
  findUserById,
  updateUser,
  listUsers,
  createUser,
  deleteUser,
  listHouses,
  getHouse,
  createHouse,
  updateHouse,
  deleteHouse,
  listTenants,
  getTenant,
  createTenant,
  updateTenant,
  deleteTenant,
  markUnitVacant,
  listPayments,
  findPaymentByReference,
  findPaymentById,
  findPaymentByClientTxnId,
  findRecordByClientTxnId,
  findMessageByClientTxnId,
  createInspection,
  listInspections,
  createMediaAttachment,
  listMediaAttachments,
  recordSyncConflict,
  listSyncConflicts,
  resolveSyncConflict,
  getConflictResolutions,
  createPayment,
  approvePayment,
  recalculateAll,
  syncHistoricalPayments,
  reconcileTenant,
  reconcileAllTenants,
  getDepositApplicationPreview,
  applyDepositToRent,
  recordRentLoss,
  getDepositApplications,
  getPropertyCollectionReport,
  deletePayment,
  getDashboardMetrics,
  getDashboardDrilldown,
  logMessage,
  getPaymentDeliveryStatus,
  updateMessageDelivery,
  tenantsDueInDays,
  findTenantsForPaymentLookup,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getOutstandingBalances,
  getUnpaidUnits,
  getDepositsAndNewTenants,
  getTenantExitSummary,
  rolloverMonth,
  rolloverBody,
  getLastRolloverMonth,
  getLastRolloverAt,
  getLastReminderMonth,
  setLastReminderMonth,
  listPenalties,
  getPenalty,
  createPenalty,
  payPenalty,
  deletePenalty,
  getOutstandingPenalties,
  listPendingPenalties,
  payPenaltiesFromPayment,
  createArrangement,
  getArrangement,
  getArrangementHistory,
  describeArrangement,
  listArrangements,
  transitionArrangement,
  closeArrangementsForVacancy,
  allocateAdvanceRent,
  allocateCreditBalance,
  applyCreditBalance,
  createPendingOverpayment,
  getPendingOverpayment,
  listPendingOverpayments,
  skipOverpayment,
  resolvePendingOverpayment,
  seedOpeningAdvance,
  logAudit,
  listAuditLog,
  addMonths,
  generateReceiptNumber,
  generateLetterNumber,
  generateInvoiceNumber,
  generateStatementNumber,
  generateMaintenanceInvoiceNumber,
  generateWorkOrderNumber,
  createDocument,
  updateLetterDraft,
  finalizeLetterDocument,
  markLetterDelivery,
  getDocument,
  findReceiptDocument,
  updateReceiptDocument,
  listDocuments,
  deleteDocument,
  createInvoiceRegister,
  voidTenantInvoices,
  updateInvoiceRegister,
  deleteInvoiceRegister,
  reuseInvoiceDocument,
  getInvoiceRegister,
  getInvoiceRegisterByDocument,
  getInvoiceRegisterByNumber,
  listInvoiceRegister,
  listInvoiceRegisterMonthly,
  markInvoiceRegister,
  getTenantStatement,
  getRentInvoiceData,
  createWorkOrder,
  getWorkOrder,
  listWorkOrders,
  updateWorkOrder,
  deleteWorkOrder,
  createMaintenanceChargesFromWO,
  updateChargeRecovery,
  buildMonthlyReportData,
  generateMonthlyReport,
  closeMonthlyReport,
  closeAllMonthlyReports,
  listMonthlyReports,
  getMonthlyReport,
  createMaintenanceInvoice,
  getMaintenanceInvoice,
  listMaintenanceInvoices,
  updateMaintenanceInvoice,
  deleteMaintenanceInvoice,
  getReceiptMode,
  setReceiptMode,
  resetTestReceipts,
  getPaymentInstructionsText,
  getApprovedPaymentCount,
  hasApprovedRentPaymentFor,
  generateExitInvoiceNumber,
  createExitInvoice,
  getExitInvoice,
  listExitInvoices,
  updateExitInvoice,
  finalizeExitInvoice,
  deleteExitInvoice,
  archiveTenancy,
  getTenancyArchive,
  getTenancyPaymentHistory,
  searchArchive,
  deleteArchive,
  getOccupancyHistory,
  vacateTenancy,
  resetTenancyFinancials,
  recordNoticeToVacate,
  recordExpensePayment,
  getExpensePayments,
  deleteExpensePayment,
  listSalaryRecords,
  getSalaryRecord,
  createSalaryRecord,
  updateSalaryRecord,
  deleteSalaryRecord,
  recordSalaryPayment,
  getSalaryPayments,
  deleteSalaryPayment,
  rollOverSalaries,
  getSalaryHistory,
  listSalaryEmployees,
  listStaffAdvances,
  getStaffAdvance,
  createStaffAdvance,
  updateStaffAdvance,
  deleteStaffAdvance,
  recordStaffAdvancePayment,
  getStaffAdvancePayments,
  deleteStaffAdvancePayment,
  listStaffAdvanceEmployees,
  listEmployeeRent,
  getEmployeeRent,
  createEmployeeRent,
  updateEmployeeRent,
  deleteEmployeeRent,
  recordEmployeeRentPayment,
  getEmployeeRentPayments,
  deleteEmployeeRentPayment,
  deductRentFromSalary,
  listEmployeeRentEmployees,
  listSalaryDeductions,
  getSalaryDeduction,
  createSalaryDeduction,
  updateSalaryDeduction,
  deleteSalaryDeduction,
  getSalaryDeductionsForMonth,
  listDepositRefunds,
  getDepositRefund,
  getDepositRefundByExitInvoice,
  updateDepositRefund,
  recordDepositRefund,
  getDepositRefundSummary,
  createDepositRefund,
  getManagementExpensesReport,
  getPropertyExpenseReport,
  getEligibleManagementExpenses,
  createManagementExpenseFromWO,
  unlinkManagementExpenseCharges,
  buildEnhancedMonthlyReport,

  // Water invoice
  generateWaterInvoiceNumber,
  createWaterInvoice,
  getWaterInvoice,
  listWaterInvoices,
  updateWaterInvoice,
  voidWaterInvoice,
  deleteWaterInvoice,
  getWaterRate,
  updateWaterRate,
  getWaterRateHistory,
  getLatestWaterReading,
  getHouseCollectionPosition,
  sealTenancyRows,
  sealStrayTenancyRows,
  validateTenancyForFinancials,
  getRecentWaterUnits,
  buildWaterBillReport,
  findTenantByPropertyAndUnit,
  getTenantInvoiceData,
  getCommissionRates,
  setCommissionRate,
  getCommissionReport,
  getPeriodCollections,
  getOtherPropertyExpenses,
  getTenantChargeSummary,
  buildLandlordPack,
  listOutstandingRegisterInvoices,
  applyPaymentToInvoices,
  reverseInvoiceLinks,
};
