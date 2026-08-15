// /api/trash — GET 回收站列表 / POST clear 清空
import { requireUser, audit } from '../api/_lib/auth.js';
import { db, storage } from '../api/_lib/store.js';
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
    // 清空回收站：删 DB 记录 + 清理 Storage 全部残留
    const rows = await db.select('jobs',
      `owner_id=eq.${user.userId}&deleted_at=not.is.null&select=id,input_storage_path`);
    let cleared = 0;
    for (const r of rows) {
      try {
        if (r.input_storage_path) {
          try { await storage.removeByPrefix('inputs', r.input_storage_path); } catch { /* 已不存在 */ }
        }
        try { await storage.removeByPrefix('outputs', r.id + '/'); } catch { /* 已不存在 */ }
        await db.remove('jobs', 'id', r.id);
        try { await db.remove('documents', 'id', r.id); } catch { /* ignore */ }
        cleared++;
      } catch { /* 单个失败继续 */ }
    }
    audit(user, 'clear_trash', 'job', null, { cleared });
    return res.json({ ok: true, cleared });
  }

  res.status(405).json({ error: 'method' });
}
