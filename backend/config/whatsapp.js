/**
 * WhatsApp messaging abstraction.
 * Supports two backends selected by WHATSAPP_PROVIDER env var:
 *   - "twilio"  → Twilio WhatsApp API (default, recommended)
 *   - "meta"    → Meta Cloud API (legacy)
 *
 * Twilio requires:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER
 *
 * Meta requires:
 *   WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN
 *
 * Both require a pre-approved template named WHATSAPP_TEMPLATE_NAME
 * with a single body variable {{1}} that receives the full message text.
 */

const fs = require('fs');
const path = require('path');

const SEND_DELAY_MS = Number(process.env.WHATSAPP_SEND_DELAY_MS) || 2500;
const PROVIDER = (process.env.WHATSAPP_PROVIDER || 'twilio').toLowerCase();

let gatewayStatus = 'offline';
let initPromise = null;
let latestError = null;

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

function isTwilio() {
  return PROVIDER === 'twilio';
}

function isMeta() {
  return PROVIDER === 'meta';
}

// ---------------------------------------------------------------------------
// Twilio helpers
// ---------------------------------------------------------------------------

let twilioClient = null;

function getTwilioClient() {
  if (twilioClient) return twilioClient;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required');
  const twilio = require('twilio');
  twilioClient = twilio(accountSid, authToken);
  return twilioClient;
}

function getTwilioWhatsAppNumber() {
  return process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
}

// ---------------------------------------------------------------------------
// Meta Cloud API helpers
// ---------------------------------------------------------------------------

const META_API_VERSION = 'v22.0';

function getPhoneNumberId() {
  return process.env.WHATSAPP_PHONE_NUMBER_ID;
}

function getAccessToken() {
  return process.env.WHATSAPP_ACCESS_TOKEN;
}

function metaGraphUrl(pathSuffix) {
  return `https://graph.facebook.com/${META_API_VERSION}/${pathSuffix.replace(/^\//, '')}`;
}

async function metaGraphPost(pathSuffix, body) {
  const url = metaGraphUrl(pathSuffix);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.error_user_title || `HTTP ${res.status}`;
    throw new Error(`Meta API: ${msg}`);
  }
  return data;
}

