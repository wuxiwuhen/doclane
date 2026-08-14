// api/[...route].js — 单一 Vercel 函数入口，内部路由分发
// 原因：Vercel Hobby 限制单次部署 ≤12 个函数；此处把全部 API 合并为 1 个函数
// 路由逻辑在 routes/*.js（普通模块，不参与函数发现）
import hello from '../routes/hello.js';
import health from '../routes/health.js';
import adminStatus from '../routes/admin-status.js';
import adminInit from '../routes/admin-init.js';
import adminSandbox from '../routes/admin-sandbox.js';
import adminAudit from '../routes/admin-audit.js';
import jobs from '../routes/jobs.js';
import jobsBatch from '../routes/jobs-batch.js';
import jobId from '../routes/job-id.js';
import jobUploaded from '../routes/job-uploaded.js';
import jobCancel from '../routes/job-cancel.js';
import jobRetry from '../routes/job-retry.js';
import jobRestore from '../routes/job-restore.js';
import jobCorrection from '../routes/job-correction.js';
import jobCorrected from '../routes/job-corrected.js';
import jobLog from '../routes/job-log.js';
import jobOriginal from '../routes/job-original.js';
import jobOutput from '../routes/job-output.js';
import kb from '../routes/kb.js';
import kbDoc from '../routes/kb-doc.js';
import search from '../routes/search.js';
import trash from '../routes/trash.js';
import trashDoc from '../routes/trash-doc.js';

// 顺序即优先级：具体路径（batch-action / trash/clear）必须排在 :id 通配之前
const ROUTES = [
  ['hello', hello],
  ['health', health],
  ['admin/status', adminStatus],
  ['admin/init', adminInit],
  ['admin/sandbox', adminSandbox],
  ['admin/audit', adminAudit],
  ['jobs', jobs],
  ['jobs/batch-action', jobsBatch],
  ['jobs/:id/uploaded', jobUploaded],
  ['jobs/:id/cancel', jobCancel],
  ['jobs/:id/retry', jobRetry],
  ['jobs/:id/restore', jobRestore],
  ['jobs/:id/correction', jobCorrection],
  ['jobs/:id/corrected', jobCorrected],
  ['jobs/:id/log', jobLog],
  ['jobs/:id/original', jobOriginal],
  ['jobs/:id/output/*', jobOutput],
  ['jobs/:id', jobId],
  ['kb', kb],
  ['kb/:id', kbDoc],
  ['search', search],
  ['trash', trash],
  ['trash/clear', trash],
  ['trash/:id', trashDoc],
];

export default async function handler(req, res) {
  const url = (req.url || '').split('?')[0];
  let segs = url.replace(/^\/+/, '').split('/').filter(Boolean);
  if (segs[0] === 'api') segs.shift();

  for (const [pattern, fn] of ROUTES) {
    const p = pattern.split('/');
    const params = {};
    let ok = true;
    for (let i = 0; i < p.length; i++) {
      if (p[i] === '*') {
        if (segs.length < p.length) { ok = false; break; }
        params.path = segs.slice(i);
        break;
      }
      if (i >= segs.length) { ok = false; break; }
      if (p[i].startsWith(':')) {
        params[p[i].slice(1)] = segs[i];
      } else if (p[i] !== segs[i]) {
        ok = false; break;
      }
    }
    if (!ok) continue;
    if (params.path === undefined && p.length !== segs.length) continue;
    req.query = { ...(req.query || {}), ...params };
    return fn(req, res);
  }
  res.status(404).json({ error: 'not found' });
}
