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
    return (process.env.WHATSAPP_LINKED_PROVIDER || 'mock').toLowerCase();
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
    const type = this.getProviderType();
    if (type === 'baileys') {
      const { BaileysWhatsAppProvider } = require('./baileys-provider');
      return new BaileysWhatsAppProvider();
    }
    const { MockWhatsAppProvider } = require('./mock-provider');
    return new MockWhatsAppProvider();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  async connect() {
    if (this._state === STATES.CONNECTING || this._state === STATES.CONNECTED) {
      return;
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

      await this._provider.initialize();
    } catch (err) {
      this._setState(STATES.ERROR, { _error: err.message });
      this.emit('error', err);
      throw err;
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
    return this._provider.sendText(phone, text);
  }

  async sendMedia(phone, buffer, mimetype, filename) {
    if (this._state !== STATES.CONNECTED || !this._provider) {
      throw new Error('WhatsApp session is not connected');
    }
    return this._provider.sendMedia(phone, buffer, mimetype, filename);
  }

  async sendDocument(phone, buffer, mimetype, filename) {
    if (this._state !== STATES.CONNECTED || !this._provider) {
      throw new Error('WhatsApp session is not connected');
    }
    return this._provider.sendDocument(phone, buffer, mimetype, filename);
  }

  async sendBulk(messages) {
    if (this._state !== STATES.CONNECTED || !this._provider) {
      throw new Error('WhatsApp session is not connected');
    }
    const results = [];
    for (let i = 0; i < messages.length; i++) {
      const { phone, text } = messages[i];
      const result = await this._provider.sendText(phone, text);
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
module.exports = sessionManager;
