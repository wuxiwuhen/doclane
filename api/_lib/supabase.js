// api/_lib/supabase.js — Supabase REST 直连（service role，零依赖，Vercel 函数用）
const URL = process.env.SUPABASE_URL?.replace(/\/$/, '') || '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function headers(extra = {}) {
  return {
    Authorization: `Bearer ${KEY}`,
    apikey: KEY,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function req(method, path, { body, extraHeaders, timeout = 60 } = {}) {
  const res = await fetch(`${URL}${path}`, {
    method,
    headers: headers(extraHeaders),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout * 1000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error(json?.message || json?.error || `Supabase ${res.status}`);
    err.status = res.status;
    err.json = json;
    throw err;
  }
  return { status: res.status, json };
}

// ---------- PostgREST ----------
export const db = {
  select: (table, query = 'select=*') => req('GET', `/rest/v1/${table}?${query}`).then(r => r.json),
  insert: (table, rows, { select = 'id' } = {}) =>
    req('POST', `/rest/v1/${table}?select=${select}`, {
      body: rows,
      extraHeaders: { Prefer: 'return=representation' },
    }).then(r => r.json),
  update: (table, idCol, idVal, fields, { select = '*' } = {}) =>
    req('PATCH', `/rest/v1/${table}?${idCol}=eq.${encodeURIComponent(idVal)}&select=${select}`, {
      body: fields,
      extraHeaders: { Prefer: 'return=representation' },
    }).then(r => r.json),
  remove: (table, idCol, idVal) =>
    req('DELETE', `/rest/v1/${table}?${idCol}=eq.${encodeURIComponent(idVal)}`, { extraHeaders: { Prefer: 'return=minimal' } }),
  rpc: (fn, body = {}) => req('POST', `/rest/v1/rpc/${fn}`, { body }).then(r => r.json),
};

// ---------- Storage ----------
export const storage = {
  // 预签名上传 URL（浏览器直传大文件，绕过 Vercel 体积限制）；返回完整 URL
  createSignedUploadUrl: async (bucket, path, expiresIn = 3600) => {
    const r = await req('POST', `/storage/v1/object/upload/sign/${bucket}/${path}`, { body: { expiresIn } });
    // 响应 url 为相对 storage 端点的路径，这里按标准格式拼完整 URL（token 单独返回）
    const uploadUrl = `${URL}/storage/v1/object/upload/sign/${bucket}/${path}?token=${r.json.token}`;
    return { uploadUrl, token: r.json.token, path: r.json.path };
  },

  // 服务端直读（drain.py 也可用；此处供函数读文件/生成签名下载）
  signUrl: (bucket, path, expiresIn = 3600) =>
    req('POST', `/storage/v1/object/sign/${bucket}/${path}`, { body: { expiresIn } }).then(r => r.json), // { signedURL }

  async read(bucket, path) {
    const res = await fetch(`${URL}/storage/v1/object/${bucket}/${path}`, {
      headers: { Authorization: `Bearer ${KEY}`, apikey: KEY },
    });
    if (!res.ok) throw new Error(`storage read ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },

  // 按前缀批量删除（清空目录/文件残留；prefix 为桶内路径，如 "jobId/" 或 "userId/jobId.ext"）
  removeByPrefix: async (bucket, prefix) => {
    const r = await req('POST', `/storage/v1/object/${bucket}/remove`, { body: { prefixes: [prefix] } });
    return r;
  },
};

// 生成签名 URL 完整地址（供 302 重定向 / 下载）
// Storage sign 接口返回的是相对路径（如 /object/sign/{bucket}/{path}?token=...），
// 需补上 /storage/v1 前缀才是有效端点
export async function signedUrl(bucket, path, expiresIn = 3600) {
  const s = await storage.signUrl(bucket, path, expiresIn);
  const u = s.signedURL || s.signedUrl || s.url || '';
  if (u.startsWith('http')) return u;
  const rel = u.startsWith('/') ? u : '/' + u;
  return `${URL}/storage/v1${rel}`;
}

export function configured() {
  return Boolean(URL && KEY);
}
