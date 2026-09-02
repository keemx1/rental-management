/**
 * @fileoverview WhatsApp provider abstraction layer.
 * Defines the base class that all WhatsApp providers must extend.
 * @module whatsapp/provider
 */

/**
 * @typedef {Object} SessionStatus
 * @property {'disconnected'|'connecting'|'qr_required'|'authenticating'|'connected'} state
 * @property {Object|null} info - Additional session info
 */

/**
 * @typedef {Object} SendMessageResult
 * @property {boolean} success
 * @property {string} id - Message ID
 */

/**
 * Base class for WhatsApp providers.
 * All providers must extend this class and implement the required methods.
 * @abstract
 */
class WhatsAppProvider {
  constructor() {
    if (new.target === WhatsAppProvider) {
      throw new Error('WhatsAppProvider is abstract and cannot be instantiated directly');
    }
    /** @type {Object<string, Function[]>} */
    this._listeners = {};
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialize the provider and establish connection.
   * @abstract
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('Not implemented');
  }

  /**
   * Disconnect from the provider gracefully.
   * @abstract
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('Not implemented');
  }

  /**
   * Logout and destroy the session permanently.
   * @abstract
   * @returns {Promise<void>}
   */
  async logout() {
    throw new Error('Not implemented');
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  /**
   * Get the current connection status.
   * @returns {SessionStatus}
   */
  getStatus() {
    return { state: 'disconnected', info: null };
  }

  /**
   * Get the current QR code data (base64 string or null).
   * @returns {string|null}
   */
  getQRCode() {
    return null;
  }

  /**
   * Get session information (phone, name, platform, etc.).
   * @returns {Object|null}
   */
  getSessionInfo() {
    return null;
  }

  // ─── Messaging ─────────────────────────────────────────────────────────────

  /**
   * Send a text message.
   * @abstract
   * @param {string} phone - Recipient phone number (international format without +)
   * @param {string} text - Message text
   * @returns {Promise<SendMessageResult>}
   */
  async sendText(phone, text) {
    throw new Error('Not implemented');
  }

  /**
   * Send a media message (image, audio, video).
   * @abstract
   * @param {string} phone - Recipient phone number
   * @param {Buffer} buffer - Media buffer
   * @param {string} mimetype - MIME type (e.g. 'image/png')
   * @param {string} [filename] - Optional filename
   * @returns {Promise<SendMessageResult>}
   */
  async sendMedia(phone, buffer, mimetype, filename) {
    throw new Error('Not implemented');
  }

  /**
   * Send a document/file.
   * @abstract
   * @param {string} phone - Recipient phone number
   * @param {Buffer} buffer - Document buffer
   * @param {string} mimetype - MIME type (e.g. 'application/pdf')
   * @param {string} filename - Filename
   * @returns {Promise<SendMessageResult>}
   */
  async sendDocument(phone, buffer, mimetype, filename) {
    throw new Error('Not implemented');
  }

  // ─── Events ────────────────────────────────────────────────────────────────

  /**
   * Register an event listener.
   * @param {string} event - Event name
   * @param {Function} callback - Event handler
   */
  on(event, callback) {
    if (!this._listeners[event]) {
      this._listeners[event] = [];
    }
    this._listeners[event].push(callback);
  }

  /**
   * Remove an event listener.
   * @param {string} event - Event name
   * @param {Function} callback - Event handler to remove
   */
  off(event, callback) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
  }

  /**
   * Emit an event to all registered listeners.
   * @param {string} event - Event name
   * @param {...*} args - Event arguments
   */
  emit(event, ...args) {
    if (!this._listeners[event]) return;
    for (const callback of this._listeners[event]) {
      callback(...args);
    }
  }
}

module.exports = { WhatsAppProvider };
