// GET /api/kb — 已入库文档浏览 + 统计
import { requireUser } from '../api/_lib/auth.js';
import { db } from '../api/_lib/supabase.js';

export default async function handler(req, res) {
  const { code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  const docs = await db.select('documents', 'select=id,filename,ext,size,created_at&order=created_at.desc&limit=500');
  const docCount = await db.select('documents', 'select=count');
  const chunkCount = await db.select('chunks', 'select=count');
  res.json({
    stats: { documents: docCount[0]?.count || 0, chunks: chunkCount[0]?.count || 0 },
    documents: docs.map((d) => ({ id: d.id, filename: d.filename, ext: d.ext, size: d.size, createdAt: Date.parse(d.created_at) })),
  });
}