async function metaGraphGet(pathSuffix) {
  const url = metaGraphUrl(pathSuffix);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Meta API: ${data?.error?.message || `HTTP ${res.status}`}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Template name (shared)
// ---------------------------------------------------------------------------

function getTemplateName() {
  return process.env.WHATSAPP_TEMPLATE_NAME || 'rental_payment_notice';
}

function getTemplateLanguage() {
  return process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en';
}

async function getTemplateStatus(templateName = getTemplateName()) {
  if (!isMeta()) return null;
  const waba = process.env.WHATSAPP_WABA_ID;
  if (!waba) return null;
  try {
    const data = await metaGraphGet(
      `${waba}/message_templates?fields=name,status&name=${encodeURIComponent(templateName)}`
    );
    const row = (data?.data || []).find((t) => t.name === templateName);
    return row ? row.status : null;
  } catch (err) {
    console.error('[WhatsApp] getTemplateStatus failed:', err.message);
    return null;
  }
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

// ---------------------------------------------------------------------------
// Sending — Twilio
// ---------------------------------------------------------------------------

async function sendTextMessageTwilio(phoneNumber, body) {
  const chatId = normalizePhone(phoneNumber);
  try {
    const client = getTwilioClient();
    const message = await client.messages.create({
      from: getTwilioWhatsAppNumber(),
      to: `whatsapp:+${chatId}`,
      contentSid: process.env.TWILIO_TEMPLATE_CONTENT_SID || undefined,
      contentVariables: process.env.TWILIO_TEMPLATE_CONTENT_SID ? JSON.stringify({ '1': body }) : undefined,
      body: process.env.TWILIO_TEMPLATE_CONTENT_SID ? undefined : body,
    });
    return {
      messageId: message.sid,
      ack: 1,
      status: 'Sent',
      chatId,
    };
  } catch (err) {
    return {
      messageId: null,
      ack: -1,
      status: 'Failed',
      chatId,
      failureReason: err.message,
    };
  }
}

async function sendMediaMessageTwilio(phoneNumber, filePath, caption = '') {
  const chatId = normalizePhone(phoneNumber);
  try {
    const client = getTwilioClient();
    const message = await client.messages.create({
      from: getTwilioWhatsAppNumber(),
      to: `whatsapp:+${chatId}`,
      body: caption || 'Your document has been generated.',
      mediaUrl: [filePath],
    });
    return {
      messageId: message.sid,
      ack: 1,
      status: 'Sent',
      chatId,
    };
  } catch (err) {
    return sendTextMessageTwilio(phoneNumber, caption
      ? `${caption}\n\n(Open dashboard to view/download the document.)`
      : 'Your document has been generated. Please check your dashboard to view/download it.');
  }
}

// ---------------------------------------------------------------------------
// Sending — Meta Cloud API
// ---------------------------------------------------------------------------

async function sendTextMessageMeta(phoneNumber, body) {
  const chatId = normalizePhone(phoneNumber);
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: chatId,
      type: 'template',
      template: {
        name: getTemplateName(),
        language: { code: getTemplateLanguage() },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: body }] },
        ],
      },
    };
    const data = await metaGraphPost(`${getPhoneNumberId()}/messages`, payload);
    const messageId = data?.messages?.[0]?.id || null;
    return { messageId, ack: 1, status: 'Sent', chatId };
  } catch (err) {
    return { messageId: null, ack: -1, status: 'Failed', chatId, failureReason: err.message };
  }
}

async function sendMediaMessageMeta(phoneNumber, filePath, caption = '') {
  const chatId = normalizePhone(phoneNumber);
  try {
    const docTemplate = process.env.WHATSAPP_DOCUMENT_TEMPLATE_NAME || 'rental_document';
    const mediaId = await uploadMediaMeta(filePath);
    const fileName = path.basename(filePath);
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: chatId,
      type: 'template',
      template: {
        name: docTemplate,
        language: { code: getTemplateLanguage() },
        components: [
          { type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename: fileName } }] },
          { type: 'body', parameters: [{ type: 'text', text: caption || 'Please find the attached document.' }] },
        ],
      },
    };
    const data = await metaGraphPost(`${getPhoneNumberId()}/messages`, payload);
    return { messageId: data?.messages?.[0]?.id || null, ack: 1, status: 'Sent', chatId };
  } catch (err) {
    return sendTextMessageMeta(phoneNumber, caption
      ? `${caption}\n\n(Open dashboard to view/download the document.)`
      : 'Your document has been generated. Please check your dashboard to view/download it.');
  }
}

