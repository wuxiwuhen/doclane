// /api/jobs — POST 建任务（返回预签名上传 URL，浏览器直传 Storage）+ GET 任务列表
import { randomUUID } from 'node:crypto';
import { requireUser, audit } from '../api/_lib/auth.js';
import { db, storage, configured } from '../api/_lib/supabase.js';
import { rowToJob, isSupported, extOf } from '../api/_lib/jobs.js';

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 10); // 单文件大小上限（防单用户耗尽额度）

export default async function handler(req, res) {
  const { user, code, message } = await requireUser(req);
  if (code) return res.status(code).json({ error: message });
  if (!configured()) return res.status(500).json({ error: 'Supabase 未配置' });

  if (req.method === 'POST') {
    const { name, size } = req.body || {};
    if (!name || !isSupported(name)) {
      return res.status(400).json({ error: `暂不支持该格式（支持: pdf docx xlsx pptx png jpg 等）` });
    }
    if (Number(size || 0) > MAX_UPLOAD_MB * 1024 * 1024) {
      return res.status(400).json({ error: `文件超过 ${MAX_UPLOAD_MB}MB 上限` });
    }
    const id = randomUUID();
    const ext = extOf(name);
    // 注意：bucket 由 createSignedUploadUrl 的 bucket 参数提供，这里只存桶内相对路径
    const inputPath = `${user.userId}/${id}${ext}`;
    const rows = await db.insert('jobs', [{
      id, owner_id: user.userId, original_name: name, ext, size: Number(size || 0),
      status: 'queued', input_storage_path: inputPath, logs: [], corrections: [],
    }], { select: '*' });
    const job = rowToJob(rows[0]);
    // 预签名上传 URL（1 小时有效）
    const { uploadUrl } = await storage.createSignedUploadUrl('inputs', inputPath, 3600);
    audit(user, 'create_job', 'job', id, { name, size });
    return res.status(202).json({ job, uploadUrl, uploadToken: null });
  }

  if (req.method === 'GET') {
    const rows = await db.select('jobs',
      `owner_id=eq.${user.userId}&deleted_at=is.null&select=*&order=created_at.desc&limit=200`);
    return res.json({ jobs: rows.map(rowToJob) });
  }

  res.status(405).json({ error: 'method' });
}
