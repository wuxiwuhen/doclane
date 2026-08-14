// server.js — 内容提取工具服务端：上传 → Daytona 沙箱 MinerU 提取 → 本地保存/查看
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DaytonaClient, DaytonaError } from './lib/daytona.js';
import { Extractor } from './lib/extractor.js';
import { StateStore } from './lib/state.js';
import { KnowledgeBase, highlightSnippet as highlight } from './lib/knowledge.js';
import { exportPdf } from './lib/export-pdf.js';
import { embedTexts, embeddingConfigured } from './lib/embedding.js';
import { FileStore } from './lib/filestore/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_TMP = path.join(DATA_DIR, 'uploads', 'tmp');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const JOBS_INDEX = path.join(DATA_DIR, 'jobs', 'index.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT || 3088);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 300);
const DATA_ROOT = process.env.DATA_ROOT || DATA_DIR; // 文件存储根目录（可配置，默认 data/）

for (const d of [UPLOAD_TMP, JOBS_DIR]) fs.mkdirSync(d, { recursive: true });

const stateStore = new StateStore(STATE_FILE);
const kb = new KnowledgeBase(path.join(DATA_DIR, 'knowledge.db'));
const fileStore = new FileStore({ rootDir: DATA_ROOT });
const daytona = new DaytonaClient();
const extractor = new Extractor({
  stateStore,
  dataDir: DATA_DIR,
  client: daytona,
  snapshotName: process.env.SNAPSHOT_NAME || 'mineru-extractor',
  sandboxName: process.env.SANDBOX_NAME || 'mineru-extractor-sandbox',
});

// ---------- 任务存储 ----------
let jobs = [];
try { jobs = JSON.parse(fs.readFileSync(JOBS_INDEX, 'utf8')); } catch { jobs = []; }
const persistJobs = () => fs.writeFileSync(JOBS_INDEX, JSON.stringify(jobs, null, 2));

function getJob(id) { return jobs.find((j) => j.id === id); }

function appendLog(job, msg) {
  job.logs = job.logs || [];
  job.logs.push({ t: Date.now(), msg });
  if (job.logs.length > 800) job.logs = job.logs.slice(-800);
}
const saveJob = (job) => persistJobs();

// ---------- 上传 ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_TMP,
    filename: (_req, file, cb) => {
      file.originalname = fixName(file.originalname);
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname)}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// 支持解析的文件扩展名（MinerU 3.4：pdf / 图片 / docx / pptx / xlsx）
const SUPPORTED_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif', '.tif', '.tiff', '.docx', '.pptx', '.xlsx']);

// busboy/multer 对 multipart filename 默认按 latin1 解码，中文文件名会变乱码；
// 转回 UTF-8（ASCII 文件名不受影响）
function fixName(name) {
  try {
    const s = Buffer.from(String(name), 'latin1').toString('utf8');
    return s.includes('\uFFFD') ? String(name) : s;
  } catch { return String(name); }
}

/** 从本地文件创建任务并入队 */
function createJobFromFile(filePath, originalName, size) {
  const id = crypto.randomUUID();
  const ext = path.extname(originalName).toLowerCase();
  const job = {
    id,
    originalName,
    ext,
    size,
    inputPath: filePath,
    status: 'queued',
    logs: [{ t: Date.now(), msg: `已接收 ${originalName}，进入队列` }],
    files: [], mainMd: null, error: null,
    createdAt: Date.now(), updatedAt: Date.now(), durationMs: null,
  };
  jobs.unshift(job);
  saveJob(job);
  enqueue(job);
  return job;
}

