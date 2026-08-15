// api/_lib/text.js — 文本处理（移植自 lib/knowledge.js，供检索/高亮）

/** 中文 bigram 切分：连续中文按 2 字符滑动窗口，非中文保留为词 */
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

/** 原文定位查询词，生成 <mark> 高亮片段（查询词转义，防注入 HTML） */
export function highlightSnippet(text, query, ctx = 60) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const t = String(text ?? '');
  const words = String(query ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return esc(t.slice(0, 200));
  let first = -1;
  for (const w of words) {
    const idx = t.indexOf(w);
    if (idx >= 0 && (first < 0 || idx < first)) first = idx;
  }
  if (first < 0) return esc(t.slice(0, 200));
  const start = Math.max(0, first - ctx);
  const end = Math.min(t.length, first + ctx);
  let snippet = (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
  for (const w of words) {
    snippet = snippet.split(w).join(`<mark>${esc(w)}</mark>`);
  }
  return snippet;
}
