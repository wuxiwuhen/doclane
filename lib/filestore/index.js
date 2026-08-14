// lib/filestore/index.js — 文件存储抽象（FileStore 接口）
//
// 设计目标：存储位置可替换。当前实现 LocalFileStore（本地磁盘根目录，能力展示/私有化），
// 将来接 Supabase Storage / S3 时新增实现，接口不变，主逻辑不动。
//
// 目录规范（key 即相对根目录的路径，天然支持 {orgId} 租户隔离）：
//   uploads/{taskId}/original.pdf      —— 上传临时区（可定时清理）
//   docs/{docId}/original.pdf          —— 归档原件
//   docs/{docId}/output/…              —— 提取产物（md / images / json）

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class FileStoreError extends Error {
  constructor(message, { status = 500, code } = {}) {
    super(message);
    this.name = 'FileStoreError';
    this.status = status;
    this.code = code;
  }
}

export class FileStore {
  /**
   * @param {object} opts
   * @param {string} opts.rootDir 本地磁盘根目录（所有文件都在其下）
   */
  constructor({ rootDir } = {}) {
    this.rootDir = path.resolve(rootDir || 'data');
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  /** key → 绝对路径，并防目录穿越（key 必须是根目录内的相对路径） */
  _resolve(key) {
    const p = path.resolve(this.rootDir, String(key));
    if (!p.startsWith(this.rootDir + path.sep) && p !== this.rootDir) {
      throw new FileStoreError('非法存储路径', { status: 400, code: 'BAD_KEY' });
    }
    return p;
  }

  /** 写入文件（覆盖） */
  async save(key, data, { contentType } = {}) {
    const p = this._resolve(key);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, data);
    return { key, size: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data), contentType };
  }

  /** 读取文件 → Buffer；不存在返回 null */
  async read(key) {
    const p = this._resolve(key);
    try {
      return await fsp.readFile(p);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  /** 读取为文本；不存在返回 null */
  async readText(key) {
    const buf = await this.read(key);
    return buf ? buf.toString('utf8') : null;
  }

  /** 删除文件；不存在静默成功 */
  async delete(key) {
    const p = this._resolve(key);
    try {
      await fsp.rm(p, { force: true });
    } catch { /* ignore */ }
  }

  /** 递归删除目录（用于级联清理某个 task/doc 的全部文件） */
  async deletePrefix(prefix) {
    const p = this._resolve(prefix);
    try {
      await fsp.rm(p, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  /** 列出前缀下的所有相对 key */
  async list(prefix = '') {
    const base = this._resolve(prefix || '.');
    const out = [];
    const walk = async (dir) => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(path.relative(this.rootDir, full));
      }
    };
    if (fs.existsSync(base)) await walk(base);
    return out;
  }

  /** 文件是否存在 */
  async exists(key) {
    return fs.existsSync(this._resolve(key));
  }

  /** 签名下载 URL（本地实现返回受控的 HTTP 端点；接口与云实现一致） */
  signedUrl(key, { expiresIn = 3600, baseUrl = '' } = {}) {
    const token = crypto.createHmac('sha256', process.env.FILE_SIGNING_SECRET || 'dev-secret')
      .update(`${key}:${Math.floor(Date.now() / 1000) + expiresIn}`)
      .digest('hex');
    const query = new URLSearchParams({ key, exp: String(Math.floor(Date.now() / 1000) + expiresIn), sig: token });
    return `${baseUrl}/api/files?${query.toString()}`;
  }

  /** 校验签名 URL 是否有效 */
  verifySignedUrl(key, exp, sig) {
    const now = Math.floor(Date.now() / 1000);
    if (Number(exp) < now) return false;
    const expect = crypto.createHmac('sha256', process.env.FILE_SIGNING_SECRET || 'dev-secret')
      .update(`${key}:${exp}`)
      .digest('hex');
    return sig === expect;
  }

  /** 当前磁盘占用（字节） */
  async usage() {
    let total = 0;
    for (const key of await this.list()) {
      try { total += (await fsp.stat(this._resolve(key))).size; } catch { /* ignore */ }
    }
    return total;
  }
}
