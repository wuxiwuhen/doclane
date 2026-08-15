// api/_lib/ensure.js — Daytona 按需沙箱拉起 + drain.py 注入（幂等，单次 <10s）
// 设计：docs/architecture.md §4.3 —— 快照秒开，不留常驻进程
// 多用户：每个用户从共享快照拉起独立沙箱（sandboxNameFor），用完即毁（release）
import { DaytonaClient, DaytonaError } from '../../lib/daytona.js';
import drainSource from './drain_source.js';
import { db } from './supabase.js';

const SNAPSHOT_NAME = process.env.SNAPSHOT_NAME || 'mineru-snap-baked';
const SANDBOX_NAME = process.env.SANDBOX_NAME || 'mineru-extractor-sandbox';
// 空闲自动停机分钟数：兜底回收（停机后磁盘保留，可唤醒复用）
const AUTO_STOP_MINUTES = Number(process.env.AUTO_STOP_MINUTES || 60);
// 沙箱寿命上限：即使释放逻辑失效，Daytona 侧也会在 TTL 到期后回收（防额度跑空）
const SANDBOX_TTL_MIN = Number(process.env.SANDBOX_TTL_MIN || 180);

export function snapshotName() { return SNAPSHOT_NAME; }
export function sandboxName() { return SANDBOX_NAME; }

/** 用户沙箱名：共享快照 + 用户 id 前 8 位 → 每用户独立沙箱 */
export function sandboxNameFor(userId) {
  const safe = String(userId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8);
  return `${SANDBOX_NAME}-${safe || 'anon'}`;
}

export function getStatus(userId) {
  const c = new DaytonaClient();
  const name = userId ? sandboxNameFor(userId) : SANDBOX_NAME;
  return (async () => {
    const out = { mode: 'snapshot', snapshot: null, sandbox: null, workDir: null, mineru: null, warmedUp: null };
    try {
      const snaps = await c.listSnapshots();
      const hit = snaps.find((s) => s.name === SNAPSHOT_NAME || s.id === SNAPSHOT_NAME);
      out.snapshot = hit ? { id: hit.id, name: hit.name, state: hit.state || hit.status || 'unknown' }
                         : { name: SNAPSHOT_NAME, state: 'missing' };
    } catch (e) { out.snapshot = { error: e.message }; }
    try {
      const sb = await c.getSandbox(name);
      out.sandbox = { id: sb.id, name: sb.name, state: sb.state };
      out.workDir = '/root';
      out.mineru = 'installed';
      out.warmedUp = true;
    } catch (e) { out.sandbox = { name, state: 'missing' }; }
    return out;
  })();
}

/**
 * ensureSandbox(userId)：确保该用户的沙箱存在且运行。
 * 返回 { ok, warming, building, started, error, message } —— 耗时步骤立即返回，前端轮询续拉（幂等）。
 */
export async function ensureSandbox(userId) {
  const c = new DaytonaClient();
  const name = userId ? sandboxNameFor(userId) : SANDBOX_NAME;
  try {
    let sb = null;
    try { sb = await c.getSandbox(name); } catch { sb = null; }

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
      await c.createSandbox({ name, snapshot: hit.name, autoStopInterval: AUTO_STOP_MINUTES, ttlMinutes: SANDBOX_TTL_MIN });
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

/** startDrain：在用户沙箱中注入 drain.py 并后台启动（处理 jobId） */
export async function startDrain(jobId, userId) {
  const c = new DaytonaClient();
  const sb = await c.getSandbox(sandboxNameFor(userId));
  const tb = await c.toolbox(sb);
  const env = [
    `SUPABASE_URL=${process.env.SUPABASE_URL}`,
    `SUPABASE_SERVICE_ROLE_KEY=${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    process.env.EMBEDDING_API_KEY ? `EMBEDDING_API_KEY=${process.env.EMBEDDING_API_KEY}` : '',
    process.env.EMBEDDING_BASE_URL ? `EMBEDDING_BASE_URL=${process.env.EMBEDDING_BASE_URL}` : '',
    `EMBEDDING_MODEL=${process.env.EMBEDDING_MODEL || 'text-embedding-3-small'}`,
    process.env.APP_URL ? `APP_URL=${process.env.APP_URL}` : '',
    process.env.RELEASE_SECRET ? `RELEASE_SECRET=${process.env.RELEASE_SECRET}` : '',
    process.env.JOB_TIMEOUT_MIN ? `JOB_TIMEOUT_MIN=${process.env.JOB_TIMEOUT_MIN}` : '',
  ].filter(Boolean).join(' ');
  const script = `${env} setsid nohup python3 /root/drain.py ${jobId} >/tmp/drain-${jobId}.log 2>&1 < /dev/null & echo STARTED`;
  await tb.uploadFile('/root/drain.py', Buffer.from(drainSource), 'drain.py');
  const r = await tb.exec(script, {}, 20);
  if (!/STARTED/.test(r.result || '')) {
    throw new Error('无法启动 drain.py：' + (r.result || '').slice(0, 200));
  }
  return { ok: true, started: true };
}

/** 销毁沙箱（先停机再删除；仅当沙箱确实不存在时视为成功） */
export async function destroySandbox(name) {
  const c = new DaytonaClient();
  try { await c.stopSandbox(name); } catch { /* 未运行/已停止 */ }
  try {
    await c.deleteSandbox(name);
  } catch (e) {
    let exists = true;
    try { await c.getSandbox(name); } catch { exists = false; }
    if (exists) throw e;
  }
}

/** ensure(jobId)：完整链路 = ensureSandbox(owner) +（就绪时）startDrain
 *  可幂等续拉：任务已在 preparing/running 时跳过 startDrain，避免轮询重复启动；
 *  startDrain 成功后立即置 preparing，堵住轮询竞态窗口。 */
export async function ensure(jobId) {
  let job = null;
  try {
    const rows = await db.select('jobs', `id=eq.${jobId}&select=*&limit=1`);
    job = rows[0];
  } catch { /* 查询失败由后续报错 */ }
  if (!job) return { ok: false, error: '任务不存在' };

  const s = await ensureSandbox(job.owner_id);
  if (!s.ok) return s;
  if (s.building || s.warming) return s;

  // 已在解析中则跳过（幂等续拉防重复启动）
  try {
    const rows = await db.select('jobs', `id=eq.${jobId}&select=status`);
    if (rows[0] && ['preparing', 'running'].includes(rows[0].status)) {
      return { ok: true, started: true, message: '任务已在解析中' };
    }
  } catch { /* 查询失败不阻塞启动 */ }

  const d = await startDrain(jobId, job.owner_id);
  if (d.ok) {
    try {
      await db.update('jobs', 'id', jobId, { status: 'preparing', updated_at: new Date().toISOString() });
    } catch { /* drain.py 会自行置 preparing，忽略 */ }
  }
  return d;
}

/** ensureAllUploaded：沙箱就绪后拉起所有卡在 uploaded 的任务（管理员/轮询兜底） */
export async function ensureAllUploaded() {
  const rows = await db.select('jobs', 'status=eq.uploaded&select=id');
  let resumed = 0;
  for (const j of rows) {
    const e = await ensure(j.id);
    if (e.ok && e.started) resumed++;
  }
  return resumed;
}
