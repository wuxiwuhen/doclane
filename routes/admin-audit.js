// GET /api/admin/audit — 审计日志（admin）
import { requireAdmin } from '../api/_lib/auth.js';
import { db } from '../api/_lib/store.js';

export default async function handler(req, res) {
  const { code, message } = await requireAdmin(req);
  if (code) return res.status(code).json({ error: message });
  const rows = await db.select('audit_logs', 'select=id,user_id,action,target_type,target_id,meta,created_at&order=created_at.desc&limit=200');
  res.json({ logs: rows });
}
