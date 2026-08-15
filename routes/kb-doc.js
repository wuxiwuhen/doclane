// /api/kb/:id — GET 文档 / DELETE 删除（级联 chunks + 任务软删）
import { requireUser, audit } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  const rows = await db.select('documents', `id=eq.${req.query.id}&select=*&limit=1`);
  const doc = rows[0];
  if (!doc) return res.status(404).json({ error: '文档不在知识库中' });

  if (req.method === 'GET') {
    return res.json({ document: doc });
  }
  if (req.method === 'DELETE') {
    // 删除文档 = 删除他人知识库内容，仅 owner/admin 可操作
    const jrows = await db.select('jobs', `id=eq.${doc.id}&select=owner_id&limit=1`);
    const j = jrows[0];
    if (!j || (j.owner_id !== user.userId && user.role !== 'admin')) {
      return res.status(403).json({ error: '无权删除该文档' });
    }
    await db.remove('documents', 'id', doc.id);
    try {
      await db.update('jobs', 'id', doc.id, { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    } catch { /* ignore */ }
    audit(user, 'delete_doc', 'document', doc.id, {});
    return res.json({ ok: true });
  }
  res.status(405).json({ error: 'method' });
}
