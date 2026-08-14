// POST /api/jobs/:id/uploaded — 标记已上传并触发 ensure（快照→沙箱→drain.py）
import { requireUser, audit } from '../../_lib/auth.js';
import { db } from '../../_lib/supabase.js';
import { ensure } from '../../_lib/ensure.js';

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
  await db.update('jobs', 'id', job.id, {
    status: 'uploaded', updated_at: new Date().toISOString(),
  });
  const r = await ensure(job.id);
  audit(user, 'upload_job', 'job', job.id, { ensure: r });
  const st = r.building ? 202 : r.warming ? 202 : r.ok ? 200 : 500;
  res.status(st).json({ ok: r.ok, ensure: r });
}
