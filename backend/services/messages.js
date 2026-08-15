/**
 * Payment and monthly reminder WhatsApp templates.
 */
const whatsapp = require('../config/whatsapp');

const store = require('../storage/store');

function formatKes(n) {
  return Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 });
}

function firstNameUpper(name) {
  return String(name || 'Tenant').trim().split(/\s+/)[0].toUpperCase();
}

function fullNameUpper(name) {
  return String(name || 'Tenant').trim().toUpperCase();
}

const FULL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Monthly rent reminder sent on the 3rd of every month.
 * Only sent to tenants with outstanding rent for the current month.
 */
function buildMonthlyInitialReminder(tenant) {
  const name = fullNameUpper(tenant.name);
  const houseName = tenant.property_name || '';
  const unitCode = tenant.tenant_code || '';
  const rentAmount = Number(tenant.rent_amount || 0);
  const formattedRent = formatKes(rentAmount);

  const now = new Date();
  const currentMonth = FULL_MONTHS[now.getMonth()];
  const currentYear = now.getFullYear();
  const dueDay = 5;
  const daysRemaining = dueDay - now.getDate();
  const daysLabel = daysRemaining <= 1 ? '1 day' : `${daysRemaining} days`;

  const dueDate = `${ordinalSuffix(dueDay)} ${currentMonth} ${currentYear}`;

  let paymentSection = '';
  const method = (tenant.payment_method) || 'paybill';
  if (method === 'till') {
    const till = tenant.till_number || '—';
    const tillName = tenant.till_name || '';
    paymentSection = `Payment Method: Buy Goods Till\nTill Number: ${till}${tillName ? ` (${tillName})` : ''}`;
  } else {
    const paybill = tenant.payment_paybill || '4186787';
    const accountFmt = tenant.account_number_format || '';
    const account = accountFmt ? accountFmt.replace(/\{\{tenant_code\}\}/g, unitCode) : unitCode;
    paymentSection = `Payment Method: M-PESA PayBill\nPayBill: ${paybill}\nAccount: ${account}`;
  }

  return (
    `Dear ${name},\n\n` +
    `This is a friendly reminder from GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS that the rent for ${houseName} – Unit ${unitCode} is due in ${daysLabel}, on ${dueDate}.\n\n` +
    `Amount Due: KES ${formattedRent}\n\n` +
    `Kindly make your payment using the payment details below:\n\n` +
    `${paymentSection}\n\n` +
    `Once payment has been made, kindly share your M-PESA confirmation message with us for prompt account updating. If you have already made the payment and have not yet shared the confirmation, please forward it to us.\n\n` +
    `If you require any clarification or assistance, kindly contact our office on 0725 934 615 / 0702 705 321.\n\n` +
    `Thank you for your continued cooperation.\n\n` +
    `GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS\n` +
    `Find a Home. Leave the Management to Us.`
  );
}

