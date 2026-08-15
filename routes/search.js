// GET /api/search?q=&mode= — 知识库检索（关键词 pg_trgm；语义/混合降级）
import { requireUser } from '../api/_lib/auth.js';
import { db } from '../api/_lib/store.js';
import { toBigrams, highlightSnippet } from '../api/_lib/text.js';

const EMBED_CONFIGURED = Boolean(process.env.EMBEDDING_API_KEY);

export default async function handler(req, res) {
  const { code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });

  const q = String(req.query.q || '').trim();
  const mode = ['keyword', 'semantic', 'hybrid'].includes(req.query.mode) ? req.query.mode : 'hybrid';
  if (!q) {
    return res.json({ query: '', total: 0, hits: [], mode, semanticEnabled: EMBED_CONFIGURED });
  }

  // v1：语义/混合在未配置 embedding 时降级为关键词；配置了也暂按关键词（向量查询后续版本接入 rpc）
  const bigrams = toBigrams(q);
  if (!bigrams) {
    return res.json({ query: q, total: 0, hits: [], mode, semanticEnabled: EMBED_CONFIGURED });
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
    query: q, total: hits.length, hits, mode,
    semanticEnabled: EMBED_CONFIGURED,
    degraded: mode !== 'keyword' && !EMBED_CONFIGURED,
    error: mode === 'semantic' && !EMBED_CONFIGURED ? '未配置 Embedding API（.env 设置 EMBEDDING_API_KEY）' : undefined,
  });
}
