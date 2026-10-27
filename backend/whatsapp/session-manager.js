'use strict';

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');

const SESSIONS_DIR = path.join(__dirname, 'sessions');

const STATES = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  QR_REQUIRED: 'QR_REQUIRED',
  AUTHENTICATING: 'AUTHENTICATING',
  CONNECTED: 'CONNECTED',
  DISCONNECTING: 'DISCONNECTING',
  ERROR: 'ERROR',
};

// ─── Transient session-file locks ────────────────────────────────────────────
// Windows (Defender real-time scanning, backup tools) can momentarily lock the
// Baileys session JSON files. These errors surface AFTER WhatsApp has accepted
// the message for relay — the message IS delivered (pre-retry-fix "Failed"
// sends arrived at the tenant; retrying them duplicated messages). THEREFORE:
// exactly ONE send attempt, always. A lock-class error returns a soft success
// without an id so callers log Sent (unconfirmed) instead of Failed, and no
// caller fallback path can re-send the same message.
function isTransientLockError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  return err.code === 'EBUSY'
    || err.code === 'EACCES'
    || /operation not permitted, open /i.test(msg)
    || /resource busy/i.test(msg);
}

async function sendWithSoftLock(fn) {
  try {
    return await fn();
  } catch (err) {
    if (isTransientLockError(err)) {
      return { id: null, unconfirmed: true, lockError: String(err.message || err) };
    }
    throw err;
  }
}

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this._provider = null;
    this._state = STATES.DISCONNECTED;
    this._qrCode = null;
    this._sessionInfo = null;
    this._connectedAt = null;
    this._error = null;
    this._initialized = false;
  }

  // ─── Getters ─────────────────────────────────────────────────────────────

  getProvider() {
    return this._provider;
  }

  getProviderType() {
    return 'baileys';
  }

  getState() {
    return this._state;
  }

  getStateInfo() {
    return {
      state: this._state,
      qrCode: this._qrCode,
      sessionInfo: this._sessionInfo,
      connectedAt: this._connectedAt,
      error: this._error,
    };
  }

  // ─── State Machine ───────────────────────────────────────────────────────

  _setState(newState, extra = {}) {
    const prev = this._state;
    this._state = newState;
    Object.assign(this, extra);
    this.emit('stateChange', { previous: prev, current: newState, ...extra });
  }

  async _persistState() {
    try {
      const { pool } = require('../config/database');
      if (pool && typeof pool.query === 'function') {
        await pool.query(
          `INSERT INTO whatsapp_sessions (state, session_info, connected_at, updated_at)
           VALUES ($1, $2, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET state = $1, session_info = $2, connected_at = $3, updated_at = NOW()`,
          [this._state, JSON.stringify(this._sessionInfo), this._connectedAt]
        );
      }
    } catch {
      // DB not available or table missing — silent fail is acceptable
    }
  }

  // ─── Provider Factory ────────────────────────────────────────────────────

  _createProvider() {
    const { BaileysWhatsAppProvider } = require('./baileys-provider');
    return new BaileysWhatsAppProvider();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  async connect(force = false) {
    if (!force && (this._state === STATES.CONNECTING || this._state === STATES.CONNECTED)) {
      return;
    }

    // If forcing reconnection, disconnect existing provider first
    if (force && this._provider) {
      try {
        this._intentionalClose = false;
        await this._provider.disconnect();
      } catch (_) { /* ignore */ }
      this._provider = null;
    }

    this._setState(STATES.CONNECTING);
    this._error = null;

    try {
      this._provider = this._createProvider();

      this._provider.on('qr', (qrData) => {
        this._setState(STATES.QR_REQUIRED, { _qrCode: qrData });
        this.emit('qr', qrData);
      });

      this._provider.on('connected', (info) => {
        this._setState(STATES.CONNECTED, {
          _sessionInfo: info,
          _connectedAt: new Date(),
          _qrCode: null,
        });
        this._persistState();
        this.emit('connected', info);
      });

      this._provider.on('disconnected', (reason) => {
        this._setState(STATES.DISCONNECTED, { _sessionInfo: null, _connectedAt: null });
        this._persistState();
        this.emit('disconnected', reason);
      });

      this._provider.on('auth_failure', (msg) => {
        this._setState(STATES.ERROR, { _error: msg });
        this._persistState();
        this.emit('auth_failure', msg);
      });

      this._provider.on('message', (msg) => {
        this.emit('message', msg);
      });

      this._provider.on('receipt', (receipt) => {
        this.emit('receipt', receipt);
        this._applyReceipt(receipt).catch((err) => {
          console.error('[WhatsApp] Receipt update failed:', err.message);
        });
      });

      await this._provider.initialize();
    } catch (err) {
      this._setState(STATES.ERROR, { _error: err.message });
      this.emit('error', err);
      throw err;
    }
  }

  // ─── Delivery Receipts ──────────────────────────────────────────────────

  /**
   * Apply a WhatsApp delivery receipt to every log that stores the provider
   * message id. Statuses only ever move forward (never downgrade a read
   * message back to delivered, or a delivered message back to failed).
   * @param {{id: string, status: 'delivered'|'read'|'failed'}} receipt
   */
  async _applyReceipt({ id, status }) {
    if (!id || !status) return;
    const { pool } = require('../config/database');
    if (!pool || typeof pool.query !== 'function') return;

    if (status === 'delivered') {
      await pool.query(
        `UPDATE message_logs SET status = 'Delivered'
         WHERE whatsapp_message_id = $1 AND status NOT IN ('Delivered', 'Read')`,
        [id]
      );
      await pool.query(
        `UPDATE whatsapp_message_log SET status = 'delivered'
         WHERE provider_message_id = $1 AND status NOT IN ('delivered', 'read')`,
        [id]
      );
      await pool.query(
        `UPDATE whatsapp_message_queue SET status = 'delivered', updated_at = NOW()
         WHERE provider_message_id = $1 AND status = 'sent'`,
        [id]
      );
    } else if (status === 'read') {
      await pool.query(
        `UPDATE message_logs SET status = 'Read'
         WHERE whatsapp_message_id = $1 AND status <> 'Read'`,
        [id]
      );
      await pool.query(
        `UPDATE whatsapp_message_log SET status = 'read'
         WHERE provider_message_id = $1 AND status <> 'read'`,
        [id]
      );
      await pool.query(
        `UPDATE whatsapp_message_queue SET status = 'delivered', updated_at = NOW()
         WHERE provider_message_id = $1 AND status IN ('sent', 'delivered')`,
        [id]
      );
    } else if (status === 'failed') {
      await pool.query(
        `UPDATE message_logs SET status = 'Failed', failure_reason = 'WhatsApp delivery failed'
         WHERE whatsapp_message_id = $1 AND status NOT IN ('Failed', 'Delivered', 'Read')`,
        [id]
      );
      await pool.query(
        `UPDATE whatsapp_message_log SET status = 'failed'
         WHERE provider_message_id = $1 AND status NOT IN ('failed', 'delivered', 'read')`,
        [id]
      );
      await pool.query(
        `UPDATE whatsapp_message_queue SET status = 'failed', updated_at = NOW()
         WHERE provider_message_id = $1 AND status = 'sent'`,
        [id]
      );
    }
  }

  async disconnect() {
    if (this._provider && this._state !== STATES.DISCONNECTED) {
      this._setState(STATES.DISCONNECTING);
      try {
        await this._provider.disconnect();
      } catch {
        // swallow
      }
      this._setState(STATES.DISCONNECTED, { _sessionInfo: null, _connectedAt: null });
      this._persistState();
      this._provider = null;
    }
  }

  async logout() {
    if (this._provider) {
      try {
        await this._provider.logout();
      } catch {
        // swallow
      }
    }
    this._provider = null;
    this._setState(STATES.DISCONNECTED, {
      _sessionInfo: null,
      _connectedAt: null,
      _qrCode: null,
      _error: null,
    });
    this._persistState();

    // Clear session files
    try {
      if (fs.existsSync(SESSIONS_DIR)) {
        const files = fs.readdirSync(SESSIONS_DIR);
        for (const f of files) {
          fs.unlinkSync(path.join(SESSIONS_DIR, f));
        }
      }
    } catch {
      // silent
    }
  }

  // ─── Messaging ───────────────────────────────────────────────────────────

  async sendText(phone, text) {
    if (this._state !== STATES.CONNECTED || !this._provider) {
      throw new Error('WhatsApp session is not connected');
    }
    return sendWithSoftLock(() => this._provider.sendText(phone, text));
  }

  async sendMedia(phone, buffer, mimetype, filename) {
    if (this._state !== STATES.CONNECTED || !this._provider) {
      throw new Error('WhatsApp session is not connected');
    }
    return sendWithSoftLock(() => this._provider.sendMedia(phone, buffer, mimetype, filename));
  }

  async sendDocument(phone, buffer, mimetype, filename) {
    if (this._state !== STATES.CONNECTED || !this._provider) {
      throw new Error('WhatsApp session is not connected');
    }
    return sendWithSoftLock(() => this._provider.sendDocument(phone, buffer, mimetype, filename));
  }

  async sendBulk(messages) {
    if (this._state !== STATES.CONNECTED || !this._provider) {
      throw new Error('WhatsApp session is not connected');
    }
    const results = [];
    for (let i = 0; i < messages.length; i++) {
      const { phone, text } = messages[i];
      const result = await sendWithSoftLock(() => this._provider.sendText(phone, text));
      results.push(result);
      if (i < messages.length - 1) {
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    return results;
  }

  // ─── Auto-Connect on Startup ─────────────────────────────────────────────

  async autoConnect() {
    if (this._initialized) return;
    this._initialized = true;

    const hasSession = fs.existsSync(SESSIONS_DIR) &&
      fs.readdirSync(SESSIONS_DIR).length > 0;

    if (hasSession) {
      try {
        await this.connect();
      } catch {
        // will be in ERROR state
      }
    }
  }
}

const sessionManager = new SessionManager();
// Exposed for tests/diagnostics: transient session-file lock classification.
sessionManager.isTransientLockError = isTransientLockError;
module.exports = sessionManager;
