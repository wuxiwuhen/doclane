// lib/daytona.js — Daytona Cloud REST API 客户端（快照 / 沙箱 / toolbox 三层）
import { createHmac } from 'node:crypto';
import 'dotenv/config';

const RAW_URL = (process.env.DAYTONA_API_URL || '').trim().replace(/\/+$/, '');
// 兼容两种写法：https://app.daytona.io 或 https://app.daytona.io/api
const API_URL = /\/api$/.test(RAW_URL) ? RAW_URL : `${RAW_URL}/api`;
const API_KEY = (process.env.DAYTONA_API_Key || '').trim();

export class DaytonaError extends Error {
  constructor(message, { status, path, body } = {}) {
    super(message);
    this.name = 'DaytonaError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export class DaytonaClient {
  constructor({ baseUrl = API_URL, apiKey = API_KEY, fetchImpl = fetch } = {}) {
    if (!apiKey) throw new DaytonaError('缺少 DAYTONA_API_Key（请检查 .env）');
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async api(path, { method = 'GET', body, raw = false, timeoutMs = 120000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await withRetry(() => this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      }), 3, 2000);
    } catch (e) {
      throw new DaytonaError(`请求失败 ${method} ${path}: ${e.message}`, { path });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new DaytonaError(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`, {
        status: res.status,
        path,
        body: text,
      });
    }
    if (raw) return res;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  // ---------- 基础 ----------
  health() {
    return this.api('/health');
  }

  // ---------- 快照（镜像 → 快照） ----------
  async listSnapshots() {
    const data = await this.api('/snapshots');
    return Array.isArray(data) ? data : data.items || [];
  }

  getSnapshot(id) {
    return this.api(`/snapshots/${id}`);
  }

  async createSnapshot(body) {
    const res = await this.api('/snapshots', { method: 'POST', body });
    return res;
  }

  deleteSnapshot(id) {
    return this.api(`/snapshots/${id}`, { method: 'DELETE', timeoutMs: 30000 });
  }

  // ---------- 沙箱 ----------
  async listSandboxes() {
    const data = await this.api('/sandbox');
    return Array.isArray(data) ? data : data.items || [];
  }

  getSandbox(idOrName) {
    return this.api(`/sandbox/${encodeURIComponent(idOrName)}`);
  }

  async createSandbox(body) {
    const res = await this.api('/sandbox', { method: 'POST', body, timeoutMs: 300000 });
    return res;
  }

  startSandbox(idOrName) {
    return this.api(`/sandbox/${encodeURIComponent(idOrName)}/start`, { method: 'POST', timeoutMs: 120000 });
  }

  stopSandbox(idOrName) {
    return this.api(`/sandbox/${encodeURIComponent(idOrName)}/stop`, { method: 'POST', timeoutMs: 120000 });
  }

  resizeSandbox(idOrName, body) {
    return this.api(`/sandbox/${encodeURIComponent(idOrName)}/resize`, { method: 'POST', body, timeoutMs: 180000 });
  }

  getSigningKey(id) {
    return this.api(`/sandbox/${encodeURIComponent(id)}/signing-key`, { timeoutMs: 30000 });
  }

  deleteSandbox(idOrName) {
    return this.api(`/sandbox/${encodeURIComponent(idOrName)}`, { method: 'DELETE', timeoutMs: 30000 });
  }

  // 轮询沙箱直到 started 且拿到 toolboxProxyUrl
  async waitForSandbox(idOrName, { timeoutMs = 10 * 60 * 1000, intervalMs = 5000, onStatus } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      const sb = await this.getSandbox(idOrName).catch((e) => {
        if (last !== 'fetch-error') { last = 'fetch-error'; onStatus?.(`获取沙箱状态失败: ${e.message}`); }
        return null;
      });
      if (sb) {
        const state = sb.state || 'unknown';
        if (state !== last) { last = state; onStatus?.(`沙箱状态: ${state}`); }
        if (state === 'started' || state === 'running') {
          if (sb.toolboxProxyUrl) return sb;
          onStatus?.('沙箱已启动，等待 toolbox 代理就绪…');
        }
        if (['error', 'build_failed', 'destroyed', 'destroying', 'stopped'].includes(state)) {
          throw new DaytonaError(`沙箱进入异常状态: ${state}${sb.errorReason ? ' — ' + sb.errorReason : ''}`);
        }
      }
      await sleep(intervalMs);
    }
    throw new DaytonaError(`等待沙箱就绪超时（${Math.round(timeoutMs / 1000)}s）`);
  }

  // ---------- toolbox（沙箱内文件 / 进程操作，经代理 URL + 签名） ----------
  // 认证方式（已对真实云环境验证）：
  //  - 基础路径 = {toolboxProxyUrl}/{sandboxId}，其余请求带 Authorization: Bearer <API Key>
  //  - 文件上传/下载走签名 URL：HMAC-SHA256(signingKey, "v1:files:{method}:{path}:{expires}")
  async toolbox(sandbox) {
    const proxyUrl = sandbox.toolboxProxyUrl || sandbox;
    const sandboxId = sandbox.id || sandbox.sandboxId;
    if (!proxyUrl || !sandboxId) throw new DaytonaError('缺少 toolboxProxyUrl 或 sandbox id');
    const base = `${String(proxyUrl).replace(/\/+$/, '')}/${sandboxId}`;
    const authHeaders = { Authorization: `Bearer ${this.apiKey}` };

    let signingKey = null;
    let signingKeyFetchedAt = 0;
    const ensureSigningKey = async () => {
      if (!signingKey || Date.now() / 1000 - signingKeyFetchedAt > 15) {
        signingKey = await this.getSigningKey(sandboxId);
        signingKeyFetchedAt = Date.now() / 1000;
      }
      return signingKey;
    };

    const signedUrl = async (operationPath, method, filePath, ttlSeconds = 3600) => {
      const key = await ensureSigningKey();
      const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
      const canonical = `v1:files:${method}:${filePath}:${expires}`;
      const signature = `v1_${createHmac('sha256', key).update(canonical).digest('base64url')}`;
      const query = new URLSearchParams({ path: filePath, expires: String(expires), signature });
      return `${base}${operationPath}?${query.toString()}`;
    };

    const uploadFile = async (absPath, buf, filename) => {
      const url = await signedUrl('/files/upload-v2', 'POST', absPath);
      const fd = new FormData();
      fd.append('file', new Blob([buf]), filename);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 300000);
      try {
        const res = await withRetry(() => this.fetch(url, { method: 'POST', body: fd, signal: ctrl.signal }), 4, 2000);
        if (!res.ok) throw new DaytonaError(`上传失败 ${res.status} ${(await res.text()).slice(0, 200)}`);
        return res.json();
      } finally {
        clearTimeout(timer);
      }
    };

    const downloadFile = async (absPath) => {
      const url = await signedUrl('/files/download', 'GET', absPath);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 300000);
      try {
        const res = await withRetry(() => this.fetch(url, { method: 'GET', signal: ctrl.signal }), 4, 2000);
        if (!res.ok) throw new DaytonaError(`下载失败 ${res.status} ${(await res.text()).slice(0, 200)}`);
        return Buffer.from(await res.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
    };

    const exec = async (command, { cwd, envs, timeout = 30 } = {}) => {
      const body = { command, timeout };
      if (cwd) body.cwd = cwd;
      if (envs) body.envs = envs;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), (timeout + 20) * 1000);
      try {
        const res = await withRetry(() =>
          this.fetch(`${base}/process/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          }), 4, 2000);
        if (!res.ok) throw new DaytonaError(`执行失败 ${res.status} ${(await res.text()).slice(0, 200)}`);
        return res.json(); // {exitCode, result}
      } finally {
        clearTimeout(timer);
      }
    };

    const apiGet = async (p) => {
      const res = await this.fetch(`${base}${p}`, { method: 'GET', headers: authHeaders });
      if (!res.ok) throw new DaytonaError(`toolbox GET ${p} 失败 ${res.status}`);
      return res.json();
    };

    const workDir = async () => (await apiGet('/work-dir')).dir;

    return { uploadFile, downloadFile, exec, workDir, baseUrl: base, sandboxId };
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 网络抖动重试（undici 瞬时连接失败 / 5xx）
async function withRetry(fn, attempts = 3, delayMs = 1500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}
