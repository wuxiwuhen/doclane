// POST /api/admin/init — 手动 ensure（等价旧「初始化」按钮；幂等，任务排队期前端轮询续拉）
import { ensureSandbox } from '../api/_lib/ensure.js';
import { requireUser, audit } from '../api/_lib/auth.js';

export default async function handler(req, res) {
  const { user, error } = await requireUser(req);
  if (error) return res.status(401).json({ error: '未登录' });
  const r = await ensureSandbox();
  audit(user, 'init', 'sandbox', null, r);
  if (r.building || r.warming) return res.status(202).json(r);
  if (!r.ok) return res.status(500).json(r);
  res.json(r);
}
