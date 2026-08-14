// scripts/e2e-prod.mjs — 生产环境全链路验证（走代理）
import fs from 'node:fs';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')
    .filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const BASE = 'https://doclane-gules.vercel.app';
const j = r => r.json();
const email = 'prod-' + Date.now() + '@doclane.test';

// 1. 建已确认用户 + 登录
const P = { headers: { Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, apikey: env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' } };
await fetch(env.SUPABASE_URL + '/auth/v1/admin/users', { ...P, method: 'POST', body: JSON.stringify({ email, password: 'Test123456', email_confirm: true }) });
const tok = await fetch(env.SUPABASE_URL + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Test123456' }) }).then(j);
const H = { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' };

// 2. 建任务 + 上传 + 触发解析
const { job, uploadUrl } = await fetch(BASE + '/api/jobs', { method: 'POST', headers: H, body: JSON.stringify({ name: 'test-sample.pdf', size: 1127 }) }).then(j);
console.log('1. create job:', job.id.slice(0, 8));
console.log('2. PUT file:', (await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: fs.readFileSync(new URL('../test-sample.pdf', import.meta.url)) })).status);
const up = await fetch(BASE + '/api/jobs/' + job.id + '/uploaded', { method: 'POST', headers: H }).then(j);
console.log('3. uploaded:', JSON.stringify(up.ensure || {}));

// 3. 轮询
for (let i = 0; i < 50; i++) {
  await new Promise(r => setTimeout(r, 10000));
  const d = await fetch(BASE + '/api/jobs/' + job.id, { headers: H }).then(j).then(x => x.job);
  const last = (d.logs || []).slice(-1)[0]?.msg?.slice(0, 60) || '';
  console.log('4. poll', i, d.status, last);
  if (d.status === 'done') { console.log('5. DONE files:', (d.files || []).length, 'mainMd:', d.mainMd); break; }
  if (d.status === 'error') { console.log('5. ERROR:', d.error); break; }
  if (i === 49) console.log('TIMEOUT');
}

// 4. 检索 + 正文
const s = await fetch(BASE + '/api/search?q=' + encodeURIComponent('pipeline') + '&mode=hybrid', { headers: H }).then(j);
console.log('6. search[pipeline]:', s.total, 'hits |', s.hits?.[0]?.filename, '|', (s.hits?.[0]?.snippet || '').replace(/<[^>]+>/g, '').slice(0, 40));
const kb = await fetch(BASE + '/api/kb', { headers: H }).then(j);
console.log('7. kb stats:', JSON.stringify(kb.stats));
