// store.js — 数据后端门面：DATA_BACKEND=local 用本地 SQLite，否则走云 Supabase
// 注意：本地模块（store-local，含 node:sqlite 初始化/写盘副作用）只能在
// local 模式按需加载——云模式（Vercel）静态导入它会导致函数 500。
const useLocal = process.env.DATA_BACKEND === 'local';

export const db = useLocal ? (await import('./store-local.js')).db : (await import('./supabase.js')).db;
export const storage = useLocal ? (await import('./store-local.js')).storage : (await import('./supabase.js')).storage;

// 同步布尔（调用处 if (!configured())）；本地模式恒可用
export const configured = () => (useLocal
  ? true
  : Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY));

export const signedUrl = async (bucket, path, expiresIn = 3600) => {
  if (useLocal) {
    const m = await import('./store-local.js');
    return m.signedUrl(bucket, path, expiresIn);
  }
  const m = await import('./supabase.js');
  return m.signedUrl(bucket, path, expiresIn);
};
