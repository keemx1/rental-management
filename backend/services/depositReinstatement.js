'use strict';

/**
 * Deposit Refund Cancellation / Deposit Restoration / Tenancy Reinstatement
 * / Unit Reassignment.
 *
 * Rules enforced here (proposal §4-§14):
 *  - only FINALIZED exits, only UNPAID refunds (nothing disbursed)
 *  - one reinstatement per refund (DB-unique + status guards)
 *  - the original payment row is NEVER duplicated or re-referenced: its
 *    ORIGIN snapshot is written once (COALESCE) and only the CURRENT
 *    ALLOCATION columns change — the money is counted once, ever
 *  - another tenant in the unit is never touched (only a confirmed vacant
 *    unit's blank row may receive the reinstated profile)
 *  - the finalized exit invoice is preserved untouched (never deleted)
 *  - everything lands in audit_log + deposit_reinstatements
 */

const store = require('../storage/store');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
// pg DATE columns arrive as local Date objects — normalise to YYYY-MM-DD.
const localDate = (d) => (d instanceof Date && !isNaN(d))
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d || '').slice(0, 10);

async function loadRefund(id) {
  return store.getDepositRefund(id); // dr.* + tenant_* + exit invoice fields
}

function isDisbursed(refund) {
  return ['refunded', 'partially_refunded'].includes(String(refund.refund_status || ''))
    || Number(refund.amount_refunded || 0) > 0
    || !!refund.refund_date;
}

async function getReinstatementByRefund(refundId) {
  const { query } = require('../config/database');
  return (await query(`SELECT * FROM deposit_reinstatements WHERE deposit_refund_id = $1`, [Number(refundId)])).rows[0] || null;
}

async function findArchive(refund) {
  const { query } = require('../config/database');
  const id = refund.archive_id || null;
  if (id) return (await query(`SELECT * FROM tenancy_archive WHERE id = $1`, [id])).rows[0] || null;
  if (refund.exit_invoice_id) {
    const ei = (await query(`SELECT archive_id FROM exit_invoices WHERE id = $1`, [refund.exit_invoice_id])).rows[0];
    if (ei && ei.archive_id) return (await query(`SELECT * FROM tenancy_archive WHERE id = $1`, [ei.archive_id])).rows[0] || null;
  }
  return null;
}

// The original deposit payment that funded this refund (exact record:
// reference, date, method, amount) — sealed to the tenancy archive when the
// unit was vacated, otherwise still on the live account.
async function findOriginalDepositPayment(refund, archive) {
  const { query } = require('../config/database');
  if (archive) {
    const rows = (await query(
      `SELECT * FROM payments WHERE tenant_code = $1 AND payment_type = 'deposit' AND tenancy_id = $2
        ORDER BY payment_date DESC, id DESC`,
      [archive.tenant_code, archive.id]
    )).rows;
    if (rows.length) return rows[0];
  }
  const live = (await query(
    `SELECT * FROM payments WHERE tenant_code = $1 AND payment_type = 'deposit' AND tenancy_id IS NULL
      ORDER BY payment_date DESC, id DESC LIMIT 1`,
    [refund.tenant_code]
  )).rows[0];
  return live || null;
}

// Who occupies the ORIGINAL unit right now + who the original tenant was.
async function unitState(refund, archive, exitInv) {
  const { query } = require('../config/database');
  const unit = exitInv?.unit_label || refund.unit_label;
  const house = exitInv?.house_paybill_number || refund.house_paybill_number;
  const current = (await query(
    `SELECT * FROM tenants
      WHERE house_paybill_number = $1 AND COALESCE(status,'') <> 'Vacant'
        AND (UPPER(COALESCE(unit_label,'')) = UPPER($2) OR UPPER(tenant_code) = UPPER($2))
      LIMIT 1`,
    [house, unit]
  )).rows[0] || null;
  if (!current) return { state: 'VACANT', current_tenant: null, original_name: archive?.tenant_name || refund.tenant_name || null };
  const sameCode = current.tenant_code === (exitInv?.tenant_code || refund.tenant_code);
  const samePerson = archive ? current.name === archive.tenant_name : sameCode;
  if (sameCode && samePerson) return { state: 'ORIGINAL_TENANT', current_tenant: current, original_name: archive?.tenant_name || current.name };
  return { state: 'OCCUPIED_BY_OTHER', current_tenant: current, original_name: archive?.tenant_name || refund.tenant_name || null };
}

