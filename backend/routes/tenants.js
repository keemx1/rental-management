const express = require('express');
const ExcelJS = require('exceljs');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const { buildAdvanceRentConfirmation, buildCreditBalanceConfirmation } = require('../services/messages');
const whatsapp = require('../config/whatsapp');

const router = express.Router();
router.use(requireAuthActive);

router.get('/', async (req, res) => {
  try {
    const tenants = await store.listTenants(req.query);
    res.json({ tenants });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list tenants' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const tenant = await store.getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ tenant });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get tenant' });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      name,
      phone_number,
      national_id,
      tenant_code,
      property_name,
      unit_label,
      house_id,
      rent_amount,
      deposit_amount,
      garbage_fee_amount,
      water_charge_amount,
      arrears,
      opening_advance_rent,
      agreement_charge,
      agreement_paid,
      rent_due_date,
      rent_due_time,
      status,
    } = req.body;
    if (!name || !phone_number || !tenant_code || !house_id || !rent_due_date || rent_amount == null) {
      return res.status(400).json({ error: 'name, phone_number, tenant_code, house_id, rent_amount, rent_due_date required' });
    }
    const openingArrears = Number(arrears || 0);
    const openingAdvance = Number(opening_advance_rent || 0);
    if (openingArrears > 0 && openingAdvance > 0) {
      return res.status(400).json({ error: 'A tenant cannot have both Opening Arrears and Opening Advance Rent at the same time.' });
    }
    const house = await store.getHouse(house_id);
    if (!house) return res.status(404).json({ error: 'House not found' });
    const tenantsList = await store.listTenants();
    const existing = tenantsList.find((t) => t.tenant_code === tenant_code);
    if (existing) return res.status(409).json({ error: 'Tenant code already exists' });
    const tenant = await store.createTenant({
      name,
      phone_number,
      national_id,
      tenant_code,
      property_name,
      unit_label,
      house_id,
      rent_amount,
      deposit_amount,
      garbage_fee_amount,
      water_charge_amount,
      arrears: openingArrears,
      opening_advance_rent: openingAdvance,
      agreement_charge,
      agreement_paid,
      rent_due_date,
      rent_due_time,
      status,
    });
    await store.logAudit({
      actor: req.user?.username,
      action: 'tenant_created',
      entityType: 'tenant',
      entityId: tenant.tenant_code,
      details: { opening_arrears: openingArrears, opening_advance_rent: openingAdvance },
    });
    res.status(201).json({ tenant });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const allowed = [
      'name',
      'phone_number',
      'national_id',
      'tenant_code',
      'property_name',
      'unit_label',
      'house_id',
      'rent_amount',
      'deposit_amount',
      'deposit_paid',
      'arrears',
      'garbage_fee_amount',
      'garbage_fee_paid',
      'water_charge_amount',
      'water_charge_paid',
      'move_in_date',
      'move_out_date',
      'notice_to_vacate_date',
      'exit_reason',
      'rent_due_date',
      'rent_due_time',
      'status',
      'opening_advance_rent',
      'agreement_charge',
      'agreement_paid',
    ];
    const patch = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    }
    if (patch.house_id !== undefined && patch.house_id !== null && patch.house_id !== '') {
      const house = await store.getHouse(patch.house_id);
      if (!house) return res.status(404).json({ error: 'House not found' });
    }

    // Opening advance for existing tenants: only seed when none is recorded yet.
    // Re-seeding is blocked so the advance can never be double-applied.
    if (req.body.opening_advance_rent !== undefined) {
      const existingTenant = await store.getTenant(req.params.id);
      if (!existingTenant) return res.status(404).json({ error: 'Tenant not found' });
      const currentAdvance = Number(existingTenant.opening_advance_rent || 0);
      const newAdvance = Number(req.body.opening_advance_rent || 0);
      if (currentAdvance === 0 && newAdvance > 0) {
        const seeded = await store.seedOpeningAdvance(req.params.id, newAdvance);
        if (!seeded) return res.status(400).json({ error: 'Failed to apply opening advance rent. Make sure the rent amount is set.' });
        patch.opening_advance_rent = newAdvance;
        try {
          await store.logAudit({
            actor: req.user ? req.user.username : 'system',
            action: 'opening_advance_added',
            entityType: 'tenant',
            entityId: req.params.id,
            details: { amount: newAdvance, via: 'edit' },
          });
        } catch (auditErr) { /* non-fatal */ }
      } else {
        // Already recorded (or amount cleared) — never modify or re-apply.
        delete patch.opening_advance_rent;
      }
    }

    const tenant = await store.updateTenant(req.params.id, patch);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ tenant });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update tenant' });
  }
});

