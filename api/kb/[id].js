// /api/kb/:id — GET 文档 / DELETE 删除（级联 chunks + 任务软删）
import { requireUser, audit } from '../../_lib/auth.js';
import { db } from '../../_lib/supabase.js';

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
    await db.remove('documents', 'id', doc.id);
    try {
      await db.update('jobs', 'id', doc.id, { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    } catch { /* ignore */ }
    audit(user, 'delete_doc', 'document', doc.id, {});
    return res.json({ ok: true });
  }
  res.status(405).json({ error: 'method' });
}
