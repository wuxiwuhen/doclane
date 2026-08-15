// GET /api/jobs/:id/export-pdf — 导出正文为 PDF（保真渲染：marked + KaTeX + Chromium）
// 本地模式用系统 Chrome；Vercel 用无服务器 Chromium（@sparticuz/chromium）
import { requireUser } from '../api/_lib/auth.js';
import { db } from '../api/_lib/store.js';
import { exportPdf } from '../lib/export-pdf.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  try {
    const rows = await db.select('documents', `id=eq.${req.query.id}&select=main_md,filename&limit=1`);
    const doc = rows[0];
    if (!doc?.main_md) return res.status(404).json({ error: '文档不在知识库中' });
    // 属主校验（文档 id = 任务 id）
    const jrows = await db.select('jobs', `id=eq.${req.query.id}&select=owner_id,deleted_at&limit=1`);
    const job = jrows[0];
    if (!job || job.deleted_at) return res.status(404).json({ error: '任务不存在' });
    if (job.owner_id !== user.userId && user.role !== 'admin') {
      return res.status(403).json({ error: '无权访问该任务' });
    }
    const pdf = await exportPdf(doc.main_md, { title: doc.filename || 'doclane' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="doclane-${req.query.id.slice(0, 8)}.pdf"`);
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: 'PDF 导出失败：' + (e.message || '').slice(0, 200) });
  }
}
