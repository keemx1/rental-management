import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const resps = [];
page.on('response', r => { if (r.url().includes('/api/')) resps.push(r.status() + ' ' + r.url()); });
await page.goto('http://localhost:3003/', { waitUntil: 'networkidle2', timeout: 30000 });
const loginInfo = await page.evaluate(() => ({
  user: !!document.getElementById('login-username') || !!document.getElementById('username') || !!document.querySelector('input[name="username"]'),
  pass: !!document.getElementById('login-password') || !!document.getElementById('password') || !!document.querySelector('input[name="password"]'),
  inputs: [...document.querySelectorAll('input')].map(i => i.id || i.name || i.type).slice(0, 10),
}));
console.log('login form:', JSON.stringify(loginInfo));
await page.evaluate(() => {
  const u = document.getElementById('login-username') || document.getElementById('username') || document.querySelector('input[name="username"]');
  const p = document.getElementById('login-password') || document.getElementById('password') || document.querySelector('input[name="password"]');
  if (u) u.value = 'admin';
  if (p) p.value = 'admin123';
});
await page.evaluate(() => {
  const btn = document.querySelector('#login-btn, button[type="submit"], .login-btn');
  if (btn) btn.click();
});
await new Promise(r => setTimeout(r, 2500));
const token = await page.evaluate(() => localStorage.getItem('rental_token'));
console.log('token stored:', token ? token.slice(0, 20) + '...' : 'NONE');
await page.evaluate(() => document.querySelector('[data-nav="sms"]')?.click());
await new Promise(r => setTimeout(r, 1500));
console.log('api responses:'); resps.forEach(x => console.log(' ', x));
const st = await page.evaluate(() => ({
  text: document.getElementById('sms-status-text')?.textContent,
  provider: document.getElementById('sms-provider-name')?.textContent,
}));
console.log('status el:', JSON.stringify(st));
await browser.close();
