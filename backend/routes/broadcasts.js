const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const sessionManager = require('../whatsapp/session-manager');

const router = express.Router();
router.use(requireAuthActive);

function applyTemplate(body, tenant, house) {
  return String(body || '')
    .replaceAll('{{client_name}}', tenant.name || 'Client')
    .replaceAll('{{tenant_code}}', tenant.tenant_code || '')
    .replaceAll('{{house_name}}', house?.house_name || tenant.property_name || 'House')
    .replaceAll('{{house_number}}', tenant.unit_label || '');
}

router.post('/send', async (req, res) => {
  try {
    const { template_id, message_body, target_type, house_id, channel } = req.body;
    if (!message_body && !template_id) {
      return res.status(400).json({ error: 'message_body or template_id required' });
    }
    if (!['all', 'house'].includes(target_type)) {
      return res.status(400).json({ error: 'target_type must be all or house' });
    }
    if (target_type === 'house' && !house_id) {
      return res.status(400).json({ error: 'house_id required when target_type=house' });
    }

    // Delivery channel: whatsapp (default) | sms | both — same semantics as
    // the tenant message modal.
    const chan = ['whatsapp', 'sms', 'both'].includes(channel) ? channel : 'whatsapp';
    const wantsWa = chan === 'whatsapp' || chan === 'both';
    const wantsSms = chan === 'sms' || chan === 'both';

    const smsService = require('../services/smsBytewave');
    const { normalizePhone } = require('../whatsapp/phone');
    let smsConfigured = false;
    if (wantsSms) {
      let settings = null;
      try { settings = await smsService.getSmsSettings(); } catch (_) { settings = null; }
      smsConfigured = !!(settings && settings.api_token);
      // SMS is the ONLY channel and is not configured -> clear 400 (no sends).
      if (!smsConfigured && chan === 'sms') {
        return res.status(400).json({ error: 'SMS is not configured — save the SMS API token in SMS Settings first.' });
      }
    }

    let baseBody = message_body;
    if (template_id) {
      const tpl = await store.getTemplate(template_id);
      if (!tpl) return res.status(404).json({ error: 'Template not found' });
      baseBody = tpl.body;
    }

    const tenants =
      target_type === 'house'
        ? await store.listTenants({ house_id })
        : await store.listTenants();

    if (!tenants.length) return res.status(400).json({ error: 'No target clients found' });
    const results = [];
    const tally = {
      whatsapp: { sent: 0, failed: 0 },
      sms: { sent: 0, failed: 0 },
    };

    for (const tenant of tenants) {
      const house = tenant?.house_id ? await store.getHouse(tenant.house_id) : null;
      const renderedBody = applyTemplate(baseBody, tenant, house);
      const entry = { tenant_id: tenant.id, tenant_name: tenant.name, status: 'Sent', error: null };

      // ── WhatsApp leg ──────────────────────────────────────────────────────
      if (wantsWa) {
        let status = 'Sent';
        let error = null;
        let whatsappMessageId = null;
        try {
          // Linked Baileys session delivers; honest per-recipient status either way.
          try {
            const result = await sessionManager.sendText(tenant.phone_number, renderedBody);
            whatsappMessageId = result.id;
          } catch (_) {
            const fallback = require('../config/whatsapp');
            const r = await fallback.sendTextMessage(tenant.phone_number, renderedBody);
            if (r.status !== 'Sent') throw new Error(r.failureReason || 'provider could not deliver the message');
            whatsappMessageId = r.messageId || null;
          }
        } catch (err) {
          status = 'failed';
          error = err.message;
        }
        tally.whatsapp[status === 'Sent' ? 'sent' : 'failed']++;
        entry.whatsapp = { status, error };
        await store.logMessage({
          tenantId: tenant.id,
          messageType: 'Broadcast',
          messageBody: renderedBody,
          status,
          whatsappMessageId,
          failureReason: error,
        });
        // Also log to whatsapp_message_log for stats (WhatsApp legs only)
        try {
          const { pool } = require('../config/database');
          await pool.query(
            `INSERT INTO whatsapp_message_log (tenant_code, phone_number, direction, message_type, content, status, provider_message_id, error_message)
             VALUES ($1, $2, 'outbound', 'broadcast', $3, $4, $5, $6)`,
            [tenant.tenant_code, tenant.phone_number, renderedBody, status, whatsappMessageId, error]
          );
        } catch (_) {}
      }

      // ── SMS leg ───────────────────────────────────────────────────────────
      if (wantsSms) {
        let status = 'Sent';
        let error = null;
        let smsId = null;
        if (!smsConfigured) {
          status = 'Failed';
          error = 'SMS not configured (save the SMS API token in SMS Settings)';
        } else {
          try {
            const to = normalizePhone(tenant.phone_number);
            const result = await smsService.sendSms({ to, message: renderedBody });
            smsId = (result && result.data && (result.data.uid || result.data.id)) || null;
          } catch (err) {
            status = 'Failed';
            error = err.message || 'SMS send failed';
          }
        }
        tally.sms[status === 'Sent' ? 'sent' : 'failed']++;
        entry.sms = { status, error, smsId };
        await store.logMessage({
          tenantId: tenant.id,
          messageType: 'SMS Broadcast',
          messageBody: renderedBody,
          status,
          whatsappMessageId: smsId,
          failureReason: error,
        });
      }

      if ((entry.whatsapp && entry.whatsapp.status !== 'Sent')
        || (entry.sms && entry.sms.status !== 'Sent')) {
        entry.status = 'failed';
        entry.error = (entry.whatsapp && entry.whatsapp.error) || (entry.sms && entry.sms.error) || 'delivery failed';
      }
      results.push(entry);
    }

    const sent = results.filter((r) => r.status === 'Sent').length;
    const failed = results.length - sent;
    res.json({
      success: true,
      channel: chan,
      sent,
      failed,
      whatsapp: wantsWa ? tally.whatsapp : null,
      sms: wantsSms ? tally.sms : null,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: 'Broadcast operation failed' });
  }
});

module.exports = router;
