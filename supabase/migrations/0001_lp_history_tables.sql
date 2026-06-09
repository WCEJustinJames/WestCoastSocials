-- LetsPoker tournament history — normalized landing tables.
-- Populated by the letspoker-harvest edge function (event-centric extraction
-- via the admin GraphQL getEventList query).

create table if not exists public.lp_events (
  id            text primary key,            -- LetsPoker tournament event id
  scheduled_at  timestamptz,                 -- UTC start
  event_date    date,                        -- Perth (UTC+8) wall-clock date
  event_name    text,
  entries       integer,                     -- field size (entrants count)
  rebuys        integer,
  synced_at     timestamptz not null default now()
);
comment on table public.lp_events is 'LetsPoker tournament events harvested from getEventList (event-centric history).';

create table if not exists public.lp_entries (
  event_id    text not null references public.lp_events(id) on delete cascade,
  player_id   text not null,
  first_name  text,
  last_name   text,
  position    integer,                       -- finishing position (1 = winner)
  winnings    numeric,                        -- payout.value (AUD)
  entry_count integer not null default 1,    -- re-entries/rebuys folded into one row
  primary key (event_id, player_id)
);
comment on table public.lp_entries is 'Per-player entrant rows per LetsPoker event (one row per player per event; entry_count folds re-entries).';

create index if not exists lp_entries_player_idx on public.lp_entries (player_id);
create index if not exists lp_events_date_idx     on public.lp_events  (event_date);

alter table public.lp_events  enable row level security;  -- service-role only
alter table public.lp_entries enable row level security;

grant select, insert, update, delete on public.lp_events  to service_role;
grant select, insert, update, delete on public.lp_entries to service_role;
