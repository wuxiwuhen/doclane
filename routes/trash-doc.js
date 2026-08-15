// DELETE /api/trash/:id — 彻底删除（回收站内）：删 DB 记录 + 清理 Storage 全部残留
import { requireUser, audit } from '../api/_lib/auth.js';
import { db, storage } from '../api/_lib/store.js';

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'method' });
  // 先取 job 元信息（input_storage_path 用于定位 Storage 原文件，删除后查不到）
  const rows = await db.select('jobs', `id=eq.${req.query.id}&select=owner_id,input_storage_path,deleted_at&limit=1`);
  const job = rows[0];
  if (!job || !job.deleted_at) return res.status(404).json({ error: '任务不在回收站' });
  // 清理 Storage 残留：inputs 原文件 + outputs 产物目录
  if (job.input_storage_path) {
    try { await storage.removeByPrefix('inputs', job.input_storage_path); } catch { /* 已不存在 */ }
  }
  try { await storage.removeByPrefix('outputs', req.query.id + '/'); } catch { /* 已不存在 */ }
  // 删 DB 记录（jobs 外键级联 documents → chunks → findings）
  await db.remove('jobs', 'id', job.id);
  try { await db.remove('documents', 'id', job.id); } catch { /* ignore */ }
  audit(user, 'purge_job', 'job', job.id, {});
  res.json({ ok: true });
}