router.patch('/:id/deposit', async (req, res) => {
  try {
    const tenant = await store.getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const depositAmount = Number(tenant.deposit_amount || 0);
    if (depositAmount <= 0) return res.status(400).json({ error: 'No deposit amount set for this tenant' });
    const newDepositPaid = Number(tenant.deposit_paid) >= depositAmount ? 0 : depositAmount;
    const updated = await store.updateTenant(req.params.id, { deposit_paid: newDepositPaid });
    res.json({ tenant: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle deposit' });
  }
});

router.patch('/:id/vacant', async (req, res) => {
  try {
    // Lifecycle-aware vacate: snapshots the tenancy into the permanent archive
    // and closes the account. Financials are NOT reset here — they reset only
    // when the unit is occupied by a new tenant (Mark Occupied).
    const { exit_invoice_id, move_out_date, reason, archived_by } = req.body || {};
    const result = await store.vacateTenancy(req.params.id, {
      exit_invoice_id,
      move_out_date,
      reason,
      archived_by: archived_by || req.user?.username,
    });
    if (!result) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ tenant: result.tenant, archive: result.archive });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark unit as vacant: ' + err.message });
  }
});

router.post('/:id/notice-to-vacate', async (req, res) => {
  try {
    const { notice_date, reason } = req.body || {};
    if (!notice_date) {
      return res.status(400).json({ error: 'notice_date required' });
    }
    const tenant = await store.recordNoticeToVacate(req.params.id, notice_date, reason || null);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ tenant });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record notice to vacate: ' + err.message });
  }
});

