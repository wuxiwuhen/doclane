-- 0001_init.sql — MINERU·PRESS 数据模型
-- 表 + 扩展 + 存储桶 + 触发器 + RLS
-- 应用方式：supabase db push（需先 supabase link 到项目）

-- ========== 扩展 ==========
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;


-- ========== 表 ==========
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  role         text not null default 'user' check (role in ('user', 'admin')),
  display_name text,
  created_at   timestamptz not null default now()
);

create table if not exists public.jobs (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users(id) on delete cascade,
  original_name      text not null,
  ext                text not null,
  size               bigint not null default 0,
  status             text not null default 'queued'
                     check (status in ('queued', 'preparing', 'running', 'done', 'error', 'cancelled')),
  input_storage_path text,
  output_dir         text,
  main_md_path       text,
  quality            jsonb,
  corrections        jsonb not null default '[]'::jsonb,
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_jobs_owner_status on public.jobs (owner_id, status, created_at desc);

create table if not exists public.documents (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.jobs(id) on delete cascade,
  filename   text not null,
  ext        text not null,
  size       bigint,
  main_md    text,
  created_at timestamptz not null default now()
);
create index if not exists idx_documents_job on public.documents (job_id);

create table if not exists public.chunks (
  id              bigint generated always as identity primary key,
  doc_id          uuid not null references public.documents(id) on delete cascade,
  seq             int not null,
  content         text not null,
  content_bigrams text,                 -- 关键词检索（中文 bigram 预处理，pg_trgm）
  embedding       vector(1536)          -- 语义检索（可选，未配 key 时为空）
);
create index if not exists idx_chunks_doc on public.chunks (doc_id, seq);
create index if not exists idx_chunks_bigrams on public.chunks using gin (content_bigrams gin_trgm_ops);
create index if not exists idx_chunks_embedding on public.chunks using hnsw (embedding vector_cosine_ops);

create table if not exists public.audit_logs (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete set null,
  action      text not null,
  target_type text,
  target_id   text,
  meta        jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_audit_created on public.audit_logs (created_at desc);

create table if not exists public.findings (
  id               bigint generated always as identity primary key,
  doc_id           uuid not null references public.documents(id) on delete cascade,
  job_id           uuid not null references public.jobs(id) on delete cascade,
  rule             text not null,
  snippet          text not null,
  char_offset      int not null,
  status           text not null default 'open' check (status in ('open', 'redacted', 'ignored')),
  redacted_snippet text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_findings_job on public.findings (job_id, rule, status);

create table if not exists public.settings (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz not null default now()
);

-- ========== 角色辅助函数（表之后定义）==========
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role = 'admin'
  );
$$;

-- ========== 触发器：注册用户自动建 profiles ==========
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, role)
  values (new.id, 'user')
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ========== 管理员提升 ==========
-- 部署引导：select public.promote_admin('you@example.com');
create or replace function public.promote_admin(target_email text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set role = 'admin'
  where user_id = (select id from auth.users where email = target_email);
  if not found then
    raise exception 'user % not found', target_email;
  end if;
end $$;

-- ========== 存储桶（私有，走预签名 URL）==========
insert into storage.buckets (id, name, public)
values ('inputs', 'inputs', false), ('outputs', 'outputs', false)
on conflict (id) do nothing;

-- ========== RLS ==========
alter table public.profiles enable row level security;
alter table public.jobs enable row level security;
alter table public.documents enable row level security;
alter table public.chunks enable row level security;
alter table public.audit_logs enable row level security;
alter table public.findings enable row level security;
alter table public.settings enable row level security;

-- profiles：本人可读可改；admin 全读
create policy "profiles select own or admin" on public.profiles
  for select using (auth.uid() = user_id or public.is_admin());
create policy "profiles update own" on public.profiles
  for update using (auth.uid() = user_id);

-- jobs：owner 全权；admin 全权（服务端函数走 service role 不受限，RLS 作纵深防御）
create policy "jobs owner all" on public.jobs
  for all using (auth.uid() = owner_id or public.is_admin());

-- documents / chunks：知识库为「单组织演示」设计，全体登录用户可读；写入由 service role 完成
create policy "documents select authed" on public.documents
  for select using (auth.role() = 'authenticated');
create policy "chunks select authed" on public.chunks
  for select using (auth.role() = 'authenticated');

-- findings：全体登录用户可读（报告页）；状态变更走服务端 API + 审计
create policy "findings select authed" on public.findings
  for select using (auth.role() = 'authenticated');

-- audit_logs：仅 admin 可读
create policy "audit select admin" on public.audit_logs
  for select using (public.is_admin());

-- settings：仅 admin 可读可写
create policy "settings admin all" on public.settings
  for all using (public.is_admin());
