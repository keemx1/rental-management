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
  return res.rows.map(r => ({ ...r, rent_amount: Number(r.rent_amount), arrears: Number(r.arrears || 0), deposit_amount: Number(r.deposit_amount || 0), deposit_paid: Number(r.deposit_paid || 0), garbage_fee_amount: Number(r.garbage_fee_amount || 0), garbage_fee_paid: Number(r.garbage_fee_paid || 0), water_charge_amount: Number(r.water_charge_amount || 0), water_charge_paid: Number(r.water_charge_paid || 0), rent_paid_this_month: Number(r.rent_paid_this_month || 0), credit_balance: Number(r.credit_balance || 0), advance_rent_balance: Number(r.advance_rent_balance || 0), opening_advance_rent: Number(r.opening_advance_rent || 0) }));
}

async function getTenant(id, run) {
  const res = await runOrQuery(run,
    `SELECT t.tenant_code AS id, t.tenant_code, t.name, t.phone_number, t.national_id, t.house_paybill_number AS house_id, t.property_name, t.unit_label, t.rent_amount, t.arrears, t.deposit_amount, t.deposit_paid, t.garbage_fee_amount, t.garbage_fee_paid, t.water_charge_amount, t.water_charge_paid, t.rent_paid_this_month, t.credit_balance, t.advance_rent_until::text AS advance_rent_until, t.advance_rent_balance, t.opening_advance_rent, t.move_in_date::text AS move_in_date, t.move_out_date::text AS move_out_date, t.notice_to_vacate_date::text AS notice_to_vacate_date, t.exit_reason, t.rent_due_date::text AS rent_due_date, t.rent_due_time, t.status, t.created_at, t.updated_at, t.guardian_name, t.guardian_id, t.guardian_phone, t.guardian_relationship, t.standard_monthly_rent, t.first_billing_method, t.first_billing_charge, t.first_billing_reason, t.first_billing_days, h.payment_method, h.payment_paybill, h.account_number_format, h.till_number, h.till_name
     FROM tenants t LEFT JOIN houses h ON t.house_paybill_number = h.paybill_number WHERE t.tenant_code = $1`,
    [id]
  );
  if (!res.rows[0]) return null;
  return { ...res.rows[0], rent_amount: Number(res.rows[0].rent_amount), arrears: Number(res.rows[0].arrears || 0), deposit_amount: Number(res.rows[0].deposit_amount || 0), deposit_paid: Number(res.rows[0].deposit_paid || 0), garbage_fee_amount: Number(res.rows[0].garbage_fee_amount || 0), garbage_fee_paid: Number(res.rows[0].garbage_fee_paid || 0), water_charge_amount: Number(res.rows[0].water_charge_amount || 0), water_charge_paid: Number(res.rows[0].water_charge_paid || 0), rent_paid_this_month: Number(res.rows[0].rent_paid_this_month || 0), credit_balance: Number(res.rows[0].credit_balance || 0), advance_rent_balance: Number(res.rows[0].advance_rent_balance || 0), opening_advance_rent: Number(res.rows[0].opening_advance_rent || 0) };
}

