// POST /api/admin/init — 手动 ensure（仅管理员；沙箱就绪后拉起所有 uploaded 任务）
// 注意：任务自动流转不再依赖此接口——前端轮询改为调 POST /api/jobs/:id/ensure
import { ensureSandbox, ensureAllUploaded } from '../api/_lib/ensure.js';
import { requireAdmin, audit } from '../api/_lib/auth.js';

export default async function handler(req, res) {
  const { user, code, message } = await requireAdmin(req);
  if (code) return res.status(code).json({ error: message });
  const r = await ensureSandbox(user.userId);
  audit(user, 'init', 'sandbox', null, r);
  if (!r.ok) return res.status(500).json(r);
  if (r.building || r.warming) return res.status(202).json(r);
  // 沙箱已就绪：续拉卡在 uploaded 的任务（幂等，已在解析的跳过）
  let resumed = 0;
  try { resumed = await ensureAllUploaded(); } catch { /* 不阻塞 */ }
  res.json({ ...r, resumed });
}
