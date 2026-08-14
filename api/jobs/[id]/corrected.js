// GET /api/jobs/:id/corrected — 原始 + 修正覆盖层合成正文（前端渲染用）
import { requireUser } from '../../_lib/auth.js';
import { db, storage } from '../../_lib/supabase.js';

function applyCorrections(md, corrections) {
  let out = md;
  for (const c of corrections || []) {
    if (c?.original) out = out.split(c.original).join(c.correct || '');
  }
  return out;
}

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  const rows = await db.select('jobs', `id=eq.${req.query.id}&select=main_md_path,corrections,owner_id&limit=1`);
  const job = rows[0];
  if (!job?.main_md_path) return res.status(404).json({ error: '任务不存在或无可修正正文' });
  const buf = await storage.read('outputs', `${req.query.id}/${job.main_md_path}`);
  const md = applyCorrections(buf.toString('utf8'), job.corrections);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(md);
}