/** 递归扫描目录下所有支持的文件 */
function scanFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scanFiles(full, out);
    else if (SUPPORTED_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

const unzip = promisify(execFile);

// ---------- 任务队列（串行，避免沙箱内并发争抢 CPU） ----------
let queue = Promise.resolve();
function enqueue(job) {
  queue = queue.then(async () => {
    if (job.status !== 'queued') return;
    job.status = 'running';
    saveJob(job);
    try {
      const result = await extractor.runJob(job, (msg) => { appendLog(job, msg); saveJob(job); });
      job.status = 'done';
      job.files = result.files;
      job.mainMd = result.mainMd;
      job.durationMs = result.durationMs;
      appendLog(job, `完成：${result.files.length} 个文件，耗时 ${(result.durationMs / 1000).toFixed(0)}s`);
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      appendLog(job, `失败：${e.message}`);
    }
    // 提取成功且有正文 → 自动入库到知识库（供全文检索）
    if (job.status === 'done' && job.mainMd) {
      const md = assessJobQuality(job);
      if (job.quality && job.quality.level !== 'ok') {
        appendLog(job, `质量校验：⚠ ${job.quality.reasons.join('；')}`);
      }
      ingestJob(job);
    } else if (job.status === 'error') {
      assessJobQuality(job);
    }
    // 异步补向量（语义检索）
    ensureEmbeddings();
    job.updatedAt = Date.now();
    saveJob(job);
  }).catch((e) => { console.error('queue error', e); });
}

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
// 前端静态资源禁用缓存，改动后刷新即生效（开发/演示期）
app.use((req, res, next) => {
  if (req.path === '/' || /\.(html|js|css)$/.test(req.path)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'web')));
app.use('/vendor/marked', express.static(path.join(__dirname, 'node_modules', 'marked')));
app.use('/vendor/katex', express.static(path.join(__dirname, 'node_modules', 'katex', 'dist')));

const outputPath = (jobId, rel) => {
  const base = path.resolve(path.join(JOBS_DIR, jobId, 'output'));
  const target = path.resolve(base, rel);
  if (!target.startsWith(base + path.sep) && target !== base) throw new Error('非法路径');
  return target;
};

// 提取结果入库到知识库（幂等）
function ingestJob(job) {
  if (job.status !== 'done' || !job.mainMd || kb.getDocument(job.id)) return false;
  try {
    const md = fs.readFileSync(outputPath(job.id, job.mainMd), 'utf8');
    const chunks = kb.ingest({
      id: job.id, jobId: job.id,
      filename: job.originalName, ext: job.ext, size: job.size,
      mainMd: md, createdAt: job.createdAt,
    });
    appendLog(job, `已入库知识库（${chunks} 个检索片段）`);
    saveJob(job);
    return true;
  } catch (e) {
    appendLog(job, `入库失败：${e.message}`);
    saveJob(job);
    return false;
  }
}

// L1 自动质量校验：正文缺失/产物缺失/正文异常短 + OCR 置信度（片段阈值 0.7）
function assessQuality(job, md, ocrScores) {
  const q = { level: 'ok', reasons: [] };
  if (!job.mainMd || !md || !md.trim()) {
    q.level = 'error'; q.reasons.push('未产出正文');
  } else {
    const len = md.trim().length;
    if (len < 50 && job.size > 10000) { q.level = 'warn'; q.reasons.push('正文过短，可能提取不完整'); }
  }
  if (!(job.files || []).length) { q.level = 'error'; q.reasons.push('无产物文件'); }
  // OCR 置信度：<0.7 视为低置信片段；整体过低 → 识别不可用
  if (ocrScores && ocrScores.length >= 3) {
    const avg = ocrScores.reduce((a, b) => a + b, 0) / ocrScores.length;
    const lowRatio = ocrScores.filter((s) => s < 0.7).length / ocrScores.length;
    q.avgScore = Number(avg.toFixed(3));
    if (avg < 0.6 || lowRatio > 0.5) {
      q.level = 'error';
      q.reasons.push(`整体 OCR 识别置信度过低（平均 ${avg.toFixed(2)}，${(lowRatio * 100).toFixed(0)}% 片段低于 0.7），识别结果基本不可用`);
    } else if (avg < 0.7 || lowRatio > 0.3) {
      q.level = q.level === 'error' ? 'error' : 'warn';
      q.reasons.push(`存在较多低置信度片段（平均 ${avg.toFixed(2)}，${(lowRatio * 100).toFixed(0)}% 低于 0.7），建议人工核对`);
    }
  }
  return q;
}

// 递归找产物目录下的 *_middle.json（含 OCR 置信度）
function scanMiddleJson(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const r = scanMiddleJson(full); if (r) return r; }
    else if (e.name.endsWith('_middle.json')) return full;
  }
  return null;
}

function extractOcrScores(middlePath) {
  try {
    const text = fs.readFileSync(middlePath, 'utf8');
    return [...text.matchAll(/"score"\s*:\s*([0-9.]+)/g)]
      .map((m) => parseFloat(m[1])).filter((s) => s >= 0 && s <= 1);
  } catch { return []; }
}

