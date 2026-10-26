'use strict';

/**
 * Pre-Exit Inspection Inventory routes — /api/preexit
 * An ADDITIONAL feature before the Exit Invoice: records findings, shares the
 * PDF with the tenant, and transfers agreed items into the existing Exit
 * Invoice exactly once. The Exit Invoice workflow itself is untouched.
 */

const express = require('express');
const fs = require('fs');
const { requireAuthActive } = require('../middleware/auth');
const preexit = require('../services/preexitInspection');

const router = express.Router();
router.use(requireAuthActive);

// Lookup: unit number -> tenant details, historical tenancies, inventories
router.get('/lookup', async (req, res) => {
  try {
    const result = await preexit.lookupUnit(req.query.unit);
    if (result.error) return res.status(result.code === 'NOT_FOUND' ? 404 : 400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed: ' + err.message });
  }
});

// List inventories for a unit
router.get('/', async (req, res) => {
  try {
    const unit = String(req.query.unit || '').trim();
    if (!unit) return res.status(400).json({ error: 'unit query parameter is required' });
    res.json({ inspections: await preexit.listInspections(unit) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list inventories: ' + err.message });
  }
});

// Create
router.post('/', async (req, res) => {
  try {
    const { unit, inspection_date, tenancy_id } = req.body || {};
    const result = await preexit.createInspection({
      unit, inspection_date, tenancy_id, actor: req.user?.username,
    });
    if (result.error) {
      const status = result.code === 'NOT_FOUND' ? 404
        : result.code === 'TENANCY_REQUIRED' ? 409 : 400;
      return res.status(status).json({ error: result.error, code: result.code });
    }
    res.status(201).json({ inspection: result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create inventory: ' + err.message });
  }
});

// Full inspection (items + tenant/tenancy context + exit-invoice link)
router.get('/:id', async (req, res) => {
  try {
    const inspection = await preexit.getInspection(req.params.id);
    if (!inspection) return res.status(404).json({ error: 'Inventory not found' });
    res.json({ inspection });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load inventory: ' + err.message });
  }
});

// Save changes (add / edit / delete items in one batch; server recalculates)
router.put('/:id', async (req, res) => {
  try {
    const { inspection_date, items } = req.body || {};
    const result = await preexit.saveInspection(req.params.id, { inspection_date, items });
    if (result.error) {
      const status = result.code === 'STALE' ? 409
        : result.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: result.error, code: result.code });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save inventory: ' + err.message });
  }
});

// Status (Agreed / Draft; Shared only via the share action)
router.put('/:id/status', async (req, res) => {
  try {
    const result = await preexit.setStatus(req.params.id, req.body?.status);
    if (result.error) {
      return res.status(result.code === 'NOT_FOUND' ? 404 : 400).json({ error: result.error, code: result.code });
    }
    res.json({ inspection: result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status: ' + err.message });
  }
});

// Share with Tenant: generate the PDF and send it via the existing
// WhatsApp document pipeline (also stored in the Documents hub).
router.post('/:id/share', async (req, res) => {
  try {
    const result = await preexit.shareInspection(req.params.id, { actor: req.user?.username });
    if (result.error) {
      const status = result.code === 'SEND_FAILED' ? 502
        : result.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: result.error, code: result.code, document: result.document || null });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to share inventory: ' + err.message });
  }
});

// Download the latest inventory PDF
router.get('/:id/pdf', async (req, res) => {
  try {
    const inspection = await preexit.getInspection(req.params.id);
    if (!inspection) return res.status(404).json({ error: 'Inventory not found' });
    if (!inspection.document_id) return res.status(404).json({ error: 'No PDF generated yet — use Share with Tenant first' });
    const doc = (await require('../config/database').query(
      `SELECT * FROM documents WHERE id = $1`, [inspection.document_id]
    )).rows[0];
    if (!doc || !doc.file_path || !fs.existsSync(doc.file_path)) {
      return res.status(404).json({ error: 'PDF file not found on disk' });
    }
    res.download(doc.file_path, doc.filename || 'Pre-Exit-Inspection.pdf');
  } catch (err) {
    res.status(500).json({ error: 'Failed to download PDF: ' + err.message });
  }
});

// Transfer agreed items into the existing Exit Invoice (exactly once)
router.post('/:id/transfer', async (req, res) => {
  try {
    const { item_ids } = req.body || {};
    const result = await preexit.transferItems(req.params.id, { item_ids, actor: req.user?.username });
    if (result.error) {
      const status = result.code === 'EXIT_INVOICE_FINALIZED' ? 409
        : result.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: result.error, code: result.code });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Transfer failed: ' + err.message });
  }
});

module.exports = router;
