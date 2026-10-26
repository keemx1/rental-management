/**
 * mark-lock-failures-delivered.js
 *
 * Corrects WhatsApp message statuses for messages that FAILED only because of
 * the transient session-file lock (EPERM "operation not permitted, open ...
 * sessions\...", EBUSY, resource busy) but were in fact delivered — confirmed
 * by the operator. Those rows carry no provider message id, so the delivery
 * callback could never upgrade them; this one-off reconciliation:
 *
 *   - flips ONLY lock-class failures (never 'session not connected' etc.)
 *     from Failed -> Delivered
 *   - keeps the original failure_reason on the row for the audit trail
 *   - writes a full audit_log entry listing every corrected row
 *
 * Run: node backend/scripts/mark-lock-failures-delivered.js          (dry run)
 *      node backend/scripts/mark-lock-failures-delivered.js --apply  (apply)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { query } = require('../config/database');

const APPLY = process.argv.includes('--apply');

const LOCK_COND = `(
  failure_reason ILIKE '%operation not permitted%'
  OR failure_reason ILIKE '%EBUSY%'
  OR failure_reason ILIKE '%resource busy%'
)`;

async function main() {
  const targets = await query(`
    SELECT id, message_type, LEFT(failure_reason, 200) AS failure_reason, logged_at::text
      FROM message_logs
     WHERE status IN ('Failed', 'failed')
       AND ${LOCK_COND}
     ORDER BY id`);
  console.log(`lock-class failed rows found: ${targets.rows.length}`);
  if (targets.rows.length) console.table(targets.rows.slice(0, 40));

  if (!APPLY || !targets.rows.length) {
    console.log(APPLY ? 'nothing to do' : 'dry run — re-run with --apply to correct');
    process.exit(0);
  }

  const ids = targets.rows.map((r) => r.id);
  const upd = await query(
    `UPDATE message_logs SET status = 'Delivered' WHERE id = ANY($1::int[]) AND status IN ('Failed','failed')`,
    [ids]
  );
  await query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, details)
     VALUES ('reconciliation', 'message_status_corrected', 'message_logs', $1, $2)`,
    [String(ids.length), JSON.stringify({
      reason: 'Transient session-file lock (EPERM/EBUSY) caused false Failed status; operator confirmed delivery. Original failure_reason retained on each row.',
      count: upd.rowCount,
      ids,
      rows: targets.rows,
    })]
  );
  console.log(`corrected to Delivered: ${upd.rowCount}`);
  const left = await query(
    `SELECT COUNT(*)::int AS n FROM message_logs WHERE status IN ('Failed','failed') AND ${LOCK_COND}`
  );
  console.log(`lock-class failures remaining: ${left.rows[0].n}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