function buildPaymentConfirmation(tenant, payment, allocation) {
  const name = fullNameUpper(tenant.name);
  const amount = Number(payment.amount || 0);
  const formattedAmount = formatKes(amount);
  const houseNo = tenant.unit_label || tenant.tenant_code || '';
  const houseName = tenant.property_name || '';
  const ref = payment.mpesa_reference || '—';
  const receiptNo = payment.receipt_number || null;

  // Use billing_period for the rent month (not payment date).
  // Payment date = when money was received; billing period = which rent it covers.
  let billingMonth, billingYear;
  if (payment.billing_period) {
    const [by, bm] = payment.billing_period.split('-').map(Number);
    billingMonth = FULL_MONTHS[bm - 1] || 'Unknown';
    billingYear = by || new Date().getFullYear();
  } else {
    // Fallback to payment_date
    let now = new Date();
    if (payment.payment_date) {
      const raw = payment.payment_date instanceof Date
        ? payment.payment_date
        : new Date(String(payment.payment_date).includes('T') ? payment.payment_date : payment.payment_date + 'T12:00:00');
      if (!isNaN(raw.getTime())) now = raw;
    }
    billingMonth = FULL_MONTHS[now.getMonth()] || 'Unknown';
    billingYear = now.getFullYear() || new Date().getFullYear();
  }

  const nextDueMonth = new Date(billingYear, FULL_MONTHS.indexOf(billingMonth) + 1, 1);
  const nextDue = `5th ${FULL_MONTHS[nextDueMonth.getMonth()]} ${nextDueMonth.getFullYear()}`;

  const num = (v) => Number(v || 0);

  let msg = '';
  if (receiptNo) msg += `Receipt No.: ${receiptNo}\n\n`;
  msg += `Dear ${name}, your rent payment of KES ${formattedAmount} for the month of ${billingMonth} ${billingYear}`;
  if (houseNo) msg += ` for House No. ${houseNo}`;
  if (houseName) msg += `, ${houseName}`;
  msg += ` has been successfully received by GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS.`;

  if (!allocation) {
    msg += ` Your account is fully paid with no outstanding balance.`;
    msg += ` Transaction Ref: ${ref}. Next rent due: ${nextDue}. Thank you.`;
    return msg;
  }

  const {
    rentDue,
    depositShortfallBefore,
    arrearsBefore,
    garbageFeeBefore,
    penaltiesBefore,
    penaltyBefore,
    maintenanceBefore,
    otherBefore,
    depositSettled,
    arrearsSettled,
    garbageFeeSettled,
    rentSettled,
    penaltySettled,
    maintenanceSettled,
    otherSettled,
    remainingRent,
    remainingDeposit,
    remainingArrears,
    remainingPenalties,
    remainingMaintenance,
    remainingOther,
    remainingGarbage,
    remainingBalance,
  } = allocation;

  const totalDueBefore = num(depositShortfallBefore) + num(arrearsBefore) + num(penaltyBefore) + num(maintenanceBefore) + num(otherBefore) + num(garbageFeeBefore) + num(rentDue);

  const dueParts = [];
  if (num(depositShortfallBefore) > 0) dueParts.push(`Deposit: KES ${formatKes(depositShortfallBefore)}`);
  if (num(arrearsBefore) > 0) dueParts.push(`Arrears: KES ${formatKes(arrearsBefore)}`);
  if (num(penaltyBefore) > 0) dueParts.push(`Penalties: KES ${formatKes(penaltyBefore)}`);
  if (num(maintenanceBefore) > 0) dueParts.push(`Maintenance Invoices: KES ${formatKes(maintenanceBefore)}`);
  if (num(otherBefore) > 0) dueParts.push(`Other Charges: KES ${formatKes(otherBefore)}`);
  if (num(garbageFeeBefore) > 0) dueParts.push(`Garbage Fee: KES ${formatKes(garbageFeeBefore)}`);
  dueParts.push(`Monthly Rent: KES ${formatKes(rentDue)}`);
  msg += ` Rent Due for ${billingMonth} ${billingYear} was KES ${formatKes(totalDueBefore)} (${dueParts.join(', ')}).`;

  const allocParts = [];
  if (num(depositSettled) > 0) allocParts.push(`Deposit: KES ${formatKes(depositSettled)}`);
  if (num(arrearsSettled) > 0) allocParts.push(`Arrears: KES ${formatKes(arrearsSettled)}`);
  if (num(penaltySettled) > 0) allocParts.push(`Penalties: KES ${formatKes(penaltySettled)}`);
  if (num(maintenanceSettled) > 0) allocParts.push(`Maintenance Invoices: KES ${formatKes(maintenanceSettled)}`);
  if (num(otherSettled) > 0) allocParts.push(`Other Charges: KES ${formatKes(otherSettled)}`);
  if (num(garbageFeeSettled) > 0) allocParts.push(`Garbage Fee: KES ${formatKes(garbageFeeSettled)}`);
  if (num(rentSettled) > 0) allocParts.push(`Monthly Rent: KES ${formatKes(rentSettled)}`);
  if (allocParts.length > 0) {
    msg += ` Your payment has been allocated as follows: ${allocParts.join(' and ')}.`;
  }

  if (num(remainingBalance) > 0) {
    const remParts = [];
    if (num(remainingDeposit) > 0) remParts.push(`Deposit: KES ${formatKes(remainingDeposit)}`);
    if (num(remainingArrears) > 0) remParts.push(`Arrears: KES ${formatKes(remainingArrears)}`);
    if (num(remainingPenalties) > 0) remParts.push(`Penalties: KES ${formatKes(remainingPenalties)}`);
    if (num(remainingMaintenance) > 0) remParts.push(`Maintenance Invoices: KES ${formatKes(remainingMaintenance)}`);
    if (num(remainingOther) > 0) remParts.push(`Other Charges: KES ${formatKes(remainingOther)}`);
    if (num(remainingGarbage) > 0) remParts.push(`Garbage Fee: KES ${formatKes(remainingGarbage)}`);
    if (num(remainingRent) > 0) remParts.push(`Monthly Rent: KES ${formatKes(remainingRent)}`);
    msg += ` Your remaining balance is KES ${formatKes(remainingBalance)} (${remParts.join(', ')}).`;
  } else {
    msg += ` Your account is fully paid with no outstanding balance.`;
  }

  msg += ` Transaction Ref: ${ref}. Next rent due: ${nextDue}. Thank you.`;
  return msg;
}

