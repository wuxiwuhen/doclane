-- 0003_jobs_status_uploaded.sql — status 约束补充 uploaded
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check
  check (status in ('queued', 'uploaded', 'preparing', 'running', 'done', 'error', 'cancelled'));
