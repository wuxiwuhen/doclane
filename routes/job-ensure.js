// POST /api/jobs/:id/ensure — 任务级 ensure（沙箱就绪则启动 drain.py；幂等）
// 普通用户可调用（仅限自己的任务）：任务 uploaded/queued 时前端轮询续拉，
// 替代原先对 admin/init 的依赖（admin/init 已收紧为管理员专用）
import { requireUser } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';
import { ensure } from '../api/_lib/ensure.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  const rows = await db.select('jobs', `id=eq.${req.query.id}&select=*&limit=1`);
  const job = rows[0];
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.owner_id !== user.userId && user.role !== 'admin') {
    return res.status(403).json({ error: '无权访问该任务' });
  }
  // preparing/running 也放行：ensure() 内部幂等跳过（避免轮询重复触发时误报 409）
  if (!['queued', 'uploaded', 'preparing', 'running'].includes(job.status)) {
    return res.status(409).json({ error: '任务不在待解析状态' });
  }
  const r = await ensure(job.id);
  const st = r.building ? 202 : r.warming ? 202 : r.ok ? 200 : 500;
  res.status(st).json({ ok: r.ok, ensure: r });
}
