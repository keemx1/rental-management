'use strict';

const COUNTRY_CODE = '254';

function normalizePhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = COUNTRY_CODE + digits.slice(1);
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.length === 9) digits = COUNTRY_CODE + digits;
  if (digits.length === 12 && digits.startsWith(COUNTRY_CODE)) return digits;
  if (digits.length === 10 && digits.startsWith('254')) return digits;
  return null;
}

function toWhatsAppJid(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  return normalized + '@s.whatsapp.net';
}

function fromWhatsAppJid(jid) {
  if (!jid) return null;
  return jid.replace('@s.whatsapp.net', '').replace('@lid', '');
}

function formatPhoneDisplay(phone) {
  const n = normalizePhone(phone);
  if (!n) return phone || '';
  return '+254 ' + n.slice(3, 6) + ' ' + n.slice(6, 9) + ' ' + n.slice(9);
}

module.exports = { normalizePhone, toWhatsAppJid, fromWhatsAppJid, formatPhoneDisplay, COUNTRY_CODE };
