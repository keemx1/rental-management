/**
 * GEHPM offline session — cached credentials (Phase 1).
 *
 * After one successful ONLINE login, the session (token + user + timestamp)
 * is cached in localStorage. If the device goes offline, the agent can keep
 * working for up to OFFLINE_SESSION_DAYS (7) without re-authenticating.
 *
 * Sensitive, system-wide actions ALWAYS require a live connection
 * (see requireOnline() + ONLINE_ONLY_ACTIONS) — the cached session only
 * unlocks normal day-to-day operations.
 */
import { api } from './api.js';

const SESSION_AT_KEY = 'gehm_session_cached_at';
const OFFLINE_SESSION_DAYS = 7;

function stampSession() {
  try {
    localStorage.setItem(SESSION_AT_KEY, new Date().toISOString());
  } catch (_) {}
}

function clearSessionStamp() {
  try {
    localStorage.removeItem(SESSION_AT_KEY);
  } catch (_) {}
}

function sessionAgeDays() {
  try {
    const raw = localStorage.getItem(SESSION_AT_KEY);
    if (!raw) return Infinity;
    const ageMs = Date.now() - new Date(raw).getTime();
    if (Number.isNaN(ageMs) || ageMs < 0) return Infinity;
    return ageMs / (1000 * 60 * 60 * 24);
  } catch (_) {
    return Infinity;
  }
}

/** True when a cached session exists, is fresh (< 7 days) and has a user. */
function hasUsableOfflineSession() {
  if (!api.getToken() || !api.getUser()) return false;
  return sessionAgeDays() <= OFFLINE_SESSION_DAYS;
}

function offlineSessionDaysLeft() {
  const left = OFFLINE_SESSION_DAYS - sessionAgeDays();
  if (!Number.isFinite(left) || left < 0) return 0;
  return Math.floor(left);
}

// ─── Online-only gates ─────────────────────────────────────────────────────
// Highly sensitive actions that must never run offline (§14 of the spec).
const ONLINE_ONLY_HINTS = {
  users: 'User & permission management requires an internet connection.',
  settings: 'Changing system settings requires an internet connection.',
  deleteFinancial: 'Deleting financial records requires an internet connection.',
  adjustments: 'Financial adjustments require an internet connection.',
};

/**
 * Returns true when online; otherwise shows a toast/alert and returns false.
 * Pass a `via` object with an `offline()` predicate (sync-engine) when
 * available — falls back to navigator.onLine.
 */
function requireOnline(kind, isOfflineFn, notify) {
  const offline = typeof isOfflineFn === 'function' ? isOfflineFn() : !navigator.onLine;
  if (!offline) return true;
  const msg = ONLINE_ONLY_HINTS[kind] || 'This action requires an internet connection.';
  if (typeof notify === 'function') notify(msg, 'error');
  else alert(msg);
  return false;
}

export {
  stampSession,
  clearSessionStamp,
  hasUsableOfflineSession,
  offlineSessionDaysLeft,
  requireOnline,
  OFFLINE_SESSION_DAYS,
};
