'use strict';

const { pool } = require('../config/database');
const { renderTemplate } = require('./templates');
const sessionManager = require('./session-manager');

let _workerInterval = null;
let _workerRunning = false;

// ─── Table Bootstrap ────────────────────────────────────────────────────────

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_message_queue (
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
    )
  `);
}

ensureTable().catch(() => {});

// ─── Enqueue ────────────────────────────────────────────────────────────────

async function enqueue(job) {
  const {
    tenantCode = null,
    phoneNumber,
    templateKey = null,
    variables = {},
    rawMessage = null,
    priority = 0,
  } = job;

  if (!phoneNumber) throw new Error('phoneNumber is required');

  const result = await pool.query(
    `INSERT INTO whatsapp_message_queue
       (tenant_code, phone_number, template_key, variables, raw_message, priority, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'queued')
     RETURNING id`,
    [tenantCode, phoneNumber, templateKey, JSON.stringify(variables), rawMessage, priority]
  );

  return result.rows[0].id;
}

// ─── Dequeue ────────────────────────────────────────────────────────────────

async function dequeue() {
  const result = await pool.query(
    `UPDATE whatsapp_message_queue
     SET status = 'sending', updated_at = NOW()
     WHERE id = (
       SELECT id FROM whatsapp_message_queue
       WHERE status = 'queued'
       ORDER BY priority ASC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  return result.rows[0] || null;
}

// ─── Status Updates ─────────────────────────────────────────────────────────

async function markSent(jobId, providerMessageId) {
  await pool.query(
    `UPDATE whatsapp_message_queue
     SET status = 'sent', provider_message_id = $1, sent_at = NOW(), updated_at = NOW()
     WHERE id = $2`,
    [providerMessageId, jobId]
  );
}

async function markFailed(jobId, errorMessage) {
  await pool.query(
    `UPDATE whatsapp_message_queue
     SET status = 'failed', error_message = $1, attempts = attempts + 1, updated_at = NOW()
     WHERE id = $2`,
    [errorMessage, jobId]
  );
}

async function cancelJob(jobId) {
  await pool.query(
    `UPDATE whatsapp_message_queue
     SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND status IN ('queued', 'sending')`,
    [jobId]
  );
}

// ─── Queries ────────────────────────────────────────────────────────────────

async function getStats() {
  const result = await pool.query(
    `SELECT status, COUNT(*)::int AS count FROM whatsapp_message_queue GROUP BY status`
  );
  const stats = { queued: 0, sending: 0, sent: 0, delivered: 0, failed: 0, cancelled: 0 };
  for (const row of result.rows) {
    stats[row.status] = row.count;
  }
  return stats;
}

async function getRecentJobs(limit = 20) {
  const result = await pool.query(
    `SELECT * FROM whatsapp_message_queue ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function retryJob(jobId) {
  await pool.query(
    `UPDATE whatsapp_message_queue
     SET status = 'queued', error_message = NULL, attempts = attempts + 1, updated_at = NOW()
     WHERE id = $1 AND status = 'failed'`,
    [jobId]
  );
}

async function cleanup(olderThanDays = 30) {
  const result = await pool.query(
    `DELETE FROM whatsapp_message_queue
     WHERE status IN ('sent', 'cancelled')
       AND updated_at < NOW() - INTERVAL '1 day' * $1`,
    [olderThanDays]
  );
  return result.rowCount;
}

// ─── Worker Loop ────────────────────────────────────────────────────────────

async function processNextJob() {
  let job;
  try {
    job = await dequeue();
  } catch (err) {
    console.error('[MsgQueue] Dequeue error:', err.message);
    return;
  }

  if (!job) return;

  try {
    let messageText;

    if (job.template_key) {
      messageText = renderTemplate(job.template_key, job.variables || {});
    } else if (job.raw_message) {
      messageText = job.raw_message;
    } else {
      throw new Error('Job has neither template_key nor raw_message');
    }

    const result = await sessionManager.sendText(job.phone_number, messageText);

    if (result && result.ack > 0) {
      await markSent(job.id, result.messageId);
    } else {
      throw new Error(result?.failureReason || 'Send failed (ack <= 0)');
    }
  } catch (err) {
    console.error(`[MsgQueue] Job ${job.id} failed:`, err.message);
    await markFailed(job.id, err.message);

    const fresh = await pool.query(
      `SELECT attempts, max_attempts FROM whatsapp_message_queue WHERE id = $1`,
      [job.id]
    );
    const row = fresh.rows[0];
    if (row && row.attempts < row.max_attempts) {
      await pool.query(
        `UPDATE whatsapp_message_queue SET status = 'queued', updated_at = NOW() WHERE id = $1`,
        [job.id]
      );
    }
  }
}

function startWorker() {
  if (_workerRunning) return;
  _workerRunning = true;
  console.log('[MsgQueue] Worker started');

  _workerInterval = setInterval(async () => {
    try {
      await processNextJob();
    } catch (err) {
      console.error('[MsgQueue] Worker tick error:', err.message);
    }
  }, 3000);
}

function stopWorker() {
  if (_workerInterval) {
    clearInterval(_workerInterval);
    _workerInterval = null;
  }
  _workerRunning = false;
  console.log('[MsgQueue] Worker stopped');
}

module.exports = {
  enqueue,
  dequeue,
  markSent,
  markFailed,
  cancelJob,
  getStats,
  getRecentJobs,
  retryJob,
  cleanup,
  startWorker,
  stopWorker,
};
