// GET /api/health — 云端状态（前端徽章用），与旧 server 形状一致
// 每用户沙箱：返回当前登录用户沙箱的状态；未登录则仅返回快照概览
import { getStatus } from '../api/_lib/ensure.js';
import { requireUser } from '../api/_lib/auth.js';

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 10);

export default async function handler(req, res) {
  try {
    const { user, code } = await requireUser(req);
    const status = await getStatus(code ? undefined : user.userId);
    const ok = !status.snapshot?.error;
    res.json({
      ok, daytona: ok ? 'ok' : (status.snapshot?.error || 'unknown'),
      maxUploadMb: MAX_UPLOAD_MB,
      ...status,
    });
  } catch (e) {
    res.status(500).json({ ok: false, daytona: e.message, error: e.message, maxUploadMb: MAX_UPLOAD_MB });
  }
}
