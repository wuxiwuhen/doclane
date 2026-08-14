// api/_lib/ensure.js — Daytona 按需沙箱拉起 + drain.py 注入（幂等，单次 <10s）
// 设计：docs/architecture.md §4.3 —— 快照秒开，不留常驻进程
import { DaytonaClient, DaytonaError } from '../../lib/daytona.js';
import drainSource from './drain_source.js';

const SNAPSHOT_NAME = process.env.SNAPSHOT_NAME || 'mineru-snap-baked';
const SANDBOX_NAME = process.env.SANDBOX_NAME || 'mineru-extractor-sandbox';
// 空闲自动停机分钟数：与 docs/architecture.md 的「autoStop 60min 尾保回收」对齐；
// 停机后磁盘保留，下次任务 ensure 时 startSandbox 唤醒复用（可经 AUTO_STOP_MINUTES 覆盖）
const AUTO_STOP_MINUTES = Number(process.env.AUTO_STOP_MINUTES || 60);

export function snapshotName() { return SNAPSHOT_NAME; }
export function sandboxName() { return SANDBOX_NAME; }

export function getStatus() {
  const c = new DaytonaClient();
  return (async () => {
    const out = { mode: 'snapshot', snapshot: null, sandbox: null, workDir: null, mineru: null, warmedUp: null };
    try {
      const snaps = await c.listSnapshots();
      const hit = snaps.find((s) => s.name === SNAPSHOT_NAME || s.id === SNAPSHOT_NAME);
      out.snapshot = hit ? { id: hit.id, name: hit.name, state: hit.state || hit.status || 'unknown' }
                         : { name: SNAPSHOT_NAME, state: 'missing' };
    } catch (e) { out.snapshot = { error: e.message }; }
    try {
      const sb = await c.getSandbox(SANDBOX_NAME);
      out.sandbox = { id: sb.id, name: sb.name, state: sb.state };
      out.workDir = '/root';
      out.mineru = 'installed';
      out.warmedUp = true;
    } catch (e) { out.sandbox = { name: SANDBOX_NAME, state: 'missing' }; }
    return out;
  })();
}

/**
 * ensureSandbox：确保沙箱存在且运行。
 * 返回 { ok, warming, building, error, message } —— 耗时步骤立即返回，前端轮询续拉（幂等）。
 */
export async function ensureSandbox() {
  const c = new DaytonaClient();
  try {
    let sb = null;
    try { sb = await c.getSandbox(SANDBOX_NAME); } catch { sb = null; }

    if (!sb) {
      const snaps = await c.listSnapshots();
      const hit = snaps.find((s) => s.name === SNAPSHOT_NAME || s.id === SNAPSHOT_NAME);
      if (!hit) {
        const dockerfile = [
          'FROM daytonaio/sandbox:0.8.0',
          'RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu && \\',
          "    pip install --no-cache-dir 'mineru[core]>=3.4.0' && pip cache purge && \\",
          '    mineru-models-download -s huggingface -m pipeline || true',
        ].join('\n');
        await c.createSnapshot({ name: SNAPSHOT_NAME, buildInfo: { dockerfileContent: dockerfile } });
        return { ok: true, building: true, message: '快照构建中（首次约 5-20 分钟），构建完成后自动继续' };
      }
      await c.createSandbox({ name: SANDBOX_NAME, snapshot: hit.name, autoStopInterval: AUTO_STOP_MINUTES });
      return { ok: true, warming: true, message: '沙箱创建中（约 10-60 秒），稍候自动继续' };
    }

    if (!['started', 'running'].includes(sb.state)) {
      await c.startSandbox(sb.id || sb.name);
      return { ok: true, warming: true, message: '沙箱启动中（约 10-60 秒），稍候自动继续' };
    }
    return { ok: true, started: true, message: '沙箱已就绪' };
  } catch (e) {
    if (e instanceof DaytonaError && e.status === 403) {
      return { ok: false, error: 'Daytona API key 无权限（需 Sandboxes/Full Access）' };
    }
    return { ok: false, error: e.message };
  }
}

/** startDrain：在已运行的沙箱中注入 drain.py 并后台启动（处理 jobId） */
export async function startDrain(jobId) {
  const c = new DaytonaClient();
  const sb = await c.getSandbox(SANDBOX_NAME);
  const tb = await c.toolbox(sb);
  const env = [
    `SUPABASE_URL=${process.env.SUPABASE_URL}`,
    `SUPABASE_SERVICE_ROLE_KEY=${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    process.env.EMBEDDING_API_KEY ? `EMBEDDING_API_KEY=${process.env.EMBEDDING_API_KEY}` : '',
    process.env.EMBEDDING_BASE_URL ? `EMBEDDING_BASE_URL=${process.env.EMBEDDING_BASE_URL}` : '',
    `EMBEDDING_MODEL=${process.env.EMBEDDING_MODEL || 'text-embedding-3-small'}`,
  ].filter(Boolean).join(' ');
  const script = `${env} setsid nohup python3 /root/drain.py ${jobId} >/tmp/drain-${jobId}.log 2>&1 < /dev/null & echo STARTED`;
  await tb.uploadFile('/root/drain.py', Buffer.from(drainSource), 'drain.py');
  const r = await tb.exec(script, {}, 20);
  if (!/STARTED/.test(r.result || '')) {
    throw new Error('无法启动 drain.py：' + (r.result || '').slice(0, 200));
  }
  return { ok: true, started: true };
}

/** ensure(jobId)：完整链路 = ensureSandbox +（就绪时）startDrain */
export async function ensure(jobId) {
  const s = await ensureSandbox();
  if (!s.ok) return s;
  if (s.building || s.warming) return s;
  try {
    const d = await startDrain(jobId);
    return { ok: true, started: true, message: '任务执行器已启动' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
