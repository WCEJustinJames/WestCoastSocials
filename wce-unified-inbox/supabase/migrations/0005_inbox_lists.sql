-- Core player message lists: a named, persistent set of CRM players that feeds
-- a recurring scheduled event (e.g. the Friday cash game). The Batches composer
-- uses a list as a one-click recipient source, so the weekly send starts from
-- the same core list instead of re-filtering the CRM every time.
create table if not exists inbox_lists (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  event_day text,   -- Mon..Sun, the day the event runs
  event_time text,  -- free text, e.g. '7pm'
  venue text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists inbox_list_members (
  list_id uuid not null references inbox_lists(id) on delete cascade,
  outreach_id uuid not null references inbox_outreach(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (list_id, outreach_id)
);
create index if not exists inbox_list_members_outreach_idx
  on inbox_list_members (outreach_id);

-- Local single-user prototype: permissive RLS + anon/authenticated grants,
-- same as every other inbox table (tighten before hosting).
alter table inbox_lists enable row level security;
alter table inbox_list_members enable row level security;
create policy inbox_lists_all on inbox_lists for all using (true) with check (true);
create policy inbox_list_members_all on inbox_list_members for all using (true) with check (true);
grant select, insert, update, delete on inbox_lists to anon, authenticated;
grant select, insert, update, delete on inbox_list_members to anon, authenticated;

-- Starter lists for the Friday scheduled events; rename or add more in the UI.
insert into inbox_lists (name, event_day) values
  ('Friday Cash Game', 'Fri'),
  ('Friday Tournament', 'Fri')
on conflict (name) do nothing;