/**
 * New-tenancy confirmation sent on the FIRST payment after a unit is freshly
 * occupied (Mark Occupied) while the deposit is not yet fully paid. Payment was
 * allocated in onboarding order: Deposit -> Monthly Rent -> Garbage Fee -> Water.
 */
function buildNewTenancyConfirmation(tenant, payment, allocation) {
  const name = fullNameUpper(tenant.name);
  const firstName = firstNameUpper(tenant.name);
  const amount = Number(payment.amount || 0);
  const formattedAmount = formatKes(amount);
  const houseNo = tenant.unit_label || tenant.tenant_code || '';
  const houseName = tenant.property_name || '';
  const ref = payment.mpesa_reference || '—';
  const receiptNo = payment.receipt_number || null;
  let now = new Date();
  if (payment.payment_date) {
    const raw = payment.payment_date instanceof Date
      ? payment.payment_date
      : new Date(String(payment.payment_date).includes('T') ? payment.payment_date : payment.payment_date + 'T12:00:00');
    if (!isNaN(raw.getTime())) now = raw;
  }
  const fullMonth = FULL_MONTHS[now.getMonth()] || 'Unknown';
  const fullYear = now.getFullYear() || new Date().getFullYear();
  const nextDueMonth = new Date(now);
  nextDueMonth.setMonth(nextDueMonth.getMonth() + 1);
  const nextDue = `5th ${FULL_MONTHS[nextDueMonth.getMonth()]} ${nextDueMonth.getFullYear()}`;

  const num = (v) => Number(v || 0);
  const {
    depositShortfallBefore,
    rentDue,
    garbageFeeBefore,
    waterChargeBefore,
    depositSettled,
    rentSettled,
    garbageFeeSettled,
    waterSettled,
    otherSettled,
    remainingDeposit,
    remainingRent,
    remainingGarbage,
    remainingWater,
    remainingOther,
    remainingBalance,
    onboardingTotal,
  } = allocation || {};

  const dueOnOccupancy = num(onboardingTotal)
    || (num(depositShortfallBefore) + num(rentDue) + num(garbageFeeBefore) + num(waterChargeBefore));

  const dueParts = [];
  if (num(depositShortfallBefore) > 0) dueParts.push(`Deposit: KES ${formatKes(depositShortfallBefore)}`);
  dueParts.push(`Monthly Rent: KES ${formatKes(rentDue)}`);
  if (num(garbageFeeBefore) > 0) dueParts.push(`Garbage Fee: KES ${formatKes(garbageFeeBefore)}`);
  if (num(waterChargeBefore) > 0) dueParts.push(`Water Charges: KES ${formatKes(waterChargeBefore)}`);

  const allocParts = [];
  if (num(depositSettled) > 0) allocParts.push(`Deposit: KES ${formatKes(depositSettled)}`);
  if (num(rentSettled) > 0) allocParts.push(`Monthly Rent: KES ${formatKes(rentSettled)}`);
  if (num(garbageFeeSettled) > 0) allocParts.push(`Garbage Fee: KES ${formatKes(garbageFeeSettled)}`);
  if (num(waterSettled) > 0) allocParts.push(`Water Charges: KES ${formatKes(waterSettled)}`);
  if (num(otherSettled) > 0) allocParts.push(`Other Charges: KES ${formatKes(otherSettled)}`);

  let msg = '';
  if (receiptNo) msg += `Receipt No.: ${receiptNo}\n\n`;
  msg += `Dear ${name},\n\n`;
  msg += `WELCOME to GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS.`;
  if (houseNo) msg += ` Your tenancy at House No. ${houseNo}`;
  if (houseName) msg += `, ${houseName}`;
  msg += ` is now active.\n\n`;

  msg += `TOTAL DUE UPON OCCUPANCY: KES ${formatKes(dueOnOccupancy)}\n`;
  msg += `(${dueParts.join(', ')})\n\n`;

  msg += `Your payment of KES ${formattedAmount} for ${fullMonth} ${fullYear} has been successfully received.`;
  if (allocParts.length > 0) {
    msg += ` It has been allocated as follows: ${allocParts.join(' and ')}.`;
  }

  if (num(remainingBalance) > 0) {
    const remParts = [];
    if (num(remainingDeposit) > 0) remParts.push(`Deposit: KES ${formatKes(remainingDeposit)}`);
    if (num(remainingRent) > 0) remParts.push(`Monthly Rent: KES ${formatKes(remainingRent)}`);
    if (num(remainingGarbage) > 0) remParts.push(`Garbage Fee: KES ${formatKes(remainingGarbage)}`);
    if (num(remainingWater) > 0) remParts.push(`Water Charges: KES ${formatKes(remainingWater)}`);
    if (num(remainingOther) > 0) remParts.push(`Other Charges: KES ${formatKes(remainingOther)}`);
    msg += ` Your remaining balance is KES ${formatKes(remainingBalance)} (${remParts.join(', ')}).`;
  } else {
    msg += ` Your account is fully paid with no outstanding balance.`;
  }

  msg += `\n\nTransaction Ref: ${ref}. Next rent due: ${nextDue}.\n`;
  msg += `Welcome ${firstName}! We are delighted to have you. If you require any assistance, kindly contact our office on 0725 934 615 / 0702 705 321.\n\n`;
  msg += `GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS\nFind a Home. Leave the Management to Us.`;
  return msg;
}

