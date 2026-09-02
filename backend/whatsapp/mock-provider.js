/**
 * @fileoverview Mock WhatsApp provider for testing.
 * Simulates connection lifecycle and message sending without a real WhatsApp connection.
 * @module whatsapp/mock-provider
 */

const { WhatsAppProvider } = require('./provider');
const QRCode = require('qrcode');

/** @typedef {'disconnected'|'connecting'|'qr_required'|'authenticating'|'connected'} MockState */

/**
 * Mock WhatsApp provider for test mode.
 * Simulates the full connection lifecycle: DISCONNECTED → CONNECTING → QR_REQUIRED → CONNECTED.
 * Stores all sent messages in `this.sentMessages` for assertions.
 * @extends WhatsAppProvider
 */
class MockWhatsAppProvider extends WhatsAppProvider {
  constructor() {
    super();

    /** @type {MockState} */
    this.state = 'disconnected';

    /** @type {string|null} Current QR code data */
    this.qrCode = null;

    /** @type {Array<{phone: string, text?: string, buffer?: Buffer, mimetype?: string, filename?: string, type: string, timestamp: number}>} */
    this.sentMessages = [];

    /** @type {NodeJS.Timeout|null} */
    this._qrTimeout = null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialize the mock provider.
   * Transitions: DISCONNECTED → CONNECTING → (after 1s) QR_REQUIRED → (after 5s) CONNECTED
   * @returns {Promise<void>}
   */
  async initialize() {
    this.state = 'connecting';
    this.emit('state_change', this.state);

    await this._delay(1000);

    this.state = 'qr_required';

    // Generate a real QR code image (base64 data URL) from a mock WhatsApp link
    const mockLink = `https://wa.me/qr/mock_${Date.now()}`;
    this.qrCode = await QRCode.toDataURL(mockLink, { width: 256, margin: 2 });
    this.emit('state_change', this.state);
    this.emit('qr', this.qrCode);

    // Auto-connect after 10 seconds of QR display (longer for user to "scan")
    this._qrTimeout = setTimeout(() => {
      this._completeAuth();
    }, 10000);
  }

  /**
   * Disconnect the mock provider.
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (this._qrTimeout) {
      clearTimeout(this._qrTimeout);
      this._qrTimeout = null;
    }
    this.state = 'disconnected';
    this.qrCode = null;
    this.emit('state_change', this.state);
    this.emit('disconnected');
  }

  /**
   * Logout the mock provider (same as disconnect for mocks).
   * @returns {Promise<void>}
   */
  async logout() {
    await this.disconnect();
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  /**
   * Get the current mock connection status.
   * @returns {{state: MockState, info: null}}
   */
  getStatus() {
    return { state: this.state, info: null };
  }

  /**
   * Get the current mock QR code data.
   * @returns {string|null}
   */
  getQRCode() {
    return this.qrCode;
  }

  /**
   * Get mock session information.
   * @returns {{phone: string, name: string, platform: string}}
   */
  getSessionInfo() {
    return {
      phone: '254700000000',
      name: 'Mock Account',
      platform: 'Mock',
    };
  }

  // ─── Messaging ─────────────────────────────────────────────────────────────

  /**
   * Send a mock text message.
   * @param {string} phone - Recipient phone number
   * @param {string} text - Message text
   * @returns {Promise<{success: boolean, id: string}>}
   */
  async sendText(phone, text) {
    const entry = {
      type: 'text',
      phone,
      text,
      timestamp: Date.now(),
    };
    this.sentMessages.push(entry);
    console.log(`[MockWhatsApp] TEXT → ${phone}: ${text}`);
    return { success: true, id: `mock_${Date.now()}` };
  }

  /**
   * Send a mock media message.
   * @param {string} phone - Recipient phone number
   * @param {Buffer} buffer - Media buffer
   * @param {string} mimetype - MIME type
   * @param {string} [filename] - Optional filename
   * @returns {Promise<{success: boolean, id: string}>}
   */
  async sendMedia(phone, buffer, mimetype, filename) {
    const entry = {
      type: 'media',
      phone,
      buffer,
      mimetype,
      filename,
      timestamp: Date.now(),
    };
    this.sentMessages.push(entry);
    console.log(`[MockWhatsApp] MEDIA → ${phone}: ${mimetype} (${filename || 'unnamed'})`);
    return { success: true, id: `mock_${Date.now()}` };
  }

  /**
   * Send a mock document.
   * @param {string} phone - Recipient phone number
   * @param {Buffer} buffer - Document buffer
   * @param {string} mimetype - MIME type
   * @param {string} filename - Filename
   * @returns {Promise<{success: boolean, id: string}>}
   */
  async sendDocument(phone, buffer, mimetype, filename) {
    const entry = {
      type: 'document',
      phone,
      buffer,
      mimetype,
      filename,
      timestamp: Date.now(),
    };
    this.sentMessages.push(entry);
    console.log(`[MockWhatsApp] DOC → ${phone}: ${filename} (${mimetype})`);
    return { success: true, id: `mock_${Date.now()}` };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Complete the mock authentication flow.
   * @private
   */
  _completeAuth() {
    this._qrTimeout = null;
    this.state = 'authenticating';
    this.emit('state_change', this.state);

    // Short delay then connected
    setTimeout(() => {
      this.state = 'connected';
      this.qrCode = null;
      this.emit('state_change', this.state);
      this.emit('connected');
    }, 200);
  }

  /**
   * Promise-based delay.
   * @private
   * @param {number} ms - Milliseconds to wait
   * @returns {Promise<void>}
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { MockWhatsAppProvider };
