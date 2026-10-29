'use strict';

/**
 * Landlord routes — /api/landlords
 * ONE landlord profile -> MANY properties -> each property keeps its OWN
 * independent commission account (invoices, payments, running balance).
 */
const express = require('express');
const fs = require('fs');
const { requireAuthActive, requireAdmin } = require('../middleware/auth');
const store = require('../storage/store');
const commission = require('../services/landlordCommission');

const router = express.Router();
router.use(requireAuthActive);

// ── Landlords CRUD ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { query } = require('../config/database');
    const rows = (await query(`SELECT * FROM landlords ORDER BY name`)).rows;
    const landlords = [];
    for (const l of rows) {
      const overview = await commission.landlordOverview(l.id, req.query.month).catch(() => null);
      landlords.push({
        ...l,
        properties: overview ? overview.properties : [],
        total_outstanding: overview ? overview.total_outstanding : 0,
      });
    }
    res.json({ landlords });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load landlords: ' + err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, phone, email, id_number, notes, default_remittance_day, default_mfi_due_day,
      mpesa_number, bank_name, bank_account, payment_details_note } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const { query } = require('../config/database');
    const row = (await query(
      `INSERT INTO landlords (name, phone, email, id_number, notes, default_remittance_day, default_mfi_due_day,
         mpesa_number, bank_name, bank_account, payment_details_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [String(name).trim(), phone || null, email || null, id_number || null, notes || null,
        default_remittance_day || null, default_mfi_due_day || null,
        mpesa_number || null, bank_name || null, bank_account || null, payment_details_note || null]
    )).rows[0];
    await store.logAudit({
      actor: req.user?.username, action: 'landlord_created',
      entityType: 'landlord', entityId: String(row.id), details: { name: row.name },
    });
    res.status(201).json({ landlord: row });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create landlord: ' + err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const month = req.query.month;
    const overview = await commission.landlordOverview(Number(req.params.id), month);
    if (!overview) return res.status(404).json({ error: 'Landlord not found' });
    res.json(overview);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load landlord: ' + err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { query } = require('../config/database');
    const { name, phone, email, id_number, notes, default_remittance_day, default_mfi_due_day,
      mpesa_number, bank_name, bank_account, payment_details_note } = req.body || {};
    const before = (await query(`SELECT * FROM landlords WHERE id = $1`, [Number(req.params.id)])).rows[0];
    const row = (await query(
      `UPDATE landlords SET name = COALESCE($1, name), phone = COALESCE($2, phone),
              email = COALESCE($3, email), id_number = COALESCE($4, id_number),
              notes = COALESCE($5, notes),
              default_remittance_day = COALESCE($6, default_remittance_day),
              default_mfi_due_day = COALESCE($7, default_mfi_due_day),
              mpesa_number = COALESCE($8, mpesa_number),
              bank_name = COALESCE($9, bank_name),
              bank_account = COALESCE($10, bank_account),
              payment_details_note = COALESCE($11, payment_details_note),
              updated_at = NOW()
        WHERE id = $12 RETURNING *`,
      [name || null, phone || null, email || null, id_number || null, notes || null,
        default_remittance_day || null, default_mfi_due_day || null,
        mpesa_number || null, bank_name || null, bank_account || null, payment_details_note || null,
        Number(req.params.id)]
    )).rows[0];
    if (!row) return res.status(404).json({ error: 'Landlord not found' });
    // Payment-details changes are audited (previous details stay in history).
    if (before && (row.mpesa_number !== before.mpesa_number || row.bank_account !== before.bank_account || row.bank_name !== before.bank_name)) {
      await store.logAudit({
        actor: req.user?.username, action: 'landlord_payment_details_changed',
        entityType: 'landlord', entityId: String(row.id),
        details: {
          previous: { mpesa_number: before.mpesa_number, bank_name: before.bank_name, bank_account: before.bank_account },
          new: { mpesa_number: row.mpesa_number, bank_name: row.bank_name, bank_account: row.bank_account },
        },
      });
    }
    res.json({ landlord: row });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update landlord: ' + err.message });
  }
});

// ── Property assignment (link/unlink houses) ────────────────────────────────
router.post('/:id/assign-house', async (req, res) => {
  try {
    const { house_paybill_number } = req.body || {};
    if (!house_paybill_number) return res.status(400).json({ error: 'house_paybill_number required' });
    const { query } = require('../config/database');
    const landlord = (await query(`SELECT id, name FROM landlords WHERE id = $1`, [Number(req.params.id)])).rows[0];
    if (!landlord) return res.status(404).json({ error: 'Landlord not found' });
    const house = (await query(`SELECT paybill_number, house_name FROM houses WHERE paybill_number = $1`, [house_paybill_number])).rows[0];
    if (!house) return res.status(404).json({ error: 'Property not found' });
    await query(`UPDATE houses SET landlord_id = $1, updated_at = NOW() WHERE paybill_number = $2`, [landlord.id, house_paybill_number]);
    await store.logAudit({
      actor: req.user?.username, action: 'landlord_house_assigned',
      entityType: 'house', entityId: house_paybill_number,
      details: { landlord_id: landlord.id, landlord_name: landlord.name },
    });
    res.json({ ok: true, landlord, house });
  } catch (err) {
    res.status(500).json({ error: 'Failed to assign property: ' + err.message });
  }
});

router.post('/:id/unassign-house', async (req, res) => {
  try {
    const { house_paybill_number } = req.body || {};
    const { query } = require('../config/database');
    await query(
      `UPDATE houses SET landlord_id = NULL, updated_at = NOW() WHERE paybill_number = $1 AND landlord_id = $2`,
      [house_paybill_number, Number(req.params.id)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unassign property: ' + err.message });
  }
});

// ── Per-property ledger / invoice / payment / statement ─────────────────────
router.get('/:id/properties/:paybill/ledger', async (req, res) => {
  try {
    const ledger = await commission.getLedger(req.params.paybill, Number(req.params.id));
    if (!ledger) return res.status(404).json({ error: 'Property not found' });
    if (ledger.landlord && ledger.landlord.id !== Number(req.params.id)) {
      return res.status(403).json({ error: 'This property belongs to a different landlord' });
    }
    res.json(ledger);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load ledger: ' + err.message });
  }
});

router.post('/:id/properties/:paybill/commission-invoice', async (req, res) => {
  try {
    const { billing_month } = req.body || {};
    const result = await commission.generateCommissionInvoice(req.params.paybill, billing_month, { actor: req.user?.username });
    if (result.error) {
      const status = result.code === 'NOT_FOUND' ? 404
        : result.code === 'NO_LANDLORD' ? 409 : 400;
      return res.status(status).json({ error: result.error, code: result.code });
    }
    await store.logAudit({
      actor: req.user?.username, action: 'commission_invoice_generated',
      entityType: 'commission_invoice', entityId: result.invoice.invoice_number,
      details: { house: req.params.paybill, billing_month, total_payable: Number(result.invoice.total_payable) },
    });
    res.json({ invoice: result.invoice, document: result.document, regenerated: result.regenerated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate commission invoice: ' + err.message });
  }
});

router.post('/:id/properties/:paybill/commission-payments', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await commission.recordCommissionPayment({
      house_paybill_number: req.params.paybill,
      landlord_id: Number(req.params.id),
      declared_landlord_id: body.landlord_id != null ? Number(body.landlord_id) : null,
      payment_date: body.payment_date,
      amount: body.amount,
      method: body.method,
      reference: body.reference,
      notes: body.notes,
      actor: req.user?.username,
    });
    if (result.error) {
      const status = result.code === 'NOT_FOUND' ? 404
        : result.code === 'LANDLORD_MISMATCH' ? 409 : 400;
      return res.status(status).json({ error: result.error, code: result.code });
    }
    await store.logAudit({
      actor: req.user?.username, action: 'commission_payment_recorded',
      entityType: 'commission_payment', entityId: String(result.payment.id),
      details: { house: req.params.paybill, amount: Number(result.payment.amount), reference: result.payment.reference },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to record payment: ' + err.message });
  }
});

router.post('/:id/properties/:paybill/statement', async (req, res) => {
  try {
    const ledger = await commission.getLedger(req.params.paybill, Number(req.params.id));
    if (!ledger) return res.status(404).json({ error: 'Property not found' });
    const { generateAndStoreCommissionStatement } = require('../services/documentStore');
    const doc = await generateAndStoreCommissionStatement(req.params.paybill);
    res.json({ ledger, document: doc });
  } catch (err) {
    res.status(500).json({ error: 'Failed to build statement: ' + err.message });
  }
});

router.get('/commission-invoices/:invoiceId/pdf', async (req, res) => {
  try {
    const { query } = require('../config/database');
    const inv = (await query(`SELECT * FROM commission_invoices WHERE id = $1`, [Number(req.params.invoiceId)])).rows[0];
    if (!inv) return res.status(404).json({ error: 'Commission invoice not found' });
    let doc = inv.document_id
      ? (await query(`SELECT * FROM documents WHERE id = $1`, [inv.document_id])).rows[0]
      : null;
    if (!doc) {
      const { generateAndStoreCommissionInvoice } = require('../services/documentStore');
      doc = await generateAndStoreCommissionInvoice(inv.id);
    }
    if (!doc || !doc.file_path || !fs.existsSync(doc.file_path)) {
      return res.status(404).json({ error: 'PDF file not found' });
    }
    res.download(doc.file_path, doc.filename || `${inv.invoice_number}.pdf`);
  } catch (err) {
    res.status(500).json({ error: 'Failed to download invoice PDF: ' + err.message });
  }
});

router.post('/commission-invoices/:invoiceId/void', async (req, res) => {
  try {
    const inv = await commission.voidCommissionInvoice(Number(req.params.invoiceId));
    if (!inv) return res.status(404).json({ error: 'Commission invoice not found' });
    await store.logAudit({
      actor: req.user?.username, action: 'commission_invoice_voided',
      entityType: 'commission_invoice', entityId: inv.invoice_number, details: {},
    });
    res.json({ invoice: inv });
  } catch (err) {
    res.status(500).json({ error: 'Failed to void invoice: ' + err.message });
  }
});

// ── Landlord Ledger Dashboard: commission + rent remittance, per property ──
router.get('/:id/properties/:paybill/dashboard', async (req, res) => {
  try {
    const dash = await commission.propertyDashboard(req.params.paybill, Number(req.params.id), req.query.month);
    if (!dash) return res.status(404).json({ error: 'Property not found' });
    if (dash.landlord && dash.landlord.id !== Number(req.params.id)) {
      return res.status(403).json({ error: 'This property belongs to a different landlord' });
    }
    res.json(dash);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load property dashboard: ' + err.message });
  }
});

router.post('/:id/properties/:paybill/remittance-payments', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await commission.recordRemittancePayment({
      house_paybill_number: req.params.paybill,
      landlord_id: Number(req.params.id),
      declared_landlord_id: body.landlord_id != null ? Number(body.landlord_id) : null,
      billing_month: body.billing_month,
      payment_date: body.payment_date,
      amount: body.amount,
      method: body.method,
      reference: body.reference,
      notes: body.notes,
      proof_note: body.proof_note,
      actor: req.user?.username,
    });
    if (result.error) {
      const status = result.code === 'NOT_FOUND' ? 404
        : result.code === 'LANDLORD_MISMATCH' || result.code === 'FINALIZED' ? 409 : 400;
      return res.status(status).json({ error: result.error, code: result.code });
    }
    await store.logAudit({
      actor: req.user?.username, action: 'landlord_remittance_recorded',
      entityType: 'landlord_remittance_payment', entityId: String(result.payment.id),
      details: { house: req.params.paybill, billing_month: body.billing_month, amount: Number(result.payment.amount), reference: result.payment.reference },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to record remittance: ' + err.message });
  }
});

router.put('/:id/properties/:paybill/remittance-day', async (req, res) => {
  try {
    const result = await commission.setRemittanceDay(req.params.paybill, req.body?.day);
    if (result.error) return res.status(400).json({ error: result.error, code: result.code });
    await store.logAudit({
      actor: req.user?.username, action: 'remittance_day_set',
      entityType: 'house', entityId: req.params.paybill, details: { day: result.remittance_day },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to set agreed payment day: ' + err.message });
  }
});

router.post('/:id/properties/:paybill/remittance-statement', async (req, res) => {
  try {
    const { generateAndStoreRemittanceStatement } = require('../services/documentStore');
    const doc = await generateAndStoreRemittanceStatement(req.params.paybill);
    if (!doc) return res.status(404).json({ error: 'Property not found' });
    const rem = await commission.remittanceLedger(req.params.paybill, Number(req.params.id));
    res.json({ ledger: rem, document: doc });
  } catch (err) {
    res.status(500).json({ error: 'Failed to build remittance statement: ' + err.message });
  }
});

// ── Verification, reconciliation, finalization, reviews (authorization) ────
router.post('/remittance-payments/:paymentId/verify', requireAdmin, async (req, res) => {
  try {
    const result = await commission.verifyRemittancePayment(Number(req.params.paymentId), req.user?.username);
    if (result.error) return res.status(result.code === 'NOT_FOUND' ? 404 : 400).json({ error: result.error, code: result.code });
    await store.logAudit({
      actor: req.user?.username, action: 'remittance_verified',
      entityType: 'landlord_remittance_payment', entityId: String(result.payment.id),
      details: { amount: Number(result.payment.amount), house: result.payment.house_paybill_number, reference: result.payment.reference },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
});

router.get('/:id/properties/:paybill/reconciliation', async (req, res) => {
  try {
    const rec = await commission.reconciliation(req.params.paybill, req.query.month || new Date().toISOString().slice(0, 7));
    res.json(rec);
  } catch (err) {
    res.status(500).json({ error: 'Reconciliation failed: ' + err.message });
  }
});

router.post('/:id/properties/:paybill/finalize', requireAdmin, async (req, res) => {
  try {
    const month = req.body?.billing_month || req.query.month;
    const result = await commission.finalizeLedger(req.params.paybill, month, req.user?.username);
    if (result.error) {
      return res.status(result.code === 'RECONCILIATION' ? 409 : 400).json({ error: result.error, code: result.code, reconciliation: result.reconciliation });
    }
    await store.logAudit({
      actor: req.user?.username, action: 'landlord_ledger_finalized',
      entityType: 'house', entityId: req.params.paybill, details: { billing_month: month },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Finalization failed: ' + err.message });
  }
});

router.post('/:id/properties/:paybill/reopen', requireAdmin, async (req, res) => {
  try {
    const month = req.body?.billing_month || req.query.month;
    const result = await commission.reopenLedger(req.params.paybill, month, req.user?.username);
    await store.logAudit({
      actor: req.user?.username, action: 'landlord_ledger_reopened',
      entityType: 'house', entityId: req.params.paybill, details: { billing_month: month },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Reopen failed: ' + err.message });
  }
});

router.post('/:id/properties/:paybill/reviews', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await commission.flagReview({
      house_paybill_number: req.params.paybill,
      billing_month: body.billing_month,
      target_type: body.target_type,
      target_id: body.target_id,
      reason: body.reason,
      evidence_note: body.evidence_note,
      actor: req.user?.username,
    });
    if (result.error) return res.status(400).json({ error: result.error, code: result.code });
    await store.logAudit({
      actor: req.user?.username, action: 'landlord_review_flagged',
      entityType: 'landlord_review', entityId: String(result.review.id),
      details: { house: req.params.paybill, billing_month: body.billing_month, reason: result.review.reason },
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Flagging review failed: ' + err.message });
  }
});

router.post('/reviews/:reviewId/resolve', requireAdmin, async (req, res) => {
  try {
    const result = await commission.resolveReview(Number(req.params.reviewId), req.user?.username);
    if (result.error) return res.status(result.code === 'NOT_FOUND' ? 404 : 400).json({ error: result.error, code: result.code });
    await store.logAudit({
      actor: req.user?.username, action: 'landlord_review_resolved',
      entityType: 'landlord_review', entityId: String(req.params.reviewId), details: {},
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Resolve failed: ' + err.message });
  }
});

module.exports = router;