router.post('/:id/occupy', async (req, res) => {
  try {
    // Mark Occupied: clears the previous tenancy's live financial rows (kept in
    // the archive) and registers the new tenant on the same unit code.
    const {
      name, phone_number, national_id, rent_amount, deposit_amount,
      garbage_fee_amount, water_charge_amount, move_in_date, rent_due_date,
      rent_due_time, opening_advance_rent, arrears,
      guardian_name, guardian_id, guardian_phone, guardian_relationship,
      standard_monthly_rent, first_billing_method, first_billing_charge,
      first_billing_reason, first_billing_days,
    } = req.body || {};
    if (!name || !phone_number || !rent_due_date || rent_amount == null) {
      return res.status(400).json({ error: 'name, phone_number, rent_amount, rent_due_date required' });
    }
    const tenant = await store.resetTenancyFinancials(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const openingArrears = Number(arrears || 0);
    const openingAdvance = Number(opening_advance_rent || 0);
    if (openingArrears > 0 && openingAdvance > 0) {
      return res.status(400).json({ error: 'A tenant cannot have both Opening Arrears and Opening Advance Rent at the same time.' });
    }

    const stdRent = standard_monthly_rent != null ? Number(standard_monthly_rent) : Number(rent_amount);
    const firstCharge = first_billing_charge != null ? Number(first_billing_charge) : null;

    const updated = await store.updateTenant(req.params.id, {
      name,
      phone_number,
      national_id: national_id || null,
      guardian_name: guardian_name || null,
      guardian_id: guardian_id || null,
      guardian_phone: guardian_phone || null,
      guardian_relationship: guardian_relationship || null,
      rent_amount: Number(rent_amount) || 0,
      standard_monthly_rent: stdRent,
      first_billing_method: first_billing_method || null,
      first_billing_charge: firstCharge,
      first_billing_reason: first_billing_reason || null,
      first_billing_days: first_billing_days ? Number(first_billing_days) : null,
      deposit_amount: Number(deposit_amount) || 0,
      garbage_fee_amount: Number(garbage_fee_amount) || 0,
      water_charge_amount: Number(water_charge_amount) || 0,
      move_in_date: move_in_date || new Date().toISOString().slice(0, 10),
      rent_due_date,
      rent_due_time: rent_due_time || '23:59:00',
      status: 'Active',
      arrears: openingArrears,
      opening_advance_rent: openingAdvance,
    });

    if (openingAdvance > 0) {
      await store.seedOpeningAdvance(req.params.id, openingAdvance);
    }

    await store.logAudit({
      actor: req.user?.username,
      action: 'tenancy_started',
      entityType: 'tenant',
      entityId: req.params.id,
      details: {
        name,
        move_in_date: move_in_date || null,
        rent_amount: Number(rent_amount) || 0,
        standard_monthly_rent: stdRent,
        first_billing_method: first_billing_method || null,
        first_billing_charge: firstCharge,
        deposit_amount: Number(deposit_amount) || 0,
        guardian_name: guardian_name || null,
        opening_arrears: openingArrears,
        opening_advance_rent: openingAdvance,
      },
    });

    const fresh = await store.getTenant(req.params.id);
    res.status(201).json({ tenant: fresh });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark unit as occupied: ' + err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const ok = await store.deleteTenant(req.params.id);
    if (!ok) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete tenant' });
  }
});

router.post('/import', async (req, res) => {
  try {
    const { file_base64, house_id } = req.body;
    if (!file_base64) return res.status(400).json({ error: 'No file provided' });

    const base64Data = file_base64.replace(/^data:.*?;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];

    const rawHouses = await store.listHouses({});
    const houseMap = new Map();
    for (const h of rawHouses) {
      houseMap.set(h.house_name.toLowerCase().trim(), h.id); // paybill_number
    }

    const today = new Date();
    const defaultDueDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-05`;

    let successCount = 0;
    let skipCount = 0;
    const errors = [];

    const rowCount = worksheet.rowCount;
    if (rowCount < 2) return res.status(400).json({ error: 'Spreadsheet seems empty' });

    let headerRowIdx = 1;
    let hIdx = -1, nIdx = -1, pIdx = -1, tIdx = -1;
    for (let r = 1; r <= Math.min(rowCount, 5); r++) {
      const rowValues = Array.from(worksheet.getRow(r).values || []);
      const headers = rowValues.map(v => String(v || '').toLowerCase().trim());
      
      nIdx = headers.findIndex(v => v && (v.includes('client') || v.includes('name')));
      tIdx = headers.findIndex(v => v && (v.includes('tenant') || v.includes('unit') || v.includes('code')));
      pIdx = headers.findIndex(v => v && (v.includes('phone') || v.includes('whatsapp')));
      
      if (nIdx !== -1 && tIdx !== -1 && pIdx !== -1) {
        headerRowIdx = r;
        hIdx = headers.findIndex(v => v && v.includes('house'));
        break;
      }
    }

    if (nIdx === -1 || tIdx === -1 || pIdx === -1) {
      return res.status(400).json({ error: 'Missing required columns. Please ensure headers have "name", "phone", and "tenant"' });
    }

    let fallbackHouseId = house_id;
    if (hIdx === -1 && !fallbackHouseId) {
      const cellA1 = String(worksheet.getCell('A1').value || '').trim();
      const matchedHouse = rawHouses.find(h => cellA1.toLowerCase().includes(h.house_name.toLowerCase().trim()));
      if (matchedHouse) {
        fallbackHouseId = matchedHouse.id;
      } else {
        return res.status(400).json({ error: 'Spreadsheet lacks a House column. Try importing from a specific House Dashboard.' });
      }
    }

    for (let i = headerRowIdx + 1; i <= rowCount; i++) {
      const row = worksheet.getRow(i);
      const houseName = hIdx !== -1 ? String(row.getCell(hIdx).value || '').trim() : '';
      const clientName = String(row.getCell(nIdx).value || '').trim();
      let phone = String(row.getCell(pIdx).value || '').trim();
      const tenantCode = String(row.getCell(tIdx).value || '').trim();

      if (!clientName || !phone || !tenantCode) continue;

      let finalHouseId = fallbackHouseId;
      if (houseName) {
        finalHouseId = houseMap.get(houseName.toLowerCase());
        if (!finalHouseId) {
          skipCount++;
          errors.push(`Row ${i}: House "${houseName}" not found. Skipped.`);
          continue;
        }
      }

      phone = phone.replace(/[^0-9]/g, '');
      if (phone.startsWith('0')) {
        phone = '254' + phone.slice(1);
      } else if (!phone.startsWith('254')) {
        phone = '254' + phone;
      }

      const existing = await store.getTenant(tenantCode);
      if (existing) {
        skipCount++;
        errors.push(`Row ${i}: Tenant code "${tenantCode}" already exists. Skipped.`);
        continue;
      }

      await store.createTenant({
        tenant_code: tenantCode,
        name: clientName,
        phone_number: phone,
        house_id: finalHouseId,
        rent_amount: 0,
        rent_due_date: defaultDueDate,
        status: 'Active'
      });
      successCount++;
    }

    res.json({ success: true, successCount, skipCount, errors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

router.get('/:id/profile', async (req, res) => {
  try {
    const tenant = await store.getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const house = tenant.house_id ? await store.getHouse(tenant.house_id) : null;
    const allPayments = await store.listPayments();
    const payments = allPayments
      .filter(p => p.tenant_code === tenant.tenant_code)
      .slice(0, 50);

    const approvedPayments = payments.filter(p => p.status === 'Approved');
    const approvedRentPayments = approvedPayments.filter(p => !p.payment_type || p.payment_type === 'rent');
    const approvedDepositPayments = approvedPayments.filter(p => p.payment_type === 'deposit');
    const pendingPayments = payments.filter(p => p.status === 'Pending');

    const totalPaid = approvedRentPayments.reduce((sum, p) => sum + Number(p.amount), 0);
    const pendingAmount = pendingPayments.reduce((sum, p) => sum + Number(p.amount), 0);
    const rentAmount = Number(tenant.rent_amount || 0);
    const arrears = Number(tenant.arrears || 0);
    const rentPaidThisMonth = Number(tenant.rent_paid_this_month || 0);
    const remainingRentForMonth = Math.max(0, rentAmount - rentPaidThisMonth);
    const penaltiesOutstanding = await store.getOutstandingPenalties(tenant.tenant_code);
    const penaltyOnly = await store.getOutstandingPenalties(tenant.tenant_code, 'penalty');
    const maintenanceOutstanding = await store.getOutstandingPenalties(tenant.tenant_code, 'maintenance');
    const otherOutstanding = await store.getOutstandingPenalties(tenant.tenant_code, 'other');

    // Get maintenance charges from work orders for this tenant
    const { pool } = require('../config/database');
    const mcRes = await pool.query(
      `SELECT mc.*, wo.wo_number AS wo_number_ref
       FROM maintenance_charges mc
       LEFT JOIN work_orders wo ON mc.work_order_id = wo.id
       WHERE mc.tenant_code = $1
       ORDER BY mc.created_at DESC LIMIT 20`,
      [tenant.tenant_code]
    );
    const maintenanceCharges = mcRes.rows;
    const depositAmount = Number(tenant.deposit_amount || 0);
    const depositPaid = Number(tenant.deposit_paid || 0);
    const garbageFeeAmount = Number(tenant.garbage_fee_amount || 0);
    const garbageFeePaid = Number(tenant.garbage_fee_paid || 0);
    const garbageShortfall = Math.max(0, garbageFeeAmount - garbageFeePaid);
    const waterChargeAmount = Number(tenant.water_charge_amount || 0);
    const waterChargePaid = Number(tenant.water_charge_paid || 0);
    const waterShortfall = Math.max(0, waterChargeAmount - waterChargePaid);
    const depositShortfall = Math.max(0, depositAmount - depositPaid);
    const balance = arrears + remainingRentForMonth + penaltiesOutstanding + garbageShortfall + waterShortfall;

    const currentMonth = new Date().toISOString().slice(0, 7);
    const currentMonthPaid = approvedRentPayments
      .filter(p => p.payment_date && p.payment_date.startsWith(currentMonth))
      .reduce((sum, p) => sum + Number(p.amount), 0);

    let paymentStatus = 'Not Paid';
    if (rentPaidThisMonth >= rentAmount && rentAmount > 0) paymentStatus = 'Fully Paid';
    else if (rentPaidThisMonth > 0) paymentStatus = 'Partial';
    else if (arrears > 0) paymentStatus = 'Arrears';
    const paymentPercent = rentAmount > 0 ? Math.round((rentPaidThisMonth / rentAmount) * 100) : 0;

    res.json({
      tenant,
      house,
      payments,
      totalPaid,
      pendingAmount,
      summary: {
        payment_status: paymentStatus,
        payment_percent: paymentPercent,
        balance,
        arrears,
        rent_amount: rentAmount,
        rent_paid_this_month: rentPaidThisMonth,
        remaining_rent_for_month: remainingRentForMonth,
        penalties_outstanding: penaltiesOutstanding,
        penalty_outstanding: penaltyOnly,
        maintenance_outstanding: maintenanceOutstanding,
        other_charges_outstanding: otherOutstanding,
        total_paid: totalPaid,
        total_pending: pendingAmount,
        payment_count: payments.length,
        deposit_amount: depositAmount,
        deposit_paid: depositPaid,
        deposit_shortfall: depositShortfall,
        deposit_status: depositAmount > 0 ? (depositPaid >= depositAmount ? 'Paid' : 'Unpaid') : 'N/A',
        garbage_fee_amount: garbageFeeAmount,
        garbage_fee_paid: garbageFeePaid,
        garbage_fee_shortfall: garbageShortfall,
        garbage_fee_status: garbageFeeAmount > 0 ? (garbageFeePaid >= garbageFeeAmount ? 'Paid' : 'Unpaid') : 'N/A',
        water_charge_amount: waterChargeAmount,
        water_charge_paid: waterChargePaid,
        water_charge_shortfall: waterShortfall,
        water_charge_status: waterChargeAmount > 0 ? (waterChargePaid >= waterChargeAmount ? 'Paid' : 'N/A') : 'N/A',
        credit_balance: Number(tenant.credit_balance || 0),
        advance_rent_until: tenant.advance_rent_until || null,
        advance_rent_balance: Number(tenant.advance_rent_balance || 0),
      },
      maintenanceCharges,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tenant profile: ' + err.message });
  }
});

router.post('/:id/send-message', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message required' });
    }
    const tenant = await store.getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const whatsapp = require('../config/whatsapp');
    let status = 'Sent';
    let failureReason = null;
    let whatsappMessageId = null;
    try {
      const result = await whatsapp.sendTextMessage(tenant.phone_number, message);
      status = result.status;
      whatsappMessageId = result.messageId;
      failureReason = result.failureReason || (result.status === 'Failed' ? 'ack_error' : null);
    } catch (err) {
      status = 'Failed';
      failureReason = err.message;
    }

    await store.logMessage({
      tenantId: tenant.id,
      messageType: 'Custom Message',
      messageBody: message,
      status,
      whatsappMessageId,
      failureReason,
    });

    res.json({ success: true, whatsapp: { status, failureReason } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message: ' + err.message });
  }
});

router.post('/:id/resolve-overpayment', async (req, res) => {
  try {
    const { payment_id, choice, overpayment, months } = req.body;
    if (!payment_id || !['advance_rent', 'credit_balance'].includes(choice)) {
      return res.status(400).json({ error: 'payment_id and choice (advance_rent|credit_balance) required' });
    }

    const tenant = await store.getTenant(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const payment = await store.findPaymentById(payment_id);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    const numOverpayment = Number(req.body.overpayment || 0) > 0
      ? Number(req.body.overpayment)
      : Number(payment.overpayment_amount || 0);
    if (numOverpayment <= 0) return res.status(400).json({ error: 'overpayment amount required' });

    let result;
    let messageBody;

    if (choice === 'advance_rent') {
      result = await store.allocateAdvanceRent(tenant.tenant_code, numOverpayment, months);
      messageBody = buildAdvanceRentConfirmation(tenant, payment, result);
    } else {
      result = await store.allocateCreditBalance(tenant.tenant_code, numOverpayment);
      const updatedTenant = await store.getTenant(tenant.tenant_code);
      messageBody = buildCreditBalanceConfirmation(updatedTenant, payment, numOverpayment, result);
    }

    await store.logAudit({
      actor: req.user?.username,
      action: 'overpayment_resolved',
      entityType: 'tenant',
      entityId: tenant.tenant_code,
      details: { payment_id, choice, overpayment: numOverpayment, months: months || null },
    });

    const updatedTenant = await store.getTenant(tenant.tenant_code);
    res.json({ success: true, tenant: updatedTenant, choice, result, messageBody });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve overpayment: ' + err.message });
  }
});

router.post('/:id/apply-credit', async (req, res) => {
  try {
    const { target, amount, reason } = req.body;
    const numAmount = Number(amount);
    if (!target || !numAmount || numAmount <= 0) {
      return res.status(400).json({ error: 'target and positive amount required' });
    }

    const result = await store.applyCreditBalance(req.params.id, numAmount, target, {
      reason: reason || null,
      actor: req.user?.username || null,
    });
    if (!result) {
      return res.status(400).json({ error: 'Insufficient credit balance or invalid target' });
    }

    await store.logAudit({
      actor: req.user?.username,
      action: 'credit_applied',
      entityType: 'tenant',
      entityId: req.params.id,
      details: { target, amount: numAmount, reason: reason || null },
    });

    const updatedTenant = await store.getTenant(req.params.id);
    res.json({ success: true, tenant: updatedTenant, result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to apply credit: ' + err.message });
  }
});

// Deposit-to-Rent Authorization
router.get('/:id/deposit-preview', async (req, res) => {
  try {
    const billingPeriod = req.query.billing_period;
    if (!billingPeriod) return res.status(400).json({ error: 'billing_period required' });
    const preview = await store.getDepositApplicationPreview(req.params.id, billingPeriod);
    if (!preview) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ preview });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get preview: ' + err.message });
  }
});

router.post('/:id/apply-deposit', async (req, res) => {
  try {
    const { amount, billing_period, reason, write_off_amount } = req.body;
    if (!amount || !billing_period) {
      return res.status(400).json({ error: 'amount and billing_period required' });
    }
    const authorizedBy = req.user?.username || 'System';
    const application = await store.applyDepositToRent(
      req.params.id, Number(amount), billing_period, authorizedBy, reason || null, Number(write_off_amount || 0)
    );
    const tenant = await store.getTenant(req.params.id);
    res.json({ success: true, application, tenant });
  } catch (err) {
    res.status(500).json({ error: 'Failed to apply deposit: ' + err.message });
  }
});

router.post('/:id/record-loss', async (req, res) => {
  try {
    const { amount, billing_period, reason } = req.body;
    if (!amount || !billing_period) {
      return res.status(400).json({ error: 'amount and billing_period required' });
    }
    const authorizedBy = req.user?.username || 'System';
    const loss = await store.recordRentLoss(req.params.id, Number(amount), billing_period, authorizedBy, reason || null);
    res.json({ success: true, loss });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record loss: ' + err.message });
  }
});

router.get('/:id/deposit-applications', async (req, res) => {
  try {
    const apps = await store.getDepositApplications(req.params.id);
    res.json({ applications: apps });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list applications: ' + err.message });
  }
});

module.exports = router;
