// server-local.js — 纯本地模式入口：Express + 复用同一套 api 路由 + 静态前端
// 数据在本地（SQLite + data/ 目录），算力走 Daytona（只需 DAYTONA_API_Key）
// 用法：node server-local.js   （.env 配 DAYTONA_API_Key；本入口强制本地模式）
// 访问：http://127.0.0.1:3088 （端口冲突用 PORT=xxxx 覆盖）
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// 强制本地数据后端（必须在加载 store 门面前设置，故 entry.js 用动态 import）
process.env.DATA_BACKEND = 'local';
const entryHandler = (await import('./api/entry.js')).default;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3088);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const app = express();
app.use(express.json({ limit: '12mb' }));

// 兜底：异步异常不崩进程（记录后继续服务）
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e && e.message ? e.message : e);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e && e.message ? e.message : e);
});

// 本地上传接收（前端 PUT 直传；路径清洗防穿越）
app.put('/api/upload/:bucket/*', express.raw({ type: '*/*', limit: '12mb' }), (req, res) => {
  const bucket = req.params.bucket;
  const rel = (req.params[0] || '').split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
  const root = path.resolve(DATA_DIR, bucket);
  const abs = path.join(root, rel);
  if (!['inputs', 'outputs'].includes(bucket) || !rel || !abs.startsWith(root)) {
    return res.status(400).json({ error: 'invalid path' });
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, req.body);
  res.status(200).json({ ok: true });
});

// 本地文件下载（签名 URL 目标）
app.get('/api/file/:bucket/*', (req, res) => {
  const bucket = req.params.bucket;
  const rel = (req.params[0] || '').split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
  const abs = path.join(path.resolve(DATA_DIR, bucket), rel);
  if (!['inputs', 'outputs'].includes(bucket) || !abs.startsWith(path.resolve(DATA_DIR, bucket)) || !fs.existsSync(abs)) {
    return res.status(404).json({ error: 'file not found' });
  }
  res.setHeader('Content-Type', /\.md$/i.test(abs) ? 'text/markdown; charset=utf-8' : 'application/octet-stream');
  fs.createReadStream(abs).pipe(res);
});

// 本地模式：动态注入 LOCAL_MODE 配置（云部署仍用静态 public/config.js）
app.get('/config.js', (req, res) => {
  const base = fs.readFileSync(path.join(__dirname, 'public', 'config.js'), 'utf8');
  const injected = base.includes('LOCAL_MODE')
    ? base
    : base.replace('window.DSH_CONFIG = {', 'window.DSH_CONFIG = { LOCAL_MODE: true,');
  res.type('application/javascript').send(injected);
});

// 同一套 API 路由（entry.js handler，Express req/res 兼容）
app.all('/api/*', (req, res) => { entryHandler(req, res); });

// 静态前端
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`DOCLANE local mode → http://127.0.0.1:${PORT}`);
  console.log(`  数据目录: ${DATA_DIR}   |  算力: Daytona 云沙箱（.env 配 DAYTONA_API_Key）`);
});
