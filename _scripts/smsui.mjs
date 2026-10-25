import puppeteer from 'puppeteer';

const URL = 'http://localhost:3003';
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name); } }

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await page.goto(URL + '/', { waitUntil: 'networkidle2', timeout: 30000 });

// login (fill + submit the real #login-form)
await page.evaluate(() => {
  const u = document.getElementById('username');
  const p = document.getElementById('password');
  if (u) u.value = 'admin';
  if (p) p.value = 'admin123';
});
await page.evaluate(() => {
  const form = document.getElementById('login-form');
  if (form && form.requestSubmit) form.requestSubmit();
  else { const b = document.querySelector('#login-form button[type="submit"]'); if (b) b.click(); }
});
// wait for login to fully complete (token stored) before navigating
await page.waitForFunction(() => !!localStorage.getItem('rental_token'), { timeout: 10000 }).catch(() => {});
await new Promise(r => setTimeout(r, 1000));
ok('logged in (token stored)', await page.evaluate(() => !!localStorage.getItem('rental_token')));

// version
const ver = await page.$eval('#gehm-version', el => el.textContent).catch(() => '');
ok('version shows v60: ' + ver, ver.includes('v60'));

// sidebar SMS link under Communications
const commLabel = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('.sidebar-section-label')];
  const comm = labels.find(l => l.textContent.trim() === 'Communications');
  if (!comm) return null;
  let el = comm.nextElementSibling;
  const items = [];
  while (el && !el.classList.contains('sidebar-section-label')) {
    if (el.dataset && el.dataset.nav) items.push(el.dataset.nav);
    el = el.nextElementSibling;
  }
  return items;
});
console.log('  Communications nav items:', JSON.stringify(commLabel));
ok('SMS in Communications sidebar', Array.isArray(commLabel) && commLabel.includes('sms'));
ok('WhatsApp still in Communications', Array.isArray(commLabel) && commLabel.includes('whatsapp'));

// click SMS nav
await page.evaluate(() => {
  const a = document.querySelector('[data-nav="sms"]');
  if (a) a.click();
});
await new Promise(r => setTimeout(r, 1500));
const sectionVisible = await page.evaluate(() => {
  const s = document.querySelector('section[data-view="sms"]');
  return s && !s.classList.contains('hidden');
});
ok('SMS section visible after nav click', sectionVisible);
const waHidden = await page.evaluate(() => {
  const s = document.querySelector('section[data-view="whatsapp"]');
  return s && s.classList.contains('hidden');
});
ok('WhatsApp section hidden', waHidden);

// SMS panel elements
const panel = await page.evaluate(() => ({
  statusText: document.getElementById('sms-status-text')?.textContent || '',
  tokenInput: !!document.getElementById('sms-api-token'),
  senderInput: !!document.getElementById('sms-sender-id'),
  testPhone: !!document.getElementById('sms-test-phone'),
  testMsg: !!document.getElementById('sms-test-msg'),
  tbody: !!document.getElementById('sms-messages-tbody'),
  provider: document.getElementById('sms-provider-name')?.textContent || '',
}));
ok('status text loaded: ' + panel.statusText, panel.statusText.length > 0);
ok('token input present', panel.tokenInput);
ok('sender id input present', panel.senderInput);
ok('test phone + msg inputs present', panel.testPhone && panel.testMsg);
ok('history tbody present', panel.tbody);
ok('provider name shown: ' + panel.provider, panel.provider.includes('Bytewave'));

// history shows the probe Failed row
const firstRow = await page.evaluate(() => document.querySelector('#sms-messages-tbody tr')?.textContent || '');
ok('history has content row', firstRow.includes('SMS Test') || firstRow.includes('SMS panel probe') || firstRow.includes('No SMS'));

// no page JS errors
ok('no page JS errors', errors.length === 0);
if (errors.length) console.log('  errors:', errors.slice(0, 5));

console.log(`\nSMS UI: ${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