async function uploadMediaMeta(filePath) {
  const stat = fs.statSync(filePath);
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';
  const boundary = `----FormBoundary${Date.now()}`;
  let body = '';
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="messaging_product"\r\n\r\n`;
  body += `whatsapp\r\n`;
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`;
  body += `Content-Type: ${mimeType}\r\n\r\n`;
  const bodyBuffer = Buffer.from(body, 'utf-8');
  const fileBuffer = fs.readFileSync(filePath);
  const footer = `\r\n--${boundary}--\r\n`;
  const footerBuffer = Buffer.from(footer, 'utf-8');
  const fullBody = Buffer.concat([bodyBuffer, fileBuffer, footerBuffer]);
  const url = metaGraphUrl(`${getPhoneNumberId()}/media`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(fullBody.length),
    },
    body: fullBody,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Media upload failed: ${data?.error?.message || `HTTP ${res.status}`}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// Sending — unified interface
// ---------------------------------------------------------------------------

async function sendTextMessage(phoneNumber, body, options = {}) {
  await waitUntilReady();
  if (isTwilio()) return sendTextMessageTwilio(phoneNumber, body);
  return sendTextMessageMeta(phoneNumber, body, options);
}

async function sendMediaMessage(phoneNumber, filePath, caption = '') {
  await waitUntilReady();
  if (isTwilio()) return sendMediaMessageTwilio(phoneNumber, filePath, caption);
  return sendMediaMessageMeta(phoneNumber, filePath, caption);
}

// ---------------------------------------------------------------------------
// Bulk sending
// ---------------------------------------------------------------------------

async function sendSequentialMessages(targets, body, onEach) {
  await waitUntilReady();
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
// Gateway lifecycle
// ---------------------------------------------------------------------------

function initializeWhatsApp() {
  if (process.env.MOCK_WHATSAPP === 'true') {
    gatewayStatus = 'ready';
    initPromise = Promise.resolve();
    return initPromise;
  }

  if (initPromise) return initPromise;
  gatewayStatus = 'syncing';
  latestError = null;

  initPromise = (async () => {
    try {
      if (isTwilio()) {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        if (!accountSid || !authToken) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required');
        getTwilioClient();
        // Validate by fetching account info
        const account = await getTwilioClient().api.accounts(accountSid).fetch();
        gatewayStatus = 'ready';
        latestError = null;
        console.log(`[WhatsApp] Twilio connected — account: ${account.friendlyName}`);
      } else {
        const pid = getPhoneNumberId();
        if (!pid) throw new Error('WHATSAPP_PHONE_NUMBER_ID not set');
        const token = getAccessToken();
        if (!token) throw new Error('WHATSAPP_ACCESS_TOKEN not set');
        await metaGraphGet(`${pid}`);
        gatewayStatus = 'ready';
        latestError = null;
        console.log('[WhatsApp] Meta Cloud API connected');
      }
    } catch (err) {
      gatewayStatus = 'offline';
      latestError = err.message;
      console.error(`[WhatsApp] Init failed: ${err.message}`);
    }
  })();

  return initPromise;
}

function clearInitState() {
  initPromise = null;
  gatewayStatus = 'offline';
  latestError = null;
}

async function resetSession() {
  clearInitState();
  twilioClient = null;
  initializeWhatsApp();
  try { await initPromise; } catch (_) { /* handled */ }
}

function getGatewayStatus() {
  return gatewayStatus;
}

function getGatewayState() {
  return {
    status: gatewayStatus,
    qr: null,
    needsScan: gatewayStatus !== 'ready',
    message: latestError
      ? `${PROVIDER.toUpperCase()}: ${latestError}`
      : gatewayStatus === 'ready'
        ? `WhatsApp (${PROVIDER}) is connected and ready.`
        : gatewayStatus === 'syncing'
          ? `Validating ${PROVIDER} credentials…`
          : `WhatsApp not configured. Set ${PROVIDER === 'twilio' ? 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN' : 'WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN'} in .env`,
    canReset: true,
    provider: PROVIDER,
  };
}

async function waitUntilReady(timeoutMs = 120000) {
  if (gatewayStatus === 'ready') return true;
  await initializeWhatsApp();
  if (gatewayStatus === 'ready') return true;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (gatewayStatus === 'ready') return true;
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(latestError || `WhatsApp (${PROVIDER}) not ready. Check .env configuration.`);
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
  // Both Twilio and Meta deliver status via webhooks — stub for now.
}

const dummyClient = {
  destroy: async () => {
    console.log(`[WhatsApp] No-op destroy (${PROVIDER}).`);
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
  normalizePhoneToChatId,
  sendTextMessage,
  sendMediaMessage,
  sendSequentialMessages,
  getTemplateName,
  getTemplateStatus,
  ackToStatus,
  setOnAckCallback,
  isTwilio,
  isMeta,

  AUTH_ROOT: null,
};
