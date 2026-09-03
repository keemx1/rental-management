const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ExcelJS = require('exceljs');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const { generateAndStoreReceipt } = require('../services/documentStore');
const { sendPaymentConfirmation, buildPaymentConfirmation, sendNewTenancyConfirmation, buildNewTenancyConfirmation, buildSkipOverpaymentConfirmation } = require('../services/messages');
const whatsapp = require('../config/whatsapp');
const { streamWorkbook } = require('../services/excelStream');
const { resolveLogoPath, getLogoExtension } = require('../services/logo');
const { reportDocumentName, renameForDelivery } = require('../services/docNames');
const { formatWorksheet, addReportHeader, addSummarySection, formatKes } = require('../services/excelFormat');

const router = express.Router();
router.use(requireAuthActive);

function queueReceiptGeneration(result) {
  if (!result || !result.payment) return;
  generateAndStoreReceipt(result.tenant, result.payment, result.allocation)
    .catch(err => console.error(`[Documents] Receipt store failed for ${result.payment.id}:`, err.message));
}

router.get('/', async (req, res) => {
  try {
    const payments = await store.listPayments(req.query);
    res.json({ payments });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list payments' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { tenant_id, amount, mpesa_reference, notes, payment_type, payment_mode, sender_account, receiver_account, cheque_number, payment_datetime } = req.body;
    if (!tenant_id || amount == null) {
      return res.status(400).json({ error: 'tenant_id and amount required' });
    }
    const tenant = await store.getTenant(tenant_id);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    const payment = await store.createPayment({
      tenant_id,
      amount,
      mpesa_reference,
      notes,
      payment_type: payment_type || 'rent',
      status: 'Pending',
      payment_mode,
      sender_account,
      receiver_account,
      cheque_number,
      payment_datetime,
    });
    res.status(201).json({ payment });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const result = await store.approvePayment(req.params.id);
    if (!result) return res.status(404).json({ error: 'Payment not found' });
    if (result.alreadyApproved) {
      return res.json({ success: true, payment: result.payment, tenant: result.tenant, whatsapp: { status: 'Skipped' }, alreadyApproved: true, sync: result.sync });
    }

    queueReceiptGeneration(result);

    // Trigger QR-linked WhatsApp notification (non-blocking)
    try {
      const notifEngine = require('../whatsapp/NotificationEngine');
      const sm = require('../whatsapp/session-manager');
      const engine = new notifEngine(sm);
      engine.trigger('payment_received', {
        tenant: result.tenant,
        payment: result.payment,
        allocation: result.allocation,
      }).catch(() => {});
    } catch (_) {}

    const overpayment = result.allocation?.overpayment || 0;

    if (overpayment > 0) {
      return res.json({
        success: true,
        payment: result.payment,
        tenant: result.tenant,
        allocation: result.allocation,
        overpayment,
        whatsapp: { status: 'Pending Overpayment Resolution' },
        sync: result.sync,
      });
    }

    // New-tenancy onboarding message for the first payment after a fresh
    // occupancy while the deposit is still outstanding; otherwise the recurring
    // monthly rent confirmation. Send asynchronously — don't block the response.
    const isOnboarding = !!(result.allocation && result.allocation.onboarding);
    if (isOnboarding) {
      sendNewTenancyConfirmation(result.tenant, result.payment, result.allocation)
        .catch(err => console.error(`[Payment] New tenancy WhatsApp send failed for ${result.payment.id}:`, err.message));
    } else {
      sendPaymentConfirmation(result.tenant, result.payment, result.allocation)
        .catch(err => console.error(`[Payment] WhatsApp send failed for ${result.payment.id}:`, err.message));
    }

    res.json({ success: true, payment: result.payment, tenant: result.tenant, whatsapp: { status: 'Sent' }, newTenancy: isOnboarding || null, sync: result.sync });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve payment: ' + err.message });
  }
});

