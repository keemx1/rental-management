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

  // A unit with a live reservation is unavailable until that reservation is
  // cancelled or activated — refuse a second booking on the same unit.
  const conflict = await findConflictingReservation(house_paybill, unit_label, tenant_code);
  if (conflict) {
    const err = new Error(
      'Unit ' + (unit_label || tenant_code || '') + ' is already reserved by ' +
      (conflict.tenant_name || 'another tenant') + ' (booking #' + conflict.id +
      '). Cancel that reservation or activate it first.'
    );
    err.code = 'RESERVED_CONFLICT';
    throw err;
  }

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

// ─── Reserved units (hide from available/vacant lists while awaiting
// activation or cancellation) ───────────────────────────────────────────────

async function getReservedUnits(housePaybill = null) {
  const params = [];
  let where = "WHERE status = 'RESERVED'";
  if (housePaybill) {
    where += ' AND house_paybill = $' + (params.length + 1);
    params.push(housePaybill);
  }
  const res = await pool.query(
    'SELECT id, house_paybill, unit_label, tenant_code, tenant_name, allocated_month ' +
    'FROM future_tenancies ' + where,
    params
  );
  return res.rows;
}

async function findConflictingReservation(housePaybill, unitLabel, tenantCode, excludeId = null) {
  if (!housePaybill) return null;
  const unit = String(unitLabel || tenantCode || '').trim().toLowerCase();
  if (!unit) return null;
  const params = [housePaybill, unit];
  let q = "SELECT * FROM future_tenancies WHERE status = 'RESERVED' AND house_paybill = $1 " +
    "AND (LOWER(COALESCE(unit_label, '')) = $2 OR LOWER(COALESCE(tenant_code, '')) = $2)";
  if (excludeId != null) {
    q += ' AND id <> $' + (params.length + 1);
    params.push(excludeId);
  }
  q += ' LIMIT 1';
  const res = await pool.query(q, params);
  return res.rows[0] || null;
}

// ─── Activate Future Tenancy ───────────────────────────────────────────────
// Converts RESERVED → ACTIVE by creating a real tenant record.
// All approved future payments are carried forward.

