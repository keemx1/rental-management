const express = require('express');
const fs = require('fs');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const whatsapp = require('../config/whatsapp');
const { generateAndStoreTenantStatement } = require('../services/documentStore');

const router = express.Router();
router.use(requireAuthActive);

router.post('/generate', async (req, res) => {
  try {
    const mode = req.body.mode || 'download';
    const tenantId = req.body.tenant_id;
    if (!tenantId) return res.status(400).json({ error: 'tenant_id is required' });

    const tenant = await store.getTenant(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const statementNo = await store.generateStatementNumber();
    const doc = await generateAndStoreTenantStatement(tenant.tenant_code, statementNo);
    if (!doc) return res.status(500).json({ error: 'Failed to generate tenant statement' });

    const unitText = tenant.tenant_code ? ` for unit ${tenant.tenant_code}` : '';
    const caption = `Hello ${tenant.name}, please find attached your latest statement of account${unitText}.`;

    if (mode === 'download') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
      res.setHeader('X-Statement-Number', statementNo);
      return res.sendFile(doc.file_path, err => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream statement PDF' });
      });
    }

    try {
      await whatsapp.sendMediaMessage(tenant.phone_number, doc.file_path, caption);
      await store.logMessage({
        tenantId: tenant.tenant_code,
        messageType: 'Statement',
        messageBody: `Tenant statement PDF sent successfully (${statementNo})`,
        status: 'Sent',
      });
    } catch (err) {
      await store.logMessage({
        tenantId: tenant.tenant_code,
        messageType: 'Statement',
        messageBody: 'Failed to send Tenant statement PDF',
        status: 'Failed',
      });
      return res.status(500).json({ error: 'WhatsApp delivery failed: ' + err.message });
    }

    if (mode === 'both') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
      res.setHeader('X-Statement-Number', statementNo);
      return res.sendFile(doc.file_path, err => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream statement PDF' });
      });
    }

    res.json({ success: true, message: 'Statement sent successfully', statement_no: statementNo });
  } catch (err) {
    res.status(500).json({ error: 'Statement operation failed: ' + err.message });
  }
});

module.exports = router;
