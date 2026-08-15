const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const whatsapp = require('../config/whatsapp');

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
    const { template_id, message_body, target_type, house_id } = req.body;
    if (!message_body && !template_id) {
      return res.status(400).json({ error: 'message_body or template_id required' });
    }
    if (!['all', 'house'].includes(target_type)) {
      return res.status(400).json({ error: 'target_type must be all or house' });
    }
    if (target_type === 'house' && !house_id) {
      return res.status(400).json({ error: 'house_id required when target_type=house' });
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

    for (const tenant of tenants) {
      const house = tenant?.house_id ? await store.getHouse(tenant.house_id) : null;
      const renderedBody = applyTemplate(baseBody, tenant, house);
      let status = 'Sent';
      let error = null;
      let whatsappMessageId = null;
      try {
        const result = await whatsapp.sendTextMessage(tenant.phone_number, renderedBody);
        status = result.status;
        whatsappMessageId = result.messageId;
        error = result.failureReason || (result.status === 'Failed' ? 'ack_error' : null);
      } catch (err) {
        status = 'Failed';
        error = err.message;
      }
      await store.logMessage({
        tenantId: tenant.id,
        messageType: 'Broadcast',
        messageBody: renderedBody,
        status,
        whatsappMessageId,
        failureReason: error,
      });
      results.push({ tenant_id: tenant.id, tenant_name: tenant.name, status, error });
    }

    const sent = results.filter((r) => r.status === 'Sent').length;
    const failed = results.length - sent;
    res.json({ success: true, sent, failed, results });
  } catch (err) {
    res.status(500).json({ error: 'Broadcast operation failed' });
  }
});

module.exports = router;
