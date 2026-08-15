// POST /api/feedback — 提交用户反馈（登录用户）
import { requireUser } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  const { content, category } = req.body || {};
  if (!content || typeof content !== 'string' || content.trim().length < 2 || content.length > 2000) {
    return res.status(400).json({ error: '反馈内容需在 2-2000 字之间' });
  }
  const rows = await db.insert('feedback', [{
    user_id: user.userId,
    content: content.trim().slice(0, 2000),
    category: ['general', 'bug', 'suggestion'].includes(category) ? category : 'general',
  }], { select: '*' });
  res.json({ ok: true, feedback: rows[0] });
}
