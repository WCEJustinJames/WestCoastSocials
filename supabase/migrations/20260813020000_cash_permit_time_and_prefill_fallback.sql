-- Cash scheduling hardening (2026-08-13):
--
-- 1. cash_plan.open_from — the permit gate. The cash tick never opens or seats
--    a plan before this instant; null keeps the original behaviour (first tick
--    of the day, 10:00 Perth). Set per-plan, or let the prefill stamp it from
--    cash_open_defaults.
--
-- 2. cash_open_defaults — per-weekday permitted cash start (Perth wall time).
--    Rows are optional; a missing weekday means "no gate". Populate once the
--    venue permit times are confirmed, e.g.:
--      insert into public.cash_open_defaults values (4, '18:00');  -- Thursdays
--
-- 3. prefill_cash_from_history — two fixes:
--    a. Venue-token fallback. The old matcher required lp_venue(label) equality,
--       so marketing-label drift ("$120" vs "$120 Entry") silently dropped whole
--       game nights (Thursday 2026-08-13 was skipped exactly this way). Now,
--       when the venue-token match finds nothing AND the date has exactly one
--       non-excluded tournament (no ambiguity about which game it is), it falls
--       back to the most recent same-weekday event with entries.
--    b. Stamps open_from from cash_open_defaults on the plans it creates.

alter table public.cash_plan add column if not exists open_from timestamptz;

create table if not exists public.cash_open_defaults (
  dow smallint primary key check (dow between 0 and 6), -- 0=Sun .. 6=Sat (Perth)
  open_time_perth time not null
);
alter table public.cash_open_defaults enable row level security;
grant select on public.cash_open_defaults to service_role;
grant insert, update, delete on public.cash_open_defaults to service_role;

create or replace function public.prefill_cash_from_history(
  horizon_days integer default 14,
  lookback_days integer default 45,
  today date default ((now() at time zone 'Australia/Perth'::text))::date
)
returns table(upcoming_date date, label text, source_date date, source_name text, players integer, action text)
language plpgsql
set search_path to 'public', 'extensions'
as $function$
declare
  rec record;
  src record;
  new_plan uuid;
  venue text;
  dw int;
  siblings int;
  matched_via text;
  gate timestamptz;
begin
  for rec in
    select te.event_date, te.label
    from public.tournament_events te
    where te.event_date >= today
      and te.event_date <= today + horizon_days
      and coalesce(te.excluded,false) = false
    order by te.event_date
  loop
    venue := public.lp_venue(rec.label);
    dw := extract(dow from rec.event_date)::int;

    if exists (select 1 from public.cash_plan cp where cp.event_date = rec.event_date
               and public.lp_venue(cp.label) = venue) then
      upcoming_date := rec.event_date; label := rec.label;
      source_date := null; source_name := null; players := null; action := 'skip: plan exists';
      return next; continue;
    end if;

    -- Primary match: same weekday, same venue token, has entries.
    select e.id, e.event_date, e.event_name into src
    from public.lp_events e
    where e.event_date < rec.event_date
      and e.event_date >= rec.event_date - lookback_days
      and extract(dow from e.event_date)::int = dw
      and public.lp_venue(e.event_name) = venue
      and exists (select 1 from public.lp_entries en where en.event_id = e.id and en.player_id is not null)
    order by e.event_date desc
    limit 1;
    matched_via := 'venue';

    -- Fallback: label drift breaks the venue token ("$120" vs "$120 Entry").
    -- Safe only when the date has exactly ONE game, so there is no ambiguity
    -- about which venue's history to copy. Empty-name events are cash-day
    -- containers, never the weekly game — exclude them.
    if src.id is null then
      select count(*) into siblings from public.tournament_events te2
      where te2.event_date = rec.event_date and coalesce(te2.excluded,false) = false;
      if siblings = 1 then
        select e.id, e.event_date, e.event_name into src
        from public.lp_events e
        where e.event_date < rec.event_date
          and e.event_date >= rec.event_date - lookback_days
          and extract(dow from e.event_date)::int = dw
          and trim(coalesce(e.event_name,'')) <> ''
          and exists (select 1 from public.lp_entries en where en.event_id = e.id and en.player_id is not null)
        order by e.event_date desc
        limit 1;
        matched_via := 'weekday-fallback';
      end if;
    end if;

    if src.id is null then
      upcoming_date := rec.event_date; label := rec.label;
      source_date := null; source_name := null; players := null; action := 'skip: no prior match';
      return next; continue;
    end if;

    -- Permit gate: local wall time from cash_open_defaults, if configured.
    select (rec.event_date::text || ' ' || d.open_time_perth::text)::timestamp
             at time zone 'Australia/Perth'
      into gate
    from public.cash_open_defaults d where d.dow = dw;

    insert into public.cash_plan (event_date, label, stakes, game_types, status, open_from)
    values (rec.event_date, rec.label, '[]'::jsonb, '[]'::jsonb, 'planned', gate)
    returning id into new_plan;

    insert into public.cash_seat_roster (plan_id, event_date, player_name, player_id, seat_status)
    select new_plan, rec.event_date,
           trim(coalesce(en.first_name,'') || ' ' || coalesce(en.last_name,'')),
           en.player_id, 'pending'
    from public.lp_entries en
    where en.event_id = src.id and en.player_id is not null
      and not public.cash_is_excluded(
        en.player_id, trim(coalesce(en.first_name,'') || ' ' || coalesce(en.last_name,'')))
    group by en.player_id, en.first_name, en.last_name;

    upcoming_date := rec.event_date; label := rec.label;
    source_date := src.event_date; source_name := src.event_name;
    select count(*) into players from public.cash_seat_roster r where r.plan_id = new_plan;
    action := 'prefilled (' || matched_via || ')';
    return next;
  end loop;
end $function$;