// 提取低置信度 OCR 片段：{content, score, bbox}，用于正文标记 + 原图区域核对（阈值 0.7）
// 兼容多种 middle JSON 结构：text 块（span.content）与 table 块（span.html），
// 表格块按单元格拆分为独立标记点（否则拼接文本跨 <td> 无法匹配渲染后的 DOM）；
// score 可能在 span 自身或父级块上（向下继承）；按 content+bbox 去重
function extractLowConfidenceSpans(middlePath, threshold = 0.7, limit = 100) {
  try {
    const data = JSON.parse(fs.readFileSync(middlePath, 'utf8'));
    const spans = [];
    const seen = new Set();
    const push = (text, score, bbox) => {
      const t = String(text || '').replace(/\s+/g, ' ').trim();
      if (!t) return;
      const key = `${t}|${bbox.join(',')}`;
      if (!seen.has(key)) { seen.add(key); spans.push({ content: t, score, bbox }); }
    };
    (function walk(n, inheritedScore) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach((it) => walk(it, inheritedScore)); return; }
      const score = typeof n.score === 'number' ? n.score : inheritedScore;
      if (Array.isArray(n.bbox) && typeof score === 'number' && score < threshold) {
        if (typeof n.content === 'string' && n.content.trim()) {
          push(n.content, score, n.bbox);
        } else if (typeof n.html === 'string' && n.html.includes('<')) {
          // 表格块：按单元格拆分，保证能匹配渲染后的表格 DOM
          const cells = [...n.html.matchAll(/<t[dh][^>]*>([^<]*)<\/t[dh]>/g)].map((m) => m[1].trim()).filter(Boolean);
          if (cells.length) cells.forEach((c) => push(c, score, n.bbox));
          else push(n.html.replace(/<[^>]+>/g, ' '), score, n.bbox);
        }
      }
      for (const k of Object.keys(n)) walk(n[k], score);
    })(data, null);
    spans.sort((a, b) => a.score - b.score);
    return spans.slice(0, limit);
  } catch { return []; }
}

// 剩余未人工修正的低置信片段数（当前质检状态）
function calcRemainingLow(job) {
  const low = job.quality?.lowConfidence || [];
  if (!low.length) return 0;
  const corrected = new Set((job.corrections || []).map((c) => c.original));
  return low.filter((s) => !corrected.has(s.content)).length;
}

// 为任务计算并写入质量标记（返回 md 供入库复用）
function assessJobQuality(job) {
  if (job.status !== 'done' || !job.mainMd) {
    job.quality = job.status === 'error' ? { level: 'error', reasons: [job.error || '解析失败'] } : null;
    return null;
  }
  let md = null;
  try { md = fs.readFileSync(outputPath(job.id, job.mainMd), 'utf8'); } catch { /* 产物已清理 */ }
  let ocrScores = null;
  let lowConfidence = null;
  let pageSize = null;
  let originType = null;
  try {
    const mid = scanMiddleJson(path.join(JOBS_DIR, job.id, 'output'));
    if (mid) {
      ocrScores = extractOcrScores(mid);
      lowConfidence = extractLowConfidenceSpans(mid);
      const data = JSON.parse(fs.readFileSync(mid, 'utf8'));
      if (data.pdf_info?.[0]?.page_size) pageSize = data.pdf_info[0].page_size;
    }
    const ext = path.extname(job.originalName || '').toLowerCase();
    originType = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'].includes(ext) ? 'image' : 'pdf';
  } catch { /* ignore */ }
  job.quality = assessQuality(job, md, ocrScores);
  job.quality.lowConfidence = lowConfidence || [];
  job.quality.pageSize = pageSize;
  job.quality.originType = originType;
  job.quality.remainingLow = calcRemainingLow(job);
  return md;
}

// 启动时恢复中断任务：服务重启后，running/queued 任务的轮询循环已丢失，
// 标记为 error 提示重试（避免永远卡在 running）
for (const job of jobs) {
  if (job.status === 'running' || job.status === 'queued') {
    const old = job.status;
    job.status = 'error';
    job.error = `服务重启中断（原状态 ${old}），请重试`;
    appendLog(job, '服务重启，解析中断，请手动重试');
    job.updatedAt = Date.now();
  }
}
persistJobs();

