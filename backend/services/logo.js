const fs = require('fs');
const path = require('path');

const LOGO_DIR = path.join(__dirname, '../../img');
const LOGO_CANDIDATES = ['logo.png', 'logo.jpeg', 'logo.jpg', 'logo.JPG', 'logo.PNG', 'logo.JPEG'];

function resolveLogoPath() {
  for (const name of LOGO_CANDIDATES) {
    const p = path.join(LOGO_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getLogoExtension() {
  const p = resolveLogoPath();
  if (!p) return 'png';
  const ext = path.extname(p).replace('.', '').toLowerCase();
  return ext === 'jpg' ? 'jpeg' : ext;
}

function getLogoBase64() {
  const p = resolveLogoPath();
  if (!p) return '';
  return `data:image/${getLogoExtension()};base64,` + fs.readFileSync(p).toString('base64');
}

module.exports = { resolveLogoPath, getLogoExtension, getLogoBase64 };
