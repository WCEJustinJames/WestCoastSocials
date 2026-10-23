-- Attendees pulled from the per-game TD sheets (Google Sheets named "DD/MM Venue").
-- The sync reads three player-bearing sections out of each night's sheet — the
-- electronic buy-in/cash-out "Player Full Name" tables, the cash-game
-- "Name/Amount/Time" tables, and the "Placing/Player/Prize" tournament table
-- (placing 1 = winner) — and skips the dealer/staff/timesheet tables. The
-- post-game tool reads from here so tonight's players are one tap away.
create table if not exists inbox_td_attendees (
  id uuid primary key default gen_random_uuid(),
  sheet_id text not null,
  sheet_title text,
  venue text,
  game_date date,
  name text not null,
  is_winner boolean not null default false,
  category text,                       -- 'cash' | 'electronic' | 'tournament'
  synced_at timestamptz not null default now(),
  unique (sheet_id, name)
);
create index if not exists inbox_td_attendees_date on inbox_td_attendees (game_date desc, venue);
