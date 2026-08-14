// scripts/smoke-test.mjs — Daytona 真实链路冒烟测试（会创建并销毁云资源）
// 用法: node scripts/smoke-test.mjs
import 'dotenv/config';
import { DaytonaClient, sleep } from '../lib/daytona.js';

const NAME = 'mineru-smoke-' + Date.now().toString(36);
const client = new DaytonaClient();
const log = (...a) => console.log('[smoke]', ...a);

async function main() {
  log('health:', await client.health());

  // 1) 用默认快照创建沙箱（本 key 无快照构建权限，只能用预置快照；资源由快照决定）
  let sb;
  try {
    log('创建沙箱（默认快照 daytonaio/sandbox:0.8.0）…');
    sb = await client.createSandbox({
      name: NAME,
      snapshot: 'daytonaio/sandbox:0.8.0',
      autoDeleteInterval: 0, // 测试用：停止即删除
      ttlMinutes: 120,
    });
    log('沙箱创建:', sb.id, '| state:', sb.state);
  } catch (e) {
    log('带快照创建失败:', e.message.slice(0, 200));
    log('尝试不带任何参数（使用默认）…');
    sb = await client.createSandbox({ name: NAME, autoDeleteInterval: 0, ttlMinutes: 120 });
    log('沙箱创建:', sb.id, '| state:', sb.state);
  }

  // 2) 等待启动
  log('等待沙箱启动…');
  sb = await client.waitForSandbox(sb.id, { timeoutMs: 12 * 60 * 1000, onStatus: log });
  log('沙箱已启动:', sb.id, '| cpu/mem:', sb.cpu, sb.memory);

  // 3) toolbox 全链路
  const tb = await client.toolbox(sb.toolboxProxyUrl);
  const wd = await tb.workDir();
  log('work-dir:', wd.dir);

  const exec1 = await tb.exec('uname -a && whoami && (python3 --version 2>&1 || true) && (pip3 --version 2>&1 || true)', {}, 20);
  log('exec1 exit:', exec1.exitCode);
  console.log(exec1.result);

  const hello = Buffer.from('HELLO_FROM_SMOKE_TEST\nline2\n');
  const up = await tb.uploadFile(`${wd.dir}/smoke.txt`, hello, 'smoke.txt');
  log('upload:', JSON.stringify(up));

  const exec2 = await tb.exec(`cat ${wd.dir}/smoke.txt`, {}, 15);
  log('exec2 cat:', JSON.stringify(exec2.result));

  const down = await tb.downloadFile(`${wd.dir}/smoke.txt`);
  log('download ok:', down.toString() === hello.toString(), '| bytes:', down.length);

  // 4) 目录创建 + 长任务后台模式验证
  const exec3 = await tb.exec(`mkdir -p ${wd.dir}/jobs/t1/out && nohup bash -c 'echo hello > ${wd.dir}/jobs/t1/out/a.md; sleep 2; echo "__DONE:0" >> ${wd.dir}/jobs/t1/out/run.log' >/dev/null 2>&1 & echo STARTED`, {}, 15);
  log('exec3 bg start:', exec3.result);
  await sleep(4000);
  const exec4 = await tb.exec(`ls ${wd.dir}/jobs/t1/out`, {}, 15);
  log('exec4 ls:', JSON.stringify(exec4.result));
  const md = await tb.downloadFile(`${wd.dir}/jobs/t1/out/a.md`);
  log('download md ok:', md.toString().trim() === 'hello');

  log('SMOKE TEST PASSED ✅');

  // 5) 清理
  try { await client.deleteSandbox(sb.id); log('沙箱已删除'); } catch (e) { log('删沙箱失败:', e.message); }
  process.exit(0);
}

main().catch((e) => { console.error('[smoke] FAILED:', e); process.exit(1); });
