'use strict';

const { pool } = require('../config/database');
const { renderTemplate } = require('./templates');
const sessionManager = require('./session-manager');

// ─── Event Constants ────────────────────────────────────────────────────────

const EVENTS = {
  TENANT_CREATED: 'tenant_created',
  RENT_INVOICE_CREATED: 'rent_invoice_created',
  RENT_DUE_SOON: 'rent_due_soon',
  RENT_DUE_TODAY: 'rent_due_today',
  RENT_OVERDUE: 'rent_overdue',
  PAYMENT_RECEIVED: 'payment_received',
  RECEIPT_CREATED: 'receipt_created',
  MAINTENANCE_CREATED: 'maintenance_created',
  MAINTENANCE_ASSIGNED: 'maintenance_assigned',
  MAINTENANCE_COMPLETED: 'maintenance_completed',
  MAINTENANCE_STATUS_CHANGED: 'maintenance_status_changed',
  GENERAL_ANNOUNCEMENT: 'general_announcement',
};

// ─── Settings Bootstrap ─────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  auto_welcome_tenant: 'true',
  auto_rent_invoice: 'true',
  auto_rent_reminder: 'true',
  auto_overdue_rent: 'true',
  auto_payment_received: 'true',
  auto_maintenance_created: 'true',
  auto_maintenance_updates: 'true',
  auto_general_announcement: 'true',
  rent_reminder_days_before: '3',
  rent_overdue_days_after: '1',
};

async function ensureSettings() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_settings (
      id SERIAL PRIMARY KEY,
      setting_key VARCHAR(64) UNIQUE NOT NULL,
      setting_value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query(
      `INSERT INTO whatsapp_settings (setting_key, setting_value)
       VALUES ($1, $2)
       ON CONFLICT (setting_key) DO NOTHING`,
      [key, value]
    );
  }
}

ensureSettings().catch(() => {});

// ─── Setting Helpers ────────────────────────────────────────────────────────

async function getSetting(key) {
  const result = await pool.query(
    `SELECT setting_value FROM whatsapp_settings WHERE setting_key = $1`,
    [key]
  );
  return result.rows[0]?.setting_value ?? null;
}

async function getSettingBool(key) {
  const val = await getSetting(key);
  return val === 'true';
}

async function getSettingInt(key) {
  const val = await getSetting(key);
  return parseInt(val, 10) || 0;
}

// ─── Event → Setting Map ────────────────────────────────────────────────────

const EVENT_SETTING_MAP = {
  [EVENTS.TENANT_CREATED]: 'auto_welcome_tenant',
  [EVENTS.RENT_INVOICE_CREATED]: 'auto_rent_invoice',
  [EVENTS.RENT_DUE_SOON]: 'auto_rent_reminder',
  [EVENTS.RENT_DUE_TODAY]: 'auto_rent_reminder',
  [EVENTS.RENT_OVERDUE]: 'auto_overdue_rent',
  [EVENTS.PAYMENT_RECEIVED]: 'auto_payment_received',
  [EVENTS.RECEIPT_CREATED]: 'auto_payment_received',
  [EVENTS.MAINTENANCE_CREATED]: 'auto_maintenance_created',
  [EVENTS.MAINTENANCE_ASSIGNED]: 'auto_maintenance_updates',
  [EVENTS.MAINTENANCE_COMPLETED]: 'auto_maintenance_updates',
  [EVENTS.MAINTENANCE_STATUS_CHANGED]: 'auto_maintenance_updates',
  [EVENTS.GENERAL_ANNOUNCEMENT]: 'auto_general_announcement',
};

// ─── Event → Template Map ───────────────────────────────────────────────────

function getTemplateKeyForEvent(eventKey) {
  switch (eventKey) {
    case EVENTS.TENANT_CREATED: return 'WELCOME_TENANT';
    case EVENTS.PAYMENT_RECEIVED:
    case EVENTS.RECEIPT_CREATED: return 'PAYMENT_RECEIVED';
    case EVENTS.RENT_DUE_SOON:
    case EVENTS.RENT_DUE_TODAY:
    case EVENTS.RENT_OVERDUE: return 'RENT_REMINDER';
    case EVENTS.RENT_INVOICE_CREATED: return 'RENT_INVOICE';
    case EVENTS.MAINTENANCE_CREATED: return 'MAINTENANCE_RECEIVED';
    case EVENTS.MAINTENANCE_ASSIGNED:
    case EVENTS.MAINTENANCE_COMPLETED:
    case EVENTS.MAINTENANCE_STATUS_CHANGED: return 'MAINTENANCE_UPDATED';
    case EVENTS.GENERAL_ANNOUNCEMENT: return 'GENERAL_ANNOUNCEMENT';
    default: return null;
  }
}

