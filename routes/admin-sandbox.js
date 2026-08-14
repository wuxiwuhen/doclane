// DELETE /api/admin/sandbox — 销毁沙箱（admin；有 running 任务时 409 保护）
import { DaytonaClient } from '../lib/daytona.js';
import { sandboxName } from '../api/_lib/ensure.js';
import { requireAdmin, audit } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'method' });
  const { user, code, message } = await requireAdmin(req);
  if (code) return res.status(code).json({ error: message });
  const running = await db.select('jobs', 'status=in.(preparing,running,uploaded)&select=id&limit=1');
  if (Array.isArray(running) && running.length) {
    return res.status(409).json({ error: '有任务正在解析，无法销毁沙箱' });
  }
  try {
    const c = new DaytonaClient();
    try { await c.deleteSandbox(sandboxName()); } catch { /* 已不存在 */ }
    audit(user, 'destroy_sandbox', 'sandbox', sandboxName(), {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
