// scripts/probe-build-real.mjs — 用真实 MinerU Dockerfile 构建沙箱（buildInfo 模式）并轮询构建状态
// 用法: node scripts/probe-build-real.mjs
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { DaytonaClient, sleep } from '../lib/daytona.js';

const c = new DaytonaClient();
const dockerfile = readFileSync(new URL('../docker/MinerU.Dockerfile', import.meta.url), 'utf8');
const name = 'mineru-build-' + Date.now().toString(36);

console.log('创建构建沙箱（cpu2/mem4/disk10 + MinerU Dockerfile）…');
const r = await c.createSandbox({
  name,
  buildInfo: { dockerfileContent: dockerfile },
  cpu: 2, memory: 4, disk: 10,
  autoDeleteInterval: 0,
  ttlMinutes: 240,
});
console.log('created:', r.id, '| state:', r.state);
console.log('SANDBOX_ID=' + r.id);

const deadline = Date.now() + 30 * 60 * 1000;
let last = '';
while (Date.now() < deadline) {
  await sleep(15000);
  const sb = await c.getSandbox(r.id);
  const st = sb.state || 'unknown';
  if (st !== last) { last = st; console.log('build state:', st); }
  if (st === 'started' || st === 'running') { console.log('BUILD COMPLETE ✅ 沙箱就绪:', JSON.stringify({ cpu: sb.cpu, memory: sb.memory, disk: sb.disk })); process.exit(0); }
  if (['error', 'build_failed', 'destroyed'].includes(st)) { console.log('BUILD FAILED ❌', sb.errorReason || ''); process.exit(1); }
}
console.log('BUILD TIMEOUT');
process.exit(1);
