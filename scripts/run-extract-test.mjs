// scripts/run-extract-test.mjs — 在沙箱内跑真实 MinerU 提取（预热模型 + PDF → Markdown）
// 用法: node scripts/run-extract-test.mjs <sandboxId> [pdf路径]
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { DaytonaClient, sleep } from '../lib/daytona.js';

const id = process.argv[2];
const pdfPath = process.argv[3] || 'test-sample.pdf';
if (!id) { console.error('需要 sandboxId'); process.exit(1); }
const c = new DaytonaClient();
const tb = await c.toolbox(await c.getSandbox(id));
const which = await tb.exec('command -v mineru', {}, 20);
const MINERU = (which.result || '').trim() || '/home/daytona/mineru-venv/bin/mineru';

console.log('[t1] mineru --version');
const v = await tb.exec(`${MINERU} --version 2>&1 | head -2`, {}, 30);
console.log(v.result);

console.log('[t2] 上传测试 PDF');
await tb.uploadFile('/home/daytona/test.pdf', fs.readFileSync(pdfPath), 'test.pdf');

console.log('[t3] 预热模型（首次下载，观察内存/磁盘）');
const script = [
  '#!/bin/bash',
  'export HF_HOME=/home/daytona/.cache/huggingface',
  `cd /home/daytona`,
  `${MINERU} -p /home/daytona/test.pdf -o /home/daytona/out1 --backend pipeline --output-format markdown > /home/daytona/extract1.log 2>&1`,
  'echo "__EXTRACT1_DONE:$?" >> /home/daytona/extract1.log',
].join('\n');
await tb.uploadFile('/home/daytona/extract.sh', Buffer.from(script), 'extract.sh');
await tb.exec('rm -rf /home/daytona/out1; nohup bash /home/daytona/extract.sh >/dev/null 2>&1 & echo RUNNING', {}, 15);

let last = '';
const deadline = Date.now() + 20 * 60 * 1000;
while (Date.now() < deadline) {
  await sleep(15000);
  const r = await tb.exec(`tail -c 1200 /home/daytona/extract1.log 2>/dev/null; echo; echo MEM=\$(cat /sys/fs/cgroup/memory.current 2>/dev/null); df -h / | tail -1 | awk '{print "DISK_USED:"\$3}'; ls /home/daytona/out1 2>/dev/null | head -5`, {}, 20);
  const text = (r.result || '').trim();
  if (text !== last && text) { last = text; console.log('---', text.split('\n').slice(-6).join('\n')); }
  if (/__EXTRACT1_DONE:0/.test(text)) break;
  if (/__EXTRACT1_DONE:[1-9]/.test(text)) { console.log('提取失败，日志尾部：'); console.log(text.slice(-800)); process.exit(1); }
}
if (!/__EXTRACT1_DONE/.test(last)) { console.log('超时'); process.exit(1); }

console.log('[t4] 结果');
const list = await tb.exec(`find /home/daytona/out1 -type f | sort; echo ---; cat /home/daytona/out1/*.md 2>/dev/null | head -40`, {}, 20);
console.log(list.result);

process.exit(0);
