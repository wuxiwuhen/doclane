-- 0002_add_job_columns.sql — 补 jobs 缺失列（logs/files/deleted_at）
alter table public.jobs add column if not exists logs      jsonb not null default '[]'::jsonb;
alter table public.jobs add column if not exists files     jsonb not null default '[]'::jsonb;
alter table public.jobs add column if not exists deleted_at timestamptz;
