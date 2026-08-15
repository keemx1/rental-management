const express = require('express');
const fs = require('fs');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const whatsapp = require('../config/whatsapp');

const router = express.Router();
router.use(requireAuthActive);

const DOC_TYPE_LABELS = {
  receipt: 'Payment Receipt',
  invoice: 'Invoice',
  exit_invoice: 'Exit Invoice',
  report: 'Report',
};

function getDocTypeLabel(docType) {
  return DOC_TYPE_LABELS[docType] || (docType || 'Document');
}

router.get('/', async (req, res) => {
  try {
    const { doc_type, tenant_code, house_paybill_number, from, to, q, limit, offset } = req.query;
    const result = await store.listDocuments({
      doc_type: doc_type || undefined,
      tenant_code: tenant_code || undefined,
      house_paybill_number: house_paybill_number || undefined,
      from: from || undefined,
      to: to || undefined,
      q: q || undefined,
      limit: limit || undefined,
      offset: offset || undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load documents: ' + err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await store.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json({ document: { ...doc, exists: fs.existsSync(doc.file_path) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load document: ' + err.message });
  }
});

async function markDocumentRegister(doc, action) {
  try {
    if (!doc || !doc.id) return;
    const register = await store.getInvoiceRegisterByDocument(doc.id);
    if (register && register.id) {
      await store.markInvoiceRegister({ id: register.id, action });
    }
  } catch (err) {
    console.error('[Invoice Register] Failed to mark document register:', err.message);
  }
}

function streamFile(res, doc, { inline }) {
  if (!fs.existsSync(doc.file_path)) {
    return res.status(404).json({ error: 'Document file is missing on disk' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${doc.filename}"`
  );
  const stream = fs.createReadStream(doc.file_path);
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: 'Failed to stream document' });
  });
  stream.pipe(res);
  return null;
}

router.get('/:id/download', async (req, res) => {
  try {
    const doc = await store.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    await markDocumentRegister(doc, 'download');
    streamFile(res, doc, { inline: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to download document: ' + err.message });
  }
});

router.get('/:id/print', async (req, res) => {
  try {
    const doc = await store.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    streamFile(res, doc, { inline: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to open document: ' + err.message });
  }
});

router.post('/:id/share-whatsapp', async (req, res) => {
  try {
    const doc = await store.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const phone = req.body?.phone_number || doc.tenant_phone;
    if (!phone) {
      return res.status(400).json({ error: 'No recipient phone number available for this document' });
    }

    const tenantName = doc.tenant_name || doc.property_name || doc.unit_label || '';
    const unitText = doc.unit_label ? ` for unit ${doc.unit_label}` : '';
    const caption = `Hello ${tenantName}, please find attached your ${getDocTypeLabel(doc.doc_type).toLowerCase()}${unitText}.`;

    const result = await whatsapp.sendMediaMessage(phone, doc.file_path, caption);
    await markDocumentRegister(doc, 'send');
    res.json({ success: true, whatsapp: result, phone });
  } catch (err) {
    res.status(500).json({ error: 'WhatsApp share failed: ' + err.message });
  }
});

module.exports = router;
