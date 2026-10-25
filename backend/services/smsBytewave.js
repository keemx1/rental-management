'use strict';

const { pool } = require('../config/database');

const DEFAULT_API_BASE = 'https://portal.bytewavenetworks.com';

async function ensureSmsSchema() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS sms_settings (
      id SERIAL PRIMARY KEY,
      setting_key VARCHAR(64) UNIQUE NOT NULL,
      setting_value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`
  );
  await pool.query(
    `INSERT INTO sms_settings (setting_key, setting_value) VALUES
      ('api_base', '${DEFAULT_API_BASE}'),
      ('api_token', ''),
      ('sender_id', '')
    ON CONFLICT (setting_key) DO NOTHING;`
  );
}

// The provider portal displays the token as "Api Token: <secret>" — users
// often copy the label together with the value. Tokens never contain
// whitespace, so strip both the label and any stray spaces/newlines.
function normalizeApiToken(raw) {
  return String(raw || '')
    .replace(/^\s*api\s*token\s*:\s*/i, '')
    .replace(/\s+/g, '');
}

async function getSmsSettings() {
  const result = await pool.query(
    `SELECT setting_key, setting_value FROM sms_settings`
  );
  const settings = {};
  for (const row of result.rows) {
    settings[row.setting_key] = row.setting_value || '';
  }
  return {
    api_base: settings.api_base || DEFAULT_API_BASE,
    api_token: normalizeApiToken(settings.api_token),
    sender_id: settings.sender_id || '',
  };
}

async function setSmsSetting(key, value) {
  await pool.query(
    `INSERT INTO sms_settings (setting_key, setting_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
    [key, value == null ? '' : String(value)]
  );
}

function buildHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

// Ultimate SMS v3 (Bytewave): POST {base}/api/v3/sms/send
// body: { message, recipient, sender_id?, type }
// response: { status: 'success'|'error', message, data }
async function sendSms({ to, message, senderId }) {
  const settings = await getSmsSettings();
  if (!settings.api_token) {
    const err = new Error('SMS API token not configured — save it in SMS Settings first');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const base = String(settings.api_base || DEFAULT_API_BASE).replace(/\/+$/, '');
  const from = senderId || settings.sender_id;
  const body = { message, recipient: to, type: 'plain' };
  if (from) body.sender_id = from;

  const res = await fetch(`${base}/api/v3/sms/send`, {
    method: 'POST',
    headers: buildHeaders(settings.api_token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error(data.message || `SMS gateway HTTP ${res.status}`);
    err.httpStatus = res.status;
    err.data = data;
    throw err;
  }
  if (data && data.status === 'error') {
    const err = new Error(data.message || 'SMS gateway rejected the message');
    err.data = data;
    throw err;
  }
  return data;
}

// Ultimate SMS v3: GET {base}/api/v3/balance
async function getBalance() {
  const settings = await getSmsSettings();
  if (!settings.api_token) {
    const err = new Error('SMS API token not configured — save it in SMS Settings first');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const base = String(settings.api_base || DEFAULT_API_BASE).replace(/\/+$/, '');
  const res = await fetch(`${base}/api/v3/balance`, {
    method: 'GET',
    headers: buildHeaders(settings.api_token),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error(data.message || `SMS gateway HTTP ${res.status}`);
    err.httpStatus = res.status;
    err.data = data;
    throw err;
  }
  if (data && data.status === 'error') {
    const err = new Error(data.message || 'Failed to fetch SMS balance');
    err.data = data;
    throw err;
  }
  return data;
}

module.exports = {
  ensureSmsSchema,
  getSmsSettings,
  setSmsSetting,
  normalizeApiToken,
  sendSms,
  getBalance,
  DEFAULT_API_BASE,
};
