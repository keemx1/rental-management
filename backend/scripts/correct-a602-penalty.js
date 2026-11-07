/**
 * A602 (William Utho) - 2026-11-06.
 * Management: the outstanding total must be 73,900 = arrears 38,700 (confirmed)
 * + rent 35,000 + garbage 200. The extra 7,200 hidden in the 80,900 total was
 * garbage 200 (now itemised in the reminder) + the stale "10%" penalty #49
 * (7,000, inv GEHPM-INV-202610-000101) - its remainder already sits inside the
 * confirmed arrears 38,700 (35,200 + 3,500, management's manual figure), so
 * counting the penalty row again double-bills it. VOID (not deleted - history
 * preserved) with audit.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/database');
const store = require('../storage/store');

(async () => {
  const code = 'A602';
  const before = (await query(`SELECT status, amount, description, invoice_number FROM penalties WHERE id = 49`)).rows[0];
  console.log('penalty #49 before:', before);
  await query(`UPDATE penalties SET status = 'Void', updated_at = NOW() WHERE id = 49`);
  await query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, details, created_at)
     VALUES ('admin-approval', 'CORRECT', 'penalty', '49', $1, NOW())`,
    [JSON.stringify({
      tenant_code: code,
      previous_value: { status: before.status, amount: before.amount, description: before.description, invoice_number: before.invoice_number },
      corrected_value: { status: 'Void' },
      reason: "Stale/double-counted charge: the '10%' penalty's remainder (3,500 of 7,000) is already inside the management-confirmed arrears KES 38,700 (35,200 + 3,500, manually set), so listing the penalty row again double-bills it. Management expected outcome: outstanding = 38,700 + 35,000 + 200 garbage = 73,900 (not 80,900). Voided - not deleted; payment history (pay#1573's allocation) untouched.",
      date: '2026-11-06', actor: 'admin-approval',
    })]
  );
  const rec = await store.reconcileTenant(code);
  const after = (await query(`SELECT status, amount FROM penalties WHERE id = 49`)).rows[0];
  console.log('penalty #49 after:', after);
  const t = await store.getTenant(code);
  const pen = await store.getOutstandingPenalties(code);
  const garbage = Math.max(0, Number(t.garbage_fee_amount || 0) - Number(t.garbage_fee_paid || 0));
  const total = Number(t.arrears || 0) + Number(t.rent_amount || 0) - Number(t.rent_paid_this_month || 0) + garbage + pen;
  console.log('A602 expected total now:', total, '(arrears', t.arrears, '+ rent', t.rent_amount, '+ garbage', garbage, '+ other', pen, ')');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