// 启动时把历史已完成任务补入库
for (const job of jobs) {
  assessJobQuality(job);
  ingestJob(job);
}

// ---------- 向量补齐（异步，不阻塞任务队列） ----------
let embeddingRunning = false;
async function ensureEmbeddings() {
  if (!embeddingConfigured() || embeddingRunning) return;
  embeddingRunning = true;
  try {
    const pending = kb.chunksWithoutEmbedding(500);
    if (!pending.length) return;
    const vecs = await embedTexts(pending.map((p) => p.content.slice(0, 800)));
    pending.forEach((p, i) => kb.setEmbedding(p.id, vecs[i]));
    console.log(`[embedding] 已补齐 ${pending.length} 个片段向量，剩余 ${kb.countPendingEmbeddings()}`);
  } catch (e) {
    console.error('[embedding] 失败:', e.message.slice(0, 200));
  } finally {
    embeddingRunning = false;
  }
}
ensureEmbeddings();

app.get('/api/health', async (_req, res) => {
  let daytonaOk = false, daytonaMsg = '';
  try { await daytona.health(); daytonaOk = true; } catch (e) { daytonaMsg = e.message; }
  let status = {};
  try { status = await extractor.getStatus(); } catch (e) { status = { error: e.message }; }
  res.json({ ok: daytonaOk, daytona: daytonaOk ? 'ok' : daytonaMsg, ...status });
});

app.post('/api/jobs', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '缺少文件字段 file' });
  if (!SUPPORTED_EXT.has(path.extname(req.file.originalname).toLowerCase())) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: `暂不支持该格式（支持: ${[...SUPPORTED_EXT].join(' ')}）` });
  }
  const job = createJobFromFile(req.file.path, req.file.originalname, req.file.size);
  res.status(202).json({ job: publicJob(job) });
});

// 批量导入：ZIP 压缩包（含子目录），解压后逐个入队
app.post('/api/jobs/batch', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '缺少文件字段 file' });
  if (path.extname(req.file.originalname).toLowerCase() !== '.zip') {
    return res.status(400).json({ error: '批量导入请上传 ZIP 压缩包' });
  }
  const destDir = path.join(DATA_DIR, 'uploads', 'batch', `${Date.now()}`);
  fs.mkdirSync(destDir, { recursive: true });
  try {
    await unzip('unzip', ['-o', '-q', req.file.path, '-d', destDir]);
  } catch (e) {
    return res.status(400).json({ error: `解压失败（请确认是有效的 ZIP）: ${e.message.slice(0, 100)}` });
  }
  const files = scanFiles(destDir);
  const created = [];
  for (const f of files) {
    const rel = path.relative(destDir, f);
    const job = createJobFromFile(f, path.basename(rel), fs.statSync(f).size);
    created.push({ filename: rel, jobId: job.id });
  }
  // 汇总日志：批量导入记录为一条任务日志挂到第一个任务上
  if (created.length) {
    const first = getJob(created[0].jobId);
    appendLog(first, `批量导入完成：共 ${created.length} 个文件入队（压缩包 ${req.file.originalname}）`);
    saveJob(first);
  }
  res.status(202).json({ created: created.length, files: created });
});

app.get('/api/jobs', (_req, res) => {
  res.json({ jobs: jobs.filter((j) => !j.deletedAt).map(publicJob) });
});

// 回收站列表
app.get('/api/trash', (_req, res) => {
  res.json({ jobs: jobs.filter((j) => j.deletedAt).map(publicJob) });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json({ job: publicJob(job) });
});

app.get('/api/jobs/:id/log', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  const lines = Number(req.query.lines || 200);
  res.json({ logs: job.logs.slice(-lines) });
});

// ---------- 知识库 ----------
app.get('/api/kb', (_req, res) => {
  res.json({ stats: kb.stats(), documents: kb.listDocuments() });
});

