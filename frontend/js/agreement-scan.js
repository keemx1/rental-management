/**
 * Signed-agreement scan pipeline (client side).
 *
 * Scanned pages (JPG/PNG photos) are downscaled + JPEG-compressed, then
 * merged into a single small PDF — typically a few hundred KB total.
 * Native PDFs pass through unchanged (server enforces the 12 MB cap).
 */

const MAX_EDGE = 1600;
const START_QUALITY = 0.72;
const MIN_QUALITY = 0.45;
const MAX_PAGE_BYTES = 700 * 1024;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

function drawScaled(img, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve({ blob, w, h }) : reject(new Error('Compression failed'))),
      'image/jpeg',
      quality
    );
  });
}

async function compressImage(file) {
  const img = await loadImage(file);
  let edge = MAX_EDGE;
  let quality = START_QUALITY;
  for (let i = 0; i < 5; i++) {
    const out = await drawScaled(img, edge, quality);
    if (out.blob.size <= MAX_PAGE_BYTES || (edge <= 900 && quality <= MIN_QUALITY)) return out;
    if (quality > MIN_QUALITY) quality = Math.max(MIN_QUALITY, quality - 0.1);
    else edge = Math.max(900, Math.round(edge * 0.8));
  }
  return drawScaled(img, 900, MIN_QUALITY);
}

// Minimal valid PDF writer: one A4 page per JPEG image. No dependencies.
async function imagesToPdf(pages) {
  const bufs = [];
  for (const p of pages) {
    bufs.push(new Uint8Array(await p.blob.arrayBuffer()));
  }
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [0];
  const push = (chunk) => {
    parts.push(chunk);
    offsets.push(offsets[offsets.length - 1] + chunk.length);
  };
  const PAGE_W = 595;
  const PAGE_H = 842;
  const MARGIN = 36;

  push(enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
  const n = bufs.length;
  // Reserve object numbers: 1 catalog, 2 pages, then per page (page, content, image)
  const pageObj = (i) => 3 + i * 3;
  const contentObj = (i) => 4 + i * 3;
  const imageObj = (i) => 5 + i * 3;
  const totalObjects = 2 + n * 3;

  push(enc.encode(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`));
  const kids = Array.from({ length: n }, (_, i) => `${pageObj(i)} 0 R`).join(' ');
  push(enc.encode(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`));

  for (let i = 0; i < n; i++) {
    const meta = pages[i].meta || {};
    const iw = meta.w || 800;
    const ih = meta.h || 1000;
    const scale = Math.min((PAGE_W - MARGIN * 2) / iw, (PAGE_H - MARGIN * 2) / ih, 1);
    const dw = Math.round(iw * scale);
    const dh = Math.round(ih * scale);
    const dx = Math.round((PAGE_W - dw) / 2);
    const dy = Math.round((PAGE_H - dh) / 2);
    const name = `/Im${i}`;
    push(enc.encode(
      `${pageObj(i)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /XObject << ${name} ${imageObj(i)} 0 R >> >> /Contents ${contentObj(i)} 0 R >>\nendobj\n`
    ));
    const content = `q\n${dw} 0 0 ${dh} ${dx} ${dy} cm\n${name} Do\nQ\n`;
    const contentBytes = enc.encode(content);
    push(enc.encode(`${contentObj(i)} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`));
    push(contentBytes);
    push(enc.encode(`\nendstream\nendobj\n`));
    push(enc.encode(
      `${imageObj(i)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} ` +
      `/ColorSpace /DeviceRGB /BitsPerColor 8 /BitsPerComponent 8 /Filter /DCTDecode /Length ${bufs[i].length} >>\nstream\n`
    ));
    push(bufs[i]);
    push(enc.encode(`\nendstream\nendobj\n`));
  }

  const xrefPos = offsets[offsets.length - 1];
  let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= totalObjects; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  push(enc.encode(xref));
  push(enc.encode(
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
  ));
  return new Blob(parts, { type: 'application/pdf' });
}

/**
 * Prepare user-selected file(s) for agreement upload.
 * Images -> compressed single PDF. A lone PDF passes through (size-capped).
 * @returns {Promise<{blob: Blob, filename: string, approxKB: number}>}
 */
async function prepareAgreementFiles(fileList, baseName) {
  const files = [...(fileList || [])];
  if (!files.length) throw new Error('No file selected');
  const images = files.filter((f) => (f.type || '').startsWith('image/'));
  const pdfs = files.filter((f) => (f.type || '') === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
  if (images.length && !pdfs.length) {
    const pages = [];
    for (const f of images.slice(0, 20)) {
      const out = await compressImage(f);
      pages.push({ blob: out.blob, meta: { w: out.w, h: out.h } });
    }
    const pdf = await imagesToPdf(pages);
    return { blob: pdf, filename: `${baseName || 'agreement'}-signed.pdf`, approxKB: Math.round(pdf.size / 1024) };
  }
  if (pdfs.length === 1 && !images.length) {
    const f = pdfs[0];
    if (f.size > 12 * 1024 * 1024) throw new Error('PDF exceeds the 12 MB limit');
    return { blob: f, filename: f.name || `${baseName || 'agreement'}.pdf`, approxKB: Math.round(f.size / 1024) };
  }
  throw new Error('Select either scanned page photos (JPG/PNG) or a single PDF — not both mixed');
}

export { compressImage, imagesToPdf, prepareAgreementFiles };