async function eligibility(refundId) {
  const refund = await loadRefund(refundId);
  if (!refund) return { error: 'Deposit refund not found', code: 'NOT_FOUND' };
  const exitInv = refund.exit_invoice_id ? await store.getExitInvoice(refund.exit_invoice_id) : null;
  const existing = await getReinstatementByRefund(refundId);

  const checks = {
    finalized: !!exitInv && String(exitInv.status) === 'Finalized',
    unpaid: !isDisbursed(refund),
    not_processed: !existing,
  };
  const archive = await findArchive(refund);
  const unit = await unitState(refund, archive, exitInv);
  const payment = await findOriginalDepositPayment(refund, archive);

  let reason = null;
  if (existing) reason = 'This refund has already been cancelled / reinstated.';
  else if (!checks.finalized) reason = 'The exit invoice is not finalized.';
  else if (!checks.unpaid) reason = 'The refund has already been disbursed — use the separate claw-back process.';
  else if (!payment) reason = 'Original deposit payment record not found.';

  return {
    eligible: !reason,
    reason,
    already_processed: !!existing,
    reinstatement: existing || null,
    unit_state: unit.state,
    original: {
      tenant_name: archive?.tenant_name || refund.tenant_name || null,
      tenant_code: refund.tenant_code,
      property: exitInv?.property_name || refund.property_name || null,
      unit: exitInv?.unit_label || refund.unit_label || null,
      house_paybill: exitInv?.house_paybill_number || refund.house_paybill_number || null,
      deposit_amount: Number(refund.deposit_amount || 0),
      deposit_paid: Number(refund.deposit_paid || 0),
      payment_reference: payment?.mpesa_reference || null,
      payment_receipt: payment?.receipt_number || null,
      payment_date: payment?.payment_date ? localDate(payment.payment_date) : null,
      payment_method: payment?.payment_mode || null,
      payment_amount: payment ? Number(payment.amount) : null,
      original_rent: Number(archive?.rent_amount || 0),
    },
    exit: {
      exit_number: refund.exit_number || null,
      exit_invoice_id: refund.exit_invoice_id || null,
      refundable_amount: Number(refund.refundable_amount || 0),
      refund_status: refund.refund_status,
    },
    current_occupancy: {
      state: unit.state,
      current_tenant_name: unit.current_tenant?.name || null,
      current_tenant_code: unit.current_tenant?.tenant_code || null,
    },
    payment_record: payment ? {
      id: payment.id, amount: Number(payment.amount), receipt_number: payment.receipt_number,
      mpesa_reference: payment.mpesa_reference, payment_date: String(payment.payment_date || '').slice(0, 10),
      payment_mode: payment.payment_mode,
    } : null,
  };
}

async function vacantUnits(housePaybill) {
  const { query } = require('../config/database');
  const house = await store.getHouse(housePaybill);
  const rows = (await query(
    `SELECT tenant_code, unit_label, rent_amount, deposit_amount FROM tenants
      WHERE house_paybill_number = $1 AND COALESCE(status,'') = 'Vacant'
      ORDER BY tenant_code`,
    [housePaybill]
  )).rows;
  // Reserved units are held — never assignable.
  const reserved = (await query(
    `SELECT unit_label FROM future_tenancies WHERE house_paybill = $1 AND status = 'RESERVED'`,
    [housePaybill]
  )).rows.map((r) => String(r.unit_label || '').toUpperCase()).filter(Boolean);
  const units = rows
    .filter((r) => !reserved.includes(String(r.tenant_code || '').toUpperCase()))
    .map((r) => ({
      unit: r.tenant_code, unit_label: r.unit_label || r.tenant_code,
      rent_amount: Number(r.rent_amount || 0), deposit_amount: Number(r.deposit_amount || 0),
    }));
  return { house: house ? { paybill_number: house.paybill_number, house_name: house.house_name } : null, units };
}

