// scripts/live-probe.mjs — 对运行中的沙箱探测 toolbox 正确访问方式
// 用法: node scripts/live-probe.mjs <sandboxId>
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { DaytonaClient } from '../lib/daytona.js';

const sbId = process.argv[2];
if (!sbId) { console.error('需要 sandboxId'); process.exit(1); }
const c = new DaytonaClient();
const KEY = process.env.DAYTONA_API_Key;

const sb = await c.getSandbox(sbId);
const base = `${(sb.toolboxProxyUrl || '').replace(/\/+$/, '')}/${sbId}`;
console.log('toolbox base:', base);

const authHeaders = { Authorization: `Bearer ${KEY}` };

// 1) work-dir
let r = await fetch(base + '/work-dir', { headers: authHeaders });
console.log('work-dir:', r.status, (await r.text()).slice(0, 200));

// 2) exec
r = await fetch(base + '/process/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeaders },
  body: JSON.stringify({ command: 'uname -a && whoami && (python3 --version 2>&1 || true) && (pip3 --version 2>&1 || true) && free -h | head -2', timeout: 20 }),
});
console.log('exec:', r.status, (await r.text()).slice(0, 500));

// 3) 签名文件 URL
const signingKey = await c.api(`/sandbox/${sbId}/signing-key`);
console.log('signing-key:', signingKey.slice(0, 30) + '...');
const expires = Math.floor(Date.now() / 1000) + 3600;
const canonical = `v1:files:GET:${'/tmp/probe.txt'}:${expires}`;
const sig = 'v1_' + createHmac('sha256', signingKey).update(canonical).digest('base64url');
const dlUrl = `${base}/files/download?path=${encodeURIComponent('/tmp/probe.txt')}&expires=${expires}&signature=${encodeURIComponent(sig)}`;
console.log('signed dl url:', dlUrl.slice(0, 130) + '...');

// 先写一个文件再下载
r = await fetch(base + '/process/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeaders },
  body: JSON.stringify({ command: 'echo hello-signed > /tmp/probe.txt', timeout: 15 }),
});
console.log('write file exec:', r.status);
r = await fetch(dlUrl, { method: 'GET' });
const dlText = await r.text();
console.log('signed download:', r.status, JSON.stringify(dlText));

// 4) 签名上传
const upCanonical = `v1:files:POST:${'/tmp/up.txt'}:${expires}`;
const upSig = 'v1_' + createHmac('sha256', signingKey).update(upCanonical).digest('base64url');
const upUrl = `${base}/files/upload-v2?path=${encodeURIComponent('/tmp/up.txt')}&expires=${expires}&signature=${encodeURIComponent(upSig)}`;
const fd = new FormData();
fd.append('file', new Blob(['UPLOADED-BODY']), 'up.txt');
r = await fetch(upUrl, { method: 'POST', body: fd });
console.log('signed upload:', r.status, (await r.text()).slice(0, 200));

r = await fetch(base + '/process/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeaders },
  body: JSON.stringify({ command: 'cat /tmp/up.txt', timeout: 15 }),
});
console.log('verify upload:', r.status, JSON.stringify((await r.json()).result));

process.exit(0);
