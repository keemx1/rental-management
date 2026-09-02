'use strict';

const express = require('express');
const { pool } = require('../config/database');
const { requireAuthActive } = require('../middleware/auth');
const sessionManager = require('../whatsapp/session-manager');
const messageQueue = require('../whatsapp/message-queue');
const NotificationEngine = require('../whatsapp/NotificationEngine');
const templates = require('../whatsapp/templates');
const { normalizePhone } = require('../whatsapp/phone');

const router = express.Router();
router.use(requireAuthActive);

const notificationEngine = new NotificationEngine(sessionManager);

// ═══════════════════════════════════════════════════════════════════════════════
// Session Management
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/status', async (req, res) => {
  try {
    const stateInfo = sessionManager.getStateInfo();
    res.json({
      state: stateInfo.state.toLowerCase(),
      qrCode: stateInfo.qrCode,
      sessionInfo: stateInfo.sessionInfo,
      connectedAt: stateInfo.connectedAt,
      error: stateInfo.error,
      provider: sessionManager.getProviderType(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get WhatsApp status' });
  }
});

router.post('/connect', async (req, res) => {
  try {
    await sessionManager.connect();
    res.json({ ok: true, state: sessionManager.getState().toLowerCase() });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to connect WhatsApp' });
  }
});

router.post('/simulate-scan', async (req, res) => {
  try {
    const provider = sessionManager.getProvider();
    if (provider && typeof provider.simulateScan === 'function') {
      await provider.simulateScan();
      res.json({ ok: true, state: sessionManager.getState().toLowerCase() });
    } else {
      res.status(400).json({ error: 'Simulate scan not available for this provider' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to simulate scan' });
  }
});

router.post('/disconnect', async (req, res) => {
  try {
    await sessionManager.disconnect();
    res.json({ ok: true, state: sessionManager.getState().toLowerCase() });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to disconnect WhatsApp' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    await sessionManager.logout();
    res.json({ ok: true, state: sessionManager.getState().toLowerCase() });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to logout WhatsApp' });
  }
});

router.post('/send-test', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: 'phone and message are required' });
    }
    const normalized = normalizePhone(phone);
    if (!normalized) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    const result = await sessionManager.sendText(normalized, message);
    // Log the test message
    try {
      await pool.query(
        `INSERT INTO whatsapp_message_log (phone_number, direction, message_type, content, status, provider_message_id)
         VALUES ($1, 'outbound', 'text', $2, 'sent', $3)`,
        [normalized, message, result?.id || null]
      );
    } catch (_) {}
    res.json({ ok: true, result, message: 'Test message sent successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to send test message' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// QR Code
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/qr', async (req, res) => {
  try {
    const stateInfo = sessionManager.getStateInfo();
    if (!stateInfo.qrCode) {
      return res.json({ qrCode: null, state: stateInfo.state });
    }
    res.json({ qrCode: stateInfo.qrCode, state: stateInfo.state });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get QR code' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Message Queue
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/queue/stats', async (req, res) => {
  try {
    const stats = await messageQueue.getStats();
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get queue stats' });
  }
});

router.get('/queue/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const jobs = await messageQueue.getRecentJobs(limit);
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get recent jobs' });
  }
});

router.post('/queue/retry/:id', async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (isNaN(jobId)) {
      return res.status(400).json({ error: 'Invalid job ID' });
    }
    await messageQueue.retryJob(jobId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retry job' });
  }
});

router.delete('/queue/:id', async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (isNaN(jobId)) {
      return res.status(400).json({ error: 'Invalid job ID' });
    }
    await messageQueue.cancelJob(jobId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel job' });
  }
});

