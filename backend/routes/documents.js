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
  letter: 'Letter',
};

function getDocTypeLabel(docType) {
  return DOC_TYPE_LABELS[docType] || (docType || 'Document');
}

// ─── Documents Hub letter templates ─────────────────────────────────────────
// Additive only: templates + letter CRUD inside the existing hub. No existing
// route, workflow, or numbering is touched.

router.get('/templates', async (req, res) => {
  try {
    const { listTemplates } = require('../services/letterTemplates');
    res.json({ templates: listTemplates() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

// Resolve placeholders (preview data) without saving anything.
router.post('/letters/resolve', async (req, res) => {
  try {
    const { resolveLetterData } = require('../services/letterService');
    const { template_key, tenant_code, values } = req.body || {};
    if (!template_key) return res.status(400).json({ error: 'template_key required' });
    const resolved = await resolveLetterData(template_key, tenant_code || null, values || {}, req.user);
    res.json({
      template_key,
      label: resolved.template.label,
      subject: resolved.subject,
      recipient_block: resolved.recipient_block,
      body: resolved.renderBody(),
      data: resolved.data,
      raw: resolved.raw,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to resolve template' });
  }
});

// Placeholder catalog for the editor insert-dropdown. Optionally appends the
// given template's own form fields (exact field-name codes, group "This
// document") so every insertable code is offered without memorising names.
router.get('/letters/placeholders', async (req, res) => {
  try {
    const { PLACEHOLDER_CATALOG } = require('../services/letterService');
    const list = PLACEHOLDER_CATALOG.map((p) => ({ ...p }));
    const tk = req.query.template_key;
    if (tk) {
      try {
        const { getTemplate } = require('../services/letterTemplates');
        const tpl = getTemplate(tk);
        for (const f of (tpl && tpl.fields) || []) {
          if (!f || !f.name) continue;
          list.push({ code: f.name, label: `${f.label || f.name} (this document)`, group: 'This document' });
        }
      } catch (_) {}
    }
    res.json({ placeholders: list });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list placeholders' });
  }
});

// Server-rendered preview: final substitution over the exact editor state,
// so what you see is byte-identical to the generated PDF body.
router.post('/letters/preview', async (req, res) => {
  try {
    const { template_key, tenant_code, values, body, subject, recipient } = req.body || {};
    if (!template_key) return res.status(400).json({ error: 'template_key required' });
    const { resolveLetterData, bodyToHtml, styledBodyToHtml, validateLetterPair } = require('../services/letterService');
    const { buildLetterHtml } = require('../services/documentStore');
    const { applyStampWithFallback } = require('../services/officialStamp');
    const resolved = await resolveLetterData(template_key, tenant_code || null, values || {}, req.user);
    const finalBody = resolved.finalizeBody(body != null && body !== '' ? body : resolved.renderBody());
    const finalSubject = resolved.finalizeBody(subject != null && subject !== '' ? subject : resolved.subject);
    const finalRecipient = resolved.finalizeBody(recipient != null && recipient !== '' ? recipient : resolved.recipient_block);
    const rawInput = {};
    if (subject != null && subject !== '') rawInput.subject = subject;
    if (recipient != null && recipient !== '') rawInput.recipient = recipient;
    if (body != null && body !== '') rawInput.body = body;
    const problems = validateLetterPair(rawInput, {
      subject: finalSubject, recipient: finalRecipient, body: finalBody,
    }, resolved.data);
    if (problems.length) {
      return res.status(400).json({ error: 'Document validation failed: ' + problems[0], problems });
    }
    const today = new Date();
    const dateLine = `${String(today.getDate()).padStart(2, '0')} ${['January','February','March','April','May','June','July','August','September','October','November','December'][today.getMonth()]} ${today.getFullYear()}`;
    // Rendered preview uses the identical stamp logic as the final PDF, so
    // the stamp position previewed is the position downloaded/sent.
    // (Editable subject/body/recipient inputs never contain the marker.)
    const html = applyStampWithFallback(buildLetterHtml({
      subject: finalSubject,
      recipientBlock: finalRecipient,
      dateLine,
      refNo: 'PREVIEW — not saved',
      bodyHtml: styledBodyToHtml(finalBody, resolved.data),
      senderName: resolved.data.sender_name,
      senderTitle: resolved.data.sender_title,
    }));
    res.json({ html });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to preview letter' });
  }
});

// Property-wide batch: one individualized finalized document per occupying
// tenant. Shared form values apply to all; tenant/unit/property resolve
// separately for each. Nothing is overwritten — every letter is its own row.
router.post('/letters/batch', async (req, res) => {
  try {
    const { template_key, house_paybill_number, property_name, values } = req.body || {};
    if (!template_key) return res.status(400).json({ error: 'template_key required' });
    const { getTemplate } = require('../services/letterTemplates');
    const template = getTemplate(template_key);
    if (!template) return res.status(400).json({ error: 'Unknown document template' });
    if (template.recipient !== 'tenant') {
      return res.status(400).json({ error: 'Property batch is available for tenant-addressed templates' });
    }
    let house = null;
    if (house_paybill_number) {
      house = await store.getHouse(house_paybill_number);
      if (!house) return res.status(404).json({ error: 'Property not found' });
    }
    const allTenants = await store.listTenants(
      house ? { house_id: house.paybill_number } : {}
    );
    let tenants = allTenants.filter((t) => String(t.status || '') !== 'Vacant');
    if (!house && property_name) {
      const want = String(property_name).toLowerCase();
      tenants = tenants.filter((t) => String(t.property_name || '').toLowerCase() === want);
    }
    if (!tenants.length) return res.status(400).json({ error: 'No occupying tenants found for this property' });
    if (tenants.length > 100) {
      return res.status(400).json({ error: `Too many tenants (${tenants.length}). Narrow the selection (max 100 per batch).` });
    }
    const { resolveLetterData, bodyToHtml, styledBodyToHtml, validateLetterPair } = require('../services/letterService');
    const { generateLetterPdfFile } = require('../services/documentStore');
    const today = new Date().toISOString().slice(0, 10);
    const results = [];
    for (const tenant of tenants) {
      try {
        const resolved = await resolveLetterData(template_key, tenant.tenant_code, values || {}, req.user);
        const finalBody = resolved.finalizeBody(resolved.renderBody());
        const problems = validateLetterPair(
          { subject: resolved.template.subject, body: resolved.template.body },
          { subject: resolved.subject, recipient: resolved.recipient_block, body: finalBody },
          resolved.data
        );
        if (problems.length) throw new Error('Validation: ' + problems[0]);
        const docNumber = await store.generateLetterNumber();
        const pdf = await generateLetterPdfFile({
          docNumber,
          subject: resolved.subject,
          recipientBlock: resolved.recipient_block,
          bodyHtml: styledBodyToHtml(finalBody, resolved.data),
          senderName: resolved.data.sender_name,
          senderTitle: resolved.data.sender_title,
          templateKey: template_key,
        });
        const doc = await store.createDocument({
          doc_type: 'letter',
          doc_number: docNumber,
          title: resolved.subject,
          filename: pdf.filename,
          file_path: pdf.file_path,
          tenant_code: tenant.tenant_code,
          house_paybill_number: resolved.data.house_paybill_number || null,
          property_name: resolved.data.property_name || null,
          unit_label: resolved.data.unit_label || null,
          doc_date: today,
          template_key,
          status: 'Finalized',
          body_text: finalBody,
          resolved_recipient: resolved.recipient_block,
        });
        results.push({
          tenant_code: tenant.tenant_code, tenant_name: tenant.name,
          unit_label: resolved.data.unit_label, ok: true,
          doc_id: doc.id, doc_number: docNumber,
        });
      } catch (tenantErr) {
        results.push({
          tenant_code: tenant.tenant_code, tenant_name: tenant.name, ok: false,
          error: tenantErr.message,
        });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    res.json({
      property: house ? house.house_name : (property_name || ''),
      total: results.length, succeeded, failed: results.length - succeeded,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to generate batch letters' });
  }
});

// ─── Blank Letterhead / Custom Notice ───────────────────────────────────────
// One individual notice per selected tenant: its own numbered PDF letter under
// that tenant's records (letterhead/footer/watermark are automatic). Creation
// only — nothing is ever sent here; Send happens per row, by the user.
router.post('/letters/custom-notice', async (req, res) => {
  try {
    const { tenant_codes, subject, body, notice_date } = req.body || {};
    const codes = [...new Set(
      (Array.isArray(tenant_codes) ? tenant_codes : [])
        .map((c) => String(c || '').trim()).filter(Boolean)
    )];
    if (!codes.length) return res.status(400).json({ error: 'Select at least one recipient' });
    if (codes.length > 100) {
      return res.status(400).json({ error: `Too many recipients (${codes.length}). Max 100 per notice.` });
    }
    const { resolveLetterData, bodyToHtml, styledBodyToHtml, validateLetterContent } = require('../services/letterService');
    // Custom notices may only use tenant-facing variables. Internal/financial
    // data (arrears, balances, landlord info …) can never appear (spec §4).
    const SAFE_CUSTOM_VARS = {
      TENANT_NAME: 'tenant_name',
      UNIT_NUMBER: 'unit_label',
      PROPERTY_NAME: 'property_name',
      TENANT_PHONE: 'phone_number',
      PHONE_NUMBER: 'phone_number',
      RECIPIENT_NAME: 'recipient_name',
      TODAY: 'today',
      DATE: 'today',
    };
    const rawText = `${subject != null ? subject : ''}\n${body != null ? body : ''}`;
    const usedVars = [...new Set([...rawText.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1].toUpperCase()))];
    const disallowed = usedVars.filter((v) => !SAFE_CUSTOM_VARS[v]);
    if (disallowed.length) {
      return res.status(400).json({
        error: `Variable {{${disallowed[0]}}} is not allowed in a custom notice. Allowed: ${Object.keys(SAFE_CUSTOM_VARS).map((v) => `{{${v}}}`).join(', ')}`,
        problems: disallowed.map((v) => `variable {{${v}}} is not allowed in custom notices`),
      });
    }
    // Probe makes safe vars "resolvable" so validation checks missing/bad
    // words without flagging them; unsafe vars were rejected above.
    const safeProbe = Object.fromEntries(Object.values(SAFE_CUSTOM_VARS).map((k) => [k, '—']));
    const problems = validateLetterContent({
      subject: subject != null ? subject : '',
      body: body != null ? body : '',
      data: safeProbe,
    });
    if (problems.length) {
      return res.status(400).json({ error: 'Document validation failed: ' + problems[0], problems });
    }
    const finalSubject = String(subject).trim();
    const finalBody = String(body);
    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(notice_date || '');
    const noticeDay = dateOk ? notice_date : new Date().toISOString().slice(0, 10);
    const MONTHS_FULL = ['January','February','March','April','May','June','July',
      'August','September','October','November','December'];
    const [ny, nm, nd] = noticeDay.split('-');
    const dateLine = `${nd} ${MONTHS_FULL[Number(nm) - 1]} ${ny}`;
    const fillCustom = (text, data) => String(text || '').replace(/\{\{(\w+)\}\}/g, (_, k) => {
      const canon = SAFE_CUSTOM_VARS[k.toUpperCase()];
      const val = canon ? data[canon] : null;
      return val != null ? String(val) : '';
    });
    const { generateLetterPdfFile } = require('../services/documentStore');
    const results = [];
    for (const code of codes) {
      try {
        const resolved = await resolveLetterData('custom_notice', code, {}, req.user);
        if (!resolved.data.tenant_name) throw new Error(`Tenant ${code} not found`);
        resolved.data.today = dateLine; // {{TODAY}} matches the notice date
        const docSubject = fillCustom(finalSubject, resolved.data);
        const docBody = fillCustom(finalBody, resolved.data);
        const docNumber = await store.generateLetterNumber();
        const pdf = await generateLetterPdfFile({
          docNumber,
          subject: docSubject,
          recipientBlock: resolved.recipient_block,
          bodyHtml: styledBodyToHtml(docBody, resolved.data),
          senderName: resolved.data.sender_name,
          senderTitle: resolved.data.sender_title,
          templateKey: 'custom_notice',
          dateLine,
        });
        const doc = await store.createDocument({
          doc_type: 'letter',
          doc_number: docNumber,
          title: docSubject,
          filename: pdf.filename,
          file_path: pdf.file_path,
          tenant_code: code,
          house_paybill_number: resolved.data.house_paybill_number || null,
          property_name: resolved.data.property_name || null,
          unit_label: resolved.data.unit_label || null,
          doc_date: noticeDay,
          template_key: 'custom_notice',
          status: 'Finalized',
          body_text: docBody,
          resolved_recipient: resolved.recipient_block,
        });
        results.push({
          tenant_code: code, tenant_name: resolved.data.tenant_name,
          unit_label: resolved.data.unit_label, ok: true,
          doc_id: doc.id, doc_number: docNumber,
        });
      } catch (err) {
        results.push({ tenant_code: code, ok: false, error: err.message || 'Failed to create notice' });
      }
    }
    const created = results.filter((r) => r.ok).length;
    if (!created) {
      return res.status(400).json({ error: 'No notices created: ' + (results[0] ? results[0].error : 'unknown error'), results });
    }
    res.status(201).json({ created, failed: results.length - created, sent: 0, results });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to create custom notices' });
  }
});

// Create a letter: Draft (no PDF yet) or Finalized (numbered + PDF stored).
router.post('/letters', async (req, res) => {
  try {
    const { template_key, tenant_code, values, body, title, recipient, status } = req.body || {};
    if (!template_key) return res.status(400).json({ error: 'template_key required' });
    const { resolveLetterData, bodyToHtml, styledBodyToHtml, validateLetterPair } = require('../services/letterService');
    const { getTemplate } = require('../services/letterTemplates');
    const template = getTemplate(template_key);
    if (!template) return res.status(400).json({ error: 'Unknown document template' });
    const resolved = await resolveLetterData(template_key, tenant_code || null, values || {}, req.user);
    const finalBody = resolved.finalizeBody(body != null ? body : resolved.renderBody());
    const finalTitle = resolved.finalizeBody(title || resolved.subject);
    const finalRecipient = resolved.finalizeBody(recipient != null ? recipient : resolved.recipient_block);
    const rawInput = {};
    if (title) rawInput.subject = title;
    if (recipient != null && recipient !== '') rawInput.recipient = recipient;
    if (body != null && body !== '') rawInput.body = body;
    const problems = validateLetterPair(rawInput, {
      subject: finalTitle, recipient: finalRecipient, body: finalBody,
    }, resolved.data);
    if (problems.length) {
      return res.status(400).json({ error: 'Document validation failed: ' + problems[0], problems });
    }
    const today = new Date().toISOString().slice(0, 10);
    const links = {
      tenant_code: tenant_code || null,
      house_paybill_number: resolved.data.house_paybill_number || null,
      property_name: resolved.data.property_name || null,
      unit_label: resolved.data.unit_label || null,
    };
    if ((status || 'Draft') === 'Finalized') {
      const docNumber = await store.generateLetterNumber();
      const { generateLetterPdfFile } = require('../services/documentStore');
      const pdf = await generateLetterPdfFile({
        docNumber,
        subject: finalTitle,
        recipientBlock: finalRecipient,
        bodyHtml: styledBodyToHtml(finalBody, resolved.data),
        senderName: resolved.data.sender_name,
        senderTitle: resolved.data.sender_title,
        templateKey: template_key,
      });
      const doc = await store.createDocument({
        doc_type: 'letter',
        doc_number: docNumber,
        title: finalTitle,
        filename: pdf.filename,
        file_path: pdf.file_path,
        ...links,
        doc_date: today,
        template_key,
        status: 'Finalized',
        body_text: finalBody,
        resolved_recipient: finalRecipient,
      });
      return res.status(201).json({ document: doc });
    }
    const doc = await store.createDocument({
      doc_type: 'letter',
      doc_number: null,
      title: finalTitle,
      filename: '',
      file_path: '',
      ...links,
      doc_date: today,
      template_key,
      status: 'Draft',
      body_text: finalBody,
      resolved_recipient: finalRecipient,
    });
    res.status(201).json({ document: doc });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to create letter' });
  }
});

// Edit a draft (finalized rows are immutable).
router.put('/letters/:id', async (req, res) => {
  try {
    const { title, body, recipient } = req.body || {};
    const existing = await store.getDocument(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Document not found' });
    if (existing.doc_type !== 'letter') return res.status(400).json({ error: 'Not a letter document' });
    const { resolveLetterData, validateLetterContent } = require('../services/letterService');
    const resolved = existing.template_key
      ? await resolveLetterData(existing.template_key, existing.tenant_code || null, {}, req.user).catch(() => null)
      : null;
    const merged = {
      subject: title !== undefined ? title : existing.title,
      recipient: recipient !== undefined ? recipient : existing.resolved_recipient,
      body: body !== undefined ? body : existing.body_text,
    };
    const problems = validateLetterContent({ ...merged, data: resolved ? resolved.data : undefined });
    if (problems.length) {
      return res.status(400).json({ error: 'Document validation failed: ' + problems[0], problems });
    }
    const doc = await store.updateLetterDraft(req.params.id, { title, body_text: body, resolved_recipient: recipient });
    if (!doc) return res.status(400).json({ error: 'Only draft letters can be edited' });
    res.json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update draft' });
  }
});

// Finalize a draft: assign number, generate PDF, lock the row.
router.post('/letters/:id/finalize', async (req, res) => {
  try {
    const existing = await store.getDocument(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Document not found' });
    if (existing.doc_type !== 'letter') return res.status(400).json({ error: 'Not a letter document' });
    if (existing.status === 'Finalized' && existing.file_path) {
      return res.json({ document: existing, already_finalized: true });
    }
    if (existing.status !== 'Draft') return res.status(400).json({ error: 'Only draft letters can be finalized' });
    const { bodyToHtml, styledBodyToHtml } = require('../services/letterService');
    const { resolveLetterData } = require('../services/letterService');
    const { validateLetterPair } = require('../services/letterService');
    const docNumber = await store.generateLetterNumber();
    const { generateLetterPdfFile } = require('../services/documentStore');
    // Final fill pass so no {{VARIABLE}} can ever reach the PDF.
    const refill = await resolveLetterData(
      existing.template_key, existing.tenant_code || null, {}, req.user
    ).catch(() => null);
    const finalBody = refill ? refill.finalizeBody(existing.body_text || '') : (existing.body_text || '');
    const finalSubject = refill ? refill.finalizeBody(existing.title || '') : (existing.title || '');
    const finalRecipient = refill ? refill.finalizeBody(existing.resolved_recipient || '') : (existing.resolved_recipient || '');
    const finalProblems = validateLetterPair({
      subject: existing.title || '',
      recipient: existing.resolved_recipient || '',
      body: existing.body_text || '',
    }, {
      subject: finalSubject || 'Letter',
      recipient: finalRecipient,
      body: finalBody,
    }, refill ? refill.data : undefined);
    if (finalProblems.length) {
      return res.status(400).json({ error: 'Document validation failed: ' + finalProblems[0], problems: finalProblems });
    }
    const pdf = await generateLetterPdfFile({
      docNumber,
      subject: finalSubject || 'Letter',
      recipientBlock: finalRecipient,
      bodyHtml: refill ? styledBodyToHtml(finalBody, refill.data) : bodyToHtml(finalBody),
      senderName: (req.user && (req.user.display_name || req.user.username)) || 'Management',
      senderTitle: 'Property Manager',
      templateKey: existing.template_key,
    });
    const doc = await store.finalizeLetterDocument(existing.id, {
      doc_number: docNumber, filename: pdf.filename, file_path: pdf.file_path,
    });
    res.json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to finalize letter' });
  }
});

// New version of a finalized letter: copies it into a fresh Draft row.
// History is never overwritten — the original stays exactly as it was.
router.post('/letters/:id/new-version', async (req, res) => {
  try {
    const existing = await store.getDocument(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Document not found' });
    if (existing.doc_type !== 'letter') return res.status(400).json({ error: 'Not a letter document' });
    const today = new Date().toISOString().slice(0, 10);
    const doc = await store.createDocument({
      doc_type: 'letter',
      doc_number: null,
      title: existing.title || 'Letter',
      filename: '',
      file_path: '',
      tenant_code: existing.tenant_code || null,
      house_paybill_number: existing.house_paybill_number || null,
      property_name: existing.property_name || null,
      unit_label: existing.unit_label || null,
      doc_date: today,
      template_key: existing.template_key || null,
      status: 'Draft',
      body_text: existing.body_text || '',
      resolved_recipient: existing.resolved_recipient || '',
    });
    res.status(201).json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to create new version' });
  }
});

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
    res.json({ document: { ...doc, exists: doc.file_path ? fs.existsSync(doc.file_path) : false } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load document: ' + err.message });
  }
});

// Delete a letter document (row + PDF file). Letters only — receipts,
// invoices and other business records are never deleted here, and tenant,
// property, payment and rent records are never touched.
router.delete('/:id', async (req, res) => {
  try {
    const doc = await store.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.doc_type !== 'letter') {
      return res.status(400).json({ error: 'Only letter documents can be deleted here' });
    }
    try {
      if (doc.file_path && fs.existsSync(doc.file_path)) fs.unlinkSync(doc.file_path);
    } catch (_) {}
    await store.deleteDocument(doc.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete document: ' + err.message });
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
    if (doc.doc_type === 'letter') await store.markLetterDelivery(doc.id, 'Downloaded');
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
    if (doc.doc_type === 'letter' && (!doc.file_path || !fs.existsSync(doc.file_path))) {
      return res.status(400).json({ error: 'Generate the PDF first before sharing' });
    }

    const phone = req.body?.phone_number || doc.tenant_phone;
    if (!phone) {
      return res.status(400).json({ error: 'No recipient phone number available for this document' });
    }

    const tenantName = doc.tenant_name || doc.property_name || doc.unit_label || '';
    const unitText = doc.unit_label ? ` for unit ${doc.unit_label}` : '';
    const caption = `Hello ${tenantName}, please find attached your ${getDocTypeLabel(doc.doc_type).toLowerCase()}${unitText}.`;

    // Linked Baileys session delivers local files from your own number —
    // with the honest result either way.
    let waStatus = 'Failed';
    let waReason = null;
    let waMessageId = null;
    try {
      const r = await whatsapp.sendDocumentSmart(phone, doc.file_path, caption);
      waStatus = r.status;
      waReason = r.failureReason || (r.status === 'Failed' ? 'provider could not deliver the document' : null);
      waMessageId = r.messageId || null;
    } catch (err) {
      waStatus = 'Failed';
      waReason = err.message;
    }
    await markDocumentRegister(doc, 'send');
    if (doc.doc_type === 'letter' && waStatus === 'Sent') {
      await store.markLetterDelivery(doc.id, 'Sent');
    }
    if (waStatus !== 'Sent') {
      return res.status(502).json({ error: 'WhatsApp delivery failed: ' + (waReason || 'could not deliver the document') });
    }
    await store.logAudit({
      actor: req.user?.username,
      action: 'document_shared_whatsapp',
      entityType: 'document',
      entityId: String(doc.id),
      details: { doc_number: doc.doc_number, doc_type: doc.doc_type, recipient: phone, wa_status: waStatus },
    });
    res.json({ success: true, whatsapp: { status: waStatus, messageId: waMessageId }, phone });
  } catch (err) {
    res.status(500).json({ error: 'WhatsApp share failed: ' + err.message });
  }
});

module.exports = router;