router.post('/sync-history', async (req, res) => {
  try {
    const result = await store.syncHistoricalPayments();
    res.json({
      success: true,
      message: 'Historical payment synchronization completed successfully.',
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to synchronize historical payments: ' + err.message });
  }
});

router.post('/:id/skip-overpayment', async (req, res) => {
  try {
    const overpayment = Number(req.body?.overpayment || 0);
    const result = await store.skipOverpayment(req.params.id, overpayment, req.user?.username);
    if (!result) return res.status(400).json({ error: 'Payment not found or no overpayment to record' });

    // Basic confirmation: receipt number + transaction reference only. No
    // mention of the pending overpayment / credit balance / advance rent.
    const messageBody = buildSkipOverpaymentConfirmation(result.tenant, result.payment);

    let status = 'Sent';
    let failureReason = null;
    let whatsappMessageId = null;
    try {
      const r = await whatsapp.sendTextMessage(result.tenant.phone_number, messageBody);
      status = r.status;
      whatsappMessageId = r.messageId;
      failureReason = r.failureReason || (r.status === 'Failed' ? 'ack_error' : null);
    } catch (err) {
      status = 'Failed';
      failureReason = err.message;
      console.error(`[Payment] Skip confirmation failed for ${result.payment.id}:`, err.message);
    }
    await store.logMessage({
      tenantId: result.tenant.id,
      messageType: 'Payment Confirmation',
      messageBody,
      status,
      whatsappMessageId,
      failureReason,
    });

    res.json({
      success: true,
      pendingOverpayment: result.record,
      messageBody,
      whatsapp: { status },
      payment: result.payment,
      tenant: result.tenant,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to skip overpayment: ' + err.message });
  }
});

function parseMpesaMessage(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const amountMatch = text.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:Ksh|KES)/i) || text.match(/\b(?:Ksh|KES)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const phoneMatch = text.match(/\b(?:254|0)?7\d{8}\b/);
  const tenantCodeMatch = text.match(/\bT\d{3,}\b/i);
  const houseNumberMatch = text.match(/\b(?:house|unit)\s*[:\-]?\s*([A-Za-z0-9\-]+)\b/i);
  const accountNumberMatch = text.match(/#([A-Z0-9]+)/i);

  // Reference: try known patterns first, then fallback
  let mpesa_reference = null;
  const refDotMatch = text.match(/\bRef\.?\s*([A-Za-z0-9]{6,20})\b/i);
  const txIdMatch = text.match(/Transaction\s+(?:ID|No|Ref)[.:]*\s*([A-Za-z0-9]{6,20})\b/i);
  if (refDotMatch) {
    mpesa_reference = refDotMatch[1].toUpperCase();
  } else if (txIdMatch) {
    mpesa_reference = txIdMatch[1].toUpperCase();
  } else {
    const refMatch = text.match(/\b[A-Z0-9]{10,12}\b/);
    mpesa_reference = refMatch ? refMatch[0] : null;
  }

  const amount = amountMatch ? Number(String(amountMatch[1]).replace(/,/g, '')) : null;

  // Extract payment date from message — formats: DD/MM/YY, YYYY-MM-DD, DD/MM/YYYY, DD Mon YYYY
  let payment_date = null;
  const dateMatchYY = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/);
  const dateMatchYYYYSlash = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  const dateMatchYYYY = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const monthNames = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const dateMatchMon = text.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\b/i);
  if (dateMatchYYYY) {
    const [, y, m, d] = dateMatchYYYY;
    payment_date = `${y}-${m}-${d}`;
  } else if (dateMatchMon) {
    const [, d, mon, y] = dateMatchMon;
    payment_date = `${y}-${monthNames[mon.toLowerCase()]}-${d.padStart(2, '0')}`;
  } else if (dateMatchYYYYSlash) {
    const [, d, m, y] = dateMatchYYYYSlash;
    payment_date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  } else if (dateMatchYY) {
    const [, d, m, y2] = dateMatchYY;
    const fullYear = Number(y2) < 100 ? 2000 + Number(y2) : Number(y2);
    payment_date = `${fullYear}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  let phone_number = phoneMatch ? phoneMatch[0] : null;
  if (phone_number) {
    const digits = phone_number.replace(/\D/g, '');
    const last9 = digits.slice(-9);
    phone_number = last9.length === 9 ? `254${last9}` : digits;
  }

  return {
    raw: text,
    amount,
    mpesa_reference,
    phone_number,
    payment_date,
    tenant_code: tenantCodeMatch ? tenantCodeMatch[0].toUpperCase() : null,
    house_number: houseNumberMatch ? houseNumberMatch[1] : null,
    accountNumber: accountNumberMatch ? accountNumberMatch[1] : null,
  };
}

function buildPaymentMessage(tenant, payment, pendingPenalties) {
  const name = String(tenant.name || 'Tenant').trim().toUpperCase();
  const amount = Number(payment.amount || 0);
  const formattedAmount = amount.toLocaleString('en-KE', { maximumFractionDigits: 0 });
  const houseNo = tenant.unit_label || tenant.tenant_code || '';
  const houseName = tenant.linked_house_name || tenant.property_name || '';
  const ref = payment.mpesa_reference || '—';
  const rentAmount = Number(tenant.rent_amount || 0);
  const rentPaidBefore = Number(tenant.rent_paid_this_month || 0);
  const remainingRentForMonth = Math.max(0, rentAmount - rentPaidBefore);
  const currentArrears = Number(tenant.arrears || 0);
  const garbageFeeAmount = Number(tenant.garbage_fee_amount || 0);
  const garbageFeePaid = Number(tenant.garbage_fee_paid || 0);
  const garbageFeeShortfall = Math.max(0, garbageFeeAmount - garbageFeePaid);
  const depositAmount = Number(tenant.deposit_amount || 0);
  const depositPaid = Number(tenant.deposit_paid || 0);
  const depositShortfall = Math.max(0, depositAmount - depositPaid);
  const allPenalties = pendingPenalties || [];
  const penaltyTotal = allPenalties.filter(p => (p.category || 'penalty') === 'penalty').reduce((s, p) => s + Number(p.amount || 0), 0);
  const maintenanceTotal = allPenalties.filter(p => p.category === 'maintenance').reduce((s, p) => s + Number(p.amount || 0), 0);
  const otherTotal = allPenalties.filter(p => p.category === 'other').reduce((s, p) => s + Number(p.amount || 0), 0);
  const totalPenalties = penaltyTotal + maintenanceTotal + otherTotal;

  let remaining = amount;
  let agreementSettled = 0;
  let depositSettled = 0;
  let arrearsSettled = 0;
  let garbageFeeSettled = 0;
  let waterSettled = 0;
  let rentSettled = 0;
  let penaltySettled = 0;
  let maintenanceSettled = 0;
  let otherSettled = 0;

  const agreementOutstanding = Number(tenant.agreement_outstanding || 0);
  if (agreementOutstanding > 0 && remaining > 0) {
    agreementSettled = Math.min(agreementOutstanding, remaining);
    remaining -= agreementSettled;
  }

  if (currentArrears > 0 && remaining > 0) {
    arrearsSettled = Math.min(currentArrears, remaining);
    remaining -= arrearsSettled;
  }

  if (penaltyTotal > 0 && remaining > 0) {
    penaltySettled = Math.min(penaltyTotal, remaining);
    remaining -= penaltySettled;
  }

  if (maintenanceTotal > 0 && remaining > 0) {
    maintenanceSettled = Math.min(maintenanceTotal, remaining);
    remaining -= maintenanceSettled;
  }

  if (otherTotal > 0 && remaining > 0) {
    otherSettled = Math.min(otherTotal, remaining);
    remaining -= otherSettled;
  }

  if (garbageFeeShortfall > 0 && remaining > 0) {
    garbageFeeSettled = Math.min(garbageFeeShortfall, remaining);
    remaining -= garbageFeeSettled;
  }

  if (remainingRentForMonth > 0 && remaining > 0) {
    rentSettled = Math.min(remainingRentForMonth, remaining);
    remaining -= rentSettled;
  }

  const futureAgreement = Math.max(0, agreementOutstanding - agreementSettled);
  const futureArrears = Math.max(0, currentArrears - arrearsSettled);
  const futurePenalties = Math.max(0, penaltyTotal - penaltySettled);
  const futureMaintenance = Math.max(0, maintenanceTotal - maintenanceSettled);
  const futureOther = Math.max(0, otherTotal - otherSettled);
  const futureGarbage = Math.max(0, garbageFeeShortfall - garbageFeeSettled);
  const futureRent = Math.max(0, remainingRentForMonth - rentSettled);
  const futureOutstanding = futureAgreement + futureArrears + futurePenalties + futureMaintenance + futureOther + futureGarbage + futureRent;
  const totalDue = agreementOutstanding + currentArrears + totalPenalties + garbageFeeShortfall + remainingRentForMonth;

  const now = payment.payment_date ? new Date(payment.payment_date + 'T12:00:00') : new Date();
  const fullMonths = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const fullMonth = fullMonths[now.getMonth()];
  const fullYear = now.getFullYear();
  const nextDueMonth = new Date(now);
  nextDueMonth.setMonth(nextDueMonth.getMonth() + 1);
  const nextDue = `5th ${fullMonths[nextDueMonth.getMonth()]} ${nextDueMonth.getFullYear()}`;

  let msg = `Dear ${name}, your rent payment of KES ${formattedAmount} for the month of ${fullMonth} ${fullYear}`;
  if (houseNo) msg += ` for House No. ${houseNo}`;
  if (houseName) msg += `, ${houseName}`;
  msg += ` has been successfully received by GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS.`;

  const dueParts = [];
  if (agreementOutstanding > 0) dueParts.push(`Agreement Fee: KES ${agreementOutstanding.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
  if (currentArrears > 0) dueParts.push(`Arrears: KES ${currentArrears.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
  if (penaltyTotal > 0) dueParts.push(`Penalties: KES ${penaltyTotal.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
  if (maintenanceTotal > 0) dueParts.push(`Maintenance Invoices: KES ${maintenanceTotal.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
  if (otherTotal > 0) dueParts.push(`Other Charges: KES ${otherTotal.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
  if (garbageFeeShortfall > 0) dueParts.push(`Garbage Fee: KES ${garbageFeeShortfall.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
  dueParts.push(`Monthly Rent: KES ${remainingRentForMonth.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
  msg += ` Rent Due for ${fullMonth} ${fullYear} was KES ${totalDue.toLocaleString('en-KE', { maximumFractionDigits: 0 })} (${dueParts.join(', ')}).`;

  const allocParts = [];
  if (agreementSettled > 0) allocParts.push(`Agreement Fee: KES ${agreementSettled.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
  if (arrearsSettled > 0) allocParts.push(`Arrears: KES ${arrearsSettled.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
  if (penaltySettled > 0) allocParts.push(`Penalties: KES ${penaltySettled.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
  if (maintenanceSettled > 0) allocParts.push(`Maintenance Invoices: KES ${maintenanceSettled.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
  if (otherSettled > 0) allocParts.push(`Other Charges: KES ${otherSettled.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
  if (garbageFeeSettled > 0) allocParts.push(`Garbage Fee: KES ${garbageFeeSettled.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
  if (rentSettled > 0) allocParts.push(`Monthly Rent: KES ${rentSettled.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
  if (allocParts.length > 0) {
    msg += ` Your payment has been allocated as follows: ${allocParts.join(' and ')}.`;
  }

  if (futureOutstanding > 0) {
    const remParts = [];
    if (futureAgreement > 0) remParts.push(`Agreement Fee: KES ${futureAgreement.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
    if (futureArrears > 0) remParts.push(`Arrears: KES ${futureArrears.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
    if (futurePenalties > 0) remParts.push(`Penalties: KES ${futurePenalties.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
    if (futureMaintenance > 0) remParts.push(`Maintenance Invoices: KES ${futureMaintenance.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
    if (futureOther > 0) remParts.push(`Other Charges: KES ${futureOther.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
    if (futureGarbage > 0) remParts.push(`Garbage Fee: KES ${futureGarbage.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
    if (futureRent > 0) remParts.push(`Monthly Rent: KES ${futureRent.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`);
    msg += ` Your remaining balance is KES ${futureOutstanding.toLocaleString('en-KE', { maximumFractionDigits: 0 })} (${remParts.join(', ')}).`;
  } else {
    msg += ` Your account is fully paid with no outstanding balance.`;
  }

  msg += ` Transaction Ref: ${ref}. Next rent due: ${nextDue}. Thank you.`;
  return msg;
}

function buildOnboardingPreview(tenant, amount) {
  const num = (v) => Number(v || 0);
  const depositShortfall = Math.max(0, num(tenant.deposit_amount) - num(tenant.deposit_paid));
  const rentDue = Math.max(0, num(tenant.rent_amount) - num(tenant.rent_paid_this_month));
  const garbageFeeBefore = Math.max(0, num(tenant.garbage_fee_amount) - num(tenant.garbage_fee_paid));
  const waterChargeBefore = Math.max(0, num(tenant.water_charge_amount) - num(tenant.water_charge_paid));
  const agreementOutstanding = num(tenant.agreement_outstanding);
  let remaining = num(amount);
  let agreementSettled = 0;
  let depositSettled = 0;
  let rentSettled = 0;
  let garbageFeeSettled = 0;
  let waterSettled = 0;
  if (agreementOutstanding > 0 && remaining > 0) { agreementSettled = Math.min(agreementOutstanding, remaining); remaining -= agreementSettled; }
  if (depositShortfall > 0 && remaining > 0) { depositSettled = Math.min(depositShortfall, remaining); remaining -= depositSettled; }
  if (rentDue > 0 && remaining > 0) { rentSettled = Math.min(rentDue, remaining); remaining -= rentSettled; }
  if (garbageFeeBefore > 0 && remaining > 0) { garbageFeeSettled = Math.min(garbageFeeBefore, remaining); remaining -= garbageFeeSettled; }
  if (waterChargeBefore > 0 && remaining > 0) { waterSettled = Math.min(waterChargeBefore, remaining); remaining -= waterSettled; }
  const otherSettled = remaining;
  const totalDue = agreementOutstanding + depositShortfall + rentDue + garbageFeeBefore + waterChargeBefore;
  return {
    agreementOutstanding,
    depositShortfallBefore: depositShortfall,
    rentDue,
    garbageFeeBefore,
    waterChargeBefore,
    agreementSettled,
    depositSettled,
    rentSettled,
    garbageFeeSettled,
    waterSettled,
    otherSettled,
    remainingAgreement: Math.max(0, agreementOutstanding - agreementSettled),
    remainingDeposit: Math.max(0, depositShortfall - depositSettled),
    remainingRent: Math.max(0, rentDue - rentSettled),
    remainingGarbage: Math.max(0, garbageFeeBefore - garbageFeeSettled),
    remainingWater: Math.max(0, waterChargeBefore - waterSettled),
    remainingOther: Math.max(0, otherSettled),
    remainingBalance: Math.max(0, totalDue - num(amount)),
    onboardingTotal: totalDue,
  };
}

router.post('/parse-message', async (req, res) => {
  try {
    const parsed = parseMpesaMessage(req.body?.raw_message);
    const matches = await store.findTenantsForPaymentLookup({
      phoneNumber: parsed.phone_number,
      tenantCode: parsed.accountNumber || parsed.tenant_code,
      paybillNumber: parsed.house_number,
    });

    const suggestedTenant = matches[0] || null;
    const previewPayment = {
      amount: parsed.amount,
      mpesa_reference: parsed.mpesa_reference,
      payment_date: parsed.payment_date || new Date().toISOString().slice(0, 10),
    };

    let previewTenant = suggestedTenant;
    if (suggestedTenant && suggestedTenant.rent_due_date) {
      const due = new Date(String(suggestedTenant.rent_due_date).slice(0, 10));
      due.setMonth(due.getMonth() + 1);
      previewTenant = { ...suggestedTenant, rent_due_date: due.toISOString().slice(0, 10) };
    }

    const generated_message = previewTenant && parsed.amount
      ? await (async () => {
          const hasRentPaymentBefore = await store.hasApprovedRentPaymentFor(previewTenant.id);
          const depositShortfall = Math.max(0, Number(previewTenant.deposit_amount || 0) - Number(previewTenant.deposit_paid || 0));
          if (!hasRentPaymentBefore && depositShortfall > 0) {
            return buildNewTenancyConfirmation(previewTenant, previewPayment, buildOnboardingPreview(previewTenant, parsed.amount));
          }
          return buildPaymentMessage(previewTenant, previewPayment, await store.listPendingPenalties(previewTenant.id));
        })()
      : null;

    let duplicate = null;
    if (parsed.mpesa_reference) {
      const existing = await store.findPaymentByReference(parsed.mpesa_reference);
      if (existing) {
        const plotName = existing.property_name || '—';
        const unitNo = existing.unit_label || existing.tenant_code || '—';
        duplicate = {
          tenant_name: existing.tenant_name,
          property_name: plotName,
          unit_number: unitNo,
          amount: existing.amount,
          payment_date: existing.payment_date,
          approved_at: existing.approved_at,
          status: existing.status,
          receipt_number: existing.receipt_number || null,
          mpesa_reference: existing.mpesa_reference,
        };
      }
    }

    res.json({
      parsed,
      matches,
      suggested_tenant: suggestedTenant,
      generated_message,
      duplicate,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to parse message' });
  }
});

router.post('/approve-from-message', async (req, res) => {
  try {
    const parsed = parseMpesaMessage(req.body?.raw_message);
    let tenantId = req.body?.tenant_id;

    // If tenantId is not provided, try to find tenant by tenant code (from account number after #)
    if (!tenantId && parsed.accountNumber) {
      const matches = await store.findTenantsForPaymentLookup({
        tenantCode: parsed.accountNumber
      });
      if (matches.length > 0) {
        tenantId = matches[0].id;
      }
    }

    if (!tenantId) {
      return res.status(400).json({ error: 'tenant_id required (could not determine from house number)' });
    }
    if (parsed.amount == null) {
      return res.status(400).json({ error: 'Could not detect amount from message' });
    }

    if (parsed.mpesa_reference) {
      const existing = await store.findPaymentByReference(parsed.mpesa_reference);
      if (existing) {
        const plotName = existing.property_name || '—';
        const unitNo = existing.unit_label || existing.tenant_code || '—';
        return res.status(409).json({
          error: 'Duplicate reference',
          message: `Approval Failed: M-Pesa Reference ${parsed.mpesa_reference} has already been used for an approved payment.`,
          duplicate: {
            tenant_name: existing.tenant_name,
            property_name: plotName,
            unit_number: unitNo,
            amount: existing.amount,
            payment_date: existing.payment_date,
            approved_at: existing.approved_at,
            status: existing.status,
            receipt_number: existing.receipt_number || null,
            mpesa_reference: existing.mpesa_reference,
          },
        });
      }
    }

    const tenant = await store.getTenant(tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const payment = await store.createPayment({
      tenant_id: tenantId,
      amount: parsed.amount,
      mpesa_reference: parsed.mpesa_reference,
      notes: parsed.raw ? `Parsed from message: ${parsed.raw}` : null,
      status: 'Pending',
      payment_date: req.body?.payment_date || parsed.payment_date || undefined,
      payment_mode: 'M-Pesa',
      sender_account: parsed.phone_number || null,
      payment_datetime: parsed.payment_date ? new Date(parsed.payment_date + 'T12:00:00').toISOString() : null,
    });

    const approved = await store.approvePayment(payment.id);
    if (!approved) {
      return res.status(500).json({ error: 'Failed to approve payment after creating it' });
    }

    queueReceiptGeneration(approved);

    // Trigger QR-linked WhatsApp notification (non-blocking)
    try {
      const notifEngine = require('../whatsapp/NotificationEngine');
      const sm = require('../whatsapp/session-manager');
      const engine = new notifEngine(sm);
      engine.trigger('payment_received', {
        tenant: approved.tenant,
        payment: approved.payment,
        allocation: approved.allocation,
      }).catch(() => {});
    } catch (_) {}

    let whatsappResult = { status: 'Skipped' };

    if (approved.allocation && approved.allocation.overpayment > 0) {
      res.json({
        success: true,
        parsed,
        payment: approved.payment,
        tenant: approved.tenant,
        whatsapp: whatsappResult,
        overpayment: approved.allocation.overpayment,
        payment_id: approved.payment.id,
      });
      return;
    }

    const isOnboarding = !!(approved.allocation && approved.allocation.onboarding);
    const generated_message = isOnboarding
      ? buildNewTenancyConfirmation(approved.tenant, approved.payment, approved.allocation)
      : buildPaymentConfirmation(approved.tenant, approved.payment, approved.allocation);

    // Send WhatsApp asynchronously — don't block the response
    if (isOnboarding) {
      sendNewTenancyConfirmation(approved.tenant, approved.payment, approved.allocation)
        .catch(err => console.error(`[Payment] New tenancy WhatsApp send failed for ${approved.payment.id}:`, err.message));
    } else {
      sendPaymentConfirmation(approved.tenant, approved.payment, approved.allocation)
        .catch(err => console.error(`[Payment] WhatsApp send failed for ${approved.payment.id}:`, err.message));
    }

    res.json({
      success: true,
      parsed,
      payment: approved.payment,
      tenant: approved.tenant,
      whatsapp: { status: 'Sent' },
      generated_message,
      newTenancy: isOnboarding || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve payment from message' });
  }
});

router.post('/approve-cash-pesalink', async (req, res) => {
  try {
    const { payment_mode, amount, payment_date, payment_time, tenant_code, tenant_id } = req.body;
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }
    if (!payment_mode || !['Cash', 'Pesa Link'].includes(payment_mode)) {
      return res.status(400).json({ error: 'payment_mode must be Cash or Pesa Link' });
    }

    let tenantId = tenant_id;
    if (!tenantId && tenant_code) {
      const matches = await store.findTenantsForPaymentLookup({ tenantCode: tenant_code });
      if (matches.length > 0) tenantId = matches[0].id;
    }
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant not found. Provide tenant_code or tenant_id.' });
    }

    const tenant = await store.getTenant(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const paymentDate = payment_date || new Date().toISOString().slice(0, 10);
    const paymentDateTime = payment_time
      ? new Date(`${paymentDate}T${payment_time}:00`).toISOString()
      : new Date(`${paymentDate}T12:00:00`).toISOString();

    const payment = await store.createPayment({
      tenant_id: tenantId,
      amount: Number(amount),
      mpesa_reference: null,
      notes: `${payment_mode} payment recorded manually`,
      status: 'Pending',
      payment_date: paymentDate,
      payment_mode,
      payment_datetime: paymentDateTime,
    });

    const approved = await store.approvePayment(payment.id);
    if (!approved) {
      return res.status(500).json({ error: 'Failed to approve payment' });
    }

    queueReceiptGeneration(approved);

    // Trigger QR-linked WhatsApp notification (non-blocking)
    try {
      const notifEngine = require('../whatsapp/NotificationEngine');
      const sm = require('../whatsapp/session-manager');
      const engine = new notifEngine(sm);
      engine.trigger('payment_received', {
        tenant: approved.tenant,
        payment: approved.payment,
        allocation: approved.allocation,
      }).catch(() => {});
    } catch (_) {}

    if (approved.allocation && approved.allocation.overpayment > 0) {
      return res.json({
        success: true,
        payment: approved.payment,
        tenant: approved.tenant,
        whatsapp: { status: 'Skipped' },
        overpayment: approved.allocation.overpayment,
        payment_id: approved.payment.id,
      });
    }

    const isOnboarding = !!(approved.allocation && approved.allocation.onboarding);
    const generated_message = isOnboarding
      ? buildNewTenancyConfirmation(approved.tenant, approved.payment, approved.allocation)
      : buildPaymentConfirmation(approved.tenant, approved.payment, approved.allocation);

    if (isOnboarding) {
      sendNewTenancyConfirmation(approved.tenant, approved.payment, approved.allocation)
        .catch(() => {});
    } else {
      sendPaymentConfirmation(approved.tenant, approved.payment, approved.allocation)
        .catch(() => {});
    }

    res.json({
      success: true,
      payment: approved.payment,
      tenant: approved.tenant,
      whatsapp: { status: 'Sent' },
      generated_message,
      newTenancy: isOnboarding || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve cash/pesalink payment: ' + err.message });
  }
});

router.post('/:id/resend-whatsapp', async (req, res) => {
  try {
    const paymentId = req.params.id;
    const { payments } = await store.listPayments();
    const payment = payments.find(p => p.id == paymentId);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    const tenant = await store.getTenant(payment.tenant_id || payment.tenant_code);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // Build allocation summary reflecting current balances + this payment
    const rentPaidThisMonth = Number(tenant.rent_paid_this_month || 0);
    const remainingRentForMonth = Math.max(0, Number(tenant.rent_amount || 0) - rentPaidThisMonth);
    const penaltyBefore = await store.getOutstandingPenalties(tenant.tenant_code, 'penalty');
    const maintenanceBefore = await store.getOutstandingPenalties(tenant.tenant_code, 'maintenance');
    const otherBefore = await store.getOutstandingPenalties(tenant.tenant_code, 'other');
    const garbageFeeShortfall = Math.max(0, Number(tenant.garbage_fee_amount || 0) - Number(tenant.garbage_fee_paid || 0));

    let remaining = Number(payment.amount || 0);
    let arrearsSettled = 0;
    let penaltySettled = 0;
    let maintenanceSettled = 0;
    let otherSettled = 0;
    let garbageFeeSettled = 0;
    let rentSettled = 0;

    const settleFrom = (due) => {
      if (due <= 0 || remaining <= 0) return 0;
      const s = Math.min(due, remaining);
      remaining -= s;
      return s;
    };

    arrearsSettled = settleFrom(Number(tenant.arrears || 0));
    penaltySettled = settleFrom(penaltyBefore);
    maintenanceSettled = settleFrom(maintenanceBefore);
    otherSettled = settleFrom(otherBefore);
    garbageFeeSettled = settleFrom(garbageFeeShortfall);
    rentSettled = settleFrom(remainingRentForMonth);

    const allocation = {
      paymentType: 'rent',
      depositShortfallBefore: Math.max(0, Number(tenant.deposit_amount || 0) - Number(tenant.deposit_paid || 0)),
      arrearsBefore: Number(tenant.arrears || 0),
      garbageFeeBefore: garbageFeeShortfall,
      rentDue: remainingRentForMonth,
      rentAmount: Number(tenant.rent_amount || 0),
      rentPaidBefore: rentPaidThisMonth,
      penaltiesBefore: penaltyBefore + maintenanceBefore + otherBefore,
      penaltyBefore,
      maintenanceBefore,
      otherBefore,
      depositSettled: 0,
      arrearsSettled,
      garbageFeeSettled,
      rentSettled,
      penaltySettled,
      maintenanceSettled,
      otherSettled,
      remainingArrears: Math.max(0, Number(tenant.arrears || 0) - arrearsSettled),
      remainingPenalties: Math.max(0, penaltyBefore - penaltySettled),
      remainingMaintenance: Math.max(0, maintenanceBefore - maintenanceSettled),
      remainingOther: Math.max(0, otherBefore - otherSettled),
      remainingGarbage: Math.max(0, garbageFeeShortfall - garbageFeeSettled),
      remainingRent: Math.max(0, remainingRentForMonth - rentSettled),
      remainingDeposit: Math.max(0, Number(tenant.deposit_amount || 0) - Number(tenant.deposit_paid || 0)),
      remainingBalance: 0,
      overpayment: Math.max(0, remaining),
    };
    allocation.remainingBalance =
      allocation.remainingDeposit + allocation.remainingArrears + allocation.remainingPenalties + allocation.remainingMaintenance +
      allocation.remainingOther + allocation.remainingGarbage + allocation.remainingRent;

    const waResult = await sendPaymentConfirmation(tenant, payment, allocation);
    res.json({ success: true, whatsapp: waResult });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resend WhatsApp: ' + err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const success = await store.deletePayment(req.params.id);
    if (!success) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete payment' });
  }
});

router.post('/send-report', async (req, res) => {
  try {
    const { phone_number, house_id, mode } = req.body;
    if (mode !== 'download' && !phone_number) {
      return res.status(400).json({ error: 'Phone number required' });
    }

    const payments = await store.listPayments(house_id ? { house_id } : {});
    const house = house_id ? await store.getHouse(house_id) : null;
    const docName = reportDocumentName({ type: 'Payment_Report', houseName: house ? house.house_name : '', date: new Date() });
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Payments Report');

    worksheet.columns = [
      { key: 'tenant', width: 25 },
      { key: 'house', width: 15 },
      { key: 'amount', width: 15 },
      { key: 'ref', width: 20 },
      { key: 'receipt', width: 22 },
      { key: 'date', width: 15 }
    ];

    // Row 1 for Logo
    worksheet.insertRow(1, []);
    worksheet.mergeCells('A1:E1');
    worksheet.getRow(1).height = 140;

    const logoPath = resolveLogoPath();
    if (logoPath) {
      const imageId = workbook.addImage({
        filename: logoPath,
        extension: getLogoExtension(),
      });
      worksheet.addImage(imageId, {
        tl: { col: 1.8, row: 0.1 },
        ext: { width: 120, height: 120 }
      });
    }

    // Row 2 for Heading
    worksheet.insertRow(2, ['GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS PAYMENTS REPORT']);
    worksheet.mergeCells('A2:E2');
    worksheet.getCell('A2').font = { bold: true, size: 14 };
    worksheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
    worksheet.getRow(2).height = 30;

    // Row 3 Spacing
    worksheet.insertRow(3, []);

    // Row 4 Headers
    const headerRow = worksheet.insertRow(4, ['Tenant Name', 'House Number', 'Amount', 'M-PESA Reference', 'Receipt Number', 'Date Paid']);
    headerRow.font = { bold: true };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };

    let totalAmount = 0;
    payments.forEach(p => {
      worksheet.addRow({
        tenant: p.tenant_name || '',
        house: p.tenant_code || '',
        amount: p.amount,
        ref: p.mpesa_reference || '',
        receipt: p.receipt_number || '',
        date: p.payment_date
      });
      totalAmount += Number(p.amount) || 0;
    });

    worksheet.addRow([]);
    const totalRow = worksheet.addRow({ tenant: 'TOTAL PAID', house: '', amount: totalAmount, ref: '', receipt: '', date: '' });
    totalRow.font = { bold: true };
    
    if (mode === 'download') {
      return streamWorkbook(res, workbook, 'Payment_Report', 'Payment_Report', docName);
    }

    const tempFilePath = path.join(os.tmpdir(), `Payment_Report_${Date.now()}.xlsx`);
    await workbook.xlsx.writeFile(tempFilePath);
    const deliveryPath = renameForDelivery(tempFilePath, docName);

    await whatsapp.sendMediaMessage(phone_number, deliveryPath, 'Here is the requested Excel payment report.');
    
    fs.unlinkSync(deliveryPath);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate and send report' });
  }
});

router.post('/reconcile', async (req, res) => {
  try {
    const tenantCode = req.body?.tenant_code || null;
    if (tenantCode) {
      const result = await store.reconcileTenant(tenantCode);
      res.json({ success: true, reconciliation: result });
    } else {
      const result = await store.reconcileAllTenants();
      res.json({ success: true, message: 'Historical reconciliation completed.', ...result });
    }
  } catch (err) {
    res.status(500).json({ error: 'Reconciliation failed: ' + err.message });
  }
});

router.all('/collection-report', async (req, res) => {
  try {
    const src = req.method === 'GET' ? req.query : (req.body || {});
    const house_id = src.house_id || null;
    const billing_month = src.billing_month || src.month || null;
    const mode = src.mode || (req.method === 'GET' ? 'download' : 'send');
    const phone_number = src.phone_number || null;
    if (!billing_month) return res.status(400).json({ error: 'billing_month required (YYYY-MM)' });
    if (mode !== 'download' && !phone_number) return res.status(400).json({ error: 'Phone number required for send mode' });

    const data = await store.getPropertyCollectionReport(house_id || null, billing_month);
    const docName = reportDocumentName({
      type: 'Collection_Report',
      houseName: data.property_name,
      date: new Date(billing_month + '-01'),
    });

    const FULL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const [by, bm] = billing_month.split('-').map(Number);
    const monthLabel = `${FULL_MONTHS[bm - 1]} ${by}`;

    const workbook = new ExcelJS.Workbook();

    // ===== SHEET 1: Collection Report =====
    const ws1 = workbook.addWorksheet('Collection Report', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    ws1.columns = [
      { key: 'unit', width: 10 },
      { key: 'tenant_name', width: 20 },
      { key: 'rent', width: 12 },
      { key: 'balance_bf', width: 12 },
      { key: 'current_rent', width: 13 },
      { key: 'other_charges', width: 12 },
      { key: 'total_expected', width: 14 },
      { key: 'amount_paid', width: 12 },
      { key: 'ref_code', width: 14 },
      { key: 'receipt', width: 18 },
      { key: 'date_paid', width: 12 },
      { key: 'balance_cf', width: 12 },
      { key: 'status', width: 14 },
    ];

    const logoPath = resolveLogoPath();
    const logoExt = getLogoExtension();
    let rowNum = addReportHeader(workbook, ws1, 'PAYMENT & RENT COLLECTION REPORT', 'M', logoPath, logoExt);

    // Metadata row
    const metaRow = ws1.insertRow(rowNum, [`Property: ${data.property_name}  |  Billing Month: ${monthLabel}  |  Report Generated: ${new Date().toLocaleString('en-KE')}`]);
    ws1.mergeCells(`A${rowNum}:M${rowNum}`);
    ws1.getCell(`A${rowNum}`).font = { size: 9, color: { argb: 'FF666666' } };
    ws1.getCell(`A${rowNum}`).alignment = { horizontal: 'center' };
    ws1.getRow(rowNum).height = 14;
    rowNum++;
    // No extra blank row — go straight to headers

    // Column headers
    const headerRow = ws1.insertRow(rowNum, [
      'House No.', 'Tenant Name', 'Rent (KES)', 'Balance B/F (KES)', 'Current Rent Due (KES)',
      'Other Charges (KES)', 'Total Expected (KES)', 'Amount Paid (KES)',
      'REF: CODE', 'Receipt No.', 'Date Paid', 'Balance C/F (KES)', 'Status'
    ]);
    headerRow.font = { bold: true, size: 9 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };
    headerRow.alignment = { wrapText: true, vertical: 'middle' };
    headerRow.height = 16;
    const headerRowNum = rowNum;
    rowNum++;

    // Data rows
    for (const r of data.rows) {
      const row = ws1.insertRow(rowNum, [
        r.unit, r.tenant_name, r.rent, r.balance_bf, r.current_rent_due,
        r.other_charges, r.total_expected, r.amount_paid,
        r.mpesa_references || '—', r.receipt_numbers || '—', r.dates_paid || '—',
        r.balance_cf, r.status,
      ]);
      // Color status
      const statusCell = row.getCell(13);
      if (r.status === 'PAID') statusCell.font = { color: { argb: 'FF166534' } };
      else if (r.status === 'PARTIALLY PAID') statusCell.font = { color: { argb: 'FF92400E' } };
      else if (r.status === 'UNPAID') statusCell.font = { color: { argb: 'FFDC2626' } };
      else if (r.status.includes('OVERPAID')) statusCell.font = { color: { argb: 'FF1E40AF' } };
      rowNum++;
    }

    // Summary section — immediately after data (no extra blank rows)
    const s = data.summary;
    const entries = [
      ['Total Units:', s.total_units],
      ['Total Expected Rent:', `KES ${formatKes(s.total_expected_rent)}`],
      ['Total Other Charges:', `KES ${formatKes(s.total_other_charges)}`],
      ['Total Expected Collection:', `KES ${formatKes(s.total_expected)}`],
      ['Total Amount Collected:', `KES ${formatKes(s.total_collected)}`],
      ['Total Outstanding:', `KES ${formatKes(s.total_outstanding)}`],
      ['Total Overpayment/Credit:', `KES ${formatKes(s.total_overpayment)}`],
      ['Collection Percentage:', `${s.collection_percentage.toFixed(2)}%`],
    ];
    rowNum = addSummarySection(ws1, rowNum, `${monthLabel.toUpperCase()} COLLECTION SUMMARY`, entries, 'M');

    rowNum++; // single blank line between summary sections
    const statusEntries = [
      ['Fully Paid:', `${s.count_paid} tenants`],
      ['Partially Paid:', `${s.count_partial} tenants`],
      ['Unpaid:', `${s.count_unpaid} tenants`],
      ['Overpaid/Credit:', `${s.count_overpaid} tenants`],
    ];
    rowNum = addSummarySection(ws1, rowNum, 'COLLECTION STATUS SUMMARY', statusEntries, 'M');

    // Apply formatting
    formatWorksheet(ws1, {
      dataStartRow: headerRowNum,
      headerRowNum,
      printLandscape: true,
      repeatHeaderRows: [headerRowNum],
    });

    // ===== SHEET 2: Payment Transactions =====
    const ws2 = workbook.addWorksheet('Payment Transactions', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    });
    ws2.columns = [
      { key: 'date', width: 12 },
      { key: 'unit', width: 10 },
      { key: 'tenant', width: 20 },
      { key: 'amount', width: 12 },
      { key: 'ref_code', width: 14 },
      { key: 'receipt', width: 18 },
      { key: 'billing_period', width: 12 },
      { key: 'type', width: 10 },
    ];

    ws2.insertRow(1, [`PAYMENT TRANSACTIONS — ${monthLabel} — ${data.property_name}`]);
    ws2.mergeCells('A1:H1');
    ws2.getCell('A1').font = { bold: true, size: 10 };
    ws2.getCell('A1').alignment = { horizontal: 'center' };
    ws2.getRow(1).height = 16;

    const txnHeader = ws2.insertRow(2, ['Date', 'House No.', 'Tenant Name', 'Amount (KES)', 'REF: CODE', 'Receipt No.', 'Billing Period', 'Type']);
    txnHeader.font = { bold: true, size: 9 };
    txnHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };
    txnHeader.alignment = { wrapText: true, vertical: 'middle' };
    txnHeader.height = 14;

    for (const txn of data.transactions) {
      ws2.addRow({
        date: txn.date,
        unit: txn.unit,
        tenant: txn.tenant_name,
        amount: txn.amount,
        ref_code: txn.mpesa_reference || '—',
        receipt: txn.receipt_number || '—',
        billing_period: txn.billing_period,
        type: txn.payment_type,
      });
    }

    formatWorksheet(ws2, { dataStartRow: 2, headerRowNum: 2, printLandscape: true, repeatHeaderRows: [2] });

    if (mode === 'download') {
      return streamWorkbook(res, workbook, 'Collection_Report', 'Collection_Report', docName);
    }

    await sendExcelReport(phone_number, workbook, docName, `Here is the ${monthLabel} collection report for ${data.property_name}.`);
    res.json({ success: true, summary: data.summary });
  } catch (err) {
    console.error('[Reports] collection-report:', err);
    res.status(500).json({ error: 'Failed to generate collection report: ' + err.message });
  }
});

module.exports = router;
