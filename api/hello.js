// api/hello.js — Vercel 函数骨架（P1 验证用）
export default function handler(req, res) {
  res.json({ ok: true, service: 'mineru-press-api', time: new Date().toISOString() });
}
