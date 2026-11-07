const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const sessionManager = require('../whatsapp/session-manager');

const router = express.Router();
router.use(requireAuthActive);

const fmtKes = (n) => Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });

function applyTemplate(body, tenant, house, fin) {
  return String(body || '')
    .replaceAll('{{client_name}}', tenant.name || 'Client')
    .replaceAll('{{tenant_code}}', tenant.tenant_code || '')
    .replaceAll('{{house_name}}', house?.house_name || tenant.property_name || 'House')
    .replaceAll('{{house_number}}', tenant.unit_label || tenant.tenant_code || '')
    .replaceAll('{{arrears}}', fmtKes(fin?.arrears))
    .replaceAll('{{current_rent}}', fmtKes(fin?.rentAmount ?? fin?.currentRent))
    .replaceAll('{{payments_received}}', fmtKes(fin?.paymentsReceived))
    .replaceAll('{{outstanding_balance}}', fmtKes(fin?.outstanding))
    .replaceAll('{{remaining_balance}}', fmtKes(fin?.outstanding))
    .replaceAll('{{amount_due}}', fmtKes(fin?.outstanding));
}

// Automatic payment verification (permanent rule): compute a tenant's verified
// financial position and whether the rent obligation is already fully settled
// (including advance rent / credits). Fully-paid tenants must never be reminded.
// Cross-period payments are recognised via arrears (carried forward) and the
// advance/credit pools - not just the current month's records.
function verifyTenantPayment(tenant) {
  const num = (v) => Number(v || 0);
  const arrears = num(tenant.arrears);
  const rentAmount = num(tenant.rent_amount);
  const rentPaidThisMonth = num(tenant.rent_paid_this_month);
  // Billing month = the tenant's current rent cycle (rent_due_date month).
  const billingMonth = tenant.rent_due_date
    ? String(tenant.rent_due_date).slice(0, 7)
    : new Date().toISOString().slice(0, 7);
  // Advance rent covering the billing month pre-pays the rent obligation.
  const advUntil = tenant.advance_rent_until ? String(tenant.advance_rent_until).slice(0, 7) : null;
  const advanceCoversRent = !!(advUntil && advUntil >= billingMonth);
  const currentRentDue = advanceCoversRent ? 0 : Math.max(0, rentAmount - rentPaidThisMonth);
  const credits = num(tenant.advance_rent_balance) + num(tenant.credit_balance);
  const grossDue = arrears + currentRentDue;
  const outstanding = Math.max(0, grossDue - credits);
  const isFullyPaid = outstanding <= 0;
  return {
    billingMonth, arrears, currentRent: currentRentDue, rentAmount,
    paymentsReceived: rentPaidThisMonth, credits, grossDue, outstanding,
    isFullyPaid, advanceCoversRent,
    status: isFullyPaid ? 'Fully Paid' : (rentPaidThisMonth > 0 ? 'Partially Paid' : 'Unpaid'),
  };
}

// Template-type classification (permanent rule): payment-based reminders must be
// filtered by payment status (a fully-paid / advance-covered tenant must never be
// reminded); general notices reach every active tenant regardless of payment.
// Matched on the template name - payment prompts (reminder / follow-up / final
// notice / overdue / balance / penalty / invoice / rent due) vs general notices
// (emergency / maintenance / security / agreement / increment / update). Bare
// "rent" is intentionally NOT a payment term so "Rent Increment" stays general.
function isPaymentReminderTemplate(name) {
  const n = String(name || '').toLowerCase();
  const paymentTerms = [
    'reminder', 'follow-up', 'follow up', 'follow', 'final notice', 'overdue',
    'balance', 'penalty', 'invoice', 'rent due', 'rent balance', 'overdue rent', 'gentle',
  ];
  return paymentTerms.some((t) => n.includes(t));
}