app.get('/api/kb/:id', (req, res) => {
  const doc = kb.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: '文档不在知识库中' });
  res.json({ document: doc });
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ query: '', total: 0, hits: [], mode: 'hybrid', semanticEnabled: embeddingConfigured() });
  const mode = ['keyword', 'semantic', 'hybrid'].includes(req.query.mode) ? req.query.mode : 'hybrid';
  const semanticEnabled = embeddingConfigured();
  let queryVec = null;
  if (mode !== 'keyword' && semanticEnabled) {
    try {
      const [v] = await embedTexts([q]);
      queryVec = v;
    } catch (e) {
      console.error('[search] embedding 失败，降级关键词:', e.message.slice(0, 120));
    }
  }
  if (mode === 'semantic' && !queryVec) {
    return res.json({ query: q, total: 0, hits: [], mode, semanticEnabled, degraded: true, error: semanticEnabled ? '语义检索失败' : '未配置 Embedding API（.env 设置 EMBEDDING_API_KEY）' });
  }
  let hits;
  if (mode === 'keyword') hits = kb.keywordSearch(q, { limit: 20 }).hits;
  else if (mode === 'semantic') {
    hits = kb.semanticSearch(queryVec, { limit: 20 }).map((r) => {
      const d = kb.getDocument(r.doc_id);
      return { docId: r.doc_id, filename: d?.filename || r.doc_id, ext: d?.ext || '', createdAt: d?.created_at || null, snippet: highlight(r.content, q), source: 'semantic', score: r.score };
    });
  } else {
    hits = kb.hybridSearch(q, queryVec, { limit: 20 }).map((r) => {
      const d = kb.getDocument(r.docId);
      return { docId: r.docId, filename: d?.filename || r.docId, ext: d?.ext || '', createdAt: d?.created_at || null, snippet: highlight(r.content, q), source: 'hybrid', score: r.score };
    });
  }
  res.json({ query: q, total: hits.length, hits, mode, semanticEnabled, degraded: mode !== 'keyword' && !queryVec });
});

// 应用人工修正到 md（按记录顺序替换；原始提取 md 文件本身永不被改写）
function applyCorrections(md, corrections) {
  let out = md;
  for (const c of corrections || []) {
    const idx = out.indexOf(c.original);
    if (idx >= 0) out = out.slice(0, idx) + c.correct + out.slice(idx + c.original.length);
  }
  return out;
}

// 人工修正：只记录修正层（不改写原始提取 md），展示/检索用"原始+修正"合成
app.post('/api/jobs/:id/correction', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job || !job.mainMd) return res.status(404).json({ error: '任务不存在或无可修正正文' });
  const { original, correct } = req.body || {};
  if (!original || typeof original !== 'string' || !correct || typeof correct !== 'string') {
    return res.status(400).json({ error: '缺少修正内容' });
  }
  let rawMd;
  try { rawMd = fs.readFileSync(outputPath(job.id, job.mainMd), 'utf8'); } catch { return res.status(404).json({ error: '正文文件不存在' }); }
  // 在当前修正版中定位（防止对同一片段重复修正）
  const current = applyCorrections(rawMd, job.corrections || []);
  const idx = current.indexOf(original);
  if (idx < 0) return res.status(404).json({ error: '原文中未找到该片段（可能已被修正），请刷新重试' });

  job.corrections = job.corrections || [];
  job.corrections.push({ original, correct, at: Date.now() });
  appendLog(job, `人工修正：「${original.slice(0, 20)}」→「${correct.slice(0, 20)}」`);

  // 修正后的内容重新入库（检索/向量用修正版）
  const corrected = applyCorrections(rawMd, job.corrections);
  try {
    kb.remove(job.id);
    const chunks = kb.ingest({
      id: job.id, jobId: job.id,
      filename: job.originalName, ext: job.ext, size: job.size,
      mainMd: corrected, createdAt: job.createdAt,
    });
    appendLog(job, `修正后已重新入库（${chunks} 个片段）`);
    ensureEmbeddings();
  } catch (e) {
    appendLog(job, `修正后重新入库失败：${e.message}`);
  }
  if (job.quality) job.quality.remainingLow = calcRemainingLow(job);
  saveJob(job);
  res.json({ ok: true, corrections: job.corrections.length, quality: job.quality });
});

// 修正版正文（原始 md + 修正覆盖层，供前端渲染）
app.get('/api/jobs/:id/corrected', (req, res) => {
  const job = getJob(req.params.id);
  if (!job || !job.mainMd) return res.status(404).json({ error: '任务不存在' });
  try {
    const rawMd = fs.readFileSync(outputPath(job.id, job.mainMd), 'utf8');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(applyCorrections(rawMd, job.corrections || []));
  } catch {
    res.status(404).json({ error: '正文文件不存在' });
  }
});

