'use strict';

/**
 * Offline-first sync endpoints (Phase 1 + 2).
 *
 * GET  /api/sync/pull  — snapshot of server data used to seed / refresh the
 *   on-device cache (tenants, houses, recent payments, work orders,
 *   maintenance invoices, water invoices, inspections). Devices call this
 *   while online; the data powers offline lookups and views.
 * POST /api/sync/media — upload a compressed offline photo (base64 JSON).
 * GET  /api/sync/media — list photos linked to a server record.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuthActive, requireAdmin } = require('../middleware/auth');
const store = require('../storage/store');
const { query } = require('../config/database');

const router = express.Router();
router.use(requireAuthActive);

router.get('/pull', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.payments_days, 10) || 90, 7), 365);
    const limit = Math.min(Math.max(parseInt(req.query.payments_limit, 10) || 5000, 100), 20000);

    const [tenants, houses, workOrders, maintenanceInvoices, inspections] = await Promise.all([
      store.listTenants({}),
      store.listHouses({}),
      store.listWorkOrders({ limit: 100 }).catch(() => []),
      store.listMaintenanceInvoices({ limit: 100 }).catch(() => []),
      store.listInspections({ limit: 100 }).catch(() => []),
    ]);

    const payRes = await query(
      `SELECT p.*, p.tenant_code AS tenant_id, p.payment_date::text AS payment_date,
              t.name AS tenant_name, t.property_name, t.unit_label
       FROM payments p
       LEFT JOIN tenants t ON p.tenant_code = t.tenant_code
       WHERE p.recorded_at >= NOW() - ($1 || ' days')::interval
       ORDER BY p.recorded_at DESC
       LIMIT $2`,
      [String(days), limit]
    );
    const payments = payRes.rows.map((r) => ({ ...r, amount: Number(r.amount) }));

    const waterRes = await query(
      `SELECT * FROM water_invoices ORDER BY created_at DESC LIMIT 200`
    ).catch(() => ({ rows: [] }));
    const waterInvoices = waterRes.rows;

    res.json({
      server_time: new Date().toISOString(),
      counts: {
        tenants: tenants.length,
        houses: houses.length,
        payments: payments.length,
        work_orders: workOrders.length,
        maintenance_invoices: maintenanceInvoices.length,
        water_invoices: waterInvoices.length,
        inspections: inspections.length,
      },
      tenants,
      houses,
      payments,
      work_orders: workOrders,
      maintenance_invoices: maintenanceInvoices,
      water_invoices: waterInvoices,
      inspections,
    });
  } catch (err) {
    console.error('[Sync] pull failed:', err.message);
    res.status(500).json({ error: 'Failed to build sync snapshot' });
  }
});

// ─── Offline photo upload ───────────────────────────────────────────────────

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'offline');
const LINKED_TYPES = new Set([
  'work_order', 'maintenance', 'water', 'inspection', 'expense',
  'move_in', 'move_out', 'tenant', 'general',
]);

function safeFileName(name, fallback) {
  const base = String(name || fallback || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return base.includes('.') ? base : `${base}.jpg`;
}

router.post('/media', async (req, res) => {
  try {
    const {
      client_txn_id, linked_type, linked_client_txn_id, linked_id,
      filename, mimetype, data,
    } = req.body || {};
    if (!data) return res.status(400).json({ error: 'data (base64) required' });
    if (!LINKED_TYPES.has(linked_type)) {
      return res.status(400).json({ error: `linked_type must be one of: ${[...LINKED_TYPES].join(', ')}` });
    }

    if (client_txn_id) {
      const replay = await store.findRecordByClientTxnId('media_attachments', client_txn_id);
      if (replay) return res.json({ media: replay, already_synced: true });
    }

    const clean = String(data).includes(',') ? String(data).split(',').pop() : String(data);
    if (clean.length > 400000) {
      return res.status(413).json({ error: 'Photo too large — recompress on device and retry' });
    }
    const buffer = Buffer.from(clean, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Invalid base64 data' });

    const dir = path.join(UPLOAD_ROOT, linked_type);
    fs.mkdirSync(dir, { recursive: true });
    const fname = `${Date.now()}-${safeFileName(filename, 'photo.jpg')}`;
    const fullPath = path.join(dir, fname);
    fs.writeFileSync(fullPath, buffer);

    // Resolve the device-side parent UUID to the real server row id.
    let resolvedLinkedId = linked_id != null ? Number(linked_id) : null;
    if (resolvedLinkedId == null && linked_client_txn_id) {
      const parentTables = {
        work_order: 'work_orders',
        maintenance: 'maintenance_invoices',
        water: 'water_invoices',
        inspection: 'inspections',
        move_out: 'exit_invoices',
      };
      const parentTable = parentTables[linked_type];
      if (parentTable) {
        const parent = await store.findRecordByClientTxnId(parentTable, linked_client_txn_id);
        if (parent && parent.id != null) resolvedLinkedId = Number(parent.id);
      }
    }

    const media = await store.createMediaAttachment({
      client_txn_id: client_txn_id || null,
      linked_type,
      linked_client_txn_id: linked_client_txn_id || null,
      linked_id: resolvedLinkedId,
      filename: fname,
      mimetype: mimetype || 'image/jpeg',
      size_bytes: buffer.length,
      storage_path: path.relative(path.join(__dirname, '..'), fullPath),
      created_by: req.user?.username || null,
    });
    if (media._idempotentReplay) {
      return res.json({ media, already_synced: true });
    }
    res.status(201).json({ media });
  } catch (err) {
    if (err && err.code === '23505' && req.body?.client_txn_id) {
      try {
        const replay = await store.findRecordByClientTxnId('media_attachments', req.body.client_txn_id);
        if (replay) return res.json({ media: replay, already_synced: true });
      } catch (_) {}
    }
    res.status(500).json({ error: 'Failed to store photo: ' + err.message });
  }
});

router.get('/media', async (req, res) => {
  try {
    const { linked_type, linked_id } = req.query;
    if (!linked_type || linked_id == null) {
      return res.status(400).json({ error: 'linked_type and linked_id required' });
    }
    const items = await store.listMediaAttachments(linked_type, linked_id);
    res.json({ media: items });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list photos' });
  }
});

// ─── Manager review queue (Phase 3) ─────────────────────────────────────────
// Rejected offline uploads land in `sync_conflicts`. Managers resolve
// centrally (dismiss = keep server truth, retry = upload again); devices
// pull resolutions on the next sync and clear/retry automatically.

router.get('/conflicts', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const conflicts = await store.listSyncConflicts(status === 'all' ? null : status);
    res.json({ conflicts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list sync conflicts' });
  }
});

router.post('/conflicts/:id/resolve', requireAdmin, async (req, res) => {
  try {
    const { resolution } = req.body || {};
    const conflict = await store.resolveSyncConflict(req.params.id, {
      resolution,
      by: req.user?.username || null,
    });
    if (!conflict) return res.status(404).json({ error: 'Conflict not found' });
    res.json({ conflict });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to resolve conflict' });
  }
});

// Called by devices during sync: "what happened to my failed uploads?"
router.post('/conflicts/check', async (req, res) => {
  try {
    const { client_txn_ids } = req.body || {};
    const resolutions = await store.getConflictResolutions(client_txn_ids);
    res.json({ resolutions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check conflict resolutions' });
  }
});

module.exports = router;
