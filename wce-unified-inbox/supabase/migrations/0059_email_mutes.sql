-- 0059_email_mutes.sql
-- Sender mute list for the Home email queue: any inbox_emails row whose
-- from_email contains a muted pattern is auto-resolved on sight. Additive.
create table if not exists public.inbox_email_mutes (
  id uuid primary key default gen_random_uuid(),
  pattern text not null unique,
  created_at timestamptz not null default now()
);
alter table public.inbox_email_mutes enable row level security;
drop policy if exists inbox_email_mutes_all on public.inbox_email_mutes;
create policy inbox_email_mutes_all on public.inbox_email_mutes for all using (true) with check (true);
grant all on public.inbox_email_mutes to anon, authenticated;
