-- 0054_attendance_stats.sql
-- Per-player attendance scoring over the FULL history of LP tournament entries
-- (live nightly via the letspoker crons) + TD-sheet attendees (live sync + the
-- --all backfill). Distinct days so an LP entry and a TD row for the same night
-- count once. A view, so it is always current as new dates land. Additive.
create or replace view public.inbox_attendance_stats as
select
  norm,
  count(distinct d) as games,
  count(distinct d) filter (where fmt = 'tourney') as tourney_games,
  count(distinct d) filter (where fmt = 'cash') as cash_games,
  count(distinct d) filter (where d >= current_date - 70) as games_10w,
  min(d) as first_seen,
  max(d) as last_seen,
  array_agg(distinct venue) filter (where venue is not null) as venues
from public.inbox_attendance_norm
where coalesce(norm, '') <> ''
group by norm;
grant select on public.inbox_attendance_stats to anon, authenticated;