router.post('/send', async (req, res) => {
  try {
    const { template_id, message_body, target_type, house_id, tenant_id, channel, dry_run } = req.body;
    if (!message_body && !template_id) {
      return res.status(400).json({ error: 'message_body or template_id required' });
    }
    if (!['all', 'house', 'tenant'].includes(target_type)) {
      return res.status(400).json({ error: 'target_type must be all, house, or tenant' });
    }
    if (target_type === 'house' && !house_id) {
      return res.status(400).json({ error: 'house_id required when target_type=house' });
    }
    if (target_type === 'tenant' && !tenant_id) {
      return res.status(400).json({ error: 'tenant_id required when target_type=tenant' });
    }

    // Delivery channel: whatsapp (default) | sms | both — same semantics as
    // the tenant message modal.
    const chan = ['whatsapp', 'sms', 'both'].includes(channel) ? channel : 'whatsapp';
    const wantsWa = chan === 'whatsapp' || chan === 'both';
    const wantsSms = chan === 'sms' || chan === 'both';

    const smsService = require('../services/smsBytewave');
    const { normalizePhone } = require('../whatsapp/phone');
    let smsConfigured = false;
    if (wantsSms) {
      let settings = null;
      try { settings = await smsService.getSmsSettings(); } catch (_) { settings = null; }
      smsConfigured = !!(settings && settings.api_token);
      // SMS is the ONLY channel and is not configured -> clear 400 (no sends).
      // Skipped in dry-run preview (we only verify + list, never send).
      if (!smsConfigured && chan === 'sms' && !dry_run) {
        return res.status(400).json({ error: 'SMS is not configured — save the SMS API token in SMS Settings first.' });
      }
    }

    let baseBody = message_body;
    let templateName = 'Default Rent Reminder';
    if (template_id) {
      const tpl = await store.getTemplate(template_id);
      if (!tpl) return res.status(404).json({ error: 'Template not found' });
      baseBody = tpl.body;
      templateName = tpl.name || templateName;
    }
    // The selected template decides recipient eligibility (payment filter or not).
    const isPaymentReminder = isPaymentReminderTemplate(templateName);

    let tenants;
    if (target_type === 'tenant') {
      const single = tenant_id ? await store.getTenant(tenant_id) : null;
      tenants = single ? [single] : [];
    } else {
      tenants =
        target_type === 'house'
          ? await store.listTenants({ house_id })
          : await store.listTenants();
    }

    if (!tenants.length) return res.status(400).json({ error: 'No target clients found' });

    // ── Recipient eligibility (permanent rule, decided by the template type) ──
    // Active tenants only (Vacant excluded). Payment reminders exclude anyone whose
    // rent obligation is fully settled (paid OR advance-covered) - never remind a
    // paid tenant. General notices reach every active tenant regardless of payment.
    const verified = tenants
      .filter((t) => (t.status || '') !== 'Vacant')
      .map((t) => ({ tenant: t, fin: verifyTenantPayment(t) }));
    const eligible = isPaymentReminder ? verified.filter((v) => !v.fin.isFullyPaid) : verified;
    const excluded = isPaymentReminder ? verified.filter((v) => v.fin.isFullyPaid) : [];
    const summary = {
      template_type: isPaymentReminder ? 'payment' : 'general',
      total_checked: verified.length,
      excluded_fully_paid: isPaymentReminder ? excluded.filter((v) => !v.fin.advanceCoversRent && v.fin.credits < v.fin.grossDue).length : 0,
      excluded_advance: isPaymentReminder ? excluded.filter((v) => v.fin.advanceCoversRent || v.fin.credits >= v.fin.grossDue).length : 0,
      included_partial: eligible.filter((v) => v.fin.status === 'Partially Paid').length,
      included_unpaid: eligible.filter((v) => v.fin.status === 'Unpaid').length,
      total_eligible: eligible.length,
    };

    // Dry-run preview: verify + build the eligible recipient list + summary but
    // send NOTHING and write NO records. The confirmation popup renders this so
    // management can review recipients before confirming the broadcast.
    if (dry_run) {
      return res.json({
        success: true,
        preview: true,
        channel: chan,
        summary,
        recipients: eligible.map((v) => ({
          tenant_id: v.tenant.id,
          tenant_code: v.tenant.tenant_code,
          tenant_name: v.tenant.name,
          phone: v.tenant.phone_number,
          status: v.fin.status,
          arrears: v.fin.arrears,
          current_rent: v.fin.currentRent,
          payments_received: v.fin.paymentsReceived,
          outstanding_balance: v.fin.outstanding,
          sample_message: applyTemplate(baseBody, v.tenant, null, v.fin),
        })),
      });
    }

    const results = [];
    const tally = {
      whatsapp: { sent: 0, failed: 0 },
      sms: { sent: 0, failed: 0 },
    };
    let removedOnRecheck = 0;

    for (const v of eligible) {
      // Pre-send recheck: re-verify payment status right before sending. For payment
      // reminders, drop anyone who has since fully settled (never remind a paid
      // tenant). General notices send to all eligible regardless of payment.
      const freshTenant = (v.tenant.id ? await store.getTenant(v.tenant.id) : null) || v.tenant;
      const fin = verifyTenantPayment(freshTenant);
      if (isPaymentReminder && fin.isFullyPaid) { removedOnRecheck++; continue; }
      const tenant = freshTenant;
      const house = tenant?.house_id ? await store.getHouse(tenant.house_id) : null;
      const renderedBody = applyTemplate(baseBody, tenant, house, fin);
      const entry = { tenant_id: tenant.id, tenant_name: tenant.name, status: 'Sent', error: null, outstanding_balance: fin.outstanding };

      // ── WhatsApp leg ──────────────────────────────────────────────────────
      if (wantsWa) {
        let status = 'Sent';
        let error = null;
        let whatsappMessageId = null;
        try {
          // Linked Baileys session delivers; honest per-recipient status either way.
          try {
            const result = await sessionManager.sendText(tenant.phone_number, renderedBody);
            whatsappMessageId = result.id;
          } catch (_) {
            const fallback = require('../config/whatsapp');
            const r = await fallback.sendTextMessage(tenant.phone_number, renderedBody);
            if (r.status !== 'Sent') throw new Error(r.failureReason || 'provider could not deliver the message');
            whatsappMessageId = r.messageId || null;
          }
        } catch (err) {
          status = 'failed';
          error = err.message;
        }
        tally.whatsapp[status === 'Sent' ? 'sent' : 'failed']++;
        entry.whatsapp = { status, error };
        await store.logMessage({
          tenantId: tenant.id,
          messageType: 'Broadcast',
          messageBody: renderedBody,
          status,
          whatsappMessageId,
          failureReason: error,
        });
        // Also log to whatsapp_message_log for stats (WhatsApp legs only)
        try {
          const { pool } = require('../config/database');
          await pool.query(
            `INSERT INTO whatsapp_message_log (tenant_code, phone_number, direction, message_type, content, status, provider_message_id, error_message)
             VALUES ($1, $2, 'outbound', 'broadcast', $3, $4, $5, $6)`,
            [tenant.tenant_code, tenant.phone_number, renderedBody, status, whatsappMessageId, error]
          );
        } catch (_) {}
      }

      // ── SMS leg ───────────────────────────────────────────────────────────
      if (wantsSms) {
        let status = 'Sent';
        let error = null;
        let smsId = null;
        if (!smsConfigured) {
          status = 'Failed';
          error = 'SMS not configured (save the SMS API token in SMS Settings)';
        } else {
          const to = normalizePhone(tenant.phone_number);
          if (!to) {
            // Malformed / missing phone (e.g. too-short number) - skip the send
            // and report clearly instead of a confusing gateway rejection.
            status = 'Failed';
            error = 'Invalid or missing phone number';
          } else {
            try {
              const result = await smsService.sendSms({ to, message: renderedBody });
              smsId = (result && result.data && (result.data.uid || result.data.id)) || null;
            } catch (err) {
              status = 'Failed';
              error = err.message || 'SMS send failed';
            }
          }
        }
        tally.sms[status === 'Sent' ? 'sent' : 'failed']++;
        entry.sms = { status, error, smsId };
        await store.logMessage({
          tenantId: tenant.id,
          messageType: 'SMS Broadcast',
          messageBody: renderedBody,
          status,
          whatsappMessageId: smsId,
          failureReason: error,
        });
      }

      if ((entry.whatsapp && entry.whatsapp.status !== 'Sent')
        || (entry.sms && entry.sms.status !== 'Sent')) {
        entry.status = 'failed';
        entry.error = (entry.whatsapp && entry.whatsapp.error) || (entry.sms && entry.sms.error) || 'delivery failed';
      }
      results.push(entry);
    }

    const sent = results.filter((r) => r.status === 'Sent').length;
    const failed = results.length - sent;
    res.json({
      success: true,
      channel: chan,
      sent,
      failed,
      whatsapp: wantsWa ? tally.whatsapp : null,
      sms: wantsSms ? tally.sms : null,
      summary,
      removed_on_recheck: removedOnRecheck,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: 'Broadcast operation failed' });
  }
});

module.exports = router;
