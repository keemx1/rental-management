/**
 * @fileoverview Baileys WhatsApp provider implementation.
 * Uses @whiskeysockets/baileys for the WhatsApp Web multi-device API.
 * Provides full session persistence, auto-reconnect, and production-grade error handling.
 * @module whatsapp/baileys-provider
 */

'use strict';

const { WhatsAppProvider } = require('./provider');
const { toWhatsAppJid } = require('./phone');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

/** @typedef {'disconnected'|'connecting'|'qr_required'|'authenticating'|'connected'} ConnectionState */

const SESSION_DIR = path.join(__dirname, 'sessions');
const RECONNECT_DELAY_MS = 5000;

/**
 * Baileys-based WhatsApp provider.
 * Connects to WhatsApp via the multi-device web protocol, persists auth state,
 * converts QR codes to base64 PNG, and handles automatic reconnection.
 * @extends WhatsAppProvider
 */
class BaileysWhatsAppProvider extends WhatsAppProvider {
  constructor() {
    super();

    /** @type {Object|null} Baileys socket instance */
    this.sock = null;

    /** @type {Object|null} Auth state credentials from useMultiFileAuthState */
    this.authState = null;

    /** @type {Function|null} Callback to persist credential updates */
    this.saveCreds = null;

    /** @type {ConnectionState} Current connection state */
    this.state = 'disconnected';

    /** @type {string|null} Current QR code as base64 data URL */
    this.qrCode = null;

    /** @type {NodeJS.Timeout|null} Reconnect timer handle */
    this._reconnectTimer = null;

    /** @type {boolean} True if disconnect() or logout() was called intentionally */
    this._intentionalClose = false;

    /** @type {Object|null} Latest Baileys version info */
    this._version = null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialize the provider: load auth state, fetch Baileys version, and connect.
   * @returns {Promise<void>}
   */
  async initialize() {
    this._intentionalClose = false;
    this._ensureSessionDir();

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    this.authState = state;
    this.saveCreds = saveCreds;

    const { version } = await fetchLatestBaileysVersion();
    this._version = version;

    this._setState('connecting');
    this._createSocket();
  }

  /**
   * Disconnect from WhatsApp gracefully.
   * Does NOT clear auth state (session can be resumed).
   * @returns {Promise<void>}
   */
  async disconnect() {
    this._intentionalClose = true;
    this._clearReconnectTimer();

    if (this.sock) {
      try {
        await this.sock.end();
      } catch (_) { /* ignore */ }
      this.sock = null;
    }

    this.authState = null;
    this.saveCreds = null;
    this.qrCode = null;
    this._setState('disconnected');
    this.emit('disconnected');
  }

  /**
   * Logout and destroy the session permanently.
   * Calls sock.logout() then removes stored auth files.
   * @returns {Promise<void>}
   */
  async logout() {
    this._intentionalClose = true;
    this._clearReconnectTimer();

    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (_) { /* ignore – session may already be invalid */ }
      try {
        await this.sock.end();
      } catch (_) { /* ignore */ }
      this.sock = null;
    }

    this.authState = null;
    this.saveCreds = null;
    this.qrCode = null;

    this._clearSessionFiles();
    this._setState('disconnected');
    this.emit('disconnected');
  }

