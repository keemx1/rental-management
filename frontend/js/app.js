import { api } from './api.js';
import { offlineDb } from './offline-db.js';
import { parseMpesaMessage as parseMpesaOffline, matchTenantsOffline } from './mpesa-parse.js';
import {
  initSyncEngine, syncNow, pullSnapshot, isOffline as syncIsOffline,
  queueOutboxOp, subscribe as subscribeSync, getStatus as getSyncStatus,
} from './sync-engine.js';
import {
  stampSession, clearSessionStamp, hasUsableOfflineSession,
  offlineSessionDaysLeft, requireOnline, OFFLINE_SESSION_DAYS,
} from './offline-session.js';
import { stagePhoto, stagedMediaFor, markMediaSynced } from './offline-media.js';
import { detectWaterAnomaly } from './water-anomaly.js';
import { prepareAgreementFiles } from './agreement-scan.js';

const GEHM_VERSION = 'v69';
try { console.log(`[GEHM] app ${GEHM_VERSION} loaded`); } catch (_) {}
try {
  const vEl = document.getElementById('gehm-version');
  if (vEl) vEl.textContent = `app ${GEHM_VERSION} · diagnostics`;
} catch (_) {}

// ─── Client diagnostics + error collector ────────────────────────────────
// Records recent JS errors so a failing device can report exactly what broke
// (open via the version stamp in the sidebar).
const _gehmErrors = [];
function _gehmNoteError(source, message) {
  try {
    _gehmErrors.push({ at: new Date().toISOString(), source, message: String(message || '').slice(0, 500) });
    if (_gehmErrors.length > 30) _gehmErrors.splice(0, _gehmErrors.length - 30);
  } catch (_) {}
}
window.addEventListener('error', (e) => _gehmNoteError('error', (e && e.message) || 'window.onerror'));
window.addEventListener('unhandledrejection', (e) => _gehmNoteError('promise', (e && e.reason && (e.reason.message || e.reason)) || 'unhandled rejection'));

// ─── Desktop PWA install ─────────────────────────────────────────────────
let _deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  try { e.preventDefault(); } catch (_) {}
  _deferredInstallPrompt = e;
  document.getElementById('btn-install-app')?.classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  _deferredInstallPrompt = null;
  document.getElementById('btn-install-app')?.classList.add('hidden');
  try { showToast('GEHPM installed — find it in your Start menu / apps.'); } catch (_) {}
});
async function installGehmApp() {
  if (!_deferredInstallPrompt) {
    try { showToast('Install is not offered here — open GEHPM via localhost or https, then retry.', 'error'); } catch (_) { alert('Install is not offered by this browser on this address.'); }
    return;
  }
  try {
    _deferredInstallPrompt.prompt();
    await _deferredInstallPrompt.userChoice.catch(() => {});
  } catch (_) {}
  _deferredInstallPrompt = null;
}

// ─── Diagnostics report ──────────────────────────────────────────────────
// Builds a plain-text report about THIS device (version, service worker,
// connectivity, per-view API reachability, recent JS errors) so support can
// see exactly why a menu shows blank. Opened via the version stamp.

async function probeEndpoint(path) {
  try {
    const headers = {};
    const token = api.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, { headers, cache: 'no-store' });
    return `${res.status} ${res.statusText || ''}`.trim();
  } catch (err) {
    return `NETWORK-FAIL (${String((err && err.message) || err).slice(0, 80)})`;
  }
}

async function collectDiagnostics() {
  // Reload counter: increments on every full page load in this tab session.
  // If this climbs on its own, something (SW churn / proxy-mutated files)
  // is reload-looping the tab — which alone explains flashing blank views.
  let loads = 1;
  try {
    loads = (Number(sessionStorage.getItem('gehm_loads') || 0) || 0) + 1;
    sessionStorage.setItem('gehm_loads', String(loads));
  } catch (_) {}
  const report = {
    page_loads_this_session: loads,
    app_version: GEHM_VERSION,
    origin: location.origin,
    pathname: location.pathname,
    user_agent: navigator.userAgent.slice(0, 120),
    online: navigator.onLine,
    has_token: !!api.getToken(),
    service_worker: 'unsupported',
    idb: {},
    probes: {},
    js_errors: _gehmErrors.slice(-15),
  };
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) report.service_worker = 'no registration';
      else {
        const active = reg.active ? reg.active.scriptURL : null;
        report.service_worker = `registered (scope=${reg.scope}, active=${active || 'none'}, waiting=${!!reg.waiting}, installing=${!!reg.installing})`;
      }
      if (navigator.serviceWorker.controller) {
        report.service_worker += ` | controller=${navigator.serviceWorker.controller.scriptURL}`;
      } else {
        report.service_worker += ' | controller=NONE (page not SW-controlled)';
      }
    }
  } catch (err) {
    report.service_worker = 'check failed: ' + String((err && err.message) || err).slice(0, 100);
  }
  try {
    await offlineDb.openDb();
    for (const s of ['tenants', 'houses', 'payments', 'outbox']) {
      try {
        const all = await offlineDb.getAll(s);
        report.idb[s] = (all || []).length;
      } catch (_) { report.idb[s] = 'ERR'; }
    }
  } catch (_) {
    report.idb = 'IndexedDB unavailable';
  }
  const endpoints = {
    'auth/me': '/api/auth/me',
    'invoice-register': '/api/invoice-register',
    'pending-overpayments': '/api/pending-overpayments',
    'deposit-refunds': '/api/deposit-refunds',
    documents: '/api/documents',
    archive: '/api/archive',
    'wa-templates': '/api/whatsapp/templates',
    'water-invoices': '/api/water-invoices',
  };
  for (const [name, url] of Object.entries(endpoints)) {
    report.probes[name] = await probeEndpoint(url);
  }
  // View state: for each menu view, is the section present, hidden, and
  // does it contain any text/rows? Distinguishes "empty data" from
  // "section never unhidden" from "section missing from DOM".
  report.views = {};
  try {
    const views = [...document.querySelectorAll('[data-view]')].map((el) => el.dataset.view);
    for (const v of views) {
      const sec = document.querySelector(`[data-view="${v}"]`);
      if (!sec) { report.views[v] = 'MISSING-FROM-DOM'; continue; }
      const hidden = sec.classList.contains('hidden');
      const textLen = ((sec.innerText || '').trim().length);
      const rows = sec.querySelectorAll('tbody tr').length;
      report.views[v] = `${hidden ? 'hidden' : 'VISIBLE'} text=${textLen} rows=${rows}`;
    }
  } catch (err) {
    report.views = 'check failed: ' + String((err && err.message) || err).slice(0, 100);
  }
  // Styling sanity: blank-white pages often mean CSS failed to apply.
  try {
    const probe = document.createElement('div');
    probe.className = 'hidden';
    probe.style.display = '';
    document.body.appendChild(probe);
    const hiddenWorks = getComputedStyle(probe).display === 'none';
    probe.remove();
    report.css = `body_bg=${getComputedStyle(document.body).backgroundColor} hidden_class_works=${hiddenWorks} tailwind=${typeof window.tailwind !== 'undefined' ? 'yes' : 'NO'} viewport=${window.innerWidth}x${window.innerHeight}`;
  } catch (err) {
    report.css = 'check failed: ' + String((err && err.message) || err).slice(0, 100);
  }
  // Which view does the app THINK is active + recent showView calls.
  // If a menu click never appears here, the click never reached showView.
  try {
    if (window.GEHM_DEBUG) {
      report.current_view = window.GEHM_DEBUG.view();
      report.view_log = window.GEHM_DEBUG.viewLog();
    }
  } catch (_) {}
  // Screen truth: what is ACTUALLY visible on screen right now (not just DOM).
  // Catches: all-sections-hidden, off-screen sections, white-on-white text,
  // and overlay elements covering the content.
  try {
    report.screen = {};
    const vis = [...document.querySelectorAll('[data-view]')].find((el) => !el.classList.contains('hidden'));
    if (!vis) {
      report.screen.visible_section = 'NONE — every view is hidden!';
    } else {
      const cs = getComputedStyle(vis);
      const r = vis.getBoundingClientRect();
      report.screen.visible_section = vis.dataset.view;
      report.screen.rect = `x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)}`;
      report.screen.style = `display=${cs.display} visibility=${cs.visibility} opacity=${cs.opacity}`;
      const cx = Math.round(window.innerWidth / 2);
      const cy = Math.round(window.innerHeight / 2);
      const top = document.elementFromPoint(cx, cy);
      if (top) {
        const cls = typeof top.className === 'string' ? top.className.split(/\s+/).slice(0, 4).join('.') : '';
        report.screen.center_top = `${top.tagName.toLowerCase()}${top.id ? '#' + top.id : ''}${cls ? '.' + cls : ''}`;
      } else {
        report.screen.center_top = 'none';
      }
      const cell = vis.querySelector('tbody td, td, p, h1, h2, h3, button, span');
      if (cell) {
        const ccs = getComputedStyle(cell);
        report.screen.sample_text = `${cell.tagName} color=${ccs.color} text=${(cell.innerText || '').trim().slice(0, 60)}`;
      }
      // Ancestor walk: a 0x0 section means a hidden ancestor — find it.
      const chain = [];
      let node = vis.parentElement;
      for (let i = 0; i < 6 && node && node !== document.body; i++) {
        const cs = getComputedStyle(node);
        const r = node.getBoundingClientRect();
        const cls = typeof node.className === 'string' ? node.className.split(/\s+/).slice(0, 4).join('.') : '';
        chain.push(`${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}${cls ? '.' + cls : ''} display=${cs.display} ${Math.round(r.width)}x${Math.round(r.height)}`);
        node = node.parentElement;
      }
      report.screen.ancestors = chain;
    }
    // Any fixed overlay that could be covering the content?
    const fixed = [...document.querySelectorAll('body *')].filter((el) => {
      if (!(el instanceof HTMLElement)) return false;
      const cs = getComputedStyle(el);
      return (cs.position === 'fixed' || cs.position === 'sticky') && cs.display !== 'none' && el.id !== 'gehm-sync-bar';
    }).slice(0, 12).map((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 3).join('.') : '';
      return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''} z=${cs.zIndex} ${Math.round(r.width)}x${Math.round(r.height)}`;
    });
    report.screen.fixed_layers = fixed;
  } catch (err) {
    report.screen = 'check failed: ' + String((err && err.message) || err).slice(0, 100);
  }
  return report;
}

function renderDiagnosticsReport(r) {
  const L = [];
  L.push(`GEHPM diagnostics — ${new Date().toISOString()}`);
  L.push(`app_version: ${r.app_version}`);
  L.push(`origin: ${r.origin}${r.pathname}`);
  L.push(`browser: ${r.user_agent}`);
  L.push(`online: ${r.online} | logged_in_token: ${r.has_token}`);
  L.push(`page_loads_this_session: ${r.page_loads_this_session ?? 'n/a'} (keeps climbing = tab is reload-looping)`);
  L.push(`service_worker: ${r.service_worker}`);
  L.push(`local_cache: ${typeof r.idb === 'string' ? r.idb : Object.entries(r.idb).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  L.push('api_probes:');
  for (const [k, v] of Object.entries(r.probes)) L.push(`  ${k}: ${v}`);
  L.push(`css: ${r.css || 'n/a'}`);
  if (r.screen && typeof r.screen === 'object') {
    L.push(`screen_visible: ${r.screen.visible_section || 'n/a'}`);
    if (r.screen.rect) L.push(`screen_rect: ${r.screen.rect}`);
    if (r.screen.style) L.push(`screen_style: ${r.screen.style}`);
    if (r.screen.center_top) L.push(`screen_center_top: ${r.screen.center_top}`);
    if (r.screen.sample_text) L.push(`screen_sample: ${r.screen.sample_text}`);
    if (Array.isArray(r.screen.ancestors)) {
      L.push('screen_ancestors (section -> body):');
      for (const a of r.screen.ancestors) L.push(`  ${a}`);
    }
    if (Array.isArray(r.screen.fixed_layers)) {
      L.push('fixed_layers:');
      for (const f of r.screen.fixed_layers) L.push(`  ${f}`);
    }
  } else if (r.screen) {
    L.push(`screen: ${r.screen}`);
  }
  L.push(`current_view: ${r.current_view || 'n/a'}`);
  L.push('recent_view_clicks (latest last):');
  if (Array.isArray(r.view_log) && r.view_log.length) {
    for (const v of r.view_log.slice(-10)) L.push(`  [${v.at}] -> ${v.view}`);
  } else {
    L.push('  (none recorded)');
  }
  L.push('views (open a blank menu FIRST, then open this report):');
  if (r.views && typeof r.views === 'object') {
    for (const [k, v] of Object.entries(r.views)) L.push(`  ${k}: ${v}`);
  } else {
    L.push(`  ${r.views}`);
  }
  L.push(`js_errors (${(r.js_errors || []).length}):`);
  for (const e of (r.js_errors || [])) L.push(`  [${e.at}] ${e.source}: ${e.message}`);
  return L.join('\n');
}

async function openDiagnostics() {
  const modal = document.getElementById('diagnostics-modal');
  const pre = document.getElementById('diagnostics-report');
  if (!modal || !pre) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  pre.textContent = 'Collecting…';
  try {
    const report = await collectDiagnostics();
    pre.textContent = renderDiagnosticsReport(report);
    modal.dataset.report = pre.textContent;
  } catch (err) {
    pre.textContent = 'Failed to collect diagnostics: ' + ((err && err.message) || err);
  }
}

function closeDiagnostics() {
  const modal = document.getElementById('diagnostics-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

async function copyDiagnostics() {
  const txt = document.getElementById('diagnostics-modal')?.dataset.report || document.getElementById('diagnostics-report')?.textContent || '';
  try {
    await navigator.clipboard.writeText(txt);
    showToast('Diagnostics copied — paste it back to support.');
  } catch (_) {
    alert('Copy failed. Long-press / select the text and copy manually.');
  }
}

// Self-test: programmatically switch through the suspect menus and record
// whether each view actually becomes visible. Distinguishes broken physical
// clicks (this passes) from a broken view switch (this fails the same way).
async function testNavSwitching() {
  const btn = document.getElementById('btn-navtest');
  const pre = document.getElementById('diagnostics-report');
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  const views = ['invoice-register', 'mgmt-expenses-report', 'deposit-refunds', 'reports',
    'monthly-reports', 'documents', 'archive', 'pending-overpayments', 'work-orders', 'users'];
  const lines = [];
  lines.push('');
  lines.push('menu_switch_test (programmatic showView per menu):');
  let original = 'dashboard';
  try { original = (window.GEHM_DEBUG && window.GEHM_DEBUG.view()) || 'dashboard'; } catch (_) {}
  for (const v of views) {
    try {
      showView(v);
      await new Promise((r) => setTimeout(r, 900));
      const sec = document.querySelector(`[data-view="${v}"]`);
      const visible = sec ? !sec.classList.contains('hidden') : false;
      const textLen = sec ? (sec.innerText || '').trim().length : 0;
      let current = '?';
      try { current = window.GEHM_DEBUG.view(); } catch (_) {}
      lines.push(`  ${v}: section_${visible ? 'VISIBLE' : 'HIDDEN'} current=${current} text=${textLen} ${visible && textLen > 100 ? 'OK' : 'FAIL'}`);
    } catch (err) {
      lines.push(`  ${v}: ERROR ${String((err && err.message) || err).slice(0, 120)}`);
    }
  }
  try { showView(original); } catch (_) {}
  lines.push(`  (restored to ${original})`);
  if (pre) {
    pre.textContent += '\n' + lines.join('\n');
    const modal = document.getElementById('diagnostics-modal');
    if (modal) modal.dataset.report = pre.textContent;
  }
  if (btn) { btn.disabled = false; btn.textContent = '▶ Test menu switching'; }
}

document.getElementById('gehm-version')?.addEventListener('click', openDiagnostics);
document.getElementById('btn-install-app')?.addEventListener('click', installGehmApp);
document.getElementById('btn-diagnostics-close')?.addEventListener('click', closeDiagnostics);
document.getElementById('btn-diagnostics-ok')?.addEventListener('click', closeDiagnostics);
document.getElementById('btn-diagnostics-copy')?.addEventListener('click', copyDiagnostics);
document.getElementById('btn-navtest')?.addEventListener('click', testNavSwitching);

let currentView = 'login';
let metricsPoll = null;
let waPoll = null;
let _waPolling = null;
let _waQrPolling = null;
const _gehmViewLog = [];
let housesCache = [];
let templatesCache = [];
let activeHouseId = null;
let activeTenantCode = null;
let houseEditReturnView = 'houses';

function formatKes(val) {
  return 'KES ' + Number(val || 0).toLocaleString();
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg, type) {
  const el = document.createElement('div');
  el.className = `fixed top-4 right-4 z-[9999] px-4 py-3 rounded-lg shadow-lg text-sm font-semibold transition-opacity duration-300 ${type === 'error' ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, 2500);
  setTimeout(() => { el.remove(); }, 3000);
}

function debounce(fn, ms) {
  let t;
  return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}

// ─── Offline-first (Phase 1): sync banner, badges, helpers ────────────────
// Statuses shown to agents:
//   🟢 SYNCED — saved on the main server
//   🟠 PENDING SYNC — saved on this device, waiting for internet
//   🔄 SYNCING — currently uploading to the server
//   🔴 SYNC FAILED — could not synchronize; retry required

function isNetworkError(err) {
  if (!err) return false;
  if (err.status === 0 || err.status === undefined) return true;
  return /network|fetch|failed to fetch|load failed|abort|offline|timeout/i.test(String(err.message || ''));
}

function effectiveOffline() {
  try {
    if (syncIsOffline()) return true;
  } catch (_) {}
  return !navigator.onLine;
}

function ensureSyncBanner() {
  let bar = document.getElementById('gehm-sync-bar');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'gehm-sync-bar';
  bar.style.cssText = 'position:sticky;top:0;z-index:9000;display:none;align-items:center;gap:10px;padding:8px 14px;font-size:13px;font-weight:600;';
  document.body.prepend(bar);
  return bar;
}

function renderSyncBanner(status) {
  const bar = ensureSyncBanner();
  const s = status || getSyncStatus();
  const parts = [];
  let bg = '#065f46'; // green — synced & online
  let fg = '#ecfdf5';

  if (!s.online) {
    bg = '#7c2d12'; fg = '#ffedd5';
    parts.push('📴 OFFLINE — working from last synced data');
  } else if (s.syncState === 'syncing') {
    bg = '#1e40af'; fg = '#dbeafe';
    parts.push('🔄 SYNCING…');
  } else if (s.syncState === 'failed') {
    bg = '#991b1b'; fg = '#fee2e2';
    parts.push('🔴 SYNC FAILED — retry required');
  } else if (s.pending > 0) {
    bg = '#9a3412'; fg = '#ffedd5';
    parts.push(`🟠 ${s.pending} PENDING SYNC`);
  } else {
    parts.push('🟢 SYNCED');
  }
  if (s.lastPull) {
    try {
      parts.push(`<span style="font-weight:400;opacity:.85">Last sync: ${new Date(s.lastPull).toLocaleString()}</span>`);
    } catch (_) {}
  }
  bar.style.background = bg;
  bar.style.color = fg;
  bar.style.display = 'flex';
  bar.innerHTML = `<span>${parts.join(' &nbsp;·&nbsp; ')}</span>
    <span style="flex:1"></span>
    ${s.online && s.pending >= 0 ? `<button id="gehm-sync-now" style="background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.4);border-radius:6px;padding:3px 12px;color:inherit;font-weight:700;cursor:pointer">Sync now</button>` : ''}`;
  const btn = document.getElementById('gehm-sync-now');
  if (btn) btn.onclick = () => { btn.disabled = true; syncNow().catch(() => {}).finally(() => { btn.disabled = false; }); };
}

/** Badge HTML for an offline-cached payment row. */
function offlineSyncBadge(sync) {
  if (sync === 'pending') return `<span class="status-badge badge-pending" title="Saved on this device. Will upload automatically when internet returns."><span class="status-dot"></span>🟠 PENDING SYNC</span>`;
  if (sync === 'failed') return `<span class="status-badge badge-suspended" title="Server rejected this upload. A manager can review it in Sync Conflicts."><span class="status-dot"></span>🔴 SYNC FAILED</span>`;
  if (sync === 'dismissed') return `<span class="status-badge" title="A manager reviewed this upload and kept the server record."><span class="status-dot"></span>⚪ DISMISSED</span>`;
  return `<span class="status-badge badge-active"><span class="status-dot"></span>🟢 SYNCED</span>`;
}

function offlinePaymentRow(p) {
  return `
      <tr style="opacity:.92">
        <td class="font-mono text-xs text-slate-500">—</td>
        <td class="text-white">${escapeHtml(p.tenant_name || '—')} <span class="text-slate-500 font-mono text-xs">${escapeHtml(p.tenant_code || '')}</span></td>
        <td class="font-mono text-green-400">KES ${Number(p.amount || 0).toLocaleString()}</td>
        <td class="font-mono text-xs">${p.mode ? `<span class="text-purple-400 text-[10px]">${escapeHtml(p.mode)}</span> ` : ''}${escapeHtml(p.mpesa_reference || '—')}</td>
        <td class="font-mono text-sm text-slate-400">${escapeHtml(p.payment_date || '—')}</td>
        <td>${offlineSyncBadge(p.sync)}<div class="text-[10px] text-slate-500 font-mono mt-1">Receipt: ${p.receipt === 'sent' ? 'sent' : 'PENDING WHATSAPP SEND'}</div></td>
        <td><span class="text-xs text-slate-500">Offline record</span></td>
      </tr>`;
}

let _offlineBooted = false;
let _swUpdateNotified = false;

/** Reveal the app once the session check has decided login vs dashboard. */
function finishBoot() {
  try { document.body.classList.add('boot-done'); } catch (_) {}
}

function bootOffline() {
  if (_offlineBooted) return;
  _offlineBooted = true;
  renderSyncBanner();
  subscribeSync(renderSyncBanner);
  // A new service worker took over: reload only when safe (no pending
  // uploads, no open modal), otherwise tell the agent an update is ready.
  // The SW itself never force-reloads tabs anymore.
  try {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange', async () => {
        if (_swUpdateNotified) return;
        _swUpdateNotified = true;
        let pending = 0;
        try { pending = await offlineDb.pendingCount(); } catch (_) {}
        const modalOpen = !!document.querySelector('.fixed.inset-0:not(.hidden)');
        if (pending === 0 && !modalOpen) {
          window.location.reload();
        } else {
          try { showToast('New GEHPM version ready — refresh when convenient.', 'error'); } catch (_) {}
        }
      });
    }
  } catch (_) {}
  initSyncEngine()
    .then(() => {
      renderSyncBanner();
      // Opportunistic snapshot refresh while online (after login too).
      if (!effectiveOffline()) pullSnapshot().catch(() => {});
    })
    .catch(() => renderSyncBanner());
}

function setTextEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function isAdmin() {
  return api.getUser()?.role === 'admin';
}

function showView(name) {
  try {
    _gehmViewLog.push({ at: new Date().toISOString(), view: name });
    if (_gehmViewLog.length > 20) _gehmViewLog.splice(0, _gehmViewLog.length - 20);
  } catch (_) {}
  currentView = name;
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.view !== name);
  });
  // Desktop sidebar: hide on login
  document.getElementById('sidebar')?.classList.toggle('hidden', name === 'login');
  // Login mode: collapse grid so login centers on full width
  document.querySelector('.app-shell')?.classList.toggle('login-mode', name === 'login');
  // Mobile header: hide on login
  document.getElementById('main-nav')?.classList.toggle('hidden', name === 'login');
  // Mobile drawer: also hide on login
  document.getElementById('nav-container')?.classList.toggle('hidden', name === 'login');
  // Active state on both desktop sidebar links and mobile nav links
  document.querySelectorAll('.nav-link, .sidebar-link').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === name);
  });
  window.scrollTo(0, 0);
  if (name === 'dashboard') loadDashboard();
  if (name === 'houses') loadHouses();
  if (name === 'tenants') loadTenants();
  if (name === 'payments') loadPayments();
  if (name === 'broadcasts') loadBroadcastCenter();
  if (name === 'whatsapp') {
    refreshWhatsappBeacon();
    waLoadStatus();
    waLoadSettings();
    waLoadMessages();
    waLoadTemplates();
    waStartPolling();
  } else if (name !== 'whatsapp') {
    waStopPolling();
    waStopQrPolling();
  }
  if (name === 'sms') {
    smsLoadStatus();
    smsLoadBalance();
    smsLoadMessages();
  }
  if (name === 'invoices') loadInvoicesCenter();
  if (name === 'work-orders') { loadWorkOrders(); loadInspections(); }
  if (name === 'documents') loadDocuments();
  if (name === 'invoice-register') loadInvoiceRegister();
  if (name === 'monthly-reports') loadMonthlyReports();
  if (name === 'mgmt-expenses-report') {
    document.getElementById('mer-month').value = new Date().toISOString().slice(0, 7);
    document.getElementById('mer-date-from').value = '';
    document.getElementById('mer-date-to').value = '';
    populatePropertyDropdowns();
  }
  if (name === 'archive') loadArchive();
  if (name === 'pending-overpayments') loadPendingOverpayments();
  if (name === 'deposit-refunds') loadDepositRefunds();
  if (name === 'future-tenancies') loadFutureTenancies();
  if (name === 'users') loadUsers();
  if (name === 'settings') { loadStampSettings(); loadSignatureSettings(); }
  if (name === 'sync-conflicts') loadConflicts();
  if (name === 'commissions') loadCommissions();
  if (name === 'reports') {
    document.getElementById('report-phone').value = '';
    refreshHouseOptions();
    loadReceiptMode();
  }
  if (name === 'house-dashboard') loadHouseDashboardPage(activeHouseId);
  if (name === 'tenant-dashboard') loadTenantDashboard(activeTenantCode);
}

function setHash(hash) {
  // Encode tenant/house identifiers so codes containing '/', spaces, etc.
  // survive the round trip through location.hash (parseRoute decodes).
  let out = String(hash || '');
  const m = out.match(/^#(tenant|house)\/(.+)$/);
  if (m) out = `#${m[1]}/${encodeURIComponent(m[2])}`;
  if (window.location.hash === out) return;
  window.location.hash = out;
}

function parseRoute() {
  const raw = (window.location.hash || '').replace(/^#/, '');
  if (!raw) return { view: null };
  // Take the FULL remainder (not just the next segment) so tenant codes
  // containing '/' (e.g. 102/104) resolve to the real tenant record.
  const head = raw.split('/')[0];
  const rest = raw.slice(head.length + 1);
  const decode = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
  if (head === 'house' && rest) return { view: 'house-dashboard', houseId: decode(rest) };
  if (head === 'tenant' && rest) return { view: 'tenant-dashboard', tenantCode: decode(rest) };
  return { view: null };
}

function applyRoute() {
  const route = parseRoute();
  if (route.view === 'house-dashboard') {
    activeHouseId = route.houseId;
    showView('house-dashboard');
    return true;
  }
  if (route.view === 'tenant-dashboard') {
    activeTenantCode = route.tenantCode;
    showView('tenant-dashboard');
    return true;
  }
  return false;
}

async function loadTenantDashboard(code) {
  if (!code) return;

  // Guardian / emergency contact line (name · ID · phone · relationship).
  function guardianDisplay(t) {
    if (!t) return '—';
    const parts = [t.guardian_name, t.guardian_id ? `ID ${t.guardian_id}` : '', t.guardian_phone, t.guardian_relationship ? `(${t.guardian_relationship})` : ''].filter(Boolean);
    return parts.length ? parts.join(' · ') : '—';
  }
  // Water charge (refundable deposit): amount / paid / balance / status.
  function waterPaidDisplay(t) {
    if (!t) return '—';
    const amt = Number(t.water_charge_amount || 0);
    if (!(amt > 0)) return '—';
    const paid = Number(t.water_charge_paid || 0);
    const bal = Math.max(0, amt - paid);
    const status = bal <= 0 ? 'PAID' : (paid > 0 ? 'PARTIALLY PAID' : 'UNPAID');
    return `KES ${paid.toLocaleString()} paid / KES ${bal.toLocaleString()} bal · ${status}`;
  }

  // ─── Signed tenancy agreements (private per-tenant Supabase storage) ───
  async function loadTenantAgreements(tenantCode) {
    const tbody = document.getElementById('td-agreements-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" class="text-center py-6 text-slate-500">Loading…</td></tr>';
    try {
      const { agreements } = await api.listAgreements(tenantCode);
      if (!agreements.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center py-6 text-slate-500">No signed agreement on file.</td></tr>';
        return;
      }
      const kb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
      const when = (ts) => { try { return new Date(ts).toLocaleDateString(); } catch (_) { return '—'; } };
      tbody.innerHTML = agreements.map((a) => `
        <tr>
          <td class="font-mono text-xs">${escapeHtml(a.filename || 'agreement.pdf')}</td>
          <td class="font-mono text-xs">${kb(Number(a.size_bytes || 0))}</td>
          <td class="text-xs text-slate-400">${when(a.created_at)}${a.uploaded_by ? ` · ${escapeHtml(a.uploaded_by)}` : ''}</td>
          <td class="text-right whitespace-nowrap">
            <button type="button" class="action-btn !py-1 !px-2 text-xs" data-ag-preview="${a.id}">Preview</button>
            <button type="button" class="action-btn action-btn-danger !py-1 !px-2 text-xs" data-ag-delete="${a.id}">Delete</button>
          </td>
        </tr>`).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-rose-400">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  // Reset fields to loading state
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText('td-title', 'Loading…');
  setText('td-subtitle', '');
  setText('td-info-name', '…');
  setText('td-info-code', '…');
  setText('td-info-phone', '…');
  setText('td-info-national-id', '…');
  setText('td-info-guardian', '…');
  setText('td-info-rent', '…');
  setText('td-info-due', '…');
  setText('td-info-water', '…');
  setText('td-house-name', '…');
  setText('td-house-paybill', '…');
  setText('td-house-units', '…');
  const tbody = document.getElementById('td-payments-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-slate-500">Loading…</td></tr>';

  // Signed tenancy agreements (private per-tenant storage)
  loadTenantAgreements(code).catch(() => {});

  // Payment arrangement (management-only internal control)
  loadTenantArrangements(code).catch(() => {});

  try {
    const { tenant, house, payments, totalPaid, pendingAmount, summary, maintenanceCharges } = await api.tenantProfile(code);
    const s = summary || {};

    // Header
    setText('td-title', `${tenant.name || tenant.tenant_code}`);
    setText('td-subtitle', `Unit ${tenant.tenant_code} — ${house ? house.house_name : tenant.property_name || '—'}`);

    // Tenant info
    setText('td-info-name', tenant.name || '—');
    setText('td-info-code', tenant.tenant_code || '—');
    setText('td-info-phone', tenant.phone_number || '—');
    setText('td-info-national-id', tenant.national_id || '—');
    setText('td-info-guardian', guardianDisplay(tenant));
    setText('td-info-rent', `KES ${Number(tenant.rent_amount || 0).toLocaleString()}`);

    // Format next rent due date dynamically — always 5th of next month
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 5);
    const day = nextMonth.getDate();
    const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
    setText('td-info-due', `${day}${suffix} ${monthNames[nextMonth.getMonth()]} ${nextMonth.getFullYear()}`);
    setText('td-info-movein', tenant.move_in_date || '—');
    setText('td-info-water', tenant.water_charge_amount ? `KES ${Number(tenant.water_charge_amount).toLocaleString()}` : '—');
    setText('td-info-water-paid', waterPaidDisplay(tenant));

    // House info
    setText('td-house-name', house ? house.house_name : '—');
    setText('td-house-paybill', house ? house.paybill_number : '—');
    setText('td-house-units', house ? house.total_units : '—');

    // Payment status bar
    const payStatus = s.payment_status || 'Not Paid';
    const payPct = s.payment_percent || 0;
    const balance = s.balance || 0;
    const rentAmt = s.rent_amount || 0;

    const statusEl = document.getElementById('td-payment-status-text');
    if (statusEl) statusEl.textContent = payStatus.toUpperCase();

    const bar = document.getElementById('td-payment-bar');
    if (bar) {
      let barColor = 'bg-red-500';
      if (payStatus === 'Fully Paid') barColor = 'bg-green-500';
      else if (payStatus === 'Overpaid') barColor = 'bg-cyan-400';
      else if (payStatus === 'Partial') barColor = 'bg-amber-400';
      bar.className = `h-2 rounded-full transition-all duration-500 ${barColor}`;
      bar.style.width = Math.min(payPct, 100) + '%';
    }

    const balanceEl = document.getElementById('td-balance-label');
    if (balanceEl) {
      balanceEl.textContent = balance > 0 ? `KES ${Number(balance).toLocaleString()}` : balance < 0 ? `KES ${Number(Math.abs(balance)).toLocaleString()} overpaid` : 'KES 0';
      balanceEl.className = balance > 0 ? 'font-mono font-bold text-xl text-red-400' : balance < 0 ? 'font-mono font-bold text-xl text-cyan-400' : 'font-mono font-bold text-xl text-green-400';
    }

    setText('td-paid-label', `KES ${totalPaid.toLocaleString()}`);
    setText('td-rent-label', `KES ${rentAmt.toLocaleString()}`);

    const arrears = s.arrears || 0;
    const arrearsRow = document.getElementById('td-arrears-row');
    if (arrearsRow) {
      if (arrears > 0) {
        arrearsRow.style.display = '';
        setText('td-arrears-label', `KES ${Number(arrears).toLocaleString()}`);
      } else {
        arrearsRow.style.display = 'none';
      }
    }

    const depositAmount = s.deposit_amount || 0;
    const depositPaid = s.deposit_paid || 0;
    const depositRow = document.getElementById('td-deposit-row');
    if (depositRow) {
      if (depositAmount > 0) {
        depositRow.style.display = '';
        setText('td-deposit-label', `KES ${Number(depositPaid).toLocaleString()} / KES ${Number(depositAmount).toLocaleString()}`);
        const toggleBtn = document.getElementById('td-deposit-toggle');
        if (toggleBtn) {
          const isPaid = depositPaid >= depositAmount;
          toggleBtn.textContent = isPaid ? 'PAID' : 'NOT PAID';
          toggleBtn.className = isPaid
            ? 'px-2 py-0.5 rounded text-xs font-mono cursor-pointer border border-green-500 bg-green-500/20 text-green-400 transition-all'
            : 'px-2 py-0.5 rounded text-xs font-mono cursor-pointer border border-amber-500 bg-amber-500/20 text-amber-400 transition-all';
          toggleBtn.onclick = async () => {
            toggleBtn.disabled = true;
            try {
              await api.toggleDeposit(code);
              loadTenantDashboard(code);
            } catch (err) {
              alert(err.message);
              toggleBtn.disabled = false;
            }
          };
        }
      } else {
        depositRow.style.display = 'none';
      }
    }

    // Garbage fee
    const garbageFeeAmount = s.garbage_fee_amount || 0;
    const garbageFeePaid = s.garbage_fee_paid || 0;
    const garbageFeeBalance = Math.max(0, garbageFeeAmount - garbageFeePaid);
    const garbageRow = document.getElementById('td-garbage-row');
    const garbageDetail = document.getElementById('td-garbage-detail');
    if (garbageRow) {
      if (garbageFeeAmount > 0) {
        garbageRow.style.display = '';
        if (garbageDetail) garbageDetail.style.display = '';
        setText('td-garbage-charged', `KES ${Number(garbageFeeAmount).toLocaleString()}`);
        setText('td-garbage-paid-label', `KES ${Number(garbageFeePaid).toLocaleString()}`);
        setText('td-garbage-balance', `KES ${Number(garbageFeeBalance).toLocaleString()}`);
        const garbageToggle = document.getElementById('td-garbage-toggle');
        if (garbageToggle) {
          const isPaid = garbageFeePaid >= garbageFeeAmount;
          garbageToggle.textContent = isPaid ? 'PAID' : 'NOT PAID';
          garbageToggle.className = isPaid
            ? 'px-2 py-0.5 rounded text-xs font-mono cursor-pointer border border-green-500 bg-green-500/20 text-green-400 transition-all'
            : 'px-2 py-0.5 rounded text-xs font-mono cursor-pointer border border-amber-500 bg-amber-500/20 text-amber-400 transition-all';
          garbageToggle.onclick = async () => {
            garbageToggle.disabled = true;
            try {
              await api.updateTenant(code, { garbage_fee_paid: isPaid ? 0 : garbageFeeAmount });
              loadTenantDashboard(code);
            } catch (err) {
              alert(err.message);
              garbageToggle.disabled = false;
            }
          };
        }
      } else {
        garbageRow.style.display = 'none';
        if (garbageDetail) garbageDetail.style.display = 'none';
      }
    }

    // Tenancy agreement fee
    const agreementCharge = Number(s.agreement_charge || 0);
    const agreementPaid = Number(s.agreement_paid || 0);
    const agreementOutstanding = Number(s.agreement_outstanding || 0);
    const agreementRow = document.getElementById('td-agreement-row');
    const agreementDetail = document.getElementById('td-agreement-detail');
    if (agreementRow) {
      if (agreementCharge > 0) {
        agreementRow.style.display = '';
        if (agreementDetail) agreementDetail.style.display = '';
        setText('td-agreement-charged', `KES ${Number(agreementCharge).toLocaleString()}`);
        setText('td-agreement-paid-label', `KES ${Number(agreementPaid).toLocaleString()}`);
        setText('td-agreement-balance', `KES ${Number(agreementOutstanding).toLocaleString()}`);
        const agreementToggle = document.getElementById('td-agreement-toggle');
        if (agreementToggle) {
          const isPaid = agreementOutstanding <= 0;
          agreementToggle.textContent = isPaid ? 'PAID' : 'NOT PAID';
          agreementToggle.className = isPaid
            ? 'px-2 py-0.5 rounded text-xs font-mono cursor-pointer border border-green-500 bg-green-500/20 text-green-400 transition-all'
            : 'px-2 py-0.5 rounded text-xs font-mono cursor-pointer border border-amber-500 bg-amber-500/20 text-amber-400 transition-all';
        }
      } else {
        agreementRow.style.display = 'none';
        if (agreementDetail) agreementDetail.style.display = 'none';
      }
    }

    // Tenant info — agreement fee
    const agreementChargeInfo = Number(tenant.agreement_charge || 0);
    const agreementPaidInfo = Number(tenant.agreement_paid || 0);
    const agreementOutstandingInfo = Number(tenant.agreement_outstanding || 0);
    if (agreementChargeInfo > 0) {
      setText('td-info-agreement', `KES ${Number(agreementChargeInfo).toLocaleString()} ${agreementOutstandingInfo > 0 ? `(Outstanding: KES ${agreementOutstandingInfo.toLocaleString()})` : '(Paid)'}`);
    } else {
      setText('td-info-agreement', '—');
    }

    // Credit balance and advance rent
    const creditBalance = Number(s.credit_balance || 0);
    const advanceRentBalance = Number(s.advance_rent_balance || 0);
    const advanceRentUntil = s.advance_rent_until || null;
    const creditRow = document.getElementById('td-credit-row');
    if (creditRow) {
      if (creditBalance > 0 || advanceRentBalance > 0) {
        creditRow.style.display = '';
        setText('td-credit-label', `KES ${Number(creditBalance).toLocaleString()}`);
        setText('td-advance-label', `KES ${Number(advanceRentBalance).toLocaleString()} ${advanceRentUntil ? `(until ${advanceRentUntil})` : ''}`);
        const applyBtn = document.getElementById('td-apply-credit-btn');
        if (applyBtn) {
          applyBtn.style.display = creditBalance > 0 ? '' : 'none';
          applyBtn.onclick = () => showApplyCreditModal(code, creditBalance);
        }
      } else {
        creditRow.style.display = 'none';
      }
    }

    // Metrics
    const statusBadgeEl = document.getElementById('td-metric-status');
    if (statusBadgeEl) statusBadgeEl.innerHTML = statusBadge(tenant.status);
    setText('td-metric-total-paid', `KES ${totalPaid.toLocaleString()}`);
    setText('td-metric-pending', `KES ${pendingAmount.toLocaleString()}`);
    setText('td-metric-payment-count', payments.length);

    // Payment history
    if (tbody) {
      if (!payments.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center py-8 text-slate-500">No payment records</td></tr>';
      } else {
        tbody.innerHTML = payments.map(p => `
          <tr>
            <td class="font-mono text-xs text-cyan-400">${escapeHtml(p.receipt_number || '—')}</td>
            <td class="font-mono text-green-400">KES ${Number(p.amount).toLocaleString()}</td>
            <td class="font-mono text-xs">${p.payment_mode ? `<span class="text-purple-400 text-[10px]">${escapeHtml(p.payment_mode)}</span> ` : ''}${escapeHtml(p.mpesa_reference || p.cheque_number || '—')}</td>
            <td class="text-slate-400 text-xs">${p.payment_date ? new Date(p.payment_date).toLocaleDateString() : '—'}</td>
            <td>${statusBadge(p.status)}</td>
            <td><div class="flex items-center gap-2">${p.status === 'Approved' ? `<button type="button" class="action-btn !py-1 !px-2 text-xs" data-td-view-receipt="${p.id}">Receipt</button><button type="button" class="action-btn !py-1 !px-2 text-xs" data-td-download-receipt="${p.id}">PDF</button>` : ''}<button type="button" class="action-btn action-btn-danger !py-1 !px-2 text-xs" data-td-delete-payment="${p.id}">Delete</button></div></td>
          </tr>`).join('');
      }
    }

    // Wire up Edit button
    document.getElementById('btn-td-edit')?.addEventListener('click', () => openTenantModal(tenant.tenant_code), { once: true });
    // Wire up Message button
    document.getElementById('btn-td-message')?.addEventListener('click', () => openMessageModal(tenant.tenant_code), { once: true });
    // Wire up Statement button
    document.getElementById('btn-td-statement')?.addEventListener('click', () => openStatementModal(tenant.tenant_code), { once: true });
    // Wire up Notice to Vacate button
    document.getElementById('btn-td-notice')?.addEventListener('click', async () => {
      const date = prompt('Notice to Vacate — date given by tenant? (YYYY-MM-DD, informational only; unit stays OCCUPIED until exit is completed)', new Date().toISOString().slice(0, 10));
      if (date == null) return;
      const reason = prompt('Reason (optional):', '') || null;
      try {
        await api.recordNoticeToVacate(tenant.tenant_code, { notice_date: date, reason });
        alert('Notice to Vacate recorded for ' + tenant.tenant_code + '.');
      } catch (err) {
        alert(err.message);
      }
    }, { once: true });
    // Wire up Exit Invoice button — navigate to Invoice Command Center
    document.getElementById('btn-td-exit-invoice')?.addEventListener('click', () => {
      // Navigate to Invoice Center → Exit Invoice
      setHash('invoices');
      showView('invoices');
      // Load invoices center and then trigger exit invoice for this tenant
      setTimeout(() => {
        showInvoiceType('exit');
        const search = document.getElementById('exit-tenant-search');
        if (search) {
          search.value = `${tenant.name} (${tenant.tenant_code})`;
          search.dispatchEvent(new Event('change'));
        }
      }, 200);
    }, { once: true });

    // Deposit-to-Rent Authorization
    document.getElementById('btn-td-deposit-rent')?.addEventListener('click', async () => {
      const currentMonth = new Date().toISOString().slice(0, 7);
      try {
        const { preview } = await api.getDepositPreview(tenant.tenant_code, currentMonth);
        if (!preview) return alert('Could not load deposit preview.');
        if (preview.outstanding_rent <= 0) return alert('This tenant has no outstanding rent for the current month.');
        if (preview.available_deposit <= 0) return alert('This tenant has no available deposit to apply.');

        // Populate the modal
        document.getElementById('dr-tenant-name').textContent = preview.tenant_name;
        document.getElementById('dr-unit').textContent = preview.unit_code;
        document.getElementById('dr-period').textContent = preview.billing_period;
        document.getElementById('dr-rent-due').textContent = money(preview.rent_due);
        document.getElementById('dr-already-paid').textContent = money(preview.payments_applied + preview.deposit_already_applied);
        document.getElementById('dr-outstanding').textContent = money(preview.outstanding_rent);
        document.getElementById('dr-deposit-avail').textContent = money(preview.available_deposit);
        document.getElementById('dr-amount').value = Math.min(preview.available_deposit, preview.outstanding_rent);
        document.getElementById('dr-amount').max = preview.max_can_apply;
        document.getElementById('dr-reason').value = '';
        document.getElementById('dr-hint').textContent = '';

        // Show write-off row if deposit doesn't fully cover
        const writeOffRow = document.getElementById('dr-writeoff-row');
        if (preview.available_deposit < preview.outstanding_rent) {
          writeOffRow.classList.remove('hidden');
          document.getElementById('dr-writeoff').value = preview.outstanding_rent - Math.min(preview.available_deposit, preview.outstanding_rent);
        } else {
          writeOffRow.classList.add('hidden');
          document.getElementById('dr-writeoff').value = '0';
        }

        // Store context for the authorize button
        document.getElementById('deposit-rent-modal').dataset.tenantCode = tenant.tenant_code;
        document.getElementById('deposit-rent-modal').dataset.billingPeriod = currentMonth;
        document.getElementById('deposit-rent-modal').classList.remove('hidden');
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }, { once: true });

    // Penalties
    loadTenantPenalties(tenant.tenant_code);

    // Maintenance / Repairs from Work Orders
    loadTenantMaintenanceCharges(tenant.tenant_code, maintenanceCharges || []);

    // Deposit Refund info (if exit invoice exists)
    loadTenantDepositRefund(tenant.tenant_code);

    const addPenaltyBtn = document.getElementById('btn-td-add-penalty');
    if (addPenaltyBtn) {
      addPenaltyBtn.onclick = async () => {
        const catEl = document.getElementById('td-penalty-category');
        const descEl = document.getElementById('td-penalty-desc');
        const amtEl = document.getElementById('td-penalty-amount');
        const category = catEl?.value || 'penalty';
        const desc = (descEl?.value || '').trim();
        const amt = Number(amtEl?.value || 0);
        if (!desc || amt <= 0) return alert('Enter description and a valid amount');
        addPenaltyBtn.disabled = true;
        try {
          await api.createPenalty({ tenant_code: tenant.tenant_code, description: desc, amount: amt, category });
          descEl.value = '';
          amtEl.value = '';
          loadTenantPenalties(tenant.tenant_code);
        } catch (err) {
          alert(err.message);
        } finally {
          addPenaltyBtn.disabled = false;
        }
      };
    }

  } catch (err) {
    setText('td-title', 'Error loading tenant');
    setText('td-subtitle', err.message);
    if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="text-center py-8 text-rose-400">${escapeHtml(err.message)}</td></tr>`;
  }
}

function loadTenantMaintenanceCharges(tenantCode, charges) {
  const tbody = document.getElementById('td-maintenance-tbody');
  if (!tbody) return;
  const outstandingEl = document.getElementById('td-maintenance-outstanding');

  if (!charges || !charges.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-slate-500 py-4">No maintenance issues recorded.</td></tr>';
    if (outstandingEl) outstandingEl.textContent = 'KES 0';
    return;
  }

  let outstanding = 0;
  tbody.innerHTML = charges.map(mc => {
    const cost = Number(mc.total_cost || 0);
    const isPaid = mc.recovery_status === 'Paid';
    if (!isPaid && mc.responsible_party && mc.responsible_party.toLowerCase().includes('tenant')) {
      outstanding += cost - Number(mc.amount_recovered || 0);
    }
    const statusClass = isPaid ? 'text-green-400' : (mc.recovery_status === 'Pending' ? 'text-amber-400' : 'text-slate-400');
    return `<tr>
      <td class="font-mono text-xs">${escapeHtml(mc.wo_number_ref || mc.wo_number || '—')}</td>
      <td>${mc.issue_no || '—'}</td>
      <td>${escapeHtml(mc.problem || '—')}</td>
      <td>${escapeHtml(mc.responsible_party || '—')}</td>
      <td class="font-mono text-right">${money(cost)}</td>
      <td class="${statusClass}">${escapeHtml(mc.recovery_status || mc.status || '—')}</td>
    </tr>`;
  }).join('');

  if (outstandingEl) outstandingEl.textContent = money(outstanding);
}

async function loadTenantDepositRefund(tenantCode) {
  const section = document.getElementById('td-deposit-refund-section');
  if (!section) return;
  try {
    const { refunds } = await api.listDepositRefunds({ tenant: tenantCode, sort: 'newest' });
    const refund = refunds.find(r => r.tenant_code === tenantCode);
    if (!refund) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    setTextEl('td-dr-deposit', formatKes(refund.deposit_paid));
    setTextEl('td-dr-deductions', formatKes(refund.deductions_total));
    setTextEl('td-dr-refundable', formatKes(refund.refundable_amount));
    const statusMap = { pending: 'Pending', due_soon: 'Due Soon', due_today: 'Due Today', overdue: 'Overdue', refunded: 'Refunded', partially_refunded: 'Partially Refunded', no_refund_due: 'No Refund Due' };
    const statusEl = document.getElementById('td-dr-status');
    statusEl.textContent = statusMap[refund.refund_status] || refund.refund_status;
    statusEl.className = 'font-bold ' + (refund.refund_status === 'refunded' ? 'text-green-400' : refund.refund_status === 'overdue' ? 'text-rose-400' : 'text-amber-400');
    setTextEl('td-dr-due', fmtDate(refund.refund_due_date));
    setTextEl('td-dr-countdown', getDrCountdown(refund).replace(/<[^>]+>/g, ''));
    document.getElementById('btn-td-view-refund').onclick = () => {
      showView('deposit-refunds');
      setTimeout(() => openDrDetail(refund.id), 300);
    };
  } catch (_) { section.classList.add('hidden'); }
}

async function loadTenantPenalties(tenantCode) {
  const tbody = document.getElementById('td-penalties-tbody');
  if (!tbody) return;
  try {
    const { penalties } = await api.listPenalties(tenantCode);
    if (!penalties.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-slate-500">No penalties</td></tr>';
      return;
    }
    const catLabel = (c) => ({ penalty: 'Penalty', maintenance: 'Maintenance', other: 'Other' }[c] || 'Penalty');
    tbody.innerHTML = penalties.map(p => `
      <tr>
        <td class="font-mono text-xs text-cyan-400">${escapeHtml(p.invoice_number || '—')}</td>
        <td class="text-slate-400 text-xs">${catLabel(p.category)}</td>
        <td class="text-slate-300">${escapeHtml(p.description)}</td>
        <td class="font-mono text-rose-400">KES ${Number(p.amount).toLocaleString()}</td>
        <td class="text-slate-400 text-xs">${p.invoice_date ? new Date(p.invoice_date).toLocaleDateString() : '—'}</td>
        <td>${statusBadge(p.status)}</td>
        <td>
          ${p.status === 'Pending'
            ? `<button type="button" class="action-btn action-btn-success !py-1 !px-2 text-xs" data-td-pay-penalty="${p.id}">Mark Paid</button>
               <button type="button" class="action-btn action-btn-danger !py-1 !px-2 text-xs" data-td-delete-penalty="${p.id}">Delete</button>`
            : `<span class="text-green-400 text-xs font-mono">Paid ${p.paid_date ? new Date(p.paid_date).toLocaleDateString() : ''}</span>`}
        </td>
      </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-rose-400">${escapeHtml(err.message)}</td></tr>`;
  }
}

function showOverpaymentPrompt(result) {
  const modal = document.getElementById('overpayment-modal');
  if (!modal) return;
  document.getElementById('overpayment-amount').textContent = formatKes(result.overpayment);
  document.getElementById('overpayment-tenant-id').value = result.tenant?.id || '';
  document.getElementById('overpayment-payment-id').value = result.payment_id || result.payment?.id || '';
  document.getElementById('overpayment-value').value = result.overpayment;
  document.getElementById('overpayment-hint').textContent = '';
  modal.style.display = 'flex';
  modal.dataset.tenantCode = result.tenant?.tenant_code || '';
}

document.getElementById('btn-overpayment-advance')?.addEventListener('click', async () => {
  const modal = document.getElementById('overpayment-modal');
  const tenantId = document.getElementById('overpayment-tenant-id').value;
  const paymentId = document.getElementById('overpayment-payment-id').value;
  const overpayment = Number(document.getElementById('overpayment-value').value);
  const tenantCode = modal.dataset.tenantCode || '';
  modal.style.display = 'none';
  await openAdvanceMonthsModal(tenantId, paymentId, overpayment, tenantCode);
});

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function monthPrefix(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function openAdvanceMonthsModal(tenantId, paymentId, overpayment, tenantCode, pendingId) {
  const modal = document.getElementById('advance-months-modal');
  const hint = document.getElementById('advance-months-hint');
  if (!modal) return;

  document.getElementById('advance-months-tenant-id').value = tenantId;
  document.getElementById('advance-months-payment-id').value = paymentId;
  document.getElementById('advance-months-pending-id').value = pendingId || '';
  document.getElementById('advance-months-overpayment').value = overpayment;
  document.getElementById('advance-months-amount').textContent = formatKes(overpayment);
  hint.textContent = '';

  let rentAmount = 0;
  let rentPaidThisMonth = 0;
  try {
    const t = await api.tenant(tenantId);
    rentAmount = Number(t?.tenant?.rent_amount || 0);
    rentPaidThisMonth = Number(t?.tenant?.rent_paid_this_month || 0);
  } catch (_) { /* ignore */ }
  modal.dataset.rentAmount = rentAmount;
  modal.dataset.rentPaidThisMonth = rentPaidThisMonth;
  modal.dataset.overpayment = overpayment;

  const now = new Date();
  const firstMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const options = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(firstMonth.getFullYear(), firstMonth.getMonth() + i, 1);
    options.push({ prefix: monthPrefix(d), label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}` });
  }

  // Default selection: the consecutive future months the overpayment covers.
  const checked = new Set();
  if (rentAmount > 0 && overpayment > 0) {
    let remaining = overpayment;
    let idx = 0;
    while (remaining > 0 && idx < options.length) {
      checked.add(options[idx].prefix);
      remaining -= Math.min(rentAmount, remaining);
      idx++;
    }
  }

  document.getElementById('advance-months-list').innerHTML = options
    .map((o) => {
      const isChecked = checked.has(o.prefix);
      return `<label class="flex items-center gap-2 px-2 py-1.5 rounded border border-slate-700 bg-slate-900 cursor-pointer select-none text-sm ${isChecked ? 'border-green-600' : ''}" data-prefix="${o.prefix}">
        <input type="checkbox" value="${o.prefix}" ${isChecked ? 'checked' : ''} class="advance-month-check accent-green-500" />
        <span class="font-mono text-slate-200">${o.label}</span>
      </label>`;
    })
    .join('');

  renderAdvanceCoverage();
  modal.style.display = 'flex';
}

function ordinalDay(d) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = d % 100;
  return d + (s[(v - 20) % 10] || s[v] || s[0]);
}

function renderAdvanceCoverage() {
  const el = document.getElementById('advance-months-coverage');
  const modal = document.getElementById('advance-months-modal');
  if (!el || !modal) return;
  const rentAmount = Number(modal.dataset.rentAmount || 0);
  const rentPaidThisMonth = Number(modal.dataset.rentPaidThisMonth || 0);
  const overpayment = Number(modal.dataset.overpayment || 0);
  const prefixes = Array.from(document.querySelectorAll('#advance-months-list .advance-month-check:checked'))
    .map((cb) => cb.value)
    .sort();
  if (rentAmount <= 0 || overpayment <= 0 || !prefixes.length) {
    el.textContent = '';
    el.style.display = 'none';
    return;
  }

  const remainingThisMonth = Math.max(0, rentAmount - rentPaidThisMonth);
  let remaining = overpayment - remainingThisMonth;
  if (remaining < 0) remaining = 0;

  let endDate = null;
  let coveredMonths = 0;
  for (const p of prefixes) {
    if (remaining <= 0) break;
    const [y, m] = p.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const settle = Math.min(rentAmount, remaining);
    coveredMonths++;
    if (settle >= rentAmount) {
      endDate = new Date(y, m - 1, daysInMonth);
    } else {
      const coveredDays = Math.ceil((settle / rentAmount) * daysInMonth);
      endDate = new Date(y, m - 1, Math.min(coveredDays, daysInMonth));
    }
    remaining -= settle;
  }

  el.style.display = '';
  if (endDate) {
    const untilStr = `${ordinalDay(endDate.getDate())} ${MONTH_NAMES[endDate.getMonth()]} ${endDate.getFullYear()}`;
    el.textContent = `Advance rent covers ${coveredMonths} month(s) and is paid up to ${untilStr}.`;
  } else {
    el.textContent = 'Advance rent amount cannot be fully placed into the selected month(s); the remainder stays as advance balance.';
  }
}

document.getElementById('advance-months-list')?.addEventListener('change', (e) => {
  if (e.target.classList.contains('advance-month-check')) {
    const label = e.target.closest('label[data-prefix]');
    if (label) label.classList.toggle('border-green-600', e.target.checked);
    renderAdvanceCoverage();
  }
});

document.getElementById('btn-advance-months-confirm')?.addEventListener('click', async () => {
  const hint = document.getElementById('advance-months-hint');
  const modal = document.getElementById('advance-months-modal');
  const tenantId = document.getElementById('advance-months-tenant-id').value;
  const paymentId = document.getElementById('advance-months-payment-id').value;
  const overpayment = Number(document.getElementById('advance-months-overpayment').value);
  const months = Array.from(document.querySelectorAll('#advance-months-list .advance-month-check:checked'))
    .map((cb) => cb.value)
    .sort();
  if (!months.length) {
    hint.textContent = 'Select at least one future month.';
    return;
  }
  hint.textContent = 'Allocating…';
  try {
    const pendingId = document.getElementById('advance-months-pending-id').value;
    let result;
    if (pendingId) {
      result = await api.resolvePendingOverpayment(pendingId, { choice: 'advance_rent', months });
    } else {
      result = await api.resolveOverpayment(tenantId, {
        payment_id: paymentId,
        overpayment,
        choice: 'advance_rent',
        months,
      });
    }
    modal.style.display = 'none';
    loadPayments();
    loadDashboard();
    if (pendingId) loadPendingOverpayments();
    const tenantCode = result.tenant?.tenant_code || '';
    if (tenantCode) loadTenantDashboard(tenantCode);
    const pmHint = document.getElementById('payment-message-hint');
    const pmApproveBtn = document.getElementById('btn-approve-from-message');
    if (pmHint) pmHint.textContent = 'Overpayment resolved successfully.';
    if (pmApproveBtn) pmApproveBtn.disabled = false;
    showOverpaymentReview(result.messageBody, tenantId, result.whatsapp);
  } catch (err) {
    hint.textContent = err.message;
  }
});

// Deposit-to-Rent modal handlers
document.getElementById('btn-dr-cancel')?.addEventListener('click', () => {
  document.getElementById('deposit-rent-modal').classList.add('hidden');
});

document.getElementById('btn-dr-authorize')?.addEventListener('click', async () => {
  const modal = document.getElementById('deposit-rent-modal');
  const tenantCode = modal.dataset.tenantCode;
  const billingPeriod = modal.dataset.billingPeriod;
  const amount = Number(document.getElementById('dr-amount').value);
  const writeOff = Number(document.getElementById('dr-writeoff').value) || 0;
  const reason = document.getElementById('dr-reason').value.trim() || null;
  const hint = document.getElementById('dr-hint');
  const btn = document.getElementById('btn-dr-authorize');

  if (!amount || amount <= 0) { hint.textContent = 'Enter a valid amount.'; return; }

  if (!confirm(`Authorize KES ${amount.toLocaleString()} from deposit for ${billingPeriod} rent?`)) return;

  btn.disabled = true;
  hint.textContent = 'Processing...';
  try {
    await api.applyDepositToRent(tenantCode, {
      amount, billing_period: billingPeriod, reason, write_off_amount: writeOff,
    });
    modal.classList.add('hidden');
    alert('Deposit applied successfully. Tenant balance updated.');
    // Refresh tenant dashboard
    if (typeof loadTenantDashboard === 'function') loadTenantDashboard(tenantCode);
    loadDashboard();
  } catch (err) {
    hint.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-advance-months-back')?.addEventListener('click', () => {
  const monthsModal = document.getElementById('advance-months-modal');
  const pendingId = document.getElementById('advance-months-pending-id')?.value;
  if (pendingId) {
    monthsModal.style.display = 'none';
    document.getElementById('pending-op-resolve-modal').style.display = 'flex';
  } else {
    const overpaymentModal = document.getElementById('overpayment-modal');
    monthsModal.style.display = 'none';
    overpaymentModal.style.display = 'flex';
  }
});

document.getElementById('btn-overpayment-credit')?.addEventListener('click', async () => {
  const modal = document.getElementById('overpayment-modal');
  const tenantId = document.getElementById('overpayment-tenant-id').value;
  const paymentId = document.getElementById('overpayment-payment-id').value;
  const overpayment = document.getElementById('overpayment-value').value;
  const hint = document.getElementById('overpayment-hint');
  hint.textContent = 'Processing…';
  try {
    const result = await api.resolveOverpayment(tenantId, {
      payment_id: paymentId,
      overpayment,
      choice: 'credit_balance',
    });
    modal.style.display = 'none';
    loadPayments();
    loadDashboard();
    const tenantCode = result.tenant?.tenant_code || modal.dataset.tenantCode;
    if (tenantCode) loadTenantDashboard(tenantCode);
    const pmHint = document.getElementById('payment-message-hint');
    const pmApproveBtn = document.getElementById('btn-approve-from-message');
    if (pmHint) pmHint.textContent = 'Overpayment resolved successfully.';
    if (pmApproveBtn) pmApproveBtn.disabled = false;
    showOverpaymentReview(result.messageBody, tenantId, result.whatsapp);
  } catch (err) {
    hint.textContent = err.message;
  }
});

document.getElementById('btn-overpayment-skip')?.addEventListener('click', () => {
  const overpaymentModal = document.getElementById('overpayment-modal');
  const skipModal = document.getElementById('skip-overpayment-modal');
  document.getElementById('skip-overpayment-payment-id').value = document.getElementById('overpayment-payment-id').value;
  document.getElementById('skip-overpayment-tenant-id').value = document.getElementById('overpayment-tenant-id').value;
  document.getElementById('skip-overpayment-value').value = document.getElementById('overpayment-value').value;
  document.getElementById('skip-overpayment-hint').textContent = '';
  overpaymentModal.style.display = 'none';
  skipModal.style.display = 'flex';
});

document.getElementById('btn-skip-overpayment-back')?.addEventListener('click', () => {
  document.getElementById('skip-overpayment-modal').style.display = 'none';
  document.getElementById('overpayment-modal').style.display = 'flex';
});

document.getElementById('btn-skip-overpayment-confirm')?.addEventListener('click', async () => {
  const hint = document.getElementById('skip-overpayment-hint');
  const skipModal = document.getElementById('skip-overpayment-modal');
  const tenantId = document.getElementById('skip-overpayment-tenant-id').value;
  const paymentId = document.getElementById('skip-overpayment-payment-id').value;
  const overpayment = Number(document.getElementById('skip-overpayment-value').value);
  hint.textContent = 'Approving payment and recording pending overpayment…';
  try {
    const result = await api.skipOverpayment(paymentId, overpayment);
    skipModal.style.display = 'none';
    loadPayments();
    loadDashboard();
    const pmHint = document.getElementById('payment-message-hint');
    const pmApproveBtn = document.getElementById('btn-approve-from-message');
    if (pmHint) pmHint.textContent = 'Overpayment skipped. Pending overpayment recorded.';
    if (pmApproveBtn) pmApproveBtn.disabled = false;
    if (tenantId) {
      loadTenantDashboard(tenantId);
      showOverpaymentReview(result.messageBody, tenantId, result.whatsapp);
    }
  } catch (err) {
    hint.textContent = err.message;
  }
});

function showOverpaymentReview(messageBody, tenantId, whatsapp) {
  const modal = document.getElementById('overpayment-review-modal');
  if (!modal) return;
  document.getElementById('overpayment-review-body').textContent = messageBody || '(No message generated)';
  document.getElementById('overpayment-review-tenant-id').value = tenantId;
  const hint = document.getElementById('overpayment-review-hint');
  const sendBtn = document.getElementById('btn-overpayment-review-send');
  if (whatsapp) {
    if (whatsapp.status === 'Sent') {
      if (hint) {
        hint.textContent = '✓ Confirmation sent to tenant via WhatsApp automatically.';
        hint.style.color = '#16a34a';
      }
      // Already delivered — hide manual send to prevent duplicates.
      if (sendBtn) sendBtn.style.display = 'none';
    } else {
      if (hint) {
        hint.textContent = `⚠ Automatic send ${whatsapp.status || 'failed'}${whatsapp.failureReason ? ': ' + whatsapp.failureReason : ''}. Press Send to retry.`;
        hint.style.color = '#dc2626';
      }
      if (sendBtn) sendBtn.style.display = '';
    }
  } else {
    if (hint) { hint.textContent = ''; hint.style.color = ''; }
    if (sendBtn) sendBtn.style.display = '';
  }
  modal.style.display = 'flex';
}

document.getElementById('btn-overpayment-review-send')?.addEventListener('click', async () => {
  const modal = document.getElementById('overpayment-review-modal');
  const tenantId = document.getElementById('overpayment-review-tenant-id').value;
  const messageBody = document.getElementById('overpayment-review-body').textContent;
  const hint = document.getElementById('overpayment-review-hint');
  const btn = document.getElementById('btn-overpayment-review-send');
  if (!tenantId || !messageBody) return;
  hint.textContent = 'Sending…';
  btn.disabled = true;
  try {
    const result = await api.sendMessage(tenantId, messageBody);
    modal.style.display = 'none';
    const wa = result.whatsapp || {};
    if (wa.status === 'Failed') {
      alert('Message sent to tenant, but WhatsApp delivery failed' + (wa.failureReason ? ': ' + wa.failureReason : '') + '.');
    } else {
      alert('Confirmation message sent to tenant successfully.');
    }
  } catch (err) {
    hint.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-overpayment-review-close')?.addEventListener('click', () => {
  document.getElementById('overpayment-review-modal').style.display = 'none';
});

function showApplyCreditModal(tenantCode, creditBalance) {
  const modal = document.getElementById('apply-credit-modal');
  if (!modal) return;
  document.getElementById('apply-credit-tenant-code').value = tenantCode;
  document.getElementById('apply-credit-balance').textContent = formatKes(creditBalance);
  document.getElementById('apply-credit-amount').value = '';
  document.getElementById('apply-credit-amount').max = creditBalance;
  document.getElementById('apply-credit-hint').textContent = '';
  modal.style.display = 'flex';
}

document.getElementById('btn-apply-credit')?.addEventListener('click', async () => {
  const tenantCode = document.getElementById('apply-credit-tenant-code').value;
  const target = document.getElementById('apply-credit-target').value;
  const amount = Number(document.getElementById('apply-credit-amount').value);
  const reason = document.getElementById('apply-credit-reason').value.trim();
  const hint = document.getElementById('apply-credit-hint');
  if (!amount || amount <= 0) { hint.textContent = 'Enter a valid amount.'; return; }
  if (!confirm(`Are you sure you want to apply this credit balance of KES ${amount.toLocaleString()} towards ${target}?\n\nThe amount, reason, date and approving user will be recorded.`)) {
    return;
  }
  hint.textContent = 'Applying…';
  try {
    await api.applyCredit(tenantCode, { target, amount, reason: reason || null });
    document.getElementById('apply-credit-modal').style.display = 'none';
    document.getElementById('apply-credit-reason').value = '';
    alert('Credit applied.');
    loadTenantDashboard(tenantCode);
    loadPayments();
    loadDashboard();
  } catch (err) {
    hint.textContent = err.message;
  }
});

document.getElementById('btn-apply-credit-close')?.addEventListener('click', () => {
  document.getElementById('apply-credit-modal').style.display = 'none';
});

function statusBadge(status) {
  const map = {
    Active: 'badge-active',
    Overdue: 'badge-expired',
    Evicted: 'badge-suspended',
    Pending: 'badge-pending',
    Approved: 'badge-active',
    Paid: 'badge-active',
    Partial: 'badge-pending',
    Arrears: 'badge-expired',
    Unpaid: 'badge-expired',
    Vacant: 'badge-vacant',
    Sent: 'badge-sent',
    Delivered: 'badge-delivered',
    Read: 'badge-read',
    Failed: 'badge-failed',
  };
  const cls = map[status] || 'badge-suspended';
  return `<span class="status-badge ${cls}"><span class="status-dot"></span>${escapeHtml(status)}</span>`;
}

// Phase 1 synchronization: an approved payment only reads as "Approved & Sent"
// once every module (payment -> tenant -> penalties) has updated and validated
// (payments.sync_status = 'synced').
function paymentStatusBadge(p) {
  if (p.status === 'Approved' && p.sync_status === 'synced') {
    return `<span class="status-badge badge-active"><span class="status-dot"></span>Approved &amp; Sent</span>`;
  }
  if (p.status === 'Approved') {
    const failed = p.sync_status === 'sync_failed';
    const label = failed ? 'Approved · Sync Failed' : 'Approved · Syncing';
    const cls = failed ? 'badge-suspended' : 'badge-pending';
    return `<span class="status-badge ${cls}" title="${escapeHtml('Payment pending full module synchronization.')}"><span class="status-dot"></span>${escapeHtml(label)}</span>`;
  }
  return statusBadge(p.status);
}

function formatExpiryDisplay(t) {
  const time = t.rent_due_time ? String(t.rent_due_time).slice(0, 5) : '23:59';
  return `${t.rent_due_date} ${time}`;
}

function renderWhatsappPanel(wa) {
  const status = wa?.status || 'offline';
  const message = wa?.message;
  const labels = { ready: 'OPERATIONAL', syncing: 'SYNCING', offline: 'OFFLINE' };
  const cls = { ready: 'beacon-green', syncing: 'beacon-amber', offline: 'beacon-red' };

  const statusNote = status === 'ready'
    ? '<p class="text-green-400 font-mono text-sm mt-3">✓ Cloud API connected</p>'
    : status === 'syncing'
      ? '<p class="text-amber-400 font-mono text-sm mt-3">⟳ Validating credentials…</p>'
      : '<p class="text-rose-400 font-mono text-sm mt-3">✗ Not configured</p>';

  const resetBtn = isAdmin()
    ? `<button type="button" id="btn-wa-reset" class="qc-btn mt-3">Re-validate connection</button>`
    : '';

  return `
    <div class="whatsapp-module glass-panel p-5">
      <div class="flex flex-wrap items-center gap-6">
        <div class="beacon-wrap shrink-0">
          <span class="beacon-pulse ${cls[status] || 'beacon-red'}"></span>
          <span class="beacon-core ${cls[status] || 'beacon-red'}"></span>
        </div>
        <div>
          <span class="sys-tag">[WA_GATEWAY]</span>
          <p class="font-orbitron text-lg text-white mt-1">${labels[status] || 'OFFLINE'}</p>
        </div>
      </div>
      ${message ? `<p class="text-amber-400/90 font-mono text-xs mt-3">${escapeHtml(message)}</p>` : ''}
      ${statusNote}
      ${resetBtn}
    </div>`;
}

async function refreshWhatsappBeacon() {
  try {
    const wa = await api.whatsappStatus();
    const el = document.getElementById('wa-beacon-slot');
    if (el) el.innerHTML = renderWhatsappPanel(wa);
  } catch (_) {
    /* ignore poll errors */
  }
}

async function handleWhatsappReset() {
  if (!confirm('Re-validate WhatsApp session connection?')) return;
  try {
    const result = await api.resetWhatsapp();
    const el = document.getElementById('wa-beacon-slot');
    if (el && result.whatsapp) el.innerHTML = renderWhatsappPanel(result.whatsapp);
  } catch (err) {
    alert(err.status === 403 ? 'Admin only' : err.message);
  }
}

async function loadDashboard() {
  try {
    const data = await api.metrics();
    const t = data.tenants || {};
    const r = data.revenue || {};
    const c = data.collection || {};
    document.getElementById('metric-total').textContent = t.total_tenants ?? 0;
    document.getElementById('metric-vacant').textContent = t.vacant_units ?? 0;
    document.getElementById('metric-overdue').textContent = t.overdue_tenants ?? 0;
    document.getElementById('metric-due7').textContent = t.due_7d ?? 0;
    document.getElementById('metric-pending').textContent = r.pending_count ?? 0;
    document.getElementById('metric-revenue').textContent = `KES ${Number(r.revenue_mtd || 0).toLocaleString()}`;
    document.getElementById('metric-arrears').textContent = `KES ${Number(r.total_arrears || 0).toLocaleString()}`;
    // Collection Progress panel — expected / collected / outstanding / percent
    const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setTxt('cp-period', c.period_label || '—');
    setTxt('cp-expected', `KES ${Number(c.expected || 0).toLocaleString()}`);
    setTxt('cp-collected', `KES ${Number(c.collected || 0).toLocaleString()}`);
    setTxt('cp-outstanding', `KES ${Number(c.outstanding || 0).toLocaleString()}`);
    const pct = Number(c.percent || 0);
    setTxt('cp-pct', `${pct.toFixed(1)}%`);
    const bar = document.getElementById('cp-bar');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  } catch (err) {
    console.error(err);
  }
}

/* ---------------- DASHBOARD DRILLDOWNS ----------------
 * Every metric card opens the records behind its figure via
 * GET /api/dashboard/drilldown/:kind. The backend builds those lists from
 * the SAME predicates as the card counts, so a card always equals its list
 * (and the row sums always equal the money figures). */

const ksh = (v) => `KES ${Number(v || 0).toLocaleString()}`;
const dashDate = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(String(iso).slice(0, 10) + 'T12:00:00Z')
      .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  } catch (_) {
    return String(iso).slice(0, 10);
  }
};
const dashTenantCell = (name, code) => code
  ? `<a href="#tenant/${encodeURIComponent(code)}" class="text-sky-600 hover:underline" data-tenant-link>${escapeHtml(name || code)}</a>`
  : escapeHtml(name || '—');
const dashCell = (v) => escapeHtml(v || '—');

const DASH_DRILLS = {
  vacant: {
    title: 'Vacant Units',
    cols: ['Property / House', 'Unit'],
    row: (r) => [dashCell(r.property_name), dashCell(r.unit_display)],
    totals: (s) => `${s.units} vacant unit(s) · live occupancy status`,
    empty: 'No vacant units right now.',
  },
  overdue: {
    title: 'Overdue Units',
    cols: ['Property', 'Unit', 'Tenant', 'Outstanding Balance', 'Overdue Period'],
    row: (r) => [
      dashCell(r.property_name),
      dashCell(r.unit_display),
      dashTenantCell(r.name, r.tenant_code),
      ksh(r.outstanding_balance),
      `${Number(r.overdue_days || 0)} day(s) · since ${dashDate(r.overdue_since)}`,
    ],
    totals: (s) => `${s.units} unit(s) · overdue rent ${ksh(s.overdue_rent)} · total outstanding ${ksh(s.outstanding)}`,
    empty: 'No overdue units — every rent balance is up to date.',
  },
  due7: {
    title: 'Rent Due in 7 Days',
    cols: ['Property', 'Unit', 'Tenant', 'Rent Due Date', 'Amount Due'],
    row: (r) => [
      dashCell(r.property_name),
      dashCell(r.unit_display),
      dashTenantCell(r.name, r.tenant_code),
      dashDate(r.rent_due_date),
      ksh(r.amount_due),
    ],
    totals: (s) => `${s.units} unit(s) · ${ksh(s.amount_due)} due within 7 days`,
    empty: 'No rent falls due in the next 7 days (fully paid rent is excluded).',
  },
  pending: {
    title: 'Pending Payments',
    cols: ['Property', 'Unit', 'Tenant', 'Expected', 'Amount Paid', 'Remaining'],
    row: (r) => [
      dashCell(r.property_name),
      dashCell(r.unit_display),
      dashTenantCell(r.name, r.tenant_code),
      ksh(r.expected_amount),
      ksh(r.paid_amount),
      ksh(r.remaining_balance),
    ],
    totals: (s) => `${s.records} record(s) · ${ksh(s.pending_amount)} awaiting approval · unpaid rent obligations appear under Total Arrears`,
    empty: 'No pending payment records. Unpaid rent obligations appear under Total Arrears.',
  },
  arrears: {
    title: 'Total Arrears & Outstanding Balances',
    cols: ['Property', 'Unit', 'Tenant', 'Arrears B/F', 'Rent Unpaid', 'Charges', 'Total Outstanding'],
    row: (r) => [
      dashCell(r.property_name),
      dashCell(r.unit_display),
      dashTenantCell(r.name, r.tenant_code),
      ksh(r.arrears_bf),
      ksh(r.unpaid_rent),
      ksh(Number(r.penalties_pending || 0) + Number(r.garbage_due || 0) + Number(r.water_due || 0)),
      ksh(r.outstanding_balance),
    ],
    totals: (s) => `${s.units} unit(s) with a balance · total ${ksh(s.outstanding)} = arrears ${ksh(s.arrears_bf)} + unpaid rent ${ksh(s.unpaid_rent)} + charges ${ksh(Number(s.penalties || 0) + Number(s.garbage || 0) + Number(s.water || 0))}`,
    empty: 'No outstanding balances — every tenant account is clear.',
  },
  revenue: {
    title: 'Collected Rent — This Month',
    cols: ['Date', 'Property', 'Unit', 'Tenant', 'Amount', 'Reference'],
    row: (r) => [
      dashDate(r.payment_date),
      dashCell(r.property_name),
      dashCell(r.unit_display),
      dashTenantCell(r.tenant_name, r.tenant_code),
      ksh(r.amount),
      dashCell(r.mpesa_reference || r.receipt_number),
    ],
    totals: (s) => `${s.records} approved payment(s) · ${ksh(s.total)} received this month (matches the Collected MTD card)`,
    empty: 'No approved payments recorded this month.',
  },
  progress: {
    title: 'Collection Progress',
    cols: ['Property', 'Unit', 'Tenant', 'Expected', 'Collected', 'Outstanding'],
    row: (r) => [
      dashCell(r.property_name),
      dashCell(r.unit_display),
      dashTenantCell(r.name, r.tenant_code),
      ksh(r.expected),
      ksh(r.collected),
      ksh(r.outstanding),
    ],
    totals: (s) => `${s.units} unit(s) · ${ksh(s.collected)} of ${ksh(s.expected)} collected · ${ksh(s.outstanding)} outstanding · ${Number(s.percent || 0)}%`,
    empty: 'No occupied units.',
  },
};

async function openDashDrill(kind) {
  const conf = DASH_DRILLS[kind];
  const modal = document.getElementById('dash-drill-modal');
  if (!conf || !modal) return;
  const title = document.getElementById('dash-drill-title');
  const sub = document.getElementById('dash-drill-sub');
  const body = document.getElementById('dash-drill-body');
  title.textContent = conf.title;
  sub.textContent = 'Loading…';
  body.innerHTML = '<p class="text-slate-400">Loading records…</p>';
  modal.classList.remove('hidden');
  try {
    const data = await api.dashboardDrill(kind);
    const rows = data.rows || [];
    sub.textContent = conf.totals(data.totals || {});
    if (!rows.length) {
      body.innerHTML = `<p class="text-slate-500">${escapeHtml(conf.empty)}</p>`;
      return;
    }
    const head = conf.cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
    const bodyRows = rows
      .map((r) => `<tr>${conf.row(r).map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
      .join('');
    body.innerHTML = `
      <div class="glass-panel overflow-x-auto">
        <table class="data-grid w-full min-w-[720px]">
          <thead><tr>${head}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
      <p class="text-slate-400 text-xs font-mono mt-2">Updated ${new Date(data.generated_at).toLocaleTimeString()} · click a tenant name to open their account</p>`;
  } catch (err) {
    sub.textContent = '—';
    body.innerHTML = `<p class="text-rose-500">${escapeHtml(err.message)}</p>`;
  }
}

async function loadTenants() {
  const tbody = document.getElementById('tenants-tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="9" class="text-center py-8 text-slate-500">Loading...</td></tr>`;
  try {
    const q = document.getElementById('tenant-search')?.value?.trim();
    const status = document.getElementById('tenant-filter-status')?.value;
    const { tenants } = await api.tenants({ ...(q ? { q } : {}), ...(status ? { status } : {}) });
    if (!tenants.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center py-8 text-slate-500">No tenants yet</td></tr>`;
      return;
    }
    tbody.innerHTML = tenants
      .map(
        (t) => `
      <tr>
        <td class="font-mono text-purple-300">
          <a href="#tenant/${t.tenant_code}" class="hover:underline text-purple-300 font-semibold">${escapeHtml(t.tenant_code)}</a>
        </td>
        <td class="text-white">${escapeHtml(t.name)}</td>
        <td class="font-mono text-sm">${escapeHtml(t.phone_number)}</td>
        <td class="text-slate-400">${escapeHtml(t.property_name)}</td>
        <td class="font-mono text-green-400">${Number(t.rent_amount).toLocaleString()}</td>
        <td class="font-mono text-sm">${t.agreement_outstanding > 0 ? `<span class="text-amber-400 font-semibold">KES ${Number(t.agreement_outstanding).toLocaleString()}</span>` : `<span class="text-emerald-400">✓</span>`}</td>
        <td class="font-mono text-sm text-slate-400">${escapeHtml(formatExpiryDisplay(t))}</td>
        <td>${statusBadge(t.status)}</td>
        <td class="space-x-1">
          <button type="button" class="action-btn" data-tenant-profile="${t.id}">Profile</button>
          <button type="button" class="action-btn action-btn-wa" data-message-tenant="${t.id}">💬 Msg</button>
          <button type="button" class="action-btn" data-edit-tenant="${t.id}">Edit</button>
          <button type="button" class="action-btn action-btn-danger" data-delete-tenant="${t.id}">Delete</button>
        </td>
      </tr>`
      )
      .join('');
  } catch (err) {
    if (!isNetworkError(err)) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-rose-400 text-center py-8">${escapeHtml(err.message)}</td></tr>`;
      return;
    }
    // Offline — tenants from the last synced snapshot (read-only).
    const q = (document.getElementById('tenant-search')?.value?.trim() || '').toLowerCase();
    const cached = await offlineDb.getAll('tenants').catch(() => []);
    const filtered = (cached || []).filter((t) => !q || `${t.name || ''} ${t.tenant_code || ''} ${t.phone_number || ''}`.toLowerCase().includes(q));
    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center py-8 text-slate-500">Offline — no synced tenant data on this device yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = `<tr><td colspan="9" class="text-center py-2 text-amber-500 text-xs font-mono">📴 Offline — showing last synced data (read-only)</td></tr>` + filtered
      .map(
        (t) => `
      <tr style="opacity:.92">
        <td class="font-mono text-purple-300">
          <a href="#tenant/${t.tenant_code}" class="hover:underline text-purple-300 font-semibold">${escapeHtml(t.tenant_code)}</a>
        </td>
        <td class="text-white">${escapeHtml(t.name)}</td>
        <td class="font-mono text-sm">${escapeHtml(t.phone_number)}</td>
        <td class="text-slate-400">${escapeHtml(t.property_name)}</td>
        <td class="font-mono text-green-400">${Number(t.rent_amount).toLocaleString()}</td>
        <td class="font-mono text-sm">${t.agreement_outstanding > 0 ? `<span class="text-amber-400 font-semibold">KES ${Number(t.agreement_outstanding).toLocaleString()}</span>` : `<span class="text-emerald-400">✓</span>`}</td>
        <td class="font-mono text-sm text-slate-400">${escapeHtml(formatExpiryDisplay(t))}</td>
        <td>${statusBadge(t.status)}</td>
        <td class="space-x-1">
          <button type="button" class="action-btn" data-tenant-profile="${t.id}">Profile</button>
          <button type="button" class="action-btn action-btn-wa" data-message-tenant="${t.id}">💬 Msg</button>
        </td>
      </tr>`
      )
      .join('');
  }
}

async function loadPayments() {
  const tbody = document.getElementById('payments-tbody');
  if (!tbody) return;
  const filter = document.getElementById('payment-filter')?.value;
  tbody.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-slate-500">Loading...</td></tr>`;
  // Locally-pending offline payments always show first with their sync badge.
  const cachedPending = await offlineDb
    .getAll('payments')
    .then((all) => (all || []).filter((p) => p && (p.sync === 'pending' || p.sync === 'failed')))
    .catch(() => []);
  const pendingRows = cachedPending.map(offlinePaymentRow).join('');
  try {
    const { payments } = await api.payments(filter || undefined);
    if (!payments.length && !cachedPending.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-slate-500">No payments</td></tr>`;
      return;
    }
    tbody.innerHTML = pendingRows + payments
      .map(
        (p) => `
      <tr>
        <td class="font-mono text-xs text-cyan-400">${escapeHtml(p.receipt_number || '—')}</td>
        <td class="text-white">${escapeHtml(p.tenant_name || '—')} <span class="text-slate-500 font-mono text-xs">${escapeHtml(p.tenant_code || '')}</span></td>
        <td class="font-mono text-green-400">KES ${Number(p.amount).toLocaleString()}</td>
        <td class="font-mono text-xs">${p.payment_type === 'deposit' ? '<span class="text-cyan-400">DEPOSIT</span> ' : ''}${p.payment_mode ? `<span class="text-purple-400 text-[10px]">${escapeHtml(p.payment_mode)}</span>` : ''} ${escapeHtml(p.mpesa_reference || p.cheque_number || '—')}</td>
        <td class="font-mono text-sm text-slate-400">${escapeHtml(p.payment_date)}</td>
        <td>${paymentStatusBadge(p)}</td>
        <td>
          <div class="flex items-center gap-2">
            ${p.status === 'Pending' ? `<button type="button" class="qc-btn qc-btn-primary !py-1 !px-2 text-xs" data-approve-payment="${p.id}">Approve</button>` : ''}
            ${p.status === 'Approved' ? `<button type="button" class="action-btn !py-1 !px-2 text-xs" data-view-receipt="${p.id}">Receipt</button><button type="button" class="action-btn !py-1 !px-2 text-xs" data-download-receipt="${p.id}">PDF</button>` : ''}
            <button type="button" class="action-btn action-btn-danger !py-1 !px-2 text-xs" data-delete-payment="${p.id}">Delete</button>
          </div>
        </td>
      </tr>`
      )
      .join('');
  } catch (err) {
    if (!isNetworkError(err)) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-rose-400 text-center py-8">${escapeHtml(err.message)}</td></tr>`;
      return;
    }
    // Fully offline — render the on-device cache (pending first).
    const cached = await offlineDb.getAll('payments').catch(() => []);
    if (!cached.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-slate-500">Offline — no synced payment data on this device yet.</td></tr>`;
      return;
    }
    const sorted = [...cached].sort((a, b) => (a.sync === b.sync ? 0 : a.sync === 'pending' ? -1 : 1));
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-2 text-amber-500 text-xs font-mono">📴 Offline — showing last synced data${cachedPending.length ? ` + ${cachedPending.length} pending` : ''}</td></tr>`
      + sorted.map(offlinePaymentRow).join('');
  }
}

async function refreshHouseOptions() {
  const { houses } = await api.houses();
  housesCache = houses;
  const tenantSelect = document.getElementById('tenant-house-select');
  const broadcastHouseSelect = document.getElementById('broadcast-house-select');
  if (tenantSelect) {
    tenantSelect.innerHTML = houses
      .map((h) => `<option value="${h.id}">${escapeHtml(h.house_name)} (${escapeHtml(h.total_units)} units)</option>`)
      .join('');
  }
  if (broadcastHouseSelect) {
    broadcastHouseSelect.innerHTML = houses
      .map((h) => `<option value="${h.id}">${escapeHtml(h.house_name)} (${escapeHtml(h.total_units)} units)</option>`)
      .join('');
  }
  const reportHouseSelect = document.getElementById('report-house-select');
  if (reportHouseSelect) {
    reportHouseSelect.innerHTML = '<option value="">All Houses</option>' + houses
      .map((h) => `<option value="${h.id}">${escapeHtml(h.house_name)}</option>`)
      .join('');
  }
}

async function openTenantModal(id = null) {
  const modal = document.getElementById('tenant-modal');
  const form = document.getElementById('tenant-form');
  form.reset();
  form.dataset.occupyMode = '';
  await refreshHouseOptions();
  document.getElementById('tenant-form-id').value = id || '';
  document.getElementById('tenant-modal-title').textContent = id ? 'Edit tenant' : 'Add tenant';

  const openingAdvanceField = document.getElementById('opening-advance-field');
  const openingAdvanceInput = form.opening_advance_rent;
  const openingAdvanceHint = document.getElementById('opening-advance-hint');
  if (openingAdvanceField) openingAdvanceField.style.display = '';
  if (openingAdvanceInput) openingAdvanceInput.readOnly = false;
  if (openingAdvanceHint) openingAdvanceHint.classList.add('hidden');
  document.getElementById('arrears-manual-badge')?.classList.add('hidden');

  if (id) {
    form.tenant_code.readOnly = true;
    api.tenant(id).then(({ tenant: t }) => {
      form.name.value = t.name;
      form.tenant_code.value = t.tenant_code;
      form.phone_number.value = t.phone_number;
      form.national_id.value = t.national_id || '';
      form.guardian_name.value = t.guardian_name || '';
      form.guardian_id.value = t.guardian_id || '';
      form.guardian_phone.value = t.guardian_phone || '';
      form.guardian_relationship.value = t.guardian_relationship || '';
      form.house_id.value = t.house_id || '';
      // unit_label is no longer used
      form.rent_amount.value = t.rent_amount;
      form.standard_monthly_rent.value = t.standard_monthly_rent || '';
      form.first_billing_method.value = t.first_billing_method || '';
      form.first_billing_charge.value = t.first_billing_charge || '';
      form.first_billing_days.value = t.first_billing_days || '';
      form.first_billing_reason.value = t.first_billing_reason || '';
      // Trigger first billing method UI
      const fbm = document.getElementById('tenant-first-billing-method');
      if (fbm) fbm.dispatchEvent(new Event('change'));
      form.deposit_amount.value = t.deposit_amount || 0;
      form.deposit_paid.value = t.deposit_paid || 0;
      form.garbage_fee_amount.value = t.garbage_fee_amount || 0;
      form.water_charge_amount.value = t.water_charge_amount || 0;
      form.water_charge_paid.value = t.water_charge_paid || 0;
      form.arrears.value = t.arrears || 0;
      document.getElementById('arrears-manual-badge')?.classList.toggle('hidden', !t.arrears_manually_set);
      form.agreement_charge.value = t.agreement_charge || 0;
      form.agreement_paid.value = t.agreement_paid || 0;
      const openingAdvance = Number(t.opening_advance_rent || 0);
      form.opening_advance_rent.value = openingAdvance;
      // An already-recorded opening advance can never be changed or re-applied.
      form.opening_advance_rent.readOnly = openingAdvance > 0;
      if (openingAdvanceHint) openingAdvanceHint.classList.toggle('hidden', openingAdvance <= 0);
      form.move_in_date.value = t.move_in_date || '';
      form.rent_due_date.value = String(t.rent_due_date || '').slice(0, 10);
      form.rent_due_time.value = String(t.rent_due_time || '23:59:00').slice(0, 5);
      if (t.status === 'Vacant') {
        form.status.value = 'Active';
        form.dataset.occupyMode = '1';
        document.getElementById('tenant-modal-title').textContent = `Mark Occupied — Assign Tenant to Unit ${t.tenant_code}`;
      } else {
        form.status.value = t.status;
        form.dataset.occupyMode = '';
      }
    });
  } else {
    form.tenant_code.readOnly = false;
    form.dataset.occupyMode = '';
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    d.setDate(5);
    form.rent_due_date.value = d.toISOString().slice(0, 10);
  }
  modal.classList.remove('hidden');
}

async function openStatementModal(tenantId) {
  const modal = document.getElementById('statement-modal');
  const statusEl = document.getElementById('statement-status');
  document.getElementById('statement-tenant-id').value = tenantId;
  statusEl.classList.add('hidden');
  statusEl.textContent = '';
  document.getElementById('btn-statement-download').disabled = false;
  document.getElementById('btn-statement-send').disabled = false;
  document.getElementById('btn-statement-both').disabled = false;
  modal.classList.remove('hidden');
}

async function runStatementGeneration(mode) {
  const tenantId = document.getElementById('statement-tenant-id').value;
  const statusEl = document.getElementById('statement-status');
  if (!tenantId) return;
  statusEl.classList.remove('hidden');
  statusEl.textContent = mode === 'download' ? 'Generating statement…' : (mode === 'both' ? 'Generating and sending statement…' : 'Sending statement via WhatsApp…');
  document.getElementById('btn-statement-download').disabled = true;
  document.getElementById('btn-statement-send').disabled = true;
  document.getElementById('btn-statement-both').disabled = true;
  try {
    if (mode === 'download' || mode === 'both') {
      const result = mode === 'download'
        ? await api.downloadStatement(tenantId)
        : await api.sendAndDownloadStatement(tenantId);
      if (result.blob) {
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.filename || `statement-${tenantId}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        statusEl.textContent = result.json?.error ? `Sent, but download failed: ${result.json.error}` : (mode === 'both' ? 'Statement sent and download started.' : 'Download started.');
      } else {
        statusEl.textContent = result.json?.message || (result.json?.error ? `Error: ${result.json.error}` : 'Done.');
      }
    } else {
      const res = await api.generateStatement(tenantId, 'send');
      statusEl.textContent = res?.message || 'Statement sent successfully.';
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + (err.message || err);
  } finally {
    document.getElementById('btn-statement-download').disabled = false;
    document.getElementById('btn-statement-send').disabled = false;
    document.getElementById('btn-statement-both').disabled = false;
  }
}

// ---- Exit Invoice modal -----------------------------------------------------

function renderEiLines(lines) {
  const tbody = document.getElementById('ei-lines-tbody');
  if (!tbody) return;
  const badge = (document.getElementById('ei-status-badge').textContent || '').toUpperCase();
  const editing = badge === 'EDITING';
  const locked = badge === 'FINALIZED' && !editing;
  const rows = (lines || []).map((l, i) => `
    <tr data-ei-line="${i}">
      <td><select class="qc-input text-sm w-36" data-ei-cat ${locked ? 'disabled' : ''}>
        ${['maintenance','repair','cleaning','painting','utility','deduction','other'].map(c =>
          `<option value="${c}" ${(l.category || 'other') === c ? 'selected' : ''}>${c[0].toUpperCase() + c.slice(1)}</option>`).join('')}
      </select></td>
      <td><input type="text" class="qc-input text-sm w-56" data-ei-desc value="${escapeHtml(l.description || '')}" ${locked ? 'disabled' : ''} /></td>
      <td><input type="number" min="0" class="qc-input text-sm w-32 text-right" data-ei-amt value="${Number(l.amount || 0)}" ${locked ? 'disabled' : ''} /></td>
      <td>${locked ? '' : '<button type="button" class="action-btn action-btn-danger !py-1 !px-2 text-xs" data-ei-del>✕</button>'}</td>
    </tr>`).join('');
  tbody.innerHTML = rows || '<tr><td colspan="4" class="text-center py-4 text-slate-500">No deductions yet. Add charges below.</td></tr>';
  tbody.querySelectorAll('[data-ei-amt], [data-ei-desc]').forEach((el) => {
    el.addEventListener('input', recalcEiTotals);
  });
  tbody.querySelectorAll('[data-ei-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.closest('tr')?.remove();
      recalcEiTotals();
    });
  });
}

function collectEiLines() {
  const tbody = document.getElementById('ei-lines-tbody');
  if (!tbody) return [];
  const lines = [];
  tbody.querySelectorAll('tr[data-ei-line]').forEach((tr) => {
    const cat = tr.querySelector('[data-ei-cat]')?.value || 'other';
    const desc = (tr.querySelector('[data-ei-desc]')?.value || '').trim();
    const amt = Number(tr.querySelector('[data-ei-amt]')?.value || 0);
    if (amt > 0) lines.push({ category: cat, description: desc || cat, amount: amt });
  });
  return lines;
}

function recalcEiTotals() {
  const lines = collectEiLines();
  const deductions = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const depositPaid = Number(document.getElementById('ei-deposit-paid')?.textContent.replace(/[^0-9]/g, '') || 0);
  const waterCharges = Number(document.getElementById('ei-water-charges')?.textContent.replace(/[^0-9]/g, '') || 0);
  const rentAmount = Number(document.getElementById('ei-rent')?.textContent.replace(/[^0-9]/g, '') || 0);
  const arrears = Number(document.getElementById('ei-outstanding')?.textContent.replace(/[^0-9]/g, '') || 0);

  // Get rent treatment
  const rentTreatment = document.querySelector('input[name="ei-rent-treatment"]:checked')?.value || 'full_month';
  let rentCharged = rentAmount;
  if (rentTreatment === 'pro_rated') {
    const days = Number(document.getElementById('ei-pro-rated-days')?.value || 0);
    rentCharged = Math.round((rentAmount / 30) * days);
    const amtEl = document.getElementById('ei-pro-rated-amount');
    if (amtEl) amtEl.value = rentCharged;
  } else if (rentTreatment === 'waived') {
    rentCharged = 0;
  }

  // 1. Refundable amount = deposit paid + water charges
  const refundableAmount = depositPaid + waterCharges;
  // 2. Total deductions = outstanding (arrears + rent + penalties) + user deduction lines
  const totalDeductions = arrears + rentCharged + deductions;
  // 3. Net refund = refundable - deductions
  const netRefund = refundableAmount - totalDeductions;

  setTextEl('ei-total-refundable', `KES ${refundableAmount.toLocaleString()}`);
  setTextEl('ei-total-refundable-val', `KES ${refundableAmount.toLocaleString()}`);
  setTextEl('ei-total-deductions', `KES ${totalDeductions.toLocaleString()}`);
  setTextEl('ei-final-settlement', `KES ${netRefund.toLocaleString()}`);
}

function renderEiActions(invoice) {
  const draftActions = document.getElementById('ei-actions-draft');
  const finalActions = document.getElementById('ei-actions-final');
  const editActions = document.getElementById('ei-actions-editing');
  const addLineWrap = document.getElementById('ei-add-line');
  const finalized = invoice && invoice.status === 'Finalized';
  // Finalized exit invoices are permanent records: the editing state no
  // longer exists (the server refuses edits/deletes with 409 as well).
  window._eiEditing = false;
  if (draftActions) draftActions.classList.toggle('hidden', finalized);
  if (finalActions) finalActions.classList.toggle('hidden', !finalized);
  if (editActions) editActions.classList.add('hidden');
  if (addLineWrap) addLineWrap.style.display = finalized ? 'none' : '';
  // Disable form fields for finalized invoices
  const fields = ['ei-move-out-date', 'ei-exit-reason', 'ei-pro-rated-days', 'ei-rent-treatment-reason', 'ei-settlement-reason'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = finalized;
  });
  document.querySelectorAll('input[name="ei-rent-treatment"], input[name="ei-deposit-treatment"]').forEach(r => {
    r.disabled = finalized;
  });
  setTextEl('ei-number', invoice ? (invoice.exit_number || '—') : 'New Invoice');
  const badge = document.getElementById('ei-status-badge');
  if (badge) {
    badge.textContent = finalized ? 'FINALIZED' : 'DRAFT';
    badge.className = 'sys-tag text-[10px] ' + (finalized ? 'text-emerald-300' : 'text-amber-300');
  }
}

async function loadEiDepositRefundInfo(exitInvoiceId) {
  const panel = document.getElementById('ei-deposit-refund-info');
  if (!panel) return;
  try {
    const { refunds } = await api.listDepositRefunds({ sort: 'newest' });
    const refund = refunds.find(r => r.exit_invoice_id === Number(exitInvoiceId));
    if (!refund) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    setTextEl('ei-dr-amount', formatKes(refund.refundable_amount));
    setTextEl('ei-dr-due', fmtDate(refund.refund_due_date));
    const statusEl = document.getElementById('ei-dr-status');
    const statusMap = { pending: 'Pending', due_soon: 'Due Soon', due_today: 'Due Today', overdue: 'Overdue', refunded: 'Refunded', partially_refunded: 'Partially Refunded', no_refund_due: 'No Refund Due' };
    statusEl.textContent = statusMap[refund.refund_status] || refund.refund_status;
    statusEl.className = 'font-bold ' + (refund.refund_status === 'refunded' ? 'text-green-400' : refund.refund_status === 'overdue' ? 'text-rose-400' : refund.refund_status === 'no_refund_due' ? 'text-slate-500' : 'text-amber-400');
    document.getElementById('btn-ei-view-refund').onclick = () => {
      document.getElementById('exit-invoice-modal').classList.add('hidden');
      showView('deposit-refunds');
      setTimeout(() => openDrDetail(refund.id), 300);
    };
  } catch (_) { panel.classList.add('hidden'); }
}

function setEiStatusMsg(msg) {
  const el = document.getElementById('ei-status-msg');
  if (!el) return;
  if (msg) { el.textContent = msg; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
}

async function openExitInvoiceModal(tenantCode, invoiceId = null, displayOverride = null) {
  window._eiEditing = false;
  _lastEiInvoice = null;
  const modal = document.getElementById('exit-invoice-modal');
  if (modal) modal.classList.remove('hidden');

  document.getElementById('ei-id').value = '';
  document.getElementById('ei-tenant-code').value = tenantCode;
  document.getElementById('ei-move-out-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('ei-exit-reason').value = '';
  document.getElementById('ei-mark-vacant-panel')?.classList.add('hidden');
  setEiStatusMsg('');
  setTextEl('ei-number', 'Loading…');
  setTextEl('ei-status-badge', '—');
  setTextEl('ei-deposit-paid', 'KES —');
  setTextEl('ei-rent', 'KES —');
  setTextEl('ei-tenant-name', 'Loading…');
  setTextEl('ei-tenant-unit', 'Loading…');

  let summary = null;
  if (!displayOverride) {
    try { summary = await api.getInvoiceTenantSummary(tenantCode); } catch (_) { summary = null; }
  }

  let existing = null;
  if (invoiceId) {
    // Open THIS tenancy's specific exit invoice (archived tenancy link).
    try {
      const r = await api.getExitInvoice(invoiceId);
      existing = (r && r.exit_invoice) || r || null;
    } catch (_) { existing = null; }
  } else {
    try {
      const { exit_invoices } = await api.listExitInvoices(tenantCode);
      existing = exit_invoices[0] || null;
    } catch (_) { existing = null; }
  }

  const depPaid = displayOverride
    ? Number(displayOverride.deposit_paid || 0)
    : (existing ? existing.deposit_paid : (summary ? summary.deposit.paid : 0));
  const waterCharges = displayOverride
    ? Number(displayOverride.water_charge || 0)
    : (existing ? existing.water_charges : (summary ? Number(summary.tenant.water_charge_amount || 0) : 0));

  const rent = displayOverride
    ? Number(displayOverride.rent_amount || 0)
    : (summary ? summary.tenant.rent_amount : 0);

  setTextEl('ei-deposit-paid', `KES ${Number(depPaid || 0).toLocaleString()}`);
  setTextEl('ei-water-charges', `KES ${Number(waterCharges || 0).toLocaleString()}`);
  setTextEl('ei-rent', `KES ${Number(rent || 0).toLocaleString()}`);
  setTextEl('ei-tenant-name', displayOverride
    ? (displayOverride.name || tenantCode)
    : (summary ? summary.tenant.name : tenantCode));
  setTextEl('ei-tenant-unit', displayOverride
    ? `${displayOverride.unit || tenantCode} — ${displayOverride.property || ''}`
    : (summary ? `${summary.tenant.unit_label || tenantCode} — ${summary.tenant.property_name || ''}` : tenantCode));

  if (existing) {
    _lastEiInvoice = existing;
    document.getElementById('ei-id').value = existing.id;
    document.getElementById('ei-move-out-date').value = existing.move_out_date || '';
    document.getElementById('ei-exit-reason').value = existing.reason || '';

    // Restore management decisions from existing invoice
    if (existing.rent_treatment) {
      const rt = document.querySelector(`input[name="ei-rent-treatment"][value="${existing.rent_treatment}"]`);
      if (rt) { rt.checked = true; rt.dispatchEvent(new Event('change')); }
    }
    if (existing.pro_rated_days) {
      const prd = document.getElementById('ei-pro-rated-days');
      if (prd) prd.value = existing.pro_rated_days;
    }
    if (existing.rent_treatment_reason) {
      const rtr = document.getElementById('ei-rent-treatment-reason');
      if (rtr) rtr.value = existing.rent_treatment_reason;
    }
    if (existing.settlement_decision_reason) {
      const sdr = document.getElementById('ei-settlement-reason');
      if (sdr) sdr.value = existing.settlement_decision_reason;
    }
  }

  renderEiActions(existing);
  renderEiLines(existing ? existing.lines : []);
  recalcEiTotals();
  // Load deposit refund info for finalized invoices
  if (existing && existing.status === 'Finalized' && existing.id) {
    loadEiDepositRefundInfo(existing.id);
  } else {
    document.getElementById('ei-deposit-refund-info')?.classList.add('hidden');
  }
}

async function saveEiDraft() {
  const id = document.getElementById('ei-id').value;
  const tenantCode = document.getElementById('ei-tenant-code').value;
  const lines = collectEiLines();
  const deductions = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const depositPaid = Number(document.getElementById('ei-deposit-paid')?.textContent.replace(/[^0-9]/g, '') || 0);
  const rentAmount = Number(document.getElementById('ei-rent')?.textContent.replace(/[^0-9]/g, '') || 0);

  // Management decisions
  const rentTreatment = document.querySelector('input[name="ei-rent-treatment"]:checked')?.value || 'full_month';
  const proRatedDays = rentTreatment === 'pro_rated' ? Number(document.getElementById('ei-pro-rated-days')?.value || 0) : null;
  const rentTreatmentReason = document.getElementById('ei-rent-treatment-reason')?.value.trim() || null;
  const settlementReason = document.getElementById('ei-settlement-reason')?.value.trim() || null;

  // Compute rent charged
  let rentCharged = rentAmount;
  if (rentTreatment === 'pro_rated' && proRatedDays) {
    rentCharged = Math.round((rentAmount / 30) * proRatedDays);
  } else if (rentTreatment === 'waived') {
    rentCharged = 0;
  }

  const body = {
    tenant_code: tenantCode,
    lines,
    move_out_date: document.getElementById('ei-move-out-date').value || null,
    reason: document.getElementById('ei-exit-reason').value.trim() || null,
    rent_treatment: rentTreatment,
    rent_charged_amount: rentCharged,
    pro_rated_days: proRatedDays,
    rent_treatment_reason: rentTreatmentReason,
    water_charges: Number(document.getElementById('ei-water-charges')?.textContent.replace(/[^0-9]/g, '') || 0),
  };
  // Offline move-out: queue the settlement draft (PENDING SYNC). Editing an
  // existing server draft stays online-only to avoid blind overwrites.
  if (effectiveOffline()) {
    if (id) {
      setEiStatusMsg('Editing a synced exit invoice requires internet (conflict protection).');
      return null;
    }
    const clientTxnId = offlineDb.newClientTxnId();
    await queueOutboxOp({ type: 'exit_create', payload: { ...body, client_txn_id: clientTxnId } });
    setEiStatusMsg('🟠 Move-out settlement saved offline — PENDING SYNC. Will upload when internet returns.');
    showToast('Exit settlement saved offline (PENDING SYNC)');
    return { offline: true, client_txn_id: clientTxnId };
  }
  let invoice;
  if (id) {
    delete body.tenant_code;
    invoice = (await api.updateExitInvoice(id, body)).exit_invoice;
  } else {
    invoice = (await api.createExitInvoice(body)).exit_invoice;
  }
  document.getElementById('ei-id').value = invoice.id;
  setTextEl('ei-number', invoice.exit_number);
  _lastEiInvoice = invoice;
  renderEiActions(invoice);
  setEiStatusMsg('Draft saved. Finalize when all deductions are captured.');
  recalcEiTotals();
  return invoice;
}

async function finalizeEi() {
  const id = document.getElementById('ei-id').value;
  try {
    let invoice = id ? (await api.getExitInvoice(id)).exit_invoice : null;
    if (!invoice || invoice.status !== 'Draft') {
      invoice = await saveEiDraft();
      if (!invoice) return;
    }
    const res = await api.finalizeExitInvoice(invoice.id, {
      move_out_date: document.getElementById('ei-move-out-date').value || null,
      reason: document.getElementById('ei-exit-reason').value.trim() || null,
    });
    const fin = res.exit_invoice;
    _lastEiInvoice = fin;
    document.getElementById('ei-id').value = fin.id;
    renderEiLines(fin.lines);
    renderEiActions(fin);
    recalcEiTotals();
    setEiStatusMsg('Exit invoice finalized and locked.');
    // Load deposit refund info
    loadEiDepositRefundInfo(fin.id);
  } catch (err) {
    setEiStatusMsg('Error: ' + (err.message || err));
  }
}

async function runExitInvoiceAction(mode) {
  const id = document.getElementById('ei-id').value;
  const tenantCode = document.getElementById('ei-tenant-code').value;
  const markPanel = document.getElementById('ei-mark-vacant-panel');
  if (!id) return setEiStatusMsg('No exit invoice. Create and finalize it first.');
  setEiStatusMsg(mode === 'download' ? 'Generating exit invoice PDF…' : mode === 'both' ? 'Sending and generating exit invoice…' : 'Sending exit invoice via WhatsApp…');
  try {
    if (mode === 'download' || mode === 'both') {
      const result = await api.downloadExitInvoice(id);
      if (result.blob) {
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.filename || `exit-invoice-${tenantCode}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      if (mode === 'download') setEiStatusMsg('Exit Invoice downloaded. Completed successfully.');
      else setEiStatusMsg('Exit Invoice sent via WhatsApp and downloaded. Completed successfully.');
    } else {
      await api.sendExitInvoice(id);
      setEiStatusMsg('Exit Invoice sent via WhatsApp. Completed successfully.');
    }
    if (markPanel) markPanel.classList.remove('hidden');
  } catch (err) {
    setEiStatusMsg('Error: ' + (err.message || err));
  }
}

async function markVacantFromEi() {
  const tenantCode = document.getElementById('ei-tenant-code').value;
  const id = document.getElementById('ei-id').value;
  const moveOut = document.getElementById('ei-move-out-date').value || null;
  const reason = document.getElementById('ei-exit-reason').value.trim() || null;
  if (!tenantCode) return;
  if (!confirm('Mark unit ' + tenantCode + ' as VACANT? The tenancy will be permanently archived.')) return;
  setEiStatusMsg('Marking unit vacant and archiving tenancy…');
  try {
    await api.markUnitVacant(tenantCode, { exit_invoice_id: id || null, move_out_date: moveOut, reason });
    document.getElementById('exit-invoice-modal').classList.add('hidden');
    alert(`Unit ${tenantCode} marked VACANT. The tenancy has been permanently archived.`);
    if (currentView === 'tenant-dashboard') {
      // Tenant is now vacant — go back to the houses view
      setHash('houses');
      showView('houses');
    } else if (currentView === 'house-dashboard') {
      loadHouseDashboardPage(activeHouseId);
    }
    loadTenants();
    if (currentView === 'dashboard') loadDashboard();
  } catch (err) {
    setEiStatusMsg('Error: ' + (err.message || err));
  }
}

// ---- Exit Invoice: Edit / Save / Delete (Finalized) ------------------------

function startEditFinalizedEi() {
  window._eiEditing = true;
  const invoice = _lastEiInvoice;
  if (!invoice) return;
  renderEiActions(invoice);
  renderEiLines(invoice.lines);
  recalcEiTotals();
  setEiStatusMsg('Editing finalized invoice. Make changes and click Save.');
}

function cancelEditEi() {
  window._eiEditing = false;
  const invoice = _lastEiInvoice;
  if (!invoice) return;
  renderEiActions(invoice);
  renderEiLines(invoice.lines);
  recalcEiTotals();
  setEiStatusMsg('');
}

async function saveFinalizedEi() {
  const id = document.getElementById('ei-id').value;
  if (!id) return setEiStatusMsg('No exit invoice to save.');
  const lines = collectEiLines();
  const rentAmount = Number(document.getElementById('ei-rent')?.textContent.replace(/[^0-9]/g, '') || 0);
  const rentTreatment = document.querySelector('input[name="ei-rent-treatment"]:checked')?.value || 'full_month';
  const proRatedDays = rentTreatment === 'pro_rated' ? Number(document.getElementById('ei-pro-rated-days')?.value || 0) : null;
  const rentTreatmentReason = document.getElementById('ei-rent-treatment-reason')?.value.trim() || null;
  const settlementReason = document.getElementById('ei-settlement-reason')?.value.trim() || null;
  let rentCharged = rentAmount;
  if (rentTreatment === 'pro_rated' && proRatedDays) {
    rentCharged = Math.round((rentAmount / 30) * proRatedDays);
  } else if (rentTreatment === 'waived') {
    rentCharged = 0;
  }
  const body = {
    lines,
    move_out_date: document.getElementById('ei-move-out-date').value || null,
    reason: document.getElementById('ei-exit-reason').value.trim() || null,
    rent_treatment: rentTreatment,
    rent_charged_amount: rentCharged,
    pro_rated_days: proRatedDays,
    rent_treatment_reason: rentTreatmentReason,
    settlement_decision_reason: settlementReason,
  };
  try {
    setEiStatusMsg('Saving changes…');
    const res = await api.updateExitInvoice(id, body);
    const updated = res.exit_invoice;
    _lastEiInvoice = updated;
    window._eiEditing = false;
    document.getElementById('ei-id').value = updated.id;
    setTextEl('ei-number', updated.exit_number);
    renderEiActions(updated);
    renderEiLines(updated.lines);
    recalcEiTotals();
    setEiStatusMsg('Changes saved successfully.');
    loadEiDepositRefundInfo(updated.id);
  } catch (err) {
    setEiStatusMsg('Error saving: ' + (err.message || err));
  }
}

async function deleteExitInvoice() {
  const id = document.getElementById('ei-id').value;
  const tenantCode = document.getElementById('ei-tenant-code').value;
  if (!id) return;
  if (!confirm('Are you sure you want to delete this Exit Invoice? This will also cancel the associated deposit refund process.')) return;
  try {
    setEiStatusMsg('Deleting exit invoice…');
    await api.deleteExitInvoice(id);
    document.getElementById('exit-invoice-modal').classList.add('hidden');
    window._eiEditing = false;
    _lastEiInvoice = null;
    alert('Exit Invoice deleted. The associated deposit refund process has been cancelled.');
    if (currentView === 'tenant-dashboard') {
      loadTenantDashboard(tenantCode);
    }
    loadTenants();
    if (currentView === 'dashboard') loadDashboard();
  } catch (err) {
    setEiStatusMsg('Error deleting: ' + (err.message || err));
  }
}

var _lastEiInvoice = null;

// ---- Tenancy Archive view ---------------------------------------------------

async function refreshHouseSelects(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  try {
    const { houses } = await api.houses();
    sel.innerHTML = '<option value="">All Properties</option>' + houses.map(h =>
      `<option value="${escapeHtml(h.paybill_number || h.id || '')}">${escapeHtml(h.house_name)}</option>`).join('');
  } catch (_) { /* keep empty */ }
}

async function loadArchive() {
  await Promise.all([refreshHouseSelects('archive-house'), refreshHouseSelects('occupancy-house')]);
  const q = document.getElementById('archive-q').value.trim();
  const house = document.getElementById('archive-house').value;
  const unit = document.getElementById('archive-unit').value.trim();
  const exitDate = document.getElementById('archive-exit-date').value;
  const params = {};
  if (q) params.q = q;
  if (house) params.house_id = house;
  if (unit) params.unit_code = unit;
  if (exitDate) params.to = exitDate;
  const tbody = document.getElementById('archive-tbody');
  const countEl = document.getElementById('archive-count');
  if (countEl) countEl.textContent = 'Searching…';
  try {
    const { archives } = await api.archives(params);
    if (countEl) countEl.textContent = `${archives.length} record${archives.length === 1 ? '' : 's'}`;
    if (!archives.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="text-center py-6 text-slate-500">No archived tenancies found.</td></tr>';
    } else {
      tbody.innerHTML = archives.map(a => `
        <tr>
          <td>
            <button type="button" class="font-semibold text-white hover:text-cyan-300 underline underline-offset-4 decoration-cyan-700/70 hover:decoration-cyan-300 text-left" data-archive-history="${a.id}" title="Open complete payment history for this tenancy">${escapeHtml(a.tenant_name || '—')}</button>
            <div class="text-xs text-slate-500 font-mono">${escapeHtml(a.phone_number || '')}</div>
          </td>
          <td class="font-mono text-purple-300">${escapeHtml(a.tenant_code || '—')}</td>
          <td class="text-slate-300 text-xs">${escapeHtml(a.property_name || '—')}</td>
          <td class="text-slate-400 text-xs font-mono">${fmtDate(a.move_in_date)}</td>
          <td class="text-slate-400 text-xs font-mono">${fmtDate(a.move_out_date)}</td>
          <td class="font-mono text-xs">${escapeHtml(a.exit_invoice_number || '—')}</td>
          <td class="font-mono text-right">KES ${Number(a.deposit_paid || 0).toLocaleString()}</td>
          <td class="font-mono text-right text-cyan-400">KES ${Number(a.deposit_refund || 0).toLocaleString()}</td>
          <td class="text-xs text-slate-400 max-w-[180px] truncate">${escapeHtml(a.exit_reason || '—')}</td>
          <td>
            <div class="flex gap-1">
              <button type="button" class="action-btn !py-1 !px-2 text-xs" data-archive-view="${a.id}">View</button>
              <button type="button" class="action-btn action-btn-danger !py-1 !px-2 text-xs" data-archive-del="${a.id}">Delete</button>
            </div>
          </td>
        </tr>`).join('');
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center py-6 text-rose-400">${escapeHtml(err.message)}</td></tr>`;
    if (countEl) countEl.textContent = 'Error';
  }
}

async function loadOccupancyHistory() {
  const house = document.getElementById('occupancy-house').value;
  const tbody = document.getElementById('occupancy-tbody');
  if (!tbody) return;
  if (!house) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center py-6 text-slate-500">Select a property to view occupancy history.</td></tr>';
    return;
  }
  try {
    const { history } = await api.occupancyHistory(house);
    if (!history.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center py-6 text-slate-500">No occupancy records for this property.</td></tr>';
      return;
    }
    tbody.innerHTML = history.flatMap(u => u.occupants.map((o, i) => `
      <tr class="${o.status === 'Current' ? 'bg-emerald-500/5' : ''}">
        <td class="font-mono text-purple-300">${escapeHtml(u.unit_code || '—')}</td>
        <td class="text-white font-semibold">${escapeHtml(o.tenant_name || o.name || '—')}</td>
        <td>${statusBadge(o.status)}</td>
        <td class="text-xs font-mono text-slate-400">${fmtDate(o.move_in_date)}</td>
        <td class="text-xs font-mono text-slate-400">${fmtDate(o.move_out_date)}</td>
        <td class="text-xs font-mono text-slate-500">${o.status === 'Current' ? '—' : (o.exit_invoice_number ? o.exit_invoice_number : '')}</td>
      </tr>`).join('')).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-rose-400">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function openArchiveDetail(id) {
  const modal = document.getElementById('archive-detail-modal');
  const body = document.getElementById('archive-detail-body');
  if (!modal || !body) return;
  modal.classList.remove('hidden');
  body.innerHTML = '<p class="text-slate-400">Loading…</p>';
  try {
    const { archive: a } = await api.archive(id);
    const pays = Array.isArray(a.payments) ? a.payments : [];
    const pens = Array.isArray(a.penalties) ? a.penalties : [];
    const msgs = Array.isArray(a.message_logs) ? a.message_logs : [];
    const docs = Array.isArray(a.documents) ? a.documents : [];
    const stmts = Array.isArray(a.statements) ? a.statements : [];
    const exitInv = a.exit_invoice ? (typeof a.exit_invoice === 'string' ? JSON.parse(a.exit_invoice) : a.exit_invoice) : null;
    const fin = a.financial_snapshot ? (typeof a.financial_snapshot === 'string' ? JSON.parse(a.financial_snapshot) : a.financial_snapshot) : null;
    setTextEl('archive-detail-title', `Archived Tenancy — ${a.tenant_name}`);
    setTextEl('archive-detail-sub', `Unit ${a.tenant_code} · ${a.property_name || '—'} · Archived ${a.archived_at ? new Date(a.archived_at).toLocaleString() : '—'}`);

    const ksh = (v) => `KES ${Number(v || 0).toLocaleString()}`;
    body.innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">Phone</p><p class="font-mono text-sm">${escapeHtml(a.phone_number || '—')}</p>
        </div>
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">National ID</p><p class="font-mono text-sm">${escapeHtml(a.national_id || '—')}</p>
        </div>
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">Move In</p><p class="font-mono text-sm">${fmtDate(a.move_in_date)}</p>
        </div>
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">Move Out</p><p class="font-mono text-sm">${fmtDate(a.move_out_date)}</p>
        </div>
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">Rent</p><p class="font-mono text-sm text-green-400">${ksh(a.rent_amount)}</p>
        </div>
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">Deposit Paid</p><p class="font-mono text-sm text-cyan-400">${ksh(a.deposit_paid)}</p>
        </div>
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">Deposit Refund</p><p class="font-mono text-sm text-cyan-400">${ksh(a.deposit_refund)}</p>
        </div>
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">Final Balance</p><p class="font-mono text-sm ${a.final_balance > 0 ? 'text-rose-400' : 'text-green-400'}">${ksh(a.final_balance)}</p>
        </div>
      </div>

      ${a.exit_reason ? `<div class="bg-slate-900 border border-slate-700 rounded p-3">
        <p class="text-xs text-slate-500 font-mono">Exit Reason</p><p class="text-sm">${escapeHtml(a.exit_reason)}</p>
      </div>` : ''}

      ${exitInv ? `<div class="bg-slate-900 border border-slate-700 rounded p-3">
        <p class="text-xs text-slate-500 font-mono mb-2">Exit Invoice ${escapeHtml(exitInv.exit_number || a.exit_invoice_number || '')}</p>
        <table class="w-full text-sm cyber-table">
          <thead><tr><th>Item</th><th class="text-right">Amount</th></tr></thead>
          <tbody>${(exitInv.lines || []).map(l => `<tr><td>${escapeHtml(l.description || l.category || '—')}</td><td class="text-right font-mono">${ksh(l.amount)}</td></tr>`).join('')}
          </tbody>
          <tfoot>
            <tr><td class="text-slate-400">Total Deductions</td><td class="text-right font-mono text-rose-400">${ksh(exitInv.deductions_total)}</td></tr>
            <tr><td class="text-slate-400">Outstanding Balance</td><td class="text-right font-mono">${ksh(exitInv.outstanding_balance)}</td></tr>
            <tr class="font-bold"><td class="text-white">Final Settlement</td><td class="text-right font-mono text-green-400">${ksh(exitInv.final_settlement)}</td></tr>
          </tfoot>
        </table>
      </div>` : ''}

      <div id="archive-dr-section" class="bg-slate-900 border border-slate-700 rounded p-3 hidden">
        <p class="text-xs text-slate-500 font-mono mb-2">Deposit Refund</p>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm font-mono">
          <div>Deposit Paid: <span class="text-cyan-400" id="arch-dr-deposit">KES 0</span></div>
          <div>Deductions: <span class="text-rose-400" id="arch-dr-deductions">KES 0</span></div>
          <div>Refundable: <span class="text-green-400" id="arch-dr-refundable">KES 0</span></div>
          <div>Status: <span class="font-bold" id="arch-dr-status">—</span></div>
          <div>Due Date: <span class="text-amber-400" id="arch-dr-due">—</span></div>
          <div>Refunded: <span class="text-green-400" id="arch-dr-refunded">KES 0</span></div>
          <div>Method: <span class="text-slate-300" id="arch-dr-method">—</span></div>
          <div>Reference: <span class="text-cyan-400" id="arch-dr-ref">—</span></div>
        </div>
      </div>

      ${fin ? `<div class="bg-slate-900 border border-slate-700 rounded p-3">
        <p class="text-xs text-slate-500 font-mono mb-2">Financial Snapshot</p>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm font-mono">
          <div>Deposit: <span class="text-cyan-400">${ksh(fin.deposit_amount)}</span></div>
          <div>Deposit Paid: <span class="text-cyan-400">${ksh(fin.deposit_paid)}</span></div>
          <div>Credit: <span class="text-cyan-400">${ksh(fin.credit_balance)}</span></div>
          <div>Advance Rent: <span class="text-purple-400">${ksh(fin.advance_rent_balance)}</span></div>
        </div>
      </div>` : ''}

      <div class="glass-panel overflow-x-auto">
        <div class="p-3 border-b border-slate-700"><h4 class="font-orbitron text-white">Payments (${pays.length})</h4></div>
        <table class="data-grid w-full min-w-[500px]">
          <thead><tr><th>Receipt</th><th>Amount</th><th>Type</th><th>Date</th><th>Ref</th></tr></thead>
          <tbody>${pays.length ? pays.map(p => `<tr>
            <td class="font-mono text-xs text-cyan-400">${escapeHtml(p.receipt_number || '—')}</td>
            <td class="font-mono text-green-400">${ksh(p.amount)}</td>
            <td class="text-xs">${escapeHtml(p.payment_type || 'rent')}</td>
            <td class="text-xs font-mono text-slate-400">${fmtDate(p.payment_date)}</td>
            <td class="text-xs font-mono">${escapeHtml(p.mpesa_reference || '—')}</td>
          </tr>`).join('') : '<tr><td colspan="5" class="text-center py-4 text-slate-500">No payments</td></tr>'}
          </tbody>
        </table>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="glass-panel overflow-x-auto">
          <div class="p-3 border-b border-slate-700"><h4 class="font-orbitron text-white">Invoices / Penalties (${pens.length})</h4></div>
          <table class="data-grid w-full">
            <thead><tr><th>No</th><th>Desc</th><th class="text-right">Amount</th><th>Status</th></tr></thead>
            <tbody>${pens.length ? pens.map(p => `<tr>
              <td class="font-mono text-xs">${escapeHtml(p.invoice_number || '—')}</td>
              <td class="text-xs">${escapeHtml(p.description || '—')}</td>
              <td class="font-mono text-right">${ksh(p.amount)}</td>
              <td class="text-xs">${escapeHtml(p.status || '—')}</td>
            </tr>`).join('') : '<tr><td colspan="4" class="text-center py-4 text-slate-500">None</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="glass-panel overflow-x-auto">
          <div class="p-3 border-b border-slate-700"><h4 class="font-orbitron text-white">Messages (${msgs.length})</h4></div>
          <table class="data-grid w-full">
            <thead><tr><th>Type</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>${msgs.length ? msgs.map(m => `<tr>
              <td class="text-xs">${escapeHtml(m.message_type || '—')}</td>
              <td class="text-xs">${escapeHtml(m.status || '—')}</td>
              <td class="text-xs font-mono text-slate-400">${m.sent_at ? new Date(m.sent_at).toLocaleDateString() : '—'}</td>
            </tr>`).join('') : '<tr><td colspan="3" class="text-center py-4 text-slate-500">None</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      ${docs.length ? `<div class="bg-slate-900 border border-slate-700 rounded p-3">
        <p class="text-xs text-slate-500 font-mono mb-2">Documents (${docs.length})</p>
        <div class="flex flex-wrap gap-2 text-xs font-mono">${docs.map(d => (d.id && d.file_path)
          ? `<button type="button" class="bg-slate-800 rounded px-2 py-1 text-sky-400 hover:text-sky-300 underline-offset-2 hover:underline" data-doc-dl="${d.id}" title="Download this tenancy's document">${escapeHtml(d.doc_number || d.filename || d.doc_type || 'Document')} ⬇</button>`
          : `<span class="bg-slate-800 rounded px-2 py-1">${escapeHtml(d.doc_number || d.document_number || d.filename || d.doc_type || '—')}</span>`
        ).join('')}</div>
      </div>` : ''}

      ${stmts.length ? `<div class="bg-slate-900 border border-slate-700 rounded p-3">
        <p class="text-xs text-slate-500 font-mono mb-2">Statements (${stmts.length})</p>
        <p class="text-sm">${stmts.map(s => escapeHtml(s.statement_number || s.id || 'statement')).join(', ')}</p>
      </div>` : ''}`;

    // Document downloads: rows bound to this tenancy keep their files.
    body.querySelectorAll('[data-doc-dl]').forEach((btn) => {
      btn.addEventListener('click', () => downloadDocumentFile({ id: btn.getAttribute('data-doc-dl') }));
    });

    // Deposit refund for THIS tenancy: prefer the row bound to this archive
    // (server-provided), then archive_id / exit-invoice matches — never a
    // plain tenant_code match, which could hit a later tenant's refund.
    let dr = a.deposit_refund_row || null;
    if (!dr && a.tenant_code) {
      try {
        const { refunds } = await api.listDepositRefunds({ tenant: a.tenant_code, sort: 'newest' });
        dr = (exitInv && refunds.find((r) => r.exit_invoice_id === exitInv.id))
          || refunds.find((r) => r.archive_id === a.id)
          || null;
      } catch (_) {}
    }
    if (dr) {
      document.getElementById('archive-dr-section')?.classList.remove('hidden');
      setTextEl('arch-dr-deposit', ksh(dr.deposit_paid));
      setTextEl('arch-dr-deductions', ksh(dr.deductions_total));
      setTextEl('arch-dr-refundable', ksh(dr.refundable_amount));
      const statusMap = { pending: 'Pending', due_soon: 'Due Soon', due_today: 'Due Today', overdue: 'Overdue', refunded: 'Refunded', partially_refunded: 'Partially Refunded', no_refund_due: 'No Refund Due' };
      const sEl = document.getElementById('arch-dr-status');
      sEl.textContent = statusMap[dr.refund_status] || dr.refund_status;
      sEl.className = 'font-bold ' + (dr.refund_status === 'refunded' ? 'text-green-400' : dr.refund_status === 'overdue' ? 'text-rose-400' : 'text-amber-400');
      setTextEl('arch-dr-due', fmtDate(dr.refund_due_date));
      setTextEl('arch-dr-refunded', ksh(dr.amount_refunded));
      setTextEl('arch-dr-method', dr.payment_method || '—');
      setTextEl('arch-dr-ref', dr.transaction_reference || '—');
    } else {
      document.getElementById('archive-dr-section')?.classList.add('hidden');
    }
  } catch (err) {
    body.innerHTML = `<p class="text-rose-400">${escapeHtml(err.message)}</p>`;
  }
}

// Complete financial history of ONE archived tenancy: tenant/tenancy info,
// chronological payments with per-charge allocations and balance before/after
// each payment, full summary, and a link to the tenancy's final Exit Invoice.
async function openTenancyHistory(archiveId) {
  const modal = document.getElementById('tenancy-history-modal');
  const wrap = document.getElementById('th-payments-wrap');
  if (!modal || !wrap) return;
  modal.classList.remove('hidden');
  setTextEl('th-title', 'Tenancy Payment History');
  setTextEl('th-sub', 'Loading…');
  document.getElementById('th-info').innerHTML = '';
  document.getElementById('th-summary').innerHTML = '';
  wrap.innerHTML = '<p class="text-slate-400">Loading records…</p>';
  document.getElementById('th-charges-wrap').innerHTML = '';
  document.getElementById('th-count').textContent = '';
  document.getElementById('th-note').textContent = '';
  const exitBtn = document.getElementById('btn-th-exit-invoice');
  if (exitBtn) exitBtn.style.display = 'none';

  try {
    const { history: h } = await api.archiveHistory(archiveId);
    const t = h.tenancy;
    const s = h.summary;
    const ksh = (v) => `KES ${Number(v || 0).toLocaleString()}`;
    window._thContext = { ...t, exit_invoice: h.exit_invoice };

    setTextEl('th-title', `Payment History — ${t.tenant_name || '—'}`);
    setTextEl('th-sub', `${t.unit || '—'} · ${t.property_name || '—'} · ${fmtDate(t.move_in_date)} → ${fmtDate(t.move_out_date)} · Tenancy #${t.id}`);
    if (h.exit_invoice && exitBtn) exitBtn.style.display = '';

    const info = [
      ['Tenant', escapeHtml(t.tenant_name || '—')],
      ['Unit', escapeHtml(String(t.unit || '—'))],
      ['Property', escapeHtml(t.property_name || '—')],
      ['Status', escapeHtml(t.status || 'Archived')],
      ['Move-in Date', fmtDate(t.move_in_date)],
      ['Move-out Date', fmtDate(t.move_out_date)],
      ['Monthly Rent', ksh(t.rent_amount)],
      ['Deposit Paid', ksh(t.deposit_paid)],
      ['Water Deposit', t.water_deposit != null ? ksh(t.water_deposit) : '—'],
      ['Exit Date', fmtDate(t.exit_date)],
      ['Exit Reason', escapeHtml(t.exit_reason || '—')],
      ['Archived', `${fmtDate(String(t.archived_at || '').slice(0, 10))}${t.archived_by ? ' by ' + escapeHtml(t.archived_by) : ''}`],
    ];
    document.getElementById('th-info').innerHTML = info.map(([label, val]) => `
      <div class="bg-slate-900 border border-slate-700 rounded p-3">
        <p class="text-xs text-slate-500 font-mono">${label}</p>
        <p class="font-mono text-sm text-white break-words">${val}</p>
      </div>`).join('');

    const summary = [
      ['Total Rent Charged', ksh(s.total_rent_charged), 'text-white'],
      ['Total Rent Paid', ksh(s.total_rent_paid), 'text-green-400'],
      ['Total Water Charges', ksh(s.total_water_charges), 'text-white'],
      ['Total Water Paid', ksh(s.total_water_paid), 'text-green-400'],
      ['Total Garbage Charged', ksh(s.total_garbage_charged), 'text-white'],
      ['Total Garbage Paid', ksh(s.total_garbage_paid), 'text-green-400'],
      ['Total Penalties', ksh(s.total_penalties), 'text-amber-400'],
      ['Penalties Paid', ksh(s.total_penalties_paid), 'text-green-400'],
      ['Total Other Charges', ksh(s.total_other_charged), 'text-white'],
      ['Other Charges Paid', ksh(s.total_other_paid), 'text-green-400'],
      ['Deposit Paid', ksh(s.deposit_paid), 'text-cyan-400'],
      ['Deposit Deductions', ksh(s.deposit_deductions), 'text-rose-400'],
      ['Deposit Refundable', ksh(s.deposit_refundable), 'text-cyan-300'],
      ['Deposit Refunded', ksh(s.deposit_refunded), 'text-cyan-300'],
      ['Final Outstanding Balance', ksh(s.final_outstanding), s.final_outstanding > 0 ? 'text-rose-400' : 'text-green-400'],
      ['Final Exit Invoice Amount', h.exit_invoice ? ksh(s.exit_invoice_amount) : '—', 'text-white'],
      ['Total Payments Received', `${ksh(s.total_payments)} (${h.payments.length})`, 'text-green-400'],
      ['Balance After Last Payment', ksh(s.balance_after_last_payment), s.balance_after_last_payment > 0 ? 'text-rose-400' : 'text-green-400'],
    ];
    document.getElementById('th-summary').innerHTML = summary.map(([label, val, cls]) => `
      <div class="bg-slate-900 border border-slate-700 rounded p-3">
        <p class="text-xs text-slate-500 font-mono">${label}</p>
        <p class="font-mono text-sm font-semibold ${cls}">${val}</p>
      </div>`).join('');

    setTextEl('th-count', `${h.payments.length} payment(s) · ${h.charges.length} charge posting(s)`);
    setTextEl('th-note', h.note || '');

    const allocCell = (p) => {
      const a = p.allocations || {};
      const parts = [];
      const push = (label, v) => { if (Number(v) > 0) parts.push(`${label}: ${ksh(v)}`); };
      push('Rent', a.rent); push('Arrears B/F', a.arrears); push('Garbage', a.garbage);
      push('Penalties', a.penalty); push('Maintenance', a.maintenance); push('Other', a.other);
      push('Agreement', a.agreement); push('Water', a.water); push('Deposit', a.deposit); push('Advance/Overpayment', a.advance);
      if (!parts.length) return '<span class="text-slate-500">No allocation recorded (legacy entry)</span>';
      const badge = p.allocation_recorded === false
        ? ' <span class="text-amber-500 text-[10px]">(legacy)</span>' : '';
      return `<div class="text-xs font-mono space-y-0.5">${parts.map((x) => `<div class="text-slate-300">• ${escapeHtml(x)}</div>`).join('')}${badge}</div>`;
    };

    if (!h.payments.length) {
      wrap.innerHTML = '<p class="text-slate-400">No payments recorded for this tenancy.</p>';
    } else {
      wrap.innerHTML = `
        <table class="data-grid w-full min-w-[880px]">
          <thead><tr>
            <th>Date</th><th>Reference</th><th class="text-right">Amount</th>
            <th>Method</th><th>Type</th><th>Billing Period</th>
            <th>Allocation</th><th class="text-right">Balance Before</th><th class="text-right">Balance After</th>
          </tr></thead>
          <tbody>
            ${h.payments.map((p) => `
              <tr>
                <td class="whitespace-nowrap">${escapeHtml(fmtDate(p.payment_date))}</td>
                <td class="font-mono text-xs">${escapeHtml(p.reference || '—')}</td>
                <td class="text-right font-mono font-semibold">${ksh(p.amount)}</td>
                <td class="text-xs">${escapeHtml(p.payment_mode || '—')}</td>
                <td class="text-xs">${escapeHtml(p.payment_type || '—')}</td>
                <td class="font-mono text-xs">${escapeHtml(p.billing_period || '—')}</td>
                <td>${allocCell(p)}</td>
                <td class="text-right font-mono text-slate-300">${ksh(p.balance_before)}</td>
                <td class="text-right font-mono font-semibold ${p.balance_after > 0 ? 'text-rose-400' : 'text-green-400'}">${ksh(p.balance_after)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }

    const chargesWrap = document.getElementById('th-charges-wrap');
    if (!h.charges.length) {
      chargesWrap.innerHTML = '<p class="text-slate-500 text-sm">No charge postings recorded.</p>';
    } else {
      chargesWrap.innerHTML = `
        <table class="data-grid w-full min-w-[640px]">
          <thead><tr><th>Date</th><th>Type</th><th>Description</th><th class="text-right">Amount</th></tr></thead>
          <tbody>
            ${h.charges.map((c) => `
              <tr>
                <td class="whitespace-nowrap">${escapeHtml(fmtDate(c.date))}</td>
                <td class="text-xs uppercase">${escapeHtml(c.type || '')}</td>
                <td>${escapeHtml(c.label || '')}</td>
                <td class="text-right font-mono">${ksh(c.amount)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }
  } catch (err) {
    wrap.innerHTML = `<p class="text-rose-400">${escapeHtml(err.message)}</p>`;
    setTextEl('th-sub', 'Failed to load history');
  }
}

async function deleteArchiveEntry(id) {
  if (!confirm('Permanently delete this archived tenancy record? This cannot be undone.')) return;
  try {
    await api.deleteArchive(id);
    loadArchive();
  } catch (err) {
    alert(err.message);
  }
}

async function loadPendingOverpayments() {
  const tbody = document.getElementById('pending-op-tbody');
  if (!tbody) return;
  const status = document.getElementById('pending-op-status')?.value || '';
  try {
    const { records } = await api.pendingOverpayments(status || undefined);
    tbody.innerHTML = records.length
      ? records.map((r) => {
          const pending = r.status === 'Pending Allocation';
          const actionCell = pending
            ? `<button type="button" class="qc-btn qc-btn-primary px-2 py-0.5 text-xs" data-op-resolve="${r.id}">Resolve</button>`
            : `<span class="text-xs font-mono text-slate-500">${escapeHtml(r.resolution_type === 'advance_rent' ? 'Advance Rent' : (r.resolution_type === 'credit_balance' ? 'Credit Balance' : 'Resolved'))}</span>`;
          return `<tr>
            <td class="font-mono text-xs text-cyan-400">${escapeHtml(r.tenant_name)}</td>
            <td class="font-mono text-xs">${escapeHtml(r.tenant_code)}${r.unit_code && r.unit_code !== r.tenant_code ? ` · ${escapeHtml(r.unit_code)}` : ''}</td>
            <td class="text-xs">${escapeHtml(r.property_name || '—')}</td>
            <td class="text-right font-mono text-xs">${ksh(r.payment_amount)}</td>
            <td class="text-right font-mono text-xs text-amber-400 font-bold">${ksh(r.overpayment_amount)}</td>
            <td class="font-mono text-xs">${escapeHtml(r.receipt_number || '—')}</td>
            <td class="font-mono text-xs">${escapeHtml(r.transaction_reference || '—')}</td>
            <td class="font-mono text-xs">${fmtDate(r.payment_date)}</td>
            <td>${statusBadge(r.status)}</td>
            <td>${actionCell}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="10" class="text-center py-6 text-slate-500">No pending overpayments found.</td></tr>';
    tbody.querySelectorAll('[data-op-resolve]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = records.find((x) => String(x.id) === btn.dataset.opResolve);
        if (r) openPendingOpResolve(r);
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center py-6 text-rose-400">${escapeHtml(err.message)}</td></tr>`;
  }
}

function openPendingOpResolve(r) {
  const modal = document.getElementById('pending-op-resolve-modal');
  if (!modal) return;
  document.getElementById('pending-op-resolve-id').value = r.id;
  document.getElementById('pending-op-resolve-tenant').textContent = `${r.tenant_name} (${r.tenant_code})`;
  document.getElementById('pending-op-resolve-amount').textContent = ksh(r.overpayment_amount);
  document.getElementById('pending-op-resolve-hint').textContent = '';
  modal.dataset.tenantCode = r.tenant_code;
  modal.dataset.overpayment = r.overpayment_amount;
  modal.style.display = 'flex';
}

async function resolvePendingOp(choice) {
  const modal = document.getElementById('pending-op-resolve-modal');
  const id = document.getElementById('pending-op-resolve-id').value;
  const hint = document.getElementById('pending-op-resolve-hint');
  const tenantCode = modal.dataset.tenantCode || '';
  const overpayment = Number(modal.dataset.overpayment || 0);
  hint.textContent = 'Resolving…';
  try {
    const result = await api.resolvePendingOverpayment(id, { choice });
    modal.style.display = 'none';
    loadPendingOverpayments();
    loadPayments();
    loadDashboard();
    if (tenantCode) loadTenantDashboard(tenantCode);
    const tenantId = result.tenant?.id || '';
    if (tenantId) showOverpaymentReview(result.messageBody, tenantId);
    else loadPendingOverpayments();
  } catch (err) {
    hint.textContent = err.message;
  }
}

document.getElementById('btn-pending-op-advance')?.addEventListener('click', async () => {
  const modal = document.getElementById('pending-op-resolve-modal');
  const overpayment = Number(modal.dataset.overpayment || 0);
  const tenantCode = modal.dataset.tenantCode || '';
  const id = document.getElementById('pending-op-resolve-id').value;
  const tenantId = await getTenantIdForAdvance(tenantCode);
  if (tenantId) {
    modal.style.display = 'none';
    await openAdvanceMonthsModal(tenantId, '', overpayment, tenantCode, id);
  } else {
    resolvePendingOp('advance_rent');
  }
});

async function getTenantIdForAdvance(tenantCode) {
  if (!tenantCode) return null;
  try {
    const t = await api.tenant(tenantCode);
    return t?.tenant?.id || null;
  } catch (_) {
    return null;
  }
}

document.getElementById('btn-pending-op-credit')?.addEventListener('click', () => {
  resolvePendingOp('credit_balance');
});

document.getElementById('btn-pending-op-close')?.addEventListener('click', () => {
  document.getElementById('pending-op-resolve-modal').style.display = 'none';
});

document.getElementById('btn-pending-overpayments-refresh')?.addEventListener('click', loadPendingOverpayments);

document.getElementById('pending-op-status')?.addEventListener('change', loadPendingOverpayments);

async function openMessageModal(tenantId) {
  const modal = document.getElementById('message-modal');
  const form = document.getElementById('message-form');
  const statusEl = document.getElementById('message-status');
  const sendBtn = document.getElementById('btn-send-message');
  
  form.reset();
  statusEl.classList.add('hidden');
  statusEl.textContent = '';
  sendBtn.disabled = false;
  sendBtn.textContent = 'Send via WhatsApp';
  
  document.getElementById('message-tenant-id').value = tenantId;
  modal.classList.remove('hidden');

  try {
    // Profile endpoint (not GET /tenants/:id) — only it computes the live
    // balance summary (arrears + rent due + penalties + shortfalls).
    const { tenant: t, summary } = await api.tenantProfile(tenantId);
    document.getElementById('message-modal-title').textContent = `Send WhatsApp: ${t.name} (${t.tenant_code})`;

    // Populate template dropdown
    const select = document.getElementById('message-template-select');
    if (!templatesCache.length) {
      const { templates } = await api.templates();
      templatesCache = templates;
    }
    select.innerHTML = '<option value="">No template (use custom message)</option>' +
      templatesCache.map((tpl) => `<option value="${tpl.id}">${escapeHtml(tpl.name)}</option>`).join('');

    const handleTemplateChange = (e) => {
      const tplId = e.target.value;
      const bodyTextarea = document.getElementById('message-body');
      if (!tplId) {
        bodyTextarea.value = '';
        return;
      }
      const selectedTpl = templatesCache.find((x) => String(x.id) === String(tplId));
      if (!selectedTpl) return;

      // Auto-capture the client's details + live balance from their profile.
      const money = (v) => Number(v || 0).toLocaleString('en-KE');
      const now = new Date();
      const balancePeriod = now.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
      const noticeDate = `${String(now.getDate()).padStart(2, '0')} ${balancePeriod}`;

      const vars = {
        client_name: t.name || '',
        tenant_code: t.tenant_code || '',
        house_name: t.property_name || '',
        house_number: t.unit_label || t.tenant_code || '',
        tenant_name: t.name || '',
        property_name: t.property_name || '',
        unit_number: t.unit_label || t.tenant_code || '',
        notice_date: noticeDate,
        balance_period: balancePeriod,
        previous_arrears: money(summary?.arrears ?? t.arrears),
        current_rent_due: money(summary?.rent_amount ?? t.rent_amount),
        payments_received: money(summary?.rent_paid_this_month ?? t.rent_paid_this_month),
        total_outstanding_balance: money(summary?.balance),
      };

      let body = selectedTpl.body;
      for (const [key, val] of Object.entries(vars)) {
        body = body.replaceAll(`{{${key}}}`, val);
      }
      bodyTextarea.value = body;
    };
    
    const newSelect = select.cloneNode(true);
    select.parentNode.replaceChild(newSelect, select);
    newSelect.addEventListener('change', handleTemplateChange);
  } catch (err) {
    statusEl.textContent = 'Failed to load tenant info: ' + err.message;
    statusEl.className = 'text-rose-400 text-sm font-mono mt-2';
    statusEl.classList.remove('hidden');
  }
}

async function openPaymentModal() {
  const modal = document.getElementById('payment-modal');
  const select = document.getElementById('payment-tenant-select');
  const { tenants } = await api.tenants();
  select.innerHTML = tenants.map((t) => `<option value="${t.id}">${escapeHtml(t.name)} (${escapeHtml(t.tenant_code)})</option>`).join('');
  document.getElementById('payment-form').reset();
  ['mpesa', 'bank', 'cheque', 'cash'].forEach(m => {
    const el = document.getElementById('payment-fields-' + m);
    if (el) el.classList.add('hidden');
  });
  document.getElementById('payment-datetime-section')?.classList.add('hidden');
  const dtEl = document.getElementById('pay-datetime');
  if (dtEl) {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    dtEl.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
  modal.classList.remove('hidden');
}

async function loadHouses() {
  const tbody = document.getElementById('houses-tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-slate-500">Loading...</td></tr>`;
  try {
    const { houses } = await api.houses();
    housesCache = houses;
    if (!houses.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-slate-500">No houses yet</td></tr>`;
      return;
    }
    tbody.innerHTML = houses.map((h) => renderHouseRow(h)).join('');
  } catch (err) {
    if (!isNetworkError(err)) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-rose-400 text-center py-8">${escapeHtml(err.message)}</td></tr>`;
      return;
    }
    // Offline — houses from the last synced snapshot (read-only).
    const cached = await offlineDb.getAll('houses').catch(() => []);
    if (!cached.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-slate-500">Offline — no synced property data on this device yet.</td></tr>`;
      return;
    }
    housesCache = cached;
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-2 text-amber-500 text-xs font-mono">📴 Offline — showing last synced data (read-only)</td></tr>`
      + cached.map((h) => renderHouseRow(h)).join('');
  }
}

function renderHouseRow(h) {
  const payMethod = h.payment_method === 'till' ? `Till ${escapeHtml(h.till_number || '')}${h.till_name ? ` (${escapeHtml(h.till_name)})` : ''}` : (h.payment_paybill ? `Paybill ${escapeHtml(h.payment_paybill)}` : '—');
  return `<tr data-house-row="${h.id}">
    <td class="font-mono text-purple-300 house-cell-display">${escapeHtml(h.paybill_number)}</td>
    <td class="text-white house-cell-display">${escapeHtml(h.house_name)}</td>
    <td class="font-mono house-cell-display">${escapeHtml(h.total_units)}</td>
    <td class="font-mono text-cyan-300">${Number(h.clients_count || 0)}</td>
    <td class="font-mono house-cell-display" style="font-size:12px">${payMethod}</td>
    <td class="house-cell-display">${escapeHtml(h.notes || '—')}</td>
    <td class="space-x-1 house-row-actions">
      <button type="button" class="action-btn" data-open-house-dashboard="${h.id}">Dashboard</button>
      <button type="button" class="action-btn house-inline-edit-btn" data-inline-edit-house="${h.id}">✏ Edit</button>
      <button type="button" class="action-btn action-btn-danger" data-delete-house="${h.id}">Delete</button>
    </td>
  </tr>`;
}

function activateInlineEdit(houseId) {
  const row = document.querySelector(`tr[data-house-row="${houseId}"]`);
  if (!row) return;
  const h = housesCache.find((x) => String(x.id) === String(houseId));
  if (!h) return;

  const cells = row.querySelectorAll('td.house-cell-display');
  const [payCell, nameCell, unitsCell, notesCell] = cells;

  payCell.innerHTML = `<span class="text-slate-400 font-mono text-xs">${escapeHtml(h.paybill_number)}</span>`;
  nameCell.innerHTML = `<input class="inline-edit-input" data-field="house_name" value="${escapeHtml(h.house_name)}" placeholder="House name" />`;
  unitsCell.innerHTML = `<input class="inline-edit-input inline-edit-input--sm" type="number" min="1" data-field="total_units" value="${h.total_units}" placeholder="Units" />`;
  notesCell.innerHTML = `<input class="inline-edit-input" data-field="notes" value="${escapeHtml(h.notes || '')}" placeholder="Notes (optional)" />`;

  const actionsCell = row.querySelector('td.house-row-actions');
  actionsCell.innerHTML = `
    <button type="button" class="action-btn action-btn-save" data-inline-save-house="${houseId}">💾 Save</button>
    <button type="button" class="action-btn" data-inline-cancel-house="${houseId}">✕ Cancel</button>
  `;

  payCell.querySelector('input')?.focus();
}

async function saveInlineHouseEdit(houseId) {
  const row = document.querySelector(`tr[data-house-row="${houseId}"]`);
  if (!row) return;

  const inputs = row.querySelectorAll('input[data-field]');
  const patch = {};
  let valid = true;

  inputs.forEach((inp) => {
    const field = inp.dataset.field;
    const val = inp.value.trim();
    if (field === 'total_units') {
      const n = Number(val);
      if (!val || isNaN(n) || n < 1) { inp.classList.add('inline-edit-error'); valid = false; }
      else { inp.classList.remove('inline-edit-error'); patch[field] = n; }
    } else if (field === 'paybill_number' || field === 'house_name') {
      if (!val) { inp.classList.add('inline-edit-error'); valid = false; }
      else { inp.classList.remove('inline-edit-error'); patch[field] = val; }
    } else {
      patch[field] = val;
    }
  });

  if (!valid) return;

  const saveBtn = row.querySelector(`[data-inline-save-house="${houseId}"]`);
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    const { house } = await api.updateHouse(houseId, patch);
    const idx = housesCache.findIndex((x) => String(x.id) === String(houseId));
    if (idx !== -1) {
      housesCache[idx] = { ...housesCache[idx], ...house };
      row.outerHTML = renderHouseRow(housesCache[idx]);
    } else {
      await loadHouses();
    }
    await refreshHouseOptions();
  } catch (err) {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Save'; }
    alert(`Save failed: ${err.message}`);
  }
}

function renderDashboardTenantRow(t, isModal) {
  const isVacant = t.status === 'Vacant';
  const name = isVacant ? '—' : t.name;
  const phone = isVacant ? '—' : t.phone_number;
  const payment = isVacant ? '—' : statusBadge(t.payment_state);

  const actionButton = isVacant
    ? `<button type="button" class="qc-btn !py-0.5 !px-1.5 text-[10px] qc-btn-primary" data-house-tenant-occupy="${t.id}">Mark Occupied</button>`
    : `<button type="button" class="action-btn !py-0.5 !px-1.5 text-[10px] action-btn-danger" data-house-tenant-vacant="${t.id}">Mark Vacant</button>`;

  if (isModal) {
    return `<tr>
      <td class="font-mono text-purple-300">
        <div class="flex items-center justify-between gap-2">
          <a href="#tenant/${t.tenant_code}" class="hover:underline text-purple-300 font-semibold" onclick="document.getElementById('house-dashboard-modal').classList.add('hidden')">${escapeHtml(t.tenant_code)}</a>
          ${actionButton}
        </div>
      </td>
      <td class="text-white">${escapeHtml(name)}</td>
      <td class="font-mono text-sm">${escapeHtml(phone)}</td>
      <td>${statusBadge(t.status)}</td>
      <td>${payment}</td>
    </tr>`;
  }

  return `<tr>
    <td class="font-mono text-purple-300">
      <div class="flex items-center justify-between gap-2">
        <a href="#tenant/${t.tenant_code}" class="hover:underline text-purple-300 font-semibold">${escapeHtml(t.tenant_code)}</a>
        ${actionButton}
      </div>
    </td>
    <td class="text-white">${escapeHtml(name)}</td>
    <td class="font-mono text-sm">${escapeHtml(phone)}</td>
    <td>${statusBadge(t.status)}</td>
    <td>${payment}</td>
    <td class="space-x-1">
      ${isVacant ? '' : `<button type="button" class="action-btn action-btn-wa" data-message-tenant="${t.id}">💬 Msg</button>`}
      <button type="button" class="action-btn" data-house-tenant-edit="${t.id}">Edit</button>
      <button type="button" class="action-btn action-btn-danger" data-house-tenant-delete="${t.id}">Delete</button>
    </td>
  </tr>`;
}

async function openHouseDashboard(houseId) {
  const modal = document.getElementById('house-dashboard-modal');
  const tbody = document.getElementById('house-dashboard-tenants-tbody');
  document.getElementById('house-dashboard-title').textContent = 'Building dashboard';
  tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-slate-500">Loading...</td></tr>`;
  modal.classList.remove('hidden');
  try {
    const data = await api.houseDashboard(houseId);
    const b = data.building || {};
    document.getElementById('house-dashboard-title').textContent = `${b.house_name || 'Building'} dashboard`;
    document.getElementById('house-metric-total-houses').textContent = b.total_units ?? 0;
    document.getElementById('house-metric-clients').textContent = b.total_clients ?? 0;
    document.getElementById('house-metric-vacants').textContent = b.vacant_units ?? 0;
    document.getElementById('house-metric-paid').textContent = b.paid_tenants ?? 0;
    document.getElementById('house-metric-unpaid').textContent = b.unpaid_tenants ?? 0;
    const vacantList = data.vacant_units_list || [];
    document.getElementById('house-vacants-list').textContent = vacantList.length
      ? vacantList.map((t) => t.tenant_code).join(', ')
      : 'No vacant units';

    const tenants = data.tenants || [];
    if (!tenants.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-slate-500">No units in this building</td></tr>`;
      return;
    }
    tbody.innerHTML = tenants.map((t) => renderDashboardTenantRow(t, true)).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-slate-500">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadHouseDashboardPage(houseId) {
  if (!houseId) return;
  // Collection position loads independently of the units table (always fresh).
  loadHouseCollection(houseId);
  const titleEl = document.getElementById('house-page-title');
  const subtitleEl = document.getElementById('house-page-subtitle');
  const tenantsTbody = document.getElementById('house-page-tenants-tbody');
  if (!titleEl || !tenantsTbody) return;

  titleEl.textContent = 'House dashboard';
  if (subtitleEl) subtitleEl.textContent = 'Loading…';
  tenantsTbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-slate-500">Loading...</td></tr>`;

  try {
    const [{ house }, dash] = await Promise.all([api.house(houseId), api.houseDashboard(houseId)]);
    const b = dash.building || {};

    titleEl.textContent = `${house.house_name} — ${house.total_units} unit${house.total_units !== 1 ? 's' : ''}`;
    if (subtitleEl) {
      let payLabel = '';
      if (house.payment_method === 'till') {
        payLabel = `Buy Goods Till ${house.till_number || '—'}${house.till_name ? ` (${house.till_name})` : ''}`;
      } else if (house.payment_paybill) {
        const acct = house.account_number_format ? house.account_number_format.replace(/\{\{tenant_code\}\}/g, 'X') : '';
        payLabel = `M-PESA Paybill ${house.payment_paybill}${acct ? `, Account ${acct}` : ''}`;
      } else {
        payLabel = 'M-PESA Paybill — (not configured)';
      }
      subtitleEl.textContent = `House: ${house.paybill_number} | ${payLabel}`;
    }

    document.getElementById('house-page-metric-total-houses').textContent = b.total_units ?? 0;
    document.getElementById('house-page-metric-clients').textContent = b.total_clients ?? 0;
    document.getElementById('house-page-metric-vacants').textContent = b.vacant_units ?? 0;
    document.getElementById('house-page-metric-paid').textContent = b.paid_tenants ?? 0;
    document.getElementById('house-page-metric-unpaid').textContent = b.unpaid_tenants ?? 0;

    // Maintenance metrics
    const m = b.maintenance || {};
    const mEl = document.getElementById('house-page-metric-maintenance');
    const mDetail = document.getElementById('house-page-metric-maintenance-detail');
    if (mEl) mEl.textContent = money(m.total_expenses || 0);
    if (mDetail) mDetail.textContent = `${m.total_issues || 0} issues | Tenant: ${money(m.tenant_responsible || 0)} | Mgmt: ${money(m.management_paid || 0)}`;
    const vacantList = dash.vacant_units_list || [];
    document.getElementById('house-page-vacants-list').textContent = vacantList.length
      ? vacantList.map((t) => t.tenant_code).join(', ')
      : 'No vacant units';

    const tenants = dash.tenants || [];
    if (!tenants.length) {
      tenantsTbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-slate-500">No units in this house</td></tr>`;
      return;
    }
    tenantsTbody.innerHTML = tenants.map((t) => renderDashboardTenantRow(t, false)).join('');
  } catch (err) {
    tenantsTbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-slate-500">${escapeHtml(err.message)}</td></tr>`;
  }
}

// Collection position for the House Dashboard: four live figures computed
// server-side from billing/invoice/payment records for the selected period.
async function loadHouseCollection(houseId) {
  if (!houseId) return;
  const input = document.getElementById('house-collection-period');
  const currentDefault = new Date().toISOString().slice(0, 7);
  if (input && !input.value) input.value = currentDefault;
  const period = (input && input.value) || currentDefault;
  try {
    const { collection: c } = await api.houseCollection(houseId, period);
    setTextEl('hc-period-label', c.period_label || c.period || '—');
    setTextEl('hc-expected', `KES ${Number(c.expected || 0).toLocaleString()}`);
    const expParts = Object.entries(c.expected_by || {})
      .filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Number(v).toLocaleString()}`);
    setTextEl('hc-expected-detail', expParts.length ? expParts.join(' · ') : 'No charges raised in this period');
    setTextEl('hc-collected', `KES ${Number(c.collected || 0).toLocaleString()}`);
    const colParts = (c.collected_by_type || [])
      .filter((x) => Number(x.amount) > 0)
      .map((x) => `${x.type}: ${Number(x.amount).toLocaleString()}`);
    setTextEl('hc-collected-detail', colParts.length ? colParts.join(' · ') : 'No payments received in this period');
    if (Number(c.remaining) < 0) {
      setTextEl('hc-remaining', 'KES 0');
      setTextEl('hc-remaining-note', `Over-collected: KES ${Math.abs(Number(c.remaining)).toLocaleString()}`);
    } else {
      setTextEl('hc-remaining', `KES ${Number(c.remaining || 0).toLocaleString()}`);
      setTextEl('hc-remaining-note', '\u00a0');
    }
    const pct = Number(c.percent || 0);
    setTextEl('hc-pct', `${pct}%`);
    const pctEl = document.getElementById('hc-pct');
    if (pctEl) {
      pctEl.className = `metric-value text-xl mt-1 font-orbitron ${pct >= 90 ? 'text-green-600' : pct >= 60 ? 'text-amber-500' : 'text-rose-500'}`;
    }
  } catch (err) {
    setTextEl('hc-period-label', '—');
    ['hc-expected', 'hc-collected', 'hc-remaining', 'hc-pct'].forEach((id) => setTextEl(id, '—'));
    setTextEl('hc-expected-detail', escapeHtml(err.message));
    setTextEl('hc-collected-detail', '');
    setTextEl('hc-remaining-note', '');
  }
}

function togglePaymentFields() {
  const method = document.getElementById('house-edit-payment-method').value;
  const isTill = method === 'till';
  document.getElementById('house-edit-paybill-group').style.display = isTill ? 'none' : '';
  document.getElementById('house-edit-account-group').style.display = isTill ? 'none' : '';
  document.getElementById('house-edit-till-number-group').style.display = isTill ? '' : 'none';
  document.getElementById('house-edit-till-name-group').style.display = isTill ? '' : 'none';
}

async function openHouseModal(id = null) {
  const form = document.getElementById('house-edit-form');
  form.reset();
  document.getElementById('house-edit-form-id').value = id || '';
  document.getElementById('house-edit-title').textContent = id ? 'Edit house' : 'Add house';
  const paybillInput = document.getElementById('house-edit-paybill-number');
  if (paybillInput) paybillInput.readOnly = !!id;
  if (id) {
    const house = housesCache.find((h) => String(h.id) === String(id)) ||
      await (async () => {
        try { const res = await api.house(id); return res.house; } catch { return null; }
      })();
    if (house) {
      form.paybill_number.value = house.paybill_number;
      form.house_name.value = house.house_name;
      form.total_units.value = house.total_units;
      form.notes.value = house.notes || '';
      document.getElementById('house-edit-payment-method').value = house.payment_method || 'paybill';
      document.getElementById('house-edit-payment-paybill').value = house.payment_paybill || '';
      document.getElementById('house-edit-account-format').value = house.account_number_format || '';
      document.getElementById('house-edit-till-number').value = house.till_number || '';
      document.getElementById('house-edit-till-name').value = house.till_name || '';
      togglePaymentFields();
      loadHouseCharges(house.paybill_number);
    } else {
      loadHouseCharges(null);
    }
  }
  houseEditReturnView = id ? 'house-dashboard' : 'houses';
  showView('house-edit');
}

// ─── House Charges ──────────────────────────────────────────────────────────

let _currentHousePaybill = null;

async function loadHouseCharges(housePaybill) {
  _currentHousePaybill = housePaybill;
  const list = document.getElementById('house-charges-list');
  if (!list) return;
  if (!housePaybill) {
    list.innerHTML = '<p class="text-xs text-slate-400">Save the house first, then add charges.</p>';
    return;
  }
  try {
    const data = await api.houseCharges(housePaybill);
    const charges = data.charges || [];
    if (charges.length === 0) {
      list.innerHTML = '<p class="text-xs text-slate-400">No charges configured. Add one below.</p>';
      return;
    }
    list.innerHTML = charges.map(c => {
      const freqBadge = c.frequency === 'monthly'
        ? '<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-700">Monthly</span>'
        : '<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-700">One-time</span>';
      return `<div class="flex items-center justify-between p-2 rounded-lg ${c.enabled ? 'bg-white border border-orange-200' : 'bg-slate-50 border border-slate-200 opacity-60'}">
        <div class="flex items-center gap-3">
          <button type="button" onclick="toggleHouseChargeUI('${housePaybill}', ${c.id})" class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${c.enabled ? 'bg-orange-500' : 'bg-slate-300'}">
            <span class="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${c.enabled ? 'translate-x-4.5' : 'translate-x-0.5'}" style="transform:translateX(${c.enabled ? '18px' : '2px'})"></span>
          </button>
          <div>
            <span class="font-semibold text-sm ${c.enabled ? 'text-slate-800' : 'text-slate-500'}">${escapeHtml(c.charge_name)}</span>
            <span class="ml-2 text-sm text-slate-600">KES ${Number(c.amount).toLocaleString('en-KE')}</span>
            <span class="ml-2">${freqBadge}</span>
          </div>
        </div>
        <button type="button" onclick="deleteHouseChargeUI('${housePaybill}', ${c.id})" class="text-red-400 hover:text-red-600 text-xs">Delete</button>
      </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = '<p class="text-xs text-red-400">Failed to load charges</p>';
  }
}

async function toggleHouseChargeUI(housePaybill, chargeId) {
  try {
    await api.toggleHouseCharge(housePaybill, chargeId);
    loadHouseCharges(housePaybill);
  } catch (err) {
    alert('Failed to toggle charge');
  }
}

async function deleteHouseChargeUI(housePaybill, chargeId) {
  if (!confirm('Delete this charge?')) return;
  try {
    await api.deleteHouseCharge(housePaybill, chargeId);
    loadHouseCharges(housePaybill);
  } catch (err) {
    alert('Failed to delete charge');
  }
}

async function saveHouseCharge() {
  if (!_currentHousePaybill) return alert('Save the house first before adding charges.');
  const name = document.getElementById('hc-add-name')?.value?.trim();
  const amount = Number(document.getElementById('hc-add-amount')?.value || 0);
  const frequency = document.getElementById('hc-add-frequency')?.value || 'one-time';
  if (!name) return alert('Charge name is required');
  try {
    await api.createHouseCharge(_currentHousePaybill, { charge_name: name, amount, frequency, enabled: true });
    document.getElementById('house-charge-add-form')?.classList.add('hidden');
    document.getElementById('hc-add-name').value = '';
    document.getElementById('hc-add-amount').value = '';
    loadHouseCharges(_currentHousePaybill);
  } catch (err) {
    alert('Failed to create charge');
  }
}

document.getElementById('btn-add-house-charge')?.addEventListener('click', () => {
  document.getElementById('house-charge-add-form')?.classList.toggle('hidden');
});

async function loadTemplates() {
  const { templates } = await api.templates();
  templatesCache = templates;
  const select = document.getElementById('broadcast-template-select');
  if (select) {
    select.innerHTML = `<option value="">No template (use custom message)</option>${templates
      .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
      .join('')}`;
  }
  const list = document.getElementById('templates-list');
  if (list) {
    list.innerHTML = templates
      .map(
        (t) => `<div class="p-4 border border-slate-300 rounded bg-white shadow-sm">
          <div class="flex items-start justify-between gap-2 mb-2">
            <h4 class="text-lg font-bold text-slate-800">${escapeHtml(t.name)}</h4>
            <div class="space-x-1 shrink-0">
              <button type="button" class="action-btn" data-edit-template="${t.id}">Edit</button>
              <button type="button" class="action-btn action-btn-danger" data-delete-template="${t.id}">Delete</button>
            </div>
          </div>
          <p class="text-sm text-slate-600">${escapeHtml(t.body)}</p>
        </div>`
      )
      .join('');
  }
}

async function loadBroadcastCenter() {
  await refreshHouseOptions();
  await loadTemplates();
  toggleBroadcastHouseSelect();
}

function toggleBroadcastHouseSelect() {
  const type = document.getElementById('broadcast-target-type')?.value;
  const sel = document.getElementById('broadcast-house-select');
  if (!sel) return;
  sel.disabled = type !== 'house';
}

function openTemplateModal(id = null) {
  const modal = document.getElementById('template-modal');
  const form = document.getElementById('template-form');
  form.reset();
  document.getElementById('template-form-id').value = id || '';
  document.getElementById('template-modal-title').textContent = id ? 'Edit template' : 'Add template';
  if (id) {
    const tpl = templatesCache.find((t) => String(t.id) === String(id));
    if (tpl) {
      form.name.value = tpl.name;
      form.body.value = tpl.body;
    }
  }
  modal.classList.remove('hidden');
}

function startPolls() {
  if (metricsPoll) clearInterval(metricsPoll);
  if (waPoll) clearInterval(waPoll);
  metricsPoll = setInterval(() => {
    if (currentView === 'dashboard') loadDashboard();
  }, 30000);
  waPoll = setInterval(() => {
    if (currentView === 'whatsapp') refreshWhatsappBeacon();
  }, 4000);
}

function stopPolls() {
  clearInterval(metricsPoll);
  clearInterval(waPoll);
  metricsPoll = null;
  waPoll = null;
}

async function initSession() {
  if (!api.getToken()) {
    showView('login');
    finishBoot();
    return;
  }
  try {
    const { user } = await api.me();
    api.setUser(user);
    stampSession();
    document.getElementById('nav-username').textContent = user.display_name || user.username;
    if (document.getElementById('nav-username-mobile')) document.getElementById('nav-username-mobile').textContent = user.display_name || user.username;
    if (document.getElementById('nav-role-mobile')) document.getElementById('nav-role-mobile').textContent = (user.role || 'operator').toUpperCase();
    document.getElementById('nav-users-link')?.classList.toggle('hidden', !isAdmin());
    document.getElementById('nav-settings-link')?.classList.toggle('hidden', !isAdmin());
    document.getElementById('nav-conflicts-link')?.classList.toggle('hidden', !isAdmin());
    const routed = applyRoute();
    if (!routed) showView('dashboard');
    startPolls();
    // Refresh the on-device snapshot while we are online.
    pullSnapshot().catch(() => {});
    finishBoot();
  } catch (err) {
    console.error('Session initialization failed:', err);
    if (err.status === 401 || err.status === 403) {
      api.logout();
      clearSessionStamp();
      showView('login');
      finishBoot();
    } else if (hasUsableOfflineSession()) {
      // No internet, but the agent logged in within the last 7 days:
      // boot offline from the cached session + last synced data.
      const user = api.getUser();
      try {
        document.getElementById('nav-username').textContent = (user && (user.display_name || user.username)) || 'Offline agent';
        if (document.getElementById('nav-username-mobile')) document.getElementById('nav-username-mobile').textContent = (user && (user.display_name || user.username)) || 'Offline agent';
        if (document.getElementById('nav-role-mobile')) document.getElementById('nav-role-mobile').textContent = ((user && user.role) || 'operator').toUpperCase();
        document.getElementById('nav-users-link')?.classList.toggle('hidden', !isAdmin());
    document.getElementById('nav-settings-link')?.classList.toggle('hidden', !isAdmin());
        document.getElementById('nav-conflicts-link')?.classList.toggle('hidden', !isAdmin());
      } catch (_) {}
      showToast(`Offline mode — session valid for ${offlineSessionDaysLeft()} more day(s). Showing last synced data.`, 'error');
      const routed = applyRoute();
      if (!routed) showView('dashboard');
      finishBoot();
    } else {
      const routed = applyRoute();
      if (!routed) showView('dashboard');
      finishBoot();
    }
  }
}

document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  try {
    const result = await api.login(
      document.getElementById('username').value.trim(),
      document.getElementById('password').value
    );
    api.setToken(result.token);
    api.setUser(result.user);
    stampSession();
    document.getElementById('nav-username').textContent = result.user.display_name || result.user.username;
    if (document.getElementById('nav-username-mobile')) document.getElementById('nav-username-mobile').textContent = result.user.display_name || result.user.username;
    if (document.getElementById('nav-role-mobile')) document.getElementById('nav-role-mobile').textContent = (result.user.role || 'operator').toUpperCase();
    document.getElementById('nav-users-link')?.classList.toggle('hidden', !isAdmin());
    document.getElementById('nav-settings-link')?.classList.toggle('hidden', !isAdmin());
    document.getElementById('nav-conflicts-link')?.classList.toggle('hidden', !isAdmin());
    const routed = applyRoute();
    if (!routed) showView('dashboard');
    startPolls();
    // Seed the on-device cache right after login for offline use.
    pullSnapshot().catch(() => {});
    showToast(`Welcome back, ${result.user.display_name || result.user.username} ✓`);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('logout-btn')?.addEventListener('click', () => {
  api.logout();
  clearSessionStamp();
  stopPolls();
  activeHouseId = null;
  setHash('#');
  showView('login');
});

document.getElementById('logout-btn-mobile')?.addEventListener('click', () => {
  api.logout();
  clearSessionStamp();
  stopPolls();
  activeHouseId = null;
  setHash('#');
  showView('login');
});

document.querySelectorAll('[data-nav]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    activeHouseId = null;
    setHash('#');
    showView(a.dataset.nav);
    
    // Auto-hide mobile menu
    const container = document.getElementById('nav-container');
    if (container && window.innerWidth < 1024) {
      container.classList.add('-translate-x-full');
      document.getElementById('mobile-menu-backdrop')?.classList.add('hidden');
    }
  });
});

document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
  document.getElementById('nav-container')?.classList.remove('-translate-x-full');
  document.getElementById('mobile-menu-backdrop')?.classList.remove('hidden');
});

document.getElementById('mobile-close-btn')?.addEventListener('click', () => {
  document.getElementById('nav-container')?.classList.add('-translate-x-full');
  document.getElementById('mobile-menu-backdrop')?.classList.add('hidden');
});

document.getElementById('mobile-menu-backdrop')?.addEventListener('click', () => {
  document.getElementById('nav-container')?.classList.add('-translate-x-full');
  document.getElementById('mobile-menu-backdrop')?.classList.add('hidden');
});

// ============================================================
// SIDEBAR TOGGLE (Desktop, lg+)
// ============================================================
(function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebar-toggle');
  if (!sidebar || !toggle) return;

  // Restore saved state
  const saved = localStorage.getItem('rental_sidebar_collapsed');
  if (saved === 'true') {
    sidebar.classList.add('collapsed');
  }

  toggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    localStorage.setItem('rental_sidebar_collapsed', sidebar.classList.contains('collapsed'));
  });
})();

document.querySelectorAll('.nav-jump').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.nav));
});

// Dashboard metric cards / collection panel → open the records behind the
// figure (Total Tenants jumps to the existing Tenants on Board list).
document.querySelectorAll('[data-drill]').forEach((el) => {
  const fire = () => {
    const kind = el.dataset.drill;
    if (kind === 'tenants') { showView('tenants'); return; }
    openDashDrill(kind);
  };
  el.addEventListener('click', fire);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
  });
});
document.getElementById('dash-drill-close')?.addEventListener('click', () => {
  document.getElementById('dash-drill-modal')?.classList.add('hidden');
});
document.getElementById('dash-drill-modal')?.addEventListener('click', (e) => {
  const modal = document.getElementById('dash-drill-modal');
  if (!modal) return;
  if (e.target === modal) modal.classList.add('hidden');
  // Tenant account link → close the overlay so the tenant dashboard is visible
  else if (e.target.closest?.('a[data-tenant-link]')) modal.classList.add('hidden');
});

document.getElementById('btn-add-tenant')?.addEventListener('click', () => openTenantModal());
document.getElementById('btn-add-tenant-dash')?.addEventListener('click', () => openTenantModal());
document.getElementById('btn-add-house')?.addEventListener('click', () => openHouseModal());
document.getElementById('btn-add-template')?.addEventListener('click', () => openTemplateModal());
document.getElementById('tenant-modal-cancel')?.addEventListener('click', () => {
  document.getElementById('tenant-modal').classList.add('hidden');
});
document.getElementById('btn-house-edit-back')?.addEventListener('click', () => {
  if (houseEditReturnView === 'house-dashboard') showView('house-dashboard');
  else showView('houses');
});

document.getElementById('btn-house-edit-cancel')?.addEventListener('click', () => {
  if (houseEditReturnView === 'house-dashboard') showView('house-dashboard');
  else showView('houses');
});
document.getElementById('house-dashboard-close')?.addEventListener('click', () => {
  document.getElementById('house-dashboard-modal').classList.add('hidden');
});
document.getElementById('template-modal-cancel')?.addEventListener('click', () => {
  document.getElementById('template-modal').classList.add('hidden');
});

// First billing method toggle
document.getElementById('tenant-first-billing-method')?.addEventListener('change', (e) => {
  const method = e.target.value;
  const chargeField = document.getElementById('first-billing-charge-field');
  const daysField = document.getElementById('first-billing-days-field');
  const reasonField = document.getElementById('first-billing-reason-field');
  const chargeLabel = document.getElementById('first-billing-charge-label');
  const rentInput = document.querySelector('#tenant-form input[name="rent_amount"]');

  chargeField?.classList.toggle('hidden', !method);
  daysField?.classList.toggle('hidden', method !== 'chargeable_days');
  reasonField?.classList.toggle('hidden', method !== 'custom');

  if (method === 'half_month' && rentInput) {
    const rent = Number(rentInput.value || 0);
    const chargeInput = document.querySelector('#tenant-form input[name="first_billing_charge"]');
    if (chargeInput && !chargeInput.value) chargeInput.value = Math.round(rent / 2);
    if (chargeLabel) chargeLabel.textContent = 'Half-Month Charge (KES)';
  } else if (method === 'chargeable_days' && rentInput) {
    if (chargeLabel) chargeLabel.textContent = 'First Billing Cycle Charge (KES)';
  } else if (method === 'custom') {
    if (chargeLabel) chargeLabel.textContent = 'Custom First-Month Charge (KES)';
  }
});

document.getElementById('tenant-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = document.getElementById('tenant-form-id').value;
  const openingArrears = Number(form.arrears?.value || 0);
  const openingAdvance = Number(form.opening_advance_rent?.value || 0);
  if (!id && openingArrears > 0 && openingAdvance > 0) {
    alert('A new tenant cannot have both Opening Arrears and Opening Advance Rent at the same time.');
    return;
  }
  const agreementCharge = Number(form.agreement_charge?.value || 0);
  const agreementPaid = Number(form.agreement_paid?.value || 0);
  if (agreementPaid > agreementCharge) {
    alert('Agreement Paid cannot exceed Agreement Charge.');
    return;
  }
  const body = {
    name: form.name.value,
    tenant_code: form.tenant_code.value.trim(),
    phone_number: form.phone_number.value.trim(),
    national_id: form.national_id?.value.trim() || null,
    guardian_name: form.guardian_name?.value.trim() || null,
    guardian_id: form.guardian_id?.value.trim() || null,
    guardian_phone: form.guardian_phone?.value.trim() || null,
    guardian_relationship: form.guardian_relationship?.value.trim() || null,
    house_id: form.house_id.value,
    rent_amount: Number(form.rent_amount.value),
    standard_monthly_rent: form.standard_monthly_rent?.value ? Number(form.standard_monthly_rent.value) : null,
    first_billing_method: form.first_billing_method?.value || null,
    first_billing_charge: form.first_billing_charge?.value ? Number(form.first_billing_charge.value) : null,
    first_billing_days: form.first_billing_days?.value ? Number(form.first_billing_days.value) : null,
    first_billing_reason: form.first_billing_reason?.value.trim() || null,
    deposit_amount: Number(form.deposit_amount?.value || 0),
    deposit_paid: Number(form.deposit_paid?.value || 0),
    garbage_fee_amount: Number(form.garbage_fee_amount?.value || 0),
    water_charge_amount: Number(form.water_charge_amount?.value || 0),
    water_charge_paid: Number(form.water_charge_paid?.value || 0),
    arrears: openingArrears,
    arrears_manually_set: openingArrears > 0,
    opening_advance_rent: openingAdvance,
    agreement_charge: agreementCharge,
    agreement_paid: agreementPaid,
    move_in_date: form.move_in_date?.value || null,
    rent_due_date: form.rent_due_date.value,
    rent_due_time: form.rent_due_time.value,
    status: form.status.value,
  };
  try {
    // New tenant registrations and edits need live validation (codes,
    // duplicates) — online only. Move-in (Mark Occupied) works offline.
    if (effectiveOffline() && !(id && form.dataset.occupyMode === '1')) {
      alert('Adding or editing tenant records requires an internet connection. Move-in (Mark Occupied) and payments work offline.');
      return;
    }
    if (id && form.dataset.occupyMode === '1') {
      // Mark Occupied: backend resets the previous tenancy's financial rows
      // (preserved in the archive) and registers the new tenant on this unit.
        delete body.house_id;
        delete body.status;
        delete body.deposit_paid;
        delete body.water_charge_paid;
      // Offline move-in queues the occupation (PENDING SYNC). On sync the
      // server applies it if the unit is still vacant, else SYNC FAILED.
      if (effectiveOffline()) {
        const clientTxnId = offlineDb.newClientTxnId();
        await queueOutboxOp({ type: 'tenant_occupy', payload: { tenant_id: id, body, client_txn_id: clientTxnId } });
        document.getElementById('tenant-modal').classList.add('hidden');
        showToast('Move-in saved offline (PENDING SYNC)');
        try { await loadTenants(); } catch (_) {}
        return;
      }
      await api.markOccupied(id, body);
    } else if (id) {
      await api.updateTenant(id, body);
    } else {
      await api.createTenant(body);
    }
    document.getElementById('tenant-modal').classList.add('hidden');
    loadTenants();
    if (currentView === 'dashboard') loadDashboard();
    if (currentView === 'house-dashboard') loadHouseDashboardPage(activeHouseId);
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('house-edit-payment-method')?.addEventListener('change', togglePaymentFields);

document.getElementById('house-edit-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = document.getElementById('house-edit-form-id').value;
  const body = {
    paybill_number: form.paybill_number.value.trim(),
    house_name: form.house_name.value.trim(),
    total_units: Number(form.total_units.value),
    notes: form.notes.value.trim(),
    garbage_fee_enabled: form.garbage_fee_enabled?.checked || false,
    payment_method: document.getElementById('house-edit-payment-method').value,
    payment_paybill: document.getElementById('house-edit-payment-paybill').value.trim() || null,
    account_number_format: document.getElementById('house-edit-account-format').value.trim() || null,
    till_number: document.getElementById('house-edit-till-number').value.trim() || null,
    till_name: document.getElementById('house-edit-till-name').value.trim() || null,
  };
  try {
    if (id) await api.updateHouse(id, body);
    else await api.createHouse(body);
    if (houseEditReturnView === 'house-dashboard') showView('house-dashboard');
    else {
      await loadHouses();
      showView('houses');
    }
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('template-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = document.getElementById('template-form-id').value;
  const body = {
    name: form.name.value.trim(),
    body: form.body.value.trim(),
  };
  try {
    if (id) await api.updateTemplate(id, body);
    else await api.createTemplate(body);
    document.getElementById('template-modal').classList.add('hidden');
    await loadTemplates();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('tenants-tbody')?.addEventListener('click', async (e) => {
  const editId = e.target.dataset.editTenant;
  const delId = e.target.dataset.deleteTenant;
  const msgId = e.target.dataset.messageTenant;
  const profileId = e.target.dataset.tenantProfile;
  if (profileId) {
    activeTenantCode = profileId;
    setHash(`#tenant/${profileId}`);
    showView('tenant-dashboard');
  }
  if (editId) openTenantModal(editId);
  if (msgId) openMessageModal(msgId);
  if (delId && confirm('Delete this tenant?')) {
    try {
      await api.deleteTenant(delId);
      loadTenants();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('houses-tbody')?.addEventListener('click', async (e) => {
  const dashboardId = e.target.dataset.openHouseDashboard;
  const inlineEditId = e.target.dataset.inlineEditHouse;
  const inlineSaveId = e.target.dataset.inlineSaveHouse;
  const inlineCancelId = e.target.dataset.inlineCancelHouse;
  const delId = e.target.dataset.deleteHouse;

  if (dashboardId) {
    activeHouseId = dashboardId;
    setHash(`#house/${dashboardId}`);
    showView('house-dashboard');
  }
  if (inlineEditId) activateInlineEdit(inlineEditId);
  if (inlineSaveId) await saveInlineHouseEdit(inlineSaveId);
  if (inlineCancelId) {
    // Revert to display without saving
    const h = housesCache.find((x) => String(x.id) === String(inlineCancelId));
    if (h) {
      const row = document.querySelector(`tr[data-house-row="${inlineCancelId}"]`);
      if (row) row.outerHTML = renderHouseRow(h);
    }
  }
  if (delId && confirm('Delete this house?')) {
    try {
      await api.deleteHouse(delId);
      loadHouses();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('btn-house-back')?.addEventListener('click', () => {
  activeHouseId = null;
  setHash('#');
  showView('houses');
});

// Collection position: recompute when the billing period changes.
document.getElementById('house-collection-period')?.addEventListener('change', () => {
  if (activeHouseId) loadHouseCollection(activeHouseId);
});

document.getElementById('btn-td-back')?.addEventListener('click', () => {
  activeTenantCode = null;
  setHash('#');
  showView('tenants');
});

document.getElementById('td-penalties-tbody')?.addEventListener('click', async (e) => {
  const payId = e.target.dataset.tdPayPenalty;
  const deleteId = e.target.dataset.tdDeletePenalty;
  if (payId) {
    if (!confirm('Mark this penalty as paid?')) return;
    try {
      await api.payPenalty(payId);
      if (activeTenantCode) loadTenantPenalties(activeTenantCode);
    } catch (err) { alert(err.message); }
  } else if (deleteId) {
    if (!confirm('Delete this penalty?')) return;
    try {
      await api.deletePenalty(deleteId);
      if (activeTenantCode) loadTenantPenalties(activeTenantCode);
    } catch (err) { alert(err.message); }
  }
});

document.getElementById('btn-house-edit')?.addEventListener('click', () => {
  if (!activeHouseId) return;
  openHouseModal(activeHouseId);
});

document.getElementById('btn-house-add-tenant')?.addEventListener('click', async () => {
  if (!activeHouseId) return;
  await openTenantModal(null);
  const sel = document.getElementById('tenant-house-select');
  if (sel) sel.value = String(activeHouseId);
});



async function handleUnitAction(e) {
  const editId = e.target.dataset.houseTenantEdit;
  const delId = e.target.dataset.houseTenantDelete;
  const occupyId = e.target.dataset.houseTenantOccupy;
  const vacantId = e.target.dataset.houseTenantVacant;
  const msgId = e.target.dataset.messageTenant;

  if (editId) openTenantModal(editId);
  if (occupyId) openTenantModal(occupyId);
  if (msgId) openMessageModal(msgId);
  if (vacantId && confirm('Mark this unit as VACANT? The tenancy will be closed and permanently archived (payments, invoices, statements, maintenance history and the exit invoice are preserved in the Tenancy Archive). Financial rows are only cleared when a new tenant occupies this unit.')) {
    try {
      await api.markUnitVacant(vacantId, {});
      if (currentView === 'house-dashboard') await loadHouseDashboardPage(activeHouseId);
      else await openHouseDashboard(activeHouseId);
      loadTenants();
      if (currentView === 'dashboard') loadDashboard();
    } catch (err) {
      alert(err.message);
    }
  }
  if (delId && confirm('Delete this tenant/unit?')) {
    try {
      await api.deleteTenant(delId);
      if (currentView === 'house-dashboard') await loadHouseDashboardPage(activeHouseId);
      else await openHouseDashboard(activeHouseId);
      loadTenants();
      if (currentView === 'dashboard') loadDashboard();
    } catch (err) {
      alert(err.message);
    }
  }
}

document.getElementById('house-page-tenants-tbody')?.addEventListener('click', handleUnitAction);
document.getElementById('house-dashboard-tenants-tbody')?.addEventListener('click', handleUnitAction);

document.getElementById('templates-list')?.addEventListener('click', async (e) => {
  const editId = e.target.dataset.editTemplate;
  const delId = e.target.dataset.deleteTemplate;
  if (editId) openTemplateModal(editId);
  if (delId && confirm('Delete this template?')) {
    try {
      await api.deleteTemplate(delId);
      loadTemplates();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('tenant-search')?.addEventListener('input', () => loadTenants());
document.getElementById('tenant-filter-status')?.addEventListener('change', () => loadTenants());

document.getElementById('btn-record-payment')?.addEventListener('click', () => openPaymentModal());
document.getElementById('payment-modal-cancel')?.addEventListener('click', () => {
  document.getElementById('payment-modal').classList.add('hidden');
});

document.getElementById('payment-mode-select')?.addEventListener('change', (e) => {
  const mode = e.target.value;
  ['mpesa', 'bank', 'cheque', 'cash'].forEach(m => {
    const el = document.getElementById('payment-fields-' + m);
    if (el) el.classList.toggle('hidden', m !== (mode || '').toLowerCase().replace('-', ''));
  });
  document.getElementById('payment-datetime-section')?.classList.toggle('hidden', !mode);
  if (mode === 'M-Pesa') {
    document.getElementById('payment-fields-mpesa')?.classList.remove('hidden');
  } else if (mode === 'Bank') {
    document.getElementById('payment-fields-bank')?.classList.remove('hidden');
  } else if (mode === 'Cheque') {
    document.getElementById('payment-fields-cheque')?.classList.remove('hidden');
  } else if (mode === 'Cash') {
    document.getElementById('payment-fields-cash')?.classList.remove('hidden');
  }
});

document.getElementById('payment-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const mode = form.payment_mode?.value || '';
  try {
    const payload = {
      tenant_id: form.tenant_id.value,
      amount: Number(form.amount.value),
      payment_type: form.payment_type?.value || 'rent',
      payment_mode: mode || null,
      sender_account: form.sender_account?.value?.trim() || null,
      receiver_account: form.receiver_account?.value?.trim() || null,
      cheque_number: form.cheque_number?.value?.trim() || null,
      payment_datetime: form.payment_datetime?.value || null,
    };
    if (mode === 'M-Pesa') {
      payload.mpesa_reference = form.mpesa_reference?.value?.trim() || null;
    }
    await api.createPayment(payload);
    document.getElementById('payment-modal').classList.add('hidden');
    loadPayments();
    if (currentView === 'dashboard') loadDashboard();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('payment-filter')?.addEventListener('change', () => loadPayments());
document.getElementById('broadcast-target-type')?.addEventListener('change', toggleBroadcastHouseSelect);
document.getElementById('broadcast-template-select')?.addEventListener('change', (e) => {
  const id = e.target.value;
  const body = document.getElementById('broadcast-message-body');
  if (!body) return;
  if (!id) return;
  const tpl = templatesCache.find((t) => String(t.id) === String(id));
  if (tpl) body.value = tpl.body;
});

let lastParsedPayment = null;

/**
 * Offline PARSE — same fields as the server parser, tenant lookup against
 * the last synced snapshot, duplicate check against cached payments.
 * The receipt preview is generated server-side on sync (allocation needs
 * live balances), so the message box shows a placeholder until then.
 */
async function parsePaymentMessageOfflineFlow({ raw, hint, tenantSel, amountEl, refEl, msgEl, copyBtn, approveBtn }) {
  lastParsedPayment = null;
  try {
    const parsed = parseMpesaOffline(raw);
    const tenants = await offlineDb.getAll('tenants').catch(() => []);
    if (!tenants.length) {
      if (hint) hint.textContent = 'Offline, and no synced tenant data on this device yet. Connect once to download it.';
      return;
    }
    const matches = matchTenantsOffline(parsed, tenants);

    if (amountEl) amountEl.value = parsed.amount ?? '';
    if (refEl) refEl.value = parsed.mpesa_reference ?? '';

    // Duplicate check against cached payments (same M-Pesa code).
    if (parsed.mpesa_reference) {
      const cached = await offlineDb.getAll('payments').catch(() => []);
      const dup = (cached || []).find((p) => String(p.mpesa_reference || '').toUpperCase() === String(parsed.mpesa_reference).toUpperCase());
      if (dup) {
        if (hint) {
          hint.innerHTML = `M-Pesa Reference <b>${escapeHtml(parsed.mpesa_reference)}</b> is already recorded on this device (${dup.sync === 'synced' ? 'SYNCED' : 'PENDING SYNC'}, ${escapeHtml(dup.tenant_name || '')}, KES ${Number(dup.amount || 0).toLocaleString()}).`;
          hint.style.color = '#dc2626';
        }
        if (approveBtn) approveBtn.disabled = true;
        return;
      }
    }
    if (hint) hint.style.color = '';

    if (parsed.amount == null) {
      if (hint) hint.textContent = 'Offline parse: could not detect the amount. Check the message and try again.';
      return;
    }
    if (!matches.length) {
      if (hint) hint.textContent = 'Offline parse: no tenant match in synced data. Ensure the message has the tenant phone, tenant code, or house paybill number.';
      return;
    }

    if (tenantSel) {
      tenantSel.innerHTML = matches
        .map((t) => {
          const houseName = t.linked_house_name || t.property_name || '';
          const houseNo = t.linked_house_number || t.unit_label || '';
          const label = `${t.name} (${t.tenant_code}) — ${houseName}${houseNo ? ` ${houseNo}` : ''}`;
          return `<option value="${escapeHtml(t.tenant_code || t.id || '')}">${escapeHtml(label)}</option>`;
        })
        .join('');
      tenantSel.disabled = false;
    }
    if (msgEl) msgEl.value = '📴 Offline — receipt preview will be generated automatically when this payment syncs.';
    if (copyBtn) copyBtn.disabled = true;
    if (approveBtn) approveBtn.disabled = false;
    if (hint) hint.textContent = `Offline parse OK (last synced data) — ${matches.length > 1 ? 'multiple matches, select the correct tenant.' : 'tenant matched.'} Receipt: PENDING WHATSAPP SEND.`;
    lastParsedPayment = { offline: true, parsed, matches };
  } catch (err) {
    if (hint) hint.textContent = `Offline parse failed: ${err.message}`;
  }
}

async function parsePaymentMessageFlow() {
  const raw = document.getElementById('payment-raw-message')?.value || '';
  const hint = document.getElementById('payment-message-hint');
  const tenantSel = document.getElementById('payment-message-tenant-select');
  const amountEl = document.getElementById('payment-message-amount');
  const refEl = document.getElementById('payment-message-ref');
  const msgEl = document.getElementById('payment-generated-message');
  const copyBtn = document.getElementById('btn-copy-generated-message');
  const approveBtn = document.getElementById('btn-approve-from-message');

  lastParsedPayment = null;
  if (approveBtn) approveBtn.disabled = true;
  if (copyBtn) copyBtn.disabled = true;
  document.getElementById('payment-outstanding-box')?.remove();
  if (tenantSel) {
    tenantSel.innerHTML = '';
    tenantSel.disabled = true;
  }
  if (amountEl) amountEl.value = '';
  if (refEl) refEl.value = '';
  if (msgEl) msgEl.value = '';

  if (!raw.trim()) {
    if (hint) hint.textContent = 'Paste a message first.';
    return;
  }

  try {
    if (hint) hint.textContent = 'Parsing…';
    let result;
    try {
      result = await api.parsePaymentMessage(raw);
    } catch (apiErr) {
      if (!isNetworkError(apiErr)) throw apiErr;
      if (hint) hint.textContent = 'No internet — parsing offline…';
      return parsePaymentMessageOfflineFlow({ raw, hint, tenantSel, amountEl, refEl, msgEl, copyBtn, approveBtn });
    }
    lastParsedPayment = result;

    if (amountEl) amountEl.value = result.parsed?.amount ?? '';
    if (refEl) refEl.value = result.parsed?.mpesa_reference ?? '';
    if (msgEl) msgEl.value = result.generated_message || '';

    // Show outstanding Invoice Center rows auto-retrieved for this tenant.
    renderParsedOutstandingInvoices(result.outstanding_invoices || []);

    if (result.duplicate) {
      const d = result.duplicate;
      const approvedOn = d.approved_at ? new Date(d.approved_at).toLocaleDateString() : (d.payment_date || '—');
      if (hint) hint.innerHTML = `Approval Failed: M-Pesa Reference <b>${result.parsed?.mpesa_reference || d.mpesa_reference || '—'}</b> has already been used for an approved payment.<br>Existing Record — Tenant: ${d.tenant_name || '—'}, Property: ${d.property_name || '—'}, Unit: ${d.unit_number || '—'}, Amount: KES ${Number(d.amount || 0).toLocaleString()}, Date Approved: ${approvedOn}, Receipt Number: ${d.receipt_number || '—'}.`;
      hint.style.color = '#dc2626';
      if (approveBtn) approveBtn.disabled = true;
      lastParsedPayment = null;
      return;
    }
    if (hint) hint.style.color = '';

    const matches = result.matches || [];
    if (!matches.length) {
      if (hint) hint.textContent = 'No tenant match found. Ensure the message has the tenant phone, tenant code, or house paybill number.';
      return;
    }

    if (tenantSel) {
      tenantSel.innerHTML = matches
        .map((t) => {
          const houseName = t.linked_house_name || t.property_name || '';
          const houseNo = t.linked_house_number || t.unit_label || '';
          const label = `${t.name} (${t.tenant_code}) — ${houseName}${houseNo ? ` ${houseNo}` : ''}`;
          return `<option value="${t.id}">${escapeHtml(label)}</option>`;
        })
        .join('');
      tenantSel.disabled = false;
    }

    if (hint) hint.textContent = matches.length > 1 ? 'Multiple matches found — select the correct tenant.' : 'Tenant matched.';
    if (copyBtn) copyBtn.disabled = !result.generated_message;
    if (approveBtn) approveBtn.disabled = false;
  } catch (err) {
    if (hint) hint.textContent = `Parse failed: ${err.message}`;
  }
}

// Outstanding Invoice Center rows retrieved for the parsed tenant.
// Display-only: approval applies them automatically, no re-entry needed.
function renderParsedOutstandingInvoices(invoices) {
  const hint = document.getElementById('payment-message-hint');
  if (!hint) return;
  let box = document.getElementById('payment-outstanding-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'payment-outstanding-box';
    hint.after(box);
  }
  if (!invoices.length) {
    box.innerHTML = '';
    return;
  }
  const total = invoices.reduce((s, r) => s + Number(r.balance_due ?? r.amount ?? 0), 0);
  box.innerHTML = `<div class="mt-2 rounded border border-slate-700 bg-slate-900 p-2 text-xs font-mono">
    <div class="text-slate-400 mb-1">Outstanding invoices auto-retrieved (${invoices.length}) — total due ${formatKes(total)}:</div>
    ${invoices.map((r) => `<div class="flex justify-between gap-2 py-0.5">
      <span class="text-slate-300">${escapeHtml(r.invoice_type || '')} · ${escapeHtml(r.invoice_number || '')}</span>
      <span class="text-amber-400">${formatKes(r.balance_due ?? r.amount)}</span>
    </div>`).join('')}
    <div class="text-slate-500 mt-1">They will be settled automatically on approve — no need to re-enter them.</div>
  </div>`;
}

/**
 * Offline APPROVE & SEND — saves the payment locally as PENDING SYNC with a
 * device UUID (`client_txn_id`). The receipt is marked PENDING WHATSAPP SEND.
 * On reconnect the sync engine uploads it; the server then runs the normal
 * allocation + WhatsApp workflow. Nothing about that workflow changes.
 */
async function approvePaymentOfflineFlow({ raw, tenantId, hint, approveBtn }) {
  try {
    if (approveBtn) approveBtn.disabled = true;
    if (hint) hint.textContent = 'Saving offline…';
    let parsed = (lastParsedPayment && lastParsedPayment.parsed) || null;
    let matches = (lastParsedPayment && lastParsedPayment.matches) || [];
    if (!parsed) {
      parsed = parseMpesaOffline(raw);
      const tenants = await offlineDb.getAll('tenants').catch(() => []);
      matches = matchTenantsOffline(parsed, tenants);
    }
    if (parsed.amount == null) {
      if (hint) hint.textContent = 'Could not detect the amount — cannot save offline.';
      return;
    }
    const tenant = matches.find((t) => String(t.tenant_code || t.id || '') === String(tenantId)) || matches[0] || null;
    if (!tenant) {
      if (hint) hint.textContent = 'Select a tenant first (offline lookup found no match).';
      return;
    }
    // Local duplicate guard: same M-Pesa code already on this device.
    if (parsed.mpesa_reference) {
      const cached = await offlineDb.getAll('payments').catch(() => []);
      const dup = (cached || []).find((p) => String(p.mpesa_reference || '').toUpperCase() === String(parsed.mpesa_reference).toUpperCase());
      if (dup) {
        if (hint) {
          hint.style.color = '#dc2626';
          hint.textContent = `M-Pesa Reference ${parsed.mpesa_reference} is already saved on this device (${dup.sync === 'synced' ? 'SYNCED' : 'PENDING SYNC'}). Not saved twice.`;
        }
        return;
      }
    }
    const clientTxnId = offlineDb.newClientTxnId();
    const today = new Date().toISOString().slice(0, 10);
    const payload = {
      raw_message: raw,
      tenant_id: tenant.tenant_code,
      payment_date: parsed.payment_date || today,
      tenant_code: tenant.tenant_code,
      tenant_name: tenant.name || '',
      amount: parsed.amount,
      mpesa_reference: parsed.mpesa_reference || null,
      payment_mode: 'M-Pesa',
      sender_account: parsed.phone_number || null,
    };
    await queueOutboxOp({ type: 'payment_mpesa', payload });
    await offlineDb.put('payments', {
      key: `pending:${clientTxnId}`,
      client_txn_id: clientTxnId,
      server_id: null,
      tenant_code: tenant.tenant_code,
      tenant_name: tenant.name || '',
      amount: Number(parsed.amount),
      mpesa_reference: parsed.mpesa_reference || null,
      payment_date: parsed.payment_date || today,
      mode: 'M-Pesa',
      sync: 'pending',
      receipt: 'pending',
      created_at: new Date().toISOString(),
    });
    if (hint) {
      hint.style.color = '';
      hint.textContent = '🟠 Saved offline — PENDING SYNC. Receipt: PENDING WHATSAPP SEND. Will upload + send automatically when internet returns.';
    }
    showToast('Payment saved offline (PENDING SYNC)');
    try { await loadPayments(); } catch (_) {}
  } catch (err) {
    if (hint) hint.textContent = `Offline save failed: ${err.message}`;
  } finally {
    if (approveBtn) approveBtn.disabled = false;
  }
}

async function approvePaymentFromMessageFlow() {
  const raw = document.getElementById('payment-raw-message')?.value || '';
  const tenantId = document.getElementById('payment-message-tenant-select')?.value;
  const hint = document.getElementById('payment-message-hint');
  const approveBtn = document.getElementById('btn-approve-from-message');
  if (!raw.trim()) return alert('Paste the M-Pesa message first.');
  if (!tenantId) return alert('Select a tenant first.');

  if (effectiveOffline()) {
    return approvePaymentOfflineFlow({ raw, tenantId, hint, approveBtn });
  }

  if (!confirm('Approve this payment now? This will update the tenant due date and send WhatsApp confirmation (if configured).')) return;

  try {
    if (approveBtn) approveBtn.disabled = true;
    if (hint) hint.textContent = 'Approving…';
    const result = await api.approvePaymentFromMessage({ raw_message: raw, tenant_id: tenantId });
    const msgEl = document.getElementById('payment-generated-message');
    if (msgEl && result.generated_message) msgEl.value = result.generated_message;
    const wa = result.whatsapp || {};
    const waStatus = wa.status || 'Skipped';

    if (result.overpayment > 0) {
      if (hint) hint.textContent = 'Approved with overpayment. Please resolve.';
      showOverpaymentPrompt(result);
      loadPayments();
      loadDashboard();
      return;
    }

    if (approveBtn) approveBtn.disabled = false;
    let hintMsg = `Approved. WhatsApp: ${waStatus}`;
    if (waStatus === 'Failed' && wa.failureReason) hintMsg += ` (${wa.failureReason})`;
    if (waStatus === 'Pending') hintMsg += ' (awaiting delivery confirmation)';
    if (hint) hint.textContent = hintMsg;
    if (waStatus === 'Pending' && result.payment && result.payment.id) {
      // Keep polling the delivery receipt so this status flips to
      // Delivered/Read automatically once WhatsApp confirms delivery.
      trackPaymentDelivery(result.payment.id, hint, 'Approved. WhatsApp');
    }
    loadPayments();
    loadDashboard();
  } catch (err) {
    const detail = err.data?.message || err.message;
    if (hint) {
      if (isNetworkError(err)) {
        hint.style.color = '#b45309';
        hint.textContent = 'Connection lost during approval. The payment may already be saved on the server — check Payment History after reconnect. If it is missing, paste + approve again: duplicate M-Pesa codes are rejected automatically, so it cannot post twice.';
      } else {
        hint.textContent = `Approve failed: ${detail}`;
        hint.style.color = err.status === 409 ? '#dc2626' : '';
      }
    }
    if (approveBtn) approveBtn.disabled = false;
  }
}

// Live WhatsApp delivery tracker: polls the payment's delivery status until
// WhatsApp confirms (Delivered/Read) or fails, updating either the inline
// approval hint or a dismissible fixed banner. The backend callback
// (Baileys delivery receipt -> message_logs) is the source of truth.
async function trackPaymentDelivery(paymentId, hintEl = null, hintBase = 'Approved. WhatsApp') {
  let banner = null;
  let statusEl = null;
  if (!hintEl) {
    document.getElementById('wa-delivery-banner')?.remove();
    banner = document.createElement('div');
    banner.id = 'wa-delivery-banner';
    banner.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#1e293b;border:1px solid #f59e0b;padding:14px 16px;border-radius:8px;z-index:9999;max-width:360px;color:#e2f8f0;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
    banner.innerHTML = `<div class="wa-delivery-line">Approved. WhatsApp: Pending — waiting for delivery confirmation…</div>
      <button onclick="this.parentElement.remove()" style="background:transparent;color:#94a3b8;border:none;cursor:pointer;margin-left:8px;font-size:12px">Dismiss</button>`;
    statusEl = banner.querySelector('.wa-delivery-line');
    document.body.appendChild(banner);
  }
  const set = (text, color, borderColor) => {
    if (hintEl) { hintEl.textContent = text; hintEl.style.color = color || ''; }
    if (statusEl) { statusEl.textContent = text; statusEl.style.color = color || ''; if (borderColor && banner) banner.style.borderColor = borderColor; }
  };
  const BASE = hintBase;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (banner && !document.body.contains(banner)) return; // dismissed
    try {
      const { delivery } = await api.paymentDeliveryStatus(paymentId);
      const st = delivery && delivery.status;
      if (st === 'Delivered' || st === 'Read') {
        set(`${BASE}: ${st} ✓ (auto-confirmed)`, '#16a34a', '#22c55e');
        return;
      }
      if (st === 'Failed') {
        set(`${BASE}: Failed — use Resend`, '#dc2626', '#ef4444');
        return;
      }
      if (st === 'Sent' || st === 'Pending') {
        set(`${BASE}: ${st} — waiting for delivery confirmation…`);
      } else if (st === null && delivery && delivery.reason === 'confirmation_not_logged') {
        set(`${BASE}: confirmation still sending…`);
      }
    } catch (_) { /* transient network error — keep polling */ }
  }
  set(`${BASE}: confirmation still pending — see WhatsApp > Messages for the live status`);
}

document.getElementById('btn-parse-payment-message')?.addEventListener('click', parsePaymentMessageFlow);
document.getElementById('btn-approve-from-message')?.addEventListener('click', approvePaymentFromMessageFlow);
document.getElementById('btn-copy-generated-message')?.addEventListener('click', async () => {
  const msg = document.getElementById('payment-generated-message')?.value || '';
  if (!msg.trim()) return;
  try {
    await navigator.clipboard.writeText(msg);
    const hint = document.getElementById('payment-message-hint');
    if (hint) hint.textContent = 'Copied message.';
  } catch {
    alert('Copy failed. Select the text and copy manually.');
  }
});

// Payment mode switching
document.getElementById('payment-mode-select')?.addEventListener('change', async (e) => {
  const mode = e.target.value;
  const mpesaSection = document.getElementById('payment-mpesa-section');
  const cashSection = document.getElementById('payment-cash-section');
  const pesalinkSection = document.getElementById('payment-pesalink-section');
  const parseBtn = document.getElementById('btn-parse-payment-message');
  const tenantSel = document.getElementById('payment-message-tenant-select');
  const hint = document.getElementById('payment-message-hint');
  if (mpesaSection) mpesaSection.classList.toggle('hidden', mode !== 'mpesa');
  if (cashSection) cashSection.classList.toggle('hidden', mode !== 'cash');
  if (pesalinkSection) pesalinkSection.classList.toggle('hidden', mode !== 'pesalink');
  if (parseBtn) parseBtn.textContent = mode === 'mpesa' ? 'Parse' : 'Approve';
  if (hint) hint.textContent = mode === 'mpesa' ? 'Paste a message and click Parse.' : 'Select tenant and enter details, then click Approve.';
  // Set today's date on cash/pesalink date fields
  const today = new Date().toISOString().slice(0, 10);
  const cashDate = document.getElementById('payment-cash-date');
  const pesaDate = document.getElementById('payment-pesalink-date');
  if (cashDate && !cashDate.value) cashDate.value = today;
  if (pesaDate && !pesaDate.value) pesaDate.value = today;
  // Populate tenant dropdown for Cash mode
  if (mode === 'cash' && tenantSel) {
    try {
      const data = await api.tenants();
      const tenants = data.tenants || data || [];
      tenantSel.innerHTML = '<option value="">Select tenant…</option>' + tenants.map(t => {
        const houseName = t.linked_house_name || t.property_name || '';
        const houseNo = t.linked_house_number || t.unit_label || '';
        return `<option value="${t.id}">${escapeHtml(t.name)} (${escapeHtml(t.tenant_code)}) — ${escapeHtml(houseName)} ${escapeHtml(houseNo)}</option>`;
      }).join('');
      tenantSel.disabled = false;
    } catch (_) {}
  }
});

// Cash / Pesa Link approve — offline variant queues to the outbox (PENDING SYNC).
async function approveCashOfflineFlow({ payment_mode, amount, date, time, tenantRef, hint }) {
  try {
    if (hint) hint.textContent = 'Saving offline…';
    const tenants = await offlineDb.getAll('tenants').catch(() => []);
    const tenant = (tenants || []).find((t) => String(t.tenant_code || t.id || '').toUpperCase() === String(tenantRef || '').toUpperCase()) || null;
    if (!tenant) {
      if (hint) hint.textContent = 'Tenant not found in synced data — connect once to download tenants, or check the code.';
      return;
    }
    const clientTxnId = offlineDb.newClientTxnId();
    const today = new Date().toISOString().slice(0, 10);
    const payload = {
      payment_mode,
      amount: Number(amount),
      payment_date: date || today,
      payment_time: time || null,
      tenant_id: tenant.tenant_code,
      tenant_code: tenant.tenant_code,
      tenant_name: tenant.name || '',
      mpesa_reference: null,
    };
    await queueOutboxOp({ type: 'payment_cash', payload });
    await offlineDb.put('payments', {
      key: `pending:${clientTxnId}`,
      client_txn_id: clientTxnId,
      server_id: null,
      tenant_code: tenant.tenant_code,
      tenant_name: tenant.name || '',
      amount: Number(amount),
      mpesa_reference: null,
      payment_date: date || today,
      mode: payment_mode,
      sync: 'pending',
      receipt: 'pending',
      created_at: new Date().toISOString(),
    });
    if (hint) {
      hint.style.color = '';
      hint.textContent = '🟠 Saved offline — PENDING SYNC. Receipt: PENDING WHATSAPP SEND. Will upload + send automatically when internet returns.';
    }
    showToast(`${payment_mode} payment saved offline (PENDING SYNC)`);
    try { await loadPayments(); } catch (_) {}
  } catch (err) {
    if (hint) hint.textContent = `Offline save failed: ${err.message}`;
  }
}

document.getElementById('btn-parse-payment-message')?.addEventListener('click', async () => {
  const mode = document.getElementById('payment-mode-select')?.value || 'mpesa';
  if (mode === 'mpesa') return parsePaymentMessageFlow();

  const hint = document.getElementById('payment-message-hint');
  const tenantSel = document.getElementById('payment-message-tenant-select');
  const amountEl = document.getElementById('payment-message-amount');
  const refEl = document.getElementById('payment-message-ref');
  const msgEl = document.getElementById('payment-generated-message');
  const approveBtn = document.getElementById('btn-approve-from-message');

  if (mode === 'cash') {
    const amount = document.getElementById('payment-cash-amount')?.value;
    const date = document.getElementById('payment-cash-date')?.value;
    const time = document.getElementById('payment-cash-time')?.value;
    if (!amount || Number(amount) <= 0) { if (hint) hint.textContent = 'Enter a valid amount.'; return; }
    if (!tenantSel?.value) { if (hint) hint.textContent = 'Select a tenant first.'; return; }
    if (effectiveOffline()) {
      return approveCashOfflineFlow({ payment_mode: 'Cash', amount, date, time, tenantRef: tenantSel.value, hint });
    }
    if (!confirm(`Approve KES ${Number(amount).toLocaleString()} cash payment?`)) return;
    try {
      if (hint) hint.textContent = 'Approving…';
      const result = await api.approveCashPesaLink({ payment_mode: 'Cash', amount, payment_date: date, payment_time: time, tenant_id: tenantSel.value });
      if (msgEl && result.generated_message) msgEl.value = result.generated_message;
      if (hint) hint.textContent = 'Cash payment approved and WhatsApp sent.';
      loadPayments(); loadDashboard();
    } catch (err) { if (hint) hint.textContent = 'Failed: ' + (err.message || err); }
    return;
  }

  if (mode === 'pesalink') {
    const amount = document.getElementById('payment-pesalink-amount')?.value;
    const date = document.getElementById('payment-pesalink-date')?.value;
    const time = document.getElementById('payment-pesalink-time')?.value;
    const tenantCode = document.getElementById('payment-pesalink-tenant')?.value;
    if (!amount || Number(amount) <= 0) { if (hint) hint.textContent = 'Enter a valid amount.'; return; }
    if (!tenantCode?.trim()) { if (hint) hint.textContent = 'Enter tenant code / house number.'; return; }
    if (effectiveOffline()) {
      return approveCashOfflineFlow({ payment_mode: 'Pesa Link', amount, date, time, tenantRef: tenantCode.trim(), hint });
    }
    if (!confirm(`Approve KES ${Number(amount).toLocaleString()} Pesa Link payment?`)) return;
    try {
      if (hint) hint.textContent = 'Approving…';
      const result = await api.approveCashPesaLink({ payment_mode: 'Pesa Link', amount, payment_date: date, payment_time: time, tenant_code: tenantCode.trim() });
      if (msgEl && result.generated_message) msgEl.value = result.generated_message;
      if (hint) hint.textContent = 'Pesa Link payment approved and WhatsApp sent.';
      loadPayments(); loadDashboard();
    } catch (err) { if (hint) hint.textContent = 'Failed: ' + (err.message || err); }
    return;
  }
});

document.getElementById('broadcast-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {
    target_type: form.target_type.value,
    house_id: form.house_id.value || null,
    template_id: form.template_id.value ? Number(form.template_id.value) : null,
    message_body: form.message_body.value.trim(),
  };
  try {
    const result = await api.sendBroadcast(payload);
    document.getElementById('broadcast-result').textContent =
      `Broadcast complete. Sent: ${result.sent}, Failed: ${result.failed}`;
  } catch (err) {
    document.getElementById('broadcast-result').textContent = `Broadcast failed: ${err.message}`;
  }
});

document.getElementById('btn-sync-historical-payments')?.addEventListener('click', async () => {
  if (!confirm('Run historical payment synchronization? This recomputes every tenant\'s balances from approved payment history and marks all approved payments as fully synced (Approved & Sent).')) return;
  const btn = document.getElementById('btn-sync-historical-payments');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  try {
    const result = await api.syncHistoricalPayments();
    let msg = `${result.message}\n\nApproved payments: ${result.totalApproved}\nMarked synced: ${result.syncedPayments}\nTenants recomputed: ${result.tenantsRepaired}`;
    if (result.failed && result.failed.length) msg += `\nFailed: ${result.failed.length}`;
    alert(msg);
    loadPayments();
    loadDashboard();
  } catch (err) {
    alert(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ============================================================
// PHASE 6: STAFF ADVANCES
// ============================================================

async function loadStaffAdvances() {
  const employee = document.getElementById('sa-employee-filter')?.value || '';
  try {
    const records = await api.listStaffAdvances(employee || undefined);
    renderStaffAdvanceList(records);
    updateStaffAdvanceSummary(records);
  } catch (e) {
    console.error('Error loading staff advances:', e);
  }
}

function renderStaffAdvanceList(records) {
  const tbody = document.getElementById('sa-list-tbody');
  if (!tbody) return;
  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="text-center text-slate-500 py-6">No staff advances recorded</td></tr>';
    return;
  }
  tbody.innerHTML = records.map(r => {
    const outstanding = Number(r.outstanding || 0);
    const statusClass = r.status === 'Fully Recovered' ? 'text-green-400' :
      r.status === 'Partially Recovered' ? 'text-amber-400' :
      r.status === 'Written Off' ? 'text-slate-500' : 'text-rose-400';
    const buttons = [
      `<button onclick="showSaPayments(${r.id})" class="text-cyan-400 hover:text-cyan-300 text-xs" title="Record Payment">Payment</button>`,
      `<button onclick="downloadStaffAdvancePdf(${r.id})" class="text-emerald-400 hover:text-emerald-300 text-xs" title="Download Invoice PDF">PDF</button>`,
    ];
    if (r.status !== 'Fully Recovered' && r.status !== 'Written Off') {
      buttons.push(`<button onclick="editStaffAdvance(${r.id})" class="text-amber-400 hover:text-amber-300 text-xs" title="Edit">Edit</button>`);
    }
    buttons.push(`<button onclick="deleteStaffAdvance(${r.id})" class="text-rose-400 hover:text-rose-300 text-xs" title="Delete">Delete</button>`);
    return `<tr>
      <td>${r.employee_name || ''}</td>
      <td>${r.person_type || 'Employee'}</td>
      <td>${r.date_advanced ? new Date(r.date_advanced).toLocaleDateString() : ''}</td>
      <td>${r.reason || ''}</td>
      <td>${r.property_name || ''}${r.unit_code ? ' / ' + r.unit_code : ''}</td>
      <td class="text-right font-mono">${formatKes(r.amount)}</td>
      <td class="text-right font-mono text-green-400">${formatKes(r.amount_recovered)}</td>
      <td class="text-right font-mono text-rose-400">${formatKes(outstanding)}</td>
      <td><span class="${statusClass}">${r.status}</span></td>
      <td class="text-right space-x-2">${buttons.join(' ')}</td>
    </tr>`;
  }).join('');
}

function updateStaffAdvanceSummary(records) {
  const totalAdvanced = records.reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalRecovered = records.reduce((s, r) => s + Number(r.amount_recovered || 0), 0);
  const totalOutstanding = records.reduce((s, r) => s + Number(r.outstanding || 0), 0);
  const activeCount = records.filter(r => r.status !== 'Fully Recovered' && r.status !== 'Written Off').length;
  const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  el('sa-total-advanced', formatKes(totalAdvanced));
  el('sa-total-recovered', formatKes(totalRecovered));
  el('sa-total-outstanding', formatKes(totalOutstanding));
  el('sa-active-count', activeCount.toString());
}

async function loadStaffAdvanceEmployees() {
  try {
    const employees = await api.listStaffAdvanceEmployees();
    const filter = document.getElementById('sa-employee-filter');
    if (filter) {
      const current = filter.value;
      filter.innerHTML = '<option value="">All Employees</option>' + employees.map(e => `<option value="${e}">${e}</option>`).join('');
      filter.value = current;
    }
  } catch (e) { console.error('Error loading employees:', e); }
}

function showSaForm(record) {
  const wrap = document.getElementById('sa-form-wrap');
  if (!wrap) return;
  wrap.classList.remove('hidden');

  const propSel = document.getElementById('sa-property');
  if (propSel && propSel.options.length <= 1) {
    api.houses().then(({ houses }) => {
      propSel.innerHTML = '<option value="">Select property</option>' +
        houses.map(h => `<option value="${escapeHtml(h.house_name)}">${escapeHtml(h.house_name)}</option>`).join('');
      if (record && record.property_name) propSel.value = record.property_name;
    }).catch(() => {});
  }

  document.getElementById('sa-form-id').value = record ? record.id : '';
  document.getElementById('sa-person-type').value = record ? record.person_type || 'Employee' : 'Employee';
  document.getElementById('sa-employee').value = record ? record.employee_name : '';
  document.getElementById('sa-date').value = record ? (record.date_advanced || '').slice(0, 10) : new Date().toISOString().slice(0, 10);
  document.getElementById('sa-amount').value = record ? record.amount : '';
  document.getElementById('sa-reason').value = record ? record.reason || '' : '';
  document.getElementById('sa-recovery-method').value = record ? record.recovery_method || 'salary_deduction' : 'salary_deduction';
  document.getElementById('sa-expected-recovery').value = record ? record.expected_recovery_month || '' : '';
  document.getElementById('sa-status').value = record ? record.status || 'Pending' : 'Pending';
  document.getElementById('sa-notes').value = record ? record.notes || '' : '';
  document.getElementById('sa-form-result').textContent = '';
  if (record && record.property_name) {
    const propSel = document.getElementById('sa-property');
    if (propSel) {
      propSel.value = record.property_name;
      if (!propSel.value) {
        const opt = document.createElement('option');
        opt.value = record.property_name;
        opt.textContent = record.property_name;
        propSel.appendChild(opt);
        propSel.value = record.property_name;
      }
    }
  } else {
    document.getElementById('sa-property').value = '';
  }
  document.getElementById('sa-unit').value = record ? record.unit_code || '' : '';
}

function hideSaForm() {
  document.getElementById('sa-form-wrap')?.classList.add('hidden');
}

async function saveStaffAdvance(e) {
  e.preventDefault();
  const id = document.getElementById('sa-form-id').value;
  const data = {
    employee_name: document.getElementById('sa-employee').value.trim(),
    person_type: document.getElementById('sa-person-type').value,
    date_advanced: document.getElementById('sa-date').value,
    amount: document.getElementById('sa-amount').value,
    reason: document.getElementById('sa-reason').value.trim(),
    property_name: document.getElementById('sa-property').value || null,
    unit_code: document.getElementById('sa-unit').value.trim() || null,
    recovery_method: document.getElementById('sa-recovery-method').value,
    expected_recovery_month: document.getElementById('sa-expected-recovery').value || null,
    status: document.getElementById('sa-status').value,
    notes: document.getElementById('sa-notes').value.trim() || null,
  };
  const resultEl = document.getElementById('sa-form-result');
  try {
    if (id) {
      await api.updateStaffAdvance(id, data);
      resultEl.textContent = 'Staff advance updated.';
      resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    } else {
      await api.createStaffAdvance(data);
      resultEl.textContent = 'Staff advance created.';
      resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    }
    hideSaForm();
    loadStaffAdvances();
    loadStaffAdvanceEmployees();
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function editStaffAdvance(id) {
  try {
    const record = await api.getStaffAdvance(id);
    if (record) showSaForm(record);
  } catch (e) { alert('Error loading staff advance: ' + e.message); }
}

async function deleteStaffAdvance(id) {
  if (!confirm('Delete this staff advance? This cannot be undone.')) return;
  try {
    await api.deleteStaffAdvance(id);
    loadStaffAdvances();
    loadStaffAdvanceEmployees();
  } catch (e) { alert('Error: ' + e.message); }
}

async function showSaPayments(advanceId) {
  const modal = document.getElementById('sa-payment-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  document.getElementById('sapm-advance-id').value = advanceId;
  document.getElementById('sapm-amount').value = '';
  document.getElementById('sapm-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('sapm-time').value = new Date().toTimeString().slice(0, 5);
  document.getElementById('sapm-method').value = '';
  document.getElementById('sapm-notes').value = '';
  document.getElementById('sapm-result').textContent = '';
  document.getElementById('sapm-sender-row').classList.add('hidden');
  document.getElementById('sapm-ref-row').classList.add('hidden');
  clearSapmSenderRef();
  try {
    const adv = await api.getStaffAdvance(advanceId);
    if (adv) {
      document.getElementById('sa-pay-title').textContent = `Recovery: ${adv.employee_name}`;
      document.getElementById('sa-pay-subtitle').textContent =
        `Advanced: ${formatKes(adv.amount)} | Recovered: ${formatKes(adv.amount_recovered)} | Outstanding: ${formatKes(adv.outstanding)}`;
    }
    await loadSaPaymentHistory(advanceId);
  } catch (e) { console.error(e); }
}

function clearSapmSenderRef() {
  const senderEl = document.getElementById('sapm-sender');
  const refEl = document.getElementById('sapm-reference');
  if (senderEl) senderEl.value = '';
  if (refEl) refEl.value = '';
}

function onSaMethodChange() {
  const method = document.getElementById('sapm-method').value;
  const senderRow = document.getElementById('sapm-sender-row');
  const refRow = document.getElementById('sapm-ref-row');
  const senderLabel = document.getElementById('sapm-sender-label');
  const refLabel = document.getElementById('sapm-ref-label');
  const senderEl = document.getElementById('sapm-sender');
  const refEl = document.getElementById('sapm-reference');
  senderRow.classList.add('hidden');
  refRow.classList.add('hidden');
  clearSapmSenderRef();
  if (method === 'M-PESA') {
    senderRow.classList.remove('hidden');
    refRow.classList.remove('hidden');
    senderLabel.textContent = 'M-Pesa Number';
    senderEl.placeholder = 'e.g. 254712345678';
    refLabel.textContent = 'M-Pesa Code';
    refEl.placeholder = 'e.g. QGH7B1YKP4';
  } else if (method === 'Bank Transfer') {
    senderRow.classList.remove('hidden');
    refRow.classList.remove('hidden');
    senderLabel.textContent = 'Bank Account Number';
    senderEl.placeholder = 'Sender account number';
    refLabel.textContent = 'Transaction Reference';
    refEl.placeholder = 'Reference number';
  } else if (method === 'Cash') {
    senderRow.classList.remove('hidden');
    senderLabel.textContent = 'Received By';
    senderEl.placeholder = 'Name of person receiving cash';
  } else if (method === 'Salary Deduction' || method === 'Other') {
    refRow.classList.remove('hidden');
    refLabel.textContent = 'Reference (optional)';
    refEl.placeholder = 'Reference number';
  }
}

function getSapmSenderRef() {
  const method = document.getElementById('sapm-method').value;
  const senderEl = document.getElementById('sapm-sender');
  const refEl = document.getElementById('sapm-reference');
  return {
    sender_account: senderEl ? senderEl.value.trim() || null : null,
    reference: refEl ? refEl.value.trim() || null : null,
  };
}

async function loadSaPaymentHistory(advanceId) {
  const container = document.getElementById('sapm-payment-history');
  if (!container) return;
  try {
    const payments = await api.getStaffAdvancePayments(advanceId);
    if (!payments.length) {
      container.innerHTML = '<p class="text-slate-500">No payments recorded.</p>';
      return;
    }
    container.innerHTML = `<table class="w-full text-xs">
      <thead><tr><th>Date</th><th>Method</th><th>From</th><th>Ref</th><th class="text-right">Amount</th><th></th></tr></thead>
      <tbody>${payments.map(p => {
        const dt = p.payment_date ? new Date(p.payment_date).toLocaleDateString() : '';
        const tm = p.payment_time ? ' ' + p.payment_time.slice(0, 5) : '';
        const method = p.payment_method || '';
        const from = p.sender_account || '';
        const ref = p.reference || '';
        return `<tr>
          <td>${dt}${tm}</td>
          <td>${method}</td>
          <td>${from}</td>
          <td>${ref}</td>
          <td class="text-right font-mono">${formatKes(p.amount)}</td>
          <td class="text-right"><button onclick="deleteSaPayment(${advanceId}, ${p.id})" class="text-rose-400 hover:text-rose-300 text-xs">Del</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  } catch (e) { container.textContent = 'Error loading payments'; }
}

async function saveSaPayment(e) {
  e.preventDefault();
  const advanceId = document.getElementById('sapm-advance-id').value;
  const { sender_account, reference } = getSapmSenderRef();
  const data = {
    amount: document.getElementById('sapm-amount').value,
    payment_date: document.getElementById('sapm-date').value,
    payment_time: document.getElementById('sapm-time').value || null,
    payment_method: document.getElementById('sapm-method').value || null,
    sender_account,
    reference,
    notes: document.getElementById('sapm-notes').value.trim() || null,
  };
  const resultEl = document.getElementById('sapm-result');
  try {
    await api.recordStaffAdvancePayment(advanceId, data);
    resultEl.textContent = 'Payment recorded.';
    resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    document.getElementById('sapm-amount').value = '';
    document.getElementById('sapm-notes').value = '';
    document.getElementById('sapm-method').value = '';
    document.getElementById('sapm-sender-row').classList.add('hidden');
    document.getElementById('sapm-ref-row').classList.add('hidden');
    clearSapmSenderRef();
    await loadSaPaymentHistory(advanceId);
    loadStaffAdvances();
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function deleteSaPayment(advanceId, paymentId) {
  if (!confirm('Delete this payment?')) return;
  try {
    await api.deleteStaffAdvancePayment(advanceId, paymentId);
    await loadSaPaymentHistory(advanceId);
    loadStaffAdvances();
  } catch (e) { alert('Error: ' + e.message); }
}

// ============================================================
// PHASE 6: EMPLOYEE RENT
// ============================================================

async function loadEmployeeRent() {
  const employee = document.getElementById('er-employee-filter')?.value || '';
  const period = document.getElementById('er-period-filter')?.value || '';
  try {
    const records = await api.listEmployeeRent(employee || undefined, period || undefined);
    renderEmployeeRentList(records);
    updateEmployeeRentSummary(records);
  } catch (e) {
    console.error('Error loading employee rent:', e);
  }
}

function renderEmployeeRentList(records) {
  const tbody = document.getElementById('er-list-tbody');
  if (!tbody) return;
  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-slate-500 py-6">No employee rent records</td></tr>';
    return;
  }
  tbody.innerHTML = records.map(r => {
    const statusClass = r.status === 'Fully Paid' ? 'text-green-400' :
      r.status === 'Partially Paid' ? 'text-amber-400' : 'text-rose-400';
    const buttons = [
      `<button onclick="showErPayments(${r.id})" class="text-cyan-400 hover:text-cyan-300 text-xs" title="Record Payment">Pay</button>`,
      `<button onclick="downloadEmployeeRentPdf(${r.id})" class="text-emerald-400 hover:text-emerald-300 text-xs" title="Download Invoice PDF">PDF</button>`,
    ];
    if (Number(r.outstanding || 0) > 0) {
      buttons.push(`<button onclick="showErDeductModal(${r.id}, ${Number(r.outstanding || 0)})" class="text-purple-400 hover:text-purple-300 text-xs" title="Deduct from Salary">Deduct</button>`);
    }
    if (r.status !== 'Fully Paid') {
      buttons.push(`<button onclick="editEmployeeRent(${r.id})" class="text-amber-400 hover:text-amber-300 text-xs" title="Edit">Edit</button>`);
    }
    buttons.push(`<button onclick="deleteEmployeeRent(${r.id})" class="text-rose-400 hover:text-rose-300 text-xs" title="Delete">Del</button>`);
    return `<tr>
      <td>${r.employee_name || ''}</td>
      <td>${r.property_name || ''} / ${r.unit_code || ''}</td>
      <td>${r.rent_period || ''}</td>
      <td class="text-right font-mono">${formatKes(r.monthly_rent)}</td>
      <td class="text-right font-mono text-green-400">${formatKes(r.total_paid)}</td>
      <td class="text-right font-mono text-purple-400">${formatKes(r.total_deducted)}</td>
      <td class="text-right font-mono text-rose-400">${formatKes(r.outstanding)}</td>
      <td><span class="${statusClass}">${r.status}</span></td>
      <td class="text-right space-x-2">${buttons.join(' ')}</td>
    </tr>`;
  }).join('');
}

function updateEmployeeRentSummary(records) {
  const totalDue = records.reduce((s, r) => s + Number(r.previous_balance || 0) + Number(r.monthly_rent || 0), 0);
  const totalPaid = records.reduce((s, r) => s + Number(r.total_paid || 0), 0);
  const totalDeducted = records.reduce((s, r) => s + Number(r.total_deducted || 0), 0);
  const totalOutstanding = records.reduce((s, r) => s + Number(r.outstanding || 0), 0);
  const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  el('er-total-due', formatKes(totalDue));
  el('er-total-paid', formatKes(totalPaid));
  el('er-total-deducted', formatKes(totalDeducted));
  el('er-total-outstanding', formatKes(totalOutstanding));
  el('er-record-count', records.length.toString());
}

async function loadEmployeeRentEmployees() {
  try {
    const employees = await api.listEmployeeRentEmployees();
    const filter = document.getElementById('er-employee-filter');
    if (filter) {
      const current = filter.value;
      filter.innerHTML = '<option value="">All Employees</option>' + employees.map(e => `<option value="${e}">${e}</option>`).join('');
      filter.value = current;
    }
  } catch (e) { console.error('Error loading employees:', e); }
}

function showErForm(record) {
  const wrap = document.getElementById('er-form-wrap');
  if (!wrap) return;
  wrap.classList.remove('hidden');

  const propSel = document.getElementById('er-property');
  if (propSel && propSel.options.length <= 1) {
    api.houses().then(({ houses }) => {
      propSel.innerHTML = '<option value="">Select property</option>' +
        houses.map(h => `<option value="${escapeHtml(h.house_name)}">${escapeHtml(h.house_name)}</option>`).join('');
      if (record && record.property_name) propSel.value = record.property_name;
    }).catch(() => {});
  }

  document.getElementById('er-form-id').value = record ? record.id : '';
  document.getElementById('er-employee').value = record ? record.employee_name : '';
  document.getElementById('er-unit').value = record ? record.unit_code : '';
  document.getElementById('er-monthly-rent').value = record ? record.monthly_rent : '';
  document.getElementById('er-due-day').value = record ? record.rent_due_day : 5;
  document.getElementById('er-period').value = record ? record.rent_period : new Date().toISOString().slice(0, 7);
  document.getElementById('er-previous-balance').value = record ? record.previous_balance : 0;
  document.getElementById('er-notes').value = record ? record.notes || '' : '';
  document.getElementById('er-form-result').textContent = '';
  if (record && record.property_name) {
    const propSel = document.getElementById('er-property');
    if (propSel) {
      propSel.value = record.property_name;
      if (!propSel.value) {
        const opt = document.createElement('option');
        opt.value = record.property_name;
        opt.textContent = record.property_name;
        propSel.appendChild(opt);
        propSel.value = record.property_name;
      }
    }
  } else {
    document.getElementById('er-property').value = '';
  }
  updateErPreview();
}

function hideErForm() {
  document.getElementById('er-form-wrap')?.classList.add('hidden');
}

function updateErPreview() {
  const prevBal = Number(document.getElementById('er-previous-balance')?.value || 0);
  const monthly = Number(document.getElementById('er-monthly-rent')?.value || 0);
  const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  el('er-prev-bal-display', formatKes(prevBal));
  el('er-monthly-display', formatKes(monthly));
  el('er-total-due-display', formatKes(prevBal + monthly));
}

async function saveEmployeeRent(e) {
  e.preventDefault();
  const id = document.getElementById('er-form-id').value;
  const data = {
    employee_name: document.getElementById('er-employee').value.trim(),
    property_name: document.getElementById('er-property').value,
    unit_code: document.getElementById('er-unit').value.trim(),
    monthly_rent: document.getElementById('er-monthly-rent').value,
    rent_due_day: document.getElementById('er-due-day').value,
    rent_period: document.getElementById('er-period').value,
    previous_balance: document.getElementById('er-previous-balance').value || 0,
    notes: document.getElementById('er-notes').value.trim() || null,
  };
  const resultEl = document.getElementById('er-form-result');
  try {
    if (id) {
      await api.updateEmployeeRent(id, data);
      resultEl.textContent = 'Rent record updated.';
      resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    } else {
      await api.createEmployeeRent(data);
      resultEl.textContent = 'Rent record created.';
      resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    }
    hideErForm();
    loadEmployeeRent();
    loadEmployeeRentEmployees();
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function editEmployeeRent(id) {
  try {
    const record = await api.getEmployeeRent(id);
    if (record) showErForm(record);
  } catch (e) { alert('Error loading rent record: ' + e.message); }
}

async function deleteEmployeeRent(id) {
  if (!confirm('Delete this rent record? This cannot be undone.')) return;
  try {
    await api.deleteEmployeeRent(id);
    loadEmployeeRent();
    loadEmployeeRentEmployees();
  } catch (e) { alert('Error: ' + e.message); }
}

async function showErPayments(rentId) {
  const modal = document.getElementById('er-payment-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  document.getElementById('erpm-rent-id').value = rentId;
  document.getElementById('erpm-amount').value = '';
  document.getElementById('erpm-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('erpm-method').value = '';
  document.getElementById('erpm-reference').value = '';
  document.getElementById('erpm-notes').value = '';
  document.getElementById('erpm-result').textContent = '';
  try {
    const rent = await api.getEmployeeRent(rentId);
    if (rent) {
      document.getElementById('er-pay-title').textContent = `Rent Payment: ${rent.employee_name}`;
      document.getElementById('er-pay-subtitle').textContent =
        `${rent.property_name} ${rent.unit_code} | Rent: ${formatKes(rent.monthly_rent)} | Paid: ${formatKes(rent.total_paid)} | Outstanding: ${formatKes(rent.outstanding)}`;
    }
    await loadErPaymentHistory(rentId);
  } catch (e) { console.error(e); }
}

async function loadErPaymentHistory(rentId) {
  const container = document.getElementById('erpm-payment-history');
  if (!container) return;
  try {
    const payments = await api.getEmployeeRentPayments(rentId);
    if (!payments.length) {
      container.innerHTML = '<p class="text-slate-500">No payments recorded.</p>';
      return;
    }
    container.innerHTML = `<table class="w-full text-xs">
      <thead><tr><th>Date</th><th>Method</th><th class="text-right">Amount</th><th>Ref</th><th></th></tr></thead>
      <tbody>${payments.map(p => `<tr>
        <td>${p.payment_date ? new Date(p.payment_date).toLocaleDateString() : ''}</td>
        <td>${p.payment_method || ''}</td>
        <td class="text-right font-mono">${formatKes(p.amount)}</td>
        <td>${p.reference || ''}</td>
        <td class="text-right"><button onclick="deleteErPayment(${rentId}, ${p.id})" class="text-rose-400 hover:text-rose-300 text-xs">Del</button></td>
      </tr>`).join('')}</tbody>
    </table>`;
  } catch (e) { container.textContent = 'Error loading payments'; }
}

async function saveErPayment(e) {
  e.preventDefault();
  const rentId = document.getElementById('erpm-rent-id').value;
  const data = {
    amount: document.getElementById('erpm-amount').value,
    payment_date: document.getElementById('erpm-date').value,
    payment_method: document.getElementById('erpm-method').value || null,
    reference: document.getElementById('erpm-reference').value.trim() || null,
    notes: document.getElementById('erpm-notes').value.trim() || null,
  };
  const resultEl = document.getElementById('erpm-result');
  try {
    await api.recordEmployeeRentPayment(rentId, data);
    resultEl.textContent = 'Payment recorded.';
    resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    document.getElementById('erpm-amount').value = '';
    document.getElementById('erpm-reference').value = '';
    document.getElementById('erpm-notes').value = '';
    await loadErPaymentHistory(rentId);
    loadEmployeeRent();
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function deleteErPayment(rentId, paymentId) {
  if (!confirm('Delete this payment?')) return;
  try {
    await api.deleteEmployeeRentPayment(rentId, paymentId);
    await loadErPaymentHistory(rentId);
    loadEmployeeRent();
  } catch (e) { alert('Error: ' + e.message); }
}

async function showErDeductModal(rentId, outstanding) {
  const modal = document.getElementById('er-deduct-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  document.getElementById('erd-rent-id').value = rentId;
  document.getElementById('erd-rent-outstanding').value = outstanding;
  document.getElementById('erd-rent-out').textContent = formatKes(outstanding);
  document.getElementById('erd-amount').value = '';
  document.getElementById('erd-result').textContent = '';
  const salarySel = document.getElementById('erd-salary-record');
  salarySel.innerHTML = '<option value="">Loading...</option>';
  try {
    const month = document.getElementById('salary-month-select')?.value || new Date().toISOString().slice(0, 7);
    const salaries = await api.listSalaryRecords(month);
    const employeeName = '';
    const empName = document.getElementById('er-employee-filter')?.value || '';
    const filtered = empName ? salaries.filter(s => s.employee_name === empName) : salaries;
    salarySel.innerHTML = '<option value="">Select salary</option>' +
      filtered.map(s => `<option value="${s.id}">${s.employee_name} (${s.salary_month}) - Balance: ${formatKes(s.outstanding)}</option>`).join('');
  } catch (e) { salarySel.innerHTML = '<option value="">Error loading salaries</option>'; }
}

async function saveErDeduction(e) {
  e.preventDefault();
  const rentId = document.getElementById('erd-rent-id').value;
  const salaryRecordId = document.getElementById('erd-salary-record').value;
  const amount = document.getElementById('erd-amount').value;
  const resultEl = document.getElementById('erd-result');
  if (!salaryRecordId) {
    resultEl.textContent = 'Please select a salary record.';
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    return;
  }
  try {
    await api.deductRentFromSalary(rentId, salaryRecordId, amount);
    resultEl.textContent = 'Deduction applied successfully.';
    resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    loadEmployeeRent();
    document.getElementById('erd-amount').value = '';
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

// ============================================================
// PHASE 6: STAFF ADVANCE ROLLOVER
// ============================================================

async function runStaffAdvanceRollover() {
  if (!confirm('Rollover all unrecovered staff advances to the next period?')) return;
  try {
    const advances = await api.listStaffAdvances();
    const unrecovered = advances.filter(a => a.status !== 'Fully Recovered' && a.status !== 'Written Off');
    if (!unrecovered.length) {
      alert('No unrecovered staff advances to rollover.');
      return;
    }
    let rolloverCount = 0;
    for (const adv of unrecovered) {
      if (adv.expected_recovery_month) {
        const parts = adv.expected_recovery_month.split('-');
        let nextMonth = parseInt(parts[1]) + 1;
        let nextYear = parseInt(parts[0]);
        if (nextMonth > 12) { nextMonth = 1; nextYear++; }
        const nextMonthStr = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
        await api.updateStaffAdvance(adv.id, { expected_recovery_month: nextMonthStr });
        rolloverCount++;
      }
    }
    alert(`Rolled over ${rolloverCount} staff advance(s).`);
    loadStaffAdvances();
  } catch (e) { alert('Error: ' + e.message); }
}

// ============================================================
// PHASE 6: EMPLOYEE RENT ROLLOVER
// ============================================================

async function runEmployeeRentRollover() {
  if (!confirm('Rollover all outstanding employee rent to the next month?')) return;
  try {
    const currentMonth = document.getElementById('er-period-filter')?.value || new Date().toISOString().slice(0, 7);
    const records = await api.listEmployeeRent(undefined, currentMonth);
    const outstanding = records.filter(r => Number(r.outstanding || 0) > 0);
    if (!outstanding.length) {
      alert('No outstanding employee rent to rollover.');
      return;
    }
    const parts = currentMonth.split('-');
    let nextMonth = parseInt(parts[1]) + 1;
    let nextYear = parseInt(parts[0]);
    if (nextMonth > 12) { nextMonth = 1; nextYear++; }
    const nextMonthStr = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
    let rolloverCount = 0;
    for (const rec of outstanding) {
      const existingRecords = await api.listEmployeeRent(rec.employee_name, nextMonthStr);
      const exists = existingRecords.find(r => r.property_name === rec.property_name && r.unit_code === rec.unit_code);
      if (!exists) {
        await api.createEmployeeRent({
          employee_name: rec.employee_name,
          property_name: rec.property_name,
          unit_code: rec.unit_code,
          monthly_rent: rec.monthly_rent,
          rent_due_day: rec.rent_due_day,
          rent_period: nextMonthStr,
          previous_balance: rec.outstanding,
          notes: `Rolled over from ${currentMonth}`,
        });
        rolloverCount++;
      }
    }
    alert(`Rolled over ${rolloverCount} rent record(s) to ${nextMonthStr}.`);
    loadEmployeeRent();
  } catch (e) { alert('Error: ' + e.message); }
}

// ============================================================
// PHASE 6: EVENT LISTENERS
// ============================================================

// Staff Advance navigation
document.getElementById('btn-back-staff-advance')?.addEventListener('click', showInvoiceTypeSelector);
document.getElementById('btn-new-staff-advance')?.addEventListener('click', () => showSaForm(null));
document.getElementById('btn-cancel-sa-form')?.addEventListener('click', hideSaForm);
document.getElementById('staff-advance-form')?.addEventListener('submit', saveStaffAdvance);
document.getElementById('sa-employee-filter')?.addEventListener('change', loadStaffAdvances);
document.getElementById('sa-payment-form')?.addEventListener('submit', saveSaPayment);
document.getElementById('sapm-method')?.addEventListener('change', onSaMethodChange);
document.getElementById('btn-close-sapm-modal')?.addEventListener('click', () => {
  document.getElementById('sa-payment-modal').style.display = 'none';
});

// Employee Rent navigation
document.getElementById('btn-back-employee-rent')?.addEventListener('click', showInvoiceTypeSelector);
document.getElementById('btn-new-employee-rent')?.addEventListener('click', () => showErForm(null));
document.getElementById('btn-cancel-er-form')?.addEventListener('click', hideErForm);
document.getElementById('employee-rent-form')?.addEventListener('submit', saveEmployeeRent);
document.getElementById('er-employee-filter')?.addEventListener('change', loadEmployeeRent);
document.getElementById('er-period-filter')?.addEventListener('change', loadEmployeeRent);
document.getElementById('er-payment-form')?.addEventListener('submit', saveErPayment);
document.getElementById('btn-close-erpm-modal')?.addEventListener('click', () => {
  document.getElementById('er-payment-modal').style.display = 'none';
});
document.getElementById('er-deduct-form')?.addEventListener('submit', saveErDeduction);
document.getElementById('btn-close-erd-modal')?.addEventListener('click', () => {
  document.getElementById('er-deduct-modal').style.display = 'none';
});

// Employee Rent preview
document.getElementById('er-previous-balance')?.addEventListener('input', updateErPreview);
document.getElementById('er-monthly-rent')?.addEventListener('input', updateErPreview);

// Expose functions to window
window.loadStaffAdvances = loadStaffAdvances;
window.showSaPayments = showSaPayments;
window.editStaffAdvance = editStaffAdvance;
window.deleteStaffAdvance = deleteStaffAdvance;
window.deleteSaPayment = deleteSaPayment;
window.showSaForm = showSaForm;
window.loadEmployeeRent = loadEmployeeRent;
window.showErPayments = showErPayments;
window.editEmployeeRent = editEmployeeRent;
window.deleteEmployeeRent = deleteEmployeeRent;
window.deleteErPayment = deleteErPayment;
window.showErForm = showErForm;
window.showErDeductModal = showErDeductModal;
window.runStaffAdvanceRollover = runStaffAdvanceRollover;
window.runEmployeeRentRollover = runEmployeeRentRollover;

async function downloadStaffAdvancePdf(id) {
  try {
    const result = await api.downloadStaffAdvanceInvoice(id);
    triggerFileDownload(result, null, 'Staff advance invoice downloaded');
  } catch (e) { alert('Error: ' + e.message); }
}

async function downloadEmployeeRentPdf(id) {
  try {
    const result = await api.downloadEmployeeRentInvoice(id);
    triggerFileDownload(result, null, 'Employee rent invoice downloaded');
  } catch (e) { alert('Error: ' + e.message); }
}

window.downloadStaffAdvancePdf = downloadStaffAdvancePdf;
window.downloadEmployeeRentPdf = downloadEmployeeRentPdf;

document.getElementById('payments-tbody')?.addEventListener('click', async (e) => {
  const approveId = e.target.dataset.approvePayment;
  const deleteId = e.target.dataset.deletePayment;
  const viewReceiptId = e.target.dataset.viewReceipt;
  const downloadReceiptId = e.target.dataset.downloadReceipt;

  if (viewReceiptId) {
    try {
      const { document } = await api.paymentReceipt(viewReceiptId);
      if (!document) throw new Error('No receipt available for this payment');
      await openDocumentViewModal(document);
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  if (downloadReceiptId) {
    try {
      const { document } = await api.paymentReceipt(downloadReceiptId);
      if (!document) throw new Error('No receipt available for this payment');
      await downloadDocumentFile(document);
    } catch (err) {
      alert(err.message);
    }
    return;
  }

  if (approveId) {
    if (!confirm('Approve this payment and notify tenant on WhatsApp?')) return;
    try {
      const result = await api.approvePayment(approveId);

      if (result.overpayment > 0) {
        showOverpaymentPrompt(result);
        loadPayments();
        loadDashboard();
        return;
      }

      const wa = result.whatsapp || {};
      const waStatus = wa.status || 'Skipped';

      loadPayments();
      loadDashboard();

      if (waStatus === 'Failed') {
        const resendBtn = `<button onclick="resendPaymentWhatsApp('${approveId}')" style="background:#3b82f6;color:white;padding:4px 12px;border-radius:4px;border:none;cursor:pointer;margin-top:8px">Resend WhatsApp</button>`;
        alert(`Payment approved successfully.\n\nWhatsApp delivery failed${wa.failureReason ? ': ' + wa.failureReason : ''}.\n\nYou can resend using the button below.`);
        setTimeout(() => {
          const existing = document.getElementById('wa-resend-banner');
          if (existing) existing.remove();
          const banner = document.createElement('div');
          banner.id = 'wa-resend-banner';
          banner.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#1e293b;border:1px solid #ef4444;padding:16px;border-radius:8px;z-index:9999;max-width:350px;color:#e2e8f0;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
          banner.innerHTML = `<div>WhatsApp delivery failed for this payment.</div>${resendBtn} <button onclick="this.parentElement.remove()" style="background:transparent;color:#94a3b8;border:none;cursor:pointer;margin-left:8px">Dismiss</button>`;
          document.body.appendChild(banner);
        }, 100);
      } else if (waStatus === 'Pending') {
        // Live status banner instead of a one-shot alert: updates itself to
        // Delivered/Read as soon as the WhatsApp delivery receipt arrives.
        const pdfNote = result.pdf ? ` PDF receipt: ${result.pdf.status}.` : '';
        if (result.payment && result.payment.id) {
          trackPaymentDelivery(result.payment.id, null, 'Approved. WhatsApp');
        } else {
          alert(`Approved. WhatsApp: Pending.${pdfNote}`);
        }
      } else {
        const pdfStatus = result.pdf ? ` PDF receipt: ${result.pdf.status}.` : '';
        alert(`Approved. WhatsApp: ${waStatus}.${pdfStatus}`);
      }
    } catch (err) {
      alert(err.message);
    }
  } else if (deleteId) {
    // Permanently deleting a financial record requires a live connection (§14).
    if (!requireOnline('deleteFinancial', effectiveOffline, showToast)) return;
    if (!confirm('Are you sure you want to delete this payment record? All of its allocations (rent, deposit, garbage, water, charges, balances) will be rolled back.')) return;
    try {
      const result = await api.deletePayment(deleteId);
      showDeleteWarnings(result);
      loadPayments();
      loadDashboard();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('td-payments-tbody')?.addEventListener('click', async (e) => {
  const viewId = e.target.dataset.tdViewReceipt;
  const downloadId = e.target.dataset.tdDownloadReceipt;
  if (viewId || downloadId) {
    try {
      const { document } = await api.paymentReceipt(viewId || downloadId);
      if (!document) throw new Error('No receipt available for this payment');
      if (viewId) await openDocumentViewModal(document);
      else await downloadDocumentFile(document);
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  const deleteId = e.target.dataset.tdDeletePayment;
  if (!deleteId) return;
  if (!requireOnline('deleteFinancial', effectiveOffline, showToast)) return;
  if (!confirm('Are you sure you want to delete this payment record? All of its allocations (rent, deposit, garbage, water, charges, balances) will be rolled back.')) return;
  try {
    const result = await api.deletePayment(deleteId);
    showDeleteWarnings(result);
    const hash = window.location.hash || '';
    const match = hash.match(/^#tenant\/(.+)/);
    if (match) loadTenantDashboard(match[1]);
  } catch (err) {
    alert(err.message);
  }
});

// Surfaces partial-rollback notes returned by payment deletion.
function showDeleteWarnings(result) {
  if (!result) return;
  const warnings = result.warnings || [];
  if (result.fallback) {
    warnings.unshift('This payment predates allocation tracking, so balances were rebuilt from remaining payments — verify the account.');
  }
  if (warnings.length) {
    showToast('Payment deleted with notes — see alert.', 'error');
    alert('Payment deleted and allocations rolled back.\n\nPlease verify:\n- ' + warnings.join('\n- '));
  } else {
    showToast('Payment deleted — all allocations rolled back.');
  }
}

// ─── Signed tenancy agreement upload / preview / delete ────────────────────

document.getElementById('btn-td-agreement-upload')?.addEventListener('click', () => {
  if (!activeTenantCode) return showToast('Open a tenant first.', 'error');
  document.getElementById('td-agreement-file')?.click();
});

document.getElementById('btn-td-scan-doc')?.addEventListener('click', () => {
  if (!activeTenantCode) return showToast('Open a tenant first.', 'error');
  // capture="environment" opens the rear camera directly on mobile;
  // desktop browsers fall back to the file picker (same pipeline).
  document.getElementById('td-agreement-scan')?.click();
});

async function handleAgreementFiles(fileList) {
  const code = activeTenantCode;
  if (!code) return;
  const btn = document.getElementById('btn-td-agreement-upload');
  const scanBtn = document.getElementById('btn-td-scan-doc');
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Compressing…'; }
    if (scanBtn) scanBtn.disabled = true;
    const { blob, filename, approxKB } = await prepareAgreementFiles(fileList, code);
    if (btn) btn.textContent = `Uploading (${approxKB} KB)…`;
    await api.uploadAgreement(code, blob, filename);
    showToast(`Agreement saved (${approxKB} KB).`);
    loadTenantDashboard(code);
  } catch (err) {
    showToast('Upload failed: ' + (err.message || err), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Upload Signed Copy'; }
    if (scanBtn) scanBtn.disabled = false;
  }
}

document.getElementById('td-agreement-file')?.addEventListener('change', async (e) => {
  const input = e.target;
  if (!input.files || !input.files.length) { input.value = ''; return; }
  await handleAgreementFiles(input.files);
  input.value = '';
});

document.getElementById('td-agreement-scan')?.addEventListener('change', async (e) => {
  const input = e.target;
  if (!input.files || !input.files.length) { input.value = ''; return; }
  showToast(`Compressing ${input.files.length} scanned page(s)…`);
  await handleAgreementFiles(input.files);
  input.value = '';
});

document.getElementById('td-agreements-tbody')?.addEventListener('click', async (e) => {
  const prevBtn = e.target.closest('[data-ag-preview]');
  const delBtn = e.target.closest('[data-ag-delete]');
  const code = activeTenantCode;
  if (!code) return;
  if (prevBtn) {
    try {
      prevBtn.disabled = true;
      const { url } = await api.previewAgreement(code, prevBtn.dataset.agPreview);
      const frame = document.getElementById('td-agreement-frame');
      if (frame) frame.src = url;
      // Links expire in ~2 minutes — note it so a stale tab isn't confusing.
      const note = document.getElementById('td-agreement-preview-note');
      if (note) note.textContent = 'Preview link expires shortly; reopen Preview if it stops loading.';
      document.getElementById('td-agreement-modal')?.classList.remove('hidden');
    } catch (err) {
      showToast('Preview failed: ' + (err.message || err), 'error');
    } finally {
      prevBtn.disabled = false;
    }
  } else if (delBtn) {
    if (!confirm('Delete this signed agreement? The file will be permanently removed from storage.')) return;
    try {
      delBtn.disabled = true;
      await api.deleteAgreement(code, delBtn.dataset.agDelete);
      showToast('Agreement deleted.');
      loadTenantDashboard(code);
    } catch (err) {
      showToast('Delete failed: ' + (err.message || err), 'error');
      delBtn.disabled = false;
    }
  }
});

document.getElementById('btn-td-agreement-close')?.addEventListener('click', () => {
  const frame = document.getElementById('td-agreement-frame');
  if (frame) frame.removeAttribute('src');
  document.getElementById('td-agreement-modal')?.classList.add('hidden');
});

document.getElementById('wa-beacon-slot')?.addEventListener('click', (e) => {
  if (e.target.id === 'btn-wa-reset') handleWhatsappReset();
});

bootOffline();
initSession();
window.removeInvoiceItem = removeInvoiceItem;

window.resendPaymentWhatsApp = async function(paymentId) {
  const banner = document.getElementById('wa-resend-banner');
  if (banner) banner.remove();
  try {
    const result = await api.resendPaymentWhatsApp(paymentId);
    const wa = result.whatsapp || {};
    if (wa.status === 'Failed') {
      alert(`Resend failed: ${wa.failureReason || 'Unknown error'}`);
    } else {
      alert(`WhatsApp resent successfully. Status: ${wa.status}`);
    }
  } catch (err) {
    alert('Resend failed: ' + err.message);
  }
};

window.addEventListener('hashchange', () => {
  if (!api.getToken()) return;
  applyRoute();
});


// --- INVOICES FEATURE ---

let invoiceItemCount = 0;

function addInvoiceItem() {
  const tbody = document.getElementById('invoice-items-tbody');
  if (!tbody) return;
  const id = ++invoiceItemCount;
  const tr = document.createElement('tr');
  tr.id = `invoice-item-${id}`;
  tr.innerHTML = `
    <td><input type="number" class="cyber-input p-1 w-full text-center invoice-calc" name="qty[]" value="1" min="1" /></td>
    <td><input type="text" class="cyber-input p-1 w-full" name="desc[]" placeholder="Item description" required /></td>
    <td><input type="number" class="cyber-input p-1 w-full text-right invoice-calc" name="price[]" value="0" min="0" /></td>
    <td class="text-right font-mono text-slate-300 align-middle">KES <span class="item-total">0</span></td>
    <td class="text-center align-middle"><button type="button" class="text-rose-400 hover:text-rose-300 px-2" onclick="removeInvoiceItem(${id})">×</button></td>
  `;
  tbody.appendChild(tr);
  
  tr.querySelectorAll('.invoice-calc').forEach(inp => {
    inp.addEventListener('input', calculateInvoiceTotals);
  });
  calculateInvoiceTotals();
}

function addDeductionItem() {
  const tbody = document.getElementById('invoice-items-tbody');
  if (!tbody) return;
  const id = ++invoiceItemCount;
  const tr = document.createElement('tr');
  tr.id = `invoice-item-${id}`;
  tr.innerHTML = `
    <td><input type="number" class="cyber-input p-1 w-full text-center invoice-calc" name="qty[]" value="1" min="1" /></td>
    <td><input type="text" class="cyber-input p-1 w-full text-rose-400" name="desc[]" placeholder="Deduction (e.g. Painting)" required /></td>
    <td><input type="number" class="cyber-input p-1 w-full text-right invoice-calc text-rose-400 deduction-price" name="price[]" value="0" step="any" placeholder="Deduction amount" /></td>
    <td class="text-right font-mono text-rose-400 align-middle">KES <span class="item-total">0</span></td>
    <td class="text-center align-middle"><button type="button" class="text-rose-400 hover:text-rose-300 px-2" onclick="removeInvoiceItem(${id})">×</button></td>
  `;
  tbody.appendChild(tr);

  tr.querySelectorAll('.invoice-calc').forEach(inp => {
    inp.addEventListener('input', calculateInvoiceTotals);
  });
  calculateInvoiceTotals();
}

function removeInvoiceItem(id) {
  const tr = document.getElementById(`invoice-item-${id}`);
  if (tr) {
    tr.remove();
    calculateInvoiceTotals();
  }
}

function calculateInvoiceTotals() {
  let subtotal = 0;
  let deductions = 0;
  const tbody = document.getElementById('invoice-items-tbody');
  if (tbody) {
    const rows = tbody.querySelectorAll('tr');
    rows.forEach(row => {
      const qty = Number(row.querySelector('input[name="qty[]"]').value) || 0;
      let price = Number(row.querySelector('input[name="price[]"]').value) || 0;
      if (row.querySelector('.deduction-price')) price = -Math.abs(price);
      const total = qty * price;
      if (price < 0) {
        deductions += total;
      } else {
        subtotal += total;
      }
      row.querySelector('.item-total').textContent = total.toLocaleString();
    });
  }

  const grandTotal = subtotal + deductions;

  const subEl = document.getElementById('invoice-subtotal');
  const dedEl = document.getElementById('invoice-total-deductions');
  const grandEl = document.getElementById('invoice-grand-total');

  if (subEl) subEl.textContent = `KES ${subtotal.toLocaleString()}`;
  if (dedEl) dedEl.textContent = `KES ${Math.abs(deductions).toLocaleString()}`;
  if (grandEl) grandEl.textContent = `KES ${grandTotal.toLocaleString()}`;
}

async function loadInvoicesCenter() {
  const { tenants } = await api.tenants();
  window.invoiceTenantsCache = tenants;
  window.exitTenantsCache = tenants;
  window.rentInvoiceTenantsCache = tenants;
  const option = t => `<option value="${escapeHtml(t.name)} (${escapeHtml(t.tenant_code)})"></option>`;
  const dl1 = document.getElementById('invoice-tenant-datalist');
  if (dl1) dl1.innerHTML = tenants.map(option).join('');
  const dl2 = document.getElementById('exit-tenant-datalist');
  if (dl2) dl2.innerHTML = tenants.map(option).join('');
  const dl3 = document.getElementById('rent-invoice-tenant-datalist');
  if (dl3) dl3.innerHTML = tenants.map(option).join('');

  showInvoiceTypeSelector();

  const tbody = document.getElementById('invoice-items-tbody');
  if (tbody && tbody.children.length === 0) {
    addInvoiceItem();
  }

  const dateInput = document.getElementById('invoice-date');
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().split('T')[0];
  }
  const exitDate = document.getElementById('exit-date');
  if (exitDate && !exitDate.value) {
    exitDate.value = new Date().toISOString().split('T')[0];
  }
}

function showInvoiceTypeSelector() {
  const selector = document.getElementById('invoice-type-selector');
  if (selector) selector.classList.remove('hidden');
  document.getElementById('maintenance-invoice-panel')?.classList.add('hidden');
  document.getElementById('exit-invoice-panel')?.classList.add('hidden');
  document.getElementById('rent-invoice-panel')?.classList.add('hidden');
  document.getElementById('maintenance-invoices-panel')?.classList.add('hidden');
  document.getElementById('salary-panel')?.classList.add('hidden');
  document.getElementById('staff-advance-panel')?.classList.add('hidden');
  document.getElementById('employee-rent-panel')?.classList.add('hidden');
  document.getElementById('water-bill-panel')?.classList.add('hidden');
}

function showInvoiceType(type) {
  document.getElementById('invoice-type-selector')?.classList.add('hidden');
  document.getElementById('maintenance-invoice-panel')?.classList.toggle('hidden', type !== 'maintenance');
  document.getElementById('exit-invoice-panel')?.classList.toggle('hidden', type !== 'exit');
  document.getElementById('rent-invoice-panel')?.classList.toggle('hidden', type !== 'rent');
  const mntPanel = document.getElementById('maintenance-invoices-panel');
  mntPanel?.classList.toggle('hidden', type !== 'maintenance-invoice');
  if (type === 'maintenance-invoice') { loadMaintenanceInvoices(); populatePropertyDropdowns(); }
  document.getElementById('salary-panel')?.classList.toggle('hidden', type !== 'salary');
  if (type === 'salary') loadSalaryDashboard();
  document.getElementById('staff-advance-panel')?.classList.toggle('hidden', type !== 'staff-advance');
  if (type === 'staff-advance') { loadStaffAdvances(); loadStaffAdvanceEmployees(); }
  document.getElementById('employee-rent-panel')?.classList.toggle('hidden', type !== 'employee-rent');
  if (type === 'employee-rent') { loadEmployeeRent(); loadEmployeeRentEmployees(); populatePropertyDropdowns(); }
  document.getElementById('water-bill-panel')?.classList.toggle('hidden', type !== 'water-bill');
  if (type === 'water-bill') { loadWaterBillInvoices(); populateWaterBillDropdowns(); }
}

function resolveTenant(searchInputId, cacheKey) {
  const searchVal = document.getElementById(searchInputId)?.value;
  const cache = window[cacheKey];
  return cache?.find(t => `${t.name} (${t.tenant_code})` === searchVal) || null;
}

function money(n) {
  return `KES ${Number(n || 0).toLocaleString()}`;
}

async function autoLoadOutstandingMaintenance() {
  const match = resolveTenant('invoice-tenant-search', 'invoiceTenantsCache');
  const tbody = document.getElementById('invoice-items-tbody');
  if (!tbody) return;
  if (!match) {
    tbody.innerHTML = '';
    invoiceItemCount = 0;
    addInvoiceItem();
    return;
  }
  const resEl = document.getElementById('invoice-result');
  if (resEl) {
    resEl.textContent = 'Loading outstanding charges...';
    resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  }
  try {
    const summary = await api.getInvoiceTenantSummary(match.tenant_code);
    tbody.innerHTML = '';
    invoiceItemCount = 0;
    if (!summary.outstanding.length) {
      addInvoiceItem();
      if (resEl) {
        resEl.textContent = 'No outstanding charges found for this tenant.';
        resEl.className = 'text-sm font-mono text-slate-400 text-right mt-2';
      }
    } else {
      summary.outstanding.forEach(o => {
        const id = ++invoiceItemCount;
        const tr = document.createElement('tr');
        tr.id = `invoice-item-${id}`;
        tr.innerHTML = `
          <td><input type="number" class="cyber-input p-1 w-full text-center invoice-calc" name="qty[]" value="1" min="1" /></td>
          <td><input type="text" class="cyber-input p-1 w-full" name="desc[]" value="${escapeHtml(o.description)}" required /></td>
          <td><input type="number" class="cyber-input p-1 w-full text-right invoice-calc" name="price[]" value="${Number(o.amount || 0)}" min="0" /></td>
          <td class="text-right font-mono text-slate-300 align-middle">KES <span class="item-total">0</span></td>
          <td class="text-center align-middle"><button type="button" class="text-rose-400 hover:text-rose-300 px-2" onclick="removeInvoiceItem(${id})">×</button></td>
        `;
        tbody.appendChild(tr);
        tr.querySelectorAll('.invoice-calc').forEach(inp => inp.addEventListener('input', calculateInvoiceTotals));
      });
      calculateInvoiceTotals();
      if (resEl) {
        resEl.textContent = `Loaded ${summary.outstanding.length} outstanding charge(s). Remove any you do not want.`;
        resEl.className = 'text-sm font-mono text-cyan-400 text-right mt-2';
      }
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Failed to load outstanding charges: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  }
}

function buildMaintenancePayload() {
  const match = resolveTenant('invoice-tenant-search', 'invoiceTenantsCache');
  if (!match) throw new Error('Please select a valid tenant from the dropdown list.');
  const date = document.getElementById('invoice-date').value;
  const invoice_no = document.getElementById('invoice-manual-no').value.trim();
  const items = [];
  const tbody = document.getElementById('invoice-items-tbody');
  if (tbody) {
    tbody.querySelectorAll('tr').forEach(row => {
      let price = Number(row.querySelector('input[name="price[]"]').value) || 0;
      if (row.querySelector('.deduction-price')) price = -Math.abs(price);
      items.push({
        qty: Number(row.querySelector('input[name="qty[]"]').value) || 1,
        description: row.querySelector('input[name="desc[]"]').value,
        unit_price: price,
      });
    });
  }
  if (!items.length) throw new Error('Add at least one line item.');
  return { tenant_id: match.id, date, invoice_no, invoice_type: 'maintenance', items };
}

function resetMaintenanceInvoice() {
  const form = document.getElementById('invoice-form');
  if (form) form.reset();
  const tbody = document.getElementById('invoice-items-tbody');
  if (tbody) tbody.innerHTML = '';
  invoiceItemCount = 0;
  addInvoiceItem();
  const dateInput = document.getElementById('invoice-date');
  if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
}

function triggerFileDownload(result, resEl, message) {
  const filename = result.filename || 'invoice.pdf';
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  if (resEl) {
    resEl.textContent = message || `Downloaded ${filename}`;
    resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
  }
}

async function runInvoiceAction(mode) {
  const resEl = document.getElementById('invoice-result');
  const btn = mode === 'send' ? document.getElementById('btn-send-invoice')
    : mode === 'both' ? document.getElementById('btn-invoice-both') : document.getElementById('btn-invoice-download');
  if (resEl) {
    resEl.textContent = mode === 'send' ? 'Generating PDF and sending...'
      : mode === 'both' ? 'Sending via WhatsApp and generating PDF...' : 'Generating PDF...';
    resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  }
  if (btn) btn.disabled = true;

  try {
    const payload = buildMaintenancePayload();
    if (mode === 'download') {
      const result = await api.downloadInvoice(payload);
      triggerFileDownload(result, resEl, `Downloaded ${result.filename}`);
    } else if (mode === 'both') {
      const result = await api.sendAndDownloadInvoice(payload);
      triggerFileDownload(result, resEl, `Sent via WhatsApp & downloaded ${result.filename}`);
    } else {
      await api.sendInvoice({ ...payload, mode: 'send' });
      if (resEl) {
        resEl.textContent = 'Invoice sent successfully!';
        resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
      }
      resetMaintenanceInvoice();
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadExitSummary() {
  const match = resolveTenant('exit-tenant-search', 'exitTenantsCache');
  const infoBox = document.getElementById('exit-tenant-info');
  const resEl = document.getElementById('exit-result');
  window.exitSummaryLoaded = false;
  if (!match) {
    infoBox?.classList.add('hidden');
    return;
  }
  if (resEl) {
    resEl.textContent = 'Loading tenant balances...';
    resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  }
  try {
    const summary = await api.getInvoiceTenantSummary(match.tenant_code);
    window.exitSummaryLoaded = true;
    window.exitSummary = summary;
    if (infoBox) infoBox.classList.remove('hidden');

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('exit-info-name', summary.tenant.name);
    set('exit-info-unit', `${summary.tenant.property_name} / ${summary.tenant.unit_label || summary.tenant.tenant_code}`);
    set('exit-info-rent', money(summary.tenant.rent_amount));
    set('exit-info-phone', summary.tenant.phone_number || '—');
    set('exit-deposit-required', money(summary.deposit.amount));
    set('exit-deposit-balance', money(summary.deposit.balance));
    const depPaid = document.getElementById('exit-deposit-paid');
    if (depPaid) depPaid.value = summary.deposit.paid;

    const ob = document.getElementById('exit-outstanding-tbody');
    ob.innerHTML = '';
    if (summary.outstanding.length) {
      summary.outstanding.forEach(o => {
        const tr = document.createElement('tr');
        tr.dataset.amount = Number(o.amount || 0);
        tr.innerHTML = `
          <td>${escapeHtml(o.description)}</td>
          <td class="text-right font-mono text-rose-400">${money(o.amount)}</td>
        `;
        ob.appendChild(tr);
      });
    } else {
      ob.innerHTML = '<tr><td class="text-slate-400">No outstanding balances.</td><td class="text-right font-mono text-slate-400">KES 0</td></tr>';
    }

    document.getElementById('exit-deductions-tbody').innerHTML = '';
    invoiceItemCount = 0;
    calculateExitSettlement();

    if (resEl) {
      resEl.textContent = summary.outstanding.length
        ? `Loaded ${summary.outstanding.length} outstanding balance(s).`
        : 'No outstanding balances found.';
      resEl.className = 'text-sm font-mono text-cyan-400 text-right mt-2';
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Failed to load tenant balances: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  }
}

function addExitDeduction() {
  const tbody = document.getElementById('exit-deductions-tbody');
  if (!tbody) return;
  const id = ++invoiceItemCount;
  const tr = document.createElement('tr');
  tr.id = `exit-deduction-${id}`;
  tr.innerHTML = `
    <td><input type="text" class="cyber-input p-1 w-full" name="exit-desc[]" placeholder="e.g. Repairs, Cleaning, Painting" required /></td>
    <td><input type="number" class="cyber-input p-1 w-full text-right exit-deduction-amount" name="exit-amount[]" value="0" min="0" required /></td>
    <td class="text-center align-middle"><button type="button" class="text-rose-400 hover:text-rose-300 px-2" onclick="removeExitDeduction(${id})">×</button></td>
  `;
  tbody.appendChild(tr);
  tr.querySelector('.exit-deduction-amount').addEventListener('input', calculateExitSettlement);
  calculateExitSettlement();
}

function removeExitDeduction(id) {
  const tr = document.getElementById(`exit-deduction-${id}`);
  if (tr) {
    tr.remove();
    calculateExitSettlement();
  }
}
window.removeExitDeduction = removeExitDeduction;

function calculateExitSettlement() {
  const depositPaid = Number(document.getElementById('exit-deposit-paid')?.value) || 0;
  let outstandingTotal = 0;
  document.querySelectorAll('#exit-outstanding-tbody tr').forEach(row => {
    outstandingTotal += Number(row.dataset.amount || 0);
  });
  let deductionsTotal = 0;
  document.querySelectorAll('.exit-deduction-amount').forEach(inp => {
    deductionsTotal += Math.abs(Number(inp.value) || 0);
  });
  const totalDeductions = outstandingTotal + deductionsTotal;
  const settlement = depositPaid - totalDeductions;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('exit-outstanding-total', money(outstandingTotal));
  set('exit-deductions-total', money(deductionsTotal));
  set('exit-settle-deposit-paid', money(depositPaid));
  set('exit-settle-total-deductions', money(totalDeductions));

  const box = document.getElementById('exit-settlement-box');
  const label = document.getElementById('exit-settle-label');
  const result = document.getElementById('exit-settle-result');
  if (!box || !label || !result) return;
  if (!window.exitSummaryLoaded) {
    box.className = 'rounded-lg border p-4 text-center border-slate-600 bg-slate-800/40';
    label.textContent = 'Final Settlement';
    result.className = 'text-lg font-mono font-bold text-slate-300 mt-2';
    result.textContent = 'Select a tenant';
    return;
  }
  if (settlement >= 0) {
    box.className = 'rounded-lg border p-4 text-center border-emerald-600 bg-emerald-950/40';
    label.textContent = 'Deposit Refund';
    result.className = 'text-2xl font-mono font-bold text-emerald-400 mt-2';
    result.textContent = money(settlement);
  } else {
    box.className = 'rounded-lg border p-4 text-center border-rose-600 bg-rose-950/40';
    label.textContent = 'Amount Payable by Tenant';
    result.className = 'text-2xl font-mono font-bold text-rose-400 mt-2';
    result.textContent = money(Math.abs(settlement));
  }
}

function buildExitPayload() {
  if (!window.exitSummaryLoaded) throw new Error('Select the tenant first and wait for their balances to load.');
  const match = resolveTenant('exit-tenant-search', 'exitTenantsCache');
  if (!match) throw new Error('Please select a valid tenant from the dropdown list.');
  const date = document.getElementById('exit-date').value;
  const deductions = [];
  document.querySelectorAll('#exit-deductions-tbody tr').forEach(row => {
    const desc = row.querySelector('input[name="exit-desc[]"]')?.value;
    const amt = Math.abs(Number(row.querySelector('.exit-deduction-amount')?.value) || 0);
    if (desc && amt > 0) deductions.push({ description: desc, amount: amt });
  });
  return { tenant_id: match.id, date, invoice_type: 'exit', deductions };
}

async function runExitAction(mode) {
  const resEl = document.getElementById('exit-result');
  const btn = mode === 'send' ? document.getElementById('btn-send-exit-invoice')
    : mode === 'both' ? document.getElementById('btn-exit-both') : document.getElementById('btn-exit-download');
  if (resEl) {
    resEl.textContent = mode === 'download' ? 'Generating exit statement PDF...' : 'Generating and sending...';
    resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  }
  if (btn) btn.disabled = true;

  try {
    const payload = buildExitPayload();
    if (mode === 'download') {
      const result = await api.downloadInvoice(payload);
      triggerFileDownload(result, resEl, `Downloaded ${result.filename}`);
    } else if (mode === 'both') {
      const result = await api.sendAndDownloadInvoice(payload);
      triggerFileDownload(result, resEl, `Sent via WhatsApp & downloaded ${result.filename}`);
    } else {
      const result = await api.sendInvoice({ ...payload, mode: 'send' });
      if (resEl) {
        resEl.textContent = `Exit statement sent successfully!${result.invoice_no ? ` (${result.invoice_no})` : ''}`;
        resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
      }
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function loadRentInvoiceTenantInfo() {
  const match = resolveTenant('rent-invoice-tenant-search', 'rentInvoiceTenantsCache');
  const infoBox = document.getElementById('rent-invoice-info');
  if (!match) {
    infoBox?.classList.add('hidden');
    return;
  }
  if (infoBox) infoBox.classList.remove('hidden');
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('rent-invoice-info-name', match.name);
  set('rent-invoice-info-unit', `${match.property_name || ''} / ${match.unit_label || match.tenant_code}`);
  set('rent-invoice-info-rent', money(match.rent_amount));
  set('rent-invoice-info-phone', match.phone_number || '—');
}

function buildRentInvoicePayload() {
  const match = resolveTenant('rent-invoice-tenant-search', 'rentInvoiceTenantsCache');
  if (!match) throw new Error('Please select a valid tenant from the dropdown list.');
  return {
    tenant_id: match.id,
    billing_period: document.getElementById('rent-invoice-period').value || null,
  };
}

async function runRentInvoiceAction(mode) {
  const resEl = document.getElementById('rent-invoice-result');
  const btn = mode === 'send' ? document.getElementById('btn-send-rent-invoice')
    : mode === 'both' ? document.getElementById('btn-rent-invoice-both') : document.getElementById('btn-rent-invoice-download');
  if (resEl) {
    resEl.textContent = mode === 'download' ? 'Generating rent invoice PDF...' : 'Generating and sending rent invoice...';
    resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  }
  if (btn) btn.disabled = true;

  try {
    const payload = buildRentInvoicePayload();
    if (mode === 'download') {
      const result = await api.downloadRentInvoice(payload.tenant_id, payload.billing_period);
      triggerFileDownload(result, resEl, `Downloaded ${result.filename}`);
    } else if (mode === 'both') {
      const result = await api.sendAndDownloadRentInvoice(payload.tenant_id, payload.billing_period);
      triggerFileDownload(result, resEl, `Sent via WhatsApp & downloaded ${result.filename}`);
    } else {
      const result = await api.generateRentInvoice(payload.tenant_id, 'send', payload.billing_period);
      if (resEl) {
        resEl.textContent = `Rent invoice sent successfully!${result.invoice_no ? ` (${result.invoice_no})` : ''}`;
        resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
      }
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ============================================================
// MANAGEMENT EXPENSES INVOICE
// ============================================================

const MNT_CATEGORY_FIELDS = {
  petty_cash: [
    { id: 'mnt-date-spent', label: 'Date Spent', type: 'date', required: true },
    { id: 'mnt-location', label: 'Location / Property', type: 'text', placeholder: 'e.g. Blue House' },
    { id: 'mnt-purpose', label: 'Purpose / Description', type: 'text', placeholder: 'What was the money used for?', required: true },
    { id: 'mnt-person', label: 'Person Who Used / Received', type: 'text', placeholder: 'e.g. John Doe' },
    { id: 'mnt-receipt', label: 'Supporting Receipt / Document', type: 'text', placeholder: 'Receipt reference or file name' },
  ],
  office_purchase: [
    { id: 'mnt-date-spent', label: 'Date Purchased', type: 'date', required: true },
    { id: 'mnt-item-purchased', label: 'Item Purchased', type: 'text', placeholder: 'e.g. Printer toner', required: true },
    { id: 'mnt-quantity', label: 'Quantity', type: 'number', placeholder: '1' },
    { id: 'mnt-supplier', label: 'Supplier', type: 'text', placeholder: 'e.g. OfficeMax' },
    { id: 'mnt-location', label: 'Location / Property', type: 'text', placeholder: 'e.g. Blue House' },
    { id: 'mnt-receipt', label: 'Supporting Receipt / Document', type: 'text', placeholder: 'Receipt reference or file name' },
  ],
  administration: [
    { id: 'mnt-date-spent', label: 'Date Spent', type: 'date', required: true },
    { id: 'mnt-purpose', label: 'Purpose / Description', type: 'text', placeholder: 'e.g. Internet bill payment', required: true },
    { id: 'mnt-person', label: 'Person / Vendor', type: 'text', placeholder: 'e.g. Safaricom' },
    { id: 'mnt-location', label: 'Location / Property', type: 'text', placeholder: 'If applicable' },
    { id: 'mnt-receipt', label: 'Supporting Document', type: 'text', placeholder: 'Receipt or reference' },
  ],
  staff_reimbursement: [
    { id: 'mnt-date-spent', label: 'Date of Expense', type: 'date', required: true },
    { id: 'mnt-purpose', label: 'Purpose / Description', type: 'text', placeholder: 'What expense is being reimbursed?', required: true },
    { id: 'mnt-person', label: 'Employee / Staff Name', type: 'text', placeholder: 'e.g. Peter Kamau', required: true },
    { id: 'mnt-receipt', label: 'Supporting Receipt / Document', type: 'text', placeholder: 'Receipt reference' },
  ],
  property_maintenance: [
    { id: 'mnt-date-spent', label: 'Date of Maintenance', type: 'date', required: true },
    { id: 'mnt-location', label: 'Location / Property', type: 'text', placeholder: 'e.g. Blue House', required: true },
    { id: 'mnt-purpose', label: 'Work Description', type: 'text', placeholder: 'e.g. Fix leaking pipe', required: true },
    { id: 'mnt-person', label: 'Technician / Vendor', type: 'text', placeholder: 'e.g. ABC Plumbing' },
    { id: 'mnt-receipt', label: 'Supporting Receipt / Document', type: 'text', placeholder: 'Receipt reference' },
  ],
  salary: [
    { id: 'mnt-date-spent', label: 'Payment Date', type: 'date', required: true },
    { id: 'mnt-person', label: 'Employee Name', type: 'text', placeholder: 'e.g. Peter Kamau', required: true },
    { id: 'mnt-purpose', label: 'Description', type: 'text', placeholder: 'e.g. August 2026 salary' },
  ],
  other: [
    { id: 'mnt-date-spent', label: 'Date', type: 'date', required: true },
    { id: 'mnt-purpose', label: 'Description', type: 'text', placeholder: 'What is this expense for?', required: true },
    { id: 'mnt-location', label: 'Location / Property', type: 'text', placeholder: 'If applicable' },
    { id: 'mnt-receipt', label: 'Supporting Document', type: 'text', placeholder: 'Receipt or reference' },
  ],
};

const MNT_STATUS_OPTIONS = {
  petty_cash: ['Pending', 'Approved', 'Paid'],
  office_purchase: ['Pending', 'Approved', 'Paid'],
  administration: ['Pending', 'Approved', 'Paid'],
  staff_reimbursement: ['Pending Reimbursement', 'Partially Reimbursed', 'Fully Reimbursed'],
  property_maintenance: ['Pending', 'Approved', 'Paid'],
  salary: ['Pending', 'Approved', 'Paid'],
  other: ['Pending', 'Approved', 'Paid'],
};

const MNT_CATEGORY_LABELS = {
  petty_cash: 'Petty Cash',
  office_purchase: 'Office Purchase',
  administration: 'Administration',
  staff_reimbursement: 'Staff Reimbursement',
  property_maintenance: 'Property Maintenance',
  salary: 'Salary',
  other: 'Other',
};

function renderMntDynamicFields(category) {
  const container = document.getElementById('mnt-dynamic-fields');
  if (!container) return;
  const fields = MNT_CATEGORY_FIELDS[category] || MNT_CATEGORY_FIELDS.other;
  container.innerHTML = '<div class="grid grid-cols-1 md:grid-cols-3 gap-4">' +
    fields.map(f => {
      const req = f.required ? ' required' : '';
      const ph = f.placeholder ? ` placeholder="${f.placeholder}"` : '';
      const min = f.type === 'number' ? ' min="0" step="1"' : '';
      return `<div>
        <label class="form-label">${f.label}</label>
        <input type="${f.type}" id="${f.id}" class="cyber-input"${ph}${min}${req} />
      </div>`;
    }).join('') +
    '</div>' +
    '<div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">' +
    '<div><label class="form-label">Notes</label><input type="text" id="mnt-notes" class="cyber-input" placeholder="Additional notes" /></div>' +
    '</div>';

  const statusSel = document.getElementById('mnt-status');
  if (statusSel) {
    const opts = MNT_STATUS_OPTIONS[category] || MNT_STATUS_OPTIONS.other;
    statusSel.innerHTML = opts.map(s => `<option value="${s}"${s === 'Pending' ? ' selected' : ''}>${s}</option>`).join('');
  }

  // Toggle plot expenses section for staff_reimbursement
  const plotSection = document.getElementById('mnt-plot-expenses-section');
  const amountRow = document.getElementById('mnt-amount-row');
  if (plotSection) {
    if (category === 'staff_reimbursement') {
      plotSection.classList.remove('hidden');
      if (amountRow) amountRow.classList.add('hidden');
      if (!document.getElementById('mnt-plot-expenses-list')?.children.length) addPlotExpenseRow();
    } else {
      plotSection.classList.add('hidden');
      if (amountRow) amountRow.classList.remove('hidden');
    }
  }
}

// Multi-plot expense row management
let mntPlotExpenseHousesCache = [];

function addPlotExpenseRow(plotName = '', amount = '', description = '') {
  const list = document.getElementById('mnt-plot-expenses-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'grid grid-cols-1 md:grid-cols-12 gap-2 items-end plot-expense-row';
  const options = (mntPlotExpenseHousesCache || []).map(h =>
    `<option value="${h.paybill_number}" ${h.paybill_number === plotName || h.house_name === plotName ? 'selected' : ''}>${escapeHtml(h.house_name)} (${h.paybill_number})</option>`
  ).join('');
  row.innerHTML = `
    <div class="md:col-span-4">
      <label class="form-label text-xs">Plot / Property</label>
      <select class="cyber-input plot-name" required>
        <option value="">Select Plot</option>${options}</select>
    </div>
    <div class="md:col-span-2">
      <label class="form-label text-xs">Amount (KES)</label>
      <input type="number" class="cyber-input plot-amount" min="0" step="0.01" placeholder="0" value="${amount}" required />
    </div>
    <div class="md:col-span-5">
      <label class="form-label text-xs">Description</label>
      <input type="text" class="cyber-input plot-desc" placeholder="e.g. Plumbing repairs" value="${escapeHtml(description)}" />
    </div>
    <div class="md:col-span-1 flex justify-center">
      <button type="button" class="text-rose-400 hover:text-rose-300 text-sm remove-plot-row" title="Remove">✕</button>
    </div>
  `;
  row.querySelector('.remove-plot-row')?.addEventListener('click', () => { row.remove(); updatePlotTotal(); });
  row.querySelectorAll('.plot-amount').forEach(el => el.addEventListener('input', updatePlotTotal));
  list.appendChild(row);
  updatePlotTotal();
}

function updatePlotTotal() {
  let total = 0;
  document.querySelectorAll('#mnt-plot-expenses-list .plot-amount').forEach(el => {
    total += Number(el.value || 0);
  });
  const el = document.getElementById('mnt-plot-total');
  if (el) el.textContent = `KES ${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

function collectPlotExpenseItems() {
  const category = document.getElementById('mnt-category')?.value || 'other';
  if (category !== 'staff_reimbursement') return null;
  const rows = document.querySelectorAll('#mnt-plot-expenses-list .plot-expense-row');
  if (!rows.length) return null;
  const dynamicData = {};
  const fields = MNT_CATEGORY_FIELDS[category] || MNT_CATEGORY_FIELDS.other;
  fields.forEach(f => {
    const el = document.getElementById(f.id);
    if (el) dynamicData[f.id] = el.value.trim();
  });
  const items = [];
  rows.forEach(row => {
    const plotSelect = row.querySelector('.plot-name');
    const plotValue = plotSelect?.value || '';
    const plotLabel = plotSelect?.options[plotSelect.selectedIndex]?.text || plotValue;
    const amt = Number(row.querySelector('.plot-amount')?.value || 0);
    const desc = row.querySelector('.plot-desc')?.value?.trim() || '';
    items.push({
      unit_code: plotLabel || plotValue,
      problem: desc || dynamicData['mnt-purpose'] || 'Staff reimbursement',
      work_required: category,
      work_done: dynamicData['mnt-person'] || '',
      materials: JSON.stringify({ ...dynamicData, plot_paybill: plotValue, plot_name: plotLabel, plot_description: desc }),
      priority: 'Medium',
      status: document.getElementById('mnt-status')?.value || 'Pending',
      labour_cost: amt,
      material_cost: 0,
    });
  });
  return items;
}

function loadPlotExpenseItems(items) {
  const list = document.getElementById('mnt-plot-expenses-list');
  if (!list) return;
  list.innerHTML = '';
  if (!items || !items.length) { addPlotExpenseRow(); return; }
  items.forEach(it => {
    const mat = it.materials ? (typeof it.materials === 'string' ? JSON.parse(it.materials || '{}') : it.materials) : {};
    addPlotExpenseRow(mat.plot_paybill || it.unit_code || '', it.labour_cost || '', mat.plot_description || it.problem || '');
  });
}

function collectMntItems() {
  const category = document.getElementById('mnt-category')?.value || 'other';
  // For staff_reimbursement, use plot expense rows
  if (category === 'staff_reimbursement') {
    const plotItems = collectPlotExpenseItems();
    if (plotItems && plotItems.length) return plotItems;
  }
  const dynamicData = {};
  const fields = MNT_CATEGORY_FIELDS[category] || MNT_CATEGORY_FIELDS.other;
  fields.forEach(f => {
    const el = document.getElementById(f.id);
    if (el) dynamicData[f.id] = el.value.trim();
  });
  const amount = Number(document.getElementById('mnt-amount')?.value || 0);
  const notes = document.getElementById('mnt-notes')?.value?.trim() || '';
  const purpose = dynamicData['mnt-purpose'] || '';
  const person = dynamicData['mnt-person'] || '';
  const location = dynamicData['mnt-location'] || '';
  const receipt = dynamicData['mnt-receipt'] || '';
  const dateSpent = dynamicData['mnt-date-spent'] || '';
  const itemPurchased = dynamicData['mnt-item-purchased'] || '';
  const quantity = dynamicData['mnt-quantity'] || '';

  const description = purpose || itemPurchased || 'Management expense';

  const item = {
    unit_code: location || '',
    problem: description,
    work_required: category,
    work_done: person || '',
    materials: JSON.stringify(dynamicData),
    priority: 'Medium',
    status: document.getElementById('mnt-status')?.value || 'Pending',
    labour_cost: amount,
    material_cost: 0,
  };
  return [item];
}

function collectMntAmount() {
  const category = document.getElementById('mnt-category')?.value || 'other';
  if (category === 'staff_reimbursement') {
    let total = 0;
    document.querySelectorAll('#mnt-plot-expenses-list .plot-amount').forEach(el => {
      total += Number(el.value || 0);
    });
    return total;
  }
  return Number(document.getElementById('mnt-amount')?.value || 0);
}

function resetMntForm() {
  const form = document.getElementById('maintenance-invoice-form');
  if (form) form.reset();
  document.getElementById('mnt-form-id').value = '';
  document.getElementById('mnt-source-wo-id').value = '';
  document.getElementById('mnt-source-wo-number').value = '';
  document.getElementById('mnt-source-issue-nos').value = '';
  document.getElementById('mnt-category').value = 'petty_cash';
  document.getElementById('mnt-status').value = 'Pending';
  renderMntDynamicFields('petty_cash');
  document.getElementById('mnt-form-result').textContent = '';
  // Clear plot expense rows
  const plotList = document.getElementById('mnt-plot-expenses-list');
  if (plotList) plotList.innerHTML = '';
  const plotSection = document.getElementById('mnt-plot-expenses-section');
  if (plotSection) plotSection.classList.add('hidden');
  const amountRow = document.getElementById('mnt-amount-row');
  if (amountRow) amountRow.classList.remove('hidden');
}

async function saveMaintenanceInvoice(e) {
  e.preventDefault();
  const resEl = document.getElementById('mnt-form-result');
  const id = document.getElementById('mnt-form-id').value;
  const woId = document.getElementById('mnt-source-wo-id').value;
  const woNumber = document.getElementById('mnt-source-wo-number').value;
  const issueNos = document.getElementById('mnt-source-issue-nos').value;
  const category = document.getElementById('mnt-category')?.value || 'other';
  const items = collectMntItems();
  const amount = collectMntAmount();
  if (amount <= 0) {
    resEl.textContent = 'Enter an amount greater than 0.';
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    return;
  }

  const notes = document.getElementById('mnt-notes')?.value?.trim() || '';
  const dateSpent = document.getElementById('mnt-date-spent')?.value || '';
  const property = document.getElementById('mnt-location')?.value?.trim() ||
    document.getElementById('mnt-property')?.value?.trim() || '';
  const fullNotes = (woNumber ? `WO Source: ${woNumber} ` : '') + notes;

  const payload = {
    property_name: property,
    house_paybill_number: null,
    unit_codes: null,
    caretaker_name: null,
    date_reported: dateSpent || new Date().toISOString().slice(0, 10),
    status: document.getElementById('mnt-status')?.value || 'Pending',
    technician_name: null,
    technician_phone: null,
    items,
    notes: fullNotes || null,
  };

  resEl.textContent = 'Saving...';
  resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  // Offline creates (contractor invoices, repair costs, materials) queue to
  // the outbox. Updates to synced records stay online-only (§13).
  if (!id && effectiveOffline()) {
    try {
      const clientTxnId = offlineDb.newClientTxnId();
      await queueOutboxOp({ type: 'maintenance_create', payload: { ...payload, client_txn_id: clientTxnId } });
      await offlineDb.put('maintenance', {
        key: `pending:${clientTxnId}`,
        client_txn_id: clientTxnId,
        server_id: null,
        mnt_number: '(pending)',
        property_name: payload.property_name || '',
        grand_total: Number(amount || 0),
        status: payload.status || 'Pending',
        sync: 'pending',
        created_at: new Date().toISOString(),
      });
      resEl.textContent = '🟠 Expense saved offline — PENDING SYNC. Will upload when internet returns.';
      resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
      showToast('Expense saved offline (PENDING SYNC)');
      document.getElementById('maintenance-invoice-form-wrap').classList.add('hidden');
      resetMntForm();
      try { await loadMaintenanceInvoices(); } catch (_) {}
    } catch (err) {
      resEl.textContent = 'Offline save failed: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
    return;
  }
  if (id && effectiveOffline()) {
    resEl.textContent = 'Editing a synced expense requires internet (conflict protection).';
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    return;
  }
  try {
    let invoice;
    if (id) {
      const result = await api.updateMaintenanceInvoice(id, payload);
      invoice = result.invoice;
      resEl.textContent = 'Expense updated.';
    } else {
      const result = await api.createMaintenanceInvoice(payload);
      invoice = result.invoice;
      resEl.textContent = 'Expense saved.';
    }

    if (woId && invoice) {
      try {
        const issueNosArr = issueNos ? issueNos.split(',').map(Number).filter(n => n > 0) : [];
        await api.linkWoExpenses(invoice.id, woId, issueNosArr.length ? issueNosArr : null);
      } catch (_) { /* WO linking is best-effort */ }
    }

    resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    document.getElementById('maintenance-invoice-form-wrap').classList.add('hidden');
    resetMntForm();
    loadMaintenanceInvoices();
  } catch (err) {
    resEl.textContent = 'Error: ' + err.message;
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function editMaintenanceInvoice(id) {
  try {
    const { invoice } = await api.getMaintenanceInvoice(id);
    if (!invoice) return;
    const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val || ''; };
    set('mnt-form-id', invoice.id);
    set('mnt-property', invoice.property_name);
    set('mnt-date-reported', invoice.date_reported);
    set('mnt-status', invoice.status);

    const item = Array.isArray(invoice.items) && invoice.items.length ? invoice.items[0] : {};
    const category = item.work_required || 'other';
    set('mnt-category', category);
    renderMntDynamicFields(category);

    const dynamicData = item.materials ? (typeof item.materials === 'string' ? JSON.parse(item.materials || '{}') : item.materials) : {};
    Object.keys(dynamicData).forEach(key => {
      const el = document.getElementById(key);
      if (el) el.value = dynamicData[key];
    });

    // For staff_reimbursement with multi-plot items, load all items into plot rows
    if (category === 'staff_reimbursement' && Array.isArray(invoice.items) && invoice.items.length > 1) {
      loadPlotExpenseItems(invoice.items);
      const total = invoice.items.reduce((s, it) => s + (Number(it.labour_cost) || 0), 0);
      set('mnt-amount', total);
    } else {
      set('mnt-amount', item.labour_cost || invoice.grand_total);
    }

    const notes = (invoice.notes || '').replace(/^WO Source: \S+\s*/, '').trim();
    set('mnt-notes', notes);

    if (invoice.notes && invoice.notes.startsWith('WO Source: ')) {
      const woRef = invoice.notes.replace('WO Source: ', '').split(' ')[0];
      set('mnt-source-wo-number', woRef);
    }

    document.getElementById('maintenance-invoice-form-wrap').classList.remove('hidden');
  } catch (err) {
    const resEl = document.getElementById('mnt-form-result');
    resEl.textContent = 'Failed to load expense: ' + err.message;
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function deleteMaintenanceInvoice(id) {
  if (!confirm('Delete this management expense?')) return;
  try {
    await api.deleteMaintenanceInvoice(id);
    loadMaintenanceInvoices();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
}

async function loadMaintenanceInvoices() {
  const tbody = document.getElementById('mnt-list-tbody');
  if (!tbody) return;
  const cachedPending = await offlineDb
    .getAll('maintenance')
    .then((all) => (all || []).filter((r) => r && (r.sync === 'pending' || r.sync === 'failed')))
    .catch(() => []);
  const pendingRows = cachedPending.map((r) =>
    '<tr style="opacity:.92">' +
    '<td class="font-mono">' + escapeHtml(r.mnt_number || '(pending)') + '</td>' +
    '<td>' + escapeHtml((r.created_at || '').slice(0, 10)) + '</td>' +
    '<td colspan="2">' + escapeHtml(r.property_name || '—') + '</td>' +
    '<td><span class="text-slate-400">Offline</span></td>' +
    '<td>' + escapeHtml(r.property_name || '—') + '</td>' +
    '<td class="text-right font-mono">' + money(r.grand_total) + '</td>' +
    '<td class="text-right font-mono text-green-400">—</td>' +
    '<td class="text-right font-mono text-rose-400">' + money(r.grand_total) + '</td>' +
    '<td>' + offlineSyncBadge(r.sync) + '</td>' +
    '<td class="text-right whitespace-nowrap"><span class="text-xs text-slate-500">Offline record</span></td></tr>'
  ).join('');
  try {
    const { invoices } = await api.listMaintenanceInvoices();
    if (!invoices.length && !cachedPending.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="text-center text-slate-500 py-6">No management expenses recorded yet.</td></tr>';
      return;
    }
    tbody.innerHTML = pendingRows + invoices.map(inv => {
      const item = Array.isArray(inv.items) && inv.items.length ? inv.items[0] : {};
      const catKey = item.work_required || 'other';
      const category = MNT_CATEGORY_LABELS[catKey] || catKey;
      const description = item.problem || '—';
      const amount = Number(inv.grand_total || 0);
      const paid = Number(inv.paid_total || 0);
      const outstanding = Math.max(0, amount - paid);
      const notes = (inv.notes || '');
      const isWoSource = notes.startsWith('WO Source: ');
      const sourceLabel = isWoSource ? 'WO' : 'Manual';
      const sourceDetail = isWoSource ? notes.replace('WO Source: ', '').split(' ')[0] : '';
      return '<tr>' +
        '<td class="font-mono">' + escapeHtml(inv.mnt_number) + '</td>' +
        '<td>' + ((inv.date_reported || '').slice(0, 10) || '—') + '</td>' +
        '<td>' + escapeHtml(category) + '</td>' +
        '<td>' + escapeHtml(description) + '</td>' +
        '<td><span class="' + (isWoSource ? 'text-emerald-400' : 'text-slate-400') + '">' + sourceLabel + '</span>' + (sourceDetail ? ' <span class="text-slate-500 text-xs">' + escapeHtml(sourceDetail) + '</span>' : '') + '</td>' +
        '<td>' + escapeHtml(inv.property_name || inv.unit_codes || 'All Properties') + '</td>' +
        '<td class="text-right font-mono">' + money(amount) + '</td>' +
        '<td class="text-right font-mono text-green-400">' + (paid > 0 ? money(paid) : '—') + '</td>' +
        '<td class="text-right font-mono ' + (outstanding > 0 ? 'text-rose-400' : 'text-green-400') + '">' + (outstanding > 0 ? money(outstanding) : '—') + '</td>' +
        '<td>' + escapeHtml(inv.status || 'Pending') + '</td>' +
        '<td class="text-right whitespace-nowrap">' +
        '<button type="button" class="action-btn px-2 py-1 text-xs" onclick="editMaintenanceInvoice(' + inv.id + ')">Edit</button> ' +
        (catKey === 'staff_reimbursement'
          ? '<button type="button" class="action-btn px-2 py-1 text-xs text-purple-400 border-purple-400" onclick="downloadReimbursementInvoice(' + inv.id + ')">Invoice</button> '
          : '<button type="button" class="action-btn px-2 py-1 text-xs text-purple-400 border-purple-400" onclick="downloadExpenseInvoice(' + inv.id + ')">Invoice</button> ') +
        '<button type="button" class="action-btn px-2 py-1 text-xs text-rose-400 border-rose-400" onclick="deleteMaintenanceInvoice(' + inv.id + ')">Del</button>' +
        '</td></tr>';
    }).join('');
  } catch (err) {
    if (!isNetworkError(err)) {
      tbody.innerHTML = '<tr><td colspan="11" class="text-center text-rose-400 py-6">Failed to load: ' + escapeHtml(err.message) + '</td></tr>';
      return;
    }
    const cached = await offlineDb.getAll('maintenance').catch(() => []);
    if (!cached.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="text-center text-slate-500 py-6">Offline — no synced expenses on this device yet.</td></tr>';
      return;
    }
    tbody.innerHTML = '<tr><td colspan="11" class="text-center text-amber-500 text-xs font-mono py-2">📴 Offline — showing last synced data</td></tr>' + cached.map((r) =>
      '<tr style="opacity:.92">' +
      '<td class="font-mono">' + escapeHtml(r.mnt_number || '(pending)') + '</td>' +
      '<td>' + escapeHtml((r.created_at || r.synced_at || '').slice(0, 10)) + '</td>' +
      '<td colspan="2">' + escapeHtml(r.property_name || '—') + '</td>' +
      '<td><span class="text-slate-400">Offline</span></td>' +
      '<td>' + escapeHtml(r.property_name || '—') + '</td>' +
      '<td class="text-right font-mono">' + money(r.grand_total) + '</td>' +
      '<td class="text-right font-mono text-green-400">—</td>' +
      '<td class="text-right font-mono text-rose-400">' + money(r.grand_total) + '</td>' +
      '<td>' + offlineSyncBadge(r.sync) + '</td>' +
      '<td class="text-right whitespace-nowrap"><span class="text-xs text-slate-500">Offline record</span></td></tr>'
    ).join('');
  }
}

// ============================================================
// WORK ORDER EXPENSE MODAL
// ============================================================

async function showWoExpenseModal() {
  const modal = document.getElementById('wo-expense-modal');
  const loading = document.getElementById('wo-expense-loading');
  const list = document.getElementById('wo-expense-list');
  const houseFilter = document.getElementById('wo-expense-filter-house');

  modal.style.display = 'flex';
  loading.style.display = '';
  list.classList.add('hidden');
  list.innerHTML = '';

  try {
    const { houses } = await api.houses();
    if (houseFilter && houses.length) {
      houseFilter.innerHTML = '<option value="">All Properties</option>' +
        houses.map(h => `<option value="${escapeHtml(h.paybill_number)}">${escapeHtml(h.house_name)}</option>`).join('');
    }
  } catch (_) { /* ignore */ }

  try {
    const { expenses } = await api.listEligibleManagementExpenses();
    loading.style.display = 'none';
    if (!expenses.length) {
      list.innerHTML = '<p class="text-center text-slate-400 py-4">No eligible work order expenses found. All WO management expenses are already linked to an invoice.</p>';
      list.classList.remove('hidden');
      return;
    }
    renderWoExpenseList(expenses);
  } catch (err) {
    loading.style.display = 'none';
    list.innerHTML = '<p class="text-center text-rose-400 py-4">Failed to load: ' + escapeHtml(err.message) + '</p>';
    list.classList.remove('hidden');
  }
}

function renderWoExpenseList(expenses) {
  const list = document.getElementById('wo-expense-list');
  list.innerHTML = expenses.map(e =>
    `<div class="border border-slate-700 rounded p-3 mb-2 hover:border-cyan-500 cursor-pointer transition-colors" onclick="selectWoExpense(${e.wo_id}, '${escapeHtml(e.wo_number || '')}', '${escapeHtml((e.issue_nos || []).join(','))}', '${escapeHtml(e.property_name || '')}')">
      <div class="flex justify-between items-start">
        <div>
          <p class="text-sm font-medium text-white">WO: ${escapeHtml(e.wo_number || '—')}</p>
          <p class="text-xs text-slate-400">Property: ${escapeHtml(e.property_name || '—')}</p>
          <p class="text-xs text-slate-400">Description: ${escapeHtml(e.description || '—')}</p>
          <p class="text-xs text-slate-400">Technician: ${escapeHtml(e.technician_name || '—')}</p>
          ${e.materials ? `<p class="text-xs text-slate-400">Materials: ${escapeHtml(e.materials)}</p>` : ''}
          <p class="text-xs text-slate-400">Responsible: ${escapeHtml(e.responsible_party || '—')}</p>
        </div>
        <p class="text-sm font-mono text-cyan-400">${money(e.amount)}</p>
      </div>
    </div>`
  ).join('');
  list.classList.remove('hidden');
}

function selectWoExpense(woId, woNumber, issueNos, property) {
  document.getElementById('mnt-source-wo-id').value = woId;
  document.getElementById('mnt-source-wo-number').value = woNumber;
  document.getElementById('mnt-source-issue-nos').value = issueNos;
  document.getElementById('mnt-property').value = property;
  document.getElementById('mnt-category').value = 'property_maintenance';
  renderMntDynamicFields('property_maintenance');
  document.getElementById('mnt-status').value = 'Pending';
  document.getElementById('mnt-form-result').textContent = 'Work Order ' + woNumber + ' linked. Fill in amount and save.';
  document.getElementById('mnt-form-result').className = 'text-sm font-mono text-cyan-400 text-right mt-2';
  hideWoExpenseModal();
  document.getElementById('maintenance-invoice-form-wrap').classList.remove('hidden');
}

function hideWoExpenseModal() {
  document.getElementById('wo-expense-modal').style.display = 'none';
}

function filterWoExpenses() {
  const house = document.getElementById('wo-expense-filter-house')?.value || '';
  api.listEligibleManagementExpenses(house || null).then(({ expenses }) => {
    renderWoExpenseList(expenses);
  }).catch(() => {});
}

async function runMntGenerate(id, mode, phone_number) {
  const resEl = document.getElementById('mnt-list-result');
  try {
    if (mode === 'download') {
      const result = await api.downloadMaintenanceInvoice(id);
      triggerFileDownload(result, resEl, `Downloaded ${result.filename}`);
    } else {
      const phone = phone_number || prompt('Send via WhatsApp to phone number:');
      if (!phone) return;
      if (mode === 'both') {
        const result = await api.sendAndDownloadMaintenanceInvoice(id, phone);
        triggerFileDownload(result, resEl, `Sent via WhatsApp & downloaded ${result.filename}`);
      } else {
        const result = await api.generateMaintenanceInvoice(id, 'send', phone);
        if (resEl) {
          resEl.textContent = `Invoice sent successfully!`;
          resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
        }
        loadMaintenanceInvoices();
      }
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  }
}

window.editMaintenanceInvoice = editMaintenanceInvoice;
window.deleteMaintenanceInvoice = deleteMaintenanceInvoice;
window.runMntGenerate = runMntGenerate;
window.showWoExpenseModal = showWoExpenseModal;
window.hideWoExpenseModal = hideWoExpenseModal;
window.selectWoExpense = selectWoExpense;
window.downloadSalaryInvoice = downloadSalaryInvoice;
window.downloadReimbursementInvoice = downloadReimbursementInvoice;
window.downloadExpenseInvoice = downloadExpenseInvoice;

// ============================================================
// SALARY MANAGEMENT
// ============================================================

async function loadSalaryDashboard() {
  const month = document.getElementById('salary-month-select')?.value || new Date().toISOString().slice(0, 7);
  const tbody = document.getElementById('salary-list-tbody');
  if (!tbody) return;
  try {
    const { records } = await api.listSalaryRecords(month);
    let totalExpected = 0, totalPaid = 0, totalOutstanding = 0;
    records.forEach(r => {
      totalExpected += Number(r.expected_salary || 0);
      totalPaid += Number(r.total_paid || 0);
      totalOutstanding += Number(r.outstanding || 0);
    });
    document.getElementById('sal-total-expected').textContent = money(totalExpected);
    document.getElementById('sal-total-paid').textContent = money(totalPaid);
    document.getElementById('sal-total-outstanding').textContent = money(totalOutstanding);
    document.getElementById('sal-employee-count').textContent = records.length;

    if (!records.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center text-slate-500 py-6">No salary records for this month. Click "+ Add Salary" to create one.</td></tr>';
      return;
    }
    tbody.innerHTML = records.map(r => {
      const totalObligation = Number(r.expected_salary || 0) + Number(r.previous_balance || 0);
      const statusClass = r.status === 'Fully Paid' ? 'text-green-400' : r.status === 'Partially Paid' ? 'text-amber-400' : 'text-slate-400';
      return `<tr>
        <td class="font-medium text-white">${escapeHtml(r.employee_name)}</td>
        <td class="font-mono">${escapeHtml(r.salary_month)}</td>
        <td class="text-right font-mono">${r.previous_balance > 0 ? money(r.previous_balance) : '—'}</td>
        <td class="text-right font-mono">${money(r.expected_salary)}</td>
        <td class="text-right font-mono text-cyan-400">${money(totalObligation)}</td>
        <td class="text-right font-mono text-green-400">${money(r.total_paid)}</td>
        <td class="text-right font-mono ${r.outstanding > 0 ? 'text-rose-400' : 'text-green-400'}">${r.outstanding > 0 ? money(r.outstanding) : '—'}</td>
        <td class="${statusClass}">${escapeHtml(r.status)}</td>
        <td class="text-right whitespace-nowrap">
          <button type="button" class="action-btn px-2 py-1 text-xs" onclick="editSalaryRecord(${r.id})">Edit</button>
          <button type="button" class="action-btn px-2 py-1 text-xs text-green-400 border-green-400" onclick="openSalaryPaymentModal(${r.id}, '${escapeHtml(r.employee_name)}', ${totalObligation}, ${r.total_paid})">Pay</button>
          <button type="button" class="action-btn px-2 py-1 text-xs text-purple-400 border-purple-400" onclick="downloadSalaryInvoice(${r.id})">Invoice</button>
          <button type="button" class="action-btn px-2 py-1 text-xs" onclick="showSalaryHistory('${escapeHtml(r.employee_name)}')">History</button>
          <button type="button" class="action-btn px-2 py-1 text-xs text-rose-400 border-rose-400" onclick="deleteSalaryRecord(${r.id})">Del</button>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-rose-400 py-6">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function editSalaryRecord(id) {
  try {
    const { record } = await api.getSalaryRecord(id);
    if (!record) return;
    document.getElementById('sal-form-id').value = record.id;
    document.getElementById('sal-employee').value = record.employee_name || '';
    document.getElementById('sal-month').value = record.salary_month || '';
    document.getElementById('sal-previous-balance').value = record.previous_balance || 0;
    document.getElementById('sal-expected').value = record.expected_salary || '';
    document.getElementById('sal-notes').value = record.notes || '';
    updateSalaryPreview();
    document.getElementById('salary-form-wrap').classList.remove('hidden');
  } catch (err) {
    alert('Failed to load: ' + err.message);
  }
}

async function deleteSalaryRecord(id) {
  if (!confirm('Delete this salary record and all its payments?')) return;
  try {
    await api.deleteSalaryRecord(id);
    loadSalaryDashboard();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
}

async function openSalaryPaymentModal(recordId, employeeName, totalObligation, totalPaid) {
  const modal = document.getElementById('salary-payment-modal');
  const outstanding = totalObligation - totalPaid;
  document.getElementById('spm-record-id').value = recordId;
  document.getElementById('spm-total-obligation').value = totalObligation;
  document.getElementById('spm-amount').value = outstanding > 0 ? outstanding : '';
  document.getElementById('spm-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('spm-method').value = '';
  document.getElementById('spm-reference').value = '';
  document.getElementById('spm-notes').value = '';
  document.getElementById('spm-result').textContent = '';
  document.getElementById('sal-pay-title').textContent = 'Record Salary Payment';
  document.getElementById('sal-pay-subtitle').textContent = employeeName + ' — Outstanding: ' + money(outstanding);

  // Load payment history
  const histDiv = document.getElementById('spm-payment-history');
  histDiv.innerHTML = 'Loading...';
  try {
    const { payments } = await api.getSalaryPayments(recordId);
    if (!payments.length) {
      histDiv.innerHTML = '<p class="text-slate-500">No payments recorded yet.</p>';
    } else {
      histDiv.innerHTML = '<table class="w-full text-xs"><thead><tr><th class="text-left">Date</th><th class="text-right">Amount</th><th>Method</th><th>Ref</th><th></th></tr></thead><tbody>' +
        payments.map(p => `<tr>
          <td>${(p.payment_date || '').slice(0, 10)}</td>
          <td class="text-right font-mono">${money(p.amount)}</td>
          <td>${escapeHtml(p.payment_method || '—')}</td>
          <td>${escapeHtml(p.reference || '—')}</td>
          <td class="text-right"><button type="button" class="text-rose-400 text-xs hover:underline" onclick="deleteSalaryPaymentFromModal(${recordId}, ${p.id})">Del</button></td>
        </tr>`).join('') +
        '</tbody></table>';
    }
  } catch (_) { histDiv.innerHTML = '<p class="text-rose-400">Failed to load.</p>'; }

  modal.style.display = 'flex';
}

async function deleteSalaryPaymentFromModal(recordId, paymentId) {
  if (!confirm('Delete this payment?')) return;
  try {
    await api.deleteSalaryPayment(recordId, paymentId);
    // Reload dashboard and modal
    loadSalaryDashboard();
    const rec = await api.getSalaryRecord(recordId);
    if (rec.record) {
      const totalObligation = Number(rec.record.expected_salary || 0) + Number(rec.record.previous_balance || 0);
      openSalaryPaymentModal(recordId, rec.record.employee_name, totalObligation, rec.record.total_paid);
    }
  } catch (err) { alert('Failed: ' + err.message); }
}

async function showSalaryHistory(employee) {
  const modal = document.getElementById('salary-history-modal');
  const content = document.getElementById('sal-hist-content');
  document.getElementById('sal-hist-title').textContent = 'Salary History — ' + employee;
  content.innerHTML = 'Loading...';
  modal.style.display = 'flex';
  try {
    const { history } = await api.getSalaryHistory(employee);
    if (!history.length) {
      content.innerHTML = '<p class="text-slate-500">No salary records found.</p>';
      return;
    }
    content.innerHTML = '<table class="w-full text-xs"><thead><tr><th class="text-left">Month</th><th class="text-right">Expected</th><th class="text-right">Prev. Bal</th><th class="text-right">Paid</th><th class="text-right">Outstanding</th><th>Status</th></tr></thead><tbody>' +
      history.map(r => `<tr>
        <td class="font-mono">${escapeHtml(r.salary_month)}</td>
        <td class="text-right font-mono">${money(r.expected_salary)}</td>
        <td class="text-right font-mono">${r.previous_balance > 0 ? money(r.previous_balance) : '—'}</td>
        <td class="text-right font-mono text-green-400">${money(r.total_paid)}</td>
        <td class="text-right font-mono ${r.outstanding > 0 ? 'text-rose-400' : 'text-green-400'}">${r.outstanding > 0 ? money(r.outstanding) : '—'}</td>
        <td>${escapeHtml(r.status)}</td>
      </tr>`).join('') +
      '</tbody></table>';
  } catch (err) { content.innerHTML = '<p class="text-rose-400">Failed: ' + escapeHtml(err.message) + '</p>'; }
}

window.editSalaryRecord = editSalaryRecord;
window.deleteSalaryRecord = deleteSalaryRecord;
window.openSalaryPaymentModal = openSalaryPaymentModal;
window.showSalaryHistory = showSalaryHistory;
window.deleteSalaryPaymentFromModal = deleteSalaryPaymentFromModal;

function updateSalaryPreview() {
  const prevBal = Number(document.getElementById('sal-previous-balance')?.value || 0);
  const expected = Number(document.getElementById('sal-expected')?.value || 0);
  const el1 = document.getElementById('sal-prev-bal-display');
  const el2 = document.getElementById('sal-cur-display');
  const el3 = document.getElementById('sal-total-display');
  if (el1) el1.textContent = money(prevBal);
  if (el2) el2.textContent = money(expected);
  if (el3) el3.textContent = money(prevBal + expected);
}

async function saveSalary(e) {
  e.preventDefault();
  const resEl = document.getElementById('sal-form-result');
  const id = document.getElementById('sal-form-id').value;
  const payload = {
    employee_name: document.getElementById('sal-employee').value.trim(),
    salary_month: document.getElementById('sal-month').value,
    previous_balance: Number(document.getElementById('sal-previous-balance').value || 0),
    expected_salary: Number(document.getElementById('sal-expected').value || 0),
    notes: document.getElementById('sal-notes').value.trim() || null,
  };
  if (!payload.employee_name || !payload.salary_month || payload.expected_salary <= 0) {
    resEl.textContent = 'Fill in employee name, month, and expected salary.';
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    return;
  }
  resEl.textContent = 'Saving...';
  resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  try {
    if (id) {
      await api.updateSalaryRecord(id, payload);
      resEl.textContent = 'Salary record updated.';
    } else {
      await api.createSalaryRecord(payload);
      resEl.textContent = 'Salary record created.';
    }
    resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    document.getElementById('salary-form-wrap').classList.add('hidden');
    loadSalaryDashboard();
  } catch (err) {
    resEl.textContent = 'Error: ' + err.message;
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function saveSalaryPayment(e) {
  e.preventDefault();
  const resEl = document.getElementById('spm-result');
  const recordId = document.getElementById('spm-record-id').value;
  const payload = {
    amount: Number(document.getElementById('spm-amount').value || 0),
    payment_date: document.getElementById('spm-date').value || new Date().toISOString().slice(0, 10),
    payment_method: document.getElementById('spm-method').value || null,
    reference: document.getElementById('spm-reference').value.trim() || null,
    notes: document.getElementById('spm-notes').value.trim() || null,
  };
  if (payload.amount <= 0) {
    resEl.textContent = 'Enter a valid amount.';
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    return;
  }
  const totalObligation = Number(document.getElementById('spm-total-obligation').value || 0);
  resEl.textContent = 'Recording...';
  resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  try {
    await api.recordSalaryPayment(recordId, payload);
    resEl.textContent = 'Payment recorded.';
    resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    loadSalaryDashboard();
    // Reload modal
    const { record } = await api.getSalaryRecord(recordId);
    if (record) {
      openSalaryPaymentModal(recordId, record.employee_name, totalObligation, record.total_paid);
    }
  } catch (err) {
    resEl.textContent = 'Error: ' + err.message;
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function runSalaryRollover() {
  const month = document.getElementById('salary-month-select')?.value || new Date().toISOString().slice(0, 7);
  if (!confirm('Roll over outstanding salary balances to the next month?')) return;
  try {
    const result = await api.rollOverSalaries(month);
    alert('Salary rollover complete. ' + result.carried_forward + ' employee balance(s) carried forward from ' + result.previous_month + '.');
    loadSalaryDashboard();
  } catch (err) {
    alert('Rollover failed: ' + err.message);
  }
}

// ============================================================
// MANAGEMENT EXPENSES HISTORY (Phase 5)
// ============================================================

async function searchManagementExpensesHistory() {
  const tbody = document.getElementById('meh-list-tbody');
  if (!tbody) return;
  const params = {};
  const month = document.getElementById('meh-month')?.value;
  const dateFrom = document.getElementById('meh-date-from')?.value;
  const dateTo = document.getElementById('meh-date-to')?.value;
  const property = document.getElementById('meh-property')?.value;
  const category = document.getElementById('meh-category')?.value;
  const status = document.getElementById('meh-status')?.value;
  const source = document.getElementById('meh-source')?.value;
  const employee = document.getElementById('meh-employee')?.value;
  const invoice = document.getElementById('meh-invoice')?.value;
  if (month) params.month = month;
  if (dateFrom) params.date_from = dateFrom;
  if (dateTo) params.date_to = dateTo;
  if (property) params.property = property;
  if (category) params.category = category;
  if (status) params.status = status;
  if (source) params.source = source;
  if (employee) params.employee = employee;
  if (invoice) params.invoice_number = invoice;

  tbody.innerHTML = '<tr><td colspan="8" class="text-center text-slate-400 py-4">Loading...</td></tr>';
  try {
    const report = await api.getManagementExpensesReport(params);
    const expenses = report.expenses || [];

    // Update summary cards
    document.getElementById('meh-summary-cards').style.display = 'grid';
    document.getElementById('meh-total-incurred').textContent = money(report.summary.total_incurred);
    document.getElementById('meh-total-paid').textContent = money(report.summary.total_paid);
    document.getElementById('meh-total-outstanding').textContent = money(report.summary.total_outstanding);
    document.getElementById('meh-expense-count').textContent = expenses.length;

    if (!expenses.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-slate-500 py-6">No expenses found matching the filters.</td></tr>';
      return;
    }
    tbody.innerHTML = expenses.map(e => {
      const date = e.date_reported ? String(e.date_reported).slice(0, 10) : (e.date_month || '—');
      const invNum = e.invoice_number || '—';
      const desc = e.description || '—';
      const prop = e.property_name || e.employee || '—';
      const srcBadge = e.source === 'Work Order' ? '<span class="text-emerald-400">WO</span>' :
                       e.source === 'Salary' ? '<span class="text-purple-400">Salary</span>' :
                       '<span class="text-slate-400">Manual</span>';
      return '<tr>' +
        '<td>' + date + '</td>' +
        '<td class="font-mono text-xs">' + escapeHtml(invNum) + '</td>' +
        '<td>' + escapeHtml(e.category || '—') + '</td>' +
        '<td>' + escapeHtml(desc) + '</td>' +
        '<td>' + escapeHtml(prop) + '</td>' +
        '<td>' + srcBadge + '</td>' +
        '<td class="text-right font-mono">' + money(e.amount) + '</td>' +
        '<td>' + escapeHtml(e.status || '—') + '</td>' +
        '</tr>';
    }).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-rose-400 py-6">Failed to load: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function clearManagementExpensesHistory() {
  ['meh-month', 'meh-date-from', 'meh-date-to', 'meh-property', 'meh-employee', 'meh-invoice'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  ['meh-category', 'meh-status', 'meh-source'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('meh-summary-cards').style.display = 'none';
  document.getElementById('meh-list-tbody').innerHTML = '<tr><td colspan="8" class="text-center text-slate-500 py-6">Click "Search" to load expenses.</td></tr>';
}

async function searchPropertyExpenseReport() {
  const property = document.getElementById('per-property')?.value?.trim();
  const month = document.getElementById('per-month')?.value;
  const resultDiv = document.getElementById('per-result');
  const reportDiv = document.getElementById('per-report');
  if (!property) { resultDiv.textContent = 'Enter a property name.'; return; }
  resultDiv.textContent = 'Loading...';
  reportDiv.classList.add('hidden');
  try {
    const report = await api.getPropertyExpenseReport(property, month || null);
    resultDiv.textContent = '';
    if (!report.categories.length) {
      reportDiv.innerHTML = '<p class="text-slate-400">No management expenses found for this property.</p>';
      reportDiv.classList.remove('hidden');
      return;
    }
    let html = '<h4 class="text-sm font-semibold text-white mb-3">' + escapeHtml(report.property) + ' — Total: ' + money(report.total) + '</h4>';
    html += '<table class="w-full text-left cyber-table text-sm"><thead><tr><th>Category</th><th class="text-right">Total</th><th class="text-right">Count</th></tr></thead><tbody>';
    report.categories.forEach(c => {
      html += '<tr><td>' + escapeHtml(c.category) + '</td><td class="text-right font-mono">' + money(c.total) + '</td><td class="text-right">' + c.expenses.length + '</td></tr>';
    });
    html += '<tr class="font-bold border-t border-slate-700"><td>Total</td><td class="text-right font-mono text-cyan-400">' + money(report.total) + '</td><td class="text-right">' + report.expense_count + '</td></tr>';
    html += '</tbody></table>';
    reportDiv.innerHTML = html;
    reportDiv.classList.remove('hidden');
  } catch (err) {
    resultDiv.textContent = 'Failed: ' + err.message;
  }
}

// ============================================================
// MONTHLY MANAGEMENT EXPENSES REPORT (Phase 5)
// ============================================================

async function generateMgmtExpensesReport() {
  const month = document.getElementById('mer-month')?.value;
  const dateFrom = document.getElementById('mer-date-from')?.value;
  const dateTo = document.getElementById('mer-date-to')?.value;
  const property = document.getElementById('mer-property')?.value;
  const category = document.getElementById('mer-category')?.value;
  const status = document.getElementById('mer-status')?.value;

  const hasDateRange = dateFrom || dateTo;
  const hasMonth = !!month;
  if (!hasDateRange && !hasMonth) {
    alert('Select a month, a single date, or a date range (From/To).');
    return;
  }

  const params = {};
  if (hasDateRange) {
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo;
    else if (dateFrom && !dateTo) params.date_to = dateFrom;
  } else if (hasMonth) {
    params.month = month;
  }
  if (property) params.property = property;
  if (category) params.category = category;
  if (status) params.status = status;

  try {
    const report = await api.getManagementExpensesReport(params);
    document.getElementById('mer-empty').style.display = 'none';
    document.getElementById('mer-summary').classList.remove('hidden');

    document.getElementById('mer-total-incurred').textContent = money(report.summary.total_incurred);
    document.getElementById('mer-total-paid').textContent = money(report.summary.total_paid);
    document.getElementById('mer-total-outstanding').textContent = money(report.summary.total_outstanding);
    document.getElementById('mer-period').textContent = report.month;
    document.getElementById('mer-property-total').textContent = money(report.summary.property_expenses);
    document.getElementById('mer-general-total').textContent = money(report.summary.general_expenses);

    // By Category
    const catDiv = document.getElementById('mer-by-category');
    catDiv.innerHTML = Object.entries(report.by_category).map(([cat, amt]) =>
      '<div class="bg-slate-800/30 rounded p-3 text-center"><p class="text-xs text-slate-400">' + escapeHtml(cat) + '</p><p class="text-lg font-bold text-white font-mono">' + money(amt) + '</p></div>'
    ).join('');

    // By Source
    const srcDiv = document.getElementById('mer-by-source');
    srcDiv.innerHTML = Object.entries(report.by_source).map(([src, amt]) =>
      '<div class="bg-slate-800/30 rounded p-3 text-center"><p class="text-xs text-slate-400">' + escapeHtml(src) + '</p><p class="text-lg font-bold text-white font-mono">' + money(amt) + '</p></div>'
    ).join('');

    // Salary table
    const salSection = document.getElementById('mer-salary-section');
    const salTbody = document.getElementById('mer-salary-tbody');
    if (report.salary_records.length) {
      salSection.style.display = 'block';
      salTbody.innerHTML = report.salary_records.map(s => {
        const totalObligation = Number(s.amount || 0) + Number(s.previous_balance || 0);
        return '<tr><td>' + escapeHtml(s.employee || s.description) + '</td>' +
          '<td class="text-right font-mono">' + money(s.amount) + '</td>' +
          '<td class="text-right font-mono">' + (s.previous_balance > 0 ? money(s.previous_balance) : '—') + '</td>' +
          '<td class="text-right font-mono text-green-400">' + money(s.total_paid) + '</td>' +
          '<td class="text-right font-mono ' + (s.outstanding > 0 ? 'text-rose-400' : 'text-green-400') + '">' + (s.outstanding > 0 ? money(s.outstanding) : '—') + '</td>' +
          '<td>' + escapeHtml(s.status) + '</td></tr>';
      }).join('');
    } else {
      salSection.style.display = 'none';
    }

    // Full expense list
    const expTbody = document.getElementById('mer-expenses-tbody');
    expTbody.innerHTML = report.expenses.map(e => {
      const date = e.date_reported ? String(e.date_reported).slice(0, 10) : (e.date_month || '—');
      const srcBadge = e.source === 'Work Order' ? '<span class="text-emerald-400">WO</span>' :
                       e.source === 'Salary' ? '<span class="text-purple-400">Salary</span>' :
                       '<span class="text-slate-400">Manual</span>';
      return '<tr><td>' + date + '</td>' +
        '<td class="font-mono text-xs">' + escapeHtml(e.invoice_number || '—') + '</td>' +
        '<td>' + escapeHtml(e.category || '—') + '</td>' +
        '<td>' + escapeHtml(e.description || '—') + '</td>' +
        '<td>' + escapeHtml(e.property_name || e.employee || '—') + '</td>' +
        '<td>' + srcBadge + '</td>' +
        '<td class="text-right font-mono">' + money(e.amount) + '</td>' +
        '<td class="text-right font-mono text-green-400">' + (e.paid ? money(e.paid) : '—') + '</td>' +
        '<td class="text-right font-mono ' + ((e.outstanding || 0) > 0 ? 'text-rose-400' : 'text-green-400') + '">' + ((e.outstanding || 0) > 0 ? money(e.outstanding) : '—') + '</td>' +
        '<td>' + escapeHtml(e.status || '—') + '</td></tr>';
    }).join('');

  } catch (err) {
    alert('Failed to generate report: ' + err.message);
  }
}

function printMgmtExpensesReport() {
  // Mark the report so @media print hides all app chrome and prints only
  // this section (landscape A4, repeating table heads, no clipped columns).
  const section = document.querySelector('[data-view="mgmt-expenses-report"]');
  const cleanup = () => {
    section?.classList.remove('print-active');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  section?.classList.add('print-active');
  window.print();
  cleanup();
}

function getReportParams() {
  const month = document.getElementById('mer-month')?.value;
  const dateFrom = document.getElementById('mer-date-from')?.value;
  const dateTo = document.getElementById('mer-date-to')?.value;
  const property = document.getElementById('mer-property')?.value;
  const category = document.getElementById('mer-category')?.value;
  const status = document.getElementById('mer-status')?.value;
  const params = {};
  if (dateFrom || dateTo) {
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo;
    else if (dateFrom && !dateTo) params.date_to = dateFrom;
  } else if (month) {
    params.month = month;
  }
  if (property) params.property = property;
  if (category) params.category = category;
  if (status) params.status = status;
  return params;
}

async function downloadMgmtExpensesReport() {
  const params = getReportParams();
  if (!params.month && !params.date_from) { alert('Generate a report first, then download.'); return; }
  try {
    const result = await api.downloadManagementExpensesReport(params);
    triggerFileDownload(result, null, 'Management expenses report downloaded');
  } catch (err) {
    alert('Failed to download report: ' + err.message);
  }
}

async function shareMgmtExpensesReport() {
  const params = getReportParams();
  if (!params.month && !params.date_from) { alert('Generate a report first, then share.'); return; }
  try {
    const result = await api.downloadManagementExpensesReport(params);
    if (result && result.blob) {
      const blob = result.blob;
      const url = URL.createObjectURL(blob);
      if (navigator.share) {
        const file = new File([blob], result.filename || 'report.pdf', { type: 'application/pdf' });
        navigator.share({ files: [file], title: 'Management Expenses Report' }).catch(() => {});
      } else {
        window.open(url, '_blank');
      }
    }
  } catch (err) {
    alert('Failed to share report: ' + err.message);
  }
}

async function downloadSalaryInvoice(recordId) {
  try {
    const result = await api.downloadSalaryInvoice(recordId);
    triggerFileDownload(result, null, 'Salary invoice downloaded');
  } catch (err) {
    alert('Failed to download salary invoice: ' + err.message);
  }
}

async function downloadReimbursementInvoice(invoiceId) {
  try {
    const result = await api.downloadReimbursementInvoice(invoiceId);
    triggerFileDownload(result, null, 'Reimbursement invoice downloaded');
  } catch (err) {
    alert('Failed to download reimbursement invoice: ' + err.message);
  }
}

async function downloadExpenseInvoice(invoiceId) {
  try {
    const result = await api.downloadExpenseInvoice(invoiceId);
    triggerFileDownload(result, null, 'Expense invoice downloaded');
  } catch (err) {
    alert('Failed to download expense invoice: ' + err.message);
  }
}

async function populatePropertyDropdowns() {
  try {
    const { houses } = await api.houses();
    mntPlotExpenseHousesCache = houses;
    const propertyNames = [...new Set(houses.map(h => h.house_name).filter(Boolean))].sort();
    ['meh-property', 'mer-property', 'mnt-property'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = '<option value="">All Properties</option>' +
        propertyNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
      sel.value = current;
    });
  } catch (_) { /* ignore — dropdowns will stay as "All Properties" */ }
}

let woItemCount = 0;

const WO_PARTIES = ['Pending Assessment', 'Tenant', 'Management / Property Owner', 'Shared Cost'];
const WO_TRADES = ['', 'Plumbing', 'Electrical', 'Carpentry', 'Masonry', 'Painting', 'General Maintenance', 'Other'];
const WO_PAYMENT_STATUSES = ['Pending Assessment', 'Pending', 'Paid', 'Charged to Tenant'];

function renderWoMaterialsList(id) {
  const row = document.getElementById(`wo-item-${id}`);
  if (!row) return;
  const mats = JSON.parse(row.dataset.materials || '[]');
  const el = document.getElementById(`wo-mat-list-${id}`);
  if (!el) return;
  if (!mats.length) {
    el.innerHTML = '<p class="text-xs text-slate-500">No materials added.</p>';
    return;
  }
  let h = '<table class="w-full text-xs mt-1"><thead><tr class="text-slate-600"><th class="text-left py-1">Material</th><th class="w-16 text-right">Qty</th><th class="w-24 text-right">Unit Cost</th><th class="w-24 text-right">Total</th><th class="w-8"></th></tr></thead><tbody>';
  mats.forEach((m, mi) => {
    h += `<tr class="border-t border-slate-200">
      <td class="py-1 text-slate-900">${escapeHtml(m.name || '—')}</td>
      <td class="text-right text-slate-700">${m.quantity}</td>
      <td class="text-right text-slate-700">${Number(m.unit_cost).toLocaleString()}</td>
      <td class="text-right text-blue-700 font-mono">${Number(m.total).toLocaleString()}</td>
      <td class="text-center"><button type="button" class="text-rose-500 hover:text-rose-700" data-wo-rm-mat="${id}-${mi}">×</button></td>
    </tr>`;
  });
  const matTotal = mats.reduce((s, m) => s + Number(m.total || 0), 0);
  h += `<tr class="border-t border-slate-300 font-semibold"><td colspan="3" class="py-1 text-right text-slate-700">Material Total</td><td class="text-right text-blue-700 font-mono">${matTotal.toLocaleString()}</td><td></td></tr>`;
  h += '</tbody></table>';
  el.innerHTML = h;
  // Update the material_cost on the row
  row.dataset.materialCost = matTotal;
  recalcWoItemTotal(id);
}

function addWoMaterial(id) {
  const row = document.getElementById(`wo-item-${id}`);
  if (!row) return;
  const name = prompt('Material name (e.g. Kitchen tap):');
  if (!name) return;
  const qty = Number(prompt('Quantity:', '1')) || 1;
  const unitCost = Number(prompt('Unit cost (KES):', '0')) || 0;
  const supplier = prompt('Supplier (optional):') || '';
  const mats = JSON.parse(row.dataset.materials || '[]');
  mats.push({ id: mats.length + 1, name, quantity: qty, unit_cost: unitCost, total: qty * unitCost, supplier });
  row.dataset.materials = JSON.stringify(mats);
  renderWoMaterialsList(id);
}

function removeWoMaterial(id, mi) {
  const row = document.getElementById(`wo-item-${id}`);
  if (!row) return;
  const mats = JSON.parse(row.dataset.materials || '[]');
  mats.splice(mi, 1);
  row.dataset.materials = JSON.stringify(mats);
  renderWoMaterialsList(id);
}

function recalcWoItemTotal(id) {
  const row = document.getElementById(`wo-item-${id}`);
  if (!row) return;
  const matInputCost = Number(row.querySelector('input[name="wo-mat-cost[]"]')?.value || 0);
  const matStoredCost = Number(row.dataset.materialCost || 0);
  const matCost = matInputCost > 0 ? matInputCost : matStoredCost;
  const labourCost = Number(row.querySelector('input[name="wo-cost[]"]')?.value || 0);
  const total = matCost + labourCost;
  const totalEl = row.querySelector('.wo-total-display');
  if (totalEl) totalEl.value = total > 0 ? total : '';
  calculateWoTotals();
}

function addWoItem(unitVal, problemVal, partyVal, costVal, paymentStatusVal, materialsVal, workReqVal, tradeVal) {
  const tbody = document.getElementById('wo-items-tbody');
  if (!tbody) return;
  const id = ++woItemCount;
  const issueNo = tbody.querySelectorAll('tr[data-issue]').length + 1;
  const tr = document.createElement('tr');
  tr.id = `wo-item-${id}`;
  tr.dataset.issue = issueNo;
  tr.dataset.materials = JSON.stringify(Array.isArray(materialsVal) ? materialsVal : []);
  tr.dataset.materialCost = Array.isArray(materialsVal) ? materialsVal.reduce((s, m) => s + Number(m.total || 0), 0) : 0;

  const partyOptions = WO_PARTIES.map(p =>
    `<option${(partyVal || 'Pending Assessment') === p ? ' selected' : ''}>${p}</option>`
  ).join('');
  const tradeOptions = WO_TRADES.map(t =>
    `<option${(tradeVal || '') === t ? ' selected' : ''}>${t || '— Select —'}</option>`
  ).join('');

  const costValNum = Number(costVal || 0);

  const matSummary = Array.isArray(materialsVal) && materialsVal.length
    ? materialsVal.map(m => m.name).filter(Boolean).join(', ') : '';
  const matCostVal = Array.isArray(materialsVal) ? materialsVal.reduce((s, m) => s + Number(m.total || 0), 0) : 0;
  const labourVal = Number(costVal || 0);
  const totalVal = matCostVal + labourVal;

  tr.innerHTML = `
    <td class="font-mono text-slate-400 wo-issue-no">${issueNo}</td>
    <td><input type="text" class="cyber-input p-1 w-full" name="wo-unit[]" value="${escapeHtml(unitVal || '')}" /></td>
    <td><input type="text" class="cyber-input p-1 w-full" name="wo-problem[]" value="${escapeHtml(problemVal || '')}" /></td>
    <td><select class="cyber-input p-1 w-full" name="wo-trade[]">${tradeOptions}</select></td>
    <td>
      <select class="cyber-input p-1 w-full" name="wo-party[]" data-issue-id="${id}">${partyOptions}</select>
      <div class="wo-mgmt-note hidden mt-1">
        <input type="text" class="cyber-input p-1 w-full text-xs" name="wo-mgmt-note[]" placeholder="Reason (appears in PDF)" />
      </div>
    </td>
    <td><input type="number" class="cyber-input p-1 w-full text-right wo-mat-input" name="wo-mat-cost[]" value="${matCostVal || ''}" min="0" data-id="${id}" /></td>
    <td><input type="number" class="cyber-input p-1 w-full text-right wo-cost-input" name="wo-cost[]" value="${labourVal || ''}" min="0" data-id="${id}" /></td>
    <td><input type="number" class="cyber-input p-1 w-full text-right text-cyan-400 font-bold wo-total-display" value="${totalVal || ''}" readonly tabindex="-1" /></td>
    <td><select class="cyber-input p-1 w-full" name="wo-status[]">
      <option>New</option><option>Assigned</option><option>In Progress</option><option>Completed</option><option>Closed</option>
    </select></td>
    <td class="text-center">
      <button type="button" class="text-slate-400 hover:text-white px-1 text-xs" data-wo-toggle="${id}" title="Materials & notes">▼</button>
      <button type="button" class="text-rose-400 hover:text-rose-300 px-1 text-xs" data-wo-del-item="${id}">×</button>
    </td>
  `;
  tbody.appendChild(tr);

  // Show/hide management note based on responsibility selection
  const partySelect = tr.querySelector(`select[data-issue-id="${id}"]`);
  const mgmtNoteRow = tr.querySelector('.wo-mgmt-note');
  if (partySelect && mgmtNoteRow) {
    const toggleNote = () => {
      const isMgmt = (partySelect.value || '').toLowerCase().includes('management') || (partySelect.value || '').toLowerCase().includes('owner');
      mgmtNoteRow.classList.toggle('hidden', !isMgmt);
    };
    partySelect.addEventListener('change', toggleNote);
    toggleNote(); // initial state
  }

  // Detail panel row (hidden by default) — for materials and notes
  const detail = document.createElement('tr');
  detail.id = `wo-detail-${id}`;
  detail.className = 'hidden';
  detail.innerHTML = `
    <td colspan="10" class="!p-0 !border-t-0">
      <div class="p-4 bg-slate-800/30 border border-slate-700 border-t-0 rounded-b-lg">
        <div class="mb-3">
          <label class="form-label text-xs">Notes</label>
          <input type="text" class="cyber-input p-1 w-full" name="wo-notes[]" placeholder="Optional notes about this issue" />
        </div>
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="form-label text-xs">Materials Used</label>
            <button type="button" class="action-btn !py-0 !px-2 text-xs" data-wo-add-mat="${id}">+ Add Material</button>
          </div>
          <div id="wo-mat-list-${id}" class="bg-white rounded p-2 border border-slate-300">
            <p class="text-xs text-slate-500">No materials added.</p>
          </div>
        </div>
      </div>
    </td>
  `;
  tbody.appendChild(detail);

  // Wire up cost inputs for recalculation
  tr.querySelector('.wo-cost-input')?.addEventListener('input', function() { recalcWoItemTotal(id); });
  tr.querySelector('.wo-mat-input')?.addEventListener('input', function() { recalcWoItemTotal(id); });

  // Render materials if provided
  if (Array.isArray(materialsVal) && materialsVal.length) {
    renderWoMaterialsList(id);
  }
  calculateWoTotals();
}

function toggleWoDetail(id) {
  const detail = document.getElementById(`wo-detail-${id}`);
  if (detail) detail.classList.toggle('hidden');
}

function removeWoItem(id) {
  const tr = document.getElementById(`wo-item-${id}`);
  const detail = document.getElementById(`wo-detail-${id}`);
  if (tr) tr.remove();
  if (detail) detail.remove();
  renumberWoIssues();
  calculateWoTotals();
}

function renumberWoIssues() {
  const tbody = document.getElementById('wo-items-tbody');
  if (!tbody) return;
  const rows = tbody.querySelectorAll('tr[data-issue]');
  rows.forEach((row, idx) => {
    row.dataset.issue = idx + 1;
    const noEl = row.querySelector('.wo-issue-no');
    if (noEl) noEl.textContent = idx + 1;
  });
}

function calculateWoTotals() {
  let total = 0;
  let mgmtCost = 0;
  let tenantCost = 0;
  let issueCount = 0;
  document.querySelectorAll('#wo-items-tbody tr[data-issue]').forEach(row => {
    issueCount++;
    const labour = Number(row.querySelector('input[name="wo-cost[]"]')?.value) || 0;
    const matInput = Number(row.querySelector('input[name="wo-mat-cost[]"]')?.value) || 0;
    const matStored = Number(row.dataset.materialCost || 0);
    const matCost = matInput > 0 ? matInput : matStored;
    const totalCost = labour + matCost;
    total += totalCost;
    const party = row.querySelector('select[name="wo-party[]"]')?.value || '';
    if (party.toLowerCase().includes('tenant')) tenantCost += totalCost;
    else if (party.toLowerCase().includes('management') || party.toLowerCase().includes('owner')) mgmtCost += totalCost;
  });
  const el = document.getElementById('wo-total-cost');
  if (el) el.textContent = money(total);

  // Update summary section
  const summary = document.getElementById('wo-totals-summary');
  if (summary) {
    summary.classList.toggle('hidden', issueCount === 0);
    const setTxt = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    setTxt('wo-summary-total-issues', issueCount);
    setTxt('wo-summary-mgmt-cost', money(mgmtCost));
    setTxt('wo-summary-tenant-cost', money(tenantCost));
    setTxt('wo-summary-total-cost', money(total));
  }
}

function parseWoBulkInput() {
  const textarea = document.getElementById('wo-bulk-input');
  if (!textarea) return;
  const raw = textarea.value
    .replace(/\r\n/g, '\n')
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/\u2022/g, '-');
  const lines = raw.split('\n').map(l => l.trim());
  if (!lines.length) return;

  document.getElementById('wo-items-tbody').innerHTML = '';
  woItemCount = 0;

  let currentUnit = '';
  let issueCount = 0;

  for (const line of lines) {
    if (!line) continue; // skip blank lines

    // Format: "1. B602" — numbered unit header
    const unitHeader = line.match(/^\d+[\.\)]\s+([A-Za-z][A-Za-z0-9\-]{1,15})\s*$/);
    if (unitHeader) {
      currentUnit = unitHeader[1].trim();
      continue;
    }

    // Format: "- Kitchen sink blocked." — bullet issue for current unit
    const bullet = line.match(/^[\-•]\s+(.+)$/);
    if (bullet && currentUnit) {
      const problem = bullet[1].trim().replace(/\.$/, ''); // remove trailing period
      addWoItem(currentUnit, problem);
      issueCount++;
      continue;
    }

    // Format: "A401: Guest toilet shaking" — unit colon issue
    const unitColon = line.match(/^([A-Za-z][A-Za-z0-9\-]{1,15})\s*[:\-]\s+(.+)$/);
    if (unitColon) {
      currentUnit = unitColon[1].trim();
      const issues = unitColon[2].split(/\s*,\s*/).map(s => s.trim().replace(/\.$/, '')).filter(Boolean);
      issues.forEach(issue => { addWoItem(currentUnit, issue); issueCount++; });
      continue;
    }

    // Format: "A401:" — unit-only with colon (sets current unit)
    const unitOnlyColon = line.match(/^([A-Za-z][A-Za-z0-9\-]{1,15})\s*:?\s*$/);
    if (unitOnlyColon && /\d/.test(unitOnlyColon[1])) {
      currentUnit = unitOnlyColon[1].trim();
      continue;
    }

    // Format: "1. Guest toilet shaking" — numbered issue (uses current unit)
    const numberedIssue = line.match(/^\d+[\.\)]\s+(.+)$/);
    if (numberedIssue && currentUnit) {
      addWoItem(currentUnit, numberedIssue[1].trim().replace(/\.$/, ''));
      issueCount++;
      continue;
    }

    // Format: "Kitchen sink blocked" — plain text issue (uses current unit)
    if (currentUnit && line.length > 3 && !line.match(/^[A-Za-z][A-Za-z0-9\-]{1,15}:?\s*$/)) {
      addWoItem(currentUnit, line.replace(/\.$/, ''));
      issueCount++;
    }
  }

  calculateWoTotals();
  const units = [...new Set([...document.querySelectorAll('input[name="wo-unit[]"]')].map(i => i.value).filter(Boolean))];
  const unitsField = document.getElementById('wo-units');
  if (unitsField && units.length) unitsField.value = units.join(', ');
}

async function resetWoForm() {
  const form = document.getElementById('work-order-form');
  if (form) form.reset();
  document.getElementById('wo-form-id').value = '';
  document.getElementById('wo-items-tbody').innerHTML = '';
  document.getElementById('wo-bulk-input').value = '';
  woItemCount = 0;
  addWoItem();
  calculateWoTotals();

  // Populate house dropdown
  const propSelect = document.getElementById('wo-property');
  if (propSelect && propSelect.tagName === 'SELECT') {
    try {
      const { houses } = await api.houses();
      propSelect.innerHTML = '<option value="">— Select Property —</option>';
      (houses || []).forEach(h => {
        const opt = document.createElement('option');
        opt.value = h.paybill_number || h.id || '';
        opt.dataset.mpesaPaybill = h.payment_paybill || '';
        opt.dataset.notes = h.notes || '';
        opt.textContent = h.house_name;
        propSelect.appendChild(opt);
      });
    } catch (_) {}
  }
}

// Auto-fill paybill and caretaker when house is selected
document.getElementById('wo-property')?.addEventListener('change', (e) => {
  const sel = e.target;
  const opt = sel.options[sel.selectedIndex];
  const houseId = opt?.value || '';
  const mpesaPaybill = opt?.dataset?.mpesaPaybill || '';
  const notes = opt?.dataset?.notes || '';

  // Hidden field stores house ID (FK value for save)
  document.getElementById('wo-house-id').value = houseId;
  // Visible field shows M-PESA paybill (for user reference)
  document.getElementById('wo-paybill').value = mpesaPaybill || houseId;

  // Parse caretaker from notes field
  if (notes) {
    const caretakerEl = document.getElementById('wo-caretaker');
    if (caretakerEl && !caretakerEl.value) {
      let name = notes.trim();
      name = name.replace(/^CARETAKER:\s*/i, '');
      name = name.replace(/\s*:?\s*\d{9,12}\s*$/, '').trim();
      name = name.replace(/:\s*$/, '').trim();
      if (name) caretakerEl.value = name;
    }
  }
});

function collectWoItems() {
  const items = [];
  const rows = document.querySelectorAll('#wo-items-tbody tr[data-issue]');
  rows.forEach((row, idx) => {
    const problem = row.querySelector('input[name="wo-problem[]"]')?.value;
    const detail = document.getElementById(`wo-detail-${row.id.replace('wo-item-', '')}`);
    const cost = Number(row.querySelector('input[name="wo-cost[]"]')?.value) || 0;
    const matInput = Number(row.querySelector('input[name="wo-mat-cost[]"]')?.value) || 0;
    const mats = JSON.parse(row.dataset.materials || '[]');
    const matCost = matInput > 0 ? matInput : (Number(row.dataset.materialCost || 0) || mats.reduce((s, m) => s + Number(m.total || 0), 0));
    if (!problem && cost === 0 && matCost === 0 && !mats.length) return;
    items.push({
      issue_no: idx + 1,
      unit_code: row.querySelector('input[name="wo-unit[]"]')?.value || '',
      problem: problem || '',
      work_required: row.querySelector('select[name="wo-trade[]"]')?.value || '',
      work_done: '',
      materials: mats,
      material_names: mats.map(m => m.name).filter(Boolean).join(', '),
      responsible_party: row.querySelector('select[name="wo-party[]"]')?.value || 'Pending Assessment',
      mgmt_note: row.querySelector('input[name="wo-mgmt-note[]"]')?.value || '',
      trade: row.querySelector('select[name="wo-trade[]"]')?.value || '',
      payment_status: '',
      status: row.querySelector('select[name="wo-status[]"]')?.value || 'New',
      labour_cost: cost,
      material_cost: matCost,
      total_cost: cost + matCost,
    });
  });
  return items;
}

async function saveWorkOrder(e) {
  e.preventDefault();
  const resEl = document.getElementById('wo-form-result');
  const items = collectWoItems();
  if (!items.length) {
    resEl.textContent = 'Add at least one work item.';
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    return;
  }
  const id = document.getElementById('wo-form-id').value;
  const propSel = document.getElementById('wo-property');
  const propName = propSel?.options?.[propSel.selectedIndex]?.textContent?.trim() || '';
  const payload = {
    property_name: propName,
    house_paybill_number: document.getElementById('wo-house-id').value.trim() || null,
    unit_codes: document.getElementById('wo-units').value.trim() || null,
    caretaker_name: document.getElementById('wo-caretaker').value.trim() || null,
    date_requested: document.getElementById('wo-date-requested').value || null,
    date_work_started: document.getElementById('wo-date-started').value || null,
    date_completed: null,
    date_assigned: document.getElementById('wo-date-assigned').value || null,
    expected_completion: document.getElementById('wo-expected').value || null,
    technician_name: document.getElementById('wo-technician').value.trim() || null,
    technician_phone: document.getElementById('wo-technician-phone').value.trim() || null,
    priority: document.getElementById('wo-priority').value,
    status: document.getElementById('wo-status').value,
    labour_involved: document.getElementById('wo-labour-involved').value.trim() || null,
    notes: document.getElementById('wo-notes').value.trim() || null,
    items,
  };
  resEl.textContent = 'Saving...';
  resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  // Offline creates queue to the outbox (PENDING SYNC). Updates to existing
  // server records stay online-only to avoid blind overwrites (§13).
  if (!id && effectiveOffline()) {
    try {
      const clientTxnId = offlineDb.newClientTxnId();
      const payload = { ...payload, tenant_code: null };
      await queueOutboxOp({ type: 'wo_create', payload: { ...payload, client_txn_id: clientTxnId } });
      await offlineDb.put('work_orders', {
        key: `pending:${clientTxnId}`,
        client_txn_id: clientTxnId,
        server_id: null,
        wo_number: '(pending)',
        property_name: payload.property_name || '',
        status: payload.status || 'Pending',
        sync: 'pending',
        created_at: new Date().toISOString(),
      });
      resEl.textContent = '🟠 Saved offline — PENDING SYNC. Will upload when internet returns.';
      resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
      showToast('Work order saved offline (PENDING SYNC)');
      document.getElementById('work-order-form-wrap').classList.add('hidden');
      resetWoForm();
      try { await loadWorkOrders(); } catch (_) {}
    } catch (err) {
      resEl.textContent = 'Offline save failed: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
    return;
  }
  if (id && effectiveOffline()) {
    resEl.textContent = 'Editing a synced work order requires internet (conflict protection).';
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    return;
  }
  try {
    if (id) {
      await api.updateWorkOrder(id, payload);
      resEl.textContent = 'Work order updated.';
    } else {
      await api.createWorkOrder(payload);
      resEl.textContent = 'Work order created.';
    }
    resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    document.getElementById('work-order-form-wrap').classList.add('hidden');
    resetWoForm();
    loadWorkOrders();
  } catch (err) {
    resEl.textContent = 'Error: ' + err.message;
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function editWorkOrder(id) {
  try {
    const { order } = await api.getWorkOrder(id);
    if (!order) return;

    // Load house dropdown first
    const propSelect = document.getElementById('wo-property');
    if (propSelect && propSelect.tagName === 'SELECT') {
      try {
        const { houses } = await api.houses();
        propSelect.innerHTML = '<option value="">— Select Property —</option>';
        (houses || []).forEach(h => {
          const opt = document.createElement('option');
          opt.value = h.paybill_number || h.id || '';
          opt.dataset.mpesaPaybill = h.payment_paybill || '';
          opt.dataset.notes = h.notes || '';
          opt.textContent = h.house_name;
          propSelect.appendChild(opt);
        });
      } catch (_) {}
    }

    const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val || ''; };
    set('wo-form-id', order.id);
    set('wo-property', order.house_paybill_number); // selects the option by house ID
    set('wo-house-id', order.house_paybill_number); // FK value for save
    set('wo-units', order.unit_codes);
    set('wo-caretaker', order.caretaker_name);
    set('wo-date-requested', order.date_requested);
    set('wo-date-started', order.date_work_started);
    set('wo-date-assigned', order.date_assigned);
    set('wo-expected', order.expected_completion);
    set('wo-technician', order.technician_name);
    set('wo-technician-phone', order.technician_phone);
    set('wo-priority', order.priority);
    set('wo-status', order.status);
    set('wo-labour-involved', order.labour_involved);
    set('wo-notes', order.notes);

    // Trigger house change to set paybill
    if (propSelect) propSelect.dispatchEvent(new Event('change'));

    document.getElementById('wo-items-tbody').innerHTML = '';
    woItemCount = 0;
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) {
      addWoItem();
    } else {
      items.forEach(it => {
        addWoItem(it.unit_code, it.problem, it.responsible_party || 'Pending Assessment',
          it.labour_cost, it.payment_status || 'Pending Assessment',
          Array.isArray(it.materials) ? it.materials : [], it.work_required, it.trade || '');
      });
    }
    calculateWoTotals();
    document.getElementById('work-order-form-wrap').classList.remove('hidden');
  } catch (err) {
    const resEl = document.getElementById('wo-form-result');
    resEl.textContent = 'Failed to load work order: ' + err.message;
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function deleteWorkOrder(id) {
  if (!confirm('Delete this work order?')) return;
  try {
    await api.deleteWorkOrder(id);
    loadWorkOrders();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
}

async function runWoGenerate(mode, id, phone_number) {
  const resEl = document.getElementById('wo-list-result');
  try {
    if (mode === 'download') {
      const result = await api.downloadWorkOrder(id);
      triggerFileDownload(result, resEl, `Downloaded ${result.filename}`);
    } else {
      const phone = phone_number || prompt('Send via WhatsApp to phone number:');
      if (!phone) return;
      if (mode === 'both') {
        const result = await api.sendAndDownloadWorkOrder(id, phone);
        triggerFileDownload(result, resEl, `Sent via WhatsApp & downloaded ${result.filename}`);
      } else {
        const result = await api.generateWorkOrder(id, 'send', phone);
        if (resEl) {
          resEl.textContent = `Work order sent successfully!${result.work_order_no ? ` (${result.work_order_no})` : ''}`;
          resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
        }
      }
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  }
}

async function loadWorkOrders() {
  const tbody = document.getElementById('wo-list-tbody');
  if (!tbody) return;
  const cachedPending = await offlineDb
    .getAll('work_orders')
    .then((all) => (all || []).filter((r) => r && (r.sync === 'pending' || r.sync === 'failed')))
    .catch(() => []);
  const pendingRows = cachedPending.map((r) => `
      <tr style="opacity:.92">
        <td class="font-mono">${escapeHtml(r.wo_number || '(pending)')}</td>
        <td>${escapeHtml(r.property_name || '—')}</td>
        <td>—</td><td>—</td><td>—</td>
        <td>${offlineSyncBadge(r.sync)}</td>
        <td class="text-right font-mono">—</td>
        <td>${escapeHtml((r.created_at || '').slice(0, 10))}</td>
        <td class="text-right whitespace-nowrap"><span class="text-xs text-slate-500">Offline record</span></td>
      </tr>`).join('');
  try {
    const { orders } = await api.listWorkOrders();
    if (!orders.length && !cachedPending.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center text-slate-500 py-6">No work orders yet. Create one to get started.</td></tr>';
      return;
    }
    tbody.innerHTML = pendingRows + orders.map(wo => `
      <tr>
        <td class="font-mono">${escapeHtml(wo.wo_number)}</td>
        <td>${escapeHtml(wo.property_name || '—')}</td>
        <td>${escapeHtml(wo.unit_codes || '—')}</td>
        <td>${escapeHtml(wo.technician_name || '—')}</td>
        <td>${escapeHtml(wo.priority || 'Medium')}</td>
        <td>${escapeHtml(wo.status || 'Pending')}</td>
        <td class="text-right font-mono">${money(wo.total_cost)}</td>
        <td>${(wo.created_at || '').slice(0, 10)}</td>
        <td class="text-right whitespace-nowrap">
          <button type="button" class="action-btn px-2 py-1 text-xs" data-wo-edit="${wo.id}">Edit</button>
          <button type="button" class="action-btn px-2 py-1 text-xs" data-wo-pdf="${wo.id}">PDF</button>
          <button type="button" class="action-btn px-2 py-1 text-xs text-amber-400 border-amber-400" data-wo-send="${wo.id}">Send</button>
          <button type="button" class="action-btn px-2 py-1 text-xs text-rose-400 border-rose-400" data-wo-del="${wo.id}">Del</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    if (!isNetworkError(err)) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center text-rose-400 py-6">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
      return;
    }
    const cached = await offlineDb.getAll('work_orders').catch(() => []);
    if (!cached.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center text-slate-500 py-6">Offline — no synced work orders on this device yet.</td></tr>';
      return;
    }
    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-amber-500 text-xs font-mono py-2">📴 Offline — showing last synced data</td></tr>` + cached.map((r) => `
      <tr style="opacity:.92">
        <td class="font-mono">${escapeHtml(r.wo_number || '(pending)')}</td>
        <td>${escapeHtml(r.property_name || '—')}</td>
        <td>—</td><td>—</td><td>—</td>
        <td>${offlineSyncBadge(r.sync)}</td>
        <td class="text-right font-mono">—</td>
        <td>${escapeHtml((r.created_at || r.synced_at || '').slice(0, 10))}</td>
        <td class="text-right whitespace-nowrap"><span class="text-xs text-slate-500">Offline record</span></td>
      </tr>`).join('');
  }
}

// ─── Property inspections (offline-capable, Phase 2) ──────────────────────

const INSP_ITEMS = [
  ['plumbing', 'Plumbing'], ['electrical', 'Electrical'], ['carpentry', 'Carpentry'],
  ['painting', 'Painting'], ['water', 'Water'], ['doors_locks', 'Doors / Locks'],
  ['fixtures', 'Fixtures'], ['general', 'General Condition'],
];

function renderInspChecklist() {
  const wrap = document.getElementById('insp-checklist');
  if (!wrap) return;
  wrap.innerHTML = INSP_ITEMS.map(([key, label]) => `
    <label class="flex items-center justify-between bg-slate-800/50 rounded px-3 py-2 text-sm">
      <span class="text-slate-200">${escapeHtml(label)}</span>
      <select data-insp-item="${key}" class="cyber-input !w-auto !py-1 text-xs">
        <option value="ok">OK</option>
        <option value="attention">Needs attention</option>
        <option value="na">N/A</option>
      </select>
    </label>`).join('');
}

async function openInspectionModal() {
  const modal = document.getElementById('inspection-modal');
  if (!modal) return;
  document.getElementById('insp-client-txn').value = offlineDb.newClientTxnId();
  document.getElementById('insp-unit').value = '';
  document.getElementById('insp-notes').value = '';
  document.getElementById('insp-status').value = 'Draft';
  document.getElementById('insp-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('insp-photos').value = '';
  document.getElementById('insp-photo-list').textContent = '';
  document.getElementById('insp-result').textContent = '';
  renderInspChecklist();
  // Properties: live list online, synced snapshot offline.
  let houses = [];
  try {
    const data = await api.houses();
    houses = data.houses || [];
  } catch (err) {
    if (isNetworkError(err)) houses = await offlineDb.getAll('houses').catch(() => []);
    else throw err;
  }
  const propSel = document.getElementById('insp-property');
  propSel.innerHTML = '<option value="">— Select Property —</option>' + (houses || []).map((h) =>
    `<option value="${escapeHtml(h.paybill_number || '')}">${escapeHtml(h.house_name || h.paybill_number || '')}</option>`).join('');
  let tenants = [];
  try {
    const data = await api.tenants({});
    tenants = data.tenants || [];
  } catch (err) {
    if (isNetworkError(err)) tenants = await offlineDb.getAll('tenants').catch(() => []);
  }
  document.getElementById('insp-tenant').innerHTML = '<option value="">—</option>' + (tenants || []).map((t) =>
    `<option value="${escapeHtml(t.tenant_code || '')}">${escapeHtml(t.name || '')} (${escapeHtml(t.tenant_code || '')})</option>`).join('');
  document.getElementById('insp-offline-tag')?.classList.toggle('hidden', !effectiveOffline());
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeInspectionModal() {
  const modal = document.getElementById('inspection-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

async function refreshInspPhotoList() {
  const uuid = document.getElementById('insp-client-txn')?.value;
  const el = document.getElementById('insp-photo-list');
  if (!el || !uuid) return;
  const staged = await stagedMediaFor(uuid).catch(() => []);
  el.textContent = staged.length ? `${staged.length} photo(s) staged${effectiveOffline() ? ' — will upload on sync' : ''}` : '';
}

async function saveInspection() {
  const resEl = document.getElementById('insp-result');
  const uuid = document.getElementById('insp-client-txn').value || offlineDb.newClientTxnId();
  const propSel = document.getElementById('insp-property');
  const paybill = propSel?.value || '';
  const propName = propSel?.options?.[propSel.selectedIndex]?.textContent?.trim() || '';
  const checklist = {};
  document.querySelectorAll('[data-insp-item]').forEach((sel) => { checklist[sel.dataset.inspItem] = sel.value; });
  const staged = await stagedMediaFor(uuid).catch(() => []);
  const payload = {
    client_txn_id: uuid,
    tenant_code: document.getElementById('insp-tenant')?.value || null,
    property_name: propName,
    house_paybill_number: paybill || null,
    unit_label: document.getElementById('insp-unit')?.value.trim() || null,
    inspection_date: document.getElementById('insp-date')?.value || new Date().toISOString().slice(0, 10),
    checklist,
    photos_count: staged.length,
    notes: document.getElementById('insp-notes')?.value.trim() || null,
    status: document.getElementById('insp-status')?.value || 'Draft',
  };
  if (!propName) {
    resEl.textContent = 'Select a property first.';
    resEl.className = 'text-sm font-mono text-rose-400 text-right mb-2';
    return;
  }
  resEl.textContent = 'Saving...';
  resEl.className = 'text-sm font-mono text-amber-400 text-right mb-2';
  try {
    if (effectiveOffline()) {
      await queueOutboxOp({ type: 'inspection_create', payload });
      await offlineDb.put('inspections', {
        key: `pending:${uuid}`,
        client_txn_id: uuid,
        server_id: null,
        property_name: propName,
        unit_label: payload.unit_label || '',
        status: payload.status,
        sync: 'pending',
        created_at: new Date().toISOString(),
      });
      resEl.textContent = '🟠 Inspection saved offline — PENDING SYNC (photos will upload on sync).';
      resEl.className = 'text-sm font-mono text-amber-400 text-right mb-2';
      showToast('Inspection saved offline (PENDING SYNC)');
      setTimeout(() => { closeInspectionModal(); loadInspections(); }, 1200);
      return;
    }
    const { inspection } = await api.createInspection(payload);
    // Upload staged photos against the new server record.
    for (const m of staged) {
      try {
        await api.uploadOfflineMedia({
          client_txn_id: m.client_txn_id,
          linked_type: 'inspection',
          linked_client_txn_id: uuid,
          linked_id: inspection.id,
          filename: m.filename,
          mimetype: m.mimetype,
          data: m.data,
        });
        await markMediaSynced(m.key);
      } catch (_) { /* photo stays staged for the sync engine */ }
    }
    resEl.textContent = 'Inspection saved.';
    resEl.className = 'text-sm font-mono text-green-400 text-right mb-2';
    setTimeout(() => { closeInspectionModal(); loadInspections(); }, 800);
  } catch (err) {
    resEl.textContent = 'Error: ' + err.message;
    resEl.className = 'text-sm font-mono text-rose-400 text-right mb-2';
  }
}

async function loadInspections() {
  const tbody = document.getElementById('insp-list-tbody');
  if (!tbody) return;
  const cachedPending = await offlineDb
    .getAll('inspections')
    .then((all) => (all || []).filter((r) => r && (r.sync === 'pending' || r.sync === 'failed')))
    .catch(() => []);
  const pendingRows = cachedPending.map((r) => `
      <tr style="opacity:.92">
        <td>${escapeHtml(r.property_name || '—')}</td>
        <td>${escapeHtml(r.unit_label || '—')}</td>
        <td>${offlineSyncBadge(r.sync)}</td>
        <td>${escapeHtml((r.created_at || '').slice(0, 10))}</td>
      </tr>`).join('');
  try {
    const { inspections } = await api.listInspections({ limit: 50 });
    if (!inspections.length && !cachedPending.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center text-slate-500 py-4">No inspections yet.</td></tr>';
      return;
    }
    tbody.innerHTML = pendingRows + inspections.map((i) => `
      <tr>
        <td>${escapeHtml(i.property_name || '—')}</td>
        <td>${escapeHtml(i.unit_label || '—')}</td>
        <td>${escapeHtml(i.status || 'Draft')}</td>
        <td>${escapeHtml((i.inspection_date || i.created_at || '').slice(0, 10))}</td>
      </tr>`).join('');
  } catch (err) {
    if (!isNetworkError(err)) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-rose-400 py-4">${escapeHtml(err.message)}</td></tr>`;
      return;
    }
    const cached = await offlineDb.getAll('inspections').catch(() => []);
    tbody.innerHTML = (cached.length ? '' : '<tr><td colspan="4" class="text-center text-slate-500 py-4">Offline — no synced inspections yet.</td></tr>')
      + cached.map((r) => `
      <tr style="opacity:.92">
        <td>${escapeHtml(r.property_name || '—')}</td>
        <td>${escapeHtml(r.unit_label || '—')}</td>
        <td>${offlineSyncBadge(r.sync)}</td>
        <td>${escapeHtml((r.created_at || r.synced_at || '').slice(0, 10))}</td>
      </tr>`).join('');
  }
}

document.getElementById('btn-new-inspection')?.addEventListener('click', openInspectionModal);
document.getElementById('btn-inspection-close')?.addEventListener('click', closeInspectionModal);
document.getElementById('btn-inspection-cancel')?.addEventListener('click', closeInspectionModal);
document.getElementById('btn-inspection-save')?.addEventListener('click', saveInspection);
document.getElementById('insp-photos')?.addEventListener('change', async (e) => {
  const uuid = document.getElementById('insp-client-txn')?.value;
  const listEl = document.getElementById('insp-photo-list');
  if (!uuid) return;
  const files = [...(e.target.files || [])].slice(0, 5);
  for (const f of files) {
    try {
      await stagePhoto(uuid, 'inspection', f, f.name);
    } catch (err) {
      if (listEl) listEl.textContent = 'Photo error: ' + err.message;
      break;
    }
  }
  e.target.value = '';
  refreshInspPhotoList();
});

// ─── Sync conflicts — manager review queue (Phase 3) ──────────────────────

let _conflictsFilter = 'pending';

const CONFLICT_TYPE_LABELS = {
  payment_mpesa: 'M-Pesa payment',
  payment_cash: 'Cash payment',
  wo_create: 'Work order',
  maintenance_create: 'Expense',
  water_create: 'Water reading',
  inspection_create: 'Inspection',
  notice_send: 'Notice',
  exit_create: 'Move-out',
  tenant_occupy: 'Move-in',
};

async function loadConflicts() {
  const tbody = document.getElementById('conflicts-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="text-center text-slate-500 py-6">Loading…</td></tr>';
  try {
    const { conflicts } = await api.listConflicts(_conflictsFilter === 'resolved' ? 'resolved' : 'pending');
    if (!conflicts.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-slate-500 py-6">${_conflictsFilter === 'resolved' ? 'No resolved conflicts.' : 'No pending conflicts. Offline uploads are syncing cleanly. 🟢'}</td></tr>`;
      return;
    }
    tbody.innerHTML = conflicts.map((c) => {
      const summary = c.summary || {};
      const existing = c.existing_ref || null;
      const who = summary.tenant_name || c.tenant_code || '—';
      const detail = summary.mpesa_reference || summary.billing_month || summary.name || summary.property_name || c.client_txn_id || '';
      const existingTxt = existing
        ? `${existing.tenant_name || ''} ${existing.amount != null ? 'KES ' + Number(existing.amount).toLocaleString() : ''} ${existing.receipt_number ? '(' + existing.receipt_number + ')' : ''}`.trim() || '—'
        : '—';
      const statusBadge = c.status === 'resolved'
        ? `<span class="status-badge badge-active">${escapeHtml(c.resolution || 'resolved')}</span>`
        : `<span class="status-badge badge-suspended"><span class="status-dot"></span>pending review</span>`;
      const actions = c.status === 'resolved'
        ? `<span class="text-xs text-slate-500">by ${escapeHtml(c.resolved_by || '—')}</span>`
        : `<button type="button" class="action-btn px-2 py-1 text-xs" data-conflict-dismiss="${c.id}">Dismiss</button>
           <button type="button" class="action-btn px-2 py-1 text-xs text-amber-400 border-amber-400" data-conflict-retry="${c.id}">Retry upload</button>`;
      return `<tr>
        <td class="font-mono text-xs">${escapeHtml((c.created_at || '').slice(0, 16).replace('T', ' '))}</td>
        <td>${escapeHtml(CONFLICT_TYPE_LABELS[c.op_type] || c.op_type || '—')}</td>
        <td>${escapeHtml(who)} <span class="text-slate-500 font-mono text-xs">${escapeHtml(String(detail))}</span></td>
        <td class="text-rose-300 text-xs max-w-xs">${escapeHtml(c.reason || '')}</td>
        <td class="text-xs text-slate-300">${escapeHtml(existingTxt)}</td>
        <td>${statusBadge}</td>
        <td class="text-right whitespace-nowrap">${actions}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-rose-400 py-6">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function resolveConflict(id, resolution) {
  const resEl = document.getElementById('conflicts-result');
  const verb = resolution === 'dismissed' ? 'dismiss (keep server record)' : 'retry the upload';
  if (!confirm(`Are you sure you want to ${verb}?\n\nDismiss: the agent's upload is dropped everywhere.\nRetry: the upload goes up again on the agent's next sync.`)) return;
  try {
    await api.resolveConflict(id, resolution);
    if (resEl) {
      resEl.textContent = resolution === 'dismissed'
        ? 'Dismissed. The agent\u2019s device will clear this upload on its next sync.'
        : 'Marked for retry. The upload will go up again on the agent\u2019s next sync.';
      resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    }
    loadConflicts();
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  }
}

document.getElementById('conflicts-tbody')?.addEventListener('click', (e) => {
  const dismissId = e.target.dataset?.conflictDismiss;
  const retryId = e.target.dataset?.conflictRetry;
  if (dismissId) resolveConflict(dismissId, 'dismissed');
  else if (retryId) resolveConflict(retryId, 'retry');
});
document.getElementById('btn-conflicts-pending')?.addEventListener('click', () => { _conflictsFilter = 'pending'; loadConflicts(); });
document.getElementById('btn-conflicts-resolved')?.addEventListener('click', () => { _conflictsFilter = 'resolved'; loadConflicts(); });
document.getElementById('btn-conflicts-refresh')?.addEventListener('click', () => loadConflicts());

// ─── Commissions (agent commission per house per month) ───────────────────

const fmtKes0 = (v) => 'KES ' + Number(v || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });

async function loadCommissions() {
  const monthEl = document.getElementById('cm-month');
  if (monthEl && !monthEl.value) monthEl.value = new Date().toISOString().slice(0, 7);
  // House filter options (cached houses fall back to report rows).
  try {
    const filterSel = document.getElementById('cm-house-filter');
    if (filterSel && filterSel.options.length <= 1) {
      const { houses } = await api.houses();
      filterSel.innerHTML = '<option value="">All houses</option>' + (houses || []).map((h) =>
        `<option value="${escapeHtml(h.paybill_number || h.id || '')}">${escapeHtml(h.house_name || '')}</option>`).join('');
    }
  } catch (_) {}
  await runCommissionReport();
}

async function runCommissionReport() {
  const tbody = document.getElementById('cm-tbody');
  const resEl = document.getElementById('cm-result');
  const month = document.getElementById('cm-month')?.value || new Date().toISOString().slice(0, 7);
  const house = document.getElementById('cm-house-filter')?.value || null;
  if (tbody) tbody.innerHTML = '<tr><td colspan="9" class="text-center text-slate-500 py-6">Calculating…</td></tr>';
  try {
    const report = await api.commissionReport({ month, house_paybill: house });
    const rows = report.rows || [];
    const t = report.totals || {};
    setTextEl('cm-t-collected', fmtKes0(t.collected));
    setTextEl('cm-t-base', fmtKes0(t.commissionable));
    setTextEl('cm-t-commission', fmtKes0(t.commission));
    setTextEl('cm-t-payout', fmtKes0(t.landlord_payout));
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center text-slate-500 py-6">No houses found.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${escapeHtml(r.property_name || r.house_paybill_number || '—')} <span class="text-slate-500 font-mono text-xs">${escapeHtml(r.house_paybill_number || '')}</span>
          <div class="text-[10px] text-slate-500 font-mono">${Number(r.payment_count || 0)} payment(s)</div></td>
        <td class="text-right font-mono">${fmtKes0(r.collected)}</td>
        <td class="text-right font-mono text-slate-400">${fmtKes0(r.deposit)}</td>
        <td class="text-right font-mono text-slate-400">${fmtKes0(r.garbage)}</td>
        <td class="text-right font-mono text-slate-400">${fmtKes0(r.water)}</td>
        <td class="text-right font-mono text-cyan-400 font-semibold">${fmtKes0(r.commissionable)}</td>
        <td class="text-right">
          <span class="inline-flex items-center gap-1">
            <input type="number" min="0" max="100" step="0.5" value="${Number(r.rate_percent || 0)}"
              data-cm-rate-for="${escapeHtml(r.house_paybill_number || '')}"
              class="cyber-input !w-20 !py-1 text-right font-mono" />
            <span class="font-mono text-slate-400">%</span>
            <button type="button" class="action-btn px-2 py-1 text-xs" data-cm-save="${escapeHtml(r.house_paybill_number || '')}">Save</button>
          </span>
        </td>
        <td class="text-right font-mono text-amber-400 font-bold">${fmtKes0(r.commission)}</td>
        <td class="text-right font-mono text-green-400 font-bold">${fmtKes0(r.landlord_payout)}</td>
      </tr>`).join('') + `
      <tr class="border-t-2 border-slate-600 font-bold">
        <td>Total</td>
        <td class="text-right font-mono">${fmtKes0(t.collected)}</td>
        <td class="text-right font-mono">${fmtKes0(t.deposit)}</td>
        <td class="text-right font-mono">${fmtKes0(t.garbage)}</td>
        <td class="text-right font-mono">${fmtKes0(t.water)}</td>
        <td class="text-right font-mono text-cyan-400">${fmtKes0(t.commissionable)}</td>
        <td></td>
        <td class="text-right font-mono text-amber-400">${fmtKes0(t.commission)}</td>
        <td class="text-right font-mono text-green-400">${fmtKes0(t.landlord_payout)}</td>
      </tr>`;
    if (resEl) {
      const d = new Date(`${report.month}-15T12:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' });
      resEl.textContent = `${d}: commission = rate % × (collected − deposit − garbage − water). Landlord payout = collected − commission.`;
    }
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="text-center text-rose-400 py-6">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function saveCommissionRate(paybill) {
  const input = document.querySelector(`[data-cm-rate-for="${CSS.escape(paybill)}"]`);
  const rate = Number(input?.value ?? 0);
  if (!paybill) return;
  if (!(rate >= 0 && rate <= 100)) { showToast('Rate must be between 0 and 100%.', 'error'); return; }
  try {
    await api.setCommissionRate(paybill, rate);
    showToast(`Commission rate saved: ${rate}%`);
    await runCommissionReport();
  } catch (err) {
    showToast('Failed to save rate: ' + (err.message || err), 'error');
  }
}

document.getElementById('cm-tbody')?.addEventListener('click', (e) => {
  const paybill = e.target?.dataset?.cmSave;
  if (paybill) saveCommissionRate(paybill);
});
document.getElementById('btn-cm-refresh')?.addEventListener('click', runCommissionReport);
document.getElementById('cm-house-filter')?.addEventListener('change', runCommissionReport);

document.querySelectorAll('[data-invoice-type]').forEach(btn => {
  btn.addEventListener('click', () => showInvoiceType(btn.dataset.invoiceType));
});
document.getElementById('btn-back-invoice-type')?.addEventListener('click', showInvoiceTypeSelector);
document.getElementById('btn-back-exit-type')?.addEventListener('click', showInvoiceTypeSelector);
document.getElementById('btn-back-rent-invoice')?.addEventListener('click', showInvoiceTypeSelector);
document.getElementById('btn-back-maintenance-invoices')?.addEventListener('click', showInvoiceTypeSelector);
document.getElementById('btn-back-salary')?.addEventListener('click', showInvoiceTypeSelector);
document.getElementById('btn-new-salary')?.addEventListener('click', () => {
  document.getElementById('sal-form-id').value = '';
  document.getElementById('sal-employee').value = '';
  document.getElementById('sal-month').value = document.getElementById('salary-month-select')?.value || new Date().toISOString().slice(0, 7);
  document.getElementById('sal-previous-balance').value = '0';
  document.getElementById('sal-expected').value = '';
  document.getElementById('sal-notes').value = '';
  updateSalaryPreview();
  document.getElementById('salary-form-wrap').classList.toggle('hidden');
});
document.getElementById('btn-cancel-salary-form')?.addEventListener('click', () => {
  document.getElementById('salary-form-wrap').classList.add('hidden');
});
document.getElementById('salary-form')?.addEventListener('submit', saveSalary);
document.getElementById('salary-payment-form')?.addEventListener('submit', saveSalaryPayment);
document.getElementById('btn-close-spm-modal')?.addEventListener('click', () => {
  document.getElementById('salary-payment-modal').style.display = 'none';
});
document.getElementById('btn-close-sal-hist-modal')?.addEventListener('click', () => {
  document.getElementById('salary-history-modal').style.display = 'none';
});
document.getElementById('btn-salary-rollover')?.addEventListener('click', runSalaryRollover);
document.getElementById('sal-previous-balance')?.addEventListener('input', updateSalaryPreview);
document.getElementById('sal-expected')?.addEventListener('input', updateSalaryPreview);
document.getElementById('btn-meh-search')?.addEventListener('click', searchManagementExpensesHistory);
document.getElementById('btn-meh-clear')?.addEventListener('click', clearManagementExpensesHistory);
document.getElementById('btn-per-search')?.addEventListener('click', searchPropertyExpenseReport);
document.getElementById('btn-mer-generate')?.addEventListener('click', generateMgmtExpensesReport);
document.getElementById('btn-mer-print')?.addEventListener('click', printMgmtExpensesReport);
document.getElementById('btn-mer-download')?.addEventListener('click', downloadMgmtExpensesReport);
document.getElementById('btn-mer-share')?.addEventListener('click', shareMgmtExpensesReport);
document.getElementById('salary-month-select')?.addEventListener('change', loadSalaryDashboard);
// Set default salary month
if (document.getElementById('salary-month-select')) {
  document.getElementById('salary-month-select').value = new Date().toISOString().slice(0, 7);
}
document.getElementById('rent-invoice-tenant-search')?.addEventListener('change', loadRentInvoiceTenantInfo);
document.getElementById('rent-invoice-form')?.addEventListener('submit', (e) => { e.preventDefault(); runRentInvoiceAction('send'); });
document.getElementById('btn-rent-invoice-download')?.addEventListener('click', () => runRentInvoiceAction('download'));
document.getElementById('btn-rent-invoice-both')?.addEventListener('click', () => runRentInvoiceAction('both'));
document.getElementById('btn-new-maintenance-invoice')?.addEventListener('click', () => {
  resetMntForm();
  document.getElementById('maintenance-invoice-form-wrap').classList.remove('hidden');
});
document.getElementById('btn-add-wo-expense')?.addEventListener('click', showWoExpenseModal);
document.getElementById('btn-cancel-mnt-form')?.addEventListener('click', () => {
  document.getElementById('maintenance-invoice-form-wrap').classList.add('hidden');
});
document.getElementById('maintenance-invoice-form')?.addEventListener('submit', saveMaintenanceInvoice);
document.getElementById('btn-add-invoice-item')?.addEventListener('click', addInvoiceItem);
document.getElementById('mnt-category')?.addEventListener('change', (e) => {
  renderMntDynamicFields(e.target.value);
});
document.getElementById('btn-add-plot-expense')?.addEventListener('click', () => addPlotExpenseRow());
document.getElementById('btn-close-wo-expense-modal')?.addEventListener('click', hideWoExpenseModal);
document.getElementById('wo-expense-filter-house')?.addEventListener('change', filterWoExpenses);
document.getElementById('wo-expense-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideWoExpenseModal();
});
document.getElementById('btn-new-work-order')?.addEventListener('click', () => {
  resetWoForm();
  document.getElementById('work-order-form-wrap').classList.toggle('hidden');
});
document.getElementById('btn-add-wo-item')?.addEventListener('click', () => addWoItem());
document.getElementById('btn-cancel-wo-form')?.addEventListener('click', () => {
  document.getElementById('work-order-form-wrap').classList.add('hidden');
});
document.getElementById('work-order-form')?.addEventListener('submit', saveWorkOrder);
document.getElementById('btn-parse-wo-bulk')?.addEventListener('click', parseWoBulkInput);
document.getElementById('btn-clear-wo-bulk')?.addEventListener('click', () => {
  document.getElementById('wo-bulk-input').value = '';
  document.getElementById('wo-items-tbody').innerHTML = '';
  woItemCount = 0;
  addWoItem();
  calculateWoTotals();
});

// Work order list action buttons (event delegation)
document.getElementById('wo-list-tbody')?.addEventListener('click', async (e) => {
  const editId = e.target.dataset.woEdit;
  const pdfId = e.target.dataset.woPdf;
  const sendId = e.target.dataset.woSend;
  const delId = e.target.dataset.woDel;
  if (editId) editWorkOrder(Number(editId));
  else if (pdfId) runWoGenerate('download', Number(pdfId));
  else if (sendId) runWoGenerate('both', Number(sendId));
  else if (delId) deleteWorkOrder(Number(delId));
});

// Work order item buttons (event delegation)
document.getElementById('wo-items-tbody')?.addEventListener('click', (e) => {
  const delItemId = e.target.dataset.woDelItem;
  const toggleId = e.target.dataset.woToggle;
  const addMatId = e.target.dataset.woAddMat;
  const rmMatKey = e.target.dataset.woRmMat;
  if (delItemId) removeWoItem(Number(delItemId));
  else if (toggleId) toggleWoDetail(Number(toggleId));
  else if (addMatId) addWoMaterial(Number(addMatId));
  else if (rmMatKey) {
    const [rowId, matIdx] = rmMatKey.split('-').map(Number);
    removeWoMaterial(rowId, matIdx);
  }
});

document.getElementById('btn-add-deduction')?.addEventListener('click', addDeductionItem);
document.getElementById('btn-load-outstanding')?.addEventListener('click', autoLoadOutstandingMaintenance);
document.getElementById('invoice-tenant-search')?.addEventListener('change', autoLoadOutstandingMaintenance);
document.getElementById('exit-tenant-search')?.addEventListener('change', () => {
  const match = resolveTenant('exit-tenant-search', 'exitTenantsCache');
  if (match) openExitInvoiceModal(match.tenant_code);
});
document.getElementById('btn-add-exit-deduction')?.addEventListener('click', addExitDeduction);
document.getElementById('exit-deposit-paid')?.addEventListener('input', calculateExitSettlement);
document.getElementById('invoice-form')?.addEventListener('submit', (e) => { e.preventDefault(); runInvoiceAction('send'); });
document.getElementById('btn-invoice-download')?.addEventListener('click', () => runInvoiceAction('download'));
document.getElementById('btn-invoice-both')?.addEventListener('click', () => runInvoiceAction('both'));
document.getElementById('exit-invoice-form')?.addEventListener('submit', (e) => { e.preventDefault(); runExitAction('send'); });
document.getElementById('btn-exit-download')?.addEventListener('click', () => runExitAction('download'));
document.getElementById('btn-exit-both')?.addEventListener('click', () => runExitAction('both'));

document.getElementById('message-modal-cancel')?.addEventListener('click', () => {
  document.getElementById('message-modal').classList.add('hidden');
});

document.getElementById('btn-statement-download')?.addEventListener('click', () => runStatementGeneration('download'));
document.getElementById('btn-statement-send')?.addEventListener('click', () => runStatementGeneration('send'));
document.getElementById('btn-statement-both')?.addEventListener('click', () => runStatementGeneration('both'));
document.getElementById('btn-statement-close')?.addEventListener('click', () => {
  document.getElementById('statement-modal').classList.add('hidden');
});

// Exit Invoice modal handlers
document.getElementById('btn-ei-add-line')?.addEventListener('click', () => {
  const tbody = document.getElementById('ei-lines-tbody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  tr.setAttribute('data-ei-line', String(tbody.children.length));
  tr.innerHTML = `
    <td><select class="qc-input text-sm w-36" data-ei-cat>
      ${['maintenance','repair','cleaning','painting','utility','deduction','other'].map(c =>
        `<option value="${c}">${c[0].toUpperCase() + c.slice(1)}</option>`).join('')}
    </select></td>
    <td><input type="text" class="qc-input text-sm w-56" data-ei-desc placeholder="Description" /></td>
    <td><input type="number" min="0" class="qc-input text-sm w-32 text-right" data-ei-amt value="0" /></td>
    <td><button type="button" class="action-btn action-btn-danger !py-1 !px-2 text-xs" data-ei-del>✕</button></td>`;
  tbody.appendChild(tr);
  tr.querySelector('[data-ei-del]').addEventListener('click', () => {
    tr.remove();
    recalcEiTotals();
  });
  tr.querySelectorAll('[data-ei-amt], [data-ei-desc]').forEach((el) => el.addEventListener('input', recalcEiTotals));
  const amt = tr.querySelector('[data-ei-amt]');
  if (amt) amt.focus();
});
document.getElementById('btn-ei-save-draft')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-ei-save-draft');
  btn.disabled = true;
  try { await saveEiDraft(); } catch (err) { setEiStatusMsg('Error: ' + (err.message || err)); }
  finally { btn.disabled = false; }
});
document.getElementById('btn-ei-finalize')?.addEventListener('click', () => {
  const btn = document.getElementById('btn-ei-finalize');
  btn.disabled = true;
  finalizeEi().finally(() => { btn.disabled = false; });
});
document.getElementById('btn-ei-download')?.addEventListener('click', () => runExitInvoiceAction('download'));
document.getElementById('btn-ei-send')?.addEventListener('click', () => runExitInvoiceAction('send'));
document.getElementById('btn-ei-both')?.addEventListener('click', () => runExitInvoiceAction('both'));
document.getElementById('btn-ei-mark-vacant-yes')?.addEventListener('click', markVacantFromEi);
document.getElementById('btn-ei-mark-vacant-no')?.addEventListener('click', () => {
  document.getElementById('ei-mark-vacant-panel')?.classList.add('hidden');
  setEiStatusMsg('Unit kept OCCUPIED. You can download or send the exit invoice again, or mark vacant later.');
});
document.getElementById('btn-ei-cancel')?.addEventListener('click', () => {
  document.getElementById('exit-invoice-modal').classList.add('hidden');
});
document.getElementById('btn-ei-close-final')?.addEventListener('click', () => {
  document.getElementById('exit-invoice-modal').classList.add('hidden');
});
document.getElementById('btn-ei-edit')?.addEventListener('click', startEditFinalizedEi);
document.getElementById('btn-ei-save-finalized')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-ei-save-finalized');
  btn.disabled = true;
  try { await saveFinalizedEi(); } catch (err) { setEiStatusMsg('Error: ' + (err.message || err)); }
  finally { btn.disabled = false; }
});
document.getElementById('btn-ei-cancel-edit')?.addEventListener('click', cancelEditEi);
document.getElementById('btn-ei-delete')?.addEventListener('click', deleteExitInvoice);
document.getElementById('ei-move-out-date')?.addEventListener('change', () => {});
document.getElementById('ei-exit-reason')?.addEventListener('input', () => {});

// Rent treatment radio handlers
document.querySelectorAll('input[name="ei-rent-treatment"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const proRatedRow = document.getElementById('ei-pro-rated-row');
    if (proRatedRow) proRatedRow.classList.toggle('hidden', radio.value !== 'pro_rated');
    recalcEiTotals();
  });
});

// Deposit treatment radio handler
document.querySelectorAll('input[name="ei-deposit-treatment"]').forEach(radio => {
  radio.addEventListener('change', recalcEiTotals);
});

// Pro-rated days input handler
document.getElementById('ei-pro-rated-days')?.addEventListener('input', recalcEiTotals);

// Archive view handlers
document.getElementById('btn-archive-refresh')?.addEventListener('click', loadArchive);
document.getElementById('archive-filter-form')?.addEventListener('submit', (e) => { e.preventDefault(); loadArchive(); });
document.getElementById('btn-archive-clear')?.addEventListener('click', () => {
  ['archive-q', 'archive-house', 'archive-unit', 'archive-exit-date'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  loadArchive();
});
document.getElementById('archive-tbody')?.addEventListener('click', (e) => {
  const viewBtn = e.target.closest('[data-archive-view]');
  const delBtn = e.target.closest('[data-archive-del]');
  const histBtn = e.target.closest('[data-archive-history]');
  if (histBtn) openTenancyHistory(histBtn.dataset.archiveHistory);
  if (viewBtn) openArchiveDetail(viewBtn.dataset.archiveView);
  if (delBtn) deleteArchiveEntry(delBtn.dataset.archiveDel);
});
document.getElementById('btn-th-close')?.addEventListener('click', () => {
  document.getElementById('tenancy-history-modal')?.classList.add('hidden');
});
document.getElementById('tenancy-history-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'tenancy-history-modal') e.target.classList.add('hidden');
});
document.getElementById('btn-th-exit-invoice')?.addEventListener('click', () => {
  const ctx = window._thContext;
  if (!ctx || !ctx.exit_invoice) return;
  document.getElementById('tenancy-history-modal')?.classList.add('hidden');
  openExitInvoiceModal(ctx.tenant_code, ctx.exit_invoice.id, {
    name: ctx.tenant_name,
    unit: ctx.unit,
    property: ctx.property_name,
    rent_amount: ctx.rent_amount,
    deposit_paid: ctx.deposit_paid,
    water_charge: 0,
  });
});
document.getElementById('occupancy-house')?.addEventListener('change', loadOccupancyHistory);
document.getElementById('btn-archive-detail-close')?.addEventListener('click', () => {
  document.getElementById('archive-detail-modal').classList.add('hidden');
});

document.getElementById('message-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const tenantId = document.getElementById('message-tenant-id').value;
  const message = document.getElementById('message-body').value.trim();
  const statusEl = document.getElementById('message-status');
  const btn = document.getElementById('btn-send-message');

  statusEl.classList.remove('hidden');
  statusEl.textContent = 'Sending...';
  statusEl.className = 'text-amber-500 text-sm font-mono mt-2';
  btn.disabled = true;

  // Offline: save as Pending Send — delivered automatically on reconnect.
  if (effectiveOffline()) {
    try {
      const clientTxnId = offlineDb.newClientTxnId();
      const channel = document.getElementById('message-channel')?.value || 'whatsapp';
      await queueOutboxOp({
        type: 'notice_send',
        payload: { tenant_id: tenantId, message, channel, client_txn_id: clientTxnId },
      });
      statusEl.textContent = '🟠 Saved — Pending Send. Will deliver automatically when internet returns.';
      statusEl.className = 'text-amber-500 text-sm font-mono mt-2';
      showToast('Notice saved (Pending Send)');
      setTimeout(() => {
        document.getElementById('message-modal').classList.add('hidden');
        btn.disabled = false;
      }, 1500);
    } catch (err) {
      statusEl.textContent = 'Offline save failed: ' + err.message;
      statusEl.className = 'text-rose-400 text-sm font-mono mt-2';
      btn.disabled = false;
    }
    return;
  }

  try {
    const channel = document.getElementById('message-channel')?.value || 'whatsapp';
    const res = await api.sendMessage(tenantId, message, undefined, channel);
    // Per-channel result line: WhatsApp: Sent · SMS: Sent (or the failure).
    const wa = res.whatsapp || {};
    const sms = res.sms || {};
    const parts = [];
    if (wa.status && wa.status !== 'Skipped') {
      parts.push(`WhatsApp: ${wa.status}${wa.failureReason ? ` (${wa.failureReason})` : ''}`);
    }
    if (sms.status && sms.status !== 'Skipped') {
      parts.push(`SMS: ${sms.status}${sms.failureReason ? ` (${sms.failureReason})` : ''}`);
    }
    const anyFailed = (wa.status === 'Failed') || (sms.status === 'Failed');
    if (res.already_synced) {
      statusEl.textContent = 'Already sent earlier — not duplicated.';
      statusEl.className = 'text-amber-500 text-sm font-mono mt-2';
    } else if (anyFailed) {
      statusEl.textContent = `Sent with issues — ${parts.join(' · ')}`;
      statusEl.className = 'text-amber-500 text-sm font-mono mt-2';
    } else {
      statusEl.textContent = `✓ Message sent — ${parts.join(' · ')}`;
      statusEl.className = 'text-green-500 text-sm font-mono mt-2';
    }
    setTimeout(() => {
      document.getElementById('message-modal').classList.add('hidden');
    }, 2500);
  } catch (err) {
    statusEl.textContent = 'Failed to send: ' + err.message;
    statusEl.className = 'text-rose-400 text-sm font-mono mt-2';
    btn.disabled = false;
  }
});

document.getElementById('report-type-select')?.addEventListener('change', (e) => {
  const val = e.target.value;
  const houseHint = document.getElementById('report-house-hint');
  const monthContainer = document.getElementById('report-month-container');
  if (val === 'deposits' || val === 'payments') {
    if (monthContainer) monthContainer.classList.remove('hidden');
    if (houseHint) houseHint.textContent = 'Leave empty for all houses, or pick a specific house.';
  } else {
    if (monthContainer) monthContainer.classList.add('hidden');
    if (val === 'vacant') {
      if (houseHint) houseHint.textContent = 'Leave empty for all houses, or pick a specific house to generate a unit-level vacancy report.';
    } else {
      if (houseHint) houseHint.textContent = 'Leave empty for all houses, or pick a specific house.';
    }
  }
});

async function runReportAction(mode) {
  const btn = mode === 'download'
    ? document.getElementById('btn-download-report')
    : document.getElementById('btn-send-report');
  const resEl = document.getElementById('report-result');
  const phone = document.getElementById('report-phone').value.trim();
  const reportType = document.getElementById('report-type-select')?.value || 'payments';
  const houseId = document.getElementById('report-house-select')?.value || null;
  const month = document.getElementById('report-month-select')?.value || null;

  if (btn) btn.disabled = true;
  if (resEl) {
    resEl.textContent = mode === 'download' ? 'Generating Excel file...' : 'Generating and sending...';
    resEl.className = 'text-sm font-mono text-amber-400 text-center mt-2';
  }

  try {
    if (mode === 'download') {
      let result;
      if (reportType === 'vacant') {
        result = await api.downloadVacantReport(houseId);
      } else if (reportType === 'outstanding') {
        result = await api.downloadOutstandingReport(houseId);
      } else if (reportType === 'unpaid') {
        result = await api.downloadUnpaidReport(houseId);
      } else if (reportType === 'deposits') {
        result = await api.downloadDepositsReport(houseId, month);
      } else if (reportType === 'payments' && month) {
        result = await api.downloadCollectionReport(houseId, month);
      } else {
        result = await api.downloadPaymentReport(houseId);
      }
      triggerFileDownload(result, resEl, `Downloaded ${result.filename}`);
    } else {
      if (!phone) throw new Error('Enter a WhatsApp number to send the report.');
      if (reportType === 'vacant') {
        await api.sendVacantReport(phone, houseId);
      } else if (reportType === 'outstanding') {
        await api.sendOutstandingReport(phone, houseId);
      } else if (reportType === 'unpaid') {
        await api.sendUnpaidReport(phone, houseId);
      } else if (reportType === 'deposits') {
        await api.sendDepositsReport(phone, houseId, month);
      } else if (reportType === 'payments' && month) {
        await api.sendCollectionReport(houseId, month, phone);
      } else {
        await api.sendPaymentReport(phone, houseId);
      }
      if (resEl) {
        resEl.textContent = `Report generated and sent to ${phone} via WhatsApp!`;
        resEl.className = 'text-sm font-mono text-green-400 text-center mt-2';
      }
    }
  } catch (err) {
    if (resEl) {
      // Server distinguishes generation failures (stage: generate) from
      // WhatsApp delivery failures (stage: send) — surface its exact message.
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-center mt-2';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.getElementById('report-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  runReportAction('send');
});
document.getElementById('btn-download-report')?.addEventListener('click', () => runReportAction('download'));

document.getElementById('btn-run-rollover')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-run-rollover');
  const resEl = document.getElementById('rollover-result');
  if (!confirm('Run rollover now? This will add unpaid rent as arrears for all overdue tenants.')) return;
  if (btn) btn.disabled = true;
  if (resEl) {
    resEl.textContent = 'Running rollover...';
    resEl.className = 'text-sm font-mono text-amber-400 text-center mt-2';
  }
  try {
    const result = await api.runRollover();
    const count = result.tenants_updated || 0;
    if (resEl) {
      resEl.textContent = count > 0
        ? `Rollover complete — ${count} tenant(s) updated with new arrears.`
        : 'Rollover complete — no tenants needed rollover.';
      resEl.className = 'text-sm font-mono text-green-400 text-center mt-2';
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-center mt-2';
    }
  } finally {
    if (btn) btn.disabled = false;
    // Rollover changes arrears / due dates / statuses — refresh the cards now
    // instead of waiting for the 30s dashboard poll.
    loadDashboard();
  }
});

/* ---------------- DOCUMENTS HUB ---------------- */

let documentsShareDocId = null;

function docsTypeLabel(type) {
  return {
    receipt: 'Payment Receipt',
    invoice: 'Invoice',
    exit_invoice: 'Exit Invoice',
    report: 'Report',
    letter: 'Letter',
  }[type] || (type || 'Document');
}

function formatDocsDate(iso) {
  if (!iso) return '—';
  let d;
  if (String(iso).includes('T')) d = new Date(iso);
  else d = new Date(String(iso) + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function loadDocuments() {
  const tenantSel = document.getElementById('documents-tenant');
  if (tenantSel && tenantSel.options.length <= 1) {
    try {
      const { tenants } = await api.tenants();
      tenantSel.innerHTML = '<option value="">All Tenants</option>' +
        tenants.map(t => `<option value="${escapeHtml(t.tenant_code)}">${escapeHtml(t.name)} (${escapeHtml(t.tenant_code)})</option>`).join('');
    } catch (err) {
      /* keep tenant filter empty on failure */
    }
  }
  await runDocumentsSearch();
}

async function runDocumentsSearch() {
  const params = {};
  const type = document.getElementById('documents-type')?.value;
  const tenant = document.getElementById('documents-tenant')?.value;
  const q = document.getElementById('documents-q')?.value.trim();
  const from = document.getElementById('documents-from')?.value;
  const to = document.getElementById('documents-to')?.value;
  if (type) params.doc_type = type;
  if (tenant) params.tenant_code = tenant;
  if (q) params.q = q;
  if (from) params.from = from;
  if (to) params.to = to;

  const tbody = document.getElementById('documents-tbody');
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-slate-500 py-6">Loading documents...</td></tr>';
  }

  try {
    const result = await api.documents(params);
    renderDocuments(result.documents || [], result.total || 0);
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-rose-400 py-6">Error: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

function renderDocuments(documents, total) {
  const tbody = document.getElementById('documents-tbody');
  const countEl = document.getElementById('documents-count');
  if (countEl) countEl.textContent = `${documents.length} shown / ${total} total`;
  if (!tbody) return;

  if (!documents.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-slate-500 py-6">No documents found.</td></tr>';
    return;
  }

  const letterStatusBadge = (d) => ({
    Draft: '<span class="status-badge badge-pending"><span class="status-dot"></span>Draft</span>',
    Finalized: '<span class="status-badge badge-active"><span class="status-dot"></span>Ready</span>',
    Sent: '<span class="status-badge badge-active"><span class="status-dot"></span>Sent</span>',
    Downloaded: '<span class="status-badge"><span class="status-dot"></span>Downloaded</span>',
  }[d.status] || `<span class="status-badge">${escapeHtml(d.status || '')}</span>`);

  tbody.innerHTML = documents.map(d => `
    <tr>
      <td><span class="sys-tag">${escapeHtml(docsTypeLabel(d.doc_type).toUpperCase())}</span></td>
      <td class="font-mono">${escapeHtml(d.doc_number || '—')}</td>
      <td>
        <div class="font-semibold">${escapeHtml(d.title || 'Document')}</div>
        ${d.tenant_name ? `<div class="text-xs text-slate-400">${escapeHtml(d.tenant_name)}</div>` : ''}
        ${d.doc_type === 'letter' ? `<div class="mt-1">${letterStatusBadge(d)}</div>` : ''}
      </td>
      <td class="text-slate-300">
        ${escapeHtml(d.house_name || d.property_name || '—')}
        ${d.unit_label ? ` <span class="font-mono text-xs">(${escapeHtml(d.unit_label)})</span>` : ''}
      </td>
      <td>${formatDocsDate(d.doc_date)}</td>
      <td class="text-right font-mono">${d.amount != null ? formatKes(d.amount) : '—'}</td>
      <td class="text-right whitespace-nowrap">
        ${d.doc_type === 'letter' && d.status === 'Draft' ? `
        <button type="button" class="action-btn text-xs" data-doc-action="edit-draft" data-doc-id="${d.id}">Edit</button>
        <button type="button" class="action-btn text-green-400 border-green-400 hover:bg-green-400/20 text-xs" data-doc-action="finalize" data-doc-id="${d.id}">Finalize</button>
        <button type="button" class="action-btn action-btn-danger text-xs" data-doc-action="delete" data-doc-id="${d.id}">Delete</button>
        ` : d.doc_type === 'letter' ? `
        <button type="button" class="action-btn text-xs" data-doc-action="view" data-doc-id="${d.id}">View</button>
        <button type="button" class="action-btn text-xs" data-doc-action="edit-version" data-doc-id="${d.id}">Edit</button>
        <button type="button" class="action-btn text-xs" data-doc-action="download" data-doc-id="${d.id}">Download</button>
        <button type="button" class="action-btn text-xs" data-doc-action="print" data-doc-id="${d.id}">Print</button>
        <button type="button" class="action-btn text-green-400 border-green-400 hover:bg-green-400/20 text-xs" data-doc-action="share" data-doc-id="${d.id}">WhatsApp</button>
        <button type="button" class="action-btn action-btn-danger text-xs" data-doc-action="delete" data-doc-id="${d.id}">Delete</button>
        ` : `
        <button type="button" class="action-btn text-xs" data-doc-action="view" data-doc-id="${d.id}">View</button>
        <button type="button" class="action-btn text-xs" data-doc-action="download" data-doc-id="${d.id}">Download</button>
        <button type="button" class="action-btn text-xs" data-doc-action="print" data-doc-id="${d.id}">Print</button>
        <button type="button" class="action-btn text-green-400 border-green-400 hover:bg-green-400/20 text-xs" data-doc-action="share" data-doc-id="${d.id}">WhatsApp</button>
        `}
      </td>
    </tr>
  `).join('');
}

async function downloadDocumentFile(doc) {
  const res = await fetch(`/api/documents/${doc.id}/download`, {
    headers: { Authorization: `Bearer ${api.getToken()}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Download failed');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.filename || 'document.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

let documentsViewBlobUrl = null;
async function openDocumentViewModal(doc) {
  const modal = document.getElementById('documents-view-modal');
  const frame = document.getElementById('documents-view-frame');
  const title = document.getElementById('documents-view-title');
  if (!modal || !frame) return;
  if (title) title.textContent = doc.title || doc.doc_number || 'Document';
  frame.src = 'about:blank';
  modal.classList.remove('hidden');
  try {
    const res = await fetch(`/api/documents/${doc.id}/print`, {
      headers: { Authorization: `Bearer ${api.getToken()}` },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to open document');
    }
    const blob = await res.blob();
    if (documentsViewBlobUrl) URL.revokeObjectURL(documentsViewBlobUrl);
    documentsViewBlobUrl = URL.createObjectURL(blob);
    frame.src = documentsViewBlobUrl;
  } catch (err) {
    if (title) title.textContent = 'Failed to load: ' + err.message;
  }
}
function closeDocumentViewModal() {
  const modal = document.getElementById('documents-view-modal');
  const frame = document.getElementById('documents-view-frame');
  if (modal) modal.classList.add('hidden');
  if (frame) frame.src = 'about:blank';
  if (documentsViewBlobUrl) { URL.revokeObjectURL(documentsViewBlobUrl); documentsViewBlobUrl = null; }
}
document.getElementById('btn-documents-view-close')?.addEventListener('click', closeDocumentViewModal);

async function openDocumentForPrint(doc) {
  const res = await fetch(`/api/documents/${doc.id}/print`, {
    headers: { Authorization: `Bearer ${api.getToken()}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to open document');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

document.getElementById('documents-filter-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  runDocumentsSearch();
});
document.getElementById('btn-documents-refresh')?.addEventListener('click', () => loadDocuments());
document.getElementById('btn-documents-clear')?.addEventListener('click', () => {
  ['documents-type', 'documents-tenant', 'documents-q', 'documents-from', 'documents-to'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  runDocumentsSearch();
});
document.getElementById('documents-tbody')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-doc-action]');
  if (!btn) return;
  const id = btn.dataset.docId;
  try {
    const { document: doc } = await api.document(id);
    if (!doc) throw new Error('Document not found');
    const action = btn.dataset.docAction;
    if (action === 'edit-draft') {
      btn.disabled = true;
      try { await openDocDraftEditor(id); } finally { btn.disabled = false; }
    } else if (action === 'finalize') {
      if (!confirm('Finalize this draft? A document number and PDF will be generated and the row locked.')) return;
      btn.disabled = true;
      try {
        await api.finalizeLetter(id);
        showToast('Letter finalized and saved to Documents Hub.');
        revealLetterInHub();
        loadDocuments();
      } catch (err) {
        alert('Finalize failed: ' + (err.message || err));
      } finally { btn.disabled = false; }
    } else if (action === 'view') {
      openDocumentViewModal(doc);
    } else if (action === 'edit-version') {
      if (!confirm('Create a new editable draft version of this finalized letter? The original stays unchanged.')) return;
      btn.disabled = true;
      try {
        const res = await api.newVersionLetter(id);
        showToast(`New draft version created (#${res.document?.id || '—'}).`);
        await openDocDraftEditor(res.document.id);
        loadDocuments();
      } catch (err) {
        alert('New version failed: ' + (err.message || err));
      } finally { btn.disabled = false; }
    } else if (action === 'delete') {
      if (!confirm(`Delete "${doc.title || 'this letter'}" permanently? The PDF file is removed too. Tenant, property and payment records are NOT affected.`)) return;
      btn.disabled = true;
      try {
        await api.deleteDocument(id);
        showToast('Document deleted.');
        loadDocuments();
      } catch (err) {
        alert('Delete failed: ' + (err.message || err));
      } finally { btn.disabled = false; }
    } else if (action === 'download') {
      btn.disabled = true;
      try { await downloadDocumentFile(doc); loadDocuments(); } finally { btn.disabled = false; }
    } else if (action === 'print') {
      btn.disabled = true;
      try { await openDocumentForPrint(doc); } finally { btn.disabled = false; }
    } else if (action === 'share') {
      documentsShareDocId = doc.id;
      const phoneEl = document.getElementById('documents-share-phone');
      if (phoneEl) phoneEl.value = doc.tenant_phone || '';
      const statusEl = document.getElementById('documents-share-status');
      if (statusEl) statusEl.textContent = '';
      const shareModal = document.getElementById('documents-share-modal');
      if (shareModal) shareModal.classList.remove('hidden');
    }
  } catch (err) {
    alert('Action failed: ' + err.message);
  }
});
document.getElementById('btn-documents-share-cancel')?.addEventListener('click', () => {
  const shareModal = document.getElementById('documents-share-modal');
  if (shareModal) shareModal.classList.add('hidden');
  documentsShareDocId = null;
});
document.getElementById('btn-documents-share-send')?.addEventListener('click', async () => {
  if (!documentsShareDocId) return;
  const btn = document.getElementById('btn-documents-share-send');
  const phone = document.getElementById('documents-share-phone')?.value.trim();
  const statusEl = document.getElementById('documents-share-status');
  if (btn) btn.disabled = true;
  if (statusEl) {
    statusEl.textContent = 'Sending...';
    statusEl.className = 'text-sm font-mono text-amber-400';
  }
  try {
    await api.shareDocument(documentsShareDocId, phone);
    if (statusEl) {
      statusEl.textContent = 'Sent successfully!';
      statusEl.className = 'text-sm font-mono text-green-400';
    }
    loadDocuments();
    setTimeout(() => {
      const shareModal = document.getElementById('documents-share-modal');
      if (shareModal) shareModal.classList.add('hidden');
      documentsShareDocId = null;
    }, 1200);
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.className = 'text-sm font-mono text-rose-400';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ─── Documents Hub letter templates (inside the existing hub) ─────────────

// ─── Custom Notice (Blank Letterhead) — inside the existing hub ─────────────
// Recipient (Tenant / Unit / Property → all or specific tenants) → review →
// notice date + subject + content → one INDIVIDUAL notice per tenant, saved
// under that tenant. Nothing is ever auto-sent: Send is per row, by the user.

let cnTenants = null;

async function ensureCnTenants() {
  if (cnTenants && cnTenants.length) return cnTenants;
  const { tenants } = await api.tenants();
  cnTenants = (tenants || []).map((t) => ({
    tenant_code: t.tenant_code,
    name: t.name,
    unit: t.unit_label || t.tenant_code,
    property: t.property_name || '—',
  }));
  return cnTenants;
}

function cnRecipientType() {
  return document.querySelector('input[name="cn-recipient-type"]:checked')?.value || 'tenant';
}

function cnCurrentSelection() {
  if (!cnTenants) return [];
  const type = cnRecipientType();
  if (type === 'tenant') {
    const code = document.getElementById('cn-tenant')?.value;
    return code ? cnTenants.filter((t) => t.tenant_code === code) : [];
  }
  if (type === 'unit') {
    const code = document.getElementById('cn-unit')?.value;
    return code ? cnTenants.filter((t) => t.tenant_code === code) : [];
  }
  const prop = document.getElementById('cn-property')?.value;
  if (!prop) return [];
  const inProp = cnTenants.filter((t) => t.property === prop);
  const scope = document.querySelector('input[name="cn-scope"]:checked')?.value || 'all';
  if (scope === 'all') return inProp;
  const checked = new Set(
    [...document.querySelectorAll('#cn-specific-list input:checked')].map((i) => i.value)
  );
  return inProp.filter((t) => checked.has(t.tenant_code));
}

function cnRenderReview() {
  const sel = cnCurrentSelection();
  const body = document.getElementById('cn-review-body');
  const count = document.getElementById('cn-review-count');
  if (count) count.textContent = String(sel.length);
  if (!body) return;
  if (!sel.length) {
    body.innerHTML = '<tr><td colspan="3" class="p-2 text-slate-500">No recipients selected</td></tr>';
    return;
  }
  body.innerHTML = sel.map((t) => `
    <tr class="border-t border-slate-800">
      <td class="p-2 text-slate-200">${escapeHtml(t.name)} <span class="text-slate-500 font-mono">(${escapeHtml(t.tenant_code)})</span></td>
      <td class="p-2 font-mono text-slate-300">${escapeHtml(String(t.unit))}</td>
      <td class="p-2 text-slate-400">${escapeHtml(t.property)}</td>
    </tr>`).join('');
}

function cnRenderSpecificList() {
  const wrap = document.getElementById('cn-specific-wrap');
  const list = document.getElementById('cn-specific-list');
  const type = cnRecipientType();
  const scope = document.querySelector('input[name="cn-scope"]:checked')?.value || 'all';
  const show = type === 'property' && scope === 'specific';
  if (wrap) wrap.classList.toggle('hidden', !show);
  if (!show || !list) return;
  const prop = document.getElementById('cn-property')?.value || '';
  const checked = new Set([...list.querySelectorAll('input:checked')].map((i) => i.value));
  const inProp = (cnTenants || []).filter((t) => t.property === prop);
  list.innerHTML = inProp.length ? inProp.map((t) => `
    <label class="flex items-center gap-2 py-0.5">
      <input type="checkbox" value="${escapeHtml(t.tenant_code)}" ${checked.has(t.tenant_code) ? 'checked' : ''} />
      <span class="text-slate-300">${escapeHtml(String(t.unit))} — ${escapeHtml(t.name)}</span>
    </label>`).join('') : '<span class="text-slate-500 p-2">No tenants in this property</span>';
}

function cnSyncControls() {
  const type = cnRecipientType();
  const tenantWrap = document.getElementById('cn-tenant-wrap');
  const unitWrap = document.getElementById('cn-unit-wrap');
  const propWrap = document.getElementById('cn-property-wrap');
  const scopeWrap = document.getElementById('cn-scope-wrap');
  if (tenantWrap) tenantWrap.classList.toggle('hidden', type !== 'tenant');
  if (unitWrap) unitWrap.classList.toggle('hidden', type !== 'unit');
  if (propWrap) propWrap.classList.toggle('hidden', type !== 'property');
  if (scopeWrap) scopeWrap.classList.toggle('hidden', type !== 'property');
  cnRenderSpecificList();
  cnRenderReview();
}

async function openCustomNoticeModal() {
  const modal = document.getElementById('custom-notice-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const status = document.getElementById('cn-status');
  if (status) { status.textContent = 'Loading tenants…'; status.className = 'text-sm font-mono text-center mb-2 text-amber-400'; }
  try {
    const list = await ensureCnTenants();
    const tenantSel = document.getElementById('cn-tenant');
    const unitSel = document.getElementById('cn-unit');
    const propSel = document.getElementById('cn-property');
    if (tenantSel) {
      tenantSel.innerHTML = '<option value="">— Select tenant —</option>' +
        list.map((t) => `<option value="${escapeHtml(t.tenant_code)}">${escapeHtml(t.name)} (${escapeHtml(String(t.unit))})</option>`).join('');
    }
    if (unitSel) {
      unitSel.innerHTML = '<option value="">— Select unit —</option>' +
        [...list].sort((a, b) => String(a.unit).localeCompare(String(b.unit)))
          .map((t) => `<option value="${escapeHtml(t.tenant_code)}">${escapeHtml(String(t.unit))} — ${escapeHtml(t.name)}</option>`).join('');
    }
    if (propSel) {
      const props = [...new Set(list.map((t) => t.property))].sort();
      propSel.innerHTML = '<option value="">— Select property —</option>' +
        props.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    }
    const dateEl = document.getElementById('cn-date');
    if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);
    const subjEl = document.getElementById('cn-subject');
    const bodyEl = document.getElementById('cn-body');
    if (subjEl) subjEl.value = '';
    if (bodyEl) bodyEl.value = '';
    const typeTenant = document.querySelector('input[name="cn-recipient-type"][value="tenant"]');
    const scopeAll = document.querySelector('input[name="cn-scope"][value="all"]');
    if (typeTenant) typeTenant.checked = true;
    if (scopeAll) scopeAll.checked = true;
    if (status) status.textContent = '';
    cnSyncControls();
  } catch (err) {
    if (status) { status.textContent = 'Failed to load tenants: ' + err.message; status.className = 'text-sm font-mono text-center mb-2 text-rose-400'; }
  }
}

function closeCustomNoticeModal() {
  const modal = document.getElementById('custom-notice-modal');
  if (modal) modal.classList.add('hidden');
}

document.getElementById('btn-custom-notice')?.addEventListener('click', openCustomNoticeModal);
document.getElementById('btn-cn-close')?.addEventListener('click', closeCustomNoticeModal);
document.getElementById('btn-cn-cancel')?.addEventListener('click', closeCustomNoticeModal);
document.querySelectorAll('input[name="cn-recipient-type"]').forEach((el) => {
  el.addEventListener('change', cnSyncControls);
});
document.querySelectorAll('input[name="cn-scope"]').forEach((el) => {
  el.addEventListener('change', cnSyncControls);
});
document.getElementById('cn-tenant')?.addEventListener('change', cnRenderReview);
document.getElementById('cn-unit')?.addEventListener('change', cnRenderReview);
document.getElementById('cn-property')?.addEventListener('change', cnSyncControls);
document.getElementById('cn-specific-list')?.addEventListener('change', cnRenderReview);

document.getElementById('btn-cn-create')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-cn-create');
  const status = document.getElementById('cn-status');
  const subject = document.getElementById('cn-subject')?.value.trim() || '';
  const body = document.getElementById('cn-body')?.value || '';
  const notice_date = document.getElementById('cn-date')?.value || '';
  const sel = cnCurrentSelection();
  const setStatus = (text, cls) => {
    if (status) { status.textContent = text; status.className = `text-sm font-mono text-center mb-2 ${cls}`; }
  };
  if (!sel.length) return setStatus('Select at least one recipient first.', 'text-amber-400');
  if (!subject) return setStatus('Subject is required.', 'text-amber-400');
  if (!body.trim()) return setStatus('Notice content is required.', 'text-amber-400');
  if (!confirm(`Create ${sel.length} individual notice${sel.length > 1 ? 's' : ''}? Each is saved separately under its tenant. Nothing will be sent.`)) return;
  if (btn) btn.disabled = true;
  setStatus(`Creating ${sel.length} notice${sel.length > 1 ? 's' : ''}…`, 'text-amber-400');
  try {
    const res = await api.customNotice({
      tenant_codes: sel.map((t) => t.tenant_code),
      subject, body, notice_date,
    });
    if (res.failed > 0) {
      const errs = (res.results || []).filter((r) => !r.ok).map((r) => `${r.tenant_code}: ${r.error}`).join('; ');
      setStatus(`Created ${res.created}, failed ${res.failed}. ${errs}`, 'text-amber-400');
    } else {
      setStatus(`Created ${res.created} notice${res.created > 1 ? 's' : ''} — not sent.`, 'text-green-400');
      showToast(`${res.created} individual notice${res.created > 1 ? 's' : ''} created and saved under each tenant. Nothing was sent — use Send on each notice.`);
      setTimeout(() => {
        closeCustomNoticeModal();
        ['documents-type', 'documents-tenant', 'documents-q', 'documents-from', 'documents-to'].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });
        runDocumentsSearch();
      }, 700);
    }
  } catch (err) {
    setStatus('Error: ' + err.message, 'text-rose-400');
  } finally {
    if (btn) btn.disabled = false;
  }
});

let docLetterTemplates = [];
let docBodyEdited = false;
let docResolvedTenant = null;
let docLastSubject = '';
let docLastRecipient = '';
let docPlaceholderTarget = 'doc-letter-body';
const docPlaceholderCache = {};

async function loadDocPlaceholders(templateKey) {
  const pick = document.getElementById('doc-placeholder-pick');
  if (!pick) return;
  try {
    if (!docPlaceholderCache[templateKey]) {
      const r = await api.placeholders(templateKey);
      docPlaceholderCache[templateKey] = r.placeholders || [];
    }
    const groups = {};
    for (const p of docPlaceholderCache[templateKey]) {
      (groups[p.group || 'Other'] = groups[p.group || 'Other'] || []).push(p);
    }
    pick.innerHTML = '<option value="">— Insert placeholder at cursor (Subject / Recipient / Body) —</option>' +
      Object.entries(groups).map(([g, items]) =>
        `<optgroup label="${escapeHtml(g)}">` +
        items.map((p) => `<option value="${escapeHtml(p.code)}">{{${escapeHtml(p.code)}}} — ${escapeHtml(p.label)}</option>`).join('') +
        '</optgroup>').join('');
  } catch (_) {}
}

async function openDocTemplatePicker() {
  const modal = document.getElementById('doc-template-modal');
  const grid = document.getElementById('doc-template-grid');
  if (!modal || !grid) return;
  grid.innerHTML = '<p class="text-slate-500 text-sm">Loading templates…</p>';
  modal.classList.remove('hidden');
  try {
    if (!docLetterTemplates.length) {
      const { templates } = await api.docTemplates();
      docLetterTemplates = templates || [];
    }
    grid.innerHTML = docLetterTemplates.map((t) => `
      <button type="button" class="text-left rounded border border-slate-700 bg-slate-900 p-3 hover:border-cyan-400" data-doc-template="${escapeHtml(t.key)}">
        <div class="font-semibold text-sm text-white">${escapeHtml(t.label)}</div>
        <div class="text-xs text-slate-400 mt-1">${escapeHtml(t.description || '')}</div>
      </button>`).join('') || '<p class="text-slate-500 text-sm">No templates available.</p>';
  } catch (err) {
    grid.innerHTML = `<p class="text-rose-400 text-sm">Failed to load templates: ${escapeHtml(err.message)}</p>`;
  }
}

function docLetterFieldInput(f, value) {
  const val = value ?? f.default ?? '';
  const req = f.required ? 'required' : '';
  const base = `data-doc-field="${escapeHtml(f.name)}"`;
  const label = `<label class="form-label text-xs">${escapeHtml(f.label)}${f.required ? ' *' : ''}</label>`;
  if (f.type === 'textarea' || f.type === 'list') {
    return `<div>${label}<textarea ${base} rows="${f.type === 'list' ? 5 : 3}" class="cyber-input w-full font-mono text-xs" placeholder="${escapeHtml(f.placeholder || '')}">${escapeHtml(val)}</textarea></div>`;
  }
  if (f.type === 'select') {
    const opts = (f.options || []).map((o) => `<option value="${escapeHtml(o.value ?? o)}" ${String(val) === String(o.value ?? o) ? 'selected' : ''}>${escapeHtml(o.label ?? o)}</option>`).join('');
    return `<div>${label}<select ${base} class="cyber-input w-full">${opts}</select></div>`;
  }
  const inputType = f.type === 'date' ? 'date' : f.type === 'month' ? 'month' : f.type === 'number' ? 'number' : 'text';
  return `<div>${label}<input type="${inputType}" ${base} value="${escapeHtml(val)}" ${req} class="cyber-input w-full" placeholder="${escapeHtml(f.placeholder || '')}" /></div>`;
}

function collectDocLetterValues() {
  const values = {};
  document.querySelectorAll('[data-doc-field]').forEach((el) => {
    values[el.dataset.docField] = el.value;
  });
  return values;
}

async function openDocLetterEditor(templateKey, existingDoc = null) {
  const template = (docLetterTemplates.find((t) => t.key === templateKey))
    || (await api.docTemplates().then((r) => (docLetterTemplates = r.templates || []).find((t) => t.key === templateKey)).catch(() => null));
  if (!template) { alert('Template not found.'); return; }
  document.getElementById('doc-template-modal')?.classList.add('hidden');
  document.getElementById('doc-letter-key').value = template.key;
  document.getElementById('doc-letter-id').value = existingDoc?.id || '';
  document.getElementById('doc-letter-title').textContent = (existingDoc ? 'Edit Draft — ' : 'New Document — ') + template.label;
  document.getElementById('doc-letter-desc').textContent = template.description || '';
  document.getElementById('doc-letter-fields').innerHTML =
    (template.fields || [])
      .filter((f) => !['letter_subject', 'letter_body', 'document_title', 'document_body'].includes(f.name))
      .map((f) => docLetterFieldInput(f)).join('');
  // Custom/landlord addressees need name + address inputs (tenant/house
  // details still auto-fill the body from the selected tenant).
  if (template.recipient === 'custom' || template.recipient === 'landlord') {
    const wrap = document.getElementById('doc-letter-fields');
    const extra = document.createElement('div');
    extra.className = 'grid grid-cols-1 md:grid-cols-2 gap-3 col-span-full';
    extra.innerHTML =
      `<div><label class="form-label text-xs">Recipient Name</label>` +
      `<input type="text" data-doc-field="recipient_name" class="cyber-input w-full" placeholder="Who receives this letter" /></div>` +
      `<div><label class="form-label text-xs">Recipient Address</label>` +
      `<textarea data-doc-field="recipient_address" rows="2" class="cyber-input w-full font-mono text-xs"></textarea></div>`;
    wrap.prepend(extra);
  }
  // Tenant picker (existing tenants; optional).
  const tenantSel = document.getElementById('doc-letter-tenant');
  if (tenantSel) {
    if (tenantSel.options.length <= 1) {
      try {
        const { tenants } = await api.tenants();
        tenantSel.innerHTML = '<option value="">— No tenant —</option>' +
          (tenants || []).map((t) => `<option value="${escapeHtml(t.tenant_code)}">${escapeHtml(t.name)} (${escapeHtml(t.tenant_code)})</option>`).join('');
      } catch (_) {}
    }
    tenantSel.value = existingDoc?.tenant_code || '';
    tenantSel.disabled = !!existingDoc;
  }
  // Property picker for property-wide batch generation.
  const propSel = document.getElementById('doc-letter-property');
  if (propSel && propSel.options.length <= 1) {
    try {
      const { houses } = await api.houses();
      propSel.innerHTML = '<option value="">— No property —</option>' +
        (houses || []).map((h) => `<option value="${escapeHtml(h.paybill_number || h.id || '')}">${escapeHtml(h.house_name || '')}</option>`).join('');
    } catch (_) {}
  }
  // Batch is offered for tenant-addressed templates only.
  document.getElementById('btn-doc-letter-batch')?.classList.toggle(
    'hidden', !(template.recipient === 'tenant') || !!existingDoc
  );
  document.getElementById('doc-letter-subject').value = existingDoc?.title || template.subject || '';
  document.getElementById('doc-letter-recipient').value = '';
  document.getElementById('doc-letter-body').value = existingDoc?.body_text || '';
  document.getElementById('doc-letter-preview').classList.add('hidden');
  document.getElementById('doc-letter-preview').innerHTML = '';
  setDocLetterStatus('');
  docBodyEdited = !!existingDoc;
  docResolvedTenant = null;
  docLastSubject = '';
  docLastRecipient = '';
  document.getElementById('doc-letter-modal')?.classList.remove('hidden');
  loadDocPlaceholders(template.key);
  if (!existingDoc) await autofillDocLetter(false);
}

function setDocLetterStatus(msg, isError) {
  const el = document.getElementById('doc-letter-status');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'text-sm font-mono text-center mb-2 ' + (isError ? 'text-rose-400' : 'text-green-400');
}

async function autofillDocLetter(announce = true) {
  const key = document.getElementById('doc-letter-key')?.value;
  const tenantCode = document.getElementById('doc-letter-tenant')?.value || null;
  if (!key) return;
  const values = collectDocLetterValues();
  setDocLetterStatus('Resolving details…');
  try {
    const r = await api.resolveLetter({ template_key: key, tenant_code: tenantCode, values });
    const subjectEl = document.getElementById('doc-letter-subject');
    const recipEl = document.getElementById('doc-letter-recipient');
    const bodyEl = document.getElementById('doc-letter-body');
    // Subject/recipient follow the tenant unless the user customized them
    // after the last resolution; the body follows until hand-edited. A
    // subject still showing the raw template text counts as uncustomized.
    const rawTemplateSubject = (docLetterTemplates.find((t) => t.key === key)?.subject) || '';
    if (subjectEl && (!subjectEl.value || subjectEl.value === docLastSubject || subjectEl.value === rawTemplateSubject)) {
      subjectEl.value = r.subject || '';
    }
    if (recipEl && (!recipEl.value || recipEl.value === docLastRecipient)) {
      recipEl.value = r.recipient_block || '';
    }
    if (bodyEl && !docBodyEdited) bodyEl.value = r.body || '';
    docLastSubject = r.subject || '';
    docLastRecipient = r.recipient_block || '';
    docResolvedTenant = tenantCode;
    // Fill empty dynamic fields from resolved raw values (arrears, rent,
    // dates…). Never overwrite what the user already typed.
    const raw = r.raw || {};
    const disp = r.data || {};
    document.querySelectorAll('#doc-letter-fields [data-doc-field]').forEach((el) => {
      if (el.value !== '' && el.value != null) return;
      const name = el.dataset.docField;
      const type = el.type || el.tagName.toLowerCase();
      if (raw[name] !== undefined && raw[name] !== null && raw[name] !== '') {
        if (type === 'number' || type === 'date' || type === 'month') {
          const str = String(raw[name]);
          if (type === 'number' || /^\d{4}-\d{2}(-\d{2})?$/.test(str)) el.value = str;
        } else if (el.tagName === 'SELECT') {
          const opt = [...el.options].find((o) => o.value === String(raw[name]));
          if (opt) el.value = opt.value;
        } else if (disp[name]) {
          el.value = disp[name];
        }
      }
    });
    setDocLetterStatus(announce ? 'Details loaded — review and edit freely.' : '');
    return r;
  } catch (err) {
    setDocLetterStatus('Autofill failed: ' + (err.message || err), true);
    return null;
  }
}

function previewDocLetter() {
  previewDocLetterServer();
}

// Server-rendered preview: identical substitution to the PDF, so raw
// {{VARIABLE}} placeholders can never hide in the letter body unnoticed.
async function previewDocLetterServer() {
  const container = document.getElementById('doc-letter-preview');
  if (!container) return;
  const key = document.getElementById('doc-letter-key')?.value;
  if (!key) return;
  container.innerHTML = '<p class="text-slate-500 text-sm">Rendering preview…</p>';
  container.classList.remove('hidden');
  try {
    const r = await api.previewLetter({
      template_key: key,
      tenant_code: document.getElementById('doc-letter-tenant')?.value || null,
      values: collectDocLetterValues(),
      body: document.getElementById('doc-letter-body')?.value || null,
      subject: document.getElementById('doc-letter-subject')?.value || null,
      recipient: document.getElementById('doc-letter-recipient')?.value || null,
    });
    container.innerHTML = r.html || '<p class="text-slate-500">Empty preview.</p>';
  } catch (err) {
    container.innerHTML = `<p class="text-rose-500 text-sm">Preview failed: ${escapeHtml(err.message || err)}</p>`;
  }
}

function gatherDocLetterPayload(status) {
  const key = document.getElementById('doc-letter-key')?.value;
  if (!key) throw new Error('No template selected');
  const template = docLetterTemplates.find((t) => t.key === key);
  const values = collectDocLetterValues();
  // Subject/body live in the dedicated editor inputs; mirror them onto the
  // template fields that alias them (general letter, custom document).
  const editorSubject = document.getElementById('doc-letter-subject')?.value || '';
  const editorBody = document.getElementById('doc-letter-body')?.value || '';
  for (const alias of ['letter_subject', 'document_title']) {
    if (!String(values[alias] ?? '').trim()) values[alias] = editorSubject;
  }
  for (const alias of ['letter_body', 'document_body']) {
    if (!String(values[alias] ?? '').trim()) values[alias] = editorBody;
  }
  const missing = (template?.fields || []).filter((f) => f.required && !String(values[f.name] ?? '').trim());
  if (missing.length) {
    // Highlight the exact fields blocking the save.
    document.querySelectorAll('#doc-letter-fields [data-doc-field]').forEach((el) => {
      const bad = missing.some((f) => f.name === el.dataset.docField);
      el.style.borderColor = bad ? '#ef4444' : '';
      if (bad) el.title = 'This field is required';
    });
    const first = document.querySelector('#doc-letter-fields [data-doc-field][style*="border-color"]');
    if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center' });
    throw new Error('Please fill required: ' + missing.map((f) => f.label).join(', '));
  } else {
    document.querySelectorAll('#doc-letter-fields [data-doc-field]').forEach((el) => { el.style.borderColor = ''; });
  }
  return {
    template_key: key,
    tenant_code: document.getElementById('doc-letter-tenant')?.value || null,
    values,
    title: document.getElementById('doc-letter-subject')?.value.trim() || null,
    recipient: document.getElementById('doc-letter-recipient')?.value || null,
    body: document.getElementById('doc-letter-body')?.value || null,
    status,
  };
}

async function saveDocLetterDraft() {
  setDocLetterStatus('Saving draft…');
  try {
    // Sender fields ride along inside values for resolution-free saves.
    const payload = gatherDocLetterPayload('Draft');
    const tenantCode = document.getElementById('doc-letter-tenant')?.value || null;
    const id = document.getElementById('doc-letter-id')?.value;
    let doc;
    if (id) {
      const res = await api.updateLetterDraft(id, {
        title: payload.title, body: payload.body, recipient: payload.recipient,
      });
      doc = res.document;
    } else {
      const res = await api.createLetter({ ...payload, tenant_code: tenantCode });
      doc = res.document;
      document.getElementById('doc-letter-id').value = doc?.id || '';
    }
    setDocLetterStatus(`Draft saved (#${doc?.id || '—'}).`);
    revealLetterInHub();
    loadDocuments();
  } catch (err) {
    setDocLetterStatus('Save failed: ' + (err.message || err), true);
  }
}

async function generateDocLetter() {
  setDocLetterStatus('Generating PDF…');
  try {
    const payload = gatherDocLetterPayload('Finalized');
    const id = document.getElementById('doc-letter-id')?.value;
    let doc;
    if (id) {
      // Persist latest edits to the draft first, then finalize it.
      await api.updateLetterDraft(id, {
        title: payload.title, body: payload.body, recipient: payload.recipient,
      });
      const res = await api.finalizeLetter(id);
      doc = res.document;
    } else {
      const res = await api.createLetter(payload);
      doc = res.document;
    }
    setDocLetterStatus(`Generated ${doc?.doc_number || ''} — saved to Documents Hub.`);
    document.getElementById('doc-letter-id').value = doc?.id || '';
    revealLetterInHub();
    loadDocuments();
    setTimeout(() => document.getElementById('doc-letter-modal')?.classList.add('hidden'), 1200);
  } catch (err) {
    setDocLetterStatus('Generate failed: ' + (err.message || err), true);
  }
}

document.getElementById('btn-documents-new')?.addEventListener('click', openDocTemplatePicker);
document.getElementById('btn-doc-template-close')?.addEventListener('click', () => {
  document.getElementById('doc-template-modal')?.classList.add('hidden');
});
document.getElementById('doc-template-grid')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-doc-template]');
  if (btn) openDocLetterEditor(btn.dataset.docTemplate);
});
document.getElementById('btn-doc-letter-close')?.addEventListener('click', () => {
  document.getElementById('doc-letter-modal')?.classList.add('hidden');
});
document.getElementById('btn-doc-letter-autofill')?.addEventListener('click', () => autofillDocLetter(true));
document.getElementById('doc-letter-tenant')?.addEventListener('change', () => {
  // Tenant (re)selected: refresh subject, recipient/house block and any
  // still-empty detail fields from that tenant's dashboard data.
  showToast('Loading tenant details…');
  autofillDocLetter(false);
});
document.getElementById('btn-doc-letter-preview')?.addEventListener('click', previewDocLetter);
document.getElementById('btn-doc-letter-batch')?.addEventListener('click', async () => {
  const key = document.getElementById('doc-letter-key')?.value;
  const propSel = document.getElementById('doc-letter-property');
  const paybill = propSel?.value || null;
  const propName = propSel?.options?.[propSel.selectedIndex]?.textContent?.trim() || '';
  if (!key || !paybill) {
    setDocLetterStatus('Select a template and a property first.', true);
    return;
  }
  if (!confirm(`Generate an individualized letter for EVERY occupying tenant of ${propName}?\n\nEach tenant gets their own finalized document (own number + PDF). This cannot be undone per letter — delete rows individually if needed.`)) return;
  setDocLetterStatus('Generating batch — this can take a while for large properties…');
  try {
    const r = await api.batchLetters({
      template_key: key,
      house_paybill_number: paybill,
      values: collectDocLetterValues(),
    });
    const failed = (r.results || []).filter((x) => !x.ok);
    setDocLetterStatus(`Batch done: ${r.succeeded}/${r.total} generated for ${r.property || propName}.` +
      (failed.length ? ` Failed: ${failed.map((x) => `${x.tenant_code || '?'} (${(x.error || '').slice(0, 60)})`).join('; ')}` : ''));
    loadDocuments();
  } catch (err) {
    setDocLetterStatus('Batch failed: ' + (err.message || err), true);
  }
});
document.getElementById('btn-doc-letter-draft')?.addEventListener('click', saveDocLetterDraft);
document.getElementById('btn-doc-letter-generate')?.addEventListener('click', generateDocLetter);
// After saving a letter, make sure the hub filter isn't hiding it
// (e.g. filtered to Receipts) so the new row is actually visible.
function revealLetterInHub() {
  const typeSel = document.getElementById('documents-type');
  if (typeSel && typeSel.value !== '' && typeSel.value !== 'letter') {
    typeSel.value = 'letter';
    showToast('Switched filter to Letters so your document is visible.');
  }
}

document.getElementById('doc-letter-body')?.addEventListener('input', () => { docBodyEdited = true; });
['doc-letter-subject', 'doc-letter-recipient', 'doc-letter-body'].forEach((id) => {
  document.getElementById(id)?.addEventListener('focus', () => { docPlaceholderTarget = id; });
});
document.getElementById('btn-doc-placeholder-insert')?.addEventListener('click', () => {
  const pick = document.getElementById('doc-placeholder-pick');
  const code = pick?.value;
  if (!code) return;
  const el = document.getElementById(docPlaceholderTarget) || document.getElementById('doc-letter-body');
  const token = `{{${code}}}`;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + token + el.value.slice(end);
  el.focus();
  try { el.setSelectionRange(start + token.length, start + token.length); } catch (_) {}
  el.dispatchEvent(new Event('input', { bubbles: true }));
  pick.value = '';
});

async function openDocDraftEditor(id) {
  try {
    const { document: doc } = await api.document(id);
    if (!doc) throw new Error('Document not found');
    if (doc.doc_type !== 'letter' || doc.status !== 'Draft') {
      alert('Only draft letters can be edited. Generate a new version for changes.');
      return;
    }
    if (!docLetterTemplates.length) {
      const { templates } = await api.docTemplates();
      docLetterTemplates = templates || [];
    }
    await openDocLetterEditor(doc.template_key, doc);
    // Restore frozen draft text (editor defaults would otherwise re-resolve).
    if (doc.title) document.getElementById('doc-letter-subject').value = doc.title;
    if (doc.resolved_recipient != null) document.getElementById('doc-letter-recipient').value = doc.resolved_recipient;
    if (doc.body_text != null) document.getElementById('doc-letter-body').value = doc.body_text;
    docBodyEdited = true;
    docResolvedTenant = doc.tenant_code || null;
    docLastSubject = document.getElementById('doc-letter-subject')?.value || '';
    docLastRecipient = document.getElementById('doc-letter-recipient')?.value || '';
  } catch (err) {
    alert('Cannot open draft: ' + (err.message || err));
  }
}

async function loadReceiptMode() {
  // Receipt numbers are now lifetime continuous (GEHPM-RCT-YYYYMM-NNNNNN).
  const el = document.getElementById('receipt-mode-label');
  if (el) el.remove();
}

document.getElementById('btn-receipt-mode-test')?.remove();
document.getElementById('btn-receipt-mode-prod')?.remove();

document.getElementById('btn-receipt-reset-test')?.remove();

document.getElementById('import-excel-input')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = async (event) => {
    const btn = document.getElementById('btn-import-tenant');
    try {
      const base64 = event.target.result;
      if (btn) {
        btn.textContent = 'Importing...';
        btn.disabled = true;
      }

      const h_id = currentView === 'house-dashboard' ? activeHouseId : null;
      const res = await api.importTenants(base64, h_id);
      
      let msg = `Import complete!\nSuccess: ${res.successCount}\nSkipped: ${res.skipCount}`;
      if (res.errors && res.errors.length) {
        msg += `\n\nErrors:\n${res.errors.join('\n')}`;
      }
      alert(msg);
      
      if (currentView === 'house-dashboard') {
        loadHouseDashboardPage(activeHouseId);
      } else {
        loadTenants();
      }
    } catch (err) {
      alert('Error importing: ' + err.message);
    } finally {
      if (btn) {
        btn.textContent = 'Import Excel';
        btn.disabled = false;
      }
      e.target.value = '';
    }
  };
  reader.readAsDataURL(file);
});

// ─── Company Settings — Official GEHPM Stamp (admin) ───────────────────────
let stampState = null;
let stampPreviewUrl = null;

function setStampMsg(text, isError) {
  const el = document.getElementById('stamp-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'text-sm font-mono text-center mt-2 ' + (isError ? 'text-rose-400' : 'text-green-400');
}

async function loadStampSettings() {
  const statusEl = document.getElementById('stamp-status');
  const img = document.getElementById('stamp-preview');
  const toggleBtn = document.getElementById('btn-stamp-toggle');
  if (!statusEl) return;
  setStampMsg('');
  statusEl.textContent = 'Loading…';
  try {
    const s = await api.stampStatus();
    stampState = s;
    if (!s.configured) {
      statusEl.innerHTML = '<span class="text-amber-400">No stamp uploaded yet.</span> Upload the official GEHPM stamp to start stamping finalized PDFs.';
    } else {
      statusEl.innerHTML =
        `<span class="${s.active ? 'text-green-400' : 'text-amber-400'} font-bold">${s.active ? 'ACTIVE' : 'INACTIVE'}</span>` +
        ` <span class="text-slate-500">${escapeHtml(s.original_name || s.mimetype || '')}</span>` +
        (s.updated_at ? ` <span class="text-slate-500">· ${escapeHtml(new Date(s.updated_at).toLocaleString())}</span>` : '') +
        (s.updated_by ? ` <span class="text-slate-500">· by ${escapeHtml(s.updated_by)}</span>` : '');
    }
    if (img) {
      if (stampPreviewUrl) { URL.revokeObjectURL(stampPreviewUrl); stampPreviewUrl = null; }
      if (s.configured && s.active) {
        try {
          const blob = await api.stampImageBlob();
          stampPreviewUrl = URL.createObjectURL(blob);
          img.src = stampPreviewUrl;
          img.classList.remove('hidden');
        } catch (_) {
          img.classList.add('hidden');
        }
      } else {
        img.classList.add('hidden');
      }
    }
    if (toggleBtn) {
      toggleBtn.textContent = s.active ? 'Deactivate' : 'Activate';
      toggleBtn.disabled = !s.configured;
    }
  } catch (err) {
    statusEl.textContent = 'Failed to load stamp status: ' + (err.message || err);
  }
}

document.getElementById('btn-stamp-upload')?.addEventListener('click', async () => {
  const input = document.getElementById('stamp-file');
  const file = input?.files?.[0];
  if (!file) return setStampMsg('Choose a PNG or JPEG file first.', true);
  setStampMsg('Uploading stamp…');
  try {
    const form = new FormData();
    form.append('file', file);
    await api.uploadStamp(form);
    input.value = '';
    setStampMsg('Stamp saved and activated — future finalized PDFs will carry it.');
    showToast('Official stamp uploaded and activated.');
    await loadStampSettings();
  } catch (err) {
    setStampMsg('Upload failed: ' + (err.message || err), true);
  }
});

document.getElementById('btn-stamp-toggle')?.addEventListener('click', async () => {
  if (!stampState?.configured) return;
  const to = !stampState.active;
  setStampMsg((to ? 'Activating' : 'Deactivating') + ' stamp…');
  try {
    await api.setStampActive(to);
    setStampMsg(to ? 'Stamp activated.' : 'Stamp deactivated — finalized PDFs will not carry it.');
    await loadStampSettings();
  } catch (err) {
    setStampMsg('Failed: ' + (err.message || err), true);
  }
});

document.getElementById('btn-stamp-delete')?.addEventListener('click', async () => {
  if (!stampState?.configured) return setStampMsg('Nothing to remove.', true);
  if (!confirm('Remove the official stamp completely? Finalized PDFs will no longer carry it.')) return;
  try {
    await api.deleteStamp();
    setStampMsg('Stamp removed.');
    await loadStampSettings();
  } catch (err) {
    setStampMsg('Failed: ' + (err.message || err), true);
  }
});

// ─── Payment Arrangement (management-only; never tenant-visible) ────────────
let tdArrCode = null;
let tdArrActiveId = null;

const tdArrMsg = (text, isError) => {
  const el = document.getElementById('td-arr-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'text-xs font-mono text-center mt-2 ' + (isError ? 'text-rose-400' : 'text-green-400');
};

async function loadTenantArrangements(code) {
  tdArrCode = code;
  tdArrActiveId = null;
  const body = document.getElementById('td-arr-body');
  const badge = document.getElementById('td-arr-status');
  const histWrap = document.getElementById('td-arr-history-wrap');
  const histBody = document.getElementById('td-arr-history-tbody');
  if (!body) return;
  body.textContent = 'Loading…';
  if (badge) { badge.textContent = '…'; badge.className = 'font-mono text-xs font-bold text-slate-400'; }
  if (histWrap) histWrap.classList.add('hidden');
  tdArrMsg('');
  try {
    const { arrangements, active } = await api.arrangements(code);
    const money = (n) => `KES ${Number(n || 0).toLocaleString()}`;
    const badgeFor = (s) => {
      if (s === 'Approved') return 'text-green-400';
      if (s === 'Fulfilled') return 'text-emerald-300';
      if (s === 'Partially Paid') return 'text-amber-400';
      if (s === 'Pending') return 'text-cyan-400';
      if ((s || '').startsWith('Overdue')) return 'text-rose-400';
      return 'text-slate-400';
    };
    if (!active) {
      if (badge) { badge.textContent = 'NONE'; badge.className = 'font-mono text-xs font-bold text-slate-400'; }
      body.innerHTML = '<span class="text-slate-500">Normal Rent Due Date governs. No arrangement in effect — fill the dates below to record one.</span>';
    } else {
      tdArrActiveId = active.id;
      if (badge) { badge.textContent = (active.display_status || active.status).toUpperCase(); badge.className = `font-mono text-xs font-bold ${badgeFor(active.display_status || active.status)}`; }
      body.innerHTML =
        `<div class="grid grid-cols-2 md:grid-cols-4 gap-2">` +
        `<div>Normal Due Date<br><span class="text-slate-200">${escapeHtml(active.normal_due_date || '—')}</span></div>` +
        `<div>Approved Pay Date<br><span class="text-green-300">${escapeHtml(active.approved_date ? String(active.approved_date).slice(0, 10) : '—')}</span></div>` +
        `<div>Actual Pay Date<br><span class="text-slate-200">${escapeHtml(active.actual_payment_date || 'Pending')}</span></div>` +
        `<div>Status<br><span class="${badgeFor(active.display_status || active.status)}">${escapeHtml(active.display_status || active.status)}</span></div>` +
        `<div>Rent (${escapeHtml(active.billing_period || '')})<br><span class="text-slate-200">${money(active.rent_amount)}</span></div>` +
        `<div>Paid<br><span class="text-slate-200">${money(active.amount_paid)}</span></div>` +
        `<div>Outstanding<br><span class="text-rose-300">${money(active.outstanding)}</span></div>` +
        `<div>Notes<br><span class="text-slate-500">${escapeHtml((active.reason || '—').slice(0, 80))}</span></div>` +
        `</div>`;
      const req = document.getElementById('td-arr-requested');
      const app = document.getElementById('td-arr-approved');
      const rsn = document.getElementById('td-arr-reason');
      if (req && !req.value && active.requested_date) req.value = String(active.requested_date).slice(0, 10);
      if (app && !app.value && active.approved_date) app.value = String(active.approved_date).slice(0, 10);
      if (rsn && !rsn.value && active.reason) rsn.value = active.reason;
    }
    if (histWrap && histBody) {
      if ((arrangements || []).length) {
        histWrap.classList.remove('hidden');
        histBody.innerHTML = arrangements.map((a) => `
          <tr>
            <td class="font-mono text-xs">${escapeHtml(a.billing_period || '')}</td>
            <td class="font-mono text-xs">${escapeHtml(a.requested_date ? String(a.requested_date).slice(0, 10) : '—')}</td>
            <td class="font-mono text-xs">${escapeHtml(a.approved_date ? String(a.approved_date).slice(0, 10) : '—')}</td>
            <td class="font-mono text-xs">${a.actual_payment_date ? `${escapeHtml(a.actual_payment_date)} · ${money(a.amount_paid)}` : 'Pending'}</td>
            <td class="font-mono text-xs ${badgeFor(a.display_status || a.status)}">${escapeHtml(a.display_status || a.status)}</td>
          </tr>`).join('');
      } else {
        histWrap.classList.add('hidden');
      }
    }
  } catch (err) {
    body.textContent = 'Failed to load arrangements: ' + (err.message || err);
    // Unknown tenant: drop the linkage so Save/Approve can never file
    // against a stale or truncated code. Transient errors keep it.
    if (/not found/i.test(err.message || '')) tdArrCode = null;
  }
}

function tdArrForm() {
  return {
    requested_date: document.getElementById('td-arr-requested')?.value || null,
    approved_date: document.getElementById('td-arr-approved')?.value || null,
    reason: document.getElementById('td-arr-reason')?.value.trim() || null,
  };
}

document.getElementById('btn-td-arr-save')?.addEventListener('click', async () => {
  if (!tdArrCode) return;
  tdArrMsg('Saving…');
  try {
    const f = tdArrForm();
    await api.createArrangement({ tenant_code: tdArrCode, ...f });
    tdArrMsg('Arrangement saved as Pending.');
    await loadTenantArrangements(tdArrCode);
  } catch (err) { tdArrMsg('Save failed: ' + (err.message || err), true); }
});

document.getElementById('btn-td-arr-approve')?.addEventListener('click', async () => {
  if (!tdArrCode) return;
  tdArrMsg('Approving…');
  try {
    const f = tdArrForm();
    let id = tdArrActiveId;
    if (!id) {
      const created = await api.createArrangement({ tenant_code: tdArrCode, ...f });
      id = created.arrangement.id;
    }
    await api.approveArrangement(id, { approved_date: f.approved_date, reason: f.reason });
    tdArrMsg('Arrangement APPROVED.');
    await loadTenantArrangements(tdArrCode);
  } catch (err) { tdArrMsg('Approve failed: ' + (err.message || err), true); }
});

document.getElementById('btn-td-arr-modify')?.addEventListener('click', async () => {
  if (!tdArrActiveId) return tdArrMsg('No active arrangement to modify.', true);
  tdArrMsg('Modifying…');
  try {
    const f = tdArrForm();
    await api.modifyArrangement(tdArrActiveId, f);
    tdArrMsg('Arrangement modified (change logged).');
    await loadTenantArrangements(tdArrCode);
  } catch (err) { tdArrMsg('Modify failed: ' + (err.message || err), true); }
});

document.getElementById('btn-td-arr-decline')?.addEventListener('click', async () => {
  if (!tdArrActiveId) return tdArrMsg('No active arrangement to decline.', true);
  try {
    await api.declineArrangement(tdArrActiveId, { reason: tdArrForm().reason });
    tdArrMsg('Arrangement declined.');
    await loadTenantArrangements(tdArrCode);
  } catch (err) { tdArrMsg('Decline failed: ' + (err.message || err), true); }
});

document.getElementById('btn-td-arr-cancel')?.addEventListener('click', async () => {
  if (!tdArrActiveId) return tdArrMsg('No active arrangement to cancel.', true);
  if (!confirm('Cancel this payment arrangement? The record is kept for audit.')) return;
  try {
    await api.cancelArrangement(tdArrActiveId, { reason: tdArrForm().reason });
    tdArrMsg('Arrangement cancelled.');
    await loadTenantArrangements(tdArrCode);
  } catch (err) { tdArrMsg('Cancel failed: ' + (err.message || err), true); }
});

document.getElementById('btn-td-arr-expire')?.addEventListener('click', async () => {
  if (!tdArrActiveId) return tdArrMsg('No active arrangement to expire.', true);
  try {
    await api.expireArrangement(tdArrActiveId, { reason: tdArrForm().reason });
    tdArrMsg('Arrangement expired.');
    await loadTenantArrangements(tdArrCode);
  } catch (err) { tdArrMsg('Expire failed: ' + (err.message || err), true); }
});

// ─── Company Settings — Authorized Signature (admin) ───────────────────────
let sigState = null;
let sigPreviewUrl = null;

function setSigMsg(text, isError) {
  const el = document.getElementById('sig-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'text-sm font-mono text-center mt-2 ' + (isError ? 'text-rose-400' : 'text-green-400');
}

async function loadSignatureSettings() {
  const statusEl = document.getElementById('sig-status');
  const img = document.getElementById('sig-preview');
  const toggleBtn = document.getElementById('btn-sig-toggle');
  const holderInput = document.getElementById('sig-holder');
  if (!statusEl) return;
  setSigMsg('');
  statusEl.textContent = 'Loading…';
  try {
    const s = await api.signatureStatus();
    sigState = s;
    if (!s.configured) {
      statusEl.innerHTML = '<span class="text-amber-400">No signature uploaded yet.</span> Letters will show the generating user as signatory.';
    } else {
      statusEl.innerHTML =
        `<span class="${s.active ? 'text-green-400' : 'text-amber-400'} font-bold">${s.active ? 'ACTIVE' : 'INACTIVE'}</span>` +
        ` <span class="text-slate-200">${escapeHtml(s.holder_name || '—')}</span>` +
        (s.updated_at ? ` <span class="text-slate-500">· ${escapeHtml(new Date(s.updated_at).toLocaleString())}</span>` : '');
    }
    if (holderInput && !holderInput.value && s.holder_name) holderInput.value = s.holder_name;
    if (img) {
      if (sigPreviewUrl) { URL.revokeObjectURL(sigPreviewUrl); sigPreviewUrl = null; }
      if (s.configured && s.active) {
        try {
          const blob = await api.signatureImageBlob();
          sigPreviewUrl = URL.createObjectURL(blob);
          img.src = sigPreviewUrl;
          img.classList.remove('hidden');
        } catch (_) {
          img.classList.add('hidden');
        }
      } else {
        img.classList.add('hidden');
      }
    }
    if (toggleBtn) {
      toggleBtn.textContent = s.active ? 'Deactivate' : 'Activate';
      toggleBtn.disabled = !s.configured;
    }
  } catch (err) {
    statusEl.textContent = 'Failed to load signature status: ' + (err.message || err);
  }
}

document.getElementById('btn-sig-upload')?.addEventListener('click', async () => {
  const fileInput = document.getElementById('sig-file');
  const file = fileInput?.files?.[0];
  const holder = document.getElementById('sig-holder')?.value.trim() || '';
  if (!file) return setSigMsg('Choose a PNG or JPEG file first.', true);
  if (!holder) return setSigMsg('Enter the signature holder name first.', true);
  setSigMsg('Uploading signature…');
  try {
    const form = new FormData();
    form.append('file', file);
    form.append('holder_name', holder);
    await api.uploadSignature(form);
    fileInput.value = '';
    setSigMsg('Signature saved and assigned — letter downloads will carry it.');
    showToast('Authorized signature uploaded and assigned.');
    await loadSignatureSettings();
  } catch (err) {
    setSigMsg('Upload failed: ' + (err.message || err), true);
  }
});

document.getElementById('btn-sig-save-name')?.addEventListener('click', async () => {
  const holder = document.getElementById('sig-holder')?.value.trim() || '';
  if (!holder) return setSigMsg('Enter the signature holder name first.', true);
  setSigMsg('Saving holder name…');
  try {
    await api.patchSignature({ holder_name: holder });
    setSigMsg('Holder name saved.');
    await loadSignatureSettings();
  } catch (err) {
    setSigMsg('Save failed: ' + (err.message || err), true);
  }
});

document.getElementById('btn-sig-toggle')?.addEventListener('click', async () => {
  if (!sigState?.configured) return;
  const to = !sigState.active;
  setSigMsg((to ? 'Activating' : 'Deactivating') + ' signature…');
  try {
    await api.patchSignature({ active: to });
    setSigMsg(to ? 'Signature activated.' : 'Signature deactivated — letters fall back to the generating user.');
    await loadSignatureSettings();
  } catch (err) {
    setSigMsg('Failed: ' + (err.message || err), true);
  }
});

document.getElementById('btn-sig-delete')?.addEventListener('click', async () => {
  if (!sigState?.configured) return setSigMsg('Nothing to remove.', true);
  if (!confirm('Remove the authorized signature completely? Letter downloads will no longer carry it.')) return;
  try {
    await api.deleteSignature();
    setSigMsg('Signature removed.');
    await loadSignatureSettings();
  } catch (err) {
    setSigMsg('Failed: ' + (err.message || err), true);
  }
});

async function loadUsers() {
  try {
    const { users } = await api.users();
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;
    tbody.innerHTML = users.map(u => `
      <tr>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.display_name || '-')}</td>
        <td><span class="sys-tag">[${u.role.toUpperCase()}]</span></td>
        <td>
          <span class="${u.is_active ? 'text-green-400' : 'text-rose-400'} font-mono text-sm">
            ${u.is_active ? 'ACTIVE' : 'INACTIVE'}
          </span>
        </td>
        <td class="font-mono text-xs">${u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never'}</td>
        <td class="text-right">
          <button type="button" class="qc-btn text-xs mr-2" data-edit-user='${escapeHtml(JSON.stringify(u))}'>Edit</button>
          <button type="button" class="qc-btn qc-btn-danger text-xs" data-delete-user="${u.id}">Delete</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    alert('Failed to load users: ' + err.message);
  }
}

document.getElementById('btn-add-user')?.addEventListener('click', () => {
  document.getElementById('user-id').value = '';
  document.getElementById('user-form').reset();
  document.getElementById('user-username').disabled = false;
  document.getElementById('user-modal-title').textContent = 'Add User';
  document.getElementById('user-modal').classList.remove('hidden');
});

document.getElementById('btn-user-cancel')?.addEventListener('click', () => {
  document.getElementById('user-modal').classList.add('hidden');
});

document.getElementById('users-tbody')?.addEventListener('click', async (e) => {
  if (e.target.dataset.editUser) {
    const u = JSON.parse(e.target.dataset.editUser);
    document.getElementById('user-id').value = u.id;
    document.getElementById('user-username').value = u.username;
    document.getElementById('user-username').disabled = true;
    document.getElementById('user-display-name').value = u.display_name || '';
    document.getElementById('user-role').value = u.role;
    document.getElementById('user-is-active').checked = u.is_active;
    document.getElementById('user-password').value = '';
    document.getElementById('user-modal-title').textContent = 'Edit User';
    document.getElementById('user-modal').classList.remove('hidden');
  } else if (e.target.dataset.deleteUser) {
    if (confirm('Are you sure you want to completely delete this user account?')) {
      try {
        await api.deleteUser(e.target.dataset.deleteUser);
        loadUsers();
      } catch (err) {
        alert(err.message);
      }
    }
  }
});

document.getElementById('user-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('btn-save-user');
  const errEl = document.getElementById('user-error');
  btn.disabled = true;
  errEl.classList.add('hidden');

  const id = document.getElementById('user-id').value;
  const data = {
    username: document.getElementById('user-username').value.trim(),
    display_name: document.getElementById('user-display-name').value.trim(),
    role: document.getElementById('user-role').value,
    is_active: document.getElementById('user-is-active').checked,
    password: document.getElementById('user-password').value
  };

  try {
    if (id) {
      await api.updateUser(id, data);
    } else {
      await api.createUser(data);
    }
    document.getElementById('user-modal').classList.add('hidden');
    loadUsers();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

// PWA Install
let deferredInstallPrompt = null;
const installBtn = document.getElementById('btn-install-pwa');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      alert('Open this app in Chrome or Samsung Internet, then use the browser menu to "Add to Home Screen".');
      return;
    }
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      deferredInstallPrompt = null;
    }
  });
}

// ===== Invoice Register & Archive =====
let irExitMode = false;
let irViewId = null;
let irShareId = null;

function irTypeLabel(type) {
  return {
    rent: 'Rent',
    maintenance: 'Maintenance',
    penalty: 'Penalty',
    exit: 'Exit',
    other: 'Other',
  }[type] || (type || 'Invoice');
}

function irStatusClass(status) {
  if (status === 'Downloaded & Sent') return 'badge-sent';
  if (status === 'Sent via WhatsApp') return 'badge-delivered';
  if (status === 'Downloaded') return 'badge-active';
  return 'badge-pending';
}

function irRegisterBadge(status) {
  return `<span class="status-badge ${irStatusClass(status)}"><span class="status-dot"></span>${escapeHtml(status || 'Generated')}</span>`;
}

// ---- Monthly Reports ----------------------------------------------------
const FULL_MONTHS_MR = ['January','February','March','April','May','June','July','August','September','October','November','December'];

async function loadMonthlyReports() {
  const sel = document.getElementById('mr-month-select');
  if (!sel) return;
  try {
    const { reports } = await api.listMonthlyReports();
    window._mrReports = reports;
    const existing = sel.value;
    const seen = new Set();
    sel.innerHTML = '<option value="">Select month...</option>';
    (reports || []).forEach(r => {
      if (seen.has(r.month)) return;
      seen.add(r.month);
      const opt = document.createElement('option');
      opt.value = r.month;
      const [y, m] = r.month.split('-');
      opt.textContent = `${FULL_MONTHS_MR[parseInt(m, 10) - 1]} ${y}`;
      sel.appendChild(opt);
    });
    if (existing) sel.value = existing;
  } catch (err) {
    sel.innerHTML = '<option value="">Failed to load</option>';
  }

  const propSel = document.getElementById('mr-property-select');
  if (propSel && propSel.options.length <= 1) {
    try {
      const { houses } = await api.houses();
      propSel.innerHTML = '<option value="">All Properties</option>';
      (houses || []).forEach(h => {
        const opt = document.createElement('option');
        opt.value = h.paybill_number;
        opt.textContent = h.house_name;
        propSel.appendChild(opt);
      });
    } catch (_) {}
  }
}

async function loadReportData(month) {
  const view = document.getElementById('mr-report-view');
  const empty = document.getElementById('mr-empty');
  if (!month) { if (view) view.classList.add('hidden'); if (empty) empty.classList.remove('hidden'); return; }
  try {
    const housePaybill = document.getElementById('mr-property-select')?.value || '';
    const { report } = await api.getMonthlyReport(month, housePaybill || undefined);
    const data = typeof report.report_data === 'string' ? JSON.parse(report.report_data) : report.report_data;
    if (view) view.classList.remove('hidden');
    if (empty) empty.classList.add('hidden');

    const money = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });
    const rev = data.revenue || {};
    const mnt = data.maintenance || {};

    document.getElementById('mr-revenue').textContent = money(rev.total_collected);
    document.getElementById('mr-revenue-count').textContent = `${rev.payment_count || 0} payments`;
    document.getElementById('mr-expenses').textContent = money(mnt.total_expenses);
    document.getElementById('mr-expenses-detail').textContent = `Mat: ${money(mnt.total_material_costs)} | Labour: ${money(mnt.total_labour_costs)}`;
    document.getElementById('mr-outstanding').textContent = money(mnt.outstanding_recovery);
    document.getElementById('mr-recovery-detail').textContent = `Recovered: ${money(mnt.recovered_from_tenants)} of ${money(mnt.tenant_responsible_repairs)}`;

    // Management expenses table
    const mgmtTbody = document.getElementById('mr-mgmt-tbody');
    const mgmt = data.management_expenses || [];
    mgmtTbody.innerHTML = mgmt.length ? mgmt.map(e => `<tr>
      <td class="font-mono">${escapeHtml(e.wo_number || '')}</td><td>${e.issue_no || ''}</td>
      <td>${escapeHtml(e.unit || '')}</td><td>${escapeHtml(e.problem || '')}</td>
      <td class="text-right">${money(e.material_cost)}</td><td class="text-right">${money(e.labour_cost)}</td>
      <td class="text-right font-semibold">${money(e.total_cost)}</td>
      <td>${escapeHtml(e.responsible_party || '')}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="text-center text-slate-500 py-4">No management expenses this month</td></tr>';

    // Tenant recoveries table
    const tenantTbody = document.getElementById('mr-tenant-tbody');
    const tenant = data.tenant_recoveries || [];
    tenantTbody.innerHTML = tenant.length ? tenant.map(e => `<tr>
      <td class="font-mono">${escapeHtml(e.wo_number || '')}</td><td>${e.issue_no || ''}</td>
      <td>${escapeHtml(e.unit || '')}</td><td>${escapeHtml(e.tenant || '')}</td>
      <td>${escapeHtml(e.problem || '')}</td><td class="text-right">${money(e.total_cost)}</td>
      <td class="text-right">${money(e.amount_recovered)}</td>
      <td class="text-right">${money(e.total_cost - e.amount_recovered)}</td>
      <td><span class="status-badge ${e.recovery_status === 'Paid' ? 'badge-active' : 'badge-pending'}">${escapeHtml(e.recovery_status || '')}</span></td>
    </tr>`).join('') : '<tr><td colspan="9" class="text-center text-slate-500 py-4">No tenant recoveries this month</td></tr>';

    // Summary grid
    document.getElementById('mr-summary-grid').innerHTML = `
      <div><span class="text-slate-400">Total Repairs:</span> <span class="font-mono">${money(mnt.total_expenses)}</span></div>
      <div><span class="text-slate-400">Mgmt Paid:</span> <span class="font-mono">${money(mnt.management_paid_repairs)}</span></div>
      <div><span class="text-slate-400">Tenant Responsible:</span> <span class="font-mono">${money(mnt.tenant_responsible_repairs)}</span></div>
      <div><span class="text-slate-400">Recovered:</span> <span class="font-mono">${money(mnt.recovered_from_tenants)}</span></div>
      <div><span class="text-slate-400">Outstanding:</span> <span class="font-mono">${money(mnt.outstanding_recovery)}</span></div>
      <div><span class="text-slate-400">Material Costs:</span> <span class="font-mono">${money(mnt.total_material_costs)}</span></div>
      <div><span class="text-slate-400">Labour Costs:</span> <span class="font-mono">${money(mnt.total_labour_costs)}</span></div>
      <div><span class="text-slate-400">Charges Raised:</span> <span class="font-mono">${money(mnt.charges_raised)}</span></div>
    `;

    // Property / Unit Performance
    const occ = data.occupancy || {};
    document.getElementById('mr-occupied').textContent = occ.occupied || 0;
    document.getElementById('mr-vacant').textContent = occ.vacant || 0;
    document.getElementById('mr-new-tenants').textContent = occ.new_tenants || 0;
    document.getElementById('mr-exiting').textContent = occ.exiting_tenants || 0;
    document.getElementById('mr-paid-count').textContent = occ.paid_count || 0;
    document.getElementById('mr-partial-count').textContent = occ.partial_count || 0;
    document.getElementById('mr-unpaid-count').textContent = occ.unpaid_count || 0;
    document.getElementById('mr-collection-pct').textContent = (occ.collection_pct || 0) + '%';

    // Penalties
    const penalties = data.penalties || [];
    document.getElementById('mr-penalty-summary').innerHTML = `
      <div><span class="text-slate-400">Total Penalties:</span> <span class="font-mono">${money(penalties.reduce((s, p) => s + Number(p.amount || 0), 0))}</span></div>
      <div><span class="text-slate-400">Paid:</span> <span class="font-mono text-green-400">${money(penalties.filter(p => p.status === 'Paid').reduce((s, p) => s + Number(p.amount || 0), 0))}</span></div>
      <div><span class="text-slate-400">Outstanding:</span> <span class="font-mono text-rose-400">${money(penalties.filter(p => p.status !== 'Paid').reduce((s, p) => s + Number(p.amount || 0), 0))}</span></div>
    `;
    document.getElementById('mr-penalties-tbody').innerHTML = penalties.length ? penalties.map(p => `<tr>
      <td>${escapeHtml(p.tenant_name || '')}</td>
      <td>${escapeHtml(p.description || '')}</td>
      <td>${escapeHtml(p.category || '')}</td>
      <td class="text-right font-mono">${money(p.amount)}</td>
      <td><span class="status-badge ${p.status === 'Paid' ? 'badge-active' : 'badge-pending'}">${escapeHtml(p.status || '')}</span></td>
    </tr>`).join('') : '<tr><td colspan="5" class="text-center text-slate-500 py-4">No penalties this month</td></tr>';

    // Exit Invoices
    const exits = data.exit_invoices || [];
    document.getElementById('mr-exit-summary').innerHTML = exits.length
      ? `<span class="text-slate-400">${exits.length} exit invoice(s) finalized this month</span>`
      : '';
    document.getElementById('mr-exits-tbody').innerHTML = exits.length ? exits.map(e => `<tr>
      <td class="font-mono text-xs">${escapeHtml(e.exit_number || '')}</td>
      <td>${escapeHtml(e.tenant_name || '')}</td>
      <td>${escapeHtml(e.unit_label || '')}</td>
      <td>${escapeHtml(e.rent_treatment || '')}</td>
      <td class="text-right font-mono">${money(e.deductions_total)}</td>
      <td class="text-right font-mono">${money(e.deposit_refund)}</td>
      <td class="text-right font-mono font-semibold">${money(e.final_settlement)}</td>
      <td><span class="status-badge ${e.status === 'Finalized' ? 'badge-active' : 'badge-pending'}">${escapeHtml(e.status || '')}</span></td>
    </tr>`).join('') : '<tr><td colspan="8" class="text-center text-slate-500 py-4">No exit invoices this month</td></tr>';

    // Notices to Vacate
    const notices = data.notices_to_vacate || [];
    document.getElementById('mr-notices-summary').innerHTML = notices.length
      ? `<span class="text-slate-400">${notices.length} tenant(s) gave notice this month</span>`
      : '';
    document.getElementById('mr-notices-tbody').innerHTML = notices.length ? notices.map(n => `<tr>
      <td>${escapeHtml(n.tenant_name || '')}</td>
      <td>${escapeHtml(n.tenant_code || '')}</td>
      <td class="font-mono text-xs">${escapeHtml(n.notice_date || '')}</td>
      <td class="font-mono text-xs">${escapeHtml(n.expected_vacate || '')}</td>
      <td><span class="status-badge badge-pending">${escapeHtml(n.status || '')}</span></td>
    </tr>`).join('') : '<tr><td colspan="5" class="text-center text-slate-500 py-4">No notices to vacate this month</td></tr>';

  } catch (err) {
    if (view) view.classList.add('hidden');
    if (empty) { empty.classList.remove('hidden'); empty.textContent = 'No report found for this month. Run monthly rollover first.'; }
  }
}

document.getElementById('mr-month-select')?.addEventListener('change', (e) => {
  if (_currentMrView === 'enhanced') loadEnhancedReport(e.target.value);
  else if (_currentMrView === 'water') loadWaterBillReport();
  else loadReportData(e.target.value);
});
document.getElementById('mr-property-select')?.addEventListener('change', () => {
  const month = document.getElementById('mr-month-select')?.value;
  if (month) {
    if (_currentMrView === 'enhanced') loadEnhancedReport(month);
    else if (_currentMrView === 'water') loadWaterBillReport();
    else loadReportData(month);
  }
});
// Hook into existing refresh handler to support enhanced view
document.getElementById('btn-refresh-report')?.addEventListener('click', async () => {
  const month = document.getElementById('mr-month-select')?.value;
  if (!month) return;
  if (_currentMrView === 'enhanced') { await loadEnhancedReport(month); return; }
  if (_currentMrView === 'water') { await loadWaterBillReport(); return; }
  const housePaybill = document.getElementById('mr-property-select')?.value || '';
  try {
    await api.refreshMonthlyReport(month, housePaybill || undefined);
    await loadReportData(month);
  } catch (err) { alert(err.message); }
});

document.getElementById('btn-download-standard-report')?.addEventListener('click', async () => {
  const month = document.getElementById('mr-month-select')?.value;
  const housePaybill = document.getElementById('mr-property-select')?.value || '';
  if (!month) return;
  try {
    const result = await api.downloadMonthlyReport(month, housePaybill || undefined);
    if (result.blob) triggerFileDownload(result);
  } catch (err) { alert(err.message); }
});

// ─── Enhanced Monthly Report ─────────────────────────────────────────────────
let _currentMrView = 'standard';

document.getElementById('btn-mr-standard')?.addEventListener('click', () => switchMrView('standard'));
document.getElementById('btn-mr-enhanced')?.addEventListener('click', () => switchMrView('enhanced'));
document.getElementById('btn-mr-water')?.addEventListener('click', () => switchMrView('water'));

// ─── Water Bill Report (read-only reporting over recorded invoices) ───────

async function loadWaterBillReport() {
  const standardView = document.getElementById('mr-report-view');
  const enhancedView = document.getElementById('mr-enhanced-view');
  const waterView = document.getElementById('mr-water-view');
  const empty = document.getElementById('mr-empty');
  const tbody = document.getElementById('mr-water-tbody');
  const tfoot = document.getElementById('mr-water-tfoot');
  const summary = document.getElementById('mr-water-summary');
  const resEl = document.getElementById('mr-water-result');
  const month = document.getElementById('mr-month-select')?.value;
  const housePaybill = document.getElementById('mr-property-select')?.value || '';
  const unit = document.getElementById('mr-water-unit')?.value.trim() || null;
  if (standardView) standardView.classList.add('hidden');
  if (enhancedView) enhancedView.classList.add('hidden');
  if (!month || !housePaybill) {
    if (waterView) waterView.classList.remove('hidden');
    if (empty) empty.classList.add('hidden');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="text-center text-slate-500 py-4">Select a billing month and a specific property above, then press Generate Report.</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    if (resEl) resEl.textContent = 'Select a billing month and a specific property first.';
    return;
  }
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="text-center text-slate-500 py-4">Loading water bill report…</td></tr>';
  try {
    const { report } = await api.getWaterBillReport({ house_paybill: housePaybill, billing_month: month, unit });
    if (waterView) waterView.classList.remove('hidden');
    if (empty) empty.classList.add('hidden');
    const money = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });
    const rows = report.rows || [];
    if (tbody) {
      tbody.innerHTML = rows.length ? rows.map((r) => {
        const vacant = r.occupancy === 'Vacant';
        const note = vacant && r.usage_note ? `<div class="text-[10px] italic text-amber-400">${escapeHtml(r.usage_note)}</div>` : '';
        return `<tr class="${vacant ? 'opacity-60' : ''}">
          <td class="font-mono font-semibold">${escapeHtml(r.unit || '')}</td>
          <td>${vacant ? '—' : escapeHtml(r.tenant_name || '')}</td>
          <td>${vacant ? `<span class="text-slate-400">Vacant</span>${note}` : '<span class="text-green-400">Occupied</span>'}</td>
          <td class="text-right font-mono">${Number(r.previous_reading || 0).toFixed(1)}</td>
          <td class="text-right font-mono">${Number(r.current_reading || 0).toFixed(1)}</td>
          <td class="text-right font-mono font-semibold">${Number(r.consumption || 0).toFixed(1)}</td>
          <td class="text-right font-mono">${Number(r.rate_per_unit || 0).toFixed(2)}</td>
          <td class="text-right font-mono font-semibold">${money(r.water_charge)}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="8" class="text-center text-slate-500 py-4">No units found for this property.</td></tr>';
    }
    const t = report.totals || {};
    if (tfoot) {
      tfoot.innerHTML = `<tr class="font-bold border-t-2 border-slate-600">
        <td colspan="5" class="text-right">TOTALS (${t.total_units || 0} units · ${t.occupied_units || 0} occupied · ${t.vacant_units || 0} vacant)</td>
        <td class="text-right font-mono">${Number(t.total_consumption || 0).toFixed(1)}</td>
        <td></td>
        <td class="text-right font-mono text-green-400">${money(t.total_water_charges)}</td>
      </tr>`;
    }
    if (summary) {
      const card = (label, val, cls) => `<div class="p-3 bg-slate-800/50 rounded-lg border border-slate-700"><p class="text-xs text-slate-400 uppercase font-bold mb-1">${label}</p><p class="text-xl font-bold ${cls}">${val}</p></div>`;
      summary.innerHTML =
        card('Billing month', escapeHtml(report.billing_month_label || ''), 'text-white') +
        card('Units (occ/vac)', `${t.total_units || 0} (${t.occupied_units || 0}/${t.vacant_units || 0})`, 'text-cyan-400') +
        card('Consumption', `${Number(t.total_consumption || 0).toFixed(1)} units`, 'text-white') +
        card('Water rate', `KES ${Number(report.water_rate || 0).toFixed(2)}`, 'text-white') +
        card('Total charges', money(t.total_water_charges), 'text-green-400');
    }
    if (resEl) resEl.textContent = `${rows.length} unit(s) · ${report.property_name || ''} · ${report.billing_month_label || ''}`;
  } catch (err) {
    if (waterView) waterView.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    if (resEl) resEl.textContent = 'Error: ' + (err.message || err);
  }
}

document.getElementById('btn-generate-water-report')?.addEventListener('click', loadWaterBillReport);

document.getElementById('btn-download-water-report')?.addEventListener('click', async () => {
  const month = document.getElementById('mr-month-select')?.value;
  const housePaybill = document.getElementById('mr-property-select')?.value || '';
  const unit = document.getElementById('mr-water-unit')?.value.trim() || null;
  const resEl = document.getElementById('mr-water-result');
  if (!month || !housePaybill) { if (resEl) resEl.textContent = 'Select a billing month and a specific property first.'; return; }
  try {
    if (resEl) resEl.textContent = 'Generating PDF…';
    const result = await api.downloadWaterBillReport({ house_paybill: housePaybill, billing_month: month, unit });
    if (result.blob) triggerFileDownload(result);
    if (resEl) resEl.textContent = 'PDF downloaded.';
  } catch (err) {
    if (resEl) resEl.textContent = 'Download failed: ' + (err.message || err);
  }
});

document.getElementById('btn-send-water-report')?.addEventListener('click', async () => {
  const month = document.getElementById('mr-month-select')?.value;
  const housePaybill = document.getElementById('mr-property-select')?.value || '';
  const unit = document.getElementById('mr-water-unit')?.value.trim() || null;
  const resEl = document.getElementById('mr-water-result');
  if (!month || !housePaybill) { if (resEl) resEl.textContent = 'Select a billing month and a specific property first.'; return; }
  const phone = prompt('Send the Water Bill Report PDF via WhatsApp to which number? (e.g. 2547XXXXXXXX)');
  if (!phone) return;
  try {
    if (resEl) resEl.textContent = 'Sending via WhatsApp…';
    const result = await api.sendWaterBillReport({ house_paybill: housePaybill, billing_month: month, unit, phone: phone.trim() });
    if (resEl) resEl.textContent = result.message || 'Sent via WhatsApp.';
    showToast('Water bill report sent via WhatsApp.');
  } catch (err) {
    if (resEl) resEl.textContent = 'Send failed: ' + ((err.data && err.data.error) || err.message || err);
    showToast('Send failed: ' + ((err.data && err.data.error) || err.message || err), 'error');
  }
});

function switchMrView(view) {
  _currentMrView = view;
  document.getElementById('btn-mr-standard')?.classList.toggle('bg-blue-600', view === 'standard');
  document.getElementById('btn-mr-standard')?.classList.toggle('text-white', view === 'standard');
  document.getElementById('btn-mr-enhanced')?.classList.toggle('bg-blue-600', view === 'enhanced');
  document.getElementById('btn-mr-enhanced')?.classList.toggle('text-white', view === 'enhanced');
  document.getElementById('btn-mr-water')?.classList.toggle('bg-blue-600', view === 'water');
  document.getElementById('btn-mr-water')?.classList.toggle('text-white', view === 'water');
  const month = document.getElementById('mr-month-select')?.value;
  if (month) {
    if (view === 'enhanced') loadEnhancedReport(month);
    else if (view === 'water') loadWaterBillReport();
    else loadReportData(month);
  } else {
    if (view === 'water') loadWaterBillReport();
  }
}

// Set initial toggle state
document.getElementById('btn-mr-standard')?.classList.add('bg-blue-600', 'text-white');

document.getElementById('btn-download-enhanced')?.addEventListener('click', async () => {
  const month = document.getElementById('mr-month-select')?.value;
  const housePaybill = document.getElementById('mr-property-select')?.value || '';
  if (!month) return;
  try {
    const result = await api.downloadEnhancedMonthlyReport(month, housePaybill || undefined);
    if (result.blob) triggerFileDownload(result);
  } catch (err) { alert(err.message); }
});

async function loadEnhancedReport(month) {
  const standardView = document.getElementById('mr-report-view');
  const enhancedView = document.getElementById('mr-enhanced-view');
  const empty = document.getElementById('mr-empty');
  if (!month) { if (standardView) standardView.classList.add('hidden'); if (enhancedView) enhancedView.classList.add('hidden'); if (empty) empty.classList.remove('hidden'); return; }
  try {
    const housePaybill = document.getElementById('mr-property-select')?.value || '';
    const { report } = await api.getEnhancedMonthlyReport(month, housePaybill || undefined);
    if (standardView) standardView.classList.add('hidden');
    if (enhancedView) enhancedView.classList.remove('hidden');
    if (empty) empty.classList.add('hidden');

    const money = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });

    // Unit-by-unit table
    const unitTbody = document.getElementById('er-unit-tbody');
    const unitTfoot = document.getElementById('er-unit-tfoot');
    const units = report.units || [];
    unitTbody.innerHTML = units.length ? units.map(u => {
      const statusClass = u.status === 'CLEARED' ? 'text-green-400' : u.status === 'PARTIALLY_PAID' ? 'text-amber-400' : u.status === 'UNPAID' ? 'text-red-400' : u.status === 'OVERPAYMENT' ? 'text-blue-400' : 'text-slate-500';
      const rowBg = u.status === 'VACANT' || u.status === 'BOOKED' ? 'opacity-50' : '';
      return `<tr class="${rowBg}">
        <td class="font-mono">${escapeHtml(u.unit_number || '')}</td>
        <td>${escapeHtml(u.tenant_name || '')}</td>
        <td class="text-xs">${escapeHtml(u.telephone || '')}</td>
        <td class="text-right font-mono">${u.deposit ? money(u.deposit) : '—'}</td>
        <td class="text-right font-mono">${u.water ? money(u.water) : '—'}</td>
        <td class="text-right font-mono">${u.penalty ? money(u.penalty) : '—'}</td>
        <td class="text-right font-mono">${money(u.monthly_rent)}</td>
        <td class="text-right font-mono">${u.balance_bf ? money(u.balance_bf) : '—'}</td>
        <td class="text-right font-mono font-semibold">${money(u.rent_due)}</td>
        <td class="text-right font-mono">${u.rent_paid ? money(u.rent_paid) : '—'}</td>
        <td class="font-mono text-xs">${escapeHtml(u.receipt_no || '—')}</td>
        <td class="font-mono text-xs">${escapeHtml(u.transaction_ref || '—')}</td>
        <td class="font-mono text-xs">${escapeHtml(u.payment_date || '—')}</td>
        <td class="text-right font-mono font-semibold">${money(u.balance)}</td>
        <td><span class="font-semibold text-xs ${statusClass}">${escapeHtml(u.status || '')}</span></td>
      </tr>`;
    }).join('') : '<tr><td colspan="15" class="text-center text-slate-500 py-4">No units found</td></tr>';

    // Totals row
    const sum = report.summary || {};
    unitTfoot.innerHTML = `<tr class="font-bold border-t-2 border-slate-600">
      <td colspan="3" class="text-right">TOTALS</td>
      <td class="text-right font-mono">${money(sum.total_deposit_collected)}</td>
      <td class="text-right font-mono">${money(sum.total_water_charges)}</td>
      <td class="text-right font-mono">${money(sum.total_penalties)}</td>
      <td class="text-right font-mono">${money(sum.total_rent_due)}</td>
      <td class="text-right font-mono">—</td>
      <td class="text-right font-mono">${money(sum.total_rent_due)}</td>
      <td class="text-right font-mono">${money(sum.total_rent_paid)}</td>
      <td colspan="3"></td>
      <td class="text-right font-mono">${money(sum.total_outstanding)}</td>
      <td></td>
    </tr>`;

    // Work summary
    const workTbody = document.getElementById('er-work-tbody');
    const work = report.work_summary || [];
    workTbody.innerHTML = work.length ? work.map(w => `<tr>
      <td class="font-mono text-xs">${escapeHtml(w.wo_number || '')}</td>
      <td>${escapeHtml(w.unit || '')}</td>
      <td>${escapeHtml(w.tenant || '')}</td>
      <td>${escapeHtml(w.problem || '')}</td>
      <td>${escapeHtml(w.work_done || '')}</td>
      <td class="text-right font-mono">${w.material_cost ? money(w.material_cost) : '—'}</td>
      <td class="text-right font-mono">${w.labour_cost ? money(w.labour_cost) : '—'}</td>
      <td class="text-right font-mono font-semibold">${money(w.total_cost)}</td>
      <td><span class="text-xs ${w.responsible_party === 'Tenant' ? 'text-amber-400' : 'text-cyan-400'}">${escapeHtml(w.responsible_party || '')}</span></td>
      <td class="text-right font-mono">${w.amount_recovered ? money(w.amount_recovered) : '—'}</td>
      <td class="text-right font-mono">${w.outstanding_recovery > 0 ? money(w.outstanding_recovery) : '—'}</td>
      <td><span class="status-badge ${w.status === 'Paid' ? 'badge-active' : 'badge-pending'}">${escapeHtml(w.status || '')}</span></td>
    </tr>`).join('') : '<tr><td colspan="12" class="text-center text-slate-500 py-4">No work/maintenance activities this month</td></tr>';

    // Invoices
    const invTbody = document.getElementById('er-invoice-tbody');
    const invs = report.invoices_issued || [];
    invTbody.innerHTML = invs.length ? invs.map(i => `<tr>
      <td class="font-mono text-xs">${escapeHtml(i.invoice_number || '')}</td>
      <td>${escapeHtml(i.invoice_type || '')}</td>
      <td class="text-xs">${escapeHtml(i.property || '')}${i.unit ? ' / ' + escapeHtml(i.unit) : ''}</td>
      <td>${escapeHtml(i.description || '')}</td>
      <td class="text-right font-mono">${money(i.amount)}</td>
      <td class="font-mono text-xs">${i.date_issued ? new Date(i.date_issued).toLocaleDateString('en-KE') : '—'}</td>
      <td>${escapeHtml(i.responsible_party || '')}</td>
      <td><span class="status-badge badge-pending">${escapeHtml(i.payment_status || '')}</span></td>
      <td class="text-right font-mono">${i.amount_paid ? money(i.amount_paid) : '—'}</td>
      <td class="text-right font-mono">${i.outstanding ? money(i.outstanding) : '—'}</td>
    </tr>`).join('') : '<tr><td colspan="10" class="text-center text-slate-500 py-4">No invoices issued this month</td></tr>';

    // Summary grid
    const sg = document.getElementById('er-summary-grid');
    sg.innerHTML = `
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Total Units</p><p class="font-bold font-orbitron">${sum.total_units || 0}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Occupied</p><p class="font-bold font-orbitron text-green-400">${sum.occupied_units || 0}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Vacant</p><p class="font-bold font-orbitron text-amber-400">${sum.vacant_units || 0}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Booked</p><p class="font-bold font-orbitron text-indigo-400">${sum.booked_units || 0}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Paid</p><p class="font-bold font-orbitron text-green-400">${sum.paid_units || 0}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Partially Paid</p><p class="font-bold font-orbitron text-amber-400">${sum.partially_paid_units || 0}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Unpaid</p><p class="font-bold font-orbitron text-red-400">${sum.unpaid_units || 0}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">New Tenants</p><p class="font-bold font-orbitron text-green-400">${sum.new_tenants || 0}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Vacated</p><p class="font-bold font-orbitron text-rose-400">${sum.vacated_tenants || 0}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Total Rent Due</p><p class="font-bold font-orbitron">${money(sum.total_rent_due)}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Total Rent Paid</p><p class="font-bold font-orbitron text-green-400">${money(sum.total_rent_paid)}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Deposit Collected</p><p class="font-bold font-orbitron">${money(sum.total_deposit_collected)}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Water Charges</p><p class="font-bold font-orbitron">${money(sum.total_water_charges)}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Penalties (Pending)</p><p class="font-bold font-orbitron text-amber-400">${money(sum.total_penalties)}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Penalties (Paid)</p><p class="font-bold font-orbitron text-green-400">${money(sum.total_penalties_paid || 0)}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Outstanding Balance</p><p class="font-bold font-orbitron text-red-400">${money(sum.total_outstanding)}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Advance/Overpayment</p><p class="font-bold font-orbitron text-blue-400">${money(sum.total_advance_overpayment)}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Credit Balance</p><p class="font-bold font-orbitron text-cyan-400">${money(sum.total_credit_balance)}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Tenant Recoveries</p><p class="font-bold font-orbitron">${money(sum.total_tenant_recoveries)}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Mgmt Maintenance</p><p class="font-bold font-orbitron text-amber-400">${money(sum.total_mgmt_maintenance_cost)}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Total Work Cost</p><p class="font-bold font-orbitron">${money(sum.total_work_repair_cost)}</p></div>
      <div class="p-2 bg-slate-800/50 rounded border border-slate-700"><p class="text-xs text-slate-400">Invoices Issued</p><p class="font-bold font-orbitron text-purple-400">${money(sum.total_invoices_issued)}</p></div>
    `;

  } catch (err) {
    if (standardView) standardView.classList.add('hidden');
    if (enhancedView) enhancedView.classList.add('hidden');
    if (empty) { empty.classList.remove('hidden'); empty.textContent = 'No enhanced report found for this month. Run monthly rollover first.'; }
  }
}

async function loadInvoiceRegister() {
  await Promise.all([loadInvoiceRegisterMonthly(), runInvoiceRegisterSearch()]);
}

async function loadInvoiceRegisterMonthly() {
  const container = document.getElementById('ir-monthly');
  if (!container) return;
  container.innerHTML = '<div class="text-slate-500 text-sm col-span-full">Loading monthly summary…</div>';
  try {
    const { months } = await api.invoiceRegisterMonthly();
    if (!months || !months.length) {
      container.innerHTML = '<div class="text-slate-500 text-sm col-span-full">No invoices issued yet.</div>';
      return;
    }
    container.innerHTML = months.map(m => `
      <button type="button" data-ir-month="${m.month}" class="glass-panel p-4 text-left hover:border-cyan-400/50 transition-colors">
        <div class="text-xs font-mono text-slate-400">${escapeHtml(m.month)}</div>
        <div class="text-lg font-bold mt-1">${m.total}</div>
        <div class="text-xs text-slate-400 mt-1">
          Rent ${m.rent || 0} · Maint ${m.maintenance || 0} · Pen ${m.penalty || 0} · Exit ${m.exit || 0}
        </div>
      </button>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div class="text-rose-400 text-sm col-span-full">Error: ${escapeHtml(err.message)}</div>`;
  }
}

async function runInvoiceRegisterSearch() {
  const params = {};
  const q = document.getElementById('ir-q')?.value.trim();
  const type = document.getElementById('ir-type')?.value;
  const status = document.getElementById('ir-status')?.value;
  const month = document.getElementById('ir-month')?.value;
  if (q) params.q = q;
  if (type) params.invoice_type = type;
  if (status) params.status = status;
  if (month) params.month = month;
  if (irExitMode) params.invoice_type = 'exit';

  const tbody = document.getElementById('ir-tbody');
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-slate-500 py-6">Loading invoice register…</td></tr>';
  }

  try {
    const result = await api.invoiceRegister(params);
    renderInvoiceRegister(result.records || [], result.total || 0);
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center text-rose-400 py-6">Error: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

function renderInvoiceRegister(records, total) {
  const tbody = document.getElementById('ir-tbody');
  const countEl = document.getElementById('ir-count');
  if (countEl) countEl.textContent = `${records.length} shown / ${total} total`;
  if (!tbody) return;

  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-slate-500 py-6">No invoices found in register.</td></tr>';
    return;
  }

  tbody.innerHTML = records.map(r => {
    const paidBadge = !r.payment_state ? '' :
      r.payment_state === 'Paid'
        ? '<span class="status-badge badge-active"><span class="status-dot"></span>Paid</span>'
        : r.payment_state === 'Partially Paid'
          ? '<span class="status-badge badge-pending"><span class="status-dot"></span>Partially Paid</span>'
          : '<span class="status-badge badge-suspended"><span class="status-dot"></span>Unpaid</span>';
    const paidCell = `<td class="text-right font-mono text-xs">
        <div class="text-green-400">${formatKes(r.amount_paid || 0)} paid</div>
        <div class="text-slate-400">${formatKes(r.balance_due ?? r.amount)} due</div>
        <div class="mt-1">${paidBadge}</div>
      </td>`;
    return `
    <tr>
      <td><span class="sys-tag">${escapeHtml(irTypeLabel(r.invoice_type).toUpperCase())}</span></td>
      <td class="font-mono">${escapeHtml(r.invoice_number || '—')}</td>
      <td>
        <div class="font-semibold">${escapeHtml(r.tenant_name || '—')}</div>
        ${r.tenant_code ? `<div class="text-xs text-slate-400 font-mono">${escapeHtml(r.tenant_code)}</div>` : ''}
      </td>
      <td class="text-slate-300">
        ${escapeHtml(r.property_name || '—')}
        ${r.unit_label ? ` <span class="font-mono text-xs">(${escapeHtml(r.unit_label)})</span>` : ''}
      </td>
      <td>${formatDocsDate(r.generated_at)}</td>
      <td class="text-right font-mono">${r.amount != null ? formatKes(r.amount) : '—'}</td>
      <td>${irRegisterBadge(r.status)}${r.voided ? ' <span class="sys-tag">VOID</span>' : ''}</td>
      ${paidCell}
      <td class="text-right whitespace-nowrap">
        <button type="button" class="action-btn text-xs" data-ir-action="view" data-ir-id="${r.id}" ${r.document_id ? '' : 'disabled title="No stored PDF attached"'} ${r.document_id ? '' : 'style="opacity:0.4;cursor:not-allowed"'}>View</button>
        <button type="button" class="action-btn text-xs" data-ir-action="download" data-ir-id="${r.id}" ${r.document_id ? '' : 'disabled style="opacity:0.4;cursor:not-allowed"'}>Download</button>
        <button type="button" class="action-btn text-green-400 border-green-400 hover:bg-green-400/20 text-xs" data-ir-action="send" data-ir-id="${r.id}" ${r.document_id ? '' : 'disabled style="opacity:0.4;cursor:not-allowed"'}>WhatsApp</button>
        <button type="button" class="action-btn text-xs" data-ir-action="edit" data-ir-id="${r.id}">Edit</button>
        <button type="button" class="action-btn text-rose-400 border-rose-400 hover:bg-rose-400/20 text-xs" data-ir-action="delete" data-ir-id="${r.id}">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

async function openInvoiceRegisterView(id) {
  try {
    const { register } = await api.invoiceRegisterById(id);
    if (!register) throw new Error('Register entry not found');
    irViewId = register.id;
    const titleEl = document.getElementById('ir-view-title');
    const metaEl = document.getElementById('ir-view-meta');
    if (titleEl) titleEl.textContent = `${irTypeLabel(register.invoice_type)} Invoice ${register.invoice_number}`;
    if (metaEl) {
      metaEl.innerHTML = `
        <span>Tenant: <b>${escapeHtml(register.tenant_name || '—')}</b> (${escapeHtml(register.tenant_code || '—')})</span>
        <span>Status: ${irRegisterBadge(register.status)}</span>
        ${register.move_out_date ? `<span>Move-out: <b>${escapeHtml(register.move_out_date)}</b></span>` : ''}
        ${register.approved_by ? `<span>Approved by: <b>${escapeHtml(register.approved_by)}</b></span>` : ''}
      `;
    }
    const frame = document.getElementById('ir-view-frame');
    if (frame) {
      frame.src = 'about:blank';
      try {
        const { blob } = await api.viewRegisterDocument(register.id);
        if (blob) frame.src = URL.createObjectURL(blob);
      } catch (err) {
        if (metaEl) metaEl.innerHTML = `<span class="text-rose-400">${escapeHtml(err.message)}</span>`;
      }
    }
    const modal = document.getElementById('ir-view-modal');
    if (modal) modal.classList.remove('hidden');
  } catch (err) {
    alert('Failed to open invoice: ' + err.message);
  }
}

let irEditId = null;

async function openInvoiceRegisterEdit(id) {
  try {
    const { register } = await api.invoiceRegisterById(id);
    if (!register) throw new Error('Register entry not found');
    irEditId = register.id;
    const ctx = document.getElementById('ir-edit-context');
    if (ctx) ctx.textContent = `${irTypeLabel(register.invoice_type)} ${register.invoice_number || ''} — ${register.tenant_name || ''} (${register.tenant_code || '—'})`;
    const amt = document.getElementById('ir-edit-amount');
    if (amt) amt.value = register.amount ?? '';
    const note = document.getElementById('ir-edit-paid-note');
    if (note) note.textContent = `Already paid: KES ${Number(register.amount_paid || 0).toLocaleString()} — balance recomputes automatically and the linked PDF amount follows. Payments and counters are untouched.`;
    const statusEl = document.getElementById('ir-edit-status');
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'text-sm font-mono text-amber-400'; }
    document.getElementById('ir-edit-modal')?.classList.remove('hidden');
  } catch (err) {
    alert('Failed to open edit: ' + err.message);
  }
}

document.getElementById('btn-ir-edit-cancel')?.addEventListener('click', () => {
  document.getElementById('ir-edit-modal')?.classList.add('hidden');
  irEditId = null;
});

document.getElementById('btn-ir-edit-save')?.addEventListener('click', async () => {
  if (!irEditId) return;
  const btn = document.getElementById('btn-ir-edit-save');
  const statusEl = document.getElementById('ir-edit-status');
  const amount = Number(document.getElementById('ir-edit-amount')?.value);
  if (!Number.isFinite(amount) || amount < 0) {
    if (statusEl) { statusEl.textContent = 'Enter a non-negative amount.'; statusEl.className = 'text-sm font-mono text-rose-400'; }
    return;
  }
  if (btn) btn.disabled = true;
  if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.className = 'text-sm font-mono text-amber-400'; }
  try {
    const res = await api.updateInvoiceRegister(irEditId, { amount });
    if (statusEl) { statusEl.textContent = 'Saved — register, balance and linked PDF updated.'; statusEl.className = 'text-sm font-mono text-green-400'; }
    showToast(`Invoice updated${res.clamped ? ' (balance clamped at zero — paid exceeded the new total)' : ''}.`);
    setTimeout(() => {
      document.getElementById('ir-edit-modal')?.classList.add('hidden');
      irEditId = null;
      loadInvoiceRegister();
    }, 700);
  } catch (err) {
    if (statusEl) { statusEl.textContent = 'Save failed: ' + (err.message || err); statusEl.className = 'text-sm font-mono text-rose-400'; }
  } finally {
    if (btn) btn.disabled = false;
  }
});

async function downloadInvoiceRegisterFile(id) {

  const { blob, filename } = await api.downloadRegisterDocument(id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'invoice.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

document.getElementById('ir-filter-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  runInvoiceRegisterSearch();
});
document.getElementById('btn-ir-refresh')?.addEventListener('click', () => loadInvoiceRegister());
document.getElementById('btn-ir-clear')?.addEventListener('click', () => {
  ['ir-type', 'ir-status', 'ir-month', 'ir-q'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  runInvoiceRegisterSearch();
});
document.getElementById('btn-ir-all')?.addEventListener('click', () => {
  irExitMode = false;
  const qEl = document.getElementById('ir-q');
  if (qEl) qEl.value = '';
  const mEl = document.getElementById('ir-month');
  if (mEl) mEl.value = '';
  loadInvoiceRegister();
});
document.getElementById('btn-ir-exit')?.addEventListener('click', () => {
  irExitMode = true;
  const qEl = document.getElementById('ir-q');
  if (qEl) qEl.value = '';
  const mEl = document.getElementById('ir-month');
  if (mEl) mEl.value = '';
  loadInvoiceRegister();
});
document.getElementById('ir-monthly')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ir-month]');
  if (!btn) return;
  const monthInput = document.getElementById('ir-month');
  if (monthInput) monthInput.value = btn.dataset.irMonth;
  runInvoiceRegisterSearch();
});
document.getElementById('ir-tbody')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-ir-action]');
  if (!btn) return;
  const id = btn.dataset.irId;
  const action = btn.dataset.irAction;
  try {
    if (action === 'view') {
      openInvoiceRegisterView(id);
    } else if (action === 'download') {
      btn.disabled = true;
      try { await downloadInvoiceRegisterFile(id); } finally { btn.disabled = false; }
    } else if (action === 'send') {
      const { register } = await api.invoiceRegisterById(id);
      irShareId = register.id;
      const phoneEl = document.getElementById('ir-share-phone');
      if (phoneEl) phoneEl.value = register.house_paybill_number || '';
      const statusEl = document.getElementById('ir-share-status');
      if (statusEl) statusEl.textContent = '';
      document.getElementById('ir-share-modal')?.classList.remove('hidden');
    } else if (action === 'edit') {
      await openInvoiceRegisterEdit(id);
    } else if (action === 'delete') {
      const { register } = await api.invoiceRegisterById(id);
      const label = `${register.invoice_type || 'invoice'} ${register.invoice_number || ''}`.trim();
      if (!confirm(`Delete ${label} from the register?\n\nThis removes the register entry, its linked PDF and its payment links. Payments, receipts and tenant counters are NOT touched.`)) return;
      btn.disabled = true;
      try {
        const res = await api.deleteInvoiceRegister(id);
        showToast(`Invoice deleted (links removed: ${res.links_removed ?? 0}, document removed: ${res.document_removed ? 'yes' : 'no'}).`);
        loadInvoiceRegister();
      } finally { btn.disabled = false; }
    }
  } catch (err) {
    alert('Action failed: ' + err.message);
  }
});
document.getElementById('btn-ir-view-download')?.addEventListener('click', async () => {
  if (!irViewId) return;
  try {
    await downloadInvoiceRegisterFile(irViewId);
  } catch (err) {
    alert('Download failed: ' + err.message);
  }
});
document.getElementById('btn-ir-view-send')?.addEventListener('click', () => {
  if (!irViewId) return;
  irShareId = irViewId;
  const phoneEl = document.getElementById('ir-share-phone');
  if (phoneEl) phoneEl.value = '';
  const statusEl = document.getElementById('ir-share-status');
  if (statusEl) statusEl.textContent = '';
  document.getElementById('ir-share-modal')?.classList.remove('hidden');
});
document.getElementById('btn-ir-view-close')?.addEventListener('click', () => {
  const frame = document.getElementById('ir-view-frame');
  if (frame) frame.src = 'about:blank';
  document.getElementById('ir-view-modal')?.classList.add('hidden');
  irViewId = null;
});
document.getElementById('btn-ir-share-cancel')?.addEventListener('click', () => {
  document.getElementById('ir-share-modal')?.classList.add('hidden');
  irShareId = null;
});
document.getElementById('btn-ir-share-send')?.addEventListener('click', async () => {
  if (!irShareId) return;
  const btn = document.getElementById('btn-ir-share-send');
  const phone = document.getElementById('ir-share-phone')?.value.trim();
  const statusEl = document.getElementById('ir-share-status');
  if (btn) btn.disabled = true;
  if (statusEl) {
    statusEl.textContent = 'Sending…';
    statusEl.className = 'text-sm font-mono text-amber-400';
  }
  try {
    await api.resendInvoiceRegister(irShareId, phone);
    if (statusEl) {
      statusEl.textContent = 'Sent successfully!';
      statusEl.className = 'text-sm font-mono text-green-400';
    }
    runInvoiceRegisterSearch();
    if (irViewId) openInvoiceRegisterView(irViewId);
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err.message;
      statusEl.className = 'text-sm font-mono text-rose-400';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ============================================================
// DEPOSIT REFUNDS
// ============================================================

let drCurrentFilter = 'all';
let drCurrentSort = 'status';
let drCurrentSearch = '';
let drDetailId = null;

async function loadDepositRefunds() {
  try {
    const [{ summary }, { refunds }] = await Promise.all([
      api.getDepositRefundSummary(),
      api.listDepositRefunds({
        status: drCurrentFilter,
        sort: drCurrentSort,
        search: drCurrentSearch,
      }),
    ]);
    renderDepositRefundSummary(summary);
    renderDepositRefundTable(refunds);
  } catch (err) {
    console.error('[DepositRefunds] Load failed:', err);
  }
}

function renderDepositRefundSummary(s) {
  setTextEl('dr-sum-pending', s.pending || 0);
  setTextEl('dr-sum-pending-amt', formatKes(s.pending_amount || 0));
  setTextEl('dr-sum-due-soon', s.due_soon || 0);
  setTextEl('dr-sum-due-soon-amt', formatKes(s.due_soon_amount || 0));
  setTextEl('dr-sum-due-today', s.due_today || 0);
  setTextEl('dr-sum-due-today-amt', formatKes(s.due_today_amount || 0));
  setTextEl('dr-sum-overdue', s.overdue || 0);
  setTextEl('dr-sum-overdue-amt', formatKes(s.overdue_amount || 0));
  setTextEl('dr-sum-refunded', s.refunded || 0);
  setTextEl('dr-sum-refunded-amt', formatKes(s.refunded_amount || 0));
}

function getDrCountdown(refund) {
  if (refund.refund_status === 'refunded') return '<span class="text-green-400">REFUNDED</span>';
  if (refund.refund_status === 'no_refund_due') return '<span class="text-slate-500">N/A</span>';
  if (!refund.refund_due_date) return '<span class="text-slate-500">—</span>';
  const due = new Date(refund.refund_due_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const diff = Math.floor((due - today) / (1000 * 60 * 60 * 24));
  if (diff < 0) return '<span class="text-rose-400 font-bold">' + Math.abs(diff) + 'd overdue</span>';
  if (diff === 0) return '<span class="text-amber-400 font-bold">Due today</span>';
  if (diff <= 7) return '<span class="text-amber-400">' + diff + ' days</span>';
  return '<span class="text-slate-300">' + diff + ' days</span>';
}

function getDrStatusBadge(status) {
  const map = {
    pending: '<span class="status-badge badge-pending"><span class="status-dot"></span>Pending</span>',
    due_soon: '<span class="status-badge badge-pending"><span class="status-dot"></span>Due Soon</span>',
    due_today: '<span class="status-badge badge-expired"><span class="status-dot"></span>Due Today</span>',
    overdue: '<span class="status-badge badge-expired"><span class="status-dot"></span>Overdue</span>',
    refunded: '<span class="status-badge badge-active"><span class="status-dot"></span>Refunded</span>',
    partially_refunded: '<span class="status-badge badge-pending"><span class="status-dot"></span>Partial</span>',
    no_refund_due: '<span class="status-badge badge-vacant"><span class="status-dot"></span>No Refund</span>',
  };
  return map[status] || status;
}

function renderDepositRefundTable(refunds) {
  const tbody = document.getElementById('dr-tbody');
  if (!tbody) return;
  if (!refunds.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-8 text-slate-500">' +
      '<div class="text-lg mb-2">No Deposit Refunds</div>' +
      '<div class="text-sm">There are currently no deposit refunds requiring action.</div>' +
      '</td></tr>';
    return;
  }
  tbody.innerHTML = refunds.map(r => {
    const name = escapeHtml(r.tenant_name || r.tenant_code);
    const code = escapeHtml(r.tenant_code);
    const prop = escapeHtml(r.property_name || '—');
    const unit = escapeHtml(r.unit_label || '—');
    return '<tr class="hover:bg-slate-800/50">' +
      '<td><p class="text-white font-semibold text-sm">' + name + '</p><p class="text-xs text-slate-400 font-mono">' + code + '</p></td>' +
      '<td><p class="text-sm">' + prop + '</p><p class="text-xs text-purple-300 font-mono">' + unit + '</p></td>' +
      '<td class="font-mono text-sm">' + fmtDate(r.exit_date) + '</td>' +
      '<td class="text-right font-mono font-bold text-green-400">' + formatKes(r.refundable_amount) + '</td>' +
      '<td class="font-mono text-sm">' + fmtDate(r.refund_due_date) + '</td>' +
      '<td class="font-mono text-sm">' + getDrCountdown(r) + '</td>' +
      '<td>' + getDrStatusBadge(r.refund_status) + '</td>' +
      '<td class="text-right"><button type="button" data-dr-view="' + r.id + '" class="action-btn">View</button></td>' +
      '</tr>';
  }).join('');
}

document.getElementById('dr-tbody')?.addEventListener('click', async (e) => {
  const viewId = e.target.dataset.drView;
  if (viewId) openDrDetail(viewId);
});

document.getElementById('dr-search')?.addEventListener('input', (() => {
  let t;
  return () => { clearTimeout(t); t = setTimeout(() => {
    drCurrentSearch = document.getElementById('dr-search').value;
    loadDepositRefunds();
  }, 400); };
})());

document.getElementById('dr-status-filter')?.addEventListener('change', (e) => {
  drCurrentFilter = e.target.value;
  loadDepositRefunds();
});

document.getElementById('dr-sort')?.addEventListener('change', (e) => {
  drCurrentSort = e.target.value;
  loadDepositRefunds();
});

document.getElementById('btn-dr-clear')?.addEventListener('click', () => {
  drCurrentFilter = 'all';
  drCurrentSort = 'status';
  drCurrentSearch = '';
  document.getElementById('dr-search').value = '';
  document.getElementById('dr-status-filter').value = 'all';
  document.getElementById('dr-sort').value = 'status';
  loadDepositRefunds();
});

document.querySelectorAll('[data-dr-filter]').forEach(card => {
  card.addEventListener('click', () => {
    drCurrentFilter = card.dataset.drFilter;
    document.getElementById('dr-status-filter').value = drCurrentFilter;
    loadDepositRefunds();
  });
});

async function openDrDetail(id) {
  drDetailId = id;
  const modal = document.getElementById('dr-detail-modal');
  try {
    const { refund } = await api.getDepositRefund(id);
    if (!refund) return;

    document.getElementById('dr-detail-status').innerHTML = getDrStatusBadge(refund.refund_status);
    setTextEl('dr-detail-tenant', refund.tenant_name || refund.tenant_code);
    setTextEl('dr-detail-phone', refund.tenant_phone || '—');
    setTextEl('dr-detail-property', refund.property_name || '—');
    setTextEl('dr-detail-unit', refund.unit_label || '—');
    document.getElementById('dr-detail-exit-number').textContent = refund.exit_number || '—';
    setTextEl('dr-detail-exit-date', fmtDate(refund.exit_date));
    setTextEl('dr-detail-due-date', fmtDate(refund.refund_due_date));

    const countdownEl = document.getElementById('dr-detail-countdown');
    countdownEl.innerHTML = getDrCountdown(refund);
    countdownEl.className = refund.refund_status === 'overdue' ? 'text-rose-400 font-bold' :
      refund.refund_status === 'due_today' ? 'text-amber-400 font-bold' : 'font-bold';

    setTextEl('dr-detail-deposit-paid', formatKes(refund.deposit_paid));
    setTextEl('dr-detail-dep-rent', '-' + formatKes(refund.deposit_applied_to_rent));
    setTextEl('dr-detail-dep-ded', '-' + formatKes(refund.deposit_applied_to_deductions));
    setTextEl('dr-detail-deductions', formatKes(refund.deductions_total));
    setTextEl('dr-detail-refundable', formatKes(refund.refundable_amount));

    const linesPanel = document.getElementById('dr-detail-lines-panel');
    const linesTbody = document.getElementById('dr-detail-lines-tbody');
    let lines = [];
    try { lines = typeof refund.ei_lines === 'string' ? JSON.parse(refund.ei_lines) : (refund.ei_lines || []); } catch (_) {}
    if (lines.length) {
      linesPanel.classList.remove('hidden');
      linesTbody.innerHTML = lines.map(l => {
        const cat = escapeHtml(l.category || l.label || '—');
        const desc = escapeHtml(l.description || l.label || '—');
        const amt = formatKes(l.amount);
        return '<tr><td class="text-sm">' + cat + '</td><td class="text-sm">' + desc + '</td><td class="text-right font-mono text-rose-400">' + amt + '</td></tr>';
      }).join('');
    } else {
      linesPanel.classList.add('hidden');
    }

    const txPanel = document.getElementById('dr-detail-transaction-panel');
    if (refund.refund_status === 'refunded' || refund.refund_status === 'partially_refunded') {
      txPanel.classList.remove('hidden');
      setTextEl('dr-detail-amount-refunded', formatKes(refund.amount_refunded));
      setTextEl('dr-detail-remaining', formatKes(refund.remaining_amount));
      setTextEl('dr-detail-refund-date', refund.refund_date ? fmtDate(refund.refund_date) + (refund.refund_time ? ' ' + refund.refund_time.slice(0, 5) : '') : '—');
      setTextEl('dr-detail-method', refund.payment_method || '—');
      setTextEl('dr-detail-ref', refund.transaction_reference || '—');
      setTextEl('dr-detail-refunded-by', refund.refunded_by || '—');
      setTextEl('dr-detail-remarks', refund.remarks || '—');
    } else {
      txPanel.classList.add('hidden');
    }

    const canRefund = refund.refund_status !== 'refunded' && refund.refund_status !== 'no_refund_due' && Number(refund.refundable_amount) > 0;
    document.getElementById('btn-dr-record-refund').style.display = canRefund ? '' : 'none';
    document.getElementById('btn-dr-view-exit-invoice').style.display = refund.exit_invoice_id ? '' : 'none';

    modal.classList.remove('hidden');
  } catch (err) {
    console.error('[DepositRefunds] Detail load failed:', err);
  }
}

document.getElementById('btn-dr-detail-close')?.addEventListener('click', () => {
  document.getElementById('dr-detail-modal').classList.add('hidden');
});

document.getElementById('dr-detail-modal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('dr-detail-modal')) {
    document.getElementById('dr-detail-modal').classList.add('hidden');
  }
});

document.getElementById('btn-dr-view-exit-invoice')?.addEventListener('click', async () => {
  if (!drDetailId) return;
  try {
    const { refund } = await api.getDepositRefund(drDetailId);
    if (refund?.exit_invoice_id) {
      document.getElementById('dr-detail-modal').classList.add('hidden');
      openExitInvoiceModal(refund.tenant_code);
    }
  } catch (err) {
    console.error('[DepositRefunds] Failed to load exit invoice:', err);
  }
});

document.getElementById('btn-dr-record-refund')?.addEventListener('click', async () => {
  if (!drDetailId) return;
  try {
    const { refund } = await api.getDepositRefund(drDetailId);
    if (!refund) return;
    const outstanding = Number(refund.refundable_amount || 0) - Number(refund.amount_refunded || 0);
    document.getElementById('dr-record-id').value = refund.id;
    setTextEl('dr-record-tenant', refund.tenant_name || refund.tenant_code);
    setTextEl('dr-record-outstanding', formatKes(outstanding));
    document.getElementById('dr-record-amount').max = outstanding;
    document.getElementById('dr-record-amount').value = outstanding;
    document.getElementById('dr-record-method').value = '';
    document.getElementById('dr-record-ref').value = '';
    document.getElementById('dr-record-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('dr-record-time').value = new Date().toISOString().slice(11, 16);
    document.getElementById('dr-record-remarks').value = '';
    document.getElementById('dr-detail-modal').classList.add('hidden');
    document.getElementById('dr-record-modal').classList.remove('hidden');
  } catch (err) {
    console.error('[DepositRefunds] Record refund load failed:', err);
  }
});

document.getElementById('btn-dr-record-cancel')?.addEventListener('click', () => {
  document.getElementById('dr-record-modal').classList.add('hidden');
  document.getElementById('dr-detail-modal').classList.remove('hidden');
});

document.getElementById('dr-record-modal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('dr-record-modal')) {
    document.getElementById('dr-record-modal').classList.add('hidden');
  }
});

document.getElementById('dr-record-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('dr-record-id').value;
  const amount = document.getElementById('dr-record-amount').value;
  const method = document.getElementById('dr-record-method').value;
  const ref = document.getElementById('dr-record-ref').value;
  const date = document.getElementById('dr-record-date').value;
  const time = document.getElementById('dr-record-time').value;
  const remarks = document.getElementById('dr-record-remarks').value;

  if (!amount || Number(amount) <= 0) return alert('Please enter a valid refund amount.');
  if (!method) return alert('Please select a payment method.');
  if (method === 'M-Pesa' && !ref.trim()) return alert('M-Pesa transaction reference is required.');

  try {
    const result = await api.recordDepositRefund(id, {
      amount: Number(amount),
      payment_method: method,
      transaction_reference: ref,
      refund_date: date,
      refund_time: time,
      remarks,
    });
    if (result.error) return alert(result.error);
    document.getElementById('dr-record-modal').classList.add('hidden');
    loadDepositRefunds();
    openDrDetail(id);
  } catch (err) {
    alert('Failed to record refund: ' + (err.message || err));
  }
});

window.openDrDetail = openDrDetail;

// ─── WhatsApp Module (QR-Linked) ────────────────────────────────────────────
// NOTE: _waPolling/_waQrPolling are declared at the top of the file because
// showView() (which runs during startup) calls waStart/StopPolling.
try {
  window.GEHM_DEBUG = {
    version: () => GEHM_VERSION,
    view: () => currentView,
    viewLog: () => [..._gehmViewLog],
    errors: () => [..._gehmErrors],
    clickNav: (n) => showView(n),
  };
} catch (_) {}

async function waLoadStatus() {
  try {
    const data = await api.waStatus();
    const dot = document.getElementById('wa-status-dot');
    const text = document.getElementById('wa-status-text');
    const info = document.getElementById('wa-session-info');
    const stats = document.getElementById('wa-stats-row');
    const btnConnect = document.getElementById('btn-wa-connect');
    const btnDisconnect = document.getElementById('btn-wa-disconnect');
    const btnLogout = document.getElementById('btn-wa-logout');
    const btnTest = document.getElementById('btn-wa-test');
    const qrPanel = document.getElementById('wa-qr-panel');

    if (!dot) return;

    const state = data.state || 'disconnected';
    const stateColors = { connected: 'bg-green-500', qr_required: 'bg-amber-500', connecting: 'bg-blue-500', disconnected: 'bg-slate-400', error: 'bg-red-500' };
    const stateLabels = { connected: 'CONNECTED', qr_required: 'QR CODE READY', connecting: 'CONNECTING…', disconnected: 'NOT CONNECTED', error: 'ERROR', authenticating: 'AUTHENTICATING…', disconnecting: 'DISCONNECTING…' };

    dot.className = `w-2 h-2 rounded-full ${stateColors[state] || 'bg-slate-500'}`;
    text.textContent = stateLabels[state] || state.toUpperCase();

    if (state === 'connected') {
      info.classList.remove('hidden');
      document.getElementById('wa-phone-display').textContent = data.sessionInfo?.phone || 'Connected';
      document.getElementById('wa-platform-display').textContent = data.sessionInfo?.platform ? `Platform: ${data.sessionInfo.platform}` : '';
      document.getElementById('wa-connected-since').textContent = data.connectedAt ? `Connected since: ${new Date(data.connectedAt).toLocaleString()}` : '';
      btnConnect.style.display = 'none';
      btnDisconnect.style.display = '';
      btnLogout.style.display = '';
      btnTest.style.display = '';
      qrPanel.classList.add('hidden');
      waStopQrPolling();
    } else if (state === 'qr_required') {
      info.classList.add('hidden');
      btnConnect.style.display = 'none';
      btnDisconnect.style.display = 'none';
      btnLogout.style.display = 'none';
      btnTest.style.display = 'none';
      qrPanel.classList.remove('hidden');
      waShowQr(data.qrCode);
      waStartQrPolling();
    } else {
      info.classList.add('hidden');
      btnConnect.style.display = '';
      btnConnect.textContent = 'Connect WhatsApp';
      btnConnect.disabled = false;
      btnDisconnect.style.display = 'none';
      btnLogout.style.display = 'none';
      btnTest.style.display = 'none';
      qrPanel.classList.add('hidden');
      waStopQrPolling();
    }

    if (state === 'connected') {
      stats.classList.remove('hidden');
      waLoadStats();
    } else {
      stats.classList.add('hidden');
    }
  } catch (err) {
    console.error('[WA] Status error:', err);
  }
}

function waShowQr(qrData) {
  const container = document.getElementById('wa-qr-container');
  if (!container) return;
  if (qrData) {
    container.innerHTML = `<img src="${qrData}" alt="WhatsApp QR Code" class="w-64 h-64 rounded-lg">`;
    document.getElementById('wa-qr-status').textContent = 'Waiting for scan…';
    document.getElementById('wa-qr-status').className = 'text-sm text-amber-600';
  } else {
    container.innerHTML = '<div class="w-64 h-64 bg-white rounded-lg flex items-center justify-center"><p class="text-slate-500 text-sm">Generating QR code…</p></div>';
  }
}

async function waConnect() {
  try {
    document.getElementById('btn-wa-connect').textContent = 'Connecting…';
    document.getElementById('btn-wa-connect').disabled = true;
    await api.waConnect();
    waStartPolling();
  } catch (err) {
    alert('Failed to connect: ' + (err.message || err));
    document.getElementById('btn-wa-connect').textContent = 'Connect WhatsApp';
    document.getElementById('btn-wa-connect').disabled = false;
  }
}

async function waSimulateScan() {
  try {
    const btn = document.querySelector('#wa-qr-panel button');
    if (btn) { btn.textContent = 'Connecting…'; btn.disabled = true; }
    await api.waSimulateScan();
  } catch (err) {
    alert('Failed: ' + (err.message || err));
  }
}

async function waDisconnect() {
  if (!confirm('Disconnect WhatsApp session?')) return;
  try {
    await api.waDisconnect();
    waLoadStatus();
  } catch (err) {
    alert('Failed to disconnect: ' + (err.message || err));
  }
}

async function waLogout() {
  if (!confirm('Logout and clear session? This will remove all session data.')) return;
  try {
    await api.waLogout();
    waLoadStatus();
  } catch (err) {
    alert('Failed to logout: ' + (err.message || err));
  }
}

async function waSendTest() {
  const phone = prompt('Enter phone number to send test message:');
  if (!phone) return;
  try {
    const result = await api.waSendTest(phone, 'Test message from Rental Management System ✓');
    alert(result.message || 'Test message sent!');
  } catch (err) {
    alert('Failed: ' + (err.message || err));
  }
}

async function waSendTestMsg() {
  const phone = document.getElementById('wa-test-phone')?.value;
  const msg = document.getElementById('wa-test-msg')?.value;
  if (!phone || !msg) return alert('Enter phone and message');
  try {
    const result = await api.waSendTest(phone, msg);
    alert(result.message || 'Sent!');
  } catch (err) {
    alert('Failed: ' + (err.message || err));
  }
}

async function waLoadStats() {
  try {
    const data = await api.waMessageStats();
    const stats = data.stats || {};
    setTextEl('wa-stat-today', Number(stats.today || 0));
    setTextEl('wa-stat-sent', Number(stats.sent_count || 0));
    setTextEl('wa-stat-delivered', Number(stats.delivered_count || 0));
    setTextEl('wa-stat-failed', Number(stats.failed_count || 0));
    setTextEl('wa-stat-queued', Number(stats.queued || 0));
  } catch (_) {}
}

async function waLoadMessages(page = 1) {
  try {
    const data = await api.waMessages({ page, limit: 20 });
    const tbody = document.getElementById('wa-messages-tbody');
    if (!tbody) return;
    const messages = data.messages || [];

    // Auto-refresh: while any message on this page is still awaiting a
    // delivery/read receipt, re-load so Delivered/Read appear automatically
    // (bounded so it can never poll forever).
    clearTimeout(window._waMessagesRefreshTimer);
    const awaitingDelivery = messages.some((m) => {
      const st = String(m.status || '').toLowerCase();
      return st === 'pending' || st === 'sent' || st === 'sending' || st === 'queued';
    });
    if (awaitingDelivery) {
      window._waMessagesRefreshCount = (window._waMessagesRefreshCount || 0) + 1;
      if (window._waMessagesRefreshCount <= 30) {
        window._waMessagesRefreshTimer = setTimeout(() => {
          const view = document.querySelector('[data-view="messages"]');
          if (view && !view.classList.contains('hidden')) waLoadMessages(page);
          else window._waMessagesRefreshCount = 0;
        }, 5000);
      }
    } else {
      window._waMessagesRefreshCount = 0;
    }
    if (messages.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="py-4 text-center text-slate-500">No messages yet</td></tr>';
      const emptyPag = document.getElementById('wa-messages-pagination');
      if (emptyPag) emptyPag.innerHTML = '';
      return;
    }
    tbody.innerHTML = messages.map(m => {
      const body = (m.content || '').replace(/\s+/g, ' ').trim();
      const snippet = body.length > 90 ? body.slice(0, 90) + '…' : body;
      const st = (m.status || '').toLowerCase();
      const badge = ['sent', 'delivered', 'read'].includes(st)
        ? 'bg-green-900 text-green-300'
        : st === 'failed' ? 'bg-red-900 text-red-300' : 'bg-slate-700 text-slate-300';
      return `
      <tr class="text-sm">
        <td class="py-2 pr-3">${escapeHtml(m.tenant_name || m.tenant_code || '—')}</td>
        <td class="py-2 pr-3 font-mono text-xs">${escapeHtml(m.phone_number || '—')}</td>
        <td class="py-2 pr-3">${escapeHtml(m.message_type || 'text')}</td>
        <td class="py-2 pr-3"><span class="px-2 py-0.5 rounded text-xs ${badge}">${escapeHtml(m.status || '—')}</span></td>
        <td class="py-2 pr-3 text-xs text-slate-500" title="${escapeHtml(body)}">${escapeHtml(snippet) || '—'}</td>
        <td class="py-2 text-xs text-slate-400">${m.created_at ? new Date(m.created_at).toLocaleString() : '—'}</td>
      </tr>`;
    }).join('');

    const pagination = data.pagination || {};
    const totalPages = Math.max(Number(pagination.totalPages) || 1, 1);
    const pag = document.getElementById('wa-messages-pagination');
    if (!pag) return;
    if (totalPages <= 1) { pag.innerHTML = ''; return; }
    const cur = Math.min(Math.max(Number(pagination.page) || page, 1), totalPages);
    const win = 2;
    const start = Math.max(1, cur - win);
    const end = Math.min(totalPages, cur + win);
    let html = `<button class="qc-btn text-xs" ${cur <= 1 ? 'disabled' : ''} onclick="waLoadMessages(${cur - 1})">‹ Prev</button>`;
    if (start > 1) html += `<button class="qc-btn text-xs" onclick="waLoadMessages(1)">1</button>${start > 2 ? '<span class="text-slate-400 text-xs px-1 self-center">…</span>' : ''}`;
    for (let i = start; i <= end; i++) {
      html += `<button class="qc-btn text-xs ${i === cur ? 'qc-btn-primary' : ''}" onclick="waLoadMessages(${i})">${i}</button>`;
    }
    if (end < totalPages) html += `${end < totalPages - 1 ? '<span class="text-slate-400 text-xs px-1 self-center">…</span>' : ''}<button class="qc-btn text-xs" onclick="waLoadMessages(${totalPages})">${totalPages}</button>`;
    html += `<button class="qc-btn text-xs" ${cur >= totalPages ? 'disabled' : ''} onclick="waLoadMessages(${cur + 1})">Next ›</button>`;
    html += `<span class="text-xs text-slate-400 px-1 self-center">Page ${cur} of ${totalPages}</span>`;
    pag.innerHTML = html;
  } catch (err) {
    console.error('[WA] Messages error:', err);
  }
}

async function waLoadSettings() {
  try {
    const data = await api.waSettings();
    const settings = data.settings || {};
    const set = (id, key) => { const el = document.getElementById(id); if (el) el.checked = settings[key] !== 'false'; };
    set('wa-set-welcome', 'auto_welcome_tenant');
    set('wa-set-invoice', 'auto_rent_invoice');
    set('wa-set-reminder', 'auto_rent_reminder');
    set('wa-set-overdue', 'auto_overdue_rent');
    set('wa-set-payment', 'auto_payment_received');
    set('wa-set-maintenance', 'auto_maintenance_created');
    set('wa-set-maint-update', 'auto_maintenance_updates');
    set('wa-set-announce', 'auto_general_announcement');
    const remindDays = document.getElementById('wa-set-remind-days');
    const overdueDays = document.getElementById('wa-set-overdue-days');
    if (remindDays) remindDays.value = settings.rent_reminder_days_before || 3;
    if (overdueDays) overdueDays.value = settings.rent_overdue_days_after || 1;
  } catch (_) {}
}

async function waSaveSettings() {
  const get = (id) => document.getElementById(id)?.checked ? 'true' : 'false';
  const settings = {
    auto_welcome_tenant: get('wa-set-welcome'),
    auto_rent_invoice: get('wa-set-invoice'),
    auto_rent_reminder: get('wa-set-reminder'),
    auto_overdue_rent: get('wa-set-overdue'),
    auto_payment_received: get('wa-set-payment'),
    auto_maintenance_created: get('wa-set-maintenance'),
    auto_maintenance_updates: get('wa-set-maint-update'),
    auto_general_announcement: get('wa-set-announce'),
    rent_reminder_days_before: document.getElementById('wa-set-remind-days')?.value || '3',
    rent_overdue_days_after: document.getElementById('wa-set-overdue-days')?.value || '1',
  };
  try {
    await api.waUpdateSettings(settings);
    alert('Settings saved!');
  } catch (err) {
    alert('Failed to save: ' + (err.message || err));
  }
}

async function waLoadTemplates() {
  try {
    const data = await api.waTemplates();
    const list = document.getElementById('wa-templates-list');
    if (!list) return;
    const keys = data.templates || [];
    if (keys.length === 0) {
      list.innerHTML = '<p class="text-slate-500 text-sm">No templates</p>';
      return;
    }
    const labels = {
      PAYMENT_RECEIVED: 'Payment Received', RENT_REMINDER: 'Rent Reminder',
      RENT_INVOICE: 'Rent Invoice', MAINTENANCE_RECEIVED: 'Maintenance Request',
      MAINTENANCE_UPDATED: 'Maintenance Update', WELCOME_TENANT: 'Welcome Tenant',
      GENERAL_ANNOUNCEMENT: 'General Announcement',
    };
    list.innerHTML = keys.map(k => `
      <div class="flex items-center justify-between p-3 rounded bg-slate-50 border border-slate-200">
        <div>
          <span class="text-sm font-semibold text-slate-700">${escapeHtml(labels[k] || k)}</span>
          <span class="text-xs text-slate-400 ml-2 font-mono">${escapeHtml(k)}</span>
        </div>
        <button class="qc-btn text-xs" onclick="waPreviewTemplate('${k}')">Preview</button>
      </div>
    `).join('');
  } catch (_) {}
}

async function waPreviewTemplate(key) {
  try {
    const data = await api.waTemplatePreview(key);
    const content = data.rendered || 'No preview available';
    const labels = {
      PAYMENT_RECEIVED: 'Payment Received', RENT_REMINDER: 'Rent Reminder',
      RENT_INVOICE: 'Rent Invoice', MAINTENANCE_RECEIVED: 'Maintenance Request',
      MAINTENANCE_UPDATED: 'Maintenance Update', WELCOME_TENANT: 'Welcome Tenant',
      GENERAL_ANNOUNCEMENT: 'General Announcement',
    };
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/50 flex items-center justify-center z-50';
    overlay.innerHTML = `
      <div class="glass-panel p-6 max-w-md w-full mx-4" style="background:white">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold text-slate-800">${escapeHtml(labels[key] || key)}</h3>
          <button class="text-slate-400 hover:text-slate-600 text-xl" onclick="this.closest('.fixed').remove()">&times;</button>
        </div>
        <pre class="text-sm text-slate-700 whitespace-pre-wrap bg-slate-50 p-4 rounded border border-slate-200 font-sans leading-relaxed">${escapeHtml(content)}</pre>
        <div class="mt-4 flex justify-end">
          <button class="qc-btn" onclick="this.closest('.fixed').remove()">Close</button>
        </div>
      </div>`;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  } catch (err) {
    alert('Failed: ' + (err.message || err));
  }
}

function waStartPolling() {
  waStopPolling();
  _waPolling = setInterval(waLoadStatus, 5000);
  waLoadStatus();
}

function waStopPolling() {
  if (_waPolling) { clearInterval(_waPolling); _waPolling = null; }
}

function waStartQrPolling() {
  waStopQrPolling();
  _waQrPolling = setInterval(async () => {
    try {
      const data = await api.waQR();
      if (data.qrCode) waShowQr(data.qrCode);
    } catch (_) {}
  }, 3000);
}

function waStopQrPolling() {
  if (_waQrPolling) { clearInterval(_waQrPolling); _waQrPolling = null; }
}

window.waConnect = waConnect;
window.waSimulateScan = waSimulateScan;
window.waDisconnect = waDisconnect;
window.waLogout = waLogout;
window.waSendTest = waSendTest;
window.waSendTestMsg = waSendTestMsg;
window.waLoadMessages = waLoadMessages;
window.waSaveSettings = waSaveSettings;
window.waPreviewTemplate = waPreviewTemplate;

// ─── SMS Module (Bytewave Networks) ────────────────────────────────────────

async function smsLoadStatus() {
  try {
    const info = await api.smsStatus();
    setTextEl('sms-status-text', info.hasToken ? 'Configured' : 'Not configured');
    const dot = document.getElementById('sms-status-dot');
    if (dot) dot.className = `w-2 h-2 rounded-full ${info.hasToken ? 'bg-green-500' : 'bg-amber-400'}`;
    const panel = document.getElementById('sms-provider-info');
    if (panel) panel.classList.toggle('hidden', false);
    setTextEl('sms-provider-name', info.providerName || 'Bytewave Networks');
    setTextEl('sms-api-base', info.apiBase || '');
    setTextEl('sms-sender-display', info.senderId ? `Sender ID: ${info.senderId}` : 'Sender ID: (none)');
    const senderInput = document.getElementById('sms-sender-id');
    if (senderInput && info.senderId) senderInput.value = info.senderId;
    const tokenInput = document.getElementById('sms-api-token');
    if (tokenInput) tokenInput.value = '';
  } catch (err) {
    // Retry once — on first view the auth token may still be settling
    if (!err || err.status !== 401) {
      setTextEl('sms-status-text', 'Error');
      console.error('[SMS] Status error:', err);
      return;
    }
    await new Promise(r => setTimeout(r, 1200));
    try {
      const info2 = await api.smsStatus();
      setTextEl('sms-status-text', info2.hasToken ? 'Configured' : 'Not configured');
      const dot2 = document.getElementById('sms-status-dot');
      if (dot2) dot2.className = `w-2 h-2 rounded-full ${info2.hasToken ? 'bg-green-500' : 'bg-amber-400'}`;
      const panel2 = document.getElementById('sms-provider-info');
      if (panel2) panel2.classList.toggle('hidden', false);
      setTextEl('sms-provider-name', info2.providerName || 'Bytewave Networks');
      setTextEl('sms-api-base', info2.apiBase || '');
      setTextEl('sms-sender-display', info2.senderId ? `Sender ID: ${info2.senderId}` : 'Sender ID: (none)');
      const senderInput2 = document.getElementById('sms-sender-id');
      if (senderInput2 && info2.senderId) senderInput2.value = info2.senderId;
    } catch (_) {
      setTextEl('sms-status-text', 'Error');
    }
  }
}

async function smsSaveSettings() {
  const token = document.getElementById('sms-api-token')?.value?.trim() || '';
  const senderId = document.getElementById('sms-sender-id')?.value?.trim() || '';
  const body = {};
  if (token) body.api_token = token;
  if (senderId) body.sender_id = senderId;
  if (Object.keys(body).length === 0) return alert('Enter an API token and/or Sender ID');
  try {
    await api.smsUpdateSettings(body);
    alert('SMS settings saved!');
    const tokenInput = document.getElementById('sms-api-token');
    if (tokenInput) tokenInput.value = '';
    smsLoadStatus();
    smsLoadBalance();
  } catch (err) {
    alert('Failed: ' + (err.message || err));
  }
}

// Per-SMS cost as reported by the Bytewave gateway on real sends (KSh).
const SMS_RATE_KSH = 0.3;

async function smsLoadBalance() {
  const el = document.getElementById('sms-balance-display');
  if (el) el.textContent = '…';
  try {
    const data = await api.smsBalance();
    // Gateway payload: { ok, data: { status, message, data: { remaining_balance, expired_on } } }
    const inner = data.data || {};
    const gw = (inner.data && typeof inner.data === 'object') ? inner.data : inner;
    const amount = parseFloat(String(gw.remaining_balance ?? gw.balance ?? '').replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(amount)) {
      if (el) el.textContent = '—';
      return;
    }
    const sms = Math.floor(amount / SMS_RATE_KSH).toLocaleString('en-KE');
    const bal = amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (el) {
      el.innerHTML =
        `<span><span class="font-semibold text-slate-800">${sms}</span> <span class="text-xs text-slate-500">SMS available</span></span>` +
        `<span><span class="text-xs text-slate-500">KSh</span> <span class="font-semibold text-slate-800">${bal}</span> <span class="text-xs text-slate-500">Balance</span></span>`;
    }
  } catch (_) {
    // Always-visible widget — stay quiet on transient gateway/network errors.
    if (el) el.textContent = '—';
  }
}

async function smsSendTestMsg() {
  const phone = document.getElementById('sms-test-phone')?.value;
  const msg = document.getElementById('sms-test-msg')?.value;
  if (!phone || !msg) return alert('Enter phone and message');
  try {
    const result = await api.smsSendTest(phone, msg);
    alert(result.message || 'SMS sent!');
    smsLoadMessages();
  } catch (err) {
    alert('Failed: ' + (err.message || err));
    smsLoadMessages();
  }
}

async function smsLoadMessages(page = 1) {
  try {
    const data = await api.smsMessages({ page, limit: 20 });
    const tbody = document.getElementById('sms-messages-tbody');
    if (!tbody) return;
    const messages = data.messages || [];
    if (messages.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-slate-500">No SMS messages yet</td></tr>';
      const emptyPag = document.getElementById('sms-messages-pagination');
      if (emptyPag) emptyPag.innerHTML = '';
      return;
    }
    tbody.innerHTML = messages.map(m => {
      const body = (m.content || '').replace(/\s+/g, ' ').trim();
      const snippet = body.length > 90 ? body.slice(0, 90) + '…' : body;
      const st = (m.status || '').toLowerCase();
      const badge = ['sent', 'delivered', 'read'].includes(st)
        ? 'bg-green-900 text-green-300'
        : st === 'failed' ? 'bg-red-900 text-red-300' : 'bg-slate-700 text-slate-300';
      return `
      <tr class="text-sm">
        <td class="py-2 pr-3">${escapeHtml(m.tenant_name || m.tenant_code || '—')}</td>
        <td class="py-2 pr-3">${escapeHtml(m.message_type || 'SMS')}</td>
        <td class="py-2 pr-3"><span class="px-2 py-0.5 rounded text-xs ${badge}">${escapeHtml(m.status || '—')}</span></td>
        <td class="py-2 pr-3 text-xs text-slate-500" title="${escapeHtml(body)}">${escapeHtml(snippet) || '—'}</td>
        <td class="py-2 text-xs text-slate-400">${m.created_at ? new Date(m.created_at).toLocaleString() : '—'}</td>
      </tr>`;
    }).join('');

    const pagination = data.pagination || {};
    const totalPages = Math.max(Number(pagination.totalPages) || 1, 1);
    const pag = document.getElementById('sms-messages-pagination');
    if (!pag) return;
    if (totalPages <= 1) { pag.innerHTML = ''; return; }
    const cur = Math.min(Math.max(Number(pagination.page) || page, 1), totalPages);
    const win = 2;
    const start = Math.max(1, cur - win);
    const end = Math.min(totalPages, cur + win);
    let html = `<button class="qc-btn text-xs" ${cur <= 1 ? 'disabled' : ''} onclick="smsLoadMessages(${cur - 1})">‹ Prev</button>`;
    if (start > 1) html += `<button class="qc-btn text-xs" onclick="smsLoadMessages(1)">1</button>${start > 2 ? '<span class="text-slate-400 text-xs px-1 self-center">…</span>' : ''}`;
    for (let i = start; i <= end; i++) {
      html += `<button class="qc-btn text-xs ${i === cur ? 'qc-btn-primary' : ''}" onclick="smsLoadMessages(${i})">${i}</button>`;
    }
    if (end < totalPages) html += `${end < totalPages - 1 ? '<span class="text-slate-400 text-xs px-1 self-center">…</span>' : ''}<button class="qc-btn text-xs" onclick="smsLoadMessages(${totalPages})">${totalPages}</button>`;
    html += `<button class="qc-btn text-xs" ${cur >= totalPages ? 'disabled' : ''} onclick="smsLoadMessages(${cur + 1})">Next ›</button>`;
    html += `<span class="text-xs text-slate-400 px-1 self-center">Page ${cur} of ${totalPages}</span>`;
    pag.innerHTML = html;
  } catch (err) {
    console.error('[SMS] Messages error:', err);
  }
}

window.smsLoadStatus = smsLoadStatus;
window.smsSaveSettings = smsSaveSettings;
window.smsLoadBalance = smsLoadBalance;
window.smsSendTestMsg = smsSendTestMsg;
window.smsLoadMessages = smsLoadMessages;

// ─── Future Tenancies ──────────────────────────────────────────────────────

let _ftCurrentTenancyId = null;

async function loadFutureTenancies() {
  try {
    const status = document.getElementById('ft-filter-status')?.value || '';
    const params = {};
    if (status) params.status = status;
    const data = await api.futureTenancies(params);
    const list = data.future_tenancies || [];
    const tbody = document.getElementById('ft-tenancies-tbody');
    if (!tbody) return;
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="text-center text-slate-400 py-8">No future tenancies found</td></tr>';
      setTextEl('ft-reserved-count', 0);
      setTextEl('ft-active-count', 0);
      setTextEl('ft-total-paid', 'KES 0');
      setTextEl('ft-total-pending', 'KES 0');
      return;
    }
    tbody.innerHTML = list.map(ft => {
      const totalPaid = Number(ft.total_paid || 0);
      const totalPending = Number(ft.total_pending || 0);
      const statusBadge = ft.status === 'RESERVED' ? 'bg-amber-100 text-amber-700'
        : ft.status === 'ACTIVE' ? 'bg-green-100 text-green-700'
        : 'bg-slate-100 text-slate-500';
      return `<tr class="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onclick="openFutureTenancyDetail(${ft.id})">
        <td>${ft.property_name || '—'}</td>
        <td>${ft.unit_label || '—'}</td>
        <td>${ft.tenant_name}</td>
        <td>${ft.phone_number || '—'}</td>
        <td>${ft.allocated_month || '—'}</td>
        <td>${Number(ft.rent_amount || 0).toLocaleString('en-KE')}</td>
        <td>${Number(ft.deposit_amount || 0).toLocaleString('en-KE')}</td>
        <td class="font-semibold">${totalPaid.toLocaleString('en-KE')}</td>
        <td><span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge}">${ft.status}</span></td>
        <td class="text-right"><button class="text-xs text-blue-600 hover:underline" onclick="event.stopPropagation();openFutureTenancyDetail(${ft.id})">View</button></td>
      </tr>`;
    }).join('');

    // Update summary cards
    const reservedCount = list.filter(f => f.status === 'RESERVED').length;
    const activeCount = list.filter(f => f.status === 'ACTIVE').length;
    const totalApproved = list.reduce((s, f) => s + Number(f.total_paid || 0), 0);
    const totalPending = list.reduce((s, f) => s + Number(f.total_pending || 0), 0);
    setTextEl('ft-reserved-count', reservedCount);
    setTextEl('ft-active-count', activeCount);
    setTextEl('ft-total-paid', 'KES ' + totalApproved.toLocaleString('en-KE'));
    setTextEl('ft-total-pending', 'KES ' + totalPending.toLocaleString('en-KE'));
  } catch (err) {
    console.error('loadFutureTenancies:', err);
  }
}

async function openFutureTenancyDetail(id) {
  try {
    const data = await api.futureTenancy(id);
    const ft = data.future_tenancy;
    if (!ft) return;
    _ftCurrentTenancyId = id;
    setTextEl('ft-detail-title', `${ft.tenant_name} — ${ft.unit_label || ''} ${ft.property_name}`);
    setTextEl('ft-detail-subtitle', `Allocated to: ${ft.allocated_month} | Status: ${ft.status}`);

    // Show/hide action buttons based on status
    const actionsEl = document.getElementById('ft-actions');
    const payFormEl = document.getElementById('ft-payment-form');
    if (ft.status === 'RESERVED') {
      actionsEl?.classList.remove('hidden');
      payFormEl?.parentElement?.querySelector('button')?.classList.remove('hidden');
    } else {
      actionsEl?.classList.add('hidden');
    }

    // Load payments
    const pData = await api.futureTenancyPayments(id);
    const payments = pData.future_payments || [];
    const pTbody = document.getElementById('ft-payments-tbody');
    if (pTbody) {
      if (payments.length === 0) {
        pTbody.innerHTML = '<tr><td colspan="8" class="text-center text-slate-400 py-4">No payments recorded yet</td></tr>';
      } else {
        pTbody.innerHTML = payments.map(fp => {
          const statusBadge = fp.status === 'Approved' ? 'bg-green-100 text-green-700'
            : fp.status === 'Pending' ? 'bg-amber-100 text-amber-700'
            : 'bg-slate-100 text-slate-500';
          const actionBtns = fp.status === 'Pending'
            ? `<button onclick="approveFuturePayment(${fp.id})" class="text-xs text-green-600 hover:underline mr-2">Approve</button><button onclick="cancelFuturePaymentAction(${fp.id})" class="text-xs text-red-600 hover:underline">Cancel</button>`
            : '';
          return `<tr class="border-t border-slate-100">
            <td>${fp.payment_date || '—'}</td>
            <td class="font-semibold">${Number(fp.amount).toLocaleString('en-KE')}</td>
            <td>${fp.payment_mode || '—'}</td>
            <td>${fp.purpose || '—'}</td>
            <td>${fp.allocated_month || '—'}</td>
            <td>${fp.mpesa_reference || '—'}</td>
            <td><span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge}">${fp.status}</span></td>
            <td>${actionBtns}</td>
          </tr>`;
        }).join('');
      }
    }

    // Show detail panel
    document.getElementById('ft-detail-panel')?.classList.remove('hidden');
    document.getElementById('ft-detail-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    console.error('openFutureTenancyDetail:', err);
  }
}

function showFuturePaymentForm() {
  const form = document.getElementById('ft-payment-form');
  if (form) {
    form.classList.remove('hidden');
    // Default date to today
    document.getElementById('ft-pay-date').value = new Date().toISOString().slice(0, 10);
    // Default allocated month to current month
    document.getElementById('ft-pay-allocated').value = new Date().toISOString().slice(0, 7);
  }
}

async function submitFuturePayment() {
  if (!_ftCurrentTenancyId) return;
  const amount = Number(document.getElementById('ft-pay-amount')?.value || 0);
  const payment_date = document.getElementById('ft-pay-date')?.value;
  const payment_mode = document.getElementById('ft-pay-mode')?.value || 'Cash';
  const purpose = document.getElementById('ft-pay-purpose')?.value || 'Down Payment';
  const allocated_month = document.getElementById('ft-pay-allocated')?.value;
  const mpesa_reference = document.getElementById('ft-pay-ref')?.value || null;
  const notes = document.getElementById('ft-pay-notes')?.value || null;

  if (!amount || amount <= 0) return alert('Please enter a valid amount');
  if (!allocated_month) return alert('Please select an allocated month');

  try {
    await api.createFuturePayment(_ftCurrentTenancyId, {
      amount, payment_date, payment_mode, purpose, allocated_month, mpesa_reference, notes,
    });
    document.getElementById('ft-payment-form')?.classList.add('hidden');
    openFutureTenancyDetail(_ftCurrentTenancyId);
  } catch (err) {
    alert('Failed to record payment: ' + (err.message || err));
  }
}

async function approveFuturePayment(paymentId) {
  try {
    await api.approveFuturePayment(paymentId);
    openFutureTenancyDetail(_ftCurrentTenancyId);
  } catch (err) {
    alert('Failed to approve: ' + (err.message || err));
  }
}

async function cancelFuturePaymentAction(paymentId) {
  if (!confirm('Cancel this payment?')) return;
  try {
    await api.cancelFuturePayment(paymentId);
    openFutureTenancyDetail(_ftCurrentTenancyId);
  } catch (err) {
    alert('Failed to cancel: ' + (err.message || err));
  }
}

async function activateFutureTenancy() {
  if (!_ftCurrentTenancyId) return;
  if (!confirm('This will create an active tenant from this reservation. All approved payments will be carried forward. Continue?')) return;
  try {
    const result = await api.activateFutureTenancy(_ftCurrentTenancyId);
    alert(`Tenancy activated!\nTenant: ${result.tenant?.name}\nTotal Paid: KES ${Number(result.total_paid || 0).toLocaleString('en-KE')}\nDeposit Paid: KES ${Number(result.deposit_paid || 0).toLocaleString('en-KE')}`);
    document.getElementById('ft-detail-panel')?.classList.add('hidden');
    _ftCurrentTenancyId = null;
    loadFutureTenancies();
  } catch (err) {
    alert('Failed to activate: ' + (err.message || err));
  }
}

async function cancelFutureTenancy() {
  if (!_ftCurrentTenancyId) return;
  if (!confirm('Cancel this reservation? This cannot be undone.')) return;
  try {
    await api.cancelFutureTenancy(_ftCurrentTenancyId);
    document.getElementById('ft-detail-panel')?.classList.add('hidden');
    _ftCurrentTenancyId = null;
    loadFutureTenancies();
  } catch (err) {
    alert('Failed to cancel: ' + (err.message || err));
  }
}

async function showAddFutureTenancyModal() {
  // Populate houses dropdown for selection
  let houses = [];
  try {
    const data = await api.houses();
    houses = data.houses || [];
  } catch (_) {}

  const modal = document.createElement('div');
  modal.id = 'ft-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/50';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  const housesOptions = houses.map(h =>
    `<option value="${h.paybill_number || ''}" data-property="${h.house_name || ''}" data-unit="${h.unit_label || ''}" data-rent="${h.rent_amount || 0}" data-deposit="${h.deposit_amount || 0}">${h.house_name || ''} — ${h.paybill_number || ''}</option>`
  ).join('');

  modal.innerHTML = `
    <div class="bg-white rounded-xl p-6 max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto shadow-2xl">
      <h3 class="text-lg font-bold mb-4">Reserve a Unit — Future Tenancy</h3>
      <div class="space-y-3">
        <div>
          <label class="block text-xs font-medium text-slate-600 mb-1">Select House (optional — can enter manually below)</label>
          <select id="ft-modal-house" class="cyber-input w-full" onchange="ftModalHouseChanged(this)">
            <option value="">— Enter details manually —</option>
            ${housesOptions}
          </select>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Property Name *</label>
            <input id="ft-modal-property" type="text" class="cyber-input w-full" placeholder="e.g. Sunview Apartments" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Unit Label</label>
            <input id="ft-modal-unit" type="text" class="cyber-input w-full" placeholder="e.g. C9" />
          </div>
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-600 mb-1">Prospective Tenant Name *</label>
          <input id="ft-modal-name" type="text" class="cyber-input w-full" placeholder="e.g. JANE WAWERU" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Phone Number</label>
            <input id="ft-modal-phone" type="tel" class="cyber-input w-full" placeholder="e.g. 0712345678" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">National ID</label>
            <input id="ft-modal-nid" type="text" class="cyber-input w-full" placeholder="e.g. 12345678" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Tenant Code</label>
            <input id="ft-modal-code" type="text" class="cyber-input w-full" placeholder="e.g. T001" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Allocated Month *</label>
            <input id="ft-modal-month" type="month" class="cyber-input w-full" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Rent Amount (KES)</label>
            <input id="ft-modal-rent" type="number" class="cyber-input w-full" placeholder="e.g. 15000" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Deposit Amount (KES)</label>
            <input id="ft-modal-deposit" type="number" class="cyber-input w-full" placeholder="e.g. 10000" />
          </div>
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-600 mb-1">Notes</label>
          <input id="ft-modal-notes" type="text" class="cyber-input w-full" placeholder="Any notes..." />
        </div>
      </div>
      <div class="flex gap-2 mt-4">
        <button onclick="submitFutureTenancy()" class="qc-btn qc-btn-primary">Reserve Unit</button>
        <button onclick="document.getElementById('ft-modal').remove()" class="qc-btn">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Default allocated month to next month
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  document.getElementById('ft-modal-month').value = nextMonth.toISOString().slice(0, 7);
}

window.ftModalHouseChanged = function(sel) {
  const opt = sel.options[sel.selectedIndex];
  if (opt.value) {
    document.getElementById('ft-modal-property').value = opt.dataset.property || '';
    document.getElementById('ft-modal-unit').value = opt.dataset.unit || '';
    document.getElementById('ft-modal-rent').value = opt.dataset.rent || '';
    document.getElementById('ft-modal-deposit').value = opt.dataset.deposit || '';
  }
};

async function submitFutureTenancy() {
  const property_name = document.getElementById('ft-modal-property')?.value?.trim();
  const unit_label = document.getElementById('ft-modal-unit')?.value?.trim();
  const house_paybill = document.getElementById('ft-modal-house')?.value || null;
  const tenant_name = document.getElementById('ft-modal-name')?.value?.trim();
  const phone_number = document.getElementById('ft-modal-phone')?.value?.trim();
  const national_id = document.getElementById('ft-modal-nid')?.value?.trim();
  const tenant_code = document.getElementById('ft-modal-code')?.value?.trim();
  const allocated_month = document.getElementById('ft-modal-month')?.value;
  const rent_amount = Number(document.getElementById('ft-modal-rent')?.value || 0);
  const deposit_amount = Number(document.getElementById('ft-modal-deposit')?.value || 0);
  const notes = document.getElementById('ft-modal-notes')?.value?.trim();

  if (!property_name) return alert('Property name is required');
  if (!tenant_name) return alert('Tenant name is required');
  if (!allocated_month) return alert('Allocated month is required');

  try {
    await api.createFutureTenancy({
      property_name, unit_label, house_paybill, tenant_name, phone_number,
      national_id, tenant_code, allocated_month, rent_amount, deposit_amount, notes,
    });
    document.getElementById('ft-modal')?.remove();
    loadFutureTenancies();
  } catch (err) {
    alert('Failed to reserve unit: ' + (err.message || err));
  }
}

// Wire up filter change
document.getElementById('ft-filter-status')?.addEventListener('change', loadFutureTenancies);

// Wire up add button
document.getElementById('btn-add-future-tenancy')?.addEventListener('click', showAddFutureTenancyModal);

// Export for showView
window._ftLoadOnView = loadFutureTenancies;

// Expose house charge functions for inline onclick handlers
window.toggleHouseChargeUI = toggleHouseChargeUI;
window.deleteHouseChargeUI = deleteHouseChargeUI;
window.saveHouseCharge = saveHouseCharge;

// Expose future tenancy functions for inline onclick handlers
window.openFutureTenancyDetail = openFutureTenancyDetail;
window.submitFuturePayment = submitFuturePayment;
window.showFuturePaymentForm = showFuturePaymentForm;
window.approveFuturePayment = approveFuturePayment;
window.cancelFuturePaymentAction = cancelFuturePaymentAction;
window.activateFutureTenancy = activateFutureTenancy;
window.cancelFutureTenancy = cancelFutureTenancy;
window.submitFutureTenancy = submitFutureTenancy;

// ── Water Bill Invoices ─────────────────────────────────────────────────────

let waterBillHousesCache = [];
let waterBillCurrentTenant = null;

async function loadWaterBillInvoices() {
  const search = document.getElementById('wb-search')?.value || '';
  const status = document.getElementById('wb-status-filter')?.value || '';
  const month = document.getElementById('wb-month-filter')?.value || '';
  const property = document.getElementById('wb-property-filter')?.value || '';
  const unitFilter = document.getElementById('wb-unit-filter')?.value || '';
  const params = {};
  if (search) params.q = search;
  if (status) params.status = status;
  if (month) params.billing_month = month;
  if (property) params.house_paybill_number = property;

  try {
    const data = await api.listWaterInvoices(params);
    const tbody = document.getElementById('wb-list-tbody');
    if (!tbody) return;
    const invoices = data.water_invoices || [];
    const cachedPending = await offlineDb
      .getAll('water')
      .then((all) => (all || []).filter((r) => r && (r.sync === 'pending' || r.sync === 'failed')))
      .catch(() => []);
    const pendingRows = cachedPending.map((r) => `<tr class="border-b border-slate-800 hover:bg-slate-800/30" style="opacity:.92">
        <td class="font-mono text-xs">${escapeHtml(r.wtr_number || '(pending)')}</td>
        <td>—</td><td>—</td>
        <td>${escapeHtml(r.tenant_name || '—')}</td>
        <td>${escapeHtml(r.billing_month || '—')}</td>
        <td class="text-right font-mono font-bold">—</td>
        <td>${escapeHtml((r.created_at || '').slice(0, 10))}</td>
        <td>${offlineSyncBadge(r.sync)}</td>
        <td><span class="text-slate-500">Unpaid</span></td>
        <td class="text-right whitespace-nowrap"><span class="text-xs text-slate-500">Offline record</span></td>
      </tr>`).join('');
    const filtered = unitFilter ? invoices.filter(inv => (inv.unit_label || '').toLowerCase().includes(unitFilter.toLowerCase())) : invoices;
    if (!filtered.length && !cachedPending.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="text-center text-slate-500 py-6">No water invoices found.</td></tr>';
      return;
    }
    tbody.innerHTML = pendingRows + filtered.map(inv => {
      const statusClass = { Draft: 'text-amber-400', Finalized: 'text-blue-400', Sent: 'text-green-400', Downloaded: 'text-blue-300', Paid: 'text-green-300', Void: 'text-rose-400' }[inv.status] || 'text-slate-400';
      const actions = [];
      actions.push(`<button class="text-cyan-400 hover:text-cyan-300 px-1" onclick="viewWaterInvoice(${inv.id})">View</button>`);
      if (inv.status !== 'Paid' && inv.status !== 'Void') {
        actions.push(`<button class="text-blue-400 hover:text-blue-300 px-1" onclick="editWaterInvoice(${inv.id})">Edit</button>`);
      }
      if (inv.status !== 'Paid' && inv.status !== 'Void') {
        actions.push(`<button class="text-rose-400 hover:text-rose-300 px-1" onclick="deleteWaterInvoiceUI(${inv.id})">Delete</button>`);
      }
      if (inv.status === 'Finalized' || inv.status === 'Sent' || inv.status === 'Downloaded') {
        actions.push(`<button class="text-amber-400 hover:text-amber-300 px-1" onclick="voidWaterInvoiceUI(${inv.id})">Void</button>`);
      }
      const paymentStatus = inv.status === 'Paid' ? '<span class="text-green-300">Paid</span>' : '<span class="text-slate-500">Unpaid</span>';
      return `<tr class="border-b border-slate-800 hover:bg-slate-800/30">
        <td class="font-mono text-xs">${escapeHtml(inv.wtr_number)}</td>
        <td>${escapeHtml(inv.property_name)}</td>
        <td>${escapeHtml(inv.unit_label)}</td>
        <td>${escapeHtml(inv.tenant_name)}</td>
        <td>${escapeHtml(inv.billing_month)}</td>
        <td class="text-right font-mono font-bold">${Number(inv.total_amount).toLocaleString()}</td>
        <td>${inv.created_at ? new Date(inv.created_at).toLocaleDateString('en-GB') : ''}</td>
        <td class="${statusClass} font-semibold">${escapeHtml(inv.status)}${inv.anomaly_flag ? ` <span title="${escapeHtml(inv.anomaly_detail || inv.anomaly_flag)}">⚠️ ${escapeHtml(String(inv.anomaly_flag).toUpperCase())}</span>` : ''}</td>
        <td>${paymentStatus}</td>
        <td class="text-right whitespace-nowrap">${actions.join(' ')}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    if (!isNetworkError(err)) {
      showToast('Failed to load water invoices: ' + err.message, 'error');
      return;
    }
    const tbody = document.getElementById('wb-list-tbody');
    if (!tbody) return;
    const cached = await offlineDb.getAll('water').catch(() => []);
    if (!cached.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="text-center text-slate-500 py-6">Offline — no synced water records on this device yet.</td></tr>';
      return;
    }
    tbody.innerHTML = '<tr><td colspan="10" class="text-center text-amber-500 text-xs font-mono py-2">📴 Offline — showing last synced data</td></tr>' + cached.map((r) => `<tr class="border-b border-slate-800 hover:bg-slate-800/30" style="opacity:.92">
        <td class="font-mono text-xs">${escapeHtml(r.wtr_number || '(pending)')}</td>
        <td>—</td><td>—</td>
        <td>${escapeHtml(r.tenant_name || '—')}</td>
        <td>${escapeHtml(r.billing_month || '—')}</td>
        <td class="text-right font-mono font-bold">—</td>
        <td>${escapeHtml((r.created_at || r.synced_at || '').slice(0, 10))}</td>
        <td>${offlineSyncBadge(r.sync)}${r.anomaly_flag ? `<div class="text-[10px] text-amber-500 font-mono mt-1" title="${escapeHtml(r.anomaly_detail || '')}">⚠️ ${escapeHtml(String(r.anomaly_flag).toUpperCase())}</div>` : ''}</td>
        <td><span class="text-slate-500">Unpaid</span></td>
        <td class="text-right whitespace-nowrap"><span class="text-xs text-slate-500">Offline record</span></td>
      </tr>`).join('');
  }
}

async function populateWaterBillDropdowns() {
  // Property dropdowns (filter + form + rate management)
  try {
    const { houses } = await api.houses();
    waterBillHousesCache = houses || [];
    const filterSel = document.getElementById('wb-property-filter');
    const formSel = document.getElementById('wb-form-house');
    const rateSel = document.getElementById('wb-rate-house');
    const opts = houses.map(h => `<option value="${h.paybill_number}">${escapeHtml(h.house_name)} (${h.paybill_number})</option>`).join('');
    if (filterSel) filterSel.innerHTML = '<option value="">All Properties</option>' + opts;
    if (formSel) formSel.innerHTML = '<option value="">Select property</option>' + opts;
    if (rateSel) rateSel.innerHTML = '<option value="">Select property</option>' + opts;
  } catch (err) { /* ignore */ }
}

// Property filter
document.getElementById('wb-property-filter')?.addEventListener('change', loadWaterBillInvoices);

// Unit filter
document.getElementById('wb-unit-filter')?.addEventListener('input', debounce(loadWaterBillInvoices, 400));

// Rate management - show rate when property selected
document.getElementById('wb-rate-house')?.addEventListener('change', async function() {
  const housePaybill = this.value;
  const rateInput = document.getElementById('wb-rate-current');
  const historyDiv = document.getElementById('wb-rate-history');
  if (!housePaybill) {
    if (rateInput) rateInput.value = '';
    if (historyDiv) historyDiv.innerHTML = '';
    return;
  }
  try {
    const data = await api.getWaterRate(housePaybill);
    if (rateInput) rateInput.value = Number(data.rate_per_unit || 0).toFixed(2);
  } catch (err) { /* ignore */ }
  try {
    const data = await api.getWaterRateHistory(housePaybill);
    const history = data.history || [];
    if (historyDiv) {
      historyDiv.innerHTML = history.length
        ? history.map(h => `<div>${escapeHtml(h.effective_month)}: KES ${h.old_rate} → KES ${h.new_rate} (by ${escapeHtml(h.changed_by || 'system')})</div>`).join('')
        : '<div>No rate changes recorded.</div>';
    }
  } catch (err) { /* ignore */ }
});

document.getElementById('btn-update-water-rate')?.addEventListener('click', async function() {
  const housePaybill = document.getElementById('wb-rate-house')?.value;
  const newRate = document.getElementById('wb-rate-new')?.value;
  const month = document.getElementById('wb-rate-month')?.value;
  if (!housePaybill || !newRate) return showToast('Select property and enter new rate', 'error');
  try {
    await api.updateWaterRate(housePaybill, { rate_per_unit: Number(newRate), effective_month: month || undefined });
    showToast('Water rate updated successfully', 'success');
    document.getElementById('wb-rate-new').value = '';
    document.getElementById('wb-rate-house').dispatchEvent(new Event('change'));
  } catch (err) {
    showToast('Failed to update rate: ' + err.message, 'error');
  }
});

document.getElementById('btn-back-water-bill')?.addEventListener('click', () => showInvoiceTypeSelector());
document.getElementById('btn-new-water-bill')?.addEventListener('click', () => showWaterBillForm());

document.getElementById('wb-search')?.addEventListener('input', debounce(loadWaterBillInvoices, 400));
document.getElementById('wb-status-filter')?.addEventListener('change', loadWaterBillInvoices);
document.getElementById('wb-month-filter')?.addEventListener('change', loadWaterBillInvoices);

// ── Water Bill Form ─────────────────────────────────────────────────────────

function showWaterBillForm(invoice = null) {
  document.getElementById('wb-list-view')?.classList.add('hidden');
  document.getElementById('wb-form-view')?.classList.remove('hidden');
  waterBillCurrentTenant = null;

  document.getElementById('wb-form-id').value = invoice ? invoice.id : '';
  document.getElementById('wb-form-tenant-code').value = invoice ? invoice.tenant_code : '';
  document.getElementById('wb-form-title').textContent = invoice ? 'Edit Monthly Rent & Utility Invoice' : 'New Monthly Rent & Utility Invoice';
  document.getElementById('wb-form-submit').textContent = invoice ? 'Update Invoice' : 'Save Invoice';

  // Populate property dropdown
  const formSel = document.getElementById('wb-form-house');
  if (formSel && waterBillHousesCache.length) {
    formSel.innerHTML = '<option value="">Select property</option>' + waterBillHousesCache.map(h =>
      `<option value="${h.paybill_number}" ${invoice && invoice.house_paybill_number === h.paybill_number ? 'selected' : ''}>${escapeHtml(h.house_name)} (${h.paybill_number})</option>`
    ).join('');
  }

  if (invoice) {
    document.getElementById('wb-form-unit').value = invoice.unit_label || '';
    document.getElementById('wb-tenant-display').textContent = invoice.tenant_name || '—';
    document.getElementById('wb-billing-month').value = invoice.billing_month || '';
    document.getElementById('wb-prev-reading').value = invoice.previous_reading || '';
    document.getElementById('wb-curr-reading').value = invoice.current_reading || '';
    document.getElementById('wb-rate').value = Number(invoice.rate_per_unit).toFixed(2);
    document.getElementById('wb-rent-amount').value = Number(invoice.rent_amount || 0);
    document.getElementById('wb-garbage-fee').value = Number(invoice.garbage_fee || 0);
    document.getElementById('wb-rent-arrears').value = Number(invoice.rent_arrears || 0);
    document.getElementById('wb-water-arrears').value = Number(invoice.water_arrears || 0);
    document.getElementById('wb-garbage-arrears').value = Number(invoice.garbage_arrears || 0);
    document.getElementById('wb-other-arrears').value = Number(invoice.other_arrears || 0);
    document.getElementById('wb-notes').value = invoice.notes || '';
    waterBillCurrentTenant = { tenant_code: invoice.tenant_code, name: invoice.tenant_name, property_name: invoice.property_name, unit_label: invoice.unit_label };
    updateWaterBillArrears();
    updateWaterBillCalc();
  } else {
    document.getElementById('wb-form-unit').value = '';
    document.getElementById('wb-tenant-display').textContent = 'Enter property and unit';
    document.getElementById('wb-billing-month').value = '';
    document.getElementById('wb-prev-reading').value = '';
    document.getElementById('wb-curr-reading').value = '';
    document.getElementById('wb-rate').value = '';
    document.getElementById('wb-rent-amount').value = '';
    document.getElementById('wb-garbage-fee').value = '';
    document.getElementById('wb-rent-arrears').value = '';
    document.getElementById('wb-water-arrears').value = '';
    document.getElementById('wb-garbage-arrears').value = '';
    document.getElementById('wb-other-arrears').value = '';
    document.getElementById('wb-notes').value = '';
    document.getElementById('wb-payment-month').value = '';
    document.getElementById('wb-due-date-display').value = '';
    document.getElementById('wb-payment-terms').textContent = '—';
    document.getElementById('wb-units-display').textContent = '0';
    document.getElementById('wb-current-charges-display').textContent = 'KES 0';
    document.getElementById('wb-outstanding-display').textContent = 'KES 0';
    document.getElementById('wb-grand-total-display').textContent = 'KES 0';
  }
  document.getElementById('wb-form-result').textContent = '';
}

// Property change on form → load rate
document.getElementById('wb-form-house')?.addEventListener('change', async function() {
  const housePaybill = this.value;
  waterBillCurrentTenant = null;
  document.getElementById('wb-tenant-display').textContent = 'Enter unit number';
  document.getElementById('wb-form-unit').value = '';
  document.getElementById('wb-rate').value = '';
  document.getElementById('wb-prev-reading').value = '';
  if (!housePaybill) return;
  try {
    const data = await api.getWaterRate(housePaybill);
    document.getElementById('wb-rate').value = Number(data.rate_per_unit || 0).toFixed(2);
  } catch (err) { /* ignore */ }
});

// Unit number change → find tenant
document.getElementById('wb-form-unit')?.addEventListener('blur', async function() {
  const unitLabel = this.value.trim();
  const housePaybill = document.getElementById('wb-form-house')?.value;
  if (!housePaybill || !unitLabel) {
    waterBillCurrentTenant = null;
    document.getElementById('wb-tenant-display').textContent = 'Enter property and unit';
    document.getElementById('wb-rent-amount').value = '';
    document.getElementById('wb-garbage-fee').value = '';
    document.getElementById('wb-rent-arrears').value = '';
    document.getElementById('wb-water-arrears').value = '';
    document.getElementById('wb-garbage-arrears').value = '';
    document.getElementById('wb-other-arrears').value = '';
    updateWaterBillCalc();
    return;
  }
  try {
    const data = await api.findTenantByPropertyAndUnit(housePaybill, unitLabel);
    waterBillCurrentTenant = data.tenant;
    document.getElementById('wb-tenant-display').textContent = waterBillCurrentTenant.name;
    document.getElementById('wb-form-tenant-code').value = waterBillCurrentTenant.tenant_code;
    // Auto-fill current charges from tenant
    document.getElementById('wb-rent-amount').value = waterBillCurrentTenant.rent_amount || '';
    document.getElementById('wb-garbage-fee').value = waterBillCurrentTenant.garbage_fee_amount || '';
    // Auto-fill outstanding from tenant
    document.getElementById('wb-rent-arrears').value = waterBillCurrentTenant.arrears || '';
    document.getElementById('wb-water-arrears').value = '';
    document.getElementById('wb-garbage-arrears').value = '';
    document.getElementById('wb-other-arrears').value = '';
    // Fetch latest reading for previous
    try {
      const rData = await api.getLatestWaterReading(waterBillCurrentTenant.tenant_code);
      document.getElementById('wb-prev-reading').value = rData.current_reading || 0;
    } catch (err) { /* ignore */ }
    updateWaterBillCalc();
  } catch (err) {
    waterBillCurrentTenant = null;
    document.getElementById('wb-tenant-display').textContent = 'No active tenant found';
    document.getElementById('wb-form-tenant-code').value = '';
    document.getElementById('wb-rent-amount').value = '';
    document.getElementById('wb-garbage-fee').value = '';
    document.getElementById('wb-rent-arrears').value = '';
    document.getElementById('wb-water-arrears').value = '';
    document.getElementById('wb-garbage-arrears').value = '';
    document.getElementById('wb-other-arrears').value = '';
    updateWaterBillCalc();
  }
});

// Billing month change → calculate payment month and due date
document.getElementById('wb-billing-month')?.addEventListener('change', updateWaterBillArrears);

function updateWaterBillArrears() {
  const billingMonth = document.getElementById('wb-billing-month')?.value;
  if (!billingMonth) {
    document.getElementById('wb-payment-month').value = '';
    document.getElementById('wb-due-date-display').value = '';
    document.getElementById('wb-payment-terms').textContent = '—';
    return;
  }
  // Payment month = next month
  const parts = billingMonth.split('-');
  let payYear = Number(parts[0]);
  let payMonth = Number(parts[1]) + 1;
  if (payMonth > 12) { payMonth = 1; payYear++; }
  const paymentMonth = `${payYear}-${String(payMonth).padStart(2, '0')}`;
  const dueDate = `${payYear}-${String(payMonth).padStart(2, '0')}-05`;

  const billingLabel = new Date(`${billingMonth}-15T12:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const paymentLabel = new Date(`${paymentMonth}-15T12:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' });

  document.getElementById('wb-payment-month').value = paymentLabel;
  const dueDateObj = new Date(`${paymentMonth}-05T12:00:00`);
  const dueDateLabel = dueDateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('wb-due-date-display').value = dueDateLabel;
  const issueMonthLabel = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  document.getElementById('wb-payment-terms').textContent = `Water bill for ${billingLabel}, issued in ${issueMonthLabel}, is due on or before ${dueDateLabel}. Please ensure payment is made using the payment details provided below.`;
}

// Reading/rate changes → recalculate
['wb-prev-reading', 'wb-curr-reading', 'wb-rate', 'wb-rent-amount', 'wb-garbage-fee',
 'wb-rent-arrears', 'wb-water-arrears', 'wb-garbage-arrears', 'wb-other-arrears'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', updateWaterBillCalc);
});

function updateWaterBillCalc() {
  const prev = Number(document.getElementById('wb-prev-reading')?.value || 0);
  const curr = Number(document.getElementById('wb-curr-reading')?.value || 0);
  const rateStr = document.getElementById('wb-rate')?.value || '0';
  const rate = Number(rateStr.replace(/[^0-9.]/g, '') || 0);
  const units = curr - prev;
  const waterBill = units * rate;
  const rentAmount = Number(document.getElementById('wb-rent-amount')?.value || 0);
  const garbageFee = Number(document.getElementById('wb-garbage-fee')?.value || 0);
  const totalCurrentCharges = rentAmount + waterBill + garbageFee;
  const rentArrears = Number(document.getElementById('wb-rent-arrears')?.value || 0);
  const waterArrears = Number(document.getElementById('wb-water-arrears')?.value || 0);
  const garbageArrears = Number(document.getElementById('wb-garbage-arrears')?.value || 0);
  const otherArrears = Number(document.getElementById('wb-other-arrears')?.value || 0);
  const totalOutstanding = rentArrears + waterArrears + garbageArrears + otherArrears;
  const grandTotal = totalCurrentCharges + totalOutstanding;

  const fmt = (v) => `KES ${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  document.getElementById('wb-units-display').textContent = units >= 0 ? units.toFixed(1) : 'Invalid';
  document.getElementById('wb-current-charges-display').textContent = fmt(totalCurrentCharges);
  document.getElementById('wb-outstanding-display').textContent = fmt(totalOutstanding);
  document.getElementById('wb-grand-total-display').textContent = fmt(grandTotal);
  // Live anomaly screen (Phase 3) — same rules as the server.
  try { renderWaterAnomalyWarn(); } catch (_) {}
}

/** History of per-bill consumption for the form's tenant (cached invoices). */
function currentWaterAnomaly(historyUnits) {
  const prev = Number(document.getElementById('wb-prev-reading')?.value || 0);
  const curr = Number(document.getElementById('wb-curr-reading')?.value || 0);
  return detectWaterAnomaly({ previous: prev, current: curr, history: historyUnits || [] });
}

async function cachedWaterHistoryUnits() {
  const code = waterBillCurrentTenant?.tenant_code;
  if (!code) return [];
  const cached = await offlineDb.getAll('water').catch(() => []);
  // Server rows lack per-row readings in cache; use units where stored,
  // else fall back to consumption derived from consecutive readings.
  const rows = (cached || []).filter((w) => w && w.tenant_code === code && w.sync === 'synced');
  const units = [];
  for (const w of rows) {
    if (w.units_used != null) units.push(Number(w.units_used));
  }
  return units.slice(0, 6);
}

async function renderWaterAnomalyWarn() {
  const el = document.getElementById('wb-anomaly-warn');
  if (!el) return;
  const history = await cachedWaterHistoryUnits();
  const a = currentWaterAnomaly(history);
  if (a.level === 'ok' || !a.code) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.classList.remove('hidden');
  if (a.level === 'reject') {
    el.style.cssText = 'background:#450a0a;border:1px solid #ef4444;color:#fecaca';
    el.textContent = '⛔ ' + a.message;
  } else {
    el.style.cssText = 'background:#451a03;border:1px solid #f59e0b;color:#fde68a';
    el.textContent = '⚠️ ' + a.message;
  }
}

// Form submit
document.getElementById('water-bill-form')?.addEventListener('submit', async function(e) {
  e.preventDefault();
  const resultEl = document.getElementById('wb-form-result');
  if (!waterBillCurrentTenant) {
    resultEl.textContent = 'Please select a valid property and unit with an active tenant.';
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    return;
  }
  const rateStr = document.getElementById('wb-rate')?.value || '0';
  const rate = Number(rateStr.replace(/[^0-9.]/g, '') || 0);
  const billingMonth = document.getElementById('wb-billing-month')?.value;
  if (!billingMonth) {
    resultEl.textContent = 'Please select a billing month.';
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    return;
  }
  // Calculate payment month and due date
  const parts = billingMonth.split('-');
  let payYear = Number(parts[0]);
  let payMonth = Number(parts[1]) + 1;
  if (payMonth > 12) { payMonth = 1; payYear++; }
  const paymentMonth = `${payYear}-${String(payMonth).padStart(2, '0')}`;
  const dueDate = `${paymentMonth}-05`;
  const billingLabel = new Date(`${billingMonth}-15T12:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const paymentLabel = new Date(`${paymentMonth}-15T12:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const issueMonthLabel = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const paymentTerms = `Water bill for ${billingLabel}, issued in ${issueMonthLabel}, is due on or before the 5th of ${paymentLabel}. Please ensure payment is made using the payment details provided below.`;

  const unitsUsed = Number(document.getElementById('wb-curr-reading')?.value || 0) - Number(document.getElementById('wb-prev-reading')?.value || 0);
  const waterBill = unitsUsed * rate;
  const rentAmount = Number(document.getElementById('wb-rent-amount')?.value || 0);
  const garbageFee = Number(document.getElementById('wb-garbage-fee')?.value || 0);
  const totalCurrentCharges = rentAmount + waterBill + garbageFee;
  const rentArrears = Number(document.getElementById('wb-rent-arrears')?.value || 0);
  const waterArrears = Number(document.getElementById('wb-water-arrears')?.value || 0);
  const garbageArrears = Number(document.getElementById('wb-garbage-arrears')?.value || 0);
  const otherArrears = Number(document.getElementById('wb-other-arrears')?.value || 0);
  const totalOutstanding = rentArrears + waterArrears + garbageArrears + otherArrears;
  const grandTotal = totalCurrentCharges + totalOutstanding;

  const autoNotes = `Water charges for ${billingLabel} are calculated from the recorded meter readings using the applicable water rate of KSh ${rate.toLocaleString('en-US', { minimumFractionDigits: 2 })} per unit. Total consumption recorded is ${unitsUsed} units, resulting in a water bill of KSh ${waterBill.toLocaleString('en-US', { minimumFractionDigits: 2 })}. This invoice also includes the applicable rent, garbage fee and any previous outstanding balance.`;

  const body = {
    tenant_code: waterBillCurrentTenant.tenant_code,
    billing_month: billingMonth,
    payment_month: paymentMonth,
    previous_reading: Number(document.getElementById('wb-prev-reading')?.value || 0),
    current_reading: Number(document.getElementById('wb-curr-reading')?.value || 0),
    rate_per_unit: rate,
    due_date: dueDate,
    payment_terms: paymentTerms,
    notes: document.getElementById('wb-notes')?.value?.trim() || autoNotes,
    rent_amount: rentAmount,
    garbage_fee: garbageFee,
    rent_arrears: rentArrears,
    water_arrears: waterArrears,
    garbage_arrears: garbageArrears,
    other_arrears: otherArrears,
  };
  const id = document.getElementById('wb-form-id')?.value;
  try {
    if (id) {
      await api.updateWaterInvoice(id, body);
      resultEl.textContent = 'Invoice updated successfully.';
      resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
      setTimeout(() => { cancelWaterBillForm(); loadWaterBillInvoices(); }, 1200);
    } else {
      showWaterBillReview(body, waterBillCurrentTenant);
    }
  } catch (err) {
    resultEl.textContent = 'Error: ' + err.message;
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
});

function showWaterBillReview(body, tenant) {
  const units = body.current_reading - body.previous_reading;
  const waterBill = units * body.rate_per_unit;
  const rentAmount = Number(body.rent_amount || 0);
  const garbageFee = Number(body.garbage_fee || 0);
  const totalCurrentCharges = rentAmount + waterBill + garbageFee;
  const rentArrears = Number(body.rent_arrears || 0);
  const waterArrears = Number(body.water_arrears || 0);
  const garbageArrears = Number(body.garbage_arrears || 0);
  const otherArrears = Number(body.other_arrears || 0);
  const totalOutstanding = rentArrears + waterArrears + garbageArrears + otherArrears;
  const grandTotal = totalCurrentCharges + totalOutstanding;
  const billingLabel = new Date(`${body.billing_month}-15T12:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const paymentLabel = body.payment_month ? new Date(`${body.payment_month}-15T12:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' }) : '';
  const houseName = waterBillHousesCache.find(h => h.paybill_number === (tenant.house_id || tenant.house_paybill_number))?.house_name || '';
  const fmt = (v) => `KES ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

  const html = `
    <div class="grid grid-cols-2 gap-3">
      <div class="bg-slate-800/50 rounded p-2"><span class="text-slate-400">Tenant:</span> <span class="text-white font-semibold">${escapeHtml(tenant.name)}</span></div>
      <div class="bg-slate-800/50 rounded p-2"><span class="text-slate-400">Property:</span> <span class="text-white">${escapeHtml(houseName)}</span></div>
      <div class="bg-slate-800/50 rounded p-2"><span class="text-slate-400">Unit:</span> <span class="text-white">${escapeHtml(tenant.unit_label || '')}</span></div>
      <div class="bg-slate-800/50 rounded p-2"><span class="text-slate-400">Billing Month:</span> <span class="text-white">${escapeHtml(billingLabel)}</span></div>
      <div class="bg-slate-800/50 rounded p-2"><span class="text-slate-400">Payment Month:</span> <span class="text-white">${escapeHtml(paymentLabel)}</span></div>
      <div class="bg-slate-800/50 rounded p-2"><span class="text-slate-400">Due Date:</span> <span class="text-white">${body.due_date || 'N/A'}</span></div>
    </div>

    <div class="text-xs font-semibold text-cyan-400 uppercase mt-3 mb-2">Current Charges</div>
    <div class="grid grid-cols-2 gap-3">
      <div class="bg-slate-800/50 rounded p-2"><span class="text-slate-400">Rent:</span> <span class="text-white font-semibold">${fmt(rentAmount)}</span></div>
      <div class="bg-slate-800/50 rounded p-2"><span class="text-slate-400">Garbage Fee:</span> <span class="text-white font-semibold">${fmt(garbageFee)}</span></div>
      <div class="bg-slate-800/50 rounded p-2"><span class="text-slate-400">Water:</span> <span class="text-cyan-400 font-mono font-bold">${fmt(waterBill)} (${units} units × KES ${Number(body.rate_per_unit).toFixed(2)})</span></div>
      <div class="bg-cyan-900/30 border border-cyan-600 rounded p-2"><span class="text-cyan-300">Total Current:</span> <span class="text-cyan-400 font-bold">${fmt(totalCurrentCharges)}</span></div>
    </div>

    <div class="text-xs font-semibold text-amber-400 uppercase mt-3 mb-2">Previous Outstanding</div>
    <div class="grid grid-cols-2 gap-3">
      <div class="bg-slate-800/50 rounded p-2"><span class="text-slate-400">Rent Arrears:</span> <span class="text-white">${fmt(rentArrears)}</span></div>
      <div class="bg-slate-800/50 rounded p-2"><span class="text-slate-400">Water Arrears:</span> <span class="text-white">${fmt(waterArrears)}</span></div>
      <div class="bg-slate-800/50 rounded p-2"><span class="text-slate-400">Garbage Arrears:</span> <span class="text-white">${fmt(garbageArrears)}</span></div>
      <div class="bg-slate-800/50 rounded p-2"><span class="text-slate-400">Other Arrears:</span> <span class="text-white">${fmt(otherArrears)}</span></div>
      <div class="bg-amber-900/30 border border-amber-600 rounded p-2 col-span-2"><span class="text-amber-300">Total Outstanding:</span> <span class="text-amber-400 font-bold">${fmt(totalOutstanding)}</span></div>
    </div>

    <div class="bg-slate-800/50 border-2 border-cyan-600 rounded-lg p-4 text-center mt-3">
      <div class="text-sm text-slate-300">TOTAL AMOUNT PAYABLE</div>
      <div class="text-2xl font-bold text-cyan-400">${fmt(grandTotal)}</div>
    </div>

    <div class="bg-slate-800/30 rounded p-3 text-xs text-slate-300 mt-3">${escapeHtml(body.payment_terms || '')}</div>
  `;
  document.getElementById('wb-review-content').innerHTML = html;
  document.getElementById('wb-review-modal').style.display = 'flex';
  document.getElementById('wb-review-modal').dataset.body = JSON.stringify(body);
}

document.getElementById('btn-close-wb-review')?.addEventListener('click', function() {
  document.getElementById('wb-review-modal').style.display = 'none';
});

document.getElementById('btn-confirm-wb-issue')?.addEventListener('click', async function() {
  const body = JSON.parse(document.getElementById('wb-review-modal').dataset.body || '{}');
  const resultEl = document.getElementById('wb-form-result');
  // Anomaly gate (Phase 3): rejections block here too, so a bad reading
  // can never be queued offline nor posted online.
  try {
    const history = await cachedWaterHistoryUnits();
    const anomaly = currentWaterAnomaly(history);
    if (anomaly.level === 'reject') {
      resultEl.textContent = '⛔ ' + anomaly.message;
      resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
      return;
    }
    if (anomaly.level === 'warn' && !confirm(`⚠️ Unusual reading\n\n${anomaly.message}\n\nSave anyway?`)) {
      return;
    }
    body.anomaly_flag = anomaly.level === 'warn' ? anomaly.code : null;
    body.anomaly_detail = anomaly.level === 'warn' ? anomaly.message : null;
  } catch (_) {}
  // Offline: queue the reading (PENDING SYNC). Previous-reading validation
  // re-runs server-side on sync against live data.
  if (effectiveOffline()) {
    try {
      const clientTxnId = offlineDb.newClientTxnId();
      await queueOutboxOp({ type: 'water_create', payload: { ...body, client_txn_id: clientTxnId } });
      await offlineDb.put('water', {
        key: `pending:${clientTxnId}`,
        client_txn_id: clientTxnId,
        server_id: null,
        wtr_number: '(pending)',
        tenant_code: body.tenant_code || '',
        tenant_name: body.tenant_name || '',
        billing_month: body.billing_month || '',
        current_reading: Number(body.current_reading || 0),
        sync: 'pending',
        created_at: new Date().toISOString(),
      });
      document.getElementById('wb-review-modal').style.display = 'none';
      resultEl.textContent = '🟠 Reading saved offline — PENDING SYNC. Will upload when internet returns.';
      resultEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
      showToast('Water reading saved offline (PENDING SYNC)');
      setTimeout(() => { cancelWaterBillForm(); try { loadWaterBillInvoices(); } catch (_) {} }, 1200);
    } catch (err) {
      resultEl.textContent = 'Offline save failed: ' + err.message;
      resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
    return;
  }
  try {
    const data = await api.createWaterInvoice(body);
    if (data.water_invoice) {
      await api.finalizeWaterInvoice(data.water_invoice.id);
    }
    document.getElementById('wb-review-modal').style.display = 'none';
    resultEl.textContent = 'Invoice created and finalized.';
    resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    setTimeout(() => { cancelWaterBillForm(); loadWaterBillInvoices(); }, 1200);
  } catch (err) {
    resultEl.textContent = 'Error: ' + err.message;
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
});

function cancelWaterBillForm() {
  document.getElementById('wb-form-view')?.classList.add('hidden');
  document.getElementById('wb-list-view')?.classList.remove('hidden');
  document.getElementById('water-bill-form')?.reset();
  waterBillCurrentTenant = null;
}

document.getElementById('btn-cancel-water-bill')?.addEventListener('click', cancelWaterBillForm);

async function editWaterInvoice(id) {
  try {
    const data = await api.getWaterInvoice(id);
    if (data.water_invoice) showWaterBillForm(data.water_invoice);
  } catch (err) {
    showToast('Failed to load invoice: ' + err.message, 'error');
  }
}

async function viewWaterInvoice(id) {
  try {
    const data = await api.getWaterInvoice(id);
    const inv = data.water_invoice;
    if (!inv) return;
    const units = Number(inv.units_used).toFixed(1);
    const rate = Number(inv.rate_per_unit).toFixed(2);
    const billingLabel = new Date(`${inv.billing_month}-15T12:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const paymentLabel = inv.payment_month ? new Date(`${inv.payment_month}-15T12:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' }) : '';
    const dueDateLabel = (() => {
      const m = String(inv.due_date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return 'N/A';
      const day = Number(m[3]); const month = Number(m[2]); const year = Number(m[1]);
      const months = ['','January','February','March','April','May','June','July','August','September','October','November','December'];
      const ord = (n) => {
        if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
        switch (n % 10) { case 1: return `${n}st`; case 2: return `${n}nd`; case 3: return `${n}rd`; default: return `${n}th`; }
      };
      return `${ord(day)} ${months[month]} ${year}`;
    })();
    const statusClass = { Draft: 'text-amber-400', Finalized: 'text-blue-400', Sent: 'text-green-400', Paid: 'text-green-300', Void: 'text-rose-400' }[inv.status] || 'text-slate-400';
    const fmt = (v) => `KES ${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const waterBill = Number(inv.units_used) * Number(inv.rate_per_unit);
    const rentAmount = Number(inv.rent_amount || 0);
    const garbageFee = Number(inv.garbage_fee || 0);
    const totalCurrentCharges = rentAmount + waterBill + garbageFee;
    const rentArrears = Number(inv.rent_arrears || 0);
    const waterArrears = Number(inv.water_arrears || 0);
    const garbageArrears = Number(inv.garbage_arrears || 0);
    const otherArrears = Number(inv.other_arrears || 0);
    const totalOutstanding = rentArrears + waterArrears + garbageArrears + otherArrears;
    const grandTotal = totalCurrentCharges + totalOutstanding;

    document.getElementById('wb-detail-title').textContent = `Monthly Rent & Utility Invoice — ${inv.wtr_number}`;
    document.getElementById('wb-detail-content').innerHTML = `
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Invoice No:</span><br><span class="text-black font-mono font-semibold">${escapeHtml(inv.wtr_number)}</span></div>
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Status:</span><br><span class="${statusClass} font-semibold">${escapeHtml(inv.status)}</span></div>
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Tenant:</span><br><span class="text-black font-semibold">${escapeHtml(inv.tenant_name)}</span></div>
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Property:</span><br><span class="text-black">${escapeHtml(inv.property_name)}</span></div>
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Unit:</span><br><span class="text-black">${escapeHtml(inv.unit_label)}</span></div>
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Billing Month:</span><br><span class="text-black">${escapeHtml(billingLabel)}</span></div>
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Payment Month:</span><br><span class="text-black">${escapeHtml(paymentLabel)}</span></div>
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Due Date:</span><br><span class="text-black">${dueDateLabel}</span></div>
      </div>

      <div class="text-xs font-bold text-blue-700 uppercase mt-3 mb-2 border-b-2 border-blue-700 pb-1">Current Charges</div>
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Rent:</span><br><span class="text-black font-semibold">${fmt(rentAmount)}</span></div>
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Garbage Fee:</span><br><span class="text-black font-semibold">${fmt(garbageFee)}</span></div>
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Water:</span><br><span class="text-blue-700 font-mono font-bold">${fmt(waterBill)} (${units} units × KES ${rate})</span></div>
        <div class="bg-blue-50 border-2 border-blue-600 rounded p-2"><span class="text-blue-700 text-xs font-bold">Total Current:</span><br><span class="text-blue-800 font-bold text-lg">${fmt(totalCurrentCharges)}</span></div>
      </div>

      <div class="text-xs font-bold text-amber-700 uppercase mt-3 mb-2 border-b-2 border-amber-600 pb-1">Previous Outstanding</div>
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Rent Arrears:</span><br><span class="text-black">${fmt(rentArrears)}</span></div>
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Water Arrears:</span><br><span class="text-black">${fmt(waterArrears)}</span></div>
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Garbage Arrears:</span><br><span class="text-black">${fmt(garbageArrears)}</span></div>
        <div class="bg-white border border-gray-200 rounded p-2"><span class="text-gray-500 text-xs">Other Arrears:</span><br><span class="text-black">${fmt(otherArrears)}</span></div>
        <div class="bg-amber-50 border-2 border-amber-500 rounded p-2 col-span-2"><span class="text-amber-700 text-xs font-bold">Total Outstanding:</span><br><span class="text-amber-800 font-bold text-lg">${fmt(totalOutstanding)}</span></div>
      </div>

      <div class="bg-blue-800 border-2 border-blue-900 rounded-lg p-4 text-center mt-3">
        <div class="text-sm text-blue-200 font-semibold">TOTAL AMOUNT PAYABLE</div>
        <div class="text-2xl font-bold text-white">${fmt(grandTotal)}</div>
      </div>
    `;
    const termsDiv = document.getElementById('wb-detail-payment-terms');
    if (inv.payment_terms) {
      termsDiv.innerHTML = `<strong>Payment Terms:</strong> ${escapeHtml(inv.payment_terms)}`;
      termsDiv.classList.remove('hidden');
    } else {
      termsDiv.classList.add('hidden');
    }
    document.getElementById('wb-detail-modal').style.display = 'flex';
    document.getElementById('wb-detail-modal').dataset.invoiceId = inv.id;
    document.getElementById('wb-detail-modal').dataset.invoiceStatus = inv.status;
    const downloadBtn = document.getElementById('btn-download-wb');
    const sendBtn = document.getElementById('btn-send-wb');
    if (downloadBtn) downloadBtn.style.display = '';
    if (sendBtn) sendBtn.style.display = '';
    let existingEdit = document.getElementById('btn-edit-wb-detail');
    let existingDel = document.getElementById('btn-delete-wb-detail');
    let existingVoid = document.getElementById('btn-void-wb-detail');
    if (existingEdit) existingEdit.remove();
    if (existingDel) existingDel.remove();
    if (existingVoid) existingVoid.remove();
    const btnRow = downloadBtn?.parentElement;
    if (btnRow) {
      if (inv.status !== 'Paid' && inv.status !== 'Void') {
        const editBtn = document.createElement('button');
        editBtn.type = 'button'; editBtn.id = 'btn-edit-wb-detail';
        editBtn.className = 'qc-btn qc-btn-primary text-sm'; editBtn.textContent = 'Edit';
        editBtn.onclick = () => { document.getElementById('wb-detail-modal').style.display = 'none'; editWaterInvoice(inv.id); };
        btnRow.insertBefore(editBtn, downloadBtn);
        const delBtn = document.createElement('button');
        delBtn.type = 'button'; delBtn.id = 'btn-delete-wb-detail';
        delBtn.className = 'qc-btn text-sm'; delBtn.style.background = '#dc2626'; delBtn.style.color = 'white'; delBtn.textContent = 'Delete';
        delBtn.onclick = () => { document.getElementById('wb-detail-modal').style.display = 'none'; deleteWaterInvoiceUI(inv.id); };
        btnRow.insertBefore(delBtn, downloadBtn);
      }
      if (inv.status === 'Finalized' || inv.status === 'Sent' || inv.status === 'Downloaded') {
        const voidBtn = document.createElement('button');
        voidBtn.type = 'button'; voidBtn.id = 'btn-void-wb-detail';
        voidBtn.className = 'qc-btn text-sm'; voidBtn.style.background = '#d97706'; voidBtn.style.color = 'white'; voidBtn.textContent = 'Void';
        voidBtn.onclick = () => { document.getElementById('wb-detail-modal').style.display = 'none'; voidWaterInvoiceUI(inv.id); };
        btnRow.insertBefore(voidBtn, downloadBtn);
      }
    }
  } catch (err) {
    showToast('Failed to load invoice: ' + err.message, 'error');
  }
}

document.getElementById('btn-close-wb-detail')?.addEventListener('click', function() {
  document.getElementById('wb-detail-modal').style.display = 'none';
});

document.getElementById('btn-download-wb')?.addEventListener('click', async function() {
  const id = document.getElementById('wb-detail-modal')?.dataset.invoiceId;
  if (!id) return;
  try {
    const result = await api.downloadWaterInvoice(id);
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a'); a.href = url; a.download = result.filename || 'water-invoice.pdf'; a.click();
    URL.revokeObjectURL(url);
    loadWaterBillInvoices();
  } catch (err) {
    showToast('Download failed: ' + err.message, 'error');
  }
});

document.getElementById('btn-send-wb')?.addEventListener('click', async function() {
  const id = document.getElementById('wb-detail-modal')?.dataset.invoiceId;
  if (!id) return;
  if (!confirm('Send this water invoice via WhatsApp to the tenant?')) return;
  try {
    await api.sendWaterInvoice(id);
    showToast('Water invoice sent successfully', 'success');
    document.getElementById('wb-detail-modal').style.display = 'none';
    loadWaterBillInvoices();
  } catch (err) {
    showToast('Send failed: ' + err.message, 'error');
  }
});

async function deleteWaterInvoiceUI(id) {
  if (!confirm('Delete this water invoice?')) return;
  try {
    await api.deleteWaterInvoice(id);
    showToast('Water invoice deleted', 'success');
    loadWaterBillInvoices();
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

async function voidWaterInvoiceUI(id) {
  const reason = prompt('Reason for voiding this invoice:');
  if (reason === null) return;
  try {
    await api.voidWaterInvoice(id, reason);
    showToast('Water invoice voided', 'success');
    loadWaterBillInvoices();
  } catch (err) {
    showToast('Void failed: ' + err.message, 'error');
  }
}

// Expose water bill functions for inline onclick handlers
window.viewWaterInvoice = viewWaterInvoice;
window.editWaterInvoice = editWaterInvoice;
window.deleteWaterInvoiceUI = deleteWaterInvoiceUI;
window.voidWaterInvoiceUI = voidWaterInvoiceUI;
