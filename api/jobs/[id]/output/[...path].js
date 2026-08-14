// GET /api/jobs/:id/output/* — 产物访问（302 到 Storage 签名 URL）
// 说明：<img>/<a> 等原生请求不带 Authorization 头，故此处不校验登录；
// 任务 id 为不可猜的 UUID，且签名 URL 限时 1 小时，作为演示期安全边界。
import { db } from '../../../_lib/supabase.js';
import { signedUrl } from '../../../_lib/supabase.js';

export default async function handler(req, res) {
  const rows = await db.select('jobs', `id=eq.${req.query.id}&select=owner_id&limit=1`);
  const job = rows[0];
  if (!job) return res.status(404).json({ error: '任务不存在' });
  const rel = (req.query.path || []).join('/');
  if (!rel) return res.status(400).json({ error: 'path required' });
  try {
    const url = await signedUrl('outputs', `${req.query.id}/${rel}`, 3600);
    return res.redirect(url);
  } catch (e) {
    res.status(404).json({ error: '文件不存在' });
  }
}
