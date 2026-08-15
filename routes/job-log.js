// GET /api/jobs/:id/log — 运行日志（尾部 N 条）
import { requireUser } from '../api/_lib/auth.js';
import { db } from '../api/_lib/store.js';

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  const rows = await db.select('jobs', `id=eq.${req.query.id}&select=logs,owner_id&limit=1`);
  const job = rows[0];
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.owner_id !== user.userId && user.role !== 'admin') {
    return res.status(403).json({ error: '无权访问该任务' });
  }
  const lines = Number(req.query.lines || 200);
  res.json({ logs: (job.logs || []).slice(-lines) });
}