async function sendNewTenancyConfirmation(tenant, payment, allocation) {
  const body = buildNewTenancyConfirmation(tenant, payment, allocation);
  let status = 'Sent';
  let failureReason = null;
  let whatsappMessageId = null;
  try {
    const result = await whatsapp.sendTextMessage(tenant.phone_number, body);
    status = result.status;
    whatsappMessageId = result.messageId;
    failureReason = result.failureReason || (result.status === 'Failed' ? 'ack_error' : null);
  } catch (err) {
    status = 'Failed';
    failureReason = err.message;
    console.error(`[New Tenancy] ${tenant.tenant_code}:`, err.message);
  }
  await store.logMessage({
    tenantId: tenant.id,
    messageType: 'New Tenancy Confirmation',
    messageBody: body,
    status,
    whatsappMessageId,
    failureReason,
  });
  return { status, whatsappMessageId, failureReason };
}

async function sendPaymentConfirmation(tenant, payment, allocation) {
  const body = buildPaymentConfirmation(tenant, payment, allocation);
  let status = 'Sent';
  let failureReason = null;
  let whatsappMessageId = null;
  try {
    const result = await whatsapp.sendTextMessage(tenant.phone_number, body);
    status = result.status;
    whatsappMessageId = result.messageId;
    failureReason = result.failureReason || (result.status === 'Failed' ? 'ack_error' : null);
  } catch (err) {
    status = 'Failed';
    failureReason = err.message;
    console.error(`[Payment] ${tenant.tenant_code}:`, err.message);
  }
  await store.logMessage({
    tenantId: tenant.id,
    messageType: 'Payment Confirmation',
    messageBody: body,
    status,
    whatsappMessageId,
    failureReason,
  });
  return { status, whatsappMessageId, failureReason };
}

