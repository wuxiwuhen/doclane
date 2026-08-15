// POST /api/jobs/batch-action — 批量操作 delete/retry/cancel
import { requireUser, audit } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';
import { ensure } from '../api/_lib/ensure.js';

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  const { action, ids } = req.body || {};
  if (!['delete', 'retry', 'cancel'].includes(action) || !Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: '参数错误' });
  }
  const ok = [], failed = [];
  const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  for (const id of ids) {
    try {
      if (!UUID_RE.test(String(id))) throw new Error('非法任务 id');
      const rows = await db.select('jobs', `id=eq.${id}&select=*&limit=1`);
      const job = rows[0];
      if (!job) throw new Error('任务不存在');
      if (job.owner_id !== user.userId && user.role !== 'admin') throw new Error('无权访问该任务');
      if (action === 'delete') {
        if (['preparing', 'running'].includes(job.status)) throw new Error('解析中不可删除');
        if (job.deleted_at) throw new Error('任务已在回收站');
        // 软删除：知识库数据保留（恢复即完整还原），检索由 search/kb 过滤
        await db.update('jobs', 'id', id, { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      } else if (action === 'retry') {
        if (['preparing', 'running'].includes(job.status)) throw new Error('解析中不可重试');
        // drain.py 幂等入库（先清旧记录），无需预删 documents
        await db.update('jobs', 'id', id, {
          status: 'uploaded', files: [], main_md_path: null, error: null, quality: null,
          logs: [{ t: Date.now(), msg: '批量重试：重新入队' }], updated_at: new Date().toISOString(),
        });
        await ensure(id);
      } else if (action === 'cancel') {
        if (!['queued', 'uploaded'].includes(job.status)) throw new Error('只有排队/待解析中的任务可取消');
        await db.update('jobs', 'id', id, {
          status: 'cancelled', logs: [...(job.logs || []), { t: Date.now(), msg: '已取消' }],
          updated_at: new Date().toISOString(),
        });
      }
      ok.push(id);
    } catch (e) {
      failed.push({ id, error: e.message });
    }
  }
  if (action !== 'cancel') audit(user, `batch_${action}`, 'job', ids.join(','), {});
  res.json({ ok, failed });
}
