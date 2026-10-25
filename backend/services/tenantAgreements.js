'use strict';

/**
 * Signed tenancy agreements on Supabase Storage (private bucket).
 *
 * Isolation model (matches the app's own JWT auth, which has no Supabase
 * Auth identities for RLS-by-user):
 *  - Bucket is PRIVATE: nothing is reachable by URL guessing.
 *  - Every file lives under its tenant's prefix: <tenant_code>/<uuid>.<ext>
 *  - The server holds the service key; every list/preview/delete first
 *    verifies the metadata row belongs to the requested tenant.
 *  - Previews use short-lived signed URLs (120s), never permanent links.
 * A tenant A session therefore has no path to tenant B's files.
 */

const BUCKET = 'tenancy-agreements';
const PREVIEW_TTL_SECONDS = 120;
const MAX_BYTES = 12 * 1024 * 1024;

let _client = null;

function getClient() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  }
  const { createClient } = require('@supabase/supabase-js');
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

function safeSegment(s) {
  return String(s || '').replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 40) || 'file';
}

function randomId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

async function ensureBucket() {
  const sb = getClient();
  const { data, error } = await sb.storage.listBuckets();
  if (error) throw new Error('Supabase storage unreachable: ' + error.message);
  if (!(data || []).some((b) => b.name === BUCKET)) {
    const { error: createErr } = await sb.storage.createBucket(BUCKET, { public: false });
    if (createErr) throw new Error('Could not create bucket: ' + createErr.message);
  }
}

function detectKind(buffer, mimetype) {
  const head = buffer.slice(0, 5).toString('latin1');
  if (head.startsWith('%PDF')) return { ext: 'pdf', mime: 'application/pdf' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return { ext: 'jpg', mime: 'image/jpeg' };
  if (head.startsWith('PNG')) return { ext: 'png', mime: 'image/png' };
  if (String(mimetype || '').includes('pdf')) return { ext: 'pdf', mime: 'application/pdf' };
  return null;
}

async function uploadAgreement({ tenantCode, buffer, mimetype, originalName }) {
  if (!buffer || !buffer.length) throw new Error('Empty file');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`File too large (${(buffer.length / 1048576).toFixed(1)} MB). Max is 12 MB — compress scans before uploading.`);
  }
  const kind = detectKind(buffer, mimetype);
  if (!kind) throw new Error('Only PDF, JPG or PNG files are accepted');
  await ensureBucket();
  const sb = getClient();
  const path = `${safeSegment(tenantCode)}/${randomId()}.${kind.ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, buffer, {
    contentType: kind.mime,
    upsert: false,
  });
  if (error) throw new Error('Upload failed: ' + error.message);
  return { path, mimetype: kind.mime, size: buffer.length };
}

async function signedPreviewUrl(path) {
  const sb = getClient();
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, PREVIEW_TTL_SECONDS);
  if (error || !data || !data.signedUrl) {
    throw new Error('Could not create preview link: ' + (error ? error.message : 'unknown'));
  }
  return data.signedUrl;
}

async function deleteAgreementFile(path) {
  const sb = getClient();
  const { error } = await sb.storage.from(BUCKET).remove([path]);
  if (error) throw new Error('Storage delete failed: ' + error.message);
}

module.exports = {
  BUCKET,
  PREVIEW_TTL_SECONDS,
  getClient,
  ensureBucket,
  uploadAgreement,
  signedPreviewUrl,
  deleteAgreementFile,
};
