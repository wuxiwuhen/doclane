-- 0005_drop_embedding.sql — 下线语义/向量检索，只保留关键词检索
-- 应用方式：Supabase Dashboard → SQL Editor 执行（或 supabase db push）
-- 说明：配合 0001 的同步修改（已不再创建 vector/embedding），此迁移用于已应用旧 0001 的库降级。

drop index if exists public.idx_chunks_embedding;
alter table public.chunks drop column if exists embedding;
drop extension if exists vector;
