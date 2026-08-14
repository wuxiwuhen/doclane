// GET /api/jobs/:id/log — 运行日志（尾部 N 条）
import { requireUser } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  const rows = await db.select('jobs', `id=eq.${req.query.id}&select=logs&limit=1`);
  const job = rows[0];
  if (!job) return res.status(404).json({ error: '任务不存在' });
  const lines = Number(req.query.lines || 200);
  res.json({ logs: (job.logs || []).slice(-lines) });
}
