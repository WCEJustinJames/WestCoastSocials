-- Keep cash-day containers out of the tournament push pipeline (2026-08-20).
--
-- A cash day is a LetsPoker *tournament* with an EMPTY eventName at Perth
-- midnight. letspoker-push's sync runs with includeCash:false, but that flag
-- doesn't help: structurally these ARE tournaments, so the sync upserted them
-- into tournament_events as ordinary games.
--
-- Nothing has ever fired for one, but only by luck of timing: containers were
-- created at 10:00 on the day, by which point the teaser (20:30 the night
-- before) and the in-event slots (start+30..+150 = 00:30-02:30 off a midnight
-- start) had already passed, and every daytime countdown is dropped by the
-- "at > startMs" rule. A container existing before ~00:30 on its own date --
-- e.g. staff opening tomorrow's cash day this evening -- would have pushed a
-- nameless "game" to players at 20:30 and five more between 00:30 and 02:30.
--
-- A trigger rather than a code change in the edge function: this is an
-- invariant of the table, it covers every writer (sync, manual insert, backfill)
-- and it needs no redeploy of the function that fires live pushes.
--
-- Real games always carry a label and a real start time, so the predicate can
-- never catch one. Setting excluded is also exactly what the push pipeline
-- already honours (lookupGames/lookupEvents/readUpcomingTournaments all filter
-- excluded=is.false), so no other code has to learn about containers.

create or replace function public.tournament_events_exclude_cash_containers()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if coalesce(trim(new.label), '') = ''
     and new.starts_at is not null
     and (new.starts_at at time zone 'Australia/Perth')::time = time '00:00'
  then
    new.excluded := true;
  end if;
  return new;
end $$;

drop trigger if exists trg_exclude_cash_containers on public.tournament_events;
create trigger trg_exclude_cash_containers
  before insert or update on public.tournament_events
  for each row execute function public.tournament_events_exclude_cash_containers();
