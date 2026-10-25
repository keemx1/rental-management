/**
 * WhatsApp messaging — Tabana-style QR-linked Baileys session ONLY.
 *
 * This is the single WhatsApp integration. All sends go through the linked
 * session (your own number, no trial limits, real media delivery). When the
 * session is not connected, every send reports an honest failure — nothing
 * ever claims success without transmitting. Reconnect by scanning the QR
 * code in the WhatsApp view.
 */

const path = require('path');

const SEND_DELAY_MS = Number(process.env.WHATSAPP_SEND_DELAY_MS) || 2500;

// ---------------------------------------------------------------------------
// Provider identity (single integration)
// ---------------------------------------------------------------------------

function isTwilio() {
  return false;
}

function isMeta() {
  return false;
}

function isBaileys() {
  return true;
}

// ---------------------------------------------------------------------------
// Phone number helpers
// ---------------------------------------------------------------------------

function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') throw new Error('Invalid phone number');
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 10) digits = `254${digits.slice(1)}`;
  else if (digits.length === 9 && /^[17]/.test(digits)) digits = `254${digits}`;
  else if (digits.length < 9) throw new Error(`Unrecognized phone format: ${phone}`);
  if (!digits.startsWith('254')) throw new Error(`Could not normalize to Kenya format: ${phone}`);
  return digits;
}

function normalizePhoneToChatId(phone) {
  return normalizePhone(phone);
}

function sessionManager() {
  return require('../whatsapp/session-manager');
}

function connected() {
  try {
    const sm = sessionManager();
    return sm && typeof sm.getState === 'function' && sm.getState() === 'CONNECTED';
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sending — Baileys linked session only
// ---------------------------------------------------------------------------

async function sendTextMessage(phoneNumber, body) {
  let chatId = null;
  try {
    chatId = normalizePhone(phoneNumber);
  } catch (err) {
    return { messageId: null, ack: -1, status: 'Failed', chatId: phoneNumber, failureReason: err.message };
  }
  if (!connected()) {
    return { messageId: null, ack: -1, status: 'Failed', chatId, failureReason: 'WhatsApp session not connected — scan the QR code in the WhatsApp view to reconnect' };
  }
  try {
    const sent = await sessionManager().sendText(chatId, body);
    return { messageId: (sent && sent.id) || null, ack: 1, status: 'Sent', chatId };
  } catch (err) {
    return { messageId: null, ack: -1, status: 'Failed', chatId, failureReason: err.message };
  }
}

async function sendMediaMessage(phoneNumber, filePath, caption = '') {
  let chatId = null;
  try {
    chatId = normalizePhone(phoneNumber);
  } catch (err) {
    return { messageId: null, ack: -1, status: 'Failed', chatId: phoneNumber, failureReason: err.message, channel: 'baileys', mediaDelivered: false };
  }
  if (!connected()) {
    return { messageId: null, ack: -1, status: 'Failed', chatId, channel: 'baileys', mediaDelivered: false, failureReason: 'WhatsApp session not connected — scan the QR code in the WhatsApp view to reconnect' };
  }
  try {
    const fs = require('fs');
    const buf = fs.readFileSync(filePath);
    const ext = String(filePath || '').toLowerCase();
    const mimetype = ext.endsWith('.png') ? 'image/png'
      : /\.jpe?g$/.test(ext) ? 'image/jpeg' : 'application/pdf';
    const sent = await sessionManager().sendDocument(chatId, buf, mimetype, path.basename(filePath) || 'document.pdf');
    return { messageId: (sent && sent.id) || null, ack: 1, status: 'Sent', chatId, channel: 'baileys', mediaDelivered: true };
  } catch (err) {
    return { messageId: null, ack: -1, status: 'Failed', chatId, channel: 'baileys', mediaDelivered: false, failureReason: err.message };
  }
}

// ---------------------------------------------------------------------------
// Smart document delivery — the Baileys session IS the delivery channel.
// Unified honest result: 'Sent' always means the document itself went out.
// Never throws — check result.status / mediaDelivered instead.
// ---------------------------------------------------------------------------

async function sendDocumentSmart(phoneNumber, filePath, caption = '') {
  const r = await sendMediaMessage(phoneNumber, filePath, caption);
  if (!r || r.status !== 'Sent') {
    return { status: 'Failed', channel: 'baileys', mediaDelivered: false, messageId: (r && r.messageId) || null, failureReason: (r && r.failureReason) || 'WhatsApp session not connected' };
  }
  return { status: 'Sent', channel: 'baileys', mediaDelivered: true, messageId: r.messageId || null, failureReason: null };
}

// ---------------------------------------------------------------------------
// Bulk sending
// ---------------------------------------------------------------------------

async function sendSequentialMessages(targets, body, onEach) {
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const { phone, clientId } = targets[i];
    let result;
    try {
      result = await sendTextMessage(phone, body);
    } catch (err) {
      result = { messageId: null, ack: -1, status: 'Failed', chatId: phone, failureReason: err.message };
    }
    const row = { clientId: clientId ?? null, phone, ...result };
    results.push(row);
    if (onEach) await onEach(row);
    if (i < targets.length - 1) await sleep(SEND_DELAY_MS);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Gateway lifecycle (session-owned; this module only reports it)
// ---------------------------------------------------------------------------

function getGatewayStatus() {
  try {
    return sessionManager().getState() === 'CONNECTED' ? 'ready' : 'offline';
  } catch (_) {
    return 'offline';
  }
}

function getGatewayState() {
  const ready = getGatewayStatus() === 'ready';
  return {
    status: ready ? 'ready' : 'offline',
    qr: null,
    needsScan: !ready,
    message: ready
      ? 'WhatsApp (linked session) is connected and ready.'
      : 'WhatsApp session not connected. Open the WhatsApp view and scan the QR code to connect.',
    canReset: true,
    provider: 'baileys',
  };
}

async function initializeWhatsApp() {
  return getGatewayStatus();
}

async function resetSession() {
  return getGatewayStatus();
}

async function waitUntilReady(timeoutMs = 5000) {
  if (getGatewayStatus() === 'ready') return true;
  throw new Error('WhatsApp session not connected — scan the QR code in the WhatsApp view to reconnect');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// ACK / status
// ---------------------------------------------------------------------------

function ackToStatus(ack) {
  if (ack == null) return 'Pending';
  if (ack === -1) return 'Failed';
  if (ack === 0) return 'Pending';
  if (ack === 1) return 'Sent';
  if (ack === 2) return 'Delivered';
  if (ack >= 3) return 'Read';
  return 'Pending';
}

function setOnAckCallback(_cb) {
  // Delivery receipts arrive via Baileys events — stub for now.
}

// Deprecated template hooks (kept so older callers keep loading; the
// Meta/Twilio template integration has been removed).
function getTemplateName() {
  return null;
}

async function getTemplateStatus() {
  return null;
}

const dummyClient = {
  destroy: async () => {
    console.log('[WhatsApp] No-op destroy (baileys).');
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  get client() { return dummyClient; },

  initializeWhatsApp,
  resetSession,
  getGatewayStatus,
  getGatewayState,
  waitUntilReady,
  normalizePhone,
  normalizePhoneToChatId,
  sendTextMessage,
  sendMediaMessage,
  sendDocumentSmart,
  sendSequentialMessages,
  getTemplateName,
  getTemplateStatus,
  ackToStatus,
  setOnAckCallback,
  isTwilio,
  isMeta,
  isBaileys,

  AUTH_ROOT: null,
};
