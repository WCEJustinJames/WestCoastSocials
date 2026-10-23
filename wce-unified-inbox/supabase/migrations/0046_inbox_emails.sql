-- 0046_inbox_emails.sql
-- Roadmap #4 (email leg): unread Gmail inbox messages mirrored for the Home action
-- queue. Populated by the PC sync (gmail.readonly); 'done' in the UI sets resolved
-- (never touches Gmail itself). Additive.
create table if not exists public.inbox_emails (
  id uuid primary key default gen_random_uuid(),
  gmail_id text not null unique,
  thread_id text,
  from_name text,
  from_email text,
  subject text,
  snippet text,
  received_at timestamptz,
  resolved boolean not null default false,
  synced_at timestamptz not null default now()
);
alter table public.inbox_emails enable row level security;
drop policy if exists inbox_emails_all on public.inbox_emails;
create policy inbox_emails_all on public.inbox_emails for all using (true) with check (true);
grant all on public.inbox_emails to anon, authenticated;
create index if not exists inbox_emails_unresolved_idx on public.inbox_emails (resolved, received_at desc);
