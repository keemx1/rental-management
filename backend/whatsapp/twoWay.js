'use strict';

const { pool } = require('../config/database');
const sessionManager = require('./session-manager');
const { fromWhatsAppJid } = require('./phone');

// ─── Idempotency ────────────────────────────────────────────────────────────

const MAX_PROCESSED_IDS = 100;
const _processedIds = new Set();
const _idOrder = [];

function _trackProcessed(messageId) {
  if (!messageId) return;
  _processedIds.add(messageId);
  _idOrder.push(messageId);
  while (_idOrder.length > MAX_PROCESSED_IDS) {
    const old = _idOrder.shift();
    _processedIds.delete(old);
  }
}

function _wasProcessed(messageId) {
  return messageId && _processedIds.has(messageId);
}

// ─── Menu Text ──────────────────────────────────────────────────────────────

const MENU_TEXT = `Welcome to GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS!

How can we help you?

1. Check rent balance
2. Payment information
3. Request receipt
4. Maintenance request
5. Contact management

Reply with a number.`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function _extractPhone(message) {
  const raw = message.from || '';
  const phone = fromWhatsAppJid(raw);
  if (!phone || phone.length < 10) return null;
  return phone;
}

function _normalizeText(text) {
  return (text || '').trim().toLowerCase();
}

async function _findTenant(phone) {
  const result = await pool.query(
    `SELECT tenant_code, name, phone_number, property_name, unit_label,
            rent_amount, rent_due_date, rent_due_time, status
     FROM tenants
     WHERE phone_number = $1
     LIMIT 1`,
    [phone]
  );
  return result.rows[0] || null;
}

async function _sendReply(phone, text) {
  try {
    await sessionManager.sendText(phone, text);
  } catch (err) {
    console.error(`[TwoWay] Failed to send reply to ${phone}:`, err.message);
  }
}

// ─── Menu Handlers ──────────────────────────────────────────────────────────

async function _handleBalance(tenant) {
  const arrearsResult = await pool.query(
    `SELECT COALESCE(SUM(amount - COALESCE(paid_amount, 0)), 0)::numeric AS arrears
     FROM invoices
     WHERE tenant_code = $1 AND status != 'paid'`,
    [tenant.tenant_code]
  );
  const arrears = parseFloat(arrearsResult.rows[0]?.arrears || 0);

  const penaltyResult = await pool.query(
    `SELECT COALESCE(SUM(penalty_amount), 0)::numeric AS penalties
     FROM invoices
     WHERE tenant_code = $1 AND status != 'paid' AND penalty_amount > 0`,
    [tenant.tenant_code]
  );
  const penalties = parseFloat(penaltyResult.rows[0]?.penalties || 0);

  const rentAmount = parseFloat(tenant.rent_amount || 0);
  const total = arrears + penalties;

  let reply;
  if (total > 0) {
    reply = `Hi ${tenant.name},\n\nYour rent balance:\nRent: KES ${rentAmount.toLocaleString()}\nOutstanding: KES ${arrears.toLocaleString()}`;
    if (penalties > 0) {
      reply += `\nPenalties: KES ${penalties.toLocaleString()}`;
    }
    reply += `\nTotal due: KES ${total.toLocaleString()}\n\nProperty: ${tenant.property_name}\nUnit: ${tenant.unit_label || ''}`;
  } else {
    reply = `Hi ${tenant.name},\n\nYour rent of KES ${rentAmount.toLocaleString()} for ${tenant.property_name} ${tenant.unit_label || ''} is up to date.\n\nThank you.`;
  }

  return reply;
}

async function _handlePaymentInfo(tenant) {
  const paymentResult = await pool.query(
    `SELECT amount, payment_date, reference, payment_method
     FROM payments
     WHERE tenant_code = $1
     ORDER BY payment_date DESC
     LIMIT 1`,
    [tenant.tenant_code]
  );
  const lastPayment = paymentResult.rows[0];

  const nextDue = tenant.rent_due_date ? new Date(tenant.rent_due_date).toLocaleDateString('en-KE') : 'N/A';

  let reply;
  if (lastPayment) {
    reply = `Hi ${tenant.name},\n\nLast payment:\nAmount: KES ${parseFloat(lastPayment.amount).toLocaleString()}\nDate: ${new Date(lastPayment.payment_date).toLocaleDateString('en-KE')}\nRef: ${lastPayment.reference || 'N/A'}\n\nNext due date: ${nextDue}`;
  } else {
    reply = `Hi ${tenant.name},\n\nNo payments recorded yet.\n\nNext due date: ${nextDue}`;
  }

  return reply;
}

function _handleReceipt(tenant) {
  return `Hi ${tenant.name},\n\nPlease contact our office for a receipt copy.\n\nProperty: ${tenant.property_name}\nUnit: ${tenant.unit_label || ''}\n📞 0725 934 615\n📧 info@quantumcode.co.ke`;
}

function _handleMaintenance() {
  return 'Please describe your maintenance issue. Our team will create a work order.';
}

function _handleContact() {
  return `Contact us at:\n📞 0725 934 615\n📧 info@quantumcode.co.ke`;
}

// ─── Main Handler ───────────────────────────────────────────────────────────

async function showMenu(phone) {
  await _sendReply(phone, MENU_TEXT);
}

async function handleIncomingMessage(message) {
  if (!message || !message.from) return;

  const msgId = message.id;
  if (_wasProcessed(msgId)) return;
  _trackProcessed(msgId);

  const phone = _extractPhone(message);
  if (!phone) return;

  const text = _normalizeText(message.text);
  if (!text) return;

  const tenant = await _findTenant(phone);

  if (!tenant) {
    await _sendReply(
      phone,
      'We could not identify this WhatsApp number with any tenant account. Please contact our office at 0725 934 615 for assistance.'
    );
    return;
  }

  if (text === 'hi' || text === 'hello' || text === 'menu') {
    await showMenu(phone);
    return;
  }

  if (text === '1') {
    const reply = await _handleBalance(tenant);
    await _sendReply(phone, reply);
    return;
  }

  if (text === '2') {
    const reply = await _handlePaymentInfo(tenant);
    await _sendReply(phone, reply);
    return;
  }

  if (text === '3') {
    const reply = _handleReceipt(tenant);
    await _sendReply(phone, reply);
    return;
  }

  if (text === '4') {
    const reply = _handleMaintenance();
    await _sendReply(phone, reply);
    return;
  }

  if (text === '5') {
    const reply = _handleContact();
    await _sendReply(phone, reply);
    return;
  }

  await showMenu(phone);
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = { handleIncomingMessage, showMenu };
