'use strict';

/**
 * Landlord routes — /api/landlords
 * ONE landlord profile -> MANY properties -> each property keeps its OWN
 * independent commission account (invoices, payments, running balance).
 */
const express = require('express');
const fs = require('fs');
const { requireAuthActive } = require('../middleware/auth');
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
    const { name, phone, email, id_number, notes } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const { query } = require('../config/database');
    const row = (await query(
      `INSERT INTO landlords (name, phone, email, id_number, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [String(name).trim(), phone || null, email || null, id_number || null, notes || null]
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
    const { name, phone, email, id_number, notes } = req.body || {};
    const row = (await query(
      `UPDATE landlords SET name = COALESCE($1, name), phone = COALESCE($2, phone),
              email = COALESCE($3, email), id_number = COALESCE($4, id_number),
              notes = COALESCE($5, notes), updated_at = NOW()
        WHERE id = $6 RETURNING *`,
      [name || null, phone || null, email || null, id_number || null, notes || null, Number(req.params.id)]
    )).rows[0];
    if (!row) return res.status(404).json({ error: 'Landlord not found' });
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
      actor: req.user?.username,
    });
    if (result.error) {
      const status = result.code === 'NOT_FOUND' ? 404
        : result.code === 'LANDLORD_MISMATCH' ? 409 : 400;
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

module.exports = router;
