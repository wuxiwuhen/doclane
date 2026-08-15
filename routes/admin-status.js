// GET /api/admin/status — 当前用户沙箱/快照/工作目录状态（初始化轮询用）
import { getStatus } from '../api/_lib/ensure.js';
import { requireUser } from '../api/_lib/auth.js';

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  try { res.json(await getStatus(user.userId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
}
