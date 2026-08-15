// store.js — 数据后端门面：DATA_BACKEND=local 用本地 SQLite，否则走云 Supabase
// 路由层只依赖本门面（db/storage/configured/signedUrl），后端可切换，云模式行为不变
import * as cloud from './supabase.js';
import * as local from './store-local.js';

const useLocal = process.env.DATA_BACKEND === 'local';

export const db = useLocal ? local.db : cloud.db;
export const storage = useLocal ? local.storage : cloud.storage;
export const configured = () => (useLocal ? local.configured() : cloud.configured());
export const signedUrl = async (bucket, path, expiresIn = 3600) => {
  if (useLocal) return local.signedUrl(bucket, path, expiresIn);
  return cloud.signedUrl(bucket, path, expiresIn);
};
