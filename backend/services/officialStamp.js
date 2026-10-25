/**
 * Official GEHPM Softcopy Stamp — central storage + PDF-time application.
 *
 * The stamp lives in ONE place (backend/storage/official-stamp/) and is
 * resolved fresh on every PDF generation, so replacing it instantly affects
 * all future finalized PDFs without touching any template.
 *
 * Templates carry a literal `{{GEHM_STAMP}}` marker at their own
 * authorization/signature position (in-flow, so it can never cover text and
 * prints on the correct page). At PDF time the marker becomes the stamp
 * image (or nothing when no stamp is active). Previews and editors never go
 * through the PDF path, so the stamp stays off working interfaces.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const STAMP_DIR = path.join(__dirname, '../storage/official-stamp');
const META_FILE = path.join(STAMP_DIR, 'stamp.json');
const STAMP_BASENAME = 'stamp';
const ALLOWED = [
  { ext: '.png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: '.jpg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { ext: '.jpeg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
];
const MAX_BYTES = 5 * 1024 * 1024;
const STAMP_MARKER = '{{GEHM_STAMP}}';
const STAMP_LINE_MARKER = '{{GEHM_STAMP_LINE}}';

// In-memory data-URI cache, invalidated by file mtime.
let cache = { key: null, uri: '' };

function ensureDir() {
  if (!fs.existsSync(STAMP_DIR)) fs.mkdirSync(STAMP_DIR, { recursive: true });
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

function stampPathFor(ext) {
  return path.join(STAMP_DIR, STAMP_BASENAME + ext);
}

function resolveStampFile() {
  for (const t of ALLOWED) {
    const p = stampPathFor(t.ext);
    if (fs.existsSync(p)) return { path: p, type: t };
  }
  return null;
}

function readMeta() {
  try {
    if (!fs.existsSync(META_FILE)) return { active: true };
    return { active: true, ...JSON.parse(fs.readFileSync(META_FILE, 'utf8')) };
  } catch (_) {
    return { active: true };
  }
}

function writeMeta(meta) {
  ensureDir();
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

function getStatus() {
  const found = resolveStampFile();
  const meta = readMeta();
  if (!found) {
    return { configured: false, active: false, mimetype: null, original_name: null, updated_at: meta.updated_at || null, updated_by: meta.updated_by || null };
  }
  let stat = null;
  try { stat = fs.statSync(found.path); } catch (_) { stat = null; }
  return {
    configured: true,
    active: meta.active !== false,
    mimetype: found.type.mime,
    original_name: meta.original_name || null,
    updated_at: meta.updated_at || (stat ? stat.mtime.toISOString() : null),
    updated_by: meta.updated_by || null,
    size_bytes: stat ? stat.size : null,
  };
}

function getStampDataUri() {
  const found = resolveStampFile();
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

// Centered, fixed-size stamp block. In-flow (never overlays text) and fully
// inline-styled so no template CSS changes are ever needed. Margins kept
// tight so the signature/stamp block reads as one compact unit.
function stampImgTag() {
  const uri = getStampDataUri();
  if (!uri) return '';
  return `<div style="margin:6px 0;text-align:center;">` +
    `<img src="${uri}" alt="GEHPM Official Stamp" style="width:150px;max-width:45%;height:auto;" />` +
    `</div>`;
}

function applyStampMarkers(html) {
  if (!html || typeof html !== 'string') return html;
  return html.split(STAMP_MARKER).join(stampImgTag()).split(STAMP_LINE_MARKER).join(stampLineTag());
}

// Global template rule: every generated PDF carries the stamp exactly once,
// in flow (never floating, never covering content, paginates with the
// signature section). Templates define their own authorization-area position
// via the marker; marker-less documents fall back to end-of-document so no
// official PDF can ever go out unstamped. Previews use this same function,
// so preview and final PDF positions are byte-identical by construction.
// Line-level marker: the full "Official Stamp:" authorization line, so the
// stamp always sits aligned with the other GEHPM details (never isolated,
// never floating). Vanishes entirely when no stamp is active.
function stampLineTag() {
  const uri = getStampDataUri();
  if (!uri) return '';
  return `Official Stamp: <img src="${uri}" alt="GEHPM Official Stamp" style="width:110px;max-width:40%;height:auto;vertical-align:middle;" />`;
}

function applyStampWithFallback(html) {
  if (!html || typeof html !== 'string') return html;
  if (html.includes(STAMP_MARKER) || html.includes(STAMP_LINE_MARKER)) return applyStampMarkers(html);
  const tag = stampImgTag();
  if (!tag) return html;
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, () => `${tag}</body>`);
  return html + tag;
}

function stripStampMarkers(html) {
  if (!html || typeof html !== 'string') return html;
  return html.split(STAMP_MARKER).join('').split(STAMP_LINE_MARKER).join('');
}

function saveStamp(buffer, originalName, username) {
  if (!buffer || !buffer.length) throw new Error('Empty file');
  if (buffer.length > MAX_BYTES) throw new Error('Stamp exceeds the 5 MB limit');
  const type = detectType(buffer, originalName);
  if (!type) throw new Error('Stamp must be a PNG or JPEG image (transparent PNG preferred)');
  ensureDir();
  // Remove any previous stamp file (extension may differ on replace).
  for (const t of ALLOWED) {
    const p = stampPathFor(t.ext);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  fs.writeFileSync(stampPathFor(type.ext), buffer);
  const meta = {
    active: true,
    mimetype: type.mime,
    original_name: originalName || null,
    updated_at: new Date().toISOString(),
    updated_by: username || null,
  };
  writeMeta(meta);
  cache = { key: null, uri: '' };
  return getStatus();
}

function setStampActive(active, username) {
  const found = resolveStampFile();
  if (!found) throw new Error('No stamp uploaded yet');
  const meta = { ...readMeta(), active: active !== false };
  if (username) meta.updated_by = username;
  meta.updated_at = new Date().toISOString();
  writeMeta(meta);
  return getStatus();
}

function removeStamp() {
  for (const t of ALLOWED) {
    const p = stampPathFor(t.ext);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  if (fs.existsSync(META_FILE)) fs.unlinkSync(META_FILE);
  cache = { key: null, uri: '' };
  return getStatus();
}

module.exports = {
  STAMP_MARKER,
  STAMP_LINE_MARKER,
  getStatus,
  getStampDataUri,
  stampImgTag,
  stampLineTag,
  applyStampMarkers,
  applyStampWithFallback,
  stripStampMarkers,
  saveStamp,
  setStampActive,
  removeStamp,
};
