-- 0004_admin_feedback.sql — 用户反馈 + 管理后台用户视图
-- 应用方式：Supabase Dashboard → SQL Editor 执行（或 supabase db push）
-- 说明：user_profiles 为 security_invoker 视图，仅 service role（管理接口）可查；
--       普通用户因无权访问 auth.users 且底层 RLS 限制，无法枚举他人邮箱。
--       注意：视图本身不可（也无需）enable RLS——其访问控制由底层表权限决定。

-- ========== 反馈表 ==========
create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  content text not null,
  category text not null default 'general' check (category in ('general','bug','suggestion')),
  status text not null default 'open' check (status in ('open','read','closed')),
  created_at timestamptz not null default now()
);
create index if not exists idx_feedback_created on public.feedback (created_at desc);
alter table public.feedback enable row level security;

-- 本人可提交（写主要走服务端 API，此策略为纵深防御）
create policy "feedback insert own" on public.feedback
  for insert with check (auth.uid() = user_id);
-- 本人可读自己的；admin 可读全部
create policy "feedback select own or admin" on public.feedback
  for select using (auth.uid() = user_id or public.is_admin());
-- admin 可更新状态（已读/关闭）
create policy "feedback update admin" on public.feedback
  for update using (public.is_admin());

-- ========== 用户视图（邮箱 + 角色 + 注册时间） ==========
create or replace view public.user_profiles
with (security_invoker = on) as
  select p.user_id, u.email, p.role, p.display_name, p.created_at
  from public.profiles p
  join auth.users u on u.id = p.user_id;

-- service role 读取视图需要 auth.users 的 SELECT 权限（security_invoker 视图按调用者权限）
grant select on auth.users to service_role;
