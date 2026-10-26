const express = require('express');
const fs = require('fs');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const { detectWaterAnomaly } = require('../services/waterAnomaly');
const whatsapp = require('../config/whatsapp');
const { generateAndStoreWaterInvoice } = require('../services/documentStore');

const router = express.Router();
router.use(requireAuthActive);

router.get('/', async (req, res) => {
  try {
    const invoices = await store.listWaterInvoices(req.query);
    res.json({ water_invoices: invoices });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list water invoices' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const invoice = await store.getWaterInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Water invoice not found' });
    res.json({ water_invoice: invoice });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get water invoice' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { tenant_code, billing_month, payment_month, previous_reading, current_reading,
            due_date, payment_terms, notes, rent_amount, garbage_fee,
            rent_arrears, water_arrears, garbage_arrears, other_arrears, client_txn_id } = req.body || {};
    if (!tenant_code) return res.status(400).json({ error: 'tenant_code required' });
    if (!billing_month) return res.status(400).json({ error: 'billing_month required' });

    // Idempotent replay of an already-uploaded offline reading.
    if (client_txn_id) {
      const replay = await store.findRecordByClientTxnId('water_invoices', client_txn_id);
      if (replay) return res.json({ water_invoice: replay, already_synced: true });
    }

    const tenant = await store.getTenant(tenant_code);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // Anomaly screen (Phase 3): negative consumption is rejected outright
    // (409 + manager-queue conflict row); warnings post with a stored flag.
    const history = await store.getRecentWaterUnits(tenant_code, 6).catch(() => []);
    const anomaly = detectWaterAnomaly({
      previous: Number(previous_reading || 0),
      current: Number(current_reading || 0),
      history,
    });
    if (anomaly.level === 'reject') {
      if (client_txn_id) {
        await store.recordSyncConflict({
          clientTxnId: client_txn_id,
          opType: 'water_create',
          tenantCode: tenant_code,
          summary: {
            tenant_name: tenant.name, billing_month,
            previous_reading: Number(previous_reading || 0),
            current_reading: Number(current_reading || 0),
          },
          reason: anomaly.message,
          existingRef: null,
        }).catch(() => {});
      }
      return res.status(409).json({
        error: 'Invalid reading',
        message: anomaly.message,
        anomaly,
        conflict: !!client_txn_id,
      });
    }

    const housePaybill = tenant.house_id || tenant.house_paybill_number;
    let ratePerUnit = req.body.rate_per_unit != null ? Number(req.body.rate_per_unit) : null;
    if (ratePerUnit == null || isNaN(ratePerUnit)) {
      ratePerUnit = await store.getWaterRate(housePaybill);
    }

    const invoice = await store.createWaterInvoice({
      tenant_code,
      tenant_name: tenant.name,
      property_name: tenant.property_name || '',
      house_paybill_number: housePaybill,
      unit_label: tenant.unit_label || '',
      billing_month,
      payment_month: payment_month || null,
      previous_reading: Number(previous_reading || 0),
      current_reading: Number(current_reading || 0),
      rate_per_unit: ratePerUnit,
      due_date: due_date || null,
      payment_terms: payment_terms || null,
      notes: notes || null,
      // Water-only invoice: never inject the tenant's rent into this document.
      rent_amount: rent_amount != null ? Number(rent_amount) : 0,
      garbage_fee: garbage_fee != null ? Number(garbage_fee) : 0,
      rent_arrears: rent_arrears != null ? Number(rent_arrears) : 0,
      water_arrears: water_arrears != null ? Number(water_arrears) : 0,
      garbage_arrears: garbage_arrears != null ? Number(garbage_arrears) : 0,
      other_arrears: other_arrears != null ? Number(other_arrears) : 0,
      client_txn_id: client_txn_id || null,
      // Server-computed flags only — never trust client-supplied values.
      anomaly_flag: anomaly.level === 'warn' ? anomaly.code : null,
      anomaly_detail: anomaly.level === 'warn' ? anomaly.message : null,
    });
    if (invoice._idempotentReplay) {
      return res.json({ water_invoice: invoice, already_synced: true });
    }

    await store.logAudit({
      actor: req.user?.username,
      action: 'water_invoice_created',
      entityType: 'water_invoice',
      entityId: invoice.wtr_number,
      details: { tenant_code, billing_month, total_amount: invoice.total_amount },
    });

    res.status(201).json({ water_invoice: invoice, anomaly: anomaly.level === 'warn' ? anomaly : null });
  } catch (err) {
    console.error('[Water Invoice] Create error:', err.message);
    if (err && err.code === '23505' && req.body?.client_txn_id) {
      try {
        const replay = await store.findRecordByClientTxnId('water_invoices', req.body.client_txn_id);
        if (replay) return res.json({ water_invoice: replay, already_synced: true });
      } catch (_) {}
    }
    res.status(500).json({ error: err.message || 'Failed to create water invoice' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const invoice = await store.updateWaterInvoice(req.params.id, req.body || {});
    if (!invoice) return res.status(404).json({ error: 'Water invoice not found' });
    await store.logAudit({
      actor: req.user?.username,
      action: 'water_invoice_updated',
      entityType: 'water_invoice',
      entityId: invoice.wtr_number,
      details: req.body,
    });
    res.json({ water_invoice: invoice });
  } catch (err) {
    console.error('[Water Invoice] Update error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to update water invoice' });
  }
});

router.post('/:id/finalize', async (req, res) => {
  try {
    const invoice = await store.updateWaterInvoice(req.params.id, { status: 'Finalized' });
    if (!invoice) return res.status(404).json({ error: 'Water invoice not found' });
    await store.logAudit({
      actor: req.user?.username,
      action: 'water_invoice_finalized',
      entityType: 'water_invoice',
      entityId: invoice.wtr_number,
    });
    res.json({ water_invoice: invoice });
  } catch (err) {
    res.status(500).json({ error: 'Failed to finalize water invoice' });
  }
});