async function listHousesForReassignment() {
  try {
    const rows = await store.listHouses({});
    return Array.isArray(rows) ? rows : (rows?.houses || []);
  } catch (_) {
    return [];
  }
}

async function cancelAndReinstate(refundId, { reason, mode, new_house_paybill, new_unit, actor }) {
  const { query } = require('../config/database');
  if (!reason || !String(reason).trim()) return { error: 'A cancellation reason is required', code: 'VALIDATION' };

  const elig = await eligibility(refundId);
  if (elig.error) return elig;
  if (!elig.eligible) return { error: elig.reason, code: elig.already_processed ? 'ALREADY_PROCESSED' : 'NOT_ELIGIBLE' };

  const refund = await loadRefund(refundId);
  const archive = await findArchive(refund);
  const exitInv = refund.exit_invoice_id ? await store.getExitInvoice(refund.exit_invoice_id) : null;
  const payment = await getPaymentRow((await findOriginalDepositPayment(refund, archive)).id);
  const originalHouse = elig.original.house_paybill;
  const originalUnit = elig.original.unit;
  const origName = elig.original.tenant_name;
  const origPhone = archive?.phone_number || refund.tenant_phone || null;
  const origId = archive?.national_id || refund.tenant_national_id || null;
  const restoredDeposit = round2(Number(refund.deposit_paid || payment.amount || 0));

  const effectiveMode = mode || (elig.unit_state === 'OCCUPIED_BY_OTHER' ? null : 'same_unit');
  if (!['same_unit', 'reassign', 'hold'].includes(effectiveMode || '')) {
    return { error: 'mode must be same_unit, reassign or hold', code: 'VALIDATION' };
  }
  if (elig.unit_state === 'OCCUPIED_BY_OTHER' && effectiveMode === 'same_unit') {
    return { error: 'The original unit is occupied by another tenant — reassign to a vacant unit or hold the deposit.', code: 'UNIT_OCCUPIED' };
  }

  // Vacant-unit target validation (management must have confirmed it).
  let targetVacant = null;
  if (effectiveMode === 'reassign') {
    if (!new_house_paybill || !new_unit) return { error: 'new_house_paybill and new_unit are required', code: 'VALIDATION' };
    const vac = await vacantUnits(new_house_paybill);
    targetVacant = vac.units.find((u) => String(u.unit).toUpperCase() === String(new_unit).toUpperCase());
    if (!targetVacant) return { error: 'Selected unit is not an available vacant unit', code: 'UNIT_NOT_VACANT' };
    if (String(new_house_paybill) === String(originalHouse) && String(new_unit).toUpperCase() === String(originalUnit).toUpperCase()) {
      return { error: 'Select a DIFFERENT unit — the original unit is occupied.', code: 'UNIT_SAME' };
    }
  }

  // Claim FIRST (unique refund id = duplicate-restoration proof).
  let reinstatement;
  try {
    reinstatement = (await query(
      `INSERT INTO deposit_reinstatements
         (deposit_refund_id, exit_invoice_id, refund_invoice_number, archive_id, original_payment_id,
          original_tenant_code, original_tenant_name, original_house_paybill, original_unit,
          original_amount, original_receipt_number, original_reference, original_payment_date,
          original_payment_method, outcome, new_tenant_code, new_house_paybill, new_unit, new_rent,
          refundable_amount, deposit_restored, reason, actor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING *`,
      [Number(refundId), refund.exit_invoice_id || null, elig.exit.exit_number, archive?.id || null,
        payment.id, refund.tenant_code, origName, originalHouse, originalUnit,
        Number(payment.amount), payment.receipt_number || null, payment.mpesa_reference || null,
        payment.payment_date ? localDate(payment.payment_date) : null,
        payment.payment_mode || null,
        effectiveMode === 'reassign' ? 'REASSIGNED' : effectiveMode === 'hold' ? 'DEPOSIT_ONLY' : 'REINSTATED_SAME_UNIT',
        effectiveMode === 'reassign' ? targetVacant.unit
          : effectiveMode === 'hold' ? `${refund.tenant_code}-R` : refund.tenant_code,
        effectiveMode === 'reassign' ? new_house_paybill : effectiveMode === 'hold' ? null : originalHouse,
        effectiveMode === 'reassign' ? targetVacant.unit : effectiveMode === 'hold' ? null : originalUnit,
        effectiveMode === 'reassign' ? targetVacant.rent_amount : null,
        Number(refund.refundable_amount || 0), restoredDeposit,
        String(reason).trim(), actor || null]
    )).rows[0];
  } catch (e) {
    if (e && e.code === '23505') return { error: 'This refund has already been cancelled / reinstated.', code: 'ALREADY_PROCESSED' };
    throw e;
  }

  let tenantNow = null;
  if (effectiveMode === 'reassign') {
    // ── Scenario C + OPTION 1: confirmed vacant unit, profile travels ─────
    const vacRow = (await query(
      `SELECT * FROM tenants WHERE tenant_code = $1 AND COALESCE(status,'') = 'Vacant' FOR UPDATE`,
      [targetVacant.unit]
    )).rows[0];
    if (!vacRow) return { error: 'Selected unit is no longer vacant — refresh and try again.', code: 'UNIT_NOT_VACANT' };
    const nextDue = (() => {
      const d = new Date(); d.setMonth(d.getMonth() + 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-05`;
    })();
    await query(
      `UPDATE tenants SET name = $2, phone_number = $3, national_id = $4, status = 'Active',
              move_in_date = $5, move_out_date = NULL, exit_reason = NULL,
              rent_due_date = $6, deposit_amount = $7, deposit_paid = $8,
              rent_paid_this_month = 0, arrears = 0, credit_balance = 0,
              advance_rent_balance = 0, advance_rent_until = NULL,
              garbage_fee_paid = 0, water_charge_paid = 0, updated_at = NOW()
        WHERE tenant_code = $1`,
      [targetVacant.unit, origName, origPhone, origId, today(), nextDue,
        Number(refund.deposit_amount || targetVacant.deposit_amount || 0), restoredDeposit]
    );
    tenantNow = await store.getTenant(targetVacant.unit);
  } else if (effectiveMode === 'same_unit') {
    // ── Scenarios A / B: original unit (active or vacant blank row) ────────
    const row = (await query(`SELECT * FROM tenants WHERE tenant_code = $1 FOR UPDATE`, [refund.tenant_code])).rows[0];
    if (!row) return { error: 'Original tenant record not found', code: 'NOT_FOUND' };
    await query(
      `UPDATE tenants SET name = $2, phone_number = COALESCE($3, phone_number),
              national_id = COALESCE($4, national_id), status = 'Active',
              deposit_amount = $5, deposit_paid = $6, move_out_date = NULL,
              exit_reason = NULL, updated_at = NOW()
        WHERE tenant_code = $1`,
      [refund.tenant_code, origName, origPhone, origId,
        Number(refund.deposit_amount || row.deposit_amount || 0), restoredDeposit]
    );
    tenantNow = await store.getTenant(refund.tenant_code);
  } else {
    // ── Scenario C + OPTION 2: hold deposit, no unit — a holding profile ──
    // (the original code belongs to the current occupant; a '-R' holding
    //  row keeps the original person's profile + deposit until assigned.)
    const holdCode = `${refund.tenant_code}-R`;
    const existingHold = (await query(`SELECT tenant_code FROM tenants WHERE tenant_code = $1`, [holdCode])).rows[0];
    if (existingHold) return { error: `Holding profile ${holdCode} already exists — use Assign Unit.`, code: 'HOLD_EXISTS' };
    await query(
      `INSERT INTO tenants (tenant_code, name, phone_number, national_id, house_paybill_number,
              property_name, status, rent_amount, deposit_amount, deposit_paid, arrears, move_in_date, rent_due_date)
       VALUES ($1,$2,$3,$4,$5,$6,'Vacant',0,$7,$8,0,$9,$10)`,
      [holdCode, origName, origPhone, origId, originalHouse,
        elig.original.property || null,
        Number(refund.deposit_amount || 0), restoredDeposit,
        archive?.move_in_date ? localDate(archive.move_in_date) : today(),
        (() => { const d = new Date(); d.setMonth(d.getMonth() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-05`; })()]
    );
    tenantNow = await store.getTenant(holdCode);
  }

  // ── Restore the ORIGINAL deposit on the ORIGINAL payment (never a new
  // payment, never a new reference): origin snapshot ONCE + allocation now.
  const alloc = effectiveMode === 'reassign'
    ? { house: new_house_paybill, unit: targetVacant.unit, code: tenantNow.tenant_code }
    : effectiveMode === 'hold'
      ? { house: null, unit: null, code: tenantNow.tenant_code }
      : { house: originalHouse, unit: originalUnit, code: refund.tenant_code };
  await query(
    `UPDATE payments SET
        origin_house_paybill = COALESCE(origin_house_paybill, $2),
        origin_unit = COALESCE(origin_unit, $3),
        origin_tenant_code = COALESCE(origin_tenant_code, $4),
        allocation_house_paybill = $5, allocation_unit = $6,
        allocation_tenant_code = $7, allocation_date = $8,
        reinstatement_id = $9
      WHERE id = $1`,
    [payment.id, originalHouse, originalUnit, refund.tenant_code,
      alloc.house, alloc.unit, alloc.code, today(), reinstatement.id]
  );

  // ── Refund record: cancelled / reinstated (nothing deleted) ──────────────
  await query(
    `UPDATE deposit_refunds
        SET refund_status = 'cancelled_reinstated', cancelled_at = NOW(),
            cancelled_by = $2, cancellation_reason = $3, updated_at = NOW()
      WHERE id = $1 AND refund_status NOT IN ('refunded','partially_refunded') AND amount_refunded = 0
      RETURNING id`,
    [Number(refundId), actor || null, String(reason).trim()]
  );

  await store.logAudit({
    actor: actor || 'system',
    action: 'deposit_refund_cancelled_reinstated',
    entityType: 'deposit_refund',
    entityId: String(refundId),
    details: {
      refund_invoice_number: elig.exit.exit_number,
      original_payment_reference: payment.mpesa_reference,
      original_unit: originalUnit,
      original_house: originalHouse,
      new_unit: effectiveMode === 'reassign' ? targetVacant.unit : null,
      restored_deposit: restoredDeposit,
      outcome: reinstatement.outcome,
      reason: String(reason).trim(),
      final_status: 'Cancelled / Reinstated',
    },
  }).catch(() => {});

  // ── Reinstatement receipt (confirmation of restored deposit — NOT a new
  // collection, no new payment reference) ────────────────────────────────────
  let document = null;
  try {
    const { generateAndStoreDepositReinstatement } = require('./documentStore');
    document = await generateAndStoreDepositReinstatement(reinstatement, tenantNow, exitInv);
    if (document && document.id) {
      await query(`UPDATE deposit_reinstatements SET receipt_document_id = $1 WHERE id = $2`, [document.id, reinstatement.id]);
      reinstatement.receipt_document_id = document.id;
    }
  } catch (docErr) {
    console.error('[DepositReinstatement] Receipt failed:', docErr.message);
  }

  return {
    reinstatement,
    refund: await loadRefund(refundId),
    tenant: tenantNow,
    unit_state: elig.unit_state,
    receipt_document: document,
  };
}

