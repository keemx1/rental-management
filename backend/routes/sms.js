'use strict';

const express = require('express');
const { pool } = require('../config/database');
const { requireAuthActive } = require('../middleware/auth');
const { normalizePhone } = require('../whatsapp/phone');
const smsService = require('../services/smsBytewave');

const router = express.Router();
router.use(requireAuthActive);

// ═══════════════════════════════════════════════════════════════════════════════
// Status & Settings (API token never leaves the server after save)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/status', async (req, res) => {
  try {
    const settings = await smsService.getSmsSettings();
    res.json({
      provider: 'bytewave',
      providerName: 'Bytewave Networks (Ultimate SMS)',
      apiBase: settings.api_base,
      hasToken: Boolean(settings.api_token),
      senderId: settings.sender_id,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get SMS status' });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const body = req.body || {};
    const updated = [];
    // api_token is write-only: empty/missing = keep existing value
    if (typeof body.api_token === 'string' && body.api_token.trim() !== '') {
      const token = smsService.normalizeApiToken(body.api_token);
      if (!token) {
        return res.status(400).json({ error: 'API token is empty after cleanup' });
      }
      await smsService.setSmsSetting('api_token', token);
      updated.push('api_token');
    }
    if (body.sender_id !== undefined) {
      await smsService.setSmsSetting('sender_id', String(body.sender_id || '').trim());
      updated.push('sender_id');
    }
    if (typeof body.api_base === 'string' && body.api_base.trim() !== '') {
      let base = body.api_base.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(base)) {
        return res.status(400).json({ error: 'API base must start with http:// or https://' });
      }
      await smsService.setSmsSetting('api_base', base);
      updated.push('api_base');
    }
    if (updated.length === 0) {
      return res.status(400).json({ error: 'No settings provided (API token, if set, must be non-empty)' });
    }
    res.json({ ok: true, updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update SMS settings' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Balance
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/balance', async (req, res) => {
  try {
    const data = await smsService.getBalance();
    res.json({ ok: true, data });
  } catch (err) {
    const status = err.code === 'NOT_CONFIGURED' ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Send Test
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/send-test', async (req, res) => {
  try {
    const { phone, message } = req.body || {};
    if (!phone || !message) {
      return res.status(400).json({ error: 'phone and message are required' });
    }
    const normalized = normalizePhone(phone);
    if (!normalized) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    try {
      const result = await smsService.sendSms({ to: normalized, message });
      try {
        await pool.query(
          `INSERT INTO message_logs (message_type, message_body, status, whatsapp_message_id)
           VALUES ('SMS Test', $1, 'Sent', $2)`,
          [message, result?.data?.uid || result?.data?.id || null]
        );
      } catch (_) {}
      res.json({ ok: true, result, message: 'SMS sent successfully' });
    } catch (sendErr) {
      try {
        await pool.query(
          `INSERT INTO message_logs (message_type, message_body, status, failure_reason)
           VALUES ('SMS Test', $1, 'Failed', $2)`,
          [message, String(sendErr.message || 'Send failed').slice(0, 500)]
        );
      } catch (_) {}
      const status = sendErr.code === 'NOT_CONFIGURED' ? 400 : 500;
      res.status(status).json({ error: sendErr.message || 'Failed to send SMS' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to send SMS' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SMS Message History (message_logs rows of type SMS%)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/messages', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT ml.id, ml.tenant_code, t.phone_number, ml.message_type,
              ml.message_body AS content, ml.status,
              ml.failure_reason AS error_message, ml.logged_at AS created_at,
              t.name AS tenant_name, t.property_name
       FROM message_logs ml
       LEFT JOIN tenants t ON ml.tenant_code = t.tenant_code
       WHERE ml.message_type LIKE 'SMS%'
       ORDER BY ml.logged_at DESC, ml.id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM message_logs WHERE message_type LIKE 'SMS%'`
    );
    const total = Number(countResult.rows[0].total);
    res.json({
      messages: result.rows.map(r => ({ ...r, id: Number(r.id) })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[SMS Messages]', err.message);
    res.status(500).json({ error: 'Failed to get SMS messages' });
  }
});

module.exports = router;
