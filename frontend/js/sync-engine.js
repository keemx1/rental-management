/**
 * GEHPM sync engine (Phase 1).
 *
 * Outbox pattern with device-generated idempotency keys (`client_txn_id`):
 *   offline APPROVE → outbox (PENDING SYNC) → online → push to server →
 *   server allocates with the EXISTING workflow → SYNCED.
 *
 * Guarantees:
 * - Same `client_txn_id` replayed twice can never double-post
 *   (server UNIQUE constraint + idempotent replay responses).
 * - Allocation logic always runs server-side; the client never computes
 *   balances — it only caches the last synced snapshot for display/lookup.
 * - A 409 "Duplicate reference" from the server marks the op FAILED with
 *   the existing record details (never auto-overwrites financial data).
 *
 * Status is broadcast via `CustomEvent('gehm-sync')` with detail:
 *   { online, syncState, pending, lastPull, lastError }
 * syncState: 'idle' | 'syncing' | 'failed'
 */
import { api } from './api.js';
import { offlineDb } from './offline-db.js';
import { markMediaSynced } from './offline-media.js';

const HEARTBEAT_MS = 30000;
const PROBE_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 5;

const _subscribers = [];
let _online = typeof navigator !== 'undefined' ? navigator.onLine : true;
let _syncState = 'idle';
let _pending = 0;
let _lastPull = null;
let _lastError = null;
let _syncing = false;
let _heartbeat = null;

function emit() {
  const detail = {
    online: _online,
    syncState: _syncState,
    pending: _pending,
    lastPull: _lastPull,
    lastError: _lastError,
  };
  _subscribers.forEach((fn) => { try { fn(detail); } catch (_) {} });
  try {
    window.dispatchEvent(new CustomEvent('gehm-sync', { detail }));
  } catch (_) {}
}

function subscribe(fn) {
  if (typeof fn === 'function') _subscribers.push(fn);
  return () => {
    const i = _subscribers.indexOf(fn);
    if (i >= 0) _subscribers.splice(i, 1);
  };
}

function getStatus() {
  return { online: _online, syncState: _syncState, pending: _pending, lastPull: _lastPull, lastError: _lastError };
}

function isOffline() {
  return !_online;
}

async function probeOnline() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch('/api/health', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t);
    return !!(res && res.ok);
  } catch (_) {
    return false;
  }
}

async function refreshPending() {
  try {
    _pending = await offlineDb.pendingCount();
  } catch (_) {
    _pending = 0;
  }
  return _pending;
}

async function setOnline(next) {
  const changed = next !== _online;
  _online = next;
  try {
    if (next) await offlineDb.kvSet('last_online', new Date().toISOString());
  } catch (_) {}
  if (changed) {
    emit();
    if (next) syncNow().catch(() => {});
  }
}

async function heartbeat() {
  const up = await probeOnline();
  await setOnline(up);
}

function initSyncEngine() {
  return offlineDb.openDb()
    .then(() => offlineDb.kvGet('last_pull'))
    .then((lp) => { _lastPull = lp || null; })
    .catch(() => {})
    .then(() => refreshPending())
    .then(() => {
      emit();
      try {
        window.addEventListener('online', () => heartbeat());
        window.addEventListener('offline', () => setOnline(false));
      } catch (_) {}
      if (_heartbeat) clearInterval(_heartbeat);
      _heartbeat = setInterval(heartbeat, HEARTBEAT_MS);
      // Initial probe + opportunistic pull/push
      return heartbeat();
    });
}

/** Queue an offline operation. `op` = { type, payload } (payload carries client_txn_id). */
async function queueOutboxOp(op) {
  const now = new Date().toISOString();
  const entry = {
    client_txn_id: op.payload.client_txn_id,
    type: op.type,
    payload: op.payload,
    status: 'pending',
    attempts: 0,
    error: null,
    created_at: now,
    updated_at: now,
  };
  await offlineDb.put('outbox', entry);
  await refreshPending();
  emit();
  return entry;
}

// ─── Push ──────────────────────────────────────────────────────────────────
// One upload call per op type. Each returns { res, cache, row } where `cache`
// is the offline-db store for the synced row (null = no local row needed)
// and `row` is the SYNCED cache entry to write.

