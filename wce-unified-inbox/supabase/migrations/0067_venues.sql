-- 0067_venues.sql
-- Venues become data instead of a hardcoded array.
--
-- The app carried its venue list in a TypeScript constant, which meant opening a
-- new room needed a code change and a deploy. Gosnells has been running since
-- long enough to log 208 games — it was already the second most recent venue in
-- inbox_game_financials — and it could not be selected anywhere in the app,
-- because nobody had edited the array.
--
-- `aliases` matters as much as `name`. TD sheets name the same room a dozen
-- ways ("Woody", "Woodvale.", "Planet R", "Adriatic", "Kenwick FC"), and until
-- now the folding rules for those lived in two more hardcoded maps in the sync
-- engine. One row per venue, and every part of the system asks the same table.
create table if not exists public.inbox_venues (
  name       text primary key,
  aliases    text[] not null default '{}',
  active     boolean not null default true,
  sort       int not null default 100,
  created_at timestamptz not null default now()
);

alter table public.inbox_venues enable row level security;

drop policy if exists staff_all on public.inbox_venues;
create policy staff_all on public.inbox_venues
  for all using (wcp_is_active_staff()) with check (wcp_is_active_staff());

-- Same shape as every other inbox table: nothing for anon, RLS does the gating
-- for signed-in staff.
revoke all on public.inbox_venues from anon;
grant select, insert, update, delete on public.inbox_venues to authenticated;

-- Seed: the eight the constant already carried, plus Gosnells. Aliases are the
-- variants actually observed in inbox_game_financials and the two alias maps
-- that used to live in src/sync/outreach.ts and src/sync/notify.ts. Lowercase —
-- matching is case-insensitive.
insert into public.inbox_venues (name, aliases, sort) values
  ('MCT',           array['mct','market city','market city tavern'],                        10),
  ('Gosnells',      array['gcfc','thornlie','gosnells cfc','gosnells football club'],        20),
  ('Woodvale',      array['woody','woodvale.','woodvale tavern'],                            30),
  ('Bentley',       array['the bentley hotel','bentley hotel'],                              40),
  ('Kenwick',       array['kenwick fc'],                                                     50),
  ('Kingsley',      array['kingsley tavern'],                                                60),
  ('Leederville',   array['leedy','leederville hotel'],                                      70),
  ('Stirling',      array['adriatic','stirling adriatic','stirling adriatic bowls club'],    80),
  ('Planet Royale', array['planet r','planet royal'],                                        90)
on conflict (name) do nothing;
