// DELETE /api/admin/sandbox — 销毁沙箱（admin）
// 默认销毁当前登录用户自己的沙箱；带 ?all=1 销毁全部用户沙箱（有 running 任务时 409 保护）
import { DaytonaClient } from '../lib/daytona.js';
import { sandboxNameFor, sandboxName, destroySandbox } from '../api/_lib/ensure.js';
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
    if (req.query.all === '1') {
      // 销毁全部用户沙箱（遍历 {SANDBOX_NAME}-* 前缀）
      let list = [];
      try { list = await c.listSandboxes(); } catch { list = []; }
      const prefix = sandboxName() + '-';
      let destroyed = 0;
      for (const sb of list) {
        const nm = sb.name || '';
        if (nm.startsWith(prefix)) {
          try { await destroySandbox(nm); destroyed++; } catch { /* 单个失败继续 */ }
        }
      }
      audit(user, 'destroy_all_sandboxes', 'sandbox', sandboxName(), { destroyed });
      return res.json({ ok: true, destroyed });
    }
    // 默认：销毁当前用户自己的沙箱
    await destroySandbox(sandboxNameFor(user.userId));
    audit(user, 'destroy_sandbox', 'sandbox', sandboxNameFor(user.userId), {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