async function pushOp(op) {
  const p = op.payload || {};
  switch (op.type) {
    case 'payment_mpesa': {
      const res = await api.approvePaymentFromMessage({
        raw_message: p.raw_message,
        tenant_id: p.tenant_id,
        payment_date: p.payment_date || undefined,
        client_txn_id: op.client_txn_id,
      });
      const sp = res.payment || {};
      return {
        res,
        cache: 'payments',
        row: {
          key: sp.id != null ? `server:${sp.id}` : `pending:${op.client_txn_id}`,
          client_txn_id: op.client_txn_id,
          server_id: sp.id ?? null,
          tenant_code: sp.tenant_code ?? p.tenant_code ?? null,
          tenant_name: (res.tenant && res.tenant.name) || p.tenant_name || '',
          amount: Number(sp.amount ?? p.amount ?? 0),
          mpesa_reference: sp.mpesa_reference ?? p.mpesa_reference ?? null,
          payment_date: sp.payment_date ?? p.payment_date ?? null,
          mode: p.payment_mode || 'M-Pesa',
          sync: 'synced',
          receipt: res.whatsapp && res.whatsapp.status === 'Sent' ? 'sent' : 'queued',
          synced_at: new Date().toISOString(),
        },
      };
    }
    case 'payment_cash': {
      const res = await api.approveCashPesaLink({ ...p, client_txn_id: op.client_txn_id });
      const sp = res.payment || {};
      return {
        res,
        cache: 'payments',
        row: {
          key: sp.id != null ? `server:${sp.id}` : `pending:${op.client_txn_id}`,
          client_txn_id: op.client_txn_id,
          server_id: sp.id ?? null,
          tenant_code: sp.tenant_code ?? p.tenant_code ?? null,
          tenant_name: (res.tenant && res.tenant.name) || p.tenant_name || '',
          amount: Number(sp.amount ?? p.amount ?? 0),
          mpesa_reference: sp.mpesa_reference ?? p.mpesa_reference ?? null,
          payment_date: sp.payment_date ?? p.payment_date ?? null,
          mode: p.payment_mode || 'Cash',
          sync: 'synced',
          receipt: res.whatsapp && res.whatsapp.status === 'Sent' ? 'sent' : 'queued',
          synced_at: new Date().toISOString(),
        },
      };
    }
    case 'wo_create': {
      const res = await api.createWorkOrder({ ...p, client_txn_id: op.client_txn_id });
      const o = res.order || {};
      return {
        res,
        cache: 'work_orders',
        row: {
          key: o.id != null ? `server:${o.id}` : `pending:${op.client_txn_id}`,
          client_txn_id: op.client_txn_id,
          server_id: o.id ?? null,
          wo_number: o.wo_number || p.wo_number || '',
          property_name: o.property_name || p.property_name || '',
          status: o.status || p.status || 'Pending',
          sync: 'synced',
          synced_at: new Date().toISOString(),
        },
      };
    }
    case 'maintenance_create': {
      const res = await api.createMaintenanceInvoice({ ...p, client_txn_id: op.client_txn_id });
      const inv = res.invoice || {};
      return {
        res,
        cache: 'maintenance',
        row: {
          key: inv.id != null ? `server:${inv.id}` : `pending:${op.client_txn_id}`,
          client_txn_id: op.client_txn_id,
          server_id: inv.id ?? null,
          mnt_number: inv.mnt_number || '',
          property_name: inv.property_name || p.property_name || '',
          grand_total: Number(inv.grand_total ?? 0),
          status: inv.status || p.status || 'Pending',
          sync: 'synced',
          synced_at: new Date().toISOString(),
        },
      };
    }
    case 'water_create': {
      const res = await api.createWaterInvoice({ ...p, client_txn_id: op.client_txn_id });
      const w = res.water_invoice || {};
      return {
        res,
        cache: 'water',
        row: {
          key: w.id != null ? `server:${w.id}` : `pending:${op.client_txn_id}`,
          client_txn_id: op.client_txn_id,
          server_id: w.id ?? null,
          wtr_number: w.wtr_number || '',
          tenant_code: w.tenant_code || p.tenant_code || '',
          tenant_name: w.tenant_name || p.tenant_name || '',
          billing_month: w.billing_month || p.billing_month || '',
          current_reading: Number(w.current_reading ?? p.current_reading ?? 0),
          sync: 'synced',
          synced_at: new Date().toISOString(),
        },
      };
    }
    case 'inspection_create': {
      const res = await api.createInspection({ ...p, client_txn_id: op.client_txn_id });
      const ins = res.inspection || {};
      return {
        res,
        cache: 'inspections',
        row: {
          key: ins.id != null ? `server:${ins.id}` : `pending:${op.client_txn_id}`,
          client_txn_id: op.client_txn_id,
          server_id: ins.id ?? null,
          property_name: ins.property_name || p.property_name || '',
          unit_label: ins.unit_label || p.unit_label || '',
          status: ins.status || p.status || 'Draft',
          sync: 'synced',
          synced_at: new Date().toISOString(),
        },
      };
    }
    case 'notice_send': {
      // Offline notice (Pending Send) — delivered once, exactly once.
      const res = await api.sendMessage(p.tenant_id, p.message, op.client_txn_id);
      return { res, cache: null, row: null };
    }
    case 'exit_create': {
      const res = await api.createExitInvoice({ ...p, client_txn_id: op.client_txn_id });
      return { res, cache: null, row: null };
    }
    case 'tenant_occupy': {
      const res = await api.markOccupied(p.tenant_id, { ...(p.body || {}), client_txn_id: op.client_txn_id });
      return { res, cache: null, row: null };
    }
    default:
      throw new Error(`Unknown offline op type: ${op.type}`);
  }
}

