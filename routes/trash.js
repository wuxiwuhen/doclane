// /api/trash — GET 回收站列表 / POST clear 清空
import { requireUser, audit } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';
import { rowToJob } from '../api/_lib/jobs.js';

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });

  if (req.method === 'GET') {
    const rows = await db.select('jobs',
      `owner_id=eq.${user.userId}&deleted_at=not.is.null&select=*&order=created_at.desc&limit=200`);
    return res.json({ jobs: rows.map(rowToJob) });
  }

  if (req.method === 'POST') {
    // 清空回收站
    const rows = await db.select('jobs', `owner_id=eq.${user.userId}&deleted_at=not.is.null&select=id`);
    let cleared = 0;
    for (const r of rows) {
      try { await db.remove('jobs', 'id', r.id); await db.remove('documents', 'id', r.id); cleared++; } catch { /* ignore */ }
    }
    audit(user, 'clear_trash', 'job', null, { cleared });
    return res.json({ ok: true, cleared });
  }

  res.status(405).json({ error: 'method' });
}