async function createTenant(data) {
  let property_name = data.property_name || 'General';
  let garbageFeeEnabled = false;
  if (data.house_id) {
    const house = await getHouse(data.house_id);
    if (house) {
      property_name = house.house_name;
      garbageFeeEnabled = house.garbage_fee_enabled === true || house.garbage_fee_enabled === 't';
    }
  }
  
  const garbageFeeAmount = data.garbage_fee_amount != null && Number(data.garbage_fee_amount) > 0
    ? Number(data.garbage_fee_amount)
    : (garbageFeeEnabled ? 2000 : 0);

  const openingArrears = Number(data.arrears || data.opening_arrears || 0);
  const openingAdvance = Number(data.opening_advance_rent || 0);
  if (openingArrears > 0 && openingAdvance > 0) {
    throw new Error('A tenant cannot have both Opening Arrears and Opening Advance Rent at the same time');
  }

  const res = await query(
    `INSERT INTO tenants (tenant_code, name, phone_number, national_id, house_paybill_number, property_name, rent_amount, deposit_amount, garbage_fee_amount, water_charge_amount, move_in_date, rent_due_date, rent_due_time, status, arrears, opening_advance_rent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
      Number(data.water_charge_amount) || 0,
      data.move_in_date || null,
      data.rent_due_date,
      data.rent_due_time || '23:59:00',
      data.status || 'Active',
      openingArrears,
      openingAdvance
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

async function deleteTenant(id) {
  const res = await query('DELETE FROM tenants WHERE tenant_code = $1', [id]);
  return res.rowCount > 0;
}

async function markUnitVacant(tenantCode) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;

  await query('DELETE FROM payments WHERE tenant_code = $1', [tenantCode]);
  await query('DELETE FROM penalties WHERE tenant_code = $1', [tenantCode]);

  const res = await query(
    `UPDATE tenants SET
       name = '', phone_number = '', status = 'Vacant',
       arrears = 0, deposit_paid = 0, garbage_fee_paid = 0, rent_paid_this_month = 0,
       credit_balance = 0, advance_rent_until = NULL, advance_rent_balance = 0,
       opening_advance_rent = 0,
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
  let q = `
    SELECT p.*, p.tenant_code AS tenant_id, p.payment_date::text AS payment_date, t.name AS tenant_name, t.tenant_code
    FROM payments p
    LEFT JOIN tenants t ON p.tenant_code = t.tenant_code
    WHERE 1=1
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

async function createPayment(data) {
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const res = await query(
    `INSERT INTO payments (tenant_code, amount, mpesa_reference, status, payment_date, notes, payment_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *, tenant_code AS tenant_id, payment_date::text AS payment_date`,
    [
      String(data.tenant_id),
      Number(data.amount),
      data.mpesa_reference || null,
      data.status || 'Pending',
      data.payment_date || todayISO(),
      data.notes || null,
      data.payment_type || 'rent'
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

    // Compute billing_period from tenant's ledger position, not just payment date.
    // Rule: payment date ≠ billing period. Allocate to the next unpaid cycle.
    const preRes = await run(`SELECT payment_type, payment_date::text AS payment_date, amount, tenant_code FROM payments WHERE id = $1`, [id]);
    const prePay = preRes.rows[0];
    const paymentMonth = prePay ? monthKey(prePay.payment_date) : new Date().toISOString().slice(0, 7);
    let billingPeriod = paymentMonth;

    if (prePay && prePay.payment_type === 'advance_rent') {
      // Explicit advance rent → next month
      billingPeriod = nextMonthKey(paymentMonth);
    } else if (prePay && prePay.payment_type !== 'deposit') {
      // Regular rent payment → allocate to next unpaid billing period.
      // Rule: payment date ≠ billing period. Check the tenant's ledger
      // to find which month this payment should cover.
      const tenantForAlloc = await getTenant(prePay.tenant_code, run);
      if (tenantForAlloc) {
        const rentAmount = Number(tenantForAlloc.rent_amount || 0);

        // Check if the current billing period is already covered
        const currentMonthPaidRes = await run(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
           WHERE tenant_code = $1 AND status = 'Approved'
             AND (billing_period = $2 OR (billing_period IS NULL AND payment_date >= $3 AND payment_date < $4))`,
          [prePay.tenant_code, currentMonth, `${currentMonth}-01`, `${nextMonthKey(currentMonth)}-01`]
        );
        const currentMonthPaid = Number(currentMonthPaidRes.rows[0]?.total || 0);
        const currentCoveredByPayments = currentMonthPaid >= rentAmount && rentAmount > 0;
        const currentCoveredByAdvance = isAdvanceCoveringMonth(tenantForAlloc, currentMonth);

        if (currentCoveredByPayments || currentCoveredByAdvance) {
          // Current month is paid — find the next unpaid month
          let candidate = nextMonthKey(currentMonth);
          for (let i = 0; i < 12; i++) {
            const alreadyPaid = await run(
              `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
               WHERE tenant_code = $1 AND status = 'Approved'
                 AND (billing_period = $2 OR (billing_period IS NULL AND payment_date >= $3 AND payment_date < $4))`,
              [prePay.tenant_code, candidate, `${candidate}-01`, `${nextMonthKey(candidate)}-01`]
            );
            const paidForMonth = Number(alreadyPaid.rows[0]?.total || 0);
            const advanceCovers = isAdvanceCoveringMonth(tenantForAlloc, candidate);
            if (paidForMonth < rentAmount && !advanceCovers) {
              billingPeriod = candidate;
              break;
            }
            candidate = nextMonthKey(candidate);
          }
        } else {
          // Current month is NOT paid — allocate to current month (not payment month)
          billingPeriod = currentMonth;
        }
      }
    }

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

      // 8) Deposit — new tenancy only (settled before any overpayment)
      if (onboarding && depositShortfall > 0 && remaining > 0) {
        const settle = Math.min(depositShortfall, remaining);
        depositPaid += settle;
        depositSettled = settle;
        remaining -= settle;
      }

      // Deposit is only settled during onboarding; for regular payments it is
      // only ever settled by a payment explicitly intended for deposit.

      const newRentPaidThisMonth = rentPaidThisMonth + rentSettled;

      await updateTenant(tenant.id, {
        deposit_paid: Math.min(depositPaid, depositAmount),
        garbage_fee_paid: Math.min(garbageFeePaid, garbageFeeAmount),
        water_charge_paid: Math.min(waterChargePaid, waterChargeAmount),
        arrears: Math.max(0, arrears),
        rent_paid_this_month: newRentPaidThisMonth,
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
        rentDue: remainingRentForMonth,
        rentAmount,
        rentPaidBefore: rentPaidThisMonth,
        penaltiesBefore: penaltyBefore + maintenanceBefore + otherBefore,
        penaltyBefore,
        maintenanceBefore,
        otherBefore,
        depositSettled,
        arrearsSettled,
        garbageFeeSettled,
        waterSettled,
        rentSettled,
        penaltySettled,
        maintenanceSettled,
        otherSettled,
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
    await run(`UPDATE payments SET overpayment_amount = $2 WHERE id = $1`, [id, overpayment]);

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

  // Re-run recalculateAll only for tenants that have approved payments.
  for (const t of tenants) {
    if (!t.tenant_code || t.approved_count === 0) continue;
    try {
      await recalculateAll(t.tenant_code);
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
            overpayment_amount, mpesa_reference, receipt_number
     FROM payments WHERE tenant_code = $1 AND status = 'Approved' ORDER BY payment_date ASC, id ASC`,
    [tenantCode]
  );
  const allPayments = payRes.rows;

  // Determine billing periods: current month and next month.
  // Past months are already settled by the rollover process — their arrears
  // are carried forward on the tenant record. Reconciling the future ensures
  // advance payments are properly applied without creating phantom arrears
  // for months that were already closed.
  const currentMonth = new Date().toISOString().slice(0, 7);
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

  // Seed the running advance balance from the tenant's current advance_rent_balance
  // (set by previous reconciliations and the rollover process).
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
     FROM deposit_applications WHERE tenant_code = $1 AND status = 'Active'
     GROUP BY billing_period`,
    [tenantCode]
  );
  const depositByPeriod = {};
  for (const r of daRes.rows) depositByPeriod[r.billing_period] = Number(r.total || 0);

  // Pre-fetch rent losses for all billing periods
  const lossRes = await query(
    `SELECT billing_period, COALESCE(SUM(rent_loss_amount), 0) AS total
     FROM deposit_applications WHERE tenant_code = $1 AND status = 'Active' AND rent_loss_amount > 0
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

    // Payments allocated to this billing period
    const periodPayments = (paymentsByPeriod[bp] || []);
    let paymentsApplied = 0;
    for (const p of periodPayments) {
      paymentsApplied += Number(p.amount || 0);
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
  const isCurrentPaid = currentStatus.startsWith('Paid');
  if (isCurrentPaid && existingArrears > 0) {
    // Check if the arrears correspond to a period that is now covered
    // by advance payments. If the payment for the arrears period was
    // actually an advance for the current month, the arrears are stale.
    const arrearsPayments = allPayments.filter(p => {
      const pMonth = monthKey(p.payment_date);
      return pMonth < currentMonth && Number(p.amount || 0) > 0;
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

  // Update tenant with reconciled values
  await updateTenant(tenantCode, {
    arrears: Math.max(0, existingArrears),
    rent_paid_this_month: Math.min(currentMonthPaid, rentAmount),
    advance_rent_balance: runningAdvance,
    advance_rent_until: runningAdvance > 0 ? `${currentMonth}-28` : null,
    status: tenantStatus,
  });

  return {
    tenant_code: tenantCode,
    status: tenantStatus,
    arrears: Math.max(0, existingArrears),
    rent_paid_this_month: Math.min(currentMonthPaid, rentAmount),
    current_month_outstanding: currentOutstanding,
    advance_balance: runningAdvance,
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
     WHERE tenant_code = $1 AND status = 'Approved' AND billing_period = $2`,
    [tenantCode, billingPeriod]
  );
  const paymentsApplied = Number(payRes.rows[0]?.total || 0);

  // Get existing deposit applications for this billing period
  const daRes = await query(
    `SELECT COALESCE(SUM(amount_applied), 0) AS total FROM deposit_applications
     WHERE tenant_code = $1 AND billing_period = $2 AND status = 'Active'`,
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
    `SELECT * FROM deposit_applications WHERE tenant_code = $1 ORDER BY created_at DESC`,
    [tenantCode]
  );
  return res.rows;
}

async function deletePayment(id) {
  const target = await query('SELECT * FROM payments WHERE id = $1', [id]);
  const deleted = target.rows[0];
  if (!deleted) return false;

  await query('DELETE FROM payments WHERE id = $1', [id]);

  if (deleted.status === 'Approved' && deleted.tenant_code) {
    await recalculateAll(deleted.tenant_code);
    // Reconcile after deletion to update status across all modules
    try {
      await reconcileTenant(deleted.tenant_code);
    } catch (err) {
      console.error(`[Reconcile] Post-deletion reconciliation failed for ${deleted.tenant_code}:`, err.message);
    }
  }

  return true;
}

async function recalculateAll(tenantCode) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return;

  // Unpay all penalties for this tenant
  await query(
    `UPDATE penalties SET status = 'Pending', paid_date = NULL, updated_at = NOW() WHERE tenant_code = $1 AND status = 'Paid'`,
    [tenantCode]
  );

  // Fetch all remaining approved payments in chronological order
  const payRes = await query(
    `SELECT * FROM payments WHERE tenant_code = $1 AND status = 'Approved' ORDER BY payment_date ASC, recorded_at ASC`,
    [tenantCode]
  );

  const rentAmount = Number(tenant.rent_amount);
  const depositAmount = Number(tenant.deposit_amount || 0);
  const garbageFeeAmount = Number(tenant.garbage_fee_amount || 0);

  let depositPaid = 0;
  let arrears = 0;
  let garbageFeePaid = 0;
  let rentPaidThisMonth = 0;

  for (const row of payRes.rows) {
    const amount = Number(row.amount);
    let remaining = amount;

    // 0) Deposit
    const depositShortfall = Math.max(0, depositAmount - depositPaid);
    if (depositShortfall > 0 && remaining > 0) {
      const settle = Math.min(depositShortfall, remaining);
      depositPaid += settle;
      remaining -= settle;
    }

    // 1) Arrears
    if (arrears > 0 && remaining > 0) {
      const settle = Math.min(arrears, remaining);
      arrears -= settle;
      remaining -= settle;
    }

    // 2) Garbage fee
    const garbageShortfall = Math.max(0, garbageFeeAmount - garbageFeePaid);
    if (garbageShortfall > 0 && remaining > 0) {
      const settle = Math.min(garbageShortfall, remaining);
      garbageFeePaid += settle;
      remaining -= settle;
    }

    // 3) Rent
    const remainingRent = Math.max(0, rentAmount - rentPaidThisMonth);
    if (remainingRent > 0 && remaining > 0) {
      const settle = Math.min(remainingRent, remaining);
      rentPaidThisMonth += settle;
      remaining -= settle;
    }

    // 4) Penalties (oldest first) — follow the same priority order as
    // approvePaymentOnce: penalty → maintenance → other
    if (remaining > 0) {
      const result = await payPenaltiesFromPayment(tenantCode, remaining, 'penalty');
      remaining = result.remaining;
    }
    if (remaining > 0) {
      const result = await payPenaltiesFromPayment(tenantCode, remaining, 'maintenance');
      remaining = result.remaining;
    }
    if (remaining > 0) {
      const result = await payPenaltiesFromPayment(tenantCode, remaining, 'other');
      remaining = result.remaining;
    }
  }

  await updateTenant(tenantCode, {
    deposit_paid: Math.min(depositPaid, depositAmount),
    garbage_fee_paid: Math.min(garbageFeePaid, garbageFeeAmount),
    arrears: Math.max(0, arrears),
    rent_paid_this_month: rentPaidThisMonth,
  });
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

  // Credit balance is untouched: it does NOT reduce the current month's rent
  // and is NOT applied automatically during monthly rollover. It remains until
  // management applies it on the tenant's instruction.
  await updateTenant(tenantCode, {
    credit_balance: newCredit,
  });

  return { creditBalance: newCredit };
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
}) {
  const res = await query(
    `INSERT INTO documents
       (doc_type, doc_number, title, filename, file_path, tenant_code, house_paybill_number, property_name, unit_label, amount, doc_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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

// ---- Permanent Invoice Register -----------------------------------------
// Every invoice generated by the system is recorded here immediately and
// never deleted. Download / WhatsApp-send events update the delivery status.

function mapInvoiceRegisterRow(r) {
  if (!r) return null;
  return {
    ...r,
    amount: r.amount != null ? Number(r.amount) : null,
    deposit_paid: r.deposit_paid != null ? Number(r.deposit_paid) : null,
    deposit_refund: r.deposit_refund != null ? Number(r.deposit_refund) : null,
    deductions_total: r.deductions_total != null ? Number(r.deductions_total) : null,
    final_refund: r.final_refund != null ? Number(r.final_refund) : null,
  };
}

async function createInvoiceRegister(data = {}) {
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
  await query(
    `INSERT INTO payments (tenant_code, amount, mpesa_reference, status, payment_date, notes, payment_type)
     VALUES ($1, $2, $3, 'Approved', CURRENT_DATE, $4, 'rent')`,
    [tenantCode, amount, `LEDGER-${type.toUpperCase()}-${Date.now()}`, description]
  );
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

async function getDashboardMetrics() {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  
  const addDaysISO = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const due7dLimit = addDaysISO(7);

  const houseStats = await query(`SELECT COALESCE(SUM(total_units), 0) AS total_units FROM houses`);
  const totalSystemUnits = Number(houseStats.rows[0].total_units) || 0;
  
  const tenantStats = await query(`
    SELECT 
      COUNT(*) FILTER (WHERE status != 'Vacant') AS total,
      COUNT(*) FILTER (WHERE status = 'Active') AS active,
      COUNT(*) FILTER (WHERE status = 'Overdue') AS overdue,
      COUNT(*) FILTER (WHERE status != 'Vacant' AND rent_due_date >= $1 AND rent_due_date <= $2) AS due_7d
    FROM tenants
  `, [today, due7dLimit]);
  
  const paymentStats = await query(`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE status = 'Approved' AND payment_date >= $1), 0) AS revenue_mtd,
      COALESCE(SUM(amount) FILTER (WHERE status = 'Pending'), 0) AS pending_amount,
      COUNT(*) FILTER (WHERE status = 'Pending') AS pending_count,
      COUNT(*) FILTER (WHERE status = 'Approved') AS paid_count
    FROM payments
  `, [monthStart]);
  
  const msgStats = await query(`
    SELECT COUNT(*) AS messages_today 
    FROM message_logs 
    WHERE logged_at::date = $1::date
  `, [today]);

  const arrearsStats = await query(`
    SELECT COALESCE(SUM(arrears), 0) AS total_arrears
    FROM tenants
    WHERE status != 'Vacant' AND arrears > 0
  `);
  
  const ts = tenantStats.rows[0];
  const ps = paymentStats.rows[0];
  const ms = msgStats.rows[0];
  const as = arrearsStats.rows[0];
  
  const occupiedUnits = parseInt(ts.total, 10) || 0;
  const vacantUnits = Math.max(0, totalSystemUnits - occupiedUnits);

  return {
    tenants: {
      total_tenants: occupiedUnits,
      active_tenants: parseInt(ts.active, 10),
      vacant_units: vacantUnits,
      overdue_tenants: parseInt(ts.overdue, 10),
      due_7d: parseInt(ts.due_7d, 10),
    },
    revenue: {
      revenue_mtd: Number(ps.revenue_mtd),
      pending_amount: Number(ps.pending_amount),
      pending_count: parseInt(ps.pending_count, 10),
      paid_count: parseInt(ps.paid_count, 10),
      total_arrears: Number(as.total_arrears),
    },
    messages_today: parseInt(ms.messages_today, 10),
  };
}

async function logMessage({ tenantId, messageType, messageBody, status, whatsappMessageId, failureReason }) {
  const res = await query(
    `INSERT INTO message_logs (tenant_code, message_type, message_body, status, whatsapp_message_id, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [tenantId ?? null, messageType, messageBody, status, whatsappMessageId ?? null, failureReason ?? null]
  );
  return res.rows[0]?.id;
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
           t.name AS tenant_name, t.tenant_code
    FROM payments p
    LEFT JOIN tenants t ON p.tenant_code = t.tenant_code
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
    const otherCharges = (penaltiesByTenant[tc] || 0) + (garbageByTenant[tc] || 0);
    const totalExpectedForTenant = arrears + rentAmount + otherCharges;

    const tenantPayments = paymentsByTenant[tc] || [];
    const amountPaid = tenantPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
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
  let q = `
    SELECT t.tenant_code, t.name, t.unit_label, t.rent_amount, t.arrears,
           t.deposit_amount, t.deposit_paid, t.garbage_fee_amount, t.garbage_fee_paid,
           COALESCE((
             SELECT SUM(p.amount) FROM penalties p
             WHERE p.tenant_code = t.tenant_code AND p.status = 'Pending'
           ), 0) AS penalties_outstanding,
           (COALESCE(t.arrears, 0)
             + GREATEST(0, COALESCE(t.deposit_amount, 0) - COALESCE(t.deposit_paid, 0))
             + GREATEST(0, COALESCE(t.garbage_fee_amount, 0) - COALESCE(t.garbage_fee_paid, 0))
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
           OR COALESCE(t.deposit_amount, 0) - COALESCE(t.deposit_paid, 0) > 0
           OR COALESCE(t.garbage_fee_amount, 0) - COALESCE(t.garbage_fee_paid, 0) > 0
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
    deposit_amount: Number(r.deposit_amount || 0),
    deposit_paid: Number(r.deposit_paid || 0),
    garbage_fee_amount: Number(r.garbage_fee_amount || 0),
    garbage_fee_paid: Number(r.garbage_fee_paid || 0),
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
            standard_monthly_rent, first_billing_method, move_in_date::text AS move_in_date
     FROM tenants
     WHERE status != 'Vacant' AND rent_due_date < $1`,
    [firstOfThisMonth]
  );

  const results = [];
  for (const t of overdue.rows) {
    let arrears = Number(t.arrears || 0);
    const rentAmount = Number(t.rent_amount || 0);
    let dueDate = new Date(t.rent_due_date + 'T12:00:00');
    let advanceRentBalance = Number(t.advance_rent_balance || 0);
    let advanceRentUntil = t.advance_rent_until || null;

    // advance_rent_until is the start of the last fully covered month (day 01)
    // OR a date inside the partially covered month (day > 01, covered by balance).
    const advancePrefix = advanceRentUntil ? String(advanceRentUntil).slice(0, 7) : null;
    const advanceDay = advanceRentUntil ? Number(String(advanceRentUntil).slice(8, 10)) : null;
    const isFullyCoveredMonth = (prefix) =>
      !!advancePrefix && (prefix < advancePrefix || (prefix === advancePrefix && advanceDay <= 1));

    // Get approved payments for this tenant
    const paymentsRes = await query(
      `SELECT amount, payment_date::text AS payment_date FROM payments WHERE tenant_code = $1 AND status = 'Approved'`,
      [t.tenant_code]
    );
    const approvedPayments = paymentsRes.rows;

    // Loop to catch up multiple missed months
    let monthsRolled = 0;
    while (dueDate < today) {
      const monthPrefix = `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, '0')}`;
      const monthPaid = approvedPayments
        .filter(p => p.payment_date && p.payment_date.startsWith(monthPrefix))
        .reduce((sum, p) => sum + Number(p.amount || 0), 0);

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

      dueDate.setMonth(dueDate.getMonth() + 1);
      dueDate.setDate(5);
      monthsRolled++;
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
        `UPDATE tenants SET arrears = $1, rent_due_date = $2, rent_paid_this_month = 0, status = $6, advance_rent_balance = $4, advance_rent_until = $5, updated_at = NOW()${rentUpdate} WHERE tenant_code = $3`,
        [Math.max(0, arrears), newDueDate, t.tenant_code, advanceRentBalance, newAdvanceUntil, newStatus, ...extraParams]
      );
      results.push({
        tenant_code: t.tenant_code,
        months_missed: monthsRolled,
        new_arrears: Math.max(0, arrears),
        new_due_date: newDueDate,
        advance_rent_applied: Number(t.advance_rent_balance || 0) - advanceRentBalance,
        rent_restored: rentUpdate ? stdRent : null,
      });
    }
  }

  return results;
}

