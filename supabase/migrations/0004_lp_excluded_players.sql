-- Player exclusion list (e.g. banned players). Filtered out of lp_player_summary
-- and therefore out of lp_churn / lp_outreach_targets / the master export.
-- Event-level history (lp_events / lp_entries / lp_event_summary) is left intact
-- so field sizes and payouts still reflect reality.

create table if not exists public.lp_excluded_players (
  player_id   text primary key,
  full_name   text,
  reason      text,
  excluded_at timestamptz not null default now()
);
comment on table public.lp_excluded_players is 'Players excluded from churn/outreach lists (e.g. banned). Event-level history is unaffected.';
grant select, insert, update, delete on public.lp_excluded_players to service_role;

-- lp_player_summary gains a final-row exclusion filter; downstream views inherit it.
create or replace view public.lp_player_summary as
with base as (
  select
    player_id,
    max(full_name) filter (where full_name <> '') as full_name,
    min(event_date) as first_seen,
    max(event_date) as last_seen,
    count(distinct event_id) as events_attended,
    sum(entry_count) as total_entries,
    sum(coalesce(winnings,0)) as total_winnings,
    min(position) as best_finish,
    count(*) filter (where winnings is not null and winnings > 0) as itm_finishes,
    round(avg(buyin_parsed), 2) as avg_buyin_parsed
  from public.lp_entry_enriched
  group by player_id
)
select
  b.*,
  (current_date - b.last_seen) as days_since_last,
  pn.night  as prominent_night,      pn.n as prominent_night_count,
  pv.venue  as prominent_venue,      pv.n as prominent_venue_count,
  fe.event_name as favourite_event,  fe.n as favourite_event_count
from base b
left join lateral (
  select night, count(*) n from public.lp_entry_enriched x
  where x.player_id = b.player_id group by night order by n desc, night limit 1) pn on true
left join lateral (
  select venue, count(*) n from public.lp_entry_enriched x
  where x.player_id = b.player_id group by venue order by n desc, venue limit 1) pv on true
left join lateral (
  select event_name, count(*) n from public.lp_entry_enriched x
  where x.player_id = b.player_id group by event_name order by n desc, event_name limit 1) fe on true
where b.player_id not in (select player_id from public.lp_excluded_players);