router.post('/:id/void', async (req, res) => {
  try {
    const { reason } = req.body || {};
    const invoice = await store.voidWaterInvoice(req.params.id, reason);
    if (!invoice) return res.status(404).json({ error: 'Water invoice not found or already paid' });
    await store.logAudit({
      actor: req.user?.username,
      action: 'water_invoice_voided',
      entityType: 'water_invoice',
      entityId: invoice.wtr_number,
      details: { reason },
    });
    res.json({ water_invoice: invoice });
  } catch (err) {
    res.status(500).json({ error: 'Failed to void water invoice' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const invoice = await store.getWaterInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Water invoice not found' });
    if (invoice.status === 'Paid' || invoice.status === 'Void') {
      return res.status(400).json({ error: 'Cannot delete paid or void invoices.' });
    }
    await store.deleteWaterInvoice(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete water invoice' });
  }
});

router.post('/:id/send', async (req, res) => {
  try {
    const mode = req.body.mode || 'download';
    const invoice = await store.getWaterInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Water invoice not found' });
    // Repeatable: a finalized invoice can be downloaded/sent unlimited times.
    // Only Draft/Paid/Void block the action.
    if (!['Finalized', 'Sent', 'Downloaded'].includes(invoice.status)) {
      return res.status(400).json({ error: 'Water invoice must be finalized before downloading or sending.' });
    }

    const tenant = await store.getTenant(invoice.tenant_code);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const doc = await generateAndStoreWaterInvoice(invoice.id, req.user?.username);
    if (!doc) return res.status(500).json({ error: 'Failed to generate water invoice PDF' });

    const mark = (action) => {
      if (doc.register_id) store.markInvoiceRegister({ id: doc.register_id, action }).catch(() => {});
    };

    const caption = `Hello ${tenant.name}, please find attached your Water Bill Invoice ${invoice.wtr_number} for ${invoice.billing_month}.`;

    if (mode === 'download') {
      mark('download');
      if (invoice.status === 'Finalized') {
        await store.updateWaterInvoice(req.params.id, { status: 'Downloaded' });
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
      res.setHeader('X-Wtr-Number', invoice.wtr_number);
      return res.sendFile(doc.file_path, err => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream water invoice PDF' });
      });
    }

    // Send mode: deliver the actual PDF. Prefer the QR-linked Baileys session
    // Linked Baileys session delivers local files from your own number.
    // The result reports the HONEST delivery status.
    let waStatus = 'Failed';
    let waReason = null;
    let waMessageId = null;
    try {
      const { sendDocumentSmart } = require('../config/whatsapp');
      const r = await sendDocumentSmart(tenant.phone_number, doc.file_path, caption);
      waStatus = r.status;
      waReason = r.failureReason || (r.status === 'Failed' ? 'provider could not deliver the PDF' : null);
      waMessageId = r.messageId || null;
    } catch (err) {
      waStatus = 'Failed';
      waReason = err.message;
    }
    await store.logMessage({
      tenantId: tenant.tenant_code,
      messageType: 'Water Invoice',
      messageBody: waStatus === 'Sent'
        ? `Water bill invoice PDF sent successfully (${invoice.wtr_number})`
        : `Failed to send water invoice: ${waReason || 'unknown error'}`,
      status: waStatus,
      whatsappMessageId: waMessageId,
      failureReason: waReason,
    });
    if (waStatus !== 'Sent') {
      return res.status(502).json({ error: 'WhatsApp delivery failed: ' + (waReason || 'could not deliver the PDF') });
    }
    mark('send');
    if (invoice.status === 'Finalized') {
      await store.updateWaterInvoice(req.params.id, { status: 'Sent' });
    }
    res.json({ success: true, message: 'Water invoice sent via WhatsApp' });
  } catch (err) {
    console.error('[Water Invoice] Send error:', err.message);
    res.status(500).json({ error: 'Failed to send water invoice' });
  }
});

// Water rate management
router.get('/rates/:housePaybill', async (req, res) => {
  try {
    const rate = await store.getWaterRate(req.params.housePaybill);
    res.json({ rate_per_unit: rate });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get water rate' });
  }
});

router.put('/rates/:housePaybill', async (req, res) => {
  try {
    const { rate_per_unit, effective_month } = req.body || {};
    if (rate_per_unit == null) return res.status(400).json({ error: 'rate_per_unit required' });
    const result = await store.updateWaterRate(
      req.params.housePaybill,
      Number(rate_per_unit),
      effective_month || new Date().toISOString().slice(0, 7),
      req.user?.username
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update water rate' });
  }
});

router.get('/rates/:housePaybill/history', async (req, res) => {
  try {
    const history = await store.getWaterRateHistory(req.params.housePaybill);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get rate history' });
  }
});

router.get('/latest-reading/:tenantCode', async (req, res) => {
  try {
    const reading = await store.getLatestWaterReading(req.params.tenantCode);
    res.json({ current_reading: reading });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get latest reading' });
  }
});

router.get('/find-tenant/:housePaybill/:unitLabel', async (req, res) => {
  try {
    const tenant = await store.findTenantByPropertyAndUnit(req.params.housePaybill, req.params.unitLabel);
    if (!tenant) return res.status(404).json({ error: 'No active tenant found for this property and unit' });
    const full = await store.getTenantInvoiceData(tenant.tenant_code);
    res.json({ tenant: { ...tenant, ...full } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to find tenant' });
  }
});

module.exports = router;
