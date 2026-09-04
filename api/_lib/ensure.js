// api/_lib/ensure.js — Daytona 按需沙箱拉起 + drain.py 注入（幂等，单次 <10s）
// 设计：docs/architecture.md §4.3 —— 快照秒开，不留常驻进程
// 多用户：每个用户从共享快照拉起独立沙箱（sandboxNameFor），用完即毁（release）
// 本地模式（DATA_BACKEND=local）：复用 Daytona 算力，数据在本地（SQLite+文件），
//   由本地 server 通过 toolbox 推输入/执行 drain.py --local/拉产物/入库
import fs from 'node:fs';
import path from 'node:path';
import { DaytonaClient, DaytonaError, sleep } from '../../lib/daytona.js';
import drainSource from './drain_source.js';
import { db, storage } from './store.js';

const SNAPSHOT_NAME = process.env.SNAPSHOT_NAME || 'mineru-snap-baked';
const SANDBOX_NAME = process.env.SANDBOX_NAME || 'mineru-extractor-sandbox';
// 空闲自动停机分钟数：兜底回收（停机后磁盘保留，可唤醒复用）
const AUTO_STOP_MINUTES = Number(process.env.AUTO_STOP_MINUTES || 60);
// 沙箱寿命上限：即使释放逻辑失效，Daytona 侧也会在 TTL 到期后回收（防额度跑空）
const SANDBOX_TTL_MIN = Number(process.env.SANDBOX_TTL_MIN || 180);
// 沙箱资源规格（默认 2核/4G/10G；1G 内存无法运行 MinerU，会 OOM）
// 注意：快照模式下规格由快照决定（createSnapshot 时传入），沙箱继承
const SANDBOX_CPU = Number(process.env.SANDBOX_CPU || 2);
const SANDBOX_MEMORY_GB = Number(process.env.SANDBOX_MEMORY_GB || 4);
const SANDBOX_DISK_GB = Number(process.env.SANDBOX_DISK_GB || 10);
const REGION = process.env.REGION || 'us';
const SANDBOX_CLASS = process.env.SANDBOX_CLASS || 'container';
const LOCAL_MODE = process.env.DATA_BACKEND === 'local';
const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data');

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
        // 注意：必须用 python:3.11-slim（mineru 要求 >=3.10,<3.14；daytonaio/sandbox 基
        // 像 Python 3.14 装不上 mineru）。pip 安装失败会直接导致构建失败（不吞错），
        // 仅模型下载可容忍失败（失败则运行时自动下载）。
        const dockerfile = [
          'FROM python:3.11-slim',
          'RUN apt-get update && apt-get install -y --no-install-recommends \\',
          '        libgl1 libglib2.0-0 libgomp1 libsm6 libxext6 fonts-noto-cjk fonts-noto-core \\',
          '    && rm -rf /var/lib/apt/lists/*',
          'RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu',
          "RUN pip install --no-cache-dir 'mineru[core]>=3.4.0' && pip cache purge",
          'RUN mineru-models-download -s huggingface -m pipeline || true',
          'ENTRYPOINT ["/bin/bash", "-c", "exec \\"$@\\"", "--"]',
        ].join('\n');
        await c.createSnapshot({
          name: SNAPSHOT_NAME,
          buildInfo: { dockerfileContent: dockerfile },
          cpu: SANDBOX_CPU, memory: SANDBOX_MEMORY_GB, disk: SANDBOX_DISK_GB,
          regionId: REGION, sandboxClass: SANDBOX_CLASS,
        });
        return { ok: true, building: true, message: '快照构建中（首次约 5-20 分钟），构建完成后自动继续' };
      }
      // 快照存在但需确认构建状态：构建中返回 building 等待，失败则报错，
      // 只有 ready/active 等就绪态才创建沙箱（否则拿未完成快照建沙箱会卡死）
      const st = String(hit.state || hit.status || '').toLowerCase();
      const READY = ['ready', 'active', 'available', 'completed', 'built', 'ok'];
      const FAILED = ['error', 'build_failed', 'failed', 'destroyed', 'deleted'];
      if (FAILED.includes(st)) {
        return { ok: false, error: `快照构建失败（${st}），请删除后重试或检查 Daytona 构建日志` };
      }
      // 快照因闲置被 Daytona 停用（inactive）：先激活再继续，否则会永远卡在 building
      if (st === 'inactive') {
        await c.activateSnapshot(hit.id);
        return { ok: true, building: true, message: '快照激活中（约 1-3 分钟），激活完成后自动继续' };
      }
      if (!READY.includes(st)) {
        return { ok: true, building: true, message: `快照构建中（state=${st}，首次约 5-20 分钟），构建完成后自动继续` };
      }
      // 快照模式：沙箱继承快照规格（Daytona API 不接受此处传 cpu/memory/disk）
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
    process.env.APP_URL ? `APP_URL=${process.env.APP_URL}` : '',
    process.env.RELEASE_SECRET ? `RELEASE_SECRET=${process.env.RELEASE_SECRET}` : '',
    process.env.JOB_TIMEOUT_MIN ? `JOB_TIMEOUT_MIN=${process.env.JOB_TIMEOUT_MIN}` : '',
  ].filter(Boolean).join(' ');
  // 与本地模式一致：/tmp 下按任务隔离（沙箱内用户非 root，/root 无写权限）；
  // 后台启动用「子 shell」写法 `( setsid nohup … & )`，规避 process/execute 30s 硬上限
  const W = '/tmp/doclane-' + jobId;
  await tb.uploadFile(W + '/drain.py', Buffer.from(drainSource), 'drain.py');
  // 注意：env 必须放在子 shell 内、setsid 之前——若放在 `mkdir` 之前，变量只会作用于
  // mkdir（bash 临时赋值仅对首个命令生效），drain.py 拿不到 SUPABASE_* 会静默退出，
  // 导致任务永远卡在 preparing 且无任何日志。
  const script = `mkdir -p ${W} && ( ${env} setsid nohup python3 ${W}/drain.py ${jobId} >${W}/run.log 2>&1 < /dev/null & ) ; echo STARTED`;
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
  if (LOCAL_MODE) return ensureLocal(jobId);
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

