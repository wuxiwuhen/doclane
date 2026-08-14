// api/_lib/jobs.js — job 行 → 前端 publicJob 形状映射 + 查询辅助
const KB_DELETED = { deleted_at: 'ne.{}' }; // 未软删（deleted_at 为 null）

export function rowToJob(row) {
  const { owner_id, input_storage_path, ...rest } = row;
  return {
    id: row.id,
    originalName: row.original_name,
    ext: row.ext,
    size: row.size,
    status: row.status,
    createdAt: row.created_at ? Date.parse(row.created_at) : null,
    updatedAt: row.updated_at ? Date.parse(row.updated_at) : null,
    files: row.files || [],
    mainMd: row.main_md_path,
    error: row.error,
    logs: row.logs || [],
    quality: row.quality,
    corrections: row.corrections || [],
    deletedAt: row.deleted_at ? Date.parse(row.deleted_at) : null,
    ...rest,
  };
}

// 支持的扩展名（与旧 server.js SUPPORTED_EXT 一致）
export const SUPPORTED_EXT = new Set([
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
  '.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.webp',
]);

export function isSupported(name) {
  const ext = (name.match(/\.\w+$/) || [''])[0].toLowerCase();
  return SUPPORTED_EXT.has(ext);
}

export function extOf(name) {
  return (name.match(/\.\w+$/) || [''])[0].toLowerCase();
}
