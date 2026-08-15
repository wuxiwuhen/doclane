// POST /api/jobs/:id/cancel — 取消排队/已上传任务
import { requireUser } from '../api/_lib/auth.js';
import { db } from '../api/_lib/store.js';

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  const rows = await db.select('jobs', `id=eq.${req.query.id}&select=*&limit=1`);
  const job = rows[0];
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.owner_id !== user.userId && user.role !== 'admin') {
    return res.status(403).json({ error: '无权访问该任务' });
  }
  if (!['queued', 'uploaded'].includes(job.status)) {
    return res.status(409).json({ error: '只有排队/待解析中的任务可取消' });
  }
  const logs = [...(job.logs || []), { t: Date.now(), msg: '已取消' }];
  await db.update('jobs', 'id', job.id, { status: 'cancelled', logs, updated_at: new Date().toISOString() });
  res.json({ ok: true });
}
