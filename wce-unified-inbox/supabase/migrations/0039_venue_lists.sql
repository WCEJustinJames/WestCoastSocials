-- 0039_venue_lists.sql
-- Roadmap #1: venue lists (cash | tourney per venue).
-- Adopts the previously-stranded inbox_lists / inbox_list_members tables into the
-- repo (they already exist live from PR #7), adds the game_type / pinned / added_by
-- columns the (venue x cash|tourney) taxonomy needs, and a venue-aware tourney
-- auto-seed. STRICTLY ADDITIVE: no existing list or member row is altered or removed.

-- ---- name normalisation helpers ----
-- Same letters-only + venue/stake noise strip the player_attendance() fn uses,
-- factored out so the seed + attendance view share one definition.
create or replace function public.norm_full_name(p text)
returns text language sql immutable as $$
  select regexp_replace(lower(coalesce(p,'')), '[^a-z]', '', 'g')
$$;

create or replace function public.norm_core_name(p text)
returns text language sql immutable as $$
  select regexp_replace(
    regexp_replace(lower(coalesce(p,'')),
      '\m(poker|holdem|cash|tourney|tournament|nlh|plo|mtt|mct|woodvale|kenwick|bentley|kingsley|leederville|leedy|stirling|adriatic|kwinana|southside|north|south|central|east|west|hotel|tavern|club|bowls|president|dealer|reserve|home|game|games|player)\M',
      ' ', 'g'),
    '[^a-z]', '', 'g')
$$;

-- ---- venue canonicaliser ----
-- Maps the messy LP event_name / TD venue strings onto the canonical venue vocab
-- used in the UI (src/ui/usePlayers VENUES). Returns null when nothing matches, so
-- unmappable events (e.g. "The Duke", "Coasters Free League") simply don't seed.
create or replace function public.canon_venue(p text)
returns text language sql immutable as $$
  select case
    when p is null then null
    when p ~* '(market city|\mmct\M)' then 'MCT'
    when p ~* 'woodvale' then 'Woodvale'
    when p ~* '(leederville|leedy)' then 'Leederville'
    when p ~* 'kenwick' then 'Kenwick'
    when p ~* '(kingsley|kingstack)' then 'Kingsley'
    when p ~* 'bentley' then 'Bentley'
    when p ~* 'stirling' then 'Stirling'
    when p ~* 'planet royale' then 'Planet Royale'
    else null
  end
$$;

-- ---- adopt the tables (no-op where they already exist live) ----
create table if not exists public.inbox_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  event_day text,
  event_time text,
  venue text,
  notes text,
  created_at timestamptz not null default now()
);
-- game_type: 'cash' | 'tourney' (null on the pre-existing rows until re-keyed in the UI).
alter table public.inbox_lists add column if not exists game_type text;

create table if not exists public.inbox_list_members (
  list_id uuid not null references public.inbox_lists(id) on delete cascade,
  outreach_id uuid not null references public.inbox_outreach(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (list_id, outreach_id)
);
-- pinned: protect a member from any future automated pruning. added_by: 'manual' | 'auto'.
alter table public.inbox_list_members add column if not exists pinned boolean not null default false;
alter table public.inbox_list_members add column if not exists added_by text not null default 'manual';

-- permissive RLS + grants, same single-user posture as the other inbox_ tables.
alter table public.inbox_lists enable row level security;
alter table public.inbox_list_members enable row level security;
drop policy if exists inbox_lists_all on public.inbox_lists;
create policy inbox_lists_all on public.inbox_lists for all using (true) with check (true);
drop policy if exists inbox_list_members_all on public.inbox_list_members;
create policy inbox_list_members_all on public.inbox_list_members for all using (true) with check (true);
grant all on public.inbox_lists to anon, authenticated;
grant all on public.inbox_list_members to anon, authenticated;

-- ---- canonical attendance with venue + format ----
-- Service/definer use only (NOT anon-granted: it exposes per-player attendance).
-- One normalised name string per attendance, matched against a player's full OR
-- core norm (mirrors player_attendance()). LP entries are all tournaments; TD rows
-- split on category (electronic-paying entrants count as tourney, only 'cash' is cash).
create or replace view public.inbox_attendance_norm as
  select
    public.norm_full_name(coalesce(en.first_name,'') || coalesce(en.last_name,'')) as norm,
    public.canon_venue(e.event_name) as venue,
    'tourney'::text as fmt,
    e.event_date as d
  from public.lp_entries en
  join public.lp_events e on e.id = en.event_id
  where e.event_date is not null
  union all
  select
    public.norm_full_name(a.name) as norm,
    public.canon_venue(a.venue) as venue,
    case when a.category = 'cash' then 'cash' else 'tourney' end as fmt,
    a.game_date as d
  from public.inbox_td_attendees a
  where a.game_date is not null;

-- ---- tourney auto-seed ----
-- ADD (never remove) players who have played >= p_min tournaments at the list's
-- venue within the last p_days. Skips banned / staff / hidden. Marks rows
-- added_by='auto'. Cash lists are seeded manually (attendance can't reliably
-- distinguish cash today). Idempotent: on-conflict-do-nothing, so re-running only
-- tops up new regulars and never disturbs manual members. Returns rows inserted.
create or replace function public.seed_tourney_list(
  p_list_id uuid, p_days int default 90, p_min int default 2
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_venue text;
  n int;
begin
  select public.canon_venue(venue) into v_venue from public.inbox_lists where id = p_list_id;
  if v_venue is null then
    return 0;  -- list venue doesn't map to a known venue; nothing to seed
  end if;

  with cand as (
    select o.id
    from public.inbox_outreach o
    join public.inbox_attendance_norm a
      on a.venue = v_venue
     and a.fmt = 'tourney'
     and a.d >= current_date - p_days
     and length(a.norm) >= 4
     and a.norm in (public.norm_full_name(o.player_name), public.norm_core_name(o.player_name))
    where o.player_name is not null
      and coalesce(o.do_not_message, false) = false
      and coalesce(o.staff, false) = false
      and coalesce(o.hidden, false) = false
    group by o.id
    having count(distinct a.d) >= p_min
  ), ins as (
    insert into public.inbox_list_members (list_id, outreach_id, added_by)
    select p_list_id, id, 'auto' from cand
    on conflict (list_id, outreach_id) do nothing
    returning 1
  )
  select count(*) into n from ins;
  return n;
end;
$$;
grant execute on function public.seed_tourney_list(uuid, int, int) to anon, authenticated;
