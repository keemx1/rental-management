/**
 * GEHPM offline photos (Phase 2) — capture + compress + stage for sync.
 *
 * Field devices (Android phones) can attach photos to work orders,
 * inspections, maintenance/expenses and move-in/out records while offline.
 * Images are downscaled on-device (canvas) so each upload stays a small
 * JPEG (~100–180 KB → base64 fits the JSON body limit). Originals are
 * never kept — only the compressed blob in IndexedDB (`media` store).
 *
 * Flow: pickPhotos() → compressFile() → stagePhoto(parentClientTxnId, …)
 * returns a media key. The sync engine uploads staged photos AFTER the
 * parent record syncs, linking them via `linked_client_txn_id`.
 */
import { offlineDb } from './offline-db.js';

const MAX_B64_CHARS = 180000; // ≈135 KB binary — safe under the JSON limit
const START_MAX_DIM = 1280;
const MIN_MAX_DIM = 480;
const QUALITY = 0.72;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read photo')); };
    img.src = url;
  });
}

function renderToDataUrl(img, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
  const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

/** Compress an image file to a data URL under MAX_B64_CHARS. */
async function compressFile(file) {
  const img = await loadImage(file);
  let dim = START_MAX_DIM;
  let quality = QUALITY;
  let url = renderToDataUrl(img, dim, quality);
  // Iteratively shrink until small enough (bounded loop).
  for (let i = 0; i < 6 && url.length > MAX_B64_CHARS; i++) {
    if (dim > MIN_MAX_DIM) dim = Math.max(MIN_MAX_DIM, Math.round(dim * 0.7));
    else quality = Math.max(0.5, quality - 0.08);
    url = renderToDataUrl(img, dim, quality);
  }
  if (url.length > MAX_B64_CHARS + 60000) {
    throw new Error('Photo still too large after compression — try fewer photos');
  }
  return url;
}

/**
 * Compress + stage a photo for a pending parent op.
 * @returns the staged media record ({ key, client_txn_id, … })
 */
async function stagePhoto(parentClientTxnId, linkedType, file, filename) {
  const dataUrl = await compressFile(file);
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const clientTxnId = offlineDb.newClientTxnId();
  const record = {
    key: `media:${clientTxnId}`,
    client_txn_id: clientTxnId,
    parent_client_txn_id: parentClientTxnId,
    linked_type: linkedType,
    filename: filename || file.name || 'photo.jpg',
    mimetype: 'image/jpeg',
    data: b64,
    size_chars: b64.length,
    sync: 'pending',
    created_at: new Date().toISOString(),
  };
  await offlineDb.put('media', record);
  // Bump the parent's photo counter where applicable.
  try {
    const parent = await offlineDb.get('inspections', `pending:${parentClientTxnId}`).catch(() => null);
    if (parent) {
      parent.photos_count = Number(parent.photos_count || 0) + 1;
      await offlineDb.put('inspections', parent);
    }
  } catch (_) {}
  return record;
}

async function stagedMediaFor(parentClientTxnId) {
  const all = await offlineDb.getAll('media').catch(() => []);
  return (all || []).filter((m) => m && m.parent_client_txn_id === parentClientTxnId && m.sync !== 'synced');
}

async function markMediaSynced(key, serverId) {
  const rec = await offlineDb.get('media', key).catch(() => null);
  if (!rec) return;
  rec.sync = 'synced';
  rec.server_id = serverId ?? null;
  rec.data = null; // free the blob — server has it now
  await offlineDb.put('media', rec).catch(() => {});
  // Prune synced blobs aggressively to protect device storage.
  try {
    await offlineDb.del('media', key);
  } catch (_) {}
}

export { compressFile, stagePhoto, stagedMediaFor, markMediaSynced, MAX_B64_CHARS };