function applyPushSuccess(op, pushed) {
  const tasks = [offlineDb.del('outbox', op.client_txn_id)];
  if (pushed.cache && pushed.row) tasks.push(offlineDb.put(pushed.cache, pushed.row));
  return Promise.all(tasks);
}

function applyPushDuplicate(op, err) {
  const dup = (err && err.data && (err.data.duplicate || err.data.existing_ref)) || null;
  op.status = 'failed';
  op.error = (err && err.data && (err.data.message || err.data.error)) || 'Rejected by server';
  op.updated_at = new Date().toISOString();
  const tasks = [offlineDb.put('outbox', op)];
  // Mirror the failure into the matching local cache so lists show
  // 🔴 SYNC FAILED with the server's reason.
  if (op.type === 'payment_mpesa' || op.type === 'payment_cash') {
    tasks.push(offlineDb.put('payments', {
      key: `pending:${op.client_txn_id}`,
      client_txn_id: op.client_txn_id,
      server_id: null,
      tenant_code: op.payload.tenant_code ?? null,
      tenant_name: op.payload.tenant_name || '',
      amount: Number(op.payload.amount ?? 0),
      mpesa_reference: op.payload.mpesa_reference ?? null,
      payment_date: op.payload.payment_date ?? null,
      mode: op.payload.payment_mode || 'M-Pesa',
      sync: 'failed',
      receipt: 'failed',
      error: op.error,
      duplicate: dup,
    }));
  } else if (op.type === 'water_create') {
    tasks.push(offlineDb.put('water', {
      key: `pending:${op.client_txn_id}`,
      client_txn_id: op.client_txn_id,
      server_id: null,
      wtr_number: '(rejected)',
      tenant_code: op.payload.tenant_code || '',
      tenant_name: op.payload.tenant_name || '',
      billing_month: op.payload.billing_month || '',
      current_reading: Number(op.payload.current_reading ?? 0),
      sync: 'failed',
      error: op.error,
      created_at: op.created_at,
    }));
  }
  return Promise.all(tasks);
}

/**
 * Push all pending outbox ops, oldest first. Sequential on purpose:
 * financial uploads must not race each other from one device.
 */
async function pushAllPending() {
  const pending = await offlineDb.pendingOutbox();
  for (const op of pending) {
    try {
      op.status = 'syncing';
      op.updated_at = new Date().toISOString();
      await offlineDb.put('outbox', op).catch(() => {});
      const pushed = await pushOp(op);
      await applyPushSuccess(op, pushed || {});
    } catch (err) {
      const status = err && err.status;
      const msg = String((err && err.message) || '');
      const isNet = status === undefined || status === 0 || /network|fetch|failed to fetch|abort|offline/i.test(msg);
      if (isNet) {
        op.status = 'pending';
        op.updated_at = new Date().toISOString();
        await offlineDb.put('outbox', op).catch(() => {});
        await setOnline(false);
        break; // stop — we lost connectivity mid-sync
      }
      if (status === 409) {
        await applyPushDuplicate(op, err).catch(() => {});
        continue; // rejected duplicate — keep going with the rest
      }
      op.attempts = Number(op.attempts || 0) + 1;
      op.status = op.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      op.error = msg || 'Sync failed';
      op.updated_at = new Date().toISOString();
      await offlineDb.put('outbox', op).catch(() => {});
      _lastError = op.error;
    }
  }
}

// ─── Conflict resolutions (Phase 3) ─────────────────────────────────────────
// After pushing, ask the server what managers decided about our FAILED
// uploads: `dismissed` clears them locally (server truth stands),
// `retry` re-queues them for one more upload pass.