async function listPenalties(tenantCode) {
  const res = await query(
    `SELECT * FROM penalties WHERE tenant_code = $1 ORDER BY created_at DESC`,
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
  return res.rows[0] || null;
}

async function deletePenalty(id) {
  const res = await query('DELETE FROM penalties WHERE id = $1', [id]);
  return res.rowCount > 0;
}

async function getOutstandingPenalties(tenantCode, category, run) {
  let q = `SELECT COALESCE(SUM(amount), 0) AS total FROM penalties WHERE tenant_code = $1 AND status = 'Pending'`;
  const params = [tenantCode];
  if (category) {
    params.push(category);
    q += ` AND category = $${params.length}`;
  }
  const res = await runOrQuery(run, q, params);
  return Number(res.rows[0]?.total || 0);
}

async function listPendingPenalties(tenantCode, category, run) {
  let q = `SELECT * FROM penalties WHERE tenant_code = $1 AND status = 'Pending'`;
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
     WHERE p.tenant_code = $1 AND p.status = 'Approved'
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
  const toDate = `${year}-${String(month).padStart(2, '0')}-31`;

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
    [tenantCode, fromDate, toDate]
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
  const closingBalance = Math.max(0, totalDue - paymentsReceived - appliedCredits);

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
    billing: { period, period_label: periodLabel, from_date: fromDate, to_date: toDate },
    opening_balance: openingBalance,
    charges,
    total_due: totalDue,
    payments_received: paymentsReceived,
    credit_balance: creditBalance,
    advance_rent: advanceRent,
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
  const woNumber = await generateWorkOrderNumber();
  const items = normalizeWorkItems(data.items);
  const totalCost = items.reduce((s, it) => s + Number(it.labour_cost || 0) + Number(it.material_cost || 0), 0);
  const res = await query(
    `INSERT INTO work_orders (
       wo_number, property_name, house_paybill_number, unit_codes, caretaker_name,
       date_requested, date_work_started, date_completed,
       technician_name, technician_phone, date_assigned, expected_completion,
       status, priority, items, actual_work_completed, materials_used, labour_involved, total_cost, notes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
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

  // Maintenance charges for this month
  let mcQ = `SELECT * FROM maintenance_charges WHERE charge_month = $1`;
  const mcParams = [month];
  if (housePaybill) {
    // Filter by work order's house
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

  // Work order details
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

  const res = await query(
    `INSERT INTO monthly_reports (month, property_name, house_paybill_number, status, report_data, updated_at)
     VALUES ($1, $2, $3, 'Active', $4, NOW())
     ON CONFLICT (month, house_paybill_number)
     DO UPDATE SET report_data = $4, property_name = $2, status = 'Active', updated_at = NOW()
     RETURNING *`,
    [month, propertyName, housePaybill || null, JSON.stringify(data)]
  );
  return res.rows[0];
}

/**
 * Close a monthly report — it becomes a permanent archived snapshot.
 */
async function closeMonthlyReport(month, housePaybill) {
  const res = await query(
    `UPDATE monthly_reports SET status = 'Closed', closed_at = NOW(), updated_at = NOW()
     WHERE month = $1 AND (house_paybill_number = $2 OR ($2 IS NULL AND house_paybill_number IS NULL))
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
    `SELECT * FROM monthly_reports WHERE month = $1 AND (house_paybill_number = $2 OR ($2 IS NULL AND house_paybill_number IS NULL))`,
    [month, housePaybill || null]
  );
  return res.rows[0] || null;
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
       labour_total, material_total, grand_total, notes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
       status = COALESCE($11, status),
       items = $12,
       labour_total = $13,
       material_total = $14,
       grand_total = $15,
       notes = COALESCE($16, notes),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      id,
      data.property_name, data.house_paybill_number, data.unit_codes, data.caretaker_name,
      data.date_reported, data.date_work_started, data.date_completed,
      data.technician_name, data.technician_phone, data.status, JSON.stringify(items),
      labourTotal, materialTotal, grandTotal, data.notes,
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
    `SELECT COUNT(*)::int AS c FROM payments WHERE tenant_code = $1 AND status = 'Approved'${excludeId ? ' AND id <> $2' : ''}`,
    excludeId ? [tenantCode, excludeId] : [tenantCode]
  );
  return res.rows[0]?.c || 0;
}

