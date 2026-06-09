-- LetsPoker cash automation: open cash games, seat reused player names
-- (one user/day across tournament + cash), and push per event.
-- Applied to project dexdftcmcixppbuucjfd (WCE App).

create table if not exists public.cash_events (
  event_id     text primary key,
  event_date   date not null,
  label        text,
  starts_at    timestamptz,
  excluded     boolean not null default false,
  synced_at    timestamptz not null default now()
);
comment on table public.cash_events is 'LetsPoker cash events (getEventList includeCash:true minus tournament-only list).';

create table if not exists public.cash_plan (
  id                  uuid primary key default gen_random_uuid(),
  event_date          date not null,
  label               text,
  event_id            text,
  buyin_variant_id    text,
  stakes              jsonb not null default '[]'::jsonb,
  game_types          jsonb not null default '[]'::jsonb,
  anticipated_tables  int,
  anticipated_players int,
  status              text not null default 'planned',
  opened_at           timestamptz,
  created_at          timestamptz not null default now()
);
comment on table public.cash_plan is 'Per cash event/date plan: stakes, game types, anticipated tables/players.';

create table if not exists public.cash_seat_roster (
  id            uuid primary key default gen_random_uuid(),
  plan_id       uuid references public.cash_plan(id) on delete cascade,
  event_date    date not null,
  player_name   text not null,
  player_id     text,
  seat_status   text not null default 'pending',
  seated_at     timestamptz,
  detail        text,
  created_at    timestamptz not null default now()
);
comment on table public.cash_seat_roster is 'Player names to seat onto cash tables (reused tournament regulars).';

create table if not exists public.cash_day_user_ledger (
  play_date    date not null,
  player_key   text not null,
  player_name  text,
  player_id    text,
  used_for     text,
  event_id     text,
  created_at   timestamptz not null default now(),
  primary key (play_date, player_key)
);
comment on table public.cash_day_user_ledger is 'Cost/idempotency guard: one name/user per Perth day across all events.';

create table if not exists public.cash_open_log (
  id           bigint generated always as identity primary key,
  source       text,
  op           text,
  ref          text,
  http_status  int,
  ok           boolean,
  detail       text,
  created_at   timestamptz not null default now()
);

create table if not exists public.cash_fired (
  event_id   text not null,
  slot       text not null,
  created_at timestamptz not null default now(),
  primary key (event_id, slot)
);

alter table public.cash_events          enable row level security;
alter table public.cash_plan            enable row level security;
alter table public.cash_seat_roster     enable row level security;
alter table public.cash_day_user_ledger enable row level security;
alter table public.cash_open_log        enable row level security;
alter table public.cash_fired           enable row level security;
