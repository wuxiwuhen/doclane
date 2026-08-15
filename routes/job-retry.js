// POST /api/jobs/:id/retry — 重试：清旧产物重入队并触发 ensure
import { requireUser, audit } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';
import { rowToJob } from '../api/_lib/jobs.js';
import { ensure } from '../api/_lib/ensure.js';

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  const rows = await db.select('jobs', `id=eq.${req.query.id}&select=*&limit=1`);
  const job = rows[0];
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.owner_id !== user.userId && user.role !== 'admin') {
    return res.status(403).json({ error: '无权访问该任务' });
  }
  if (['preparing', 'running'].includes(job.status)) return res.status(409).json({ error: '任务解析中' });
  // drain.py 幂等入库（先清旧记录），无需预删 documents
  const logs = [{ t: Date.now(), msg: '手动重试：重新入队' }];
  const rows2 = await db.update('jobs', 'id', job.id, {
    status: 'uploaded', files: [], main_md_path: null, error: null, quality: null,
    logs, updated_at: new Date().toISOString(),
  }, { select: '*' });
  const r = await ensure(job.id);
  audit(user, 'retry_job', 'job', job.id, {});
  res.status(202).json({ job: rowToJob(rows2[0]), ensure: r });
}
