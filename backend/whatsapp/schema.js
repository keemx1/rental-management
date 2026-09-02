'use strict';

const { pool, testConnection } = require('../config/database');

async function applyWhatsAppSchema() {
  await testConnection();

  const statements = [
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'whatsapp_message_queue') THEN
        CREATE TABLE whatsapp_message_queue (
          id SERIAL PRIMARY KEY,
          tenant_code VARCHAR(32),
          phone_number VARCHAR(20) NOT NULL,
          template_key VARCHAR(64),
          variables JSONB DEFAULT '{}',
          raw_message TEXT,
          status VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','delivered','failed','cancelled')),
          priority INTEGER DEFAULT 0,
          attempts INTEGER DEFAULT 0,
          max_attempts INTEGER DEFAULT 3,
          error_message TEXT,
          provider_message_id VARCHAR(128),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          sent_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      END IF;
    END $$;`,

    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'whatsapp_settings') THEN
        CREATE TABLE whatsapp_settings (
          id SERIAL PRIMARY KEY,
          setting_key VARCHAR(64) UNIQUE NOT NULL,
          setting_value TEXT,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      END IF;
    END $$;`,

    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'whatsapp_message_log') THEN
        CREATE TABLE whatsapp_message_log (
          id SERIAL PRIMARY KEY,
          tenant_code VARCHAR(32),
          phone_number VARCHAR(20) NOT NULL,
          direction VARCHAR(10) NOT NULL DEFAULT 'outbound' CHECK (direction IN ('inbound','outbound')),
          message_type VARCHAR(32) DEFAULT 'text',
          content TEXT,
          status VARCHAR(20) DEFAULT 'sent',
          provider_message_id VARCHAR(128),
          error_message TEXT,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      END IF;
    END $$;`,

    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'whatsapp_sessions') THEN
        CREATE TABLE whatsapp_sessions (
          id SERIAL PRIMARY KEY,
          provider VARCHAR(32) NOT NULL DEFAULT 'baileys',
          status VARCHAR(32) NOT NULL DEFAULT 'disconnected',
          phone_number VARCHAR(20),
          display_name VARCHAR(128),
          connected_at TIMESTAMPTZ,
          disconnected_at TIMESTAMPTZ,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      END IF;
    END $$;`,

    `CREATE INDEX IF NOT EXISTS idx_wa_queue_status ON whatsapp_message_queue(status);`,
    `CREATE INDEX IF NOT EXISTS idx_wa_queue_priority ON whatsapp_message_queue(priority, created_at);`,
    `CREATE INDEX IF NOT EXISTS idx_wa_log_tenant ON whatsapp_message_log(tenant_code);`,
    `CREATE INDEX IF NOT EXISTS idx_wa_log_created ON whatsapp_message_log(created_at);`,

    // Insert default settings if not present
    `INSERT INTO whatsapp_settings (setting_key, setting_value) VALUES
      ('auto_welcome_tenant', 'true'),
      ('auto_rent_invoice', 'true'),
      ('auto_rent_reminder', 'true'),
      ('auto_overdue_rent', 'true'),
      ('auto_payment_received', 'true'),
      ('auto_maintenance_created', 'true'),
      ('auto_maintenance_updates', 'true'),
      ('auto_general_announcement', 'true'),
      ('rent_reminder_days_before', '3'),
      ('rent_overdue_days_after', '1')
    ON CONFLICT (setting_key) DO NOTHING;`
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }
  console.log('[WhatsApp] Schema initialized');
}

module.exports = { applyWhatsAppSchema };
