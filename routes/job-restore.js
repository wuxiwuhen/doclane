// POST /api/jobs/:id/restore — 从回收站恢复
import { requireUser } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  const rows = await db.select('jobs', `id=eq.${req.query.id}&select=*&limit=1`);
  const job = rows[0];
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.owner_id !== user.userId && user.role !== 'admin') {
    return res.status(403).json({ error: '无权访问该任务' });
  }
  if (!job.deleted_at) return res.status(409).json({ error: '任务不在回收站' });
  await db.update('jobs', 'id', job.id, { deleted_at: null, updated_at: new Date().toISOString() });
  res.json({ ok: true });
}
