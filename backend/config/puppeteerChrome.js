/**
 * Resolve a Chromium binary for whatsapp-web.js on Windows and other OSes.
 */
const fs = require('fs');
const path = require('path');

function fileExists(p) {
  try {
    return Boolean(p && fs.existsSync(p));
  } catch {
    return false;
  }
}

function findChromeExecutable() {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fileExists(fromEnv)) return fromEnv;

  try {
    const puppeteer = require('puppeteer');
    const bundled = puppeteer.executablePath();
    if (fileExists(bundled)) return bundled;
  } catch (err) {
    console.warn('[WhatsApp Gateway] puppeteer.executablePath:', err.message);
  }

  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    const candidates = [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    for (const candidate of candidates) {
      if (fileExists(candidate)) return candidate;
    }
  }

  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const candidate of candidates) {
      if (fileExists(candidate)) return candidate;
    }
  }

  if (process.platform === 'linux') {
    const candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ];
    for (const candidate of candidates) {
      if (fileExists(candidate)) return candidate;
    }
  }

  return null;
}

function getPuppeteerLaunchOptions() {
  const executablePath = findChromeExecutable();
  const opts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-extensions',
      '--disable-features=DialMediaRouteProvider',
    ],
  };
  if (executablePath) {
    opts.executablePath = executablePath;
    console.log(`[WhatsApp Gateway] Using browser: ${executablePath}`);
  } else {
    console.warn(
      '[WhatsApp Gateway] No Chrome/Edge found. Install Google Chrome or run: npx puppeteer browsers install chrome'
    );
  }
  return opts;
}

module.exports = { findChromeExecutable, getPuppeteerLaunchOptions };
