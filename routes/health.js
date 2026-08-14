// GET /api/health — 云端状态（前端徽章用），与旧 server 形状一致
import { getStatus } from '../api/_lib/ensure.js';

export default async function handler(_req, res) {
  try {
    const status = await getStatus();
    const ok = !status.snapshot?.error;
    res.json({ ok, daytona: ok ? 'ok' : (status.snapshot?.error || 'unknown'), ...status });
  } catch (e) {
    res.status(500).json({ ok: false, daytona: e.message, error: e.message });
  }
}
