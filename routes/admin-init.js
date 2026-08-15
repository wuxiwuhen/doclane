// POST /api/admin/init — 手动 ensure（等价旧「初始化」按钮；幂等，任务排队期前端轮询续拉）
// 沙箱就绪后会把所有卡在 uploaded 的任务拉起（ensure 幂等：preparing/running 跳过）
import { ensureSandbox, ensure } from '../api/_lib/ensure.js';
import { requireUser, audit } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';

export default async function handler(req, res) {
  const { user, error } = await requireUser(req);
  if (error) return res.status(401).json({ error: '未登录' });
  const r = await ensureSandbox();
  audit(user, 'init', 'sandbox', null, r);
  if (!r.ok) return res.status(500).json(r);
  if (r.building || r.warming) return res.status(202).json(r);
  // 沙箱已就绪：续拉卡在 uploaded 的任务（幂等，已在解析的跳过）
  let resumed = 0;
  try {
    const rows = await db.select('jobs', 'status=eq.uploaded&select=id');
    for (const j of rows) {
      const e = await ensure(j.id);
      if (e.ok && e.started) resumed++;
    }
  } catch { /* 查询失败不阻塞响应 */ }
  res.json({ ...r, resumed });
}
