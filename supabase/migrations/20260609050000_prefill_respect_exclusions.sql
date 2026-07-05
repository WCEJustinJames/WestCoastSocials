-- Re-create the prefill so it skips players on the cash_exclusions list.
create or replace function public.prefill_cash_from_history(
  horizon_days  int  default 14,
  lookback_days int  default 45,
  today         date default (now() at time zone 'Australia/Perth')::date
)
returns table(upcoming_date date, label text, source_date date, source_name text, players int, action text)
language plpgsql as $$
declare
  rec record;
  src record;
  new_plan uuid;
  venue text;
  dw int;
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

    select e.id, e.event_date, e.event_name into src
    from public.lp_events e
    where e.event_date < rec.event_date
      and e.event_date >= rec.event_date - lookback_days
      and extract(dow from e.event_date)::int = dw
      and public.lp_venue(e.event_name) = venue
      and exists (select 1 from public.lp_entries en where en.event_id = e.id and en.player_id is not null)
    order by e.event_date desc
    limit 1;

    if src.id is null then
      upcoming_date := rec.event_date; label := rec.label;
      source_date := null; source_name := null; players := null; action := 'skip: no prior match';
      return next; continue;
    end if;

    insert into public.cash_plan (event_date, label, stakes, game_types, status)
    values (rec.event_date, rec.label, '[]'::jsonb, '[]'::jsonb, 'planned')
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
    action := 'prefilled';
    return next;
  end loop;
end $$;