async function sendMonthlyInitialReminder(tenant) {
  const body = buildMonthlyInitialReminder(tenant);
  let status = 'Sent';
  let failureReason = null;
  let whatsappMessageId = null;
  try {
    const result = await whatsapp.sendTextMessage(tenant.phone_number, body);
    status = result.status;
    whatsappMessageId = result.messageId;
    failureReason = result.failureReason || (result.status === 'Failed' ? 'ack_error' : null);
  } catch (err) {
    status = 'Failed';
    failureReason = err.message;
    console.error(`[Monthly Reminder] ${tenant.tenant_code}:`, err.message);
  }
  await store.logMessage({
    tenantId: tenant.id,
    messageType: 'Monthly Initial Reminder',
    messageBody: body,
    status,
    whatsappMessageId,
    failureReason,
  });
  return { status, whatsappMessageId, failureReason };
}

function ordinalSuffix(n) {
  if (n === 1 || n === 21 || n === 31) return 'st';
  if (n === 2 || n === 22) return 'nd';
  if (n === 3 || n === 23) return 'rd';
  return 'th';
}

function joinMonths(months) {
  if (months.length === 1) return months[0];
  if (months.length === 2) return `${months[0]} and ${months[1]}`;
  return months.slice(0, -1).join(', ') + ', and ' + months[months.length - 1];
}

function lastDayOfMonth(monthName, year) {
  const idx = FULL_MONTHS.indexOf(monthName);
  if (idx < 0) return 28;
  return new Date(year, idx + 1, 0).getDate();
}

