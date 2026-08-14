// GET /api/jobs/:id/original — 原始上传文件（302 到 Storage 签名 URL）
// 同 output/*：原生请求不带 token，UUID 不可猜 + 签名限时，演示期安全边界。
import { db } from '../../_lib/supabase.js';
import { signedUrl } from '../../_lib/supabase.js';

export default async function handler(req, res) {
  const rows = await db.select('jobs', `id=eq.${req.query.id}&select=input_storage_path&limit=1`);
  const job = rows[0];
  if (!job?.input_storage_path) return res.status(404).json({ error: '原始文件不存在' });
  try {
    const url = await signedUrl('inputs', job.input_storage_path, 3600);
    return res.redirect(url);
  } catch {
    res.status(404).json({ error: '原始文件不存在' });
  }
}