// 修正历史（审计/回滚参考）
app.get('/api/jobs/:id/corrections', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json({ corrections: job.corrections || [] });
});

// 原始上传文件访问（质检核对用，图片按比例裁剪 / PDF 后续接入）
app.get('/api/jobs/:id/original', (req, res) => {
  const job = getJob(req.params.id);
  if (!job || !job.inputPath || !fs.existsSync(job.inputPath)) return res.status(404).json({ error: '原始文件不存在' });
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(job.inputPath);
});

/** 软删除：移入回收站（文件保留，退出知识库检索）；供单删与批量复用 */
function softDeleteJob(job) {
  job.deletedAt = Date.now();
  job.updatedAt = Date.now();
  try { kb.remove(job.id); } catch { /* ignore */ }
  saveJob(job);
}

/** 彻底删除：物理清理文件 + 移除记录（回收站内使用） */
async function purgeJob(job) {
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) jobs.splice(idx, 1);
  persistJobs();
  await fileStore.deletePrefix(`jobs/${job.id}`);
  if (job.inputPath) fs.rmSync(job.inputPath, { force: true });
  try { kb.remove(job.id); } catch { /* ignore */ }
}

// ---------- 任务/文档管理 ----------

/** 删除任务：移入回收站（软删除，文件保留可恢复） */
app.delete('/api/jobs/:id', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.status === 'running') return res.status(409).json({ error: '任务解析中，无法删除（可等待完成或销毁沙箱）' });
  if (job.deletedAt) return res.status(409).json({ error: '任务已在回收站' });
  softDeleteJob(job);
  res.json({ ok: true, trashed: true });
});

/** 恢复：从回收站还原（重新入库知识库） */
app.post('/api/jobs/:id/restore', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (!job.deletedAt) return res.status(409).json({ error: '任务不在回收站' });
  delete job.deletedAt;
  job.updatedAt = Date.now();
  appendLog(job, '已从回收站恢复');
  ingestJob(job); // done 且有正文则重新入库
  saveJob(job);
  res.json({ job: publicJob(job) });
});

/** 彻底删除单个（回收站内） */
app.delete('/api/trash/:id', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (!job.deletedAt) return res.status(409).json({ error: '任务不在回收站' });
  await purgeJob(job);
  res.json({ ok: true });
});

/** 清空回收站 */
app.post('/api/trash/clear', async (req, res) => {
  const trash = jobs.filter((j) => j.deletedAt);
  for (const j of trash) await purgeJob(j);
  res.json({ ok: true, cleared: trash.length });
});

/** 批量操作：delete / retry / cancel */
app.post('/api/jobs/batch-action', async (req, res) => {
  const { action, ids } = req.body || {};
  if (!['delete', 'retry', 'cancel'].includes(action) || !Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: '参数错误' });
  }
  const ok = [], failed = [];
  for (const id of ids) {
    const job = getJob(id);
    if (!job) { failed.push({ id, error: '任务不存在' }); continue; }
    try {
      if (action === 'delete') {
        if (job.status === 'running') throw new Error('解析中不可删除');
        if (job.deletedAt) throw new Error('任务已在回收站');
        softDeleteJob(job);
      } else if (action === 'retry') {
        if (job.status === 'running') throw new Error('解析中不可重试');
        if (!job.inputPath || !fs.existsSync(job.inputPath)) throw new Error('原始文件不存在，请重新上传');
        await fileStore.deletePrefix(`jobs/${job.id}`);
        try { kb.remove(job.id); } catch { /* ignore */ }
        job.status = 'queued';
        job.files = []; job.mainMd = null; job.error = null; job.durationMs = null;
        job.updatedAt = Date.now();
        job.logs = [{ t: Date.now(), msg: '批量重试：重新入队' }];
        saveJob(job);
        enqueue(job);
      } else if (action === 'cancel') {
        if (job.status !== 'queued') throw new Error('只有排队中的任务可取消');
        job.status = 'cancelled';
        job.updatedAt = Date.now();
        appendLog(job, '已取消');
        saveJob(job);
      }
      ok.push(id);
    } catch (e) {
      failed.push({ id, error: e.message });
    }
  }
  res.json({ ok, failed });
});