async function hasApprovedRentPaymentFor(tenantCode, excludeId = null, run) {
  const res = await runOrQuery(run,
    `SELECT COUNT(*)::int AS c FROM payments WHERE tenant_code = $1 AND status = 'Approved' AND (payment_type IS NULL OR payment_type = 'rent')${excludeId ? ' AND id <> $2' : ''}`,
    excludeId ? [tenantCode, excludeId] : [tenantCode]
  );
  return (res.rows[0]?.c || 0) > 0;
}

// ---- Exit invoices ---------------------------------------------------------

async function generateExitInvoiceNumber() {
  return nextCounterNumber('invoice_counters', 'GEHPM-EXT');
}

/**
 * Compute exit settlement based on management's rent and deposit treatment decisions.
 * Returns: { rentCharged, outstanding, depositAppliedToRent, depositAppliedToDeductions, depositRefund, finalSettlement }
 */
function computeExitSettlement(opts) {
  const { tenant, summary, lines, deductionsTotal, depositAmount, depositPaid,
    rentTreatment, rentChargedAmount, proRatedDays,
    depositTreatment, depositAppliedToRent: reqDepRent, depositAppliedToDeductions: reqDepDed } = opts;

  const rentAmount = Number(tenant.rent_amount || 0);
  const arrears = summary ? Number(summary.totals.arrears || 0) : 0;
  const penalties = summary ? Number(summary.totals.penalties || 0) : 0;
  const garbage = summary ? Number(summary.totals.garbage_fee || 0) : 0;
  const unpaidRentFromSummary = summary ? Number(summary.totals.unpaid_rent || 0) : 0;

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

  // 2. Total outstanding = arrears + rent charged + penalties + garbage
  const outstanding = arrears + rentCharged + penalties + garbage;

  // 3. Deposit application
  let depToRent = 0;
  let depToDed = 0;

  if (depositTreatment === 'apply_to_rent') {
    depToRent = Math.min(depositPaid, rentCharged);
  } else if (depositTreatment === 'apply_to_deductions') {
    depToDed = Math.min(depositPaid, deductionsTotal);
  } else if (depositTreatment === 'apply_to_both') {
    // Apply to rent first, then deductions with remaining
    depToRent = Math.min(depositPaid, rentCharged);
    const remaining = depositPaid - depToRent;
    depToDed = Math.min(remaining, deductionsTotal);
  } else if (depositTreatment === 'refund') {
    // Deposit is fully refunded, not applied to anything
    depToRent = 0;
    depToDed = 0;
  } else if (depositTreatment === 'other') {
    // Use requested amounts
    depToRent = Math.min(reqDepRent || 0, depositPaid);
    const remaining = depositPaid - depToRent;
    depToDed = Math.min(reqDepDed || 0, remaining);
  }

  // 4. Final settlement
  // Total obligations = outstanding + deductions
  // Total credits = deposit (applied to rent + deductions)
  const totalObligations = outstanding + deductionsTotal;
  const totalCredits = depToRent + depToDed;
  const finalSettlement = totalCredits - totalObligations;
  const depositRefund = Math.max(0, depositPaid - depToRent - depToDed);

  return {
    rentCharged,
    outstanding: Math.max(0, outstanding),
    depositAppliedToRent: depToRent,
    depositAppliedToDeductions: depToDed,
    depositRefund,
    finalSettlement,
  };
}

