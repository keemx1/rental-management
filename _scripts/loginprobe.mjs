import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://localhost:3003/', { waitUntil: 'networkidle2', timeout: 30000 });
const info = await page.evaluate(() => {
  const forms = [...document.querySelectorAll('form')].map(f => ({
    id: f.id, action: f.action, cls: f.className,
    inputs: [...f.querySelectorAll('input')].map(i => ({ id: i.id, name: i.name, type: i.type })),
    buttons: [...f.querySelectorAll('button')].map(b => ({ id: b.id, type: b.type, text: b.textContent.trim() })),
  }));
  const btns = [...document.querySelectorAll('button')].map(b => ({ id: b.id, type: b.type, text: b.textContent.trim() })).slice(0, 12);
  return { forms, btns };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
