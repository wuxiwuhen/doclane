// GET /api/search?q= — 知识库检索（仅关键词：中文 bigram + pg_trgm / 本地 LIKE）
// 语义/混合检索暂未实现（未来版本升级）；mode 参数保留兼容，但一律按关键词处理。
import { requireUser } from '../api/_lib/auth.js';
import { db } from '../api/_lib/store.js';
import { toBigrams, highlightSnippet } from '../api/_lib/text.js';

export default async function handler(req, res) {
  const { code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });

  const q = String(req.query.q || '').trim();
  const asked = req.query.mode === 'semantic' || req.query.mode === 'hybrid' ? req.query.mode : null;
  if (!q) {
    return res.json({ query: '', total: 0, hits: [], mode: 'keyword', semanticEnabled: false });
  }

  const bigrams = toBigrams(q);
  if (!bigrams) {
    return res.json({ query: q, total: 0, hits: [], mode: 'keyword', semanticEnabled: false });
  }
  const encoded = encodeURIComponent(`*${bigrams}*`);
  const rows = await db.select('chunks',
    `content_bigrams=ilike.${encoded}&select=id,doc_id,seq,content,documents(id,filename,ext,created_at,jobs(deleted_at))&limit=100`);

  // 排除回收站任务的文档（软删除期间不可检索，恢复后自动重新可见）
  const valid = rows.filter((r) => {
    const doc = r.documents?.[0] || r.documents || {};
    const job = doc.jobs?.[0] || {};
    return !job.deleted_at;
  });

  // 按文档聚合并取最佳命中
  const byDoc = new Map();
  for (const r of valid) {
    const doc = r.documents?.[0] || r.documents || {};
    if (!byDoc.has(r.doc_id)) {
      byDoc.set(r.doc_id, {
        docId: r.doc_id, filename: doc.filename || r.doc_id, ext: doc.ext || '',
        createdAt: doc.created_at ? Date.parse(doc.created_at) : null,
        snippet: highlightSnippet(r.content, q), score: 1,
      });
    }
  }
  const hits = [...byDoc.values()];
  res.json({
    query: q, total: hits.length, hits, mode: 'keyword', semanticEnabled: false,
    // 请求了未上线的语义/混合时提示未来升级
    upgrade: asked ? '语义 / 混合检索将在未来版本提供，当前为关键词结果' : undefined,
  });
}