async function createExitInvoice(tenantCode, data = {}) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;
  const exitNumber = await generateExitInvoiceNumber();
  const depositAmount = Number(tenant.deposit_amount || 0);
  const depositPaid = Number(tenant.deposit_paid || 0);
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const deductionsTotal = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const summary = await getTenantExitSummary(tenantCode);

  // Management decision fields
  const rentTreatment = data.rent_treatment || 'full_month';
  const rentChargedAmount = data.rent_charged_amount != null ? Number(data.rent_charged_amount) : null;
  const proRatedDays = data.pro_rated_days ? Number(data.pro_rated_days) : null;
  const depositTreatment = data.deposit_treatment || 'apply_to_deductions';
  const depositAppliedToRent = Number(data.deposit_applied_to_rent || 0);
  const depositAppliedToDeductions = Number(data.deposit_applied_to_deductions || 0);

  // Compute settlement
  const settlement = computeExitSettlement({
    tenant, summary, lines, deductionsTotal, depositAmount, depositPaid,
    rentTreatment, rentChargedAmount, proRatedDays,
    depositTreatment, depositAppliedToRent, depositAppliedToDeductions,
  });

  const res = await query(
    `INSERT INTO exit_invoices
      (exit_number, tenant_code, property_name, house_paybill_number, unit_label, status,
       lines, deductions_total, deposit_amount, deposit_paid, deposit_refund,
       outstanding_balance, final_settlement, move_out_date, reason,
       rent_treatment, rent_charged_amount, pro_rated_days, rent_treatment_reason,
       deposit_treatment, deposit_applied_to_rent, deposit_applied_to_deductions, settlement_decision_reason)
     VALUES ($1,$2,$3,$4,$5,'Draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING *, move_out_date::text AS move_out_date`,
    [
      exitNumber, tenant.tenant_code, tenant.property_name || null,
      tenant.house_id || null, tenant.unit_label || tenant.tenant_code || null,
      JSON.stringify(lines), Number(deductionsTotal.toFixed(2)),
      depositAmount, depositPaid,
      Number(settlement.depositRefund.toFixed(2)),
      Number(settlement.outstanding.toFixed(2)),
      Number(settlement.finalSettlement.toFixed(2)),
      data.move_out_date || null, data.reason || null,
      rentTreatment,
      settlement.rentCharged, proRatedDays,
      data.rent_treatment_reason || null,
      depositTreatment,
      settlement.depositAppliedToRent, settlement.depositAppliedToDeductions,
      data.settlement_decision_reason || null,
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
    deposit_refund: Number(r.deposit_refund || 0),
    outstanding_balance: Number(r.outstanding_balance || 0),
    final_settlement: Number(r.final_settlement || 0),
  }));
}

