// scripts/probe-sandbox.mjs — 探测沙箱创建方式（不清理，用于排查；运行后需手动删除 probe-* 沙箱）
import 'dotenv/config';
import { DaytonaClient } from '../lib/daytona.js';

const c = new DaytonaClient();
const probe = async (label, body) => {
  try {
    const r = await c.createSandbox(body);
    console.log(label, '=> OK', JSON.stringify({ id: r.id, state: r.state, snapshot: r.snapshot, cpu: r.cpu, memory: r.memory, disk: r.disk }).slice(0, 260));
    return r;
  } catch (e) {
    console.log(label, '=>', e.message.slice(0, 180));
    return null;
  }
};

const suffix = Date.now().toString(36);
await probe('A: snapshot=ubuntu:22.04 无资源', { name: 'probe-a-' + suffix, snapshot: 'ubuntu:22.04' });
await probe('B: snapshot=python:3.11-slim + buildInfo', { name: 'probe-b-' + suffix, snapshot: 'python:3.11-slim', buildInfo: { dockerfileContent: 'FROM python:3.11-slim\nRUN echo built-ok' } });
await probe('C: snapshot=python:3.11-slim 无资源', { name: 'probe-c-' + suffix, snapshot: 'python:3.11-slim' });
await probe('D: 无snapshot 只给资源', { name: 'probe-d-' + suffix, cpu: 1, memory: 2, disk: 10 });
process.exit(0);