async function activateFutureTenancy(futureTenancyId, store) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = (sql, params) => client.query(sql, params);

    const ftRes = await run('SELECT * FROM future_tenancies WHERE id = $1 FOR UPDATE', [futureTenancyId]);
    const ft = ftRes.rows[0];
    if (!ft) throw new Error('Future tenancy not found');
    if (ft.status !== 'RESERVED') throw new Error('Future tenancy is not in RESERVED status');

    const approvedRes = await run(
      "SELECT * FROM future_payments WHERE future_tenancy_id = $1 AND status = 'Approved' ORDER BY payment_date",
      [futureTenancyId]
    );
    const approvedPayments = approvedRes.rows;

    const depositPaid = approvedPayments
      .filter(p => p.purpose === 'Deposit' || p.purpose === 'Down Payment')
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const rentPaid = approvedPayments
      .filter(p => p.purpose === 'Rent')
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const otherPaid = approvedPayments
      .filter(p => p.purpose !== 'Deposit' && p.purpose !== 'Down Payment' && p.purpose !== 'Rent')
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const totalPaid = approvedPayments.reduce((sum, p) => sum + Number(p.amount), 0);

    const today = new Date().toISOString().slice(0, 10);
    const rentDueDate = ft.allocated_month ? ft.allocated_month + '-05' : today;

    // Resolve the tenant row: convert an existing Vacant placeholder in place
    // (no duplicate tenancy records); otherwise insert. An actively occupied
    // unit is a hard conflict and is never overwritten.
    const tenantCode = ft.tenant_code;
    let tenantRow = null;
    if (tenantCode) {
      const exRes = await run('SELECT * FROM tenants WHERE tenant_code = $1 FOR UPDATE', [tenantCode]);
      tenantRow = exRes.rows[0] || null;
    }
    if (tenantRow && String(tenantRow.status || '') !== 'Vacant') {
      const err = new Error(
        'Unit is already occupied by ' + (tenantRow.name || tenantRow.tenant_code) +
        ' - cancel that tenancy or reservation first; activation refused to create a duplicate.'
      );
      err.code = 'UNIT_OCCUPIED';
      throw err;
    }

    let finalTenantCode = tenantCode;
    // House defaults for the new tenancy's recurring charges — computed once
    // for BOTH branches (mirrors store.createTenant) so a re-let unit never
    // inherits the previous tenant's garbage/water amounts.
    let garbageFeeAmount = 0;
    let waterChargeAmount = 0;
    if (ft.house_paybill) {
      try {
        const hRes = await run('SELECT house_name, garbage_fee_enabled FROM houses WHERE paybill_number = $1', [ft.house_paybill]);
        const house = hRes.rows[0];
        if (house) {
          if (house.garbage_fee_enabled === true || house.garbage_fee_enabled === 't') garbageFeeAmount = 2000;
          try {
            const chRes = await run('SELECT * FROM house_charges WHERE house_paybill = $1 AND enabled = TRUE ORDER BY sort_order, id', [ft.house_paybill]);
            for (const hc of chRes.rows) {
              const nm = String(hc.charge_name || '').toLowerCase();
              if (nm.includes('garbage') && garbageFeeAmount === 0) garbageFeeAmount = Number(hc.amount) || 2000;
              else if (nm.includes('water') && waterChargeAmount === 0) waterChargeAmount = Number(hc.amount) || 0;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    // Permanence: seal any records still bound to the previous tenancy BEFORE
    // this one takes over the row (vacate already seals; this is the safety
    // net). The booking payments inserted below stay un-stamped — they belong
    // to the NEW tenancy (NULL = current live tenancy).
    if (tenantCode) {
      try { await store.sealStrayTenancyRows(tenantCode); } catch (_) {}
    }

    if (tenantRow) {
      // Fresh tenancy starts financially clean: booking amounts REPLACE
      // (never add to) whatever the previous tenant left on the shared unit row.
      await run(
        'UPDATE tenants SET name = $2, phone_number = $3, national_id = $4,' +
        ' rent_amount = $5, deposit_amount = $6,' +
        ' house_paybill_number = COALESCE($7, house_paybill_number),' +
        ' property_name = COALESCE($8, property_name),' +
        ' unit_label = COALESCE($9, unit_label),' +
        " status = 'Active', move_in_date = $10, rent_due_date = $11," +
        ' deposit_paid = $12, rent_paid_this_month = $13, credit_balance = $14,' +
        ' garbage_fee_amount = $15, water_charge_amount = $16,' +
        ' arrears = 0, garbage_fee_paid = 0, water_charge_paid = 0,' +
        ' advance_rent_until = NULL, advance_rent_balance = 0, opening_advance_rent = 0,' +
        ' agreement_charge = 0, agreement_paid = 0, agreement_outstanding = 0,' +
        ' move_out_date = NULL, exit_reason = NULL, notice_to_vacate_date = NULL,' +
        ' updated_at = NOW() WHERE tenant_code = $1',
        [tenantRow.tenant_code, ft.tenant_name, ft.phone_number, ft.national_id || null,
         Number(ft.rent_amount || 0), Number(ft.deposit_amount || 0),
         ft.house_paybill || null, ft.property_name || null, ft.unit_label || null,
         today, rentDueDate, depositPaid, rentPaid, otherPaid, garbageFeeAmount, waterChargeAmount]
      );
      finalTenantCode = tenantRow.tenant_code;
    } else {
      let propertyName = ft.property_name || 'General';
      if (ft.house_paybill) {
        try {
          const hRes = await run('SELECT house_name FROM houses WHERE paybill_number = $1', [ft.house_paybill]);
          const house = hRes.rows[0];
          if (house) propertyName = house.house_name || propertyName;
        } catch (_) {}
      }
      await run(
        'INSERT INTO tenants (tenant_code, name, phone_number, national_id, house_paybill_number, property_name,' +
        ' rent_amount, deposit_amount, garbage_fee_amount, water_charge_amount,' +
        " move_in_date, rent_due_date, rent_due_time, status, arrears, opening_advance_rent," +
        ' agreement_charge, agreement_paid, agreement_outstanding,' +
        ' deposit_paid, rent_paid_this_month, credit_balance)' +
        " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'23:59:00','Active',0,0,0,0,0,$13,$14,$15)",
        [tenantCode, ft.tenant_name, ft.phone_number, ft.national_id || null,
         ft.house_paybill ? String(ft.house_paybill) : null, propertyName,
         Number(ft.rent_amount || 0), Number(ft.deposit_amount || 0),
         garbageFeeAmount, waterChargeAmount, today, rentDueDate,
         depositPaid, rentPaid, otherPaid]
      );
      finalTenantCode = tenantCode;
    }

    // Move approved booking payments verbatim: same dates, references,
    // amounts and purposes. Never re-approved, so no new receipts, no
    // re-allocation and no duplicate side-effects. Already-moved rows
    // (same future_payment_id) are skipped, making retries idempotent.
    const purposeToType = (purpose) => {
      const p = String(purpose || '');
      if (p === 'Deposit' || p === 'Down Payment') return 'deposit';
      if (p === 'Rent') return 'rent';
      return 'other';
    };
    let movedPayments = 0;
    for (const fp of approvedPayments) {
      const already = await run('SELECT id FROM payments WHERE future_payment_id = $1 LIMIT 1', [fp.id]);
      if (already.rows[0]) continue;
      // pg DATE columns arrive as local-midnight Date objects — use local
      // fields (toISOString would shift the calendar day by timezone).
      const fpDateStr = (fp.payment_date instanceof Date && !isNaN(fp.payment_date))
        ? fp.payment_date.getFullYear() + '-' + String(fp.payment_date.getMonth() + 1).padStart(2, '0') + '-' + String(fp.payment_date.getDate()).padStart(2, '0')
        : String(fp.payment_date || '').slice(0, 10);
      const payDate = fpDateStr
        ? new Date(fpDateStr + 'T' + (fp.payment_time || '12:00:00')).toISOString()
        : new Date().toISOString();
      const lineage = 'Moved from booking payment #' + fp.id + ' (' + (fp.purpose || 'Down Payment') +
        (fp.allocated_month ? ' for ' + fp.allocated_month : '') + ')';
      const notes = fp.notes ? fp.notes + ' - ' + lineage : lineage;
      await run(
        'INSERT INTO payments (tenant_code, amount, mpesa_reference, status, payment_date,' +
        ' notes, payment_type, payment_mode, payment_datetime,' +
        " approved_at, recorded_at, billing_period, receipt_number," +
        " sync_status, synced_at, future_payment_id, source)" +
        " VALUES ($1,$2,$3,'Approved',$4,$5,$6,$7,$8,$9,$10,$11,$12,'synced',NOW(),$13,'booking')",
        [finalTenantCode, Number(fp.amount), fp.mpesa_reference || null,
         fpDateStr || today, notes, purposeToType(fp.purpose),
         fp.payment_mode || null, payDate,
         fp.approved_at || new Date().toISOString(),
         fp.created_at || new Date().toISOString(),
         fp.allocated_month || null, fp.receipt_number || null, fp.id]
      );
      movedPayments++;
    }

    await run(
      'UPDATE future_tenancies' +
      ' SET status = ' + "'ACTIVE'" + ', activated_at = NOW(), activated_tenant_code = $1, updated_at = NOW()' +
      ' WHERE id = $2',
      [finalTenantCode, futureTenancyId]
    );

    await client.query('COMMIT');

    let tenant = null;
    try {
      tenant = await store.getTenant(finalTenantCode);
    } catch (_) {
      tenant = { tenant_code: finalTenantCode, name: ft.tenant_name };
    }
    return { tenant: tenant, totalPaid: totalPaid, depositPaid: depositPaid, rentPaid: rentPaid, otherPaid: otherPaid, movedPayments: movedPayments };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
  getReservedUnits,
  getFutureTenancySummary,
};
