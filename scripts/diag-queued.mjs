// diag: 定位"卡待解析"任务——查最近任务状态 + upload_job/init 审计里的 ensure 结果
// 运行：node scripts/diag-queued.mjs   （需项目根目录存在 .env）
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const URL = (env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL || !KEY) { console.error('缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const H = { Authorization: 'Bearer ' + KEY, apikey: KEY, 'Content-Type': 'application/json' };

async function get(path) {
  const r = await fetch(URL + '/rest/v1/' + path, { headers: H });
  if (!r.ok) throw new Error(path + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

// 1) 卡住的任务（status=uploaded 或 queued）
const stuck = await get('jobs?select=id,status,original_name,error,created_at,updated_at&status=in.(uploaded,queued)&order=created_at.desc&limit=20');
console.log('=== 卡住的任务（uploaded/queued）===');
if (!stuck.length) console.log('（无）');
for (const j of stuck) {
  console.log(String(j.status).padEnd(9), String(j.id).slice(0, 8),
    (j.original_name || '').slice(0, 24).padEnd(24),
    '| 创建:', j.created_at, '| 更新:', j.updated_at);
}

// 2) 最近任务（看整体状态流）
const jobs = await get('jobs?select=id,status,original_name,error,created_at,updated_at&order=created_at.desc&limit=10');
console.log('\n=== 最近 10 个任务 ===');
for (const j of jobs) {
  console.log(String(j.status).padEnd(9), String(j.id).slice(0, 8),
    (j.original_name || '').slice(0, 24).padEnd(24),
    '| err:', (j.error || '').slice(0, 100),
    '| 更新:', j.updated_at);
}

// 3) upload_job 审计 → ensure 完整返回
const ups = await get('audit_logs?select=meta,created_at&action=eq.upload_job&order=created_at.desc&limit=8');
console.log('\n=== upload_job 审计（ensure 结果）===');
if (!ups.length) console.log('（无）');
for (const a of ups) {
  const e = (a.meta && a.meta.ensure) || a.meta || {};
  console.log(a.created_at,
    '| ok:', e.ok, '| building:', e.building, '| warming:', e.warming, '| started:', e.started,
    '| msg:', (e.message || '').slice(0, 100),
    '| err:', (e.error || '').slice(0, 160));
}

// 4) admin/init 审计 → ensureSandbox 结果
const inits = await get('audit_logs?select=meta,created_at&action=eq.init&order=created_at.desc&limit=8');
console.log('\n=== admin/init 审计（ensureSandbox 结果）===');
if (!inits.length) console.log('（无）');
for (const a of inits) {
  const e = (a.meta && a.meta.ensure) || a.meta || {};
  console.log(a.created_at,
    '| ok:', e.ok, '| building:', e.building, '| warming:', e.warming, '| started:', e.started,
    '| msg:', (e.message || '').slice(0, 100),
    '| err:', (e.error || '').slice(0, 160));
}
