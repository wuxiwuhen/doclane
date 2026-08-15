// api/_lib/auth.js — JWT 校验（Supabase Auth REST，零依赖）；本地模式固定单用户
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '') || '';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const LOCAL_MODE = process.env.DATA_BACKEND === 'local';

/**
 * 校验 Bearer JWT，返回 { userId, email, role } 或 null。
 * 用 auth/v1/user 端点校验 token（服务端标准做法，无需 JWT secret）。
 */
export async function verifyUser(authHeader) {
  // 本地模式：单用户固定身份（admin），跳过 Auth
  if (LOCAL_MODE) {
    const { LOCAL_USER } = await import('./store-local.js');
    return { userId: LOCAL_USER.userId, email: LOCAL_USER.email, role: LOCAL_USER.role };
  }
  const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !SUPABASE_URL || !ANON_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user?.id) return null;
    let role = 'user';
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${user.id}&select=role`,
        { headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY } }
      );
      const rows = await r.json();
      if (Array.isArray(rows) && rows[0]?.role) role = rows[0].role;
    } catch { /* 默认 user */ }
    return { userId: user.id, email: user.email, role };
  } catch {
    return null;
  }
}

/** 必须登录；失败返回 { user:null, code, message } */
export async function requireUser(req) {
  const user = await verifyUser(req.headers.authorization);
  if (!user) return { user: null, code: 401, message: '未登录或会话已过期' };
  return { user, code: 0, message: '' };
}

/** 必须 admin */
export async function requireAdmin(req) {
  const { user, code, message } = await requireUser(req);
  if (code) return { user: null, code, message };
  if (user.role !== 'admin') return { user: null, code: 403, message: '需要管理员权限' };
  return { user, code: 0, message: '' };
}

/** 写审计日志（失败不阻断业务） */
export async function audit(user, action, targetType, targetId, meta = {}) {
  try {
    const { db } = await import('./store.js');
    await db.insert('audit_logs', [{
      user_id: user?.userId || null,
      action, target_type: targetType, target_id: targetId,
      meta, created_at: new Date().toISOString(),
    }]);
  } catch { /* ignore */ }
}
