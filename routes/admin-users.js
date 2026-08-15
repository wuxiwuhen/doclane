// GET /api/admin/users — 注册用户列表 + 使用统计（仅 admin）
import { requireAdmin } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';

const ACTIVE_STATUS = ['queued', 'uploaded', 'preparing', 'running'];

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const { code, message } = await requireAdmin(req);
  if (code) return res.status(code).json({ error: message });

  try {
    const users = await db.select('user_profiles',
      'select=user_id,email,role,display_name,created_at&order=created_at.desc&limit=500');
    const jobs = await db.select('jobs', 'select=owner_id,status,created_at&limit=10000');
    const feedback = await db.select('feedback', 'select=user_id&limit=10000');

  // 任务统计（按 owner 聚合）
  const byUser = new Map();
  for (const j of jobs) {
    const s = byUser.get(j.owner_id) || { total: 0, done: 0, error: 0, active: 0, lastAt: 0 };
    s.total++;
    if (j.status === 'done') s.done++;
    else if (j.status === 'error') s.error++;
    else if (ACTIVE_STATUS.includes(j.status)) s.active++;
    const t = Date.parse(j.created_at || 0);
    if (t > s.lastAt) s.lastAt = t;
    byUser.set(j.owner_id, s);
  }
  // 反馈数（按 user 聚合）
  const fbCount = new Map();
  for (const f of feedback) fbCount.set(f.user_id, (fbCount.get(f.user_id) || 0) + 1);

  res.json({
    users: users.map((u) => {
      const s = byUser.get(u.user_id) || { total: 0, done: 0, error: 0, active: 0, lastAt: 0 };
      return {
        userId: u.user_id, email: u.email || null, role: u.role || 'user',
        displayName: u.display_name || null, createdAt: u.created_at || null,
        stats: s, feedbackCount: fbCount.get(u.user_id) || 0,
      };
    }),
    summary: {
      users: users.length,
      totalJobs: jobs.length,
      activeJobs: jobs.filter((j) => ACTIVE_STATUS.includes(j.status)).length,
      feedback: feedback.length,
    },
  });
  } catch (e) {
    res.status(500).json({ error: '管理数据加载失败：' + (e.message || '').slice(0, 120) });
  }
}
