'use strict';

/**
 * Property inspections (offline-first, Phase 2).
 *
 * Agents conduct inspections offline; the record carries a `client_txn_id`
 * UUID so re-uploads resolve idempotently and never duplicate.
 */
const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');

const router = express.Router();
router.use(requireAuthActive);

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const inspections = await store.listInspections({ limit, offset });
    res.json({ inspections });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list inspections' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { client_txn_id } = req.body || {};
    if (client_txn_id) {
      const replay = await store.findRecordByClientTxnId('inspections', client_txn_id);
      if (replay) return res.json({ inspection: replay, already_synced: true });
    }
    const inspection = await store.createInspection({
      ...(req.body || {}),
      created_by: req.user?.username || null,
    });
    if (inspection._idempotentReplay) {
      return res.json({ inspection, already_synced: true });
    }
    res.status(201).json({ inspection });
  } catch (err) {
    if (err && err.code === '23505' && req.body?.client_txn_id) {
      try {
        const replay = await store.findRecordByClientTxnId('inspections', req.body.client_txn_id);
        if (replay) return res.json({ inspection: replay, already_synced: true });
      } catch (_) {}
    }
    res.status(500).json({ error: 'Failed to save inspection: ' + err.message });
  }
});

module.exports = router;