router.post('/queue/cleanup', async (req, res) => {
  try {
    const days = parseInt(req.body.days, 10) || 30;
    const deleted = await messageQueue.cleanup(days);
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cleanup queue' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Message History (log table)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/messages', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT ml.id, ml.tenant_code, ml.phone_number, ml.direction, ml.message_type, ml.content, ml.status, ml.provider_message_id, ml.error_message, ml.created_at,
              t.name as tenant_name, t.property_name
       FROM whatsapp_message_log ml
       LEFT JOIN tenants t ON ml.tenant_code = t.tenant_code
       ORDER BY ml.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await pool.query('SELECT COUNT(*) AS total FROM whatsapp_message_log');
    const total = Number(countResult.rows[0].total);

    const data = {
      messages: result.rows.map(r => ({
        ...r,
        id: Number(r.id),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
    const json = JSON.stringify(data);
    res.setHeader('Content-Type', 'application/json');
    res.send(json);
  } catch (err) {
    console.error('[WA Messages]', err.message);
    res.setHeader('Content-Type', 'application/json');
    res.status(500);
    res.send(JSON.stringify({ error: 'Failed to get messages', detail: err.message }));
  }
});

router.get('/messages/stats', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) as today,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days') as this_week,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '30 days') as this_month,
        COUNT(*) FILTER (WHERE status = 'sent') as sent_count,
        COUNT(*) FILTER (WHERE status = 'failed') as failed_count,
        COUNT(*) FILTER (WHERE status = 'delivered') as delivered_count,
        COUNT(*) as total
       FROM whatsapp_message_log`
    );
    res.json({ stats: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get message stats' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Notification Settings
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT setting_key, setting_value FROM whatsapp_settings ORDER BY setting_key`
    );
    const settings = {};
    for (const row of result.rows) {
      settings[row.setting_key] = row.setting_value;
    }
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'Request body must be an object of key-value pairs' });
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) {
      return res.status(400).json({ error: 'No settings provided' });
    }

    for (const key of keys) {
      await pool.query(
        `INSERT INTO whatsapp_settings (setting_key, setting_value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
        [key, String(updates[key])]
      );
    }

    res.json({ ok: true, updated: keys });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Templates
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/templates', async (req, res) => {
  try {
    const keys = templates.listTemplates();
    res.json({ templates: keys });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

router.get('/templates/:key', async (req, res) => {
  try {
    const content = templates.getTemplate(req.params.key);
    res.json({ key: req.params.key, content });
  } catch (err) {
    if (err.message && err.message.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to get template' });
  }
});

router.post('/templates/:key/preview', async (req, res) => {
  try {
    const key = req.params.key;
    const sampleData = req.body || {};

    // Use default sample data if none provided
    const defaults = {
      TENANT_NAME: 'JANE WAWERU',
      FIRST_NAME: 'JANE',
      AMOUNT: '15,000',
      MONTH: 'September',
      YEAR: '2026',
      HOUSE_NO: 'A302',
      PROPERTY_NAME: 'LUXURY APARTMENT',
      PROPERTY: 'LUXURY APARTMENT',
      REFERENCE: 'QGH7X4P2RB',
      DUE_DATE: '5th September 2026',
      NEXT_DUE: '5th October 2026',
      TOTAL_DUE: '15,000',
      DUE_BREAKDOWN: 'Monthly Rent: KES 15,000',
      ALLOCATION: 'Monthly Rent: KES 15,000',
      REMAINING_TEXT: ' Your account is fully paid with no outstanding balance.',
      REQUEST_ID: 'WO-2026-0001',
      DESCRIPTION: 'Leaking kitchen faucet',
      STATUS: 'In Progress',
      TECHNICIAN_TEXT: '\nAssigned to: John Kariuki',
      MESSAGE: 'Rent collection deadline extended to 10th September 2026.',
    };

    const data = { ...defaults, ...sampleData };
    const rendered = templates.previewTemplate(key, data);
    res.json({ key, rendered });
  } catch (err) {
    if (err.message && err.message.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to preview template' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bulk / General Send
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/send', async (req, res) => {
  try {
    const { phone, message, tenantCode } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: 'phone and message are required' });
    }
    const normalized = normalizePhone(phone);
    if (!normalized) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    const jobId = await messageQueue.enqueue({
      tenantCode: tenantCode || null,
      phoneNumber: normalized,
      rawMessage: message,
    });

    res.json({ ok: true, jobId });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to enqueue message' });
  }
});

router.post('/broadcast', async (req, res) => {
  try {
    const { phones, message } = req.body;
    if (!Array.isArray(phones) || phones.length === 0 || !message) {
      return res.status(400).json({ error: 'phones (array) and message are required' });
    }

    const jobIds = [];
    const invalid = [];

    for (const phone of phones) {
      const normalized = normalizePhone(phone);
      if (!normalized) {
        invalid.push(phone);
        continue;
      }
      const jobId = await messageQueue.enqueue({
        phoneNumber: normalized,
        rawMessage: message,
      });
      jobIds.push(jobId);
    }

    res.json({ ok: true, queued: jobIds.length, invalid, jobIds });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to broadcast messages' });
  }
});

router.post('/trigger-event', async (req, res) => {
  try {
    const { event, data } = req.body;
    if (!event) {
      return res.status(400).json({ error: 'event is required' });
    }

    const jobId = await notificationEngine.trigger(event, data || {});
    res.json({ ok: true, jobId });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to trigger event' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Two-Way Conversation
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/conversation/:phone', async (req, res) => {
  try {
    const normalized = normalizePhone(req.params.phone);
    if (!normalized) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    const result = await pool.query(
      `SELECT * FROM whatsapp_message_log
       WHERE phone_number = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [normalized]
    );

    res.json({ phone: normalized, messages: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

module.exports = router;
