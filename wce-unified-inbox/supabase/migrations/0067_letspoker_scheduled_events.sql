-- LetsPoker recurring-events staging queue.
--
-- letspoker-schedule (mode "queue") stakes out each missing weekly occurrence
-- here as status='pending' — a private review list that lives only in our DB,
-- so nothing is visible on the LetsPoker calendar until it is approved and
-- published. Mode "publish" then creates the approved rows on LetsPoker via
-- createTournament (the same mutation letspoker-cash uses for cash-day
-- containers) and records the returned event id.
--
-- Additive; matches the existing LetsPoker / cash tables' RLS convention
-- (authenticated_all). The edge function writes via the service role, which
-- bypasses RLS; the review UI reads as an authenticated user.

create table if not exists public.letspoker_scheduled_events (
  id                   bigint generated always as identity primary key,
  series_name          text        not null,          -- LP event name to create
  event_date           date        not null,          -- Perth calendar date
  start_time           text        not null,          -- Perth HH:MM
  scheduled_at         timestamptz not null,          -- absolute instant sent to createTournament
  weekday              smallint,                       -- 0=Sun … 6=Sat (Perth)
  buy_in               numeric,                        -- informational, from the series' last run
  status               text        not null default 'pending'
                         check (status in ('pending','approved','rejected','created','failed','skipped')),
  source               text,                           -- e.g. 'queue 2026-07-13..2026-07-31'
  tournament_event_id  text,                           -- LP event id once created
  note                 text,                           -- freeform / failure detail
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  decided_at           timestamptz,                    -- approved / rejected at
  published_at         timestamptz,                    -- created on LP at
  -- One row per (date, game): makes "queue" idempotent via ON CONFLICT and
  -- stops the same occurrence being staged twice.
  unique (event_date, series_name)
);

create index if not exists letspoker_scheduled_events_status_idx
  on public.letspoker_scheduled_events (status, event_date);

alter table public.letspoker_scheduled_events enable row level security;

drop policy if exists authenticated_all on public.letspoker_scheduled_events;
create policy authenticated_all on public.letspoker_scheduled_events
  for all to authenticated using (true) with check (true);
