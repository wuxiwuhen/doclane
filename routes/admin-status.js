// GET /api/admin/status — 沙箱/快照/工作目录状态（初始化轮询用）
import { getStatus } from '../api/_lib/ensure.js';

export default async function handler(_req, res) {
  try { res.json(await getStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
}
