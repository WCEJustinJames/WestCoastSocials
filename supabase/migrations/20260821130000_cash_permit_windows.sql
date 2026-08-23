-- Venue cash permit windows (2026-08-21), as given by Justin:
--   Mon-Fri  18:00 - 23:59 Perth
--   Sat      12:30 - 18:30 Perth
--   Sun      no permitted cash -- no row, and the tick treats a missing row as
--            "no gate", so Sunday is deliberately left without a cash plan
--            rather than gated. Add a row if Sunday cash ever starts.
--
-- A permit is a WINDOW, not a start time. The original gate only held a plan
-- until open_from; auto-seating a player after the permit ends is the same
-- breach as seating one before it starts, and Saturday's 18:30 close makes that
-- a live concern rather than a theoretical one. So cash_plan gains open_until
-- and the tick stops once it passes.
--
-- Both columns stay nullable: a plan with neither behaves exactly as before.

alter table public.cash_open_defaults add column if not exists close_time_perth time;
alter table public.cash_plan add column if not exists open_until timestamptz;

insert into public.cash_open_defaults (dow, open_time_perth, close_time_perth) values
  (1, '18:00', '23:59'),  -- Monday
  (2, '18:00', '23:59'),  -- Tuesday
  (3, '18:00', '23:59'),  -- Wednesday
  (4, '18:00', '23:59'),  -- Thursday
  (5, '18:00', '23:59'),  -- Friday
  (6, '12:30', '18:30')   -- Saturday
on conflict (dow) do update
  set open_time_perth = excluded.open_time_perth,
      close_time_perth = excluded.close_time_perth;

-- Stamp both ends of the window on plans the prefill creates.
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
  gate_open timestamptz;
  gate_close timestamptz;
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
    -- about which venue's history to copy.
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

    -- Permit window for that weekday, as local Perth wall time.
    select (rec.event_date::text || ' ' || d.open_time_perth::text)::timestamp at time zone 'Australia/Perth',
           case when d.close_time_perth is null then null
                else (rec.event_date::text || ' ' || d.close_time_perth::text)::timestamp at time zone 'Australia/Perth'
           end
      into gate_open, gate_close
    from public.cash_open_defaults d where d.dow = dw;

    insert into public.cash_plan (event_date, label, stakes, game_types, status, open_from, open_until)
    values (rec.event_date, rec.label, '[]'::jsonb, '[]'::jsonb, 'planned', gate_open, gate_close)
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

-- Existing future plans were created before the windows were configured.
update public.cash_plan cp
set open_from = (cp.event_date::text || ' ' || d.open_time_perth::text)::timestamp at time zone 'Australia/Perth',
    open_until = case when d.close_time_perth is null then null
                      else (cp.event_date::text || ' ' || d.close_time_perth::text)::timestamp at time zone 'Australia/Perth' end
from public.cash_open_defaults d
where d.dow = extract(dow from cp.event_date)::int
  and cp.event_date >= (now() at time zone 'Australia/Perth')::date
  and cp.open_from is null;
