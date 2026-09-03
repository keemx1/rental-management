'use strict';

const { pool } = require('../config/database');

// ─── List Future Tenancies ─────────────────────────────────────────────────

async function listFutureTenancies(filters = {}) {
  let where = [];
  let params = [];
  let idx = 1;

  if (filters.status) {
    where.push(`ft.status = $${idx++}`);
    params.push(filters.status);
  }
  if (filters.property_name) {
    where.push(`ft.property_name ILIKE $${idx++}`);
    params.push(`%${filters.property_name}%`);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT ft.*,
            COALESCE(SUM(fp.amount) FILTER (WHERE fp.status = 'Approved'), 0) AS total_paid,
            COALESCE(SUM(fp.amount) FILTER (WHERE fp.status = 'Pending'), 0) AS total_pending
     FROM future_tenancies ft
     LEFT JOIN future_payments fp ON fp.future_tenancy_id = ft.id
     ${clause}
     GROUP BY ft.id
     ORDER BY ft.created_at DESC`,
    params
  );
  return result.rows;
}

// ─── Get Future Tenancy ────────────────────────────────────────────────────

async function getFutureTenancy(id) {
  const result = await pool.query(
    `SELECT ft.*,
            COALESCE(SUM(fp.amount) FILTER (WHERE fp.status = 'Approved'), 0) AS total_paid,
            COALESCE(SUM(fp.amount) FILTER (WHERE fp.status = 'Pending'), 0) AS total_pending
     FROM future_tenancies ft
     LEFT JOIN future_payments fp ON fp.future_tenancy_id = ft.id
     WHERE ft.id = $1
     GROUP BY ft.id`,
    [id]
  );
  return result.rows[0] || null;
}

// ─── Create Future Tenancy ─────────────────────────────────────────────────

async function createFutureTenancy(data) {
  const {
    property_name, unit_label, house_paybill, tenant_name, phone_number,
    national_id, tenant_code, allocated_month, rent_amount, deposit_amount, notes,
  } = data;

  const result = await pool.query(
    `INSERT INTO future_tenancies
       (property_name, unit_label, house_paybill, tenant_name, phone_number,
        national_id, tenant_code, allocated_month, rent_amount, deposit_amount, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [property_name, unit_label, house_paybill || null, tenant_name, phone_number,
     national_id, tenant_code, allocated_month, rent_amount || 0, deposit_amount || 0, notes]
  );
  return result.rows[0];
}

// ─── Update Future Tenancy ─────────────────────────────────────────────────

async function updateFutureTenancy(id, data) {
  const allowed = ['tenant_name', 'phone_number', 'national_id', 'tenant_code',
    'allocated_month', 'rent_amount', 'deposit_amount', 'notes', 'status'];
  const sets = [];
  const params = [];
  let idx = 1;
  for (const key of allowed) {
    if (data[key] !== undefined) {
      sets.push(`${key} = $${idx++}`);
      params.push(data[key]);
    }
  }
  if (sets.length === 0) return getFutureTenancy(id);
  sets.push(`updated_at = NOW()`);
  params.push(id);
  await pool.query(`UPDATE future_tenancies SET ${sets.join(', ')} WHERE id = $${idx}`, params);
  return getFutureTenancy(id);
}

// ─── Cancel Future Tenancy ─────────────────────────────────────────────────

async function cancelFutureTenancy(id) {
  return updateFutureTenancy(id, { status: 'CANCELLED' });
}

// ─── Future Tenancy Payments ───────────────────────────────────────────────

async function listFuturePayments(futureTenancyId) {
  const result = await pool.query(
    `SELECT * FROM future_payments WHERE future_tenancy_id = $1 ORDER BY created_at DESC`,
    [futureTenancyId]
  );
  return result.rows;
}

async function getFuturePayment(id) {
  const result = await pool.query(`SELECT * FROM future_payments WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function createFuturePayment(data) {
  const {
    future_tenancy_id, amount, payment_date, payment_time, allocated_month,
    payment_mode, mpesa_reference, purpose, notes,
  } = data;

  const result = await pool.query(
    `INSERT INTO future_payments
       (future_tenancy_id, amount, payment_date, payment_time, allocated_month,
        payment_mode, mpesa_reference, purpose, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [future_tenancy_id, amount, payment_date || new Date().toISOString().slice(0, 10),
     payment_time || null, allocated_month, payment_mode || 'Cash',
     mpesa_reference || null, purpose || 'Down Payment', notes || null]
  );
  return result.rows[0];
}

async function approveFuturePayment(id) {
  const now = new Date().toISOString();
  const result = await pool.query(
    `UPDATE future_payments SET status = 'Approved', approved_at = $1, updated_at = $1 WHERE id = $2 RETURNING *`,
    [now, id]
  );
  return result.rows[0] || null;
}

async function cancelFuturePayment(id) {
  const result = await pool.query(
    `UPDATE future_payments SET status = 'Cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

// ─── Activate Future Tenancy ───────────────────────────────────────────────
// Converts RESERVED → ACTIVE by creating a real tenant record.
// All approved future payments are carried forward.

async function activateFutureTenancy(futureTenancyId, store) {
  const ft = await getFutureTenancy(futureTenancyId);
  if (!ft) throw new Error('Future tenancy not found');
  if (ft.status !== 'RESERVED') throw new Error('Future tenancy is not in RESERVED status');

  // Get approved payments
  const payments = await pool.query(
    `SELECT * FROM future_payments WHERE future_tenancy_id = $1 AND status = 'Approved' ORDER BY payment_date`,
    [futureTenancyId]
  );
  const approvedPayments = payments.rows;

  // Calculate totals by purpose
  const depositPaid = approvedPayments
    .filter(p => p.purpose === 'Deposit' || p.purpose === 'Down Payment')
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const rentPaid = approvedPayments
    .filter(p => p.purpose === 'Rent')
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const otherPaid = approvedPayments
    .filter(p => p.purpose === 'Other')
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const totalPaid = approvedPayments.reduce((sum, p) => sum + Number(p.amount), 0);

  // Create the tenant with carry-forward
  const tenant = await store.createTenant({
    name: ft.tenant_name,
    phone_number: ft.phone_number,
    national_id: ft.national_id,
    tenant_code: ft.tenant_code,
    property_name: ft.property_name,
    unit_label: ft.unit_label,
    house_id: ft.house_paybill,
    rent_amount: ft.rent_amount,
    deposit_amount: ft.deposit_amount,
    deposit_paid: depositPaid,
    status: 'Active',
    move_in_date: new Date().toISOString().slice(0, 10),
    rent_due_date: ft.allocated_month + '-05',
  });

  // Record the future payments as regular payments against the new tenant
  for (const fp of approvedPayments) {
    const payment = await store.createPayment({
      tenant_id: tenant.id,
      amount: Number(fp.amount),
      mpesa_reference: fp.mpesa_reference,
      notes: `Future tenancy payment #${fp.id} — ${fp.purpose} for ${fp.allocated_month}`,
      status: 'Pending',
      payment_date: fp.payment_date,
      payment_mode: fp.payment_mode,
    });
    await store.approvePayment(payment.id);
  }

  // Update future tenancy status
  await pool.query(
    `UPDATE future_tenancies
     SET status = 'ACTIVE', activated_at = NOW(), activated_tenant_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [tenant.id, futureTenancyId]
  );

  return { tenant, totalPaid, depositPaid, rentPaid, otherPaid };
}

// ─── Summary ───────────────────────────────────────────────────────────────

async function getFutureTenancySummary() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'RESERVED') AS reserved_count,
      COUNT(*) FILTER (WHERE status = 'ACTIVE') AS active_count,
      COUNT(*) FILTER (WHERE status = 'CANCELLED') AS cancelled_count,
      COALESCE(SUM(amount) FILTER (WHERE status = 'Approved'), 0) AS total_approved,
      COALESCE(SUM(amount) FILTER (WHERE status = 'Pending'), 0) AS total_pending
    FROM future_payments fp
    JOIN future_tenancies ft ON fp.future_tenancy_id = ft.id
  `);
  return result.rows[0] || {};
}

module.exports = {
  listFutureTenancies,
  getFutureTenancy,
  createFutureTenancy,
  updateFutureTenancy,
  cancelFutureTenancy,
  listFuturePayments,
  getFuturePayment,
  createFuturePayment,
  approveFuturePayment,
  cancelFuturePayment,
  activateFutureTenancy,
  getFutureTenancySummary,
};
