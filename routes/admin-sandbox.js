// DELETE /api/admin/sandbox — 销毁沙箱（admin；有 running 任务时 409 保护）
import { DaytonaClient } from '../lib/daytona.js';
import { sandboxName } from '../api/_lib/ensure.js';
import { requireAdmin, audit } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'method' });
  const { user, code, message } = await requireAdmin(req);
  if (code) return res.status(code).json({ error: message });
  try {
    const running = await db.select('jobs', 'status=in.(preparing,running,uploaded)&select=id&limit=1');
    if (Array.isArray(running) && running.length) {
      return res.status(409).json({ error: '有任务正在解析，无法销毁沙箱' });
    }
  } catch (e) {
    return res.status(500).json({ error: '查询任务状态失败: ' + e.message });
  }
  try {
    const c = new DaytonaClient();
    // 先停机再删除：部分云环境不允许直接删除 running 沙箱（停机失败不影响后续删除）
    try { await c.stopSandbox(sandboxName()); } catch { /* 未运行/已停止 */ }
    try {
      await c.deleteSandbox(sandboxName());
    } catch (e) {
      // 仅当沙箱确实已不存在时视为成功；其他错误（权限/网络）如实抛出
      let exists = true;
      try { await c.getSandbox(sandboxName()); } catch { exists = false; }
      if (exists) throw e;
    }
    audit(user, 'destroy_sandbox', 'sandbox', sandboxName(), {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
