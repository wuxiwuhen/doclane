// POST /api/jobs/batch-action — 批量操作 delete/retry/cancel
import { requireUser, audit } from '../_lib/auth.js';
import { db } from '../_lib/supabase.js';
import { ensure } from '../_lib/ensure.js';

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  const { action, ids } = req.body || {};
  if (!['delete', 'retry', 'cancel'].includes(action) || !Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: '参数错误' });
  }
  const ok = [], failed = [];
  for (const id of ids) {
    try {
      const rows = await db.select('jobs', `id=eq.${id}&select=*&limit=1`);
      const job = rows[0];
      if (!job) throw new Error('任务不存在');
      if (action === 'delete') {
        if (['preparing', 'running'].includes(job.status)) throw new Error('解析中不可删除');
        if (job.deleted_at) throw new Error('任务已在回收站');
        await db.update('jobs', 'id', id, { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        try { await db.remove('documents', 'id', id); } catch { /* ignore */ }
      } else if (action === 'retry') {
        if (['preparing', 'running'].includes(job.status)) throw new Error('解析中不可重试');
        try { await db.remove('documents', 'id', id); } catch { /* ignore */ }
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