const OP_TYPE_CACHE = {
  payment_mpesa: 'payments',
  payment_cash: 'payments',
  wo_create: 'work_orders',
  maintenance_create: 'maintenance',
  water_create: 'water',
  inspection_create: 'inspections',
};

async function markCacheDismissed(op) {
  const storeName = OP_TYPE_CACHE[op.type];
  if (!storeName) return;
  const row = await offlineDb.get(storeName, `pending:${op.client_txn_id}`).catch(() => null);
  if (row) {
    row.sync = 'dismissed';
    row.error = 'Dismissed by manager — server record stands.';
    await offlineDb.put(storeName, row).catch(() => {});
  }
}

/** @returns true when at least one op was re-queued for retry. */
async function applyConflictResolutions() {
  const failed = await offlineDb.pendingOutbox()
    .then((all) => (all || []).filter((o) => o && o.status === 'failed'))
    .catch(() => []);
  if (!failed.length) return false;
  let map = {};
  try {
    const res = await api.checkConflicts(failed.map((o) => o.client_txn_id));
    map = (res && res.resolutions) || {};
  } catch (_) {
    return false;
  }
  let retried = false;
  for (const op of failed) {
    const r = map[op.client_txn_id];
    if (!r || r.status !== 'resolved') continue;
    if (r.resolution === 'dismissed') {
      await offlineDb.del('outbox', op.client_txn_id).catch(() => {});
      await markCacheDismissed(op);
    } else if (r.resolution === 'retry') {
      op.status = 'pending';
      op.attempts = 0;
      op.error = null;
      op.updated_at = new Date().toISOString();
      await offlineDb.put('outbox', op).catch(() => {});
      retried = true;
    }
  }
  await refreshPending().catch(() => {});
  emit();
  return retried;
}

async function syncNow() {
  if (_syncing) return getStatus();
  if (!(await probeOnline())) {
    await setOnline(false);
    return getStatus();
  }
  await setOnline(true);
  _syncing = true;
  _syncState = 'syncing';
  _lastError = null;
  emit();

  try {
    await pushAllPending();

    // Phase 2: upload staged photos AFTER their parent records synced,
    // resolving device UUIDs to real server ids.
    try {
      await syncPendingMedia();
    } catch (err) {
      _lastError = (err && err.message) || 'Photo upload failed';
    }

    // Phase 3: apply manager resolutions, then one retry pass if needed.
    try {
      const retried = await applyConflictResolutions();
      if (retried) await pushAllPending();
    } catch (err) {
      _lastError = (err && err.message) || 'Conflict check failed';
    }

    // Pull latest snapshot after pushing (server is source of truth).
    try {
      await pullSnapshot();
    } catch (err) {
      _lastError = (err && err.message) || 'Snapshot refresh failed';
    }

    await refreshPending();
    const failed = await offlineDb.pendingOutbox().then((all) => all.filter((o) => o.status === 'failed').length).catch(() => 0);
    _syncState = failed > 0 ? 'failed' : 'idle';
    emit();
    return getStatus();
  } finally {
    _syncing = false;
  }
}

// ─── Media (phase 2) ─────────────────────────────────────────────────────────
// Staged photos upload only after the parent record has a server id.

const MEDIA_PARENT_STORES = ['payments', 'work_orders', 'maintenance', 'water', 'inspections'];

async function resolveParentServerId(parentClientTxnId) {
  for (const storeName of MEDIA_PARENT_STORES) {
    try {
      const all = await offlineDb.getAll(storeName);
      const hit = (all || []).find((r) => r && r.client_txn_id === parentClientTxnId && r.server_id != null);
      if (hit) return Number(hit.server_id);
    } catch (_) {}
  }
  return null;
}

async function syncPendingMedia() {
  const all = await offlineDb.getAll('media').catch(() => []);
  const pending = (all || []).filter((m) => m && m.sync === 'pending' && m.data);
  for (const m of pending) {
    try {
      const serverId = await resolveParentServerId(m.parent_client_txn_id);
      if (serverId == null) continue; // parent not synced yet — retry next time
      await api.uploadOfflineMedia({
        client_txn_id: m.client_txn_id,
        linked_type: m.linked_type,
        linked_client_txn_id: m.parent_client_txn_id,
        linked_id: serverId,
        filename: m.filename,
        mimetype: m.mimetype,
        data: m.data,
      });
      await markMediaSynced(m.key);
    } catch (err) {
      const msg = String((err && err.message) || '');
      const isNet = (err && err.status === undefined) || /network|fetch|abort|offline/i.test(msg);
      if (isNet) break;
      // Leave for retry; record nothing destructive.
    }
  }
}

