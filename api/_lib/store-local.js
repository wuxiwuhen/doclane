// store-local.js — 本地数据后端（阶段 A：纯本地模式）
// 实现与 supabase.js 相同的 db/storage 接口语义（PostgREST 查询子集），
// 数据存本地 SQLite（node:sqlite）+ data/ 目录文件。单用户本地模式。
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error('✖ 本地模式需要 Node.js ≥ 22.5（node:sqlite 模块）。当前版本过低：' + process.version);
  console.error('  请升级 Node：https://nodejs.org  (建议 LTS 22.x)');
  process.exit(1);
}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.LOCAL_DB || path.join(DATA_DIR, 'doclane.db');

// 本地单用户（auth 层注入同一身份）
export const LOCAL_USER = {
  userId: process.env.LOCAL_USER_ID || 'local-user',
  email: process.env.LOCAL_USER_EMAIL || 'local@doclane.local',
  role: process.env.LOCAL_USER_ROLE || 'admin',
  displayName: process.env.LOCAL_USER_NAME || 'Local Admin',
};

fs.mkdirSync(path.join(DATA_DIR, 'inputs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'outputs'), { recursive: true });

export const dbc = new DatabaseSync(DB_PATH);
dbc.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, owner_id TEXT, original_name TEXT, ext TEXT, size INTEGER,
    status TEXT, input_storage_path TEXT, error TEXT, files TEXT, main_md_path TEXT,
    logs TEXT, corrections TEXT, quality TEXT, deleted_at TEXT,
    created_at TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, job_id TEXT, filename TEXT, ext TEXT, size INTEGER,
    main_md TEXT, created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_docs_job ON documents(job_id);
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT, seq INTEGER, content TEXT, content_bigrams TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, content TEXT,
    category TEXT NOT NULL DEFAULT 'general', status TEXT NOT NULL DEFAULT 'open', created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, target_type TEXT, target_id TEXT,
    meta TEXT, created_at TEXT
  );
`);

// ---------- JSON 列（读出时解析，写入时序列化） ----------
const JSON_COLS = {
  jobs: { logs: 1, files: 1, corrections: 1, quality: 1 },
  audit_logs: { meta: 1 },
};
const LIST_COLS = { jobs: { logs: 1, files: 1, corrections: 1 } };

// ---------- PostgREST 查询子集解析 ----------
function parseSelect(spec) {
  // 'id,filename,jobs(deleted_at)' → [{name:'id'},{name:'filename'},{name:'jobs',nested:[{name:'deleted_at'}]}]
  const out = [];
  const stack = [out];
  let cur = '';
  for (const ch of spec) {
    if (ch === '(') { stack.push([]); if (cur) { stack[stack.length - 2].push({ name: cur.trim(), nested: stack[stack.length - 1] }); cur = ''; } }
    else if (ch === ')') { if (cur) stack[stack.length - 1].push({ name: cur.trim() }); cur = ''; stack.pop(); }
    else if (ch === ',') { if (cur) stack[stack.length - 1].push({ name: cur.trim() }); cur = ''; }
    else cur += ch;
  }
  if (cur) stack[0].push({ name: cur.trim() });
  return out.length ? out : [{ name: '*' }];
}

function parseQuery(q) {
  const out = { fields: [{ name: '*' }], filters: [], order: null, limit: null };
  for (const part of String(q || '').split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq >= 0 ? part.slice(0, eq) : part;
    const val = eq >= 0 ? decodeURIComponent(part.slice(eq + 1)) : '';
    if (key === 'select') out.fields = parseSelect(val);
    else if (key === 'order') out.order = val;
    else if (key === 'limit') out.limit = parseInt(val, 10);
    else out.filters.push({ key, val });
  }
  return out;
}

// 过滤条件 → SQL（值参数化，防注入）
function buildFilterSql(filters, table) {
  const where = [];
  const params = [];
  for (const f of filters) {
    const m = f.val.match(/^(eq|neq|gt|gte|lt|lte|like|ilike|in|is|not\.is)\.?(.*)$/s);
    if (!m) continue;
    const op = m[1], raw = m[2];
    const col = `"${f.key}"`;
    if (op === 'eq') { where.push(`${col} = ?`); params.push(raw); }
    else if (op === 'neq') { where.push(`${col} != ?`); params.push(raw); }
    else if (op === 'in') { const list = raw.replace(/^\(|\)$/g, '').split(','); where.push(`${col} IN (${list.map(() => '?').join(',')})`); params.push(...list); }
    else if (op === 'is') { where.push(`${col} IS NULL`); }
    else if (op === 'not.is') { where.push(`${col} IS NOT NULL`); }
    else if (op === 'gte') { where.push(`${col} >= ?`); params.push(raw); }
    else if (op === 'gt') { where.push(`${col} > ?`); params.push(raw); }
    else if (op === 'lte') { where.push(`${col} <= ?`); params.push(raw); }
    else if (op === 'lt') { where.push(`${col} < ?`); params.push(raw); }
    else if (op === 'like' || op === 'ilike') {
      // PostgREST 用 * 作通配符（含已 URL 解码的 %），映射为 SQL LIKE 的 %
      where.push(`${col} LIKE ? COLLATE NOCASE`); params.push(raw.replace(/\*/g, '%'));
    }
  }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

// 嵌入表（外键映射）：查询 table 时可按需 JOIN 嵌入资源
const JOINS = {
  chunks: { documents: { on: 'chunks.doc_id = documents.id', join: 'documents' } },
  documents: { jobs: { on: 'documents.job_id = jobs.id', join: 'jobs' } },
};

// 嵌入 join（chunks→documents→jobs）在 db.select 内联处理
function hasNested(fields, ...path) {
  let list = fields;
  for (const name of path) {
    const hit = (list || []).find((f) => f.name === name && f.nested);
    if (!hit) return false;
    list = hit.nested;
  }
  return true;
}

function hydrate(table, rows) {
  const jc = JSON_COLS[table] || {};
  const lc = LIST_COLS[table] || {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(jc)) {
      if (r[k] != null) {
        try { r[k] = JSON.parse(r[k]); } catch { r[k] = lc[k] ? [] : null; }
      }
    }
    if (table === 'chunks') { /* nothing */ }
  }
  return rows;
}

// 虚拟表：本地模式的 user_profiles（单用户）
function virtualUserProfiles(fields) {
  const row = {
    user_id: LOCAL_USER.userId, email: LOCAL_USER.email, role: LOCAL_USER.role,
    display_name: LOCAL_USER.displayName, created_at: new Date(0).toISOString(),
  };
  return [row];
}

// 嵌入字段选择：总是带上 id（用于匹配），忽略嵌套子资源，列名来自代码内固定字符串（安全）
function pickCols(nested) {
  const names = nested.filter((f) => !f.nested).map((f) => f.name);
  if (names.includes('*')) return '*';
  const cols = names.includes('id') ? names : ['id', ...names];
  return cols.map((n) => `"${n}"`).join(',');
}

// 嵌入填充：chunks→documents(→jobs)、documents→jobs
function hydrateWithEmbeds(table, fields, rows) {
  const out = hydrate(table, rows.map((r) => ({ ...r })));
  if (table === 'chunks') {
    const emb = fields.find((f) => f.name === 'documents' && f.nested);
    if (emb) {
      const ids = [...new Set(out.map((r) => r.doc_id).filter(Boolean))];
      const docSel = pickCols(emb.nested);
      const docCols = docSel === '*' ? '*' : docSel + ',"job_id"'; // 内部关联 jobs 需要 job_id
      const docRows = ids.length
        ? dbc.prepare(`SELECT ${docCols} FROM documents WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
        : [];
      const jobsEmb = emb.nested.find((f) => f.name === 'jobs' && f.nested);
      let jobsMap = new Map();
      if (jobsEmb) {
        const jids = [...new Set(docRows.map((d) => d.job_id).filter(Boolean))];
        const jRows = jids.length
          ? dbc.prepare(`SELECT ${pickCols(jobsEmb.nested)} FROM jobs WHERE id IN (${jids.map(() => '?').join(',')})`).all(...jids)
          : [];
        jobsMap = new Map(jRows.map((j) => [j.id, j]));
      }
      for (const r of out) {
        r.documents = docRows.filter((d) => d.id === r.doc_id)
          .map((d) => ({ ...d, ...(jobsEmb ? { jobs: [jobsMap.get(d.job_id)].filter(Boolean) } : {}) }));
      }
    }
  }
  if (table === 'documents') {
    const emb = fields.find((f) => f.name === 'jobs' && f.nested);
    if (emb) {
      const ids = [...new Set(out.map((r) => r.job_id).filter(Boolean))];
      const jRows = ids.length
        ? dbc.prepare(`SELECT ${pickCols(emb.nested)} FROM jobs WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
        : [];
      const jmap = new Map(jRows.map((j) => [j.id, j]));
      for (const r of out) r.jobs = [jmap.get(r.job_id)].filter(Boolean);
    }
  }
  return out;
}

export const db = {
  select(table, query = 'select=*') {
    const q = parseQuery(query);
    const isCount = q.fields.length === 1 && q.fields[0].name === 'count';
    if (table === 'user_profiles') {
      return Promise.resolve(virtualUserProfiles(q.fields));
    }
    if (!dbc) return Promise.resolve([]);
    const { sql: wsql, params } = buildFilterSql(q.filters, table);
    const order = q.order ? ' ORDER BY ' + q.order.split(',').map((o) => {
      const t = o.trim();
      const m = t.match(/^([^. ]+)[. ](desc|asc)(nulls(?:last|first))?$/i) || t.match(/^([^. ]+)$/);
      const col = m ? m[1] : t;
      const dir = /desc/i.test(t) ? 'DESC' : 'ASC';
      return `"${col}" ${dir}`;
    }).join(', ') : '';
    const limit = q.limit ? ' LIMIT ' + q.limit : '';
    if (isCount) {
      const row = dbc.prepare(`SELECT COUNT(*) AS count FROM "${table}"${wsql}`).get(...params);
      return Promise.resolve([{ count: row?.count || 0 }]);
    }
    const rows = dbc.prepare(`SELECT * FROM "${table}"${wsql}${order}${limit}`).all(...params);
    return Promise.resolve(hydrateWithEmbeds(table, q.fields, rows));
  },

  insert(table, rows, { select = 'id' } = {}) {
    if (!rows || !rows.length) return Promise.resolve([]);
    const ts = new Date().toISOString();
    const hasCreated = (table) => !['chunks'].includes(table); // jobs/documents/feedback/audit_logs 有 created_at
    const out = [];
    for (const row of rows) {
      const jsonSafe = { ...row };
      if (hasCreated(table) && !('created_at' in jsonSafe)) jsonSafe.created_at = ts;
      if (table === 'jobs' && !('updated_at' in jsonSafe)) jsonSafe.updated_at = ts;
      const cols = Object.keys(jsonSafe);
      const jc = JSON_COLS[table] || {};
      for (const k of cols) if (jc[k] && typeof jsonSafe[k] !== 'string') jsonSafe[k] = JSON.stringify(jsonSafe[k]);
      const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
      const info = dbc.prepare(sql).run(...cols.map((c) => jsonSafe[c]));
      const got = dbc.prepare(`SELECT * FROM "${table}" WHERE "rowid" = ?`).get(info.lastInsertRowid);
      out.push(hydrate(table, [got])[0]);
    }
    return Promise.resolve(out);
  },

  update(table, idCol, idVal, fields, { select = '*' } = {}) {
    const jc = JSON_COLS[table] || {};
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`"${k}" = ?`);
      params.push(jc[k] && typeof v !== 'string' ? JSON.stringify(v) : v);
    }
    params.push(idVal);
    dbc.prepare(`UPDATE "${table}" SET ${sets.join(',')} WHERE "${idCol}" = ?`).run(...params);
    const rows = dbc.prepare(`SELECT * FROM "${table}" WHERE "${idCol}" = ?`).all(idVal);
    return Promise.resolve(hydrate(table, rows));
  },

  remove(table, idCol, idVal) {
    dbc.prepare(`DELETE FROM "${table}" WHERE "${idCol}" = ?`).run(idVal);
    return Promise.resolve({ status: 200 });
  },

  rpc: () => Promise.reject(new Error('本地模式不支持 rpc')),
};

// ---------- 本地 storage ----------
function localPath(bucket, p) {
  const rel = String(p || '').replace(/^\/+/, '');
  const abs = path.join(DATA_DIR, bucket, rel);
  const root = path.resolve(DATA_DIR, bucket);
  if (!abs.startsWith(root)) throw new Error('invalid path');
  return abs;
}

export const storage = {
  // 返回本地接收端点（前端同源 PUT 上传）
  createSignedUploadUrl: async (bucket, p) => ({
    uploadUrl: `/api/upload/${bucket}/${String(p).replace(/^\/+/, '')}`,
    token: null,
  }),
  read: async (bucket, p) => fs.readFileSync(localPath(bucket, p)),
  signUrl: async (bucket, p) => ({ signedURL: `/api/file/${bucket}/${String(p).replace(/^\/+/, '')}` }),
  removeByPrefix: async (bucket, prefix) => {
    const root = path.resolve(DATA_DIR, bucket);
    const target = path.resolve(root, String(prefix || '').replace(/^\/+/, ''));
    if (!target.startsWith(root + path.sep) && target !== root) return { ok: false };
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  },
};

export function signedUrl(bucket, p) {
  return Promise.resolve(`/api/file/${bucket}/${String(p).replace(/^\/+/, '')}`);
}

export function configured() { return true; }