async function updateExitInvoice(id, patch = {}) {
  const existing = await getExitInvoice(id);
  if (!existing) return null;
  if (existing.status !== 'Draft') {
    return { error: 'Exit invoice is finalized and can no longer be edited' };
  }
  const tenant = await getTenant(existing.tenant_code);
  const summary = tenant ? await getTenantExitSummary(existing.tenant_code) : null;
  const lines = Array.isArray(patch.lines) ? patch.lines : existing.lines;
  const deductionsTotal = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const depositAmount = patch.deposit_amount != null ? Number(patch.deposit_amount) : existing.deposit_amount;
  const depositPaid = patch.deposit_paid != null ? Number(patch.deposit_paid) : existing.deposit_paid;

  // Management decision fields (use patch value, or keep existing)
  const rentTreatment = patch.rent_treatment || existing.rent_treatment || 'full_month';
  const rentChargedAmount = patch.rent_charged_amount != null ? Number(patch.rent_charged_amount) : existing.rent_charged_amount;
  const proRatedDays = patch.pro_rated_days != null ? Number(patch.pro_rated_days) : existing.pro_rated_days;
  const depositTreatment = patch.deposit_treatment || existing.deposit_treatment || 'apply_to_deductions';
  const depositAppliedToRent = patch.deposit_applied_to_rent != null ? Number(patch.deposit_applied_to_rent) : existing.deposit_applied_to_rent;
  const depositAppliedToDeductions = patch.deposit_applied_to_deductions != null ? Number(patch.deposit_applied_to_deductions) : existing.deposit_applied_to_deductions;

  // Compute settlement
  const settlement = tenant ? computeExitSettlement({
    tenant, summary, lines, deductionsTotal, depositAmount, depositPaid,
    rentTreatment, rentChargedAmount, proRatedDays,
    depositTreatment, depositAppliedToRent, depositAppliedToDeductions,
  }) : {
    rentCharged: rentChargedAmount || 0,
    outstanding: existing.outstanding_balance,
    depositAppliedToRent, depositAppliedToDeductions,
    depositRefund: existing.deposit_refund, finalSettlement: existing.final_settlement,
  };

  await query(
    `UPDATE exit_invoices SET
       lines = $2, deductions_total = $3, deposit_amount = $4, deposit_paid = $5,
       deposit_refund = $6, outstanding_balance = $7, final_settlement = $8,
       move_out_date = COALESCE($9, move_out_date), reason = COALESCE($10, reason),
       rent_treatment = $11, rent_charged_amount = $12, pro_rated_days = $13,
       rent_treatment_reason = COALESCE($14, rent_treatment_reason),
       deposit_treatment = $15, deposit_applied_to_rent = $16, deposit_applied_to_deductions = $17,
       settlement_decision_reason = COALESCE($18, settlement_decision_reason),
       updated_at = NOW()
     WHERE id = $1`,
    [
      id, JSON.stringify(lines), Number(deductionsTotal.toFixed(2)),
      depositAmount, depositPaid,
      Number(settlement.depositRefund.toFixed(2)),
      Number(settlement.outstanding.toFixed(2)),
      Number(settlement.finalSettlement.toFixed(2)),
      patch.move_out_date || null, patch.reason != null ? patch.reason : null,
      rentTreatment, settlement.rentCharged, proRatedDays,
      patch.rent_treatment_reason || null,
      depositTreatment, settlement.depositAppliedToRent, settlement.depositAppliedToDeductions,
      patch.settlement_decision_reason || null,
    ]
  );
  return getExitInvoice(id);
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
  return getExitInvoice(id);
}

