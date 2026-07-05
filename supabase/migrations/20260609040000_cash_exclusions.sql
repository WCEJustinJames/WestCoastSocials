-- Persistent "never auto-seat" list (opt-outs, staff, dummy accounts). Applied
-- during prefill and on demand. Match by player_id (preferred) or name.
create table if not exists public.cash_exclusions (
  id          uuid primary key default gen_random_uuid(),
  player_id   text,
  player_name text,
  reason      text,
  created_at  timestamptz not null default now(),
  check (player_id is not null or player_name is not null)
);
comment on table public.cash_exclusions is 'Players to never auto-seat (skipped during prefill / seat).';
create unique index if not exists cash_exclusions_pid_uq  on public.cash_exclusions (player_id) where player_id is not null;
create unique index if not exists cash_exclusions_name_uq on public.cash_exclusions (lower(player_name)) where player_name is not null;

alter table public.cash_exclusions enable row level security;
grant all on public.cash_exclusions to service_role, anon, authenticated;
create policy cash_exclusions_anon_rw on public.cash_exclusions
  for all to anon, authenticated using (true) with check (true);

-- Helper: is a (player_id, name) excluded?
create or replace function public.cash_is_excluded(p_player_id text, p_name text)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.cash_exclusions x
    where (x.player_id is not null and x.player_id = p_player_id)
       or (x.player_name is not null and lower(x.player_name) = lower(p_name))
  )
$$;
grant execute on function public.cash_is_excluded(text,text) to service_role, anon, authenticated;