  /**
   * Destroy the socket and release resources (alias for cleanup).
   * Safe to call even if already disconnected.
   * @returns {Promise<void>}
   */
  async destroy() {
    this._intentionalClose = true;
    this._clearReconnectTimer();

    if (this.sock) {
      try {
        await this.sock.end();
      } catch (_) { /* ignore */ }
      this.sock = null;
    }

    this.authState = null;
    this.saveCreds = null;
    this.qrCode = null;
    this._setState('disconnected');
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  /**
   * Get the current connection status.
   * @returns {{state: ConnectionState, info: Object|null}}
   */
  getStatus() {
    let info = null;
    if (this.state === 'connected' && this.sock?.user) {
      info = {
        phone: this.sock.user.id?.replace(/:.*$/, '').replace('@s.whatsapp.net', ''),
        name: this.sock.user.name,
        platform: this.sock.user.platform,
      };
    }
    return { state: this.state, info };
  }

  /**
   * Get the current QR code as a base64 data URL, or null.
   * @returns {string|null}
   */
  getQRCode() {
    return this.qrCode;
  }

  /**
   * Get session information if connected.
   * @returns {{phone: string, name: string, platform: string}|null}
   */
  getSessionInfo() {
    if (this.state !== 'connected' || !this.sock?.user) return null;
    const u = this.sock.user;
    return {
      phone: u.id?.replace(/:.*$/, '').replace('@s.whatsapp.net', ''),
      name: u.name || '',
      platform: u.platform || '',
    };
  }

  // ─── Messaging ─────────────────────────────────────────────────────────────

  /**
   * Send a text message.
   * @param {string} phone - Recipient phone number (international format without +)
   * @param {string} text - Message text
   * @returns {Promise<{success: boolean, id: string}>}
   */
  async sendText(phone, text) {
    const jid = this._resolveJid(phone);
    const result = await this.sock.sendMessage(jid, { text });
    return { success: true, id: result.key.id };
  }

  /**
   * Send a media message (image, audio, video).
   * @param {string} phone - Recipient phone number
   * @param {Buffer} buffer - Media buffer
   * @param {string} mimetype - MIME type (e.g. 'image/png')
   * @param {string} [filename] - Optional filename
   * @returns {Promise<{success: boolean, id: string}>}
   */
  async sendMedia(phone, buffer, mimetype, filename) {
    const jid = this._resolveJid(phone);
    const result = await this.sock.sendMessage(jid, {
      image: buffer,
      mimetype,
      fileName: filename || 'file',
    });
    return { success: true, id: result.key.id };
  }

  /**
   * Send a document/file.
   * @param {string} phone - Recipient phone number
   * @param {Buffer} buffer - Document buffer
   * @param {string} mimetype - MIME type (e.g. 'application/pdf')
   * @param {string} filename - Filename
   * @returns {Promise<{success: boolean, id: string}>}
   */
  async sendDocument(phone, buffer, mimetype, filename) {
    const jid = this._resolveJid(phone);
    const result = await this.sock.sendMessage(jid, {
      document: buffer,
      mimetype,
      fileName: filename,
    });
    return { success: true, id: result.key.id };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Create the Baileys socket and attach all event handlers.
   * @private
   */
  _createSocket() {
    this.sock = makeWASocket({
      auth: this.authState,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['GEHPM Rental Management', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: false,
      version: this._version,
    });

    this._attachHandlers();
  }

  /**
   * Attach Baileys event handlers to the socket.
   * @private
   */
  _attachHandlers() {
    const sock = this.sock;

    // ── Connection / QR ──────────────────────────────────────────────────
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this._handleQr(qr);
      }

      if (connection === 'open') {
        this._setState('connected');
        this.qrCode = null;
        this._clearReconnectTimer();
        this.emit('connected');
        return;
      }

      if (connection === 'connecting') {
        this._setState('connecting');
        return;
      }

      if (connection === 'close') {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        // Logged-out or forbidden – do not reconnect
        if (
          statusCode === DisconnectReason.loggedOut ||
          statusCode === DisconnectReason.forbidden
        ) {
          this._intentionalClose = true;
          this._setState('disconnected');
          this.emit('disconnected');
          return;
        }

        // Intentional disconnect – do not reconnect
        if (this._intentionalClose) {
          this._setState('disconnected');
          this.emit('disconnected');
          return;
        }

        // Unexpected close – schedule reconnect
        this._setState('disconnected');
        this.emit('disconnected');
        this._scheduleReconnect();
      }
    });

    // ── Credential persistence ───────────────────────────────────────────
    sock.ev.on('creds.update', () => {
      if (this.saveCreds) {
        this.saveCreds().catch((err) => {
          console.error('[BaileysWhatsApp] Failed to save credentials:', err.message);
        });
      }
    });

    // ── Incoming messages ────────────────────────────────────────────────
    sock.ev.on('messages.upsert', (event) => {
      if (event.type !== 'notify') return;

      for (const msg of event.messages) {
        // Skip messages sent by the bot itself
        if (msg.key.fromMe) continue;

        const { remoteJid, id } = msg.key;
        const message = msg.message || {};
        const text =
          message.conversation ||
          message.extendedTextMessage?.text ||
          '';

        this.emit('message', {
          from: remoteJid,
          text,
          id,
          timestamp: msg.messageTimestamp,
        });
      }
    });
  }

  /**
   * Convert a raw QR string to a base64 PNG data URL and emit/store it.
   * @private
   * @param {string} qr - Raw QR string from Baileys
   */
  async _handleQr(qr) {
    try {
      const dataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
      this.qrCode = dataUrl;
      this._setState('qr_required');
      this.emit('qr', dataUrl);
    } catch (err) {
      console.error('[BaileysWhatsApp] QR code conversion failed:', err.message);
    }
  }

  /**
   * Schedule a reconnection attempt after RECONNECT_DELAY_MS.
   * @private
   */
  _scheduleReconnect() {
    this._clearReconnectTimer();
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._intentionalClose) return;

      try {
        this._setState('connecting');
        this.emit('state_change', this.state);

        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        this.authState = state;
        this.saveCreds = saveCreds;

        const { version } = await fetchLatestBaileysVersion();
        this._version = version;

        this._createSocket();
      } catch (err) {
        console.error('[BaileysWhatsApp] Reconnect failed:', err.message);
        this._scheduleReconnect();
      }
    }, RECONNECT_DELAY_MS);
  }

  /**
   * Clear the reconnect timer if active.
   * @private
   */
  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * Normalize a phone number to a WhatsApp JID.
   * Throws if the number is invalid.
   * @private
   * @param {string} phone
   * @returns {string} WhatsApp JID
   */
  _resolveJid(phone) {
    const jid = toWhatsAppJid(phone);
    if (!jid) {
      throw new Error(`Invalid phone number: ${phone}`);
    }
    return jid;
  }

  /**
   * Set internal state and emit a state_change event.
   * @private
   * @param {ConnectionState} newState
   */
  _setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    this.emit('state_change', newState);
  }

  /**
   * Ensure the sessions directory exists.
   * @private
   */
  _ensureSessionDir() {
    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }
  }

  /**
   * Remove all files inside the session directory.
   * @private
   */
  _clearSessionFiles() {
    if (!fs.existsSync(SESSION_DIR)) return;

    const entries = fs.readdirSync(SESSION_DIR, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(SESSION_DIR, entry.name);
      try {
        if (entry.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      } catch (_) { /* best effort */ }
    }
  }
}

module.exports = { BaileysWhatsAppProvider };