// ---------- 本地模式编排（数据在本地，算力在 Daytona） ----------
function localOutputPath(jobId, rel) {
  return path.join(DATA_DIR, 'outputs', jobId, String(rel || '').replace(/^\/+/, ''));
}

// 用完即毁（本地/云端共用）：该用户无排队/待解析任务则销毁其沙箱。
// 本地 ensureLocal 与云端 routes/sandbox-release.js 都走这一份。
export async function releaseIfIdle(ownerId, currentJobId) {
  try {
    const pending = await db.select('jobs',
      `owner_id=eq.${ownerId}&status=in.(queued,uploaded,preparing,running)&select=id&limit=5`);
    const hasNext = (pending || []).some((j) => j.id !== currentJobId);
    if (!hasNext) {
      await destroySandbox(sandboxNameFor(ownerId));
      return true;
    }
  } catch { /* 查询/销毁失败不阻塞 */ }
  return false;
}

async function ensureLocal(jobId) {
  let job = null;
  try {
    const rows = await db.select('jobs', `id=eq.${jobId}&select=*&limit=1`);
    job = rows[0];
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
  if (!job) return { ok: false, error: '任务不存在' };

  const log = (msg) => ({ t: Date.now(), msg: String(msg).slice(0, 300) });
  const logs = Array.isArray(job.logs) ? job.logs.map((l) => ({ ...l })) : [];
  // 追加日志并立即落库（失败也能看到过程日志）
  const pushLog = async (msg) => {
    logs.push(log(msg));
    try {
      await db.update('jobs', 'id', jobId, {
        logs, updated_at: new Date().toISOString(),
      });
    } catch { /* 忽略 */ }
  };

  const fail = async (msg) => {
    try {
      await pushLog('失败：' + String(msg).slice(0, 300));
      await db.update('jobs', 'id', jobId, {
        status: 'error', error: String(msg).slice(0, 500), updated_at: new Date().toISOString(),
      });
    } catch { /* 忽略 */ }
    // 失败同样用完即毁（无排队任务则销毁沙箱）
    try { await releaseIfIdle(job.owner_id, jobId); } catch { /* 忽略 */ }
    return { ok: true, started: true, error: String(msg).slice(0, 200) };
  };

  try {
    const s = await ensureSandbox(job.owner_id);
    if (!s.ok) return s;
    if (s.building || s.warming) {
      // 写进度日志（去重），让用户看到沙箱在准备而不是"无响应"
      if (logs[logs.length - 1]?.msg !== s.message) {
        await pushLog(s.message);
      }
      return s;
    }

    // 已在解析中则跳过（幂等）
    try {
      const st = await db.select('jobs', `id=eq.${jobId}&select=status`);
      if (st[0] && ['preparing', 'running'].includes(st[0].status)) {
        return { ok: true, started: true, message: '任务已在解析中' };
      }
    } catch { /* 忽略 */ }

    // 串行化：同用户已有其他任务在处理则排队（本地模式一次一个，
    // 避免同一沙箱并发跑多个 MinerU 抢内存导致卡死）
    try {
      const busyRows = await db.select('jobs',
        `owner_id=eq.${job.owner_id}&status=in.(preparing,running)&select=id&limit=10`);
      if ((busyRows || []).some((j) => j.id !== jobId)) {
        return { ok: true, started: false, message: '已有任务在解析，排队等待' };
      }
    } catch { /* 查询失败不阻塞 */ }

    await db.update('jobs', 'id', jobId, { status: 'preparing', updated_at: new Date().toISOString() });
    await pushLog('沙箱已就绪，任务执行器已启动');

    const c = new DaytonaClient();
    const sb = await c.getSandbox(sandboxNameFor(job.owner_id));
    const tb = await c.toolbox(sb);

    // 1) 注入 drain.py + 上传输入文件
    //    用 /tmp 下按任务隔离的目录（沙箱内用户非 root，/root 无写权限）
    const W = '/tmp/doclane-' + jobId;
    await pushLog('正在上传输入文件到云沙箱…');
    await tb.uploadFile(W + '/drain.py', Buffer.from(drainSource), 'drain.py');
    const inputBuf = await storage.read('inputs', job.input_storage_path);
    const inputPath = W + '/input' + (job.ext || '.bin');
    await tb.uploadFile(inputPath, inputBuf, 'input' + (job.ext || '.bin'));

    // 2) 后台启动（process/execute 有 ~30s 硬上限；后台必须用「子 shell」写法
    //    `( setsid nohup cmd & )`，父命令立即结束，exec 才会快速返回）
    const tmo = Math.min(40 * 60, Number(process.env.JOB_TIMEOUT_MIN || 30) * 60);
    const st = await tb.exec(
      `mkdir -p ${W}/out && ( setsid nohup python3 ${W}/drain.py ${jobId} --local ${inputPath} ${W}/out >${W}/run.log 2>&1 < /dev/null & ) ; echo STARTED`,
      {}, 30);
    if (!/STARTED/.test(st.result || '')) {
      return fail('无法启动任务执行器：' + (st.result || '').slice(0, 200));
    }
    await pushLog('已启动 MinerU 提取（后台运行中）…');
    // 转入 running（与云模式一致：提取阶段显示"解析中"而非"准备中"）
    await db.update('jobs', 'id', jobId, { status: 'running', updated_at: new Date().toISOString() });

    // 3) 轮询 ingest.json（drain.py 在「产物收集 + 切段」完成后最后写入 = 完成信号；
    //    run.log 出现 ERROR = 失败；总超时兜底）
    //    注意：python:3.11-slim 沙箱无 pgrep/ps，进程探测不可用，改为日志/产物探测
    const deadline = Date.now() + tmo * 1000;
    let ingest = null;
    let lastErr = '';
    let pollCount = 0;
    while (Date.now() < deadline) {
      await sleep(10000);
      pollCount++;
      // 尝试拉 ingest（出现 = 完成）
      try {
        ingest = JSON.parse(await tb.downloadFile(W + '/out/ingest.json').then((b) => b.toString('utf8')));
        break;
      } catch { /* 还没完成 */ }
      // 每 3 轮（30s）写一次进度 + 检测 run.log 的 ERROR（drain.py 失败会 print "ERROR:" 到 stderr）
      if (pollCount % 3 === 0) {
        await pushLog(`MinerU 提取中…（已等待 ${Math.round(pollCount * 10)}s）`);
        try {
          const logTxt = await tb.downloadFile(W + '/run.log').then((b) => b.toString('utf8'));
          const m = logTxt.match(/ERROR:[\s\S]*/);
          if (m) { lastErr = m[0].slice(0, 800); break; }
        } catch { /* 日志暂不可读 */ }
      }
    }
    if (!ingest) {
      const detail = (lastErr || '任务超时（' + Math.round(tmo / 60) + ' 分钟）').slice(-800);
      return fail(detail);
    }

    // 任务可能已被用户取消/删除（沙箱进程无法终止，但跳过后续入库）
    try {
      const cur = await db.select('jobs', `id=eq.${jobId}&select=status,deleted_at`);
      const cj = cur[0];
      if (cj && (cj.deleted_at || !['preparing', 'running'].includes(cj.status))) {
        return { ok: true, started: true, message: '任务已取消/删除，跳过入库' };
      }
    } catch { /* 查询失败不阻塞 */ }

    // 4) 拉回产物（按 ingest.manifest；切段/bigram 已在 drain.py 内算好，与云端同一实现）
    const manifest = Array.isArray(ingest.manifest) ? ingest.manifest : [];
    await pushLog(`提取完成，拉取产物（${manifest.length} 个）…`);
    const saved = [];
    for (const m of manifest) {
      const buf = await tb.downloadFile(W + '/out/' + m.rel);
      const abs = localOutputPath(jobId, m.rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      saved.push({ rel: m.rel, size: buf.length, isMd: !!m.isMd });
    }

    // 5) 入库（documents + chunks，幂等先清旧；数据直接来自 ingest.json）
    const chunks = Array.isArray(ingest.chunks) ? ingest.chunks : [];
    await pushLog(`入库知识库（${chunks.length} 个检索片段）…`);
    await db.remove('chunks', 'doc_id', jobId);
    await db.remove('documents', 'id', jobId);
    await db.insert('documents', [{
      id: jobId, job_id: jobId, filename: job.original_name, ext: job.ext || '',
      size: job.size || 0, main_md: ingest.main_md_text || '', created_at: new Date().toISOString(),
    }], { select: 'id' });
    for (const c of chunks) {
      await db.insert('chunks', [{ doc_id: jobId, seq: c.seq, content: c.content, content_bigrams: c.bigrams }], { select: 'id' });
    }

    await pushLog(`完成：${saved.length} 个产物，${chunks.length} 个检索片段`);
    await db.update('jobs', 'id', jobId, {
      status: 'done', files: saved, main_md_path: ingest.main_md || null, error: null,
      quality: { level: 'ok' }, logs,
      updated_at: new Date().toISOString(),
    });
    // 用完即毁：无排队任务则销毁沙箱（与云端 release 共用 releaseIfIdle）
    await releaseIfIdle(job.owner_id, jobId);
    return { ok: true, started: true };
  } catch (e) {
    return fail(e.message || e);
  }
}