/** 重试失败/完成的任务：清空旧产物后重新入队（同一任务 id） */
app.post('/api/jobs/:id/retry', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.status === 'running') return res.status(409).json({ error: '任务解析中' });
  if (!job.inputPath || !fs.existsSync(job.inputPath)) {
    return res.status(409).json({ error: '原始文件已不存在，无法重试（请重新上传）' });
  }
  // 清旧产物 + 知识库
  await fileStore.deletePrefix(`jobs/${job.id}`);
  try { kb.remove(job.id); } catch { /* ignore */ }
  // 复用原任务 id，重置状态重新入队
  job.status = 'queued';
  job.files = []; job.mainMd = null; job.error = null; job.durationMs = null;
  job.updatedAt = Date.now();
  job.logs = [{ t: Date.now(), msg: '手动重试：重新入队' }];
  saveJob(job);
  enqueue(job);
  res.json({ job: publicJob(job) });
});

/** 取消排队中的任务 */
app.post('/api/jobs/:id/cancel', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.status !== 'queued') return res.status(409).json({ error: '只有排队中的任务可以取消' });
  job.status = 'cancelled';
  job.updatedAt = Date.now();
  appendLog(job, '已取消');
  saveJob(job);
  res.json({ job: publicJob(job) });
});

/** 删除知识库文档（级联 chunks + 向量 + 产物文件） */
app.delete('/api/kb/:id', async (req, res) => {
  const doc = kb.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: '文档不在知识库中' });
  kb.remove(doc.id);
  await fileStore.deletePrefix(`jobs/${doc.id}`);
  // 若对应任务记录存在，一并移除
  const idx = jobs.findIndex((j) => j.id === doc.id);
  if (idx >= 0) { jobs.splice(idx, 1); persistJobs(); }
  res.json({ ok: true });
});

// 导出 PDF：服务端 md → 渲染 → headless Chrome 输出 PDF（与正文一致）
app.get('/api/jobs/:id/export-pdf', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job || !job.mainMd) return res.status(404).json({ error: '该任务没有可导出的正文' });
  try {
    const rawMd = fs.readFileSync(outputPath(job.id, job.mainMd), 'utf8');
    const md = applyCorrections(rawMd, job.corrections || []); // 导出修正版
    const baseDir = job.mainMd.split('/').slice(0, -1).join('/');
    const baseUrl = `http://127.0.0.1:${PORT}`;
    const pdf = await exportPdf(md, {
      baseUrl,
      imagePrefix: `/api/jobs/${job.id}/output/${baseDir}`,
      title: job.originalName,
    });
    const base = job.originalName.replace(/\.\w+$/, '') || 'document';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(base)}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error('[export-pdf]', e.message);
    res.status(500).json({ error: `PDF 生成失败: ${e.message.slice(0, 120)}` });
  }
});

app.get('/api/jobs/:id/output/*', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  const rel = req.params[0];
  try {
    const target = outputPath(job.id, rel);
    if (!fs.existsSync(target)) return res.status(404).json({ error: '文件不存在' });
    const mime = rel.toLowerCase().endsWith('.md') ? 'text/markdown; charset=utf-8'
      : rel.toLowerCase().endsWith('.json') ? 'application/json'
      : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    if (req.query.download === '1') {
      const name = path.basename(rel);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    }
    res.sendFile(target);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/init', (_req, res) => {
  // 后台执行初始化（快照/沙箱/预热），前端轮询 /api/admin/status 观察
  extractor.init((msg) => console.log('[init]', msg)).then(() => {
    console.log('[init] done');
  }).catch((e) => console.error('[init] error', e.message));
  res.json({ status: 'started' });
});

app.get('/api/admin/status', async (_req, res) => {
  try { res.json(await extractor.getStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/sandbox', async (_req, res) => {
  try {
    await extractor.destroySandbox((msg) => console.log('[destroy]', msg));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function publicJob(job) {
  const { inputPath, ...rest } = job;
  return rest;
}

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: `上传错误: ${err.message}` });
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`MinerU 提取工具已启动: http://127.0.0.1:${PORT}`);
});
