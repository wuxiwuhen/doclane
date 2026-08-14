// POST /api/jobs/:id/correction — 人工修正（记录修正层，不改写原始 md）
import { requireUser, audit } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  const { original, correct } = req.body || {};
  if (!original || typeof original !== 'string' || !correct) {
    return res.status(400).json({ error: '缺少修正内容' });
  }
  const rows = await db.select('jobs', `id=eq.${req.query.id}&select=*&limit=1`);
  const job = rows[0];
  if (!job || !job.main_md_path) return res.status(404).json({ error: '任务不存在或无可修正正文' });
  const corrections = [...(job.corrections || []), { original, correct, at: Date.now() }];
  const logs = [...(job.logs || []), { t: Date.now(), msg: `人工修正：「${original.slice(0, 20)}」→「${correct.slice(0, 20)}」` }];
  await db.update('jobs', 'id', job.id, { corrections, logs, updated_at: new Date().toISOString() });
  audit(user, 'correction', 'job', job.id, { original: original.slice(0, 50), correct: correct.slice(0, 50) });
  res.json({ ok: true, corrections: corrections.length });
}
