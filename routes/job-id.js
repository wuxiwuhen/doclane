// /api/jobs/:id — GET 详情 / DELETE 软删除（移入回收站）
import { requireUser, audit } from '../api/_lib/auth.js';
import { db } from '../api/_lib/store.js';
import { rowToJob } from '../api/_lib/jobs.js';

async function loadOwnedJob(req, user) {
  const rows = await db.select('jobs', `id=eq.${req.query.id}&select=*&limit=1`);
  const job = rows[0];
  if (!job) return { job: null, err: [404, '任务不存在'] };
  if (job.owner_id !== user.userId && user.role !== 'admin') {
    return { job: null, err: [403, '无权访问该任务'] };
  }
  return { job, err: null };
}

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });

  if (req.method === 'GET') {
    const { job, err } = await loadOwnedJob(req, user);
    if (err) return res.status(err[0]).json({ error: err[1] });
    return res.json({ job: rowToJob(job) });
  }

  if (req.method === 'DELETE') {
    const { job, err } = await loadOwnedJob(req, user);
    if (err) return res.status(err[0]).json({ error: err[1] });
    if (['preparing', 'running'].includes(job.status)) {
      return res.status(409).json({ error: '任务解析中，无法删除（可等待完成或销毁沙箱）' });
    }
    if (job.deleted_at) return res.status(409).json({ error: '任务已在回收站' });
    await db.update('jobs', 'id', job.id, {
      deleted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    // 知识库数据（documents/chunks/findings）保留：恢复即完整还原，无需重新解析；
    // 软删除期间由 search/kb 过滤（join jobs.deleted_at）使其从检索中消失
    audit(user, 'delete_job', 'job', job.id, {});
    return res.json({ ok: true, trashed: true });
  }

  res.status(405).json({ error: 'method' });
}
