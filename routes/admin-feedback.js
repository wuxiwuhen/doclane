// GET /api/admin/feedback — 用户反馈列表（仅 admin）
import { requireAdmin } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const { code, message } = await requireAdmin(req);
  if (code) return res.status(code).json({ error: message });

  try {
    const rows = await db.select('feedback',
      'select=id,user_id,content,category,status,created_at&order=created_at.desc&limit=200');
    const users = await db.select('user_profiles', 'select=user_id,email,role&limit=1000');
    const byId = new Map(users.map((u) => [u.user_id, u]));

    res.json({
      feedback: rows.map((f) => ({
        id: f.id, content: f.content, category: f.category, status: f.status,
        createdAt: f.created_at,
        email: byId.get(f.user_id)?.email || null,
        userRole: byId.get(f.user_id)?.role || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: '反馈列表加载失败：' + (e.message || '').slice(0, 120) });
  }
}
