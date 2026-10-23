-- Player Outreach CRM, mirrored from Airtable (base "West Coast Event
-- Management", table "Player Outreach"). Read-only recipient source for batches;
-- the Node sync upserts it when AIRTABLE_API_KEY is set. Local single-user
-- prototype: permissive RLS + anon/authenticated grants (tighten before hosting).
create table if not exists inbox_outreach (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique not null,
  player_name text,
  first_name text,
  last_name text,
  phone text,
  email text,
  beeper_chat_id text,
  beeper_contact_name text,
  region text,
  stakes text[] not null default '{}',
  venues text[] not null default '{}',
  activity text,
  outreach_status text,
  game_type text,
  last_active date,
  last_contacted date,
  notes text,
  synced_at timestamptz not null default now()
);
create index if not exists inbox_outreach_region_idx on inbox_outreach (region);
create index if not exists inbox_outreach_chat_idx on inbox_outreach (beeper_chat_id);

alter table inbox_outreach enable row level security;
create policy inbox_outreach_all on inbox_outreach for all using (true) with check (true);
grant select, insert, update, delete on inbox_outreach to anon, authenticated;
