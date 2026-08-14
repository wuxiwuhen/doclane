// scripts/sandbox-install-test.mjs — 在指定沙箱内真实安装 MinerU 并跑小测试（后台任务）
// 用法: node scripts/sandbox-install-test.mjs <sandboxId>
import 'dotenv/config';
import { DaytonaClient, sleep } from '../lib/daytona.js';

const id = process.argv[2];
if (!id) { console.error('需要 sandboxId'); process.exit(1); }
const c = new DaytonaClient();
const tb = await c.toolbox(await c.getSandbox(id));

const script = `
set -x
export UV_CACHE_DIR=/tmp/uv-cache
df -h / | tail -1
uv venv /opt/mineru-venv --python 3.13 -q && echo VENV_OK
df -h / | tail -1
uv pip install --python /opt/mineru-venv/bin/python --no-cache 'mineru[core]>=3.4.0' > /tmp/mineru-install.log 2>&1
echo INSTALL_EXIT:$?
df -h / | tail -1
du -sh /opt/mineru-venv 2>/dev/null
tail -3 /tmp/mineru-install.log
`;
const r = await tb.exec(script, {}, 60);
console.log(r.result.slice(0, 1200));
console.log('--- install exit:', /INSTALL_EXIT:(\d+)/.exec(r.result)?.[1]);
process.exit(0);