// ─── Pull ──────────────────────────────────────────────────────────────────

async function mergeCache(storeName, serverRows) {
  const existing = await offlineDb.getAll(storeName).catch(() => []);
  const pendingRows = (existing || []).filter((r) => r && String(r.key || '').startsWith('pending:'));
  await offlineDb.clear(storeName);
  await offlineDb.bulkPut(storeName, [...pendingRows, ...serverRows]);
}

async function pullSnapshot() {
  const snap = await api.syncPull({ payments_days: 90 });
  const stamp = snap.server_time || new Date().toISOString();
  if (Array.isArray(snap.tenants)) {
    await offlineDb.clear('tenants');
    await offlineDb.bulkPut('tenants', snap.tenants.filter((t) => t && t.tenant_code));
  }
  if (Array.isArray(snap.houses)) {
    await offlineDb.clear('houses');
    await offlineDb.bulkPut('houses', snap.houses.filter((h) => h && h.paybill_number));
  }
  if (Array.isArray(snap.payments)) {
    // Merge server rows into the payments cache without touching
    // locally-pending entries.
    const serverRows = snap.payments
      .filter((p) => p && p.id != null)
      .map((p) => ({
        key: `server:${p.id}`,
        client_txn_id: p.client_txn_id || null,
        server_id: p.id,
        tenant_code: p.tenant_code ?? null,
        tenant_name: p.tenant_name || '',
        amount: Number(p.amount ?? 0),
        mpesa_reference: p.mpesa_reference ?? null,
        payment_date: p.payment_date ?? null,
        mode: p.payment_mode || 'M-Pesa',
        sync: 'synced',
        receipt: 'sent',
        synced_at: stamp,
      }));
    await mergeCache('payments', serverRows);
  }
  if (Array.isArray(snap.work_orders)) {
    await mergeCache('work_orders', snap.work_orders.filter((o) => o && o.id != null).map((o) => ({
      key: `server:${o.id}`,
      client_txn_id: o.client_txn_id || null,
      server_id: o.id,
      wo_number: o.wo_number || '',
      property_name: o.property_name || '',
      status: o.status || '',
      sync: 'synced',
      synced_at: stamp,
    })));
  }
  if (Array.isArray(snap.maintenance_invoices)) {
    await mergeCache('maintenance', snap.maintenance_invoices.filter((m) => m && m.id != null).map((m) => ({
      key: `server:${m.id}`,
      client_txn_id: m.client_txn_id || null,
      server_id: m.id,
      mnt_number: m.mnt_number || '',
      property_name: m.property_name || '',
      grand_total: Number(m.grand_total ?? 0),
      status: m.status || '',
      sync: 'synced',
      synced_at: stamp,
    })));
  }
  if (Array.isArray(snap.water_invoices)) {
    await mergeCache('water', snap.water_invoices.filter((w) => w && w.id != null).map((w) => ({
      key: `server:${w.id}`,
      client_txn_id: w.client_txn_id || null,
      server_id: w.id,
      wtr_number: w.wtr_number || '',
      tenant_code: w.tenant_code || '',
      tenant_name: w.tenant_name || '',
      billing_month: w.billing_month || '',
      current_reading: Number(w.current_reading ?? 0),
      previous_reading: Number(w.previous_reading ?? 0),
      units_used: w.units_used != null ? Number(w.units_used) : null,
      anomaly_flag: w.anomaly_flag || null,
      anomaly_detail: w.anomaly_detail || null,
      sync: 'synced',
      synced_at: stamp,
    })));
  }
  if (Array.isArray(snap.inspections)) {
    await mergeCache('inspections', snap.inspections.filter((i) => i && i.id != null).map((i) => ({
      key: `server:${i.id}`,
      client_txn_id: i.client_txn_id || null,
      server_id: i.id,
      property_name: i.property_name || '',
      unit_label: i.unit_label || '',
      status: i.status || '',
      sync: 'synced',
      synced_at: stamp,
    })));
  }
  _lastPull = stamp;
  await offlineDb.kvSet('last_pull', stamp).catch(() => {});
  emit();
  return snap;
}

export {
  initSyncEngine,
  syncNow,
  pullSnapshot,
  probeOnline,
  isOffline,
  queueOutboxOp,
  subscribe,
  getStatus,
  refreshPending,
};
