// lib/embedding.js — 文本向量化适配器（OpenAI 兼容接口）
//
// 设计目标：可替换。当前用第三方 embedding API（OpenAI / 通义 / 硅基流动等，
// 只要兼容 /v1/embeddings 即可，通过环境变量切换）。
// 将来私有化部署可换成本地模型（同样返回 number[]），或迁移 Supabase pgvector
// 时把存储层换掉即可，主检索逻辑不变。
import 'dotenv/config';

export const EMBEDDING = {
  apiKey: (process.env.EMBEDDING_API_KEY || '').trim(),
  baseUrl: (process.env.EMBEDDING_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  batchSize: Number(process.env.EMBEDDING_BATCH || 32),
};

export function embeddingConfigured() {
  return !!EMBEDDING.apiKey;
}

/**
 * 批量向量化文本
 * @param {string[]} texts
 * @returns {Promise<number[][] | null>} 未配置 API 时返回 null
 */
export async function embedTexts(texts) {
  if (!embeddingConfigured()) return null;
  // 兼容两种 base_url 写法：.../v4 或 .../v4/embeddings
  const endpoint = EMBEDDING.baseUrl.endsWith('/embeddings')
    ? EMBEDDING.baseUrl
    : `${EMBEDDING.baseUrl}/embeddings`;
  const out = [];
  for (let i = 0; i < texts.length; i += EMBEDDING.batchSize) {
    const batch = texts.slice(i, i + EMBEDDING.batchSize);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${EMBEDDING.apiKey}`,
      },
      body: JSON.stringify({ model: EMBEDDING.model, input: batch }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Embedding API ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data.data?.length) throw new Error('Embedding API 返回为空');
    out.push(...data.data.map((d) => d.embedding));
  }
  return out;
}

/** 余弦相似度 */
export function cosine(a, b) {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
