/**
 * Meta Cloud API WhatsApp integration.
 * Replaces whatsapp-web.js with direct HTTPS calls to graph.facebook.com.
 *
 * Required env vars:
 *   WHATSAPP_PHONE_NUMBER_ID — Meta phone number ID (from WABA)
 *   WHATSAPP_ACCESS_TOKEN   — Permanent access token from Meta Business
 *   WHATSAPP_TEMPLATE_NAME  — Approved template name (default: 'rental_notification')
 *
 * The template should have a single body variable {{1}} that receives the
 * full message text. Create it in Meta Business Manager → WABA → Message templates.
 *
 * Media messages (documents) are sent as text templates saying the document
 * is ready — downloads happen via the dashboard.
 */

const fs = require('fs');
const path = require('path');

const API_VERSION = 'v22.0';
const SEND_DELAY_MS = Number(process.env.WHATSAPP_SEND_DELAY_MS) || 2500;

let gatewayStatus = 'offline';
let initPromise = null;
let latestError = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPhoneNumberId() {
  const v = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return v;
}

function getAccessToken() {
  const v = process.env.WHATSAPP_ACCESS_TOKEN;
  return v;
}

function getTemplateName() {
  return process.env.WHATSAPP_TEMPLATE_NAME || 'rental_notification';
}

/**
 * Check whether the current text template is approved on the WABA.
 * Requires WHATSAPP_WABA_ID. Returns null if the WABA ID is not configured.
 */
async function getTemplateStatus(templateName = getTemplateName()) {
  const waba = process.env.WHATSAPP_WABA_ID;
  if (!waba) return null;
  try {
    const data = await graphGet(
      `${waba}/message_templates?fields=name,status&name=${encodeURIComponent(templateName)}`
    );
    const row = (data?.data || []).find((t) => t.name === templateName);
    return row ? row.status : null;
  } catch (err) {
    console.error('[WhatsApp Cloud API] getTemplateStatus failed:', err.message);
    return null;
  }
}

function getTemplateLanguage() {
  return process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en';
}

function graphUrl(pathSuffix) {
  return `https://graph.facebook.com/${API_VERSION}/${pathSuffix.replace(/^\//, '')}`;
}

