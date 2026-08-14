// scripts/probe-snapshot.mjs — 实测快照构建（含模型烘焙），验证快照权限与状态机
// 用法: node scripts/probe-snapshot.mjs [bake:true|false] [快照名]
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { DaytonaClient, sleep } from '../lib/daytona.js';

const c = new DaytonaClient();
const bake = (process.argv[2] || 'true') === 'true';
const name = process.argv[3] || 'mineru-snap-' + Date.now().toString(36);

const dockerfile = readFileSync(new URL('../docker/MinerU.Dockerfile', import.meta.url), 'utf8');
const baked = bake ? dockerfile + '\nRUN mineru-models-download -s huggingface -m pipeline\n' : dockerfile;

console.log(`创建快照 ${name}（bake=${bake}，cpu2/mem4/disk10）…`);
let snap;
try {
  snap = await c.createSnapshot({
    name,
    buildInfo: { dockerfileContent: baked },
    cpu: 2, memory: 4, disk: 10,
    regionId: process.env.REGION || 'us',
    sandboxClass: process.env.SNAPSHOT_CLASS || 'container',
  });
  console.log('创建返回:', JSON.stringify(snap).slice(0, 300));
} catch (e) {
  console.log('创建失败:', e.message.slice(0, 300));
  process.exit(1);
}

const id = snap.id || snap.name;
const deadline = Date.now() + 30 * 60 * 1000;
let last = '';
while (Date.now() < deadline) {
  await sleep(12000);
  const s = await c.getSnapshot(id);
  const state = (s.state || s.status || 'unknown').toLowerCase();
  if (state !== last) { last = state; console.log('快照状态:', state); }
  if (['ready', 'active', 'available', 'completed', 'built', 'ok'].includes(state)) {
    console.log('SNAPSHOT_READY', JSON.stringify({ id: s.id, name: s.name, state }));
    process.exit(0);
  }
  if (['error', 'build_failed', 'failed', 'destroyed'].includes(state)) {
    console.log('SNAPSHOT_FAILED:', s.errorReason || s.error || JSON.stringify(s).slice(0, 300));
    process.exit(1);
  }
}
console.log('SNAPSHOT_TIMEOUT');
process.exit(1);
