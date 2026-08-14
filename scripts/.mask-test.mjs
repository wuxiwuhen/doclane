import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox','--disable-gpu'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0,250)));
try {
  await page.goto('https://doclane-gules.vercel.app', { waitUntil: 'networkidle2', timeout: 60000 });
} catch (e) { console.log('GOTO FAIL:', e.message.slice(0,120)); }
await new Promise(r=>setTimeout(r,4000));
const st = await page.evaluate(() => { const m=document.getElementById('auth-mask'); return { hidden: m.hidden, display: getComputedStyle(m).display }; });
console.log('RESULT:', JSON.stringify(st), '| errors:', errs.length ? errs.join(' ;; ') : '(none)');
await browser.close();
