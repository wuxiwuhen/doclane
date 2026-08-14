// scripts/probe-build.mjs — 测试 buildInfo 建沙箱（可能支持自定义资源且免快照权限）
// 用法: node scripts/probe-build.mjs
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { DaytonaClient } from '../lib/daytona.js';

const c = new DaytonaClient();
const dockerfile = readFileSync(new URL('../docker/MinerU.Dockerfile', import.meta.url), 'utf8');
const name = 'probe-build-' + Date.now().toString(36);
const body = {
  name,
  buildInfo: { dockerfileContent: dockerfile },
  cpu: 2, memory: 8, disk: 40,
  autoDeleteInterval: 0,
  ttlMinutes: 180,
};
try {
  const r = await c.createSandbox(body);
  console.log('BUILD SANDBOX OK:', JSON.stringify({ id: r.id, state: r.state, cpu: r.cpu, memory: r.memory, disk: r.disk }).slice(0, 300));
  console.log('SANDBOX_ID=' + r.id);
} catch (e) {
  console.log('BUILD SANDBOX FAILED:', e.message.slice(0, 300));
  console.log('尝试 buildInfo 不带资源…');
  try {
    const { buildInfo, cpu, memory, disk, ...rest } = body;
    const r2 = await c.createSandbox(rest);
    console.log('BUILD SANDBOX (no resources) OK:', JSON.stringify({ id: r2.id, state: r2.state, cpu: r2.cpu, memory: r2.memory, disk: r2.disk }).slice(0, 300));
    console.log('SANDBOX_ID=' + r2.id);
  } catch (e2) {
    console.log('ALSO FAILED:', e2.message.slice(0, 300));
  }
}
process.exit(0);
