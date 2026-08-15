/**
 * Monthly rollover — carries forward unpaid rent as arrears on the 1st.
 * Monthly rent reminder — sent on the 5th to tenants with outstanding balance.
 * Reminder only sends once the WhatsApp template is APPROVED; the 13:00
 * schedule is the same-day fallback in case approval lands after 08:00, and
 * the 10th schedule forwards the attempt once more if still not approved.
 */
const cron = require('node-cron');
const store = require('../storage/store');
const whatsapp = require('../config/whatsapp');
const { sendMonthlyInitialReminder } = require('./messages');

let cronTask = null;
let monthlyReminderTask = null;
let rolloverTask = null;

async function runRolloverJob({ force = false } = {}) {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastMonth = await store.getLastRolloverMonth();
  if (!force && lastMonth === month) {
    const at = await store.getLastRolloverAt();
    console.log(`[Cron] Rollover already ran for ${month} at ${at} — skipping.`);
    return { skipped: true, reason: 'already_ran_this_month', month, last_rollover_at: at };
  }

  console.log('[Cron] Running monthly rollover...');
  const result = await store.rolloverMonth();
  if (result.skipped) {
    console.log('[Cron] Rollover skipped — another rollover is already running.');
    return result;
  }
  const results = result.details || [];
  if (results.length > 0) {
    console.log(`[Cron] Rollover complete — ${results.length} tenants updated:`);
    for (const r of results) {
      console.log(`  ${r.tenant_code}: +${r.months_missed} month(s), arrears now KES ${r.new_arrears}, next due ${r.new_due_date}`);
    }
  } else {
    console.log('[Cron] Rollover complete — no tenants needed rollover.');
  }
  return { skipped: false, tenants_updated: results.length, details: results };
}

async function runMonthlyInitialReminderJob({ nextRetryLabel } = {}) {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Already sent this month (from the 08:00 run) — skip the later attempts.
  const lastMonth = await store.getLastReminderMonth();
  if (lastMonth === month) {
    console.log(`[Cron] Monthly rent reminder already ran for ${month} — skipping.`);
    return { skipped: true, reason: 'already_sent_this_month', month };
  }

  // Only send when the WhatsApp template is approved. Otherwise the later
  // schedules (13:00 on the 5th, then the 10th) become the retry chain.
  const templateStatus = await whatsapp.getTemplateStatus();
  if (templateStatus !== 'APPROVED') {
    const retryText = nextRetryLabel || 'on the 10th';
    console.log(
      `[Cron] Monthly rent reminder deferred — template "${whatsapp.getTemplateName()}" status is ${templateStatus || 'unknown'}. Will retry ${retryText}.`
    );
    return { skipped: true, reason: 'template_not_approved', status: templateStatus, month, retry: retryText };
  }

  console.log('[Cron] Running monthly rent reminder scan...');
  try {
    const allTenants = await store.listTenants({ status: 'Active' });
    const tenants = allTenants.filter((t) => {
      const paid = Number(t.rent_paid_this_month || 0);
      const due = Number(t.rent_amount || 0);
      return paid < due;
    });
    let sent = 0;
    for (const t of tenants) {
      await sendMonthlyInitialReminder(t);
      sent++;
    }
    await store.setLastReminderMonth(month);
    console.log(`[Cron] Complete — ${sent} reminders sent (${allTenants.length - sent} already paid, skipped)`);
    return { skipped: false, sent, total: allTenants.length, month };
  } catch (err) {
    console.error('[Cron] Error running monthly rent reminder job:', err.message);
    return { skipped: true, reason: 'error', error: err.message };
  }
}

function startScheduler() {
  if (cronTask) return;

  // Monthly rollover on the 1st at 6:00 AM
  rolloverTask = cron.schedule(
    '0 6 1 * *',
    () => {
      runRolloverJob().catch((err) => console.error('[Cron Rollover]', err));
    },
    { scheduled: true, timezone: process.env.CRON_TZ || undefined }
  );
  console.log('[Cron] Monthly rollover scheduler registered (06:00 on the 1st).');

  // Monthly rent reminder on the 5th at 8:00 AM, with a same-day 1:00 PM
  // fallback, then a final forward to the 10th if the template is still
  // not approved. Retry chain: 5th 08:00 -> 5th 13:00 -> 10th 08:00.
  monthlyReminderTask = cron.schedule(
    '0 8 5 * *',
    () => {
      runMonthlyInitialReminderJob({ nextRetryLabel: 'at 13:00 today' }).catch((err) => console.error('[Cron Monthly 08:00]', err));
    },
    { scheduled: true, timezone: process.env.CRON_TZ || undefined }
  );
  console.log('[Cron] Monthly rent reminder scheduler registered (08:00 on the 5th).');

  cron.schedule(
    '0 13 5 * *',
    () => {
      runMonthlyInitialReminderJob({ nextRetryLabel: 'on the 10th' }).catch((err) => console.error('[Cron Monthly 13:00]', err));
    },
    { scheduled: true, timezone: process.env.CRON_TZ || undefined }
  );
  console.log('[Cron] Monthly rent reminder fallback scheduler registered (13:00 on the 5th).');

  cron.schedule(
    '0 8 10 * *',
    () => {
      runMonthlyInitialReminderJob({ nextRetryLabel: 'next month' }).catch((err) => console.error('[Cron Monthly 10th]', err));
    },
    { scheduled: true, timezone: process.env.CRON_TZ || undefined }
  );
  console.log('[Cron] Monthly rent reminder 10th-forward scheduler registered (08:00 on the 10th).');
}

module.exports = { startScheduler, runMonthlyInitialReminderJob, runRolloverJob };