function buildAdvanceRentConfirmation(tenant, payment, advanceResult) {
  const name = fullNameUpper(tenant.name);
  const amount = Number(payment.amount || 0);
  const formattedAmount = formatKes(amount);
  const ref = payment.mpesa_reference || '—';
  const receiptNo = payment.receipt_number || null;

  const now = new Date();
  const currentMonthName = FULL_MONTHS[now.getMonth()];
  const currentYear = now.getFullYear();

  let msg = '';
  if (receiptNo) msg += `Receipt No.: ${receiptNo}\n\n`;
  msg += `Dear ${name}, your rent payment of KES ${formattedAmount}`;
  msg += ` has been successfully received by GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS.`;
  msg += ` Your ${currentMonthName} ${currentYear} Rent Due had already been fully paid with no outstanding balance.`;

  if (advanceResult && advanceResult.allocation && advanceResult.allocation.length > 0) {
    const fullMonthNames = [];
    let partialMonthName = null;
    let partialDateStr = null;

    for (const entry of advanceResult.allocation) {
      const isPartial = entry.month.includes('partial');
      if (isPartial) {
        const match = entry.month.match(/^(\w+)\s+(\d{4})/);
        if (match) {
          partialMonthName = `${match[1]} ${match[2]}`;
          if (advanceResult.advanceRentUntil) {
            const d = new Date(advanceResult.advanceRentUntil + 'T12:00:00');
            const day = d.getDate();
            partialDateStr = `${day}${ordinalSuffix(day)} ${FULL_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
          }
        }
      } else {
        fullMonthNames.push(entry.month);
      }
    }

    if (fullMonthNames.length > 0 && !partialMonthName) {
      msg += ` Your payment has been allocated as Advance Rent for ${joinMonths(fullMonthNames)}.`;
    } else {
      msg += ` Your payment has been allocated as Advance Rent.`;
    }

    if (fullMonthNames.length > 0 && partialMonthName) {
      const lastFull = fullMonthNames[fullMonthNames.length - 1];
      const parts = lastFull.split(' ');
      const lDay = lastDayOfMonth(parts[0], parseInt(parts[1]));
      msg += ` Your rent is fully paid up to ${lDay}${ordinalSuffix(lDay)} ${parts[0]} ${parts[1]} and partially paid up to ${partialDateStr}.`;
    } else if (fullMonthNames.length > 0) {
      const lastFull = fullMonthNames[fullMonthNames.length - 1];
      const parts = lastFull.split(' ');
      const lDay = lastDayOfMonth(parts[0], parseInt(parts[1]));
      msg += ` Your rent is now fully paid up to ${lDay}${ordinalSuffix(lDay)} ${parts[0]} ${parts[1]}.`;
    }
  } else {
    msg += ` Your payment has been allocated as Advance Rent.`;
  }

  msg += ` Transaction Ref: ${ref}.`;

  if (advanceResult && advanceResult.advanceRentUntil) {
    const untilDate = new Date(advanceResult.advanceRentUntil + 'T12:00:00');
    let nextDueDate;
    if (advanceResult.partialAmount > 0) {
      nextDueDate = new Date(untilDate.getFullYear(), untilDate.getMonth(), 5);
    } else {
      nextDueDate = new Date(untilDate.getFullYear(), untilDate.getMonth() + 1, 5);
    }
    msg += ` Next Rent Due: 5th ${FULL_MONTHS[nextDueDate.getMonth()]} ${nextDueDate.getFullYear()}.`;
  }

  msg += ` Thank you.`;
  return msg;
}

function buildCreditBalanceConfirmation(tenant, payment, overpayment, creditResult) {
  const name = fullNameUpper(tenant.name);
  const amount = Number(payment.amount || 0);
  const formattedAmount = formatKes(amount);
  const houseNo = tenant.unit_label || tenant.tenant_code || '';
  const houseName = tenant.linked_house_name || tenant.property_name || '';
  const ref = payment.mpesa_reference || '—';
  const receiptNo = payment.receipt_number || null;

  const now = new Date();
  const currentMonthName = FULL_MONTHS[now.getMonth()];
  const currentYear = now.getFullYear();
  const nextDueMonth = new Date(now);
  nextDueMonth.setMonth(nextDueMonth.getMonth() + 1);

  let msg = '';
  if (receiptNo) msg += `Receipt No.: ${receiptNo}\n\n`;
  msg += `Dear ${name}, your rent payment of KES ${formattedAmount} for the month of ${currentMonthName} ${currentYear}`;
  if (houseNo) msg += ` for House No. ${houseNo}`;
  if (houseName) msg += `, ${houseName}`;
  msg += ` has been successfully received by GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS.`;
  msg += ` Your account for ${currentMonthName} ${currentYear} is fully paid with no outstanding balance.`;
  msg += ` Transaction Ref: ${ref}. Next rent due: 5th ${FULL_MONTHS[nextDueMonth.getMonth()]} ${nextDueMonth.getFullYear()}. Thank you.`;
  return msg;
}

/**
 * Basic confirmation sent when an overpayment is approved but skipped
 * (Skip / Resolve Later). Contains only the receipt number and transaction
 * reference — it never mentions pending overpayment, credit balance, or
 * advance rent (those remain internal until resolved).
 */
function buildSkipOverpaymentConfirmation(tenant, payment) {
  const name = fullNameUpper(tenant.name);
  const amount = Number(payment.amount || 0);
  const formattedAmount = formatKes(amount);
  const houseNo = tenant.unit_label || tenant.tenant_code || '';
  const houseName = tenant.linked_house_name || tenant.property_name || '';
  const ref = payment.mpesa_reference || '—';
  const receiptNo = payment.receipt_number || null;

  let msg = '';
  if (receiptNo) msg += `Receipt No.: ${receiptNo}\n\n`;
  msg += `Dear ${name}, your rent payment of KES ${formattedAmount}`;
  if (houseNo) msg += ` for House No. ${houseNo}`;
  if (houseName) msg += `, ${houseName}`;
  msg += ` has been successfully received by GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS.`;
  msg += ` Transaction Ref: ${ref}. Thank you.`;
  return msg;
}

module.exports = {
  buildMonthlyInitialReminder,
  buildPaymentConfirmation,
  buildNewTenancyConfirmation,
  buildAdvanceRentConfirmation,
  buildCreditBalanceConfirmation,
  buildSkipOverpaymentConfirmation,
  sendMonthlyInitialReminder,
  sendPaymentConfirmation,
  sendNewTenancyConfirmation,
};
