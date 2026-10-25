/**
 * Official GEHPM signatory signature — central storage + PDF-time assignment.
 *
 * An uploaded signature image plus the holder's name pre-signs letter
 * documents (all letters/agreements share letter.html's signature block):
 * the signature image renders above the printed name, and the printed name
 * becomes the holder's name instead of the generating operator's username.
 * With nothing configured, letters render exactly as before.
 *
 * Like the stamp: resolved fresh on every render (replace = instant
 * everywhere), applied in previews and finalized PDFs only — never stored
 * into bodies, drafts or titles, and never in editor inputs (the marker
 * lives in template chrome).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SIG_DIR = path.join(__dirname, '../storage/official-signature');
const META_FILE = path.join(SIG_DIR, 'signature.json');
const SIG_BASENAME = 'signature';
const ALLOWED = [
  { ext: '.png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: '.jpg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { ext: '.jpeg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
];
const MAX_BYTES = 5 * 1024 * 1024;
const SIG_MARKER = '{{GEHM_SIGNATURE}}';
const SIG_LINE_MARKER = '{{GEHM_SIGNATURE_LINE}}';

let cache = { key: null, uri: '' };

function ensureDir() {
  if (!fs.existsSync(SIG_DIR)) fs.mkdirSync(SIG_DIR, { recursive: true });
}

function detectType(buffer, originalName) {
  const head = [buffer[0], buffer[1], buffer[2], buffer[3]];
  for (const t of ALLOWED) {
    if (t.magic.every((b, i) => head[i] === b)) return t;
  }
  const ext = String(originalName || '').toLowerCase().match(/\.(png|jpe?g)$/);
  if (ext) {
    const norm = ext[1] === 'jpg' ? '.jpg' : ext[1] === 'jpeg' ? '.jpeg' : '.png';
    return ALLOWED.find((t) => t.ext === norm) || null;
  }
  return null;
}

function sigPathFor(ext) {
  return path.join(SIG_DIR, SIG_BASENAME + ext);
}

function resolveSigFile() {
  for (const t of ALLOWED) {
    const p = sigPathFor(t.ext);
    if (fs.existsSync(p)) return { path: p, type: t };
  }
  return null;
}

function readMeta() {
  try {
    if (!fs.existsSync(META_FILE)) return { active: true, holder_name: '' };
    return { active: true, holder_name: '', ...JSON.parse(fs.readFileSync(META_FILE, 'utf8')) };
  } catch (_) {
    return { active: true, holder_name: '' };
  }
}

function writeMeta(meta) {
  ensureDir();
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

function getStatus() {
  const found = resolveSigFile();
  const meta = readMeta();
  if (!found) {
    return { configured: false, active: false, holder_name: meta.holder_name || '', mimetype: null, original_name: null, updated_at: meta.updated_at || null, updated_by: meta.updated_by || null };
  }
  let stat = null;
  try { stat = fs.statSync(found.path); } catch (_) { stat = null; }
  return {
    configured: true,
    active: meta.active !== false,
    holder_name: meta.holder_name || '',
    mimetype: found.type.mime,
    original_name: meta.original_name || null,
    updated_at: meta.updated_at || (stat ? stat.mtime.toISOString() : null),
    updated_by: meta.updated_by || null,
    size_bytes: stat ? stat.size : null,
  };
}

function getSigDataUri() {
  const found = resolveSigFile();
  if (!found) return '';
  if (readMeta().active === false) return '';
  let mtime = '';
  try { mtime = String(fs.statSync(found.path).mtimeMs); } catch (_) { return ''; }
  const key = `${found.path}:${mtime}`;
  if (cache.key === key && cache.uri) return cache.uri;
  const uri = `data:${found.type.mime};base64,` + fs.readFileSync(found.path).toString('base64');
  cache = { key, uri };
  return uri;
}

// Active signature assignment: image tag + holder name. Null when nothing
// usable is configured (missing image, blank holder, or deactivated).
function getActiveSignature() {
  const uri = getSigDataUri();
  const holder = (readMeta().holder_name || '').trim();
  if (!uri || !holder) return null;
  return { uri, holderName: holder };
}

// Compact signature image block (4px rhythm to match the signature block).
function signatureImgTag() {
  const sig = getActiveSignature();
  if (!sig) return '';
  return `<div style="margin:4px 0;text-align:center;">` +
    `<img src="${sig.uri}" alt="Authorized Signature" style="width:140px;max-width:45%;height:auto;" />` +
    `</div>`;
}

function applySignatureMarkers(html) {
  if (!html || typeof html !== 'string') return html;
  return html.split(SIG_MARKER).join(signatureImgTag()).split(SIG_LINE_MARKER).join(signatureLineTag());
}

// Line-level marker: the full "Signature:" authorization line. Shows the
// configured signature image, or a hand-signing line when none is set.
function signatureLineTag() {
  const sig = getActiveSignature();
  if (!sig) return 'Signature: __________';
  return `Signature: <img src="${sig.uri}" alt="Authorized Signature" style="width:140px;max-width:45%;height:auto;vertical-align:middle;" />`;
}

function stripSignatureMarkers(html) {
  if (!html || typeof html !== 'string') return html;
  return html.split(SIG_MARKER).join('').split(SIG_LINE_MARKER).join('');
}

function saveSignature(buffer, originalName, holderName, username) {
  if (!buffer || !buffer.length) throw new Error('Empty file');
  if (buffer.length > MAX_BYTES) throw new Error('Signature exceeds the 5 MB limit');
  const type = detectType(buffer, originalName);
  if (!type) throw new Error('Signature must be a PNG or JPEG image (transparent PNG preferred)');
  const holder = String(holderName || '').trim();
  if (!holder) throw new Error('Signature holder name is required');
  ensureDir();
  for (const t of ALLOWED) {
    const p = sigPathFor(t.ext);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  fs.writeFileSync(sigPathFor(type.ext), buffer);
  const meta = {
    active: true,
    holder_name: holder.slice(0, 128),
    mimetype: type.mime,
    original_name: originalName || null,
    updated_at: new Date().toISOString(),
    updated_by: username || null,
  };
  writeMeta(meta);
  cache = { key: null, uri: '' };
  return getStatus();
}

function setSignatureActive(active, username) {
  const found = resolveSigFile();
  if (!found) throw new Error('No signature uploaded yet');
  const meta = { ...readMeta(), active: active !== false };
  if (username) meta.updated_by = username;
  meta.updated_at = new Date().toISOString();
  writeMeta(meta);
  return getStatus();
}

function setSignatureHolder(holderName, username) {
  const holder = String(holderName || '').trim();
  if (!holder) throw new Error('Signature holder name is required');
  const meta = { ...readMeta(), holder_name: holder.slice(0, 128) };
  if (username) meta.updated_by = username;
  meta.updated_at = new Date().toISOString();
  writeMeta(meta);
  return getStatus();
}

function removeSignature() {
  for (const t of ALLOWED) {
    const p = sigPathFor(t.ext);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  if (fs.existsSync(META_FILE)) fs.unlinkSync(META_FILE);
  cache = { key: null, uri: '' };
  return getStatus();
}

module.exports = {
  SIG_MARKER,
  SIG_LINE_MARKER,
  getStatus,
  getSigDataUri,
  getActiveSignature,
  signatureImgTag,
  signatureLineTag,
  applySignatureMarkers,
  stripSignatureMarkers,
  saveSignature,
  setSignatureActive,
  setSignatureHolder,
  removeSignature,
};
