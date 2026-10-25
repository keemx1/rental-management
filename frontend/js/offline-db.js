/**
 * GEHPM offline storage — IndexedDB wrapper (no external dependencies).
 *
 * Database: `gehm-offline`, version 2.
 * Stores:
 *   kv          — { k, v } misc state (last_pull, last_online, device_id, session_cache)
 *   tenants     — server tenant rows, keyPath `tenant_code`
 *   houses      — server house rows, keyPath `paybill_number`
 *   payments    — cached + pending payment rows, keyPath `key`
 *                 (`pending:<client_txn_id>` while offline, `server:<id>` once synced)
 *   work_orders — cached + pending work orders, keyPath `key` (same convention)
 *   maintenance — cached + pending maintenance/expense invoices, keyPath `key`
 *   water       — cached + pending water invoices/readings, keyPath `key`
 *   inspections — cached + pending inspections, keyPath `key`
 *   media       — compressed photo blobs, keyPath `key`
 *                 (`media:<client_txn_id>`), linked to a parent op via
 *                 `parent_client_txn_id`; uploaded after the parent syncs.
 *   outbox      — pending uploads, keyPath `client_txn_id`
 *                 { client_txn_id, type, payload, status, attempts, error,
 *                   created_at, updated_at }
 *
 * NOTE: promise wrapper assumes callers await openDb() once at startup
 * (sync-engine does this). All helpers are safe to call afterwards.
 */

const DB_NAME = 'gehm-offline';
const DB_VERSION = 2;

let _db = null;

function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('tenants')) db.createObjectStore('tenants', { keyPath: 'tenant_code' });
      if (!db.objectStoreNames.contains('houses')) db.createObjectStore('houses', { keyPath: 'paybill_number' });
      if (!db.objectStoreNames.contains('payments')) db.createObjectStore('payments', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('work_orders')) db.createObjectStore('work_orders', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('maintenance')) db.createObjectStore('maintenance', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('water')) db.createObjectStore('water', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('inspections')) db.createObjectStore('inspections', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'client_txn_id' });
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error || new Error('Failed to open offline database'));
  });
}

function _tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    let result;
    try {
      result = fn(os);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result !== undefined ? result : null);
    t.onerror = () => reject(t.error || new Error('Offline DB transaction failed'));
    // If fn returned a request, surface its value
    if (result && typeof result === 'object' && 'onsuccess' in result) {
      result.onsuccess = () => resolve(result.result);
      result.onerror = () => reject(result.error || new Error('Offline DB request failed'));
    }
  }));
}

const offlineDb = {
  openDb,

  kvGet(k) {
    return _tx('kv', 'readonly', (os) => os.get(k)).then((r) => (r ? r.v : null));
  },
  kvSet(k, v) {
    return _tx('kv', 'readwrite', (os) => os.put({ k, v }));
  },

  bulkPut(store, records) {
    if (!records || !records.length) return Promise.resolve();
    return openDb().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      const os = t.objectStore(store);
      for (const r of records) { try { os.put(r); } catch (_) {} }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error || new Error('bulkPut failed'));
    }));
  },
  clear(store) {
    return _tx(store, 'readwrite', (os) => os.clear());
  },
  getAll(store) {
    return _tx(store, 'readonly', (os) => os.getAll());
  },
  get(store, key) {
    return _tx(store, 'readonly', (os) => os.get(key));
  },
  put(store, record) {
    return _tx(store, 'readwrite', (os) => os.put(record));
  },
  del(store, key) {
    return _tx(store, 'readwrite', (os) => os.delete(key));
  },

  /** All outbox entries still needing upload, oldest first. */
  pendingOutbox() {
    return this.getAll('outbox').then((all) =>
      (all || [])
        .filter((o) => o.status === 'pending' || o.status === 'failed')
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    );
  },
  pendingCount() {
    return this.pendingOutbox().then((all) => all.length);
  },

  newClientTxnId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  },
};

export { offlineDb };
