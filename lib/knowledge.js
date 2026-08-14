// lib/knowledge.js — 知识库存储（node:sqlite + FTS5 全文检索，零外部依赖）
//
// 表结构：
//   documents —— 文档记录（提取结果 markdown 全文 + 元数据）
//   chunks    —— 按段落切分的检索单元（含原文，用于命中片段展示）
//   chunks_fts—— FTS5 全文索引（内容做中文 bigram 切分，支持中文 2 字词检索）
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { cosine } from './embedding.js';

// 中文 bigram 切分：连续中文按 2 字符滑动窗口切词，非中文（拉丁/数字/符号）保留为词
export function toBigrams(text) {
  return String(text ?? '')
    .replace(/[\u4e00-\u9fff]+/g, (zh) => {
      if (zh.length === 1) return zh + ' ';
      const grams = [];
      for (let i = 0; i < zh.length - 1; i++) grams.push(zh.slice(i, i + 2));
      return grams.join(' ') + ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// 把用户查询转成 FTS5 MATCH 表达式：查询词 bigram 化后 AND 组合
export function buildMatchExpr(query) {
  const grams = toBigrams(query).split(/\s+/).filter(Boolean);
  if (!grams.length) return null;
  return grams.map((g) => `"${g.replace(/"/g, '')}"`).join(' AND ');
}

// 在原文中定位查询词，生成带 <mark> 高亮的上下文片段
export function highlightSnippet(text, query, ctx = 60) {
  const t = String(text ?? '');
  const words = String(query ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return t.slice(0, 200);
  let first = -1;
  for (const w of words) {
    const idx = t.indexOf(w);
    if (idx >= 0 && (first < 0 || idx < first)) first = idx;
  }
  if (first < 0) return t.slice(0, 200);
  const start = Math.max(0, first - ctx);
  const end = Math.min(t.length, first + ctx);
  let snippet = (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
  for (const w of words) {
    snippet = snippet.split(w).join(`<mark>${w}</mark>`);
  }
  return snippet;
}

export class KnowledgeBase {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        job_id TEXT,
        filename TEXT,
        ext TEXT,
        size INTEGER,
        status TEXT,
        main_md TEXT,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT,
        seq INTEGER,
        content TEXT,
        embedding TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        cid UNINDEXED, doc_id UNINDEXED, content
      );
    `);
    // 兼容旧库：无 embedding 列时补列
    const cols = this.db.prepare(`PRAGMA table_info(chunks)`).all().map((c) => c.name);
    if (!cols.includes('embedding')) {
      this.db.exec('ALTER TABLE chunks ADD COLUMN embedding TEXT');
    }
  }

  /** 文档入库：写 documents + 切 chunk + 建全文索引（幂等：重复入库先删旧）
   *  向量 embedding 由调用方随后通过 setEmbedding 异步补齐（不阻塞入库） */
  ingest({ id, jobId, filename, ext, size, mainMd, createdAt = Date.now() }) {
    const doc = this.db.prepare('SELECT id FROM documents WHERE id = ?').get(id);
    if (doc) this.remove(id);

    this.db.prepare(
      'INSERT INTO documents (id, job_id, filename, ext, size, status, main_md, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(id, jobId, filename, ext, size, 'done', mainMd, createdAt);

    // 按空行分段切 chunk
    const paras = String(mainMd || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    const insChunk = this.db.prepare('INSERT INTO chunks (doc_id, seq, content) VALUES (?,?,?)');
    const insFts = this.db.prepare('INSERT INTO chunks_fts (cid, doc_id, content) VALUES (?,?,?)');
    this.db.exec('BEGIN');
    try {
      paras.forEach((p, i) => {
        const r = insChunk.run(id, i, p);
        insFts.run(r.lastInsertRowid, id, toBigrams(p));
      });
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return paras.length;
  }

  remove(id) {
    const rows = this.db.prepare('SELECT id FROM chunks WHERE doc_id = ?').all(id);
    const delFts = this.db.prepare('DELETE FROM chunks_fts WHERE cid = ?');
    this.db.exec('BEGIN');
    try {
      for (const r of rows) delFts.run(r.id);
      this.db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id);
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** 全文检索：返回命中文档 + 高亮片段 */
  keywordSearch(query, { limit = 20 } = {}) {
    const match = buildMatchExpr(query);
    if (!match) return { query, total: 0, hits: [] };
    const rows = this.db.prepare(`
      SELECT f.cid, f.doc_id,
             c.seq, c.content,
             bm25(chunks_fts, 8.0, 8.0) AS score
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.cid
      WHERE chunks_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(match, limit);

    const docIds = [...new Set(rows.map((r) => r.doc_id))];
    const docs = new Map();
    for (const id of docIds) {
      const d = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
      if (d) docs.set(id, d);
    }
    const hits = rows.map((r) => {
      const d = docs.get(r.doc_id);
      return {
        docId: r.doc_id,
        filename: d?.filename || r.doc_id,
        ext: d?.ext || '',
        createdAt: d?.created_at || null,
        snippet: highlightSnippet(r.content, query),
      };
    });
    return { query, total: hits.length, hits };
  }

  listDocuments() {
    return this.db.prepare('SELECT id, filename, ext, size, created_at FROM documents ORDER BY created_at DESC').all();
  }

  // ---------- 向量 / 混合检索 ----------

  /** 需要补向量的片段（embedding 为空） */
  chunksWithoutEmbedding(limit = 500) {
    return this.db.prepare('SELECT id, content FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT ?').all(limit);
  }

  countPendingEmbeddings() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL').get().n;
  }

  /** 写入单个片段的向量 */
  setEmbedding(chunkId, vec) {
    this.db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?').run(JSON.stringify(vec), chunkId);
  }

  /** 语义检索：余弦相似度 top-N */
  semanticSearch(queryVec, { limit = 20 } = {}) {
    const rows = this.db.prepare('SELECT id, doc_id, content, embedding FROM chunks WHERE embedding IS NOT NULL').all();
    const scored = [];
    for (const r of rows) {
      const vec = JSON.parse(r.embedding);
      const sim = cosine(queryVec, vec);
      if (sim > 0) scored.push({ cid: r.id, doc_id: r.doc_id, content: r.content, score: sim });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** 混合检索：全文（FTS5）+ 语义（向量）→ RRF 融合 */
  hybridSearch(query, queryVec, { limit = 20 } = {}) {
    const k = 60; // RRF 常数
    const rankMap = new Map(); // cid -> {score, docId, content}
    const addRanks = (list) => {
      list.forEach((item, idx) => {
        const rank = idx + 1;
        const entry = rankMap.get(item.cid) || { cid: item.cid, docId: item.doc_id, content: item.content, score: 0 };
        entry.score += 1 / (k + rank);
        rankMap.set(item.cid, entry);
      });
    };
    // 全文结果（取 topN*3 供融合）
    const kwMatch = buildMatchExpr(query);
    if (kwMatch) {
      const kw = this.db.prepare(`
        SELECT f.cid, f.doc_id, c.content
        FROM chunks_fts f JOIN chunks c ON c.id = f.cid
        WHERE chunks_fts MATCH ?
        ORDER BY bm25(chunks_fts, 8.0, 8.0)
        LIMIT ?
      `).all(kwMatch, limit * 3);
      addRanks(kw);
    }
    // 语义结果
    if (queryVec) {
      addRanks(this.semanticSearch(queryVec, { limit: limit * 3 }));
    }
    const merged = [...rankMap.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    return merged;
  }

  getDocument(id) {
    return this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  }

  stats() {
    const d = this.db.prepare('SELECT COUNT(*) AS docs FROM documents').get();
    const c = this.db.prepare('SELECT COUNT(*) AS chunks FROM chunks').get();
    return { documents: d.docs, chunks: c.chunks };
  }

  close() {
    this.db.close();
  }
}