// ─── Build Variables ────────────────────────────────────────────────────────

function buildVariables(eventKey, data) {
  const vars = {};

  switch (eventKey) {
    case EVENTS.TENANT_CREATED: {
      vars.tenant_name = data.name || data.tenant_name || '';
      vars.property_name = data.property_name || '';
      vars.unit_number = data.unit_label || data.unit_number || '';
      vars.rent_amount = data.rent_amount || '';
      vars.move_in_date = data.move_in_date || data.created_at || '';
      vars.phone_number = data.phone_number || '';
      break;
    }

    case EVENTS.PAYMENT_RECEIVED:
    case EVENTS.RECEIPT_CREATED: {
      vars.tenant_name = data.tenant_name || data.name || '';
      vars.property_name = data.property_name || '';
      vars.unit_number = data.unit_number || data.unit_label || '';
      vars.amount = data.amount || data.payment_amount || '';
      vars.reference = data.reference || data.receipt_number || '';
      vars.balance = data.balance || data.remaining_balance || '0';
      vars.phone_number = data.phone_number || '';
      break;
    }

    case EVENTS.RENT_DUE_SOON:
    case EVENTS.RENT_DUE_TODAY:
    case EVENTS.RENT_OVERDUE: {
      vars.tenant_name = data.tenant_name || data.name || '';
      vars.amount = data.amount || data.rent_amount || '';
      vars.due_date = data.due_date || data.rent_due_date || '';
      vars.property_name = data.property_name || '';
      vars.unit_number = data.unit_number || data.unit_label || '';
      vars.phone_number = data.phone_number || '';
      break;
    }

    case EVENTS.RENT_INVOICE_CREATED: {
      vars.tenant_name = data.tenant_name || data.name || '';
      vars.property_name = data.property_name || '';
      vars.unit_number = data.unit_number || data.unit_label || '';
      vars.amount = data.amount || data.rent_amount || '';
      vars.due_date = data.due_date || data.rent_due_date || '';
      vars.phone_number = data.phone_number || '';
      break;
    }

    case EVENTS.MAINTENANCE_CREATED:
    case EVENTS.MAINTENANCE_ASSIGNED:
    case EVENTS.MAINTENANCE_COMPLETED:
    case EVENTS.MAINTENANCE_STATUS_CHANGED: {
      vars.tenant_name = data.tenant_name || data.name || '';
      vars.request_id = data.request_id || data.id || '';
      vars.description = data.description || data.issue || '';
      vars.status = data.status || '';
      vars.technician = data.technician || data.assigned_to || '';
      vars.phone_number = data.phone_number || '';
      break;
    }

    case EVENTS.GENERAL_ANNOUNCEMENT: {
      vars.message = data.message || '';
      break;
    }
  }

  return vars;
}

// ─── Class ──────────────────────────────────────────────────────────────────

class NotificationEngine {
  constructor(_sessionManager) {
    this._sm = _sessionManager || sessionManager;
  }

  async isEnabled(eventKey) {
    const settingKey = EVENT_SETTING_MAP[eventKey];
    if (!settingKey) return false;
    return getSettingBool(settingKey);
  }

  async trigger(eventKey, data = {}) {
    const enabled = await this.isEnabled(eventKey);
    if (!enabled) return null;

    const templateKey = getTemplateKeyForEvent(eventKey);
    if (!templateKey) return null;

    const variables = buildVariables(eventKey, data);
    const phoneNumber = variables.phone_number;

    if (!phoneNumber) {
      console.warn(`[NotificationEngine] No phone_number for event ${eventKey}, skipping`);
      return null;
    }

    const { enqueue } = require('./message-queue');
    return enqueue({
      tenantCode: data.tenant_code || null,
      phoneNumber,
      templateKey,
      variables,
    });
  }

  async sendImmediate(phoneNumber, message) {
    if (!phoneNumber || !message) throw new Error('phoneNumber and message are required');
    return this._sm.sendText(phoneNumber, message);
  }

  async sendBulk(phones, templateKey, variables = {}) {
    const { enqueue } = require('./message-queue');
    const ids = [];
    for (const phone of phones) {
      const id = await enqueue({
        phoneNumber: phone,
        templateKey,
        variables,
      });
      ids.push(id);
    }
    return ids;
  }
}

module.exports = NotificationEngine;