async function getPaymentRow(id) {
  const { query } = require('../config/database');
  const r = (await query(`SELECT * FROM payments WHERE id = $1`, [Number(id)])).rows[0];
  if (!r) throw new Error('Original deposit payment not found');
  return r;
}

// Later unit assignment for a DEPOSIT_ONLY holding profile.
async function assignHeldUnit(reinstatementId, { new_house_paybill, new_unit, actor }) {
  const { query } = require('../config/database');
  const inst = (await query(`SELECT * FROM deposit_reinstatements WHERE id = $1`, [Number(reinstatementId)])).rows[0];
  if (!inst) return { error: 'Reinstatement not found', code: 'NOT_FOUND' };
  if (inst.outcome !== 'DEPOSIT_ONLY') return { error: 'This reinstatement already has a unit.', code: 'NOT_ELIGIBLE' };
  if (!new_house_paybill || !new_unit) return { error: 'new_house_paybill and new_unit are required', code: 'VALIDATION' };
  const vac = await vacantUnits(new_house_paybill);
  const target = vac.units.find((u) => String(u.unit).toUpperCase() === String(new_unit).toUpperCase());
  if (!target) return { error: 'Selected unit is not an available vacant unit', code: 'UNIT_NOT_VACANT' };

  const holdCode = inst.new_tenant_code; // e.g. 'B1-R'
  const hold = (await query(`SELECT * FROM tenants WHERE tenant_code = $1 FOR UPDATE`, [holdCode])).rows[0];
  if (!hold) return { error: 'Holding profile not found', code: 'NOT_FOUND' };
  const targetRow = (await query(
    `SELECT * FROM tenants WHERE tenant_code = $1 AND COALESCE(status,'') = 'Vacant' FOR UPDATE`, [target.unit]
  )).rows[0];
  if (!targetRow) return { error: 'Selected unit is no longer vacant', code: 'UNIT_NOT_VACANT' };

  const nextDue = (() => {
    const d = new Date(); d.setMonth(d.getMonth() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-05`;
  })();
  await query(
    `UPDATE tenants SET name = $2, phone_number = $3, national_id = $4, status = 'Active',
            move_in_date = $5, rent_due_date = $6, deposit_amount = $7, deposit_paid = $8,
            rent_amount = $9, arrears = 0, credit_balance = 0, updated_at = NOW()
      WHERE tenant_code = $1`,
    [target.unit, hold.name, hold.phone_number, hold.national_id, today(), nextDue,
      hold.deposit_amount, hold.deposit_paid, target.rent_amount]
  );
  // The hold-profile's documents (reinstatement receipt) follow the tenant
  // to the confirmed unit, then the holding row is removed (audited).
  await query(
    `UPDATE documents SET tenant_code = $2, house_paybill_number = COALESCE($3, house_paybill_number),
            unit_label = $4
      WHERE tenant_code = $1`,
    [holdCode, target.unit, new_house_paybill, target.unit]
  );
  await query(`DELETE FROM tenants WHERE tenant_code = $1`, [holdCode]);
  await query(
    `UPDATE deposit_reinstatements
        SET outcome = 'REASSIGNED', new_tenant_code = $2, new_house_paybill = $3,
            new_unit = $4, new_rent = $5
      WHERE id = $1`,
    [Number(reinstatementId), target.unit, new_house_paybill, target.unit, target.rent_amount]
  );
  await query(
    `UPDATE payments SET allocation_house_paybill = $2, allocation_unit = $3,
            allocation_tenant_code = $4, allocation_date = $5
      WHERE reinstatement_id = $1`,
    [Number(reinstatementId), new_house_paybill, target.unit, target.unit, today()]
  );
  await store.logAudit({
    actor: actor || 'system', action: 'deposit_reinstatement_unit_assigned',
    entityType: 'deposit_reinstatement', entityId: String(reinstatementId),
    details: { holding_profile: holdCode, new_house: new_house_paybill, new_unit: target.unit },
  }).catch(() => {});

  const inst2 = (await query(`SELECT * FROM deposit_reinstatements WHERE id = $1`, [Number(reinstatementId)])).rows[0];
  return { reinstatement: inst2, tenant: await store.getTenant(target.unit) };
}

async function reinstatementsForPayments(paymentIds) {
  if (!Array.isArray(paymentIds) || !paymentIds.length) return [];
  const { query } = require('../config/database');
  const rows = (await query(
    `SELECT r.id, r.original_payment_id, r.outcome, r.new_unit, r.reinstated_at::text AS reinstated_at,
            r.receipt_document_id, r.refund_invoice_number, r.deposit_restored
       FROM deposit_reinstatements r
      WHERE r.original_payment_id = ANY($1::int[])`,
    [paymentIds]
  )).rows;
  return rows;
}

module.exports = { eligibility, vacantUnits, listHousesForReassignment, cancelAndReinstate, assignHeldUnit, reinstatementsForPayments };
