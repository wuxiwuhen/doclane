// POST /api/sandbox/release — drain.py 结束回调：该用户无排队任务则销毁其沙箱（用完即毁）
// 鉴权：X-Release-Secret 与 RELEASE_SECRET 比对（由 startDrain 注入沙箱环境变量）
import { db } from '../api/_lib/supabase.js';
import { sandboxNameFor, destroySandbox } from '../api/_lib/ensure.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const secret = process.env.RELEASE_SECRET;
  if (secret && req.headers['x-release-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { jobId } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  try {
    const rows = await db.select('jobs', `id=eq.${jobId}&select=owner_id,status&limit=1`);
    const job = rows[0];
    if (!job) return res.status(404).json({ error: '任务不存在' });
    if (!['done', 'error', 'cancelled'].includes(job.status)) {
      return res.status(409).json({ error: '任务未结束，不释放沙箱' });
    }
    // 该用户是否还有排队/运行中的任务：有则复用沙箱，无则销毁（用完即毁）
    const pending = await db.select(
      'jobs', `owner_id=eq.${job.owner_id}&status=in.(queued,uploaded,preparing,running)&select=id&limit=1`
    );
    if (Array.isArray(pending) && pending.length) {
      return res.json({ ok: true, destroyed: false, reason: '有排队任务，沙箱复用' });
    }
    await destroySandbox(sandboxNameFor(job.owner_id));
    return res.json({ ok: true, destroyed: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
