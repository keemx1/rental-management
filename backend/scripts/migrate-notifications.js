/**
 * migrate-notifications.js — Central Notification Bar lifecycle log.
 *
 * Alerts themselves are COMPUTED LIVE from underlying records (they can
 * never move money or approve anything). This table only tracks the
 * lifecycle: one Open row per unresolved issue (deduped by alert_key),
 * auto-resolved when the underlying issue clears, history preserved.
 *
 * Run: node backend/scripts/migrate-notifications.js   (idempotent)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');

async function main() {
  console.log('[migrate-notifications] starting');
  await query(`
    CREATE TABLE IF NOT EXISTS notification_log (
      id SERIAL PRIMARY KEY,
      alert_key TEXT NOT NULL,
      priority VARCHAR(20) NOT NULL CHECK (priority IN ('critical','overdue','due_soon','pending','review')),
      issue_type VARCHAR(60) NOT NULL,
      title TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      amount NUMERIC(14,2),
      status VARCHAR(20) NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Resolved')),
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      resolution TEXT
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_notification_status ON notification_log (status, priority)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_notification_seen ON notification_log (last_seen DESC)`);
  // Dedupe: exactly ONE Open row per issue identity.
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_open_key
      ON notification_log (alert_key) WHERE status = 'Open'`);
  console.log('[migrate-notifications] done');
  process.exit(0);
}

main().catch((e) => { console.error('[migrate-notifications] FAILED:', e); process.exit(1); });