async function deleteExitInvoice(id) {
  const existing = await getExitInvoice(id);
  if (!existing) return false;
  if (existing.status !== 'Draft') return false;
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

async function archiveTenancy(tenantCode, options = {}) {
  const tenant = await getTenant(tenantCode);
  if (!tenant) return null;

  const paymentsRes = await query(
    `SELECT *, payment_date::text AS payment_date_text FROM payments WHERE tenant_code = $1 ORDER BY payments.payment_date ASC, id ASC`,
    [tenantCode]
  );
  const payments = paymentsRes.rows.map((r) => ({ ...r, payment_date: r.payment_date_text, amount: Number(r.amount) }));

  const penaltiesRes = await query(
    `SELECT *, invoice_date::text AS invoice_date_text FROM penalties WHERE tenant_code = $1 ORDER BY penalties.invoice_date ASC, id ASC`,
    [tenantCode]
  );
  const penalties = penaltiesRes.rows.map((r) => ({ ...r, invoice_date: r.invoice_date_text, amount: Number(r.amount) }));

  const docsRes = await query(
    `SELECT id, doc_type, doc_number, title, filename, amount, doc_date::text AS doc_date, created_at FROM documents WHERE tenant_code = $1 ORDER BY created_at ASC`,
    [tenantCode]
  );
  const documents = docsRes.rows.map((r) => ({ ...r, amount: r.amount != null ? Number(r.amount) : null }));

  const msgsRes = await query(
    `SELECT id, message_type, message_body, status, whatsapp_message_id, failure_reason, logged_at FROM message_logs WHERE tenant_code = $1 ORDER BY logged_at ASC`,
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
    rent_history: rentHistory,
  };

  const res = await query(
    `INSERT INTO tenancy_archive
      (tenant_code, property_name, house_paybill_number, unit_label, tenant_name, phone_number, national_id,
       move_in_date, move_out_date, rent_amount, deposit_amount, deposit_paid, deposit_refund,
       opening_balance, final_balance, exit_reason, exit_invoice_number,
       payments, penalties, documents, message_logs, statements, inspections, exit_invoice, financial_snapshot, archived_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
     RETURNING id`,
    [
      tenant.tenant_code,
      tenant.property_name || null,
      tenant.house_id || null,
      tenant.unit_label || tenant.tenant_code || null,
      tenant.name,
      tenant.phone_number || null,
      tenant.national_id || null,
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
  return getTenancyArchive(res.rows[0].id);
}

async function getTenancyArchive(id) {
  const res = await query(
    `SELECT id, tenant_code, property_name, house_paybill_number, unit_label, tenant_name, phone_number, national_id,
       move_in_date::text AS move_in_date, move_out_date::text AS move_out_date, rent_amount,
       deposit_amount, deposit_paid, deposit_refund, opening_balance, final_balance, exit_reason,
       exit_invoice_number, payments, penalties, documents, message_logs, statements, inspections,
       exit_invoice, financial_snapshot, archived_by, archived_at
     FROM tenancy_archive WHERE id = $1`,
    [id]
  );
  if (!res.rows[0]) return null;
  const r = res.rows[0];
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
  // The previous tenancy is archived (vacateTenancy/archiveTenancy) before this
  // runs, so clearing the live rows preserves nothing that is not already in the
  // archive. Live rows must be cleared so the new tenancy starts with a clean
  // financial profile (including correct first-payment detection).
  await query('DELETE FROM payments WHERE tenant_code = $1', [tenantCode]);
  await query('DELETE FROM penalties WHERE tenant_code = $1', [tenantCode]);
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
  createPayment,
  approvePayment,
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
  logMessage,
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
  generateInvoiceNumber,
  generateStatementNumber,
  generateMaintenanceInvoiceNumber,
  generateWorkOrderNumber,
  createDocument,
  getDocument,
  listDocuments,
  deleteDocument,
  createInvoiceRegister,
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
  searchArchive,
  deleteArchive,
  getOccupancyHistory,
  vacateTenancy,
  resetTenancyFinancials,
  recordNoticeToVacate,
};