async function graphPost(pathSuffix, body) {
  const url = graphUrl(pathSuffix);
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

async function graphGet(pathSuffix) {
  const url = graphUrl(pathSuffix);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Meta API: ${data?.error?.message || `HTTP ${res.status}`}`);
  }
  return data;
}

async function uploadMedia(filePath) {
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

  // Build multipart body manually to avoid external dependencies
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

  const url = graphUrl(`${getPhoneNumberId()}/media`);
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
  if (!res.ok) {
    throw new Error(`Media upload failed: ${data?.error?.message || `HTTP ${res.status}`}`);
  }
  return data.id;
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
      const pid = getPhoneNumberId();
      if (!pid) throw new Error('WHATSAPP_PHONE_NUMBER_ID not set');
      const token = getAccessToken();
      if (!token) throw new Error('WHATSAPP_ACCESS_TOKEN not set');

      // Validate by fetching the phone number
      await graphGet(`${pid}`);
      gatewayStatus = 'ready';
      latestError = null;
      console.log('[WhatsApp Cloud API] Connected — ready to send via Meta Cloud API');
    } catch (err) {
      gatewayStatus = 'offline';
      latestError = err.message;
      console.error('[WhatsApp Cloud API] Init failed:', err.message);
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
  initializeWhatsApp();

  // Wait briefly for validation
  try {
    await initPromise;
  } catch (_) {
    /* already handled */
  }
}

function getGatewayStatus() {
  return gatewayStatus;
}

function getGatewayState() {
  return {
    status: gatewayStatus,
    qr: null, // no QR with Cloud API
    needsScan: gatewayStatus !== 'ready',
    message: latestError
      ? `Cloud API: ${latestError}`
      : gatewayStatus === 'ready'
        ? 'WhatsApp Cloud API is connected and ready to send messages.'
        : gatewayStatus === 'syncing'
          ? 'Validating Meta Cloud API credentials…'
          : 'WhatsApp Cloud API not configured. Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN in .env',
    canReset: true,
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

  throw new Error(
    latestError || 'WhatsApp Cloud API not ready. Check .env configuration.'
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  return digits; // E.164 without +
}

function normalizePhoneToChatId(phone) {
  return normalizePhone(phone);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Send a message via a Meta Cloud API template.
 * Template should have body variable {{1}} that receives the full message.
 */
async function sendTextMessage(phoneNumber, body, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  const chatId = normalizePhone(phoneNumber);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: chatId,
      type: 'template',
      template: {
        name: getTemplateName(),
        language: { code: getTemplateLanguage() },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'text', text: body }],
          },
        ],
      },
    };

    const data = await graphPost(`${getPhoneNumberId()}/messages`, payload);
    clearTimeout(timer);

    const messageId = data?.messages?.[0]?.id || null;
    return {
      messageId,
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

/**
 * Send a document as a template with document header.
 * Falls back to text template if upload fails.
 *
 * Requires a template named "rental_document" (or WHATSAPP_DOCUMENT_TEMPLATE_NAME)
 * with a document header component.
 */
async function sendMediaMessage(phoneNumber, filePath, caption = '') {
  const chatId = normalizePhone(phoneNumber);

  // Try sending as document template
  const docTemplate = process.env.WHATSAPP_DOCUMENT_TEMPLATE_NAME || 'rental_document';
  try {
    const mediaId = await uploadMedia(filePath);
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
          {
            type: 'header',
            parameters: [
              {
                type: 'document',
                document: { id: mediaId, filename: fileName },
              },
            ],
          },
          {
            type: 'body',
            parameters: [{ type: 'text', text: caption || 'Please find the attached document.' }],
          },
        ],
      },
    };

    const data = await graphPost(`${getPhoneNumberId()}/messages`, payload);
    const messageId = data?.messages?.[0]?.id || null;
    return {
      messageId,
      ack: 1,
      status: 'Sent',
      chatId,
    };
  } catch (err) {
    // Fallback: send a text template saying the document is ready
    const fallbackBody = caption
      ? `${caption}\n\n(Open dashboard to view/download the document.)`
      : 'Your document has been generated. Please check your dashboard to view/download it.';
    return sendTextMessage(phoneNumber, fallbackBody);
  }
}

/**
 * Send the same body to multiple targets sequentially.
 */
async function sendSequentialMessages(targets, body, onEach) {
  await waitUntilReady();
  const results = [];

  for (let i = 0; i < targets.length; i++) {
    const { phone, clientId } = targets[i];
    let status = 'Sent';
    let error = null;

    try {
      const chatId = normalizePhone(phone);
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
      await graphPost(`${getPhoneNumberId()}/messages`, payload);
    } catch (err) {
      status = 'Failed';
      error = err.message;
    }

    const row = { clientId: clientId ?? null, phone, status, error };
    results.push(row);
    if (onEach) await onEach(row);
    if (i < targets.length - 1) await sleep(SEND_DELAY_MS);
  }

  return results;
}

// ---------------------------------------------------------------------------
// ACK / status (Cloud API uses webhooks — this is a stub)
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
  // Cloud API delivers status updates via Webhook, not callbacks.
  // To enable: set up a webhook endpoint and point Meta to /api/whatsapp-webhook.
  // For now, delivery status is tracked via the API response.
}

// Dummy client for graceful shutdown compatibility.
const dummyClient = {
  destroy: async () => {
    console.log('[WhatsApp Cloud API] No-op destroy (no persistent connection).');
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  get client() {
    return dummyClient;
  },

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

  /** @deprecated No auth directory used — kept for compatibility */
  AUTH_ROOT: null,
};
