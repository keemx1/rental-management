/**
 * Ops helper — polls Meta for template approval and fires a one-time live
 * send test (to the registered test recipient) as soon as the template is
 * approved. Intended to be run by a scheduled task every 15 minutes.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const whatsapp = require('../backend/config/whatsapp');
const messages = require('../backend/services/messages');

const MARKER = path.join(__dirname, 'template-approved.marker');
const LOG = path.join(__dirname, 'template-check.log');

function log(line) {
  const stamp = new Date().toISOString();
  fs.appendFileSync(LOG, `[${stamp}] ${line}\n`);
  console.log(`[${stamp}] ${line}`);
}

(async () => {
  const status = await whatsapp.getTemplateStatus();
  const name = whatsapp.getTemplateName();

  if (status !== 'APPROVED') {
    log(`Template "${name}" status: ${status || 'unknown'} — not approved yet.`);
    return;
  }

  log(`Template "${name}" is APPROVED.`);

  if (fs.existsSync(MARKER)) {
    log('Live send test already performed — skipping.');
    return;
  }

  log('Running live send test to 254703377395...');
  await whatsapp.initializeWhatsApp();
  const body = messages.buildMonthlyInitialReminder({
    name: 'Test Tenant',
    property_name: 'Sample House',
    tenant_code: 'T001',
    rent_amount: 15000,
    payment_method: 'paybill',
    payment_paybill: '4186787',
    account_number_format: '{{tenant_code}}',
  });
  const result = await whatsapp.sendTextMessage('254703377395', body);
  log('Send result: ' + JSON.stringify(result));
  fs.writeFileSync(MARKER, new Date().toISOString());
  log('Marker written. Live send test done.');
})().catch((e) => {
  log('ERROR: ' + e.message);
  process.exitCode = 1;
});
