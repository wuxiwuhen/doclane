// DELETE /api/trash/:id — 彻底删除（回收站内）
import { requireUser, audit } from '../../_lib/auth.js';
import { db } from '../../_lib/supabase.js';

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'method' });
  const rows = await db.select('jobs', `id=eq.${req.query.id}&select=owner_id,deleted_at&limit=1`);
  const job = rows[0];
  if (!job || !job.deleted_at) return res.status(404).json({ error: '任务不在回收站' });
  await db.remove('jobs', 'id', job.id);
  try { await db.remove('documents', 'id', job.id); } catch { /* ignore */ }
  audit(user, 'purge_job', 'job', job.id, {});
  res.json({ ok: true });
}
