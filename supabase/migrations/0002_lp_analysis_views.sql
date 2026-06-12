-- Analysis layer over the raw lp_events / lp_entries tables.
--   lp_event_enriched  : events + derived night, venue, parsed buy-in
--   lp_entry_enriched  : one enriched row per attendance (player x event)
--   lp_player_summary  : per-player lifetime metrics + prominent night/venue/event
--   lp_churn           : Jul-Dec 2025 vs Jan-Jun 2026 entry comparison
--   lp_event_summary   : per recurring event — field size, prize paid, profitability

create or replace view public.lp_event_enriched as
select
  e.*,
  trim(to_char(e.event_date, 'Day')) as night,
  extract(isodow from e.event_date)::int as night_num,
  case
    when e.event_name ilike '%market city%' or e.event_name ilike '%mct%' then 'Market City Tavern'
    when e.event_name ilike '%woodvale%'    then 'Woodvale Tavern'
    when e.event_name ilike '%kenwick%'     then 'Kenwick FC'
    when e.event_name ilike '%kingsley%' or e.event_name ilike '%kingstack%' then 'Kingsley Tavern'
    when e.event_name ilike '%leederville%' then 'Leederville Hotel'
    when e.event_name ilike '%currambine%'  then 'Currambine Bar & Bistro'
    when e.event_name ilike '%bentley%'     then 'The Bentley Hotel'
    when e.event_name ilike '%stirling%' or e.event_name ilike '%adriatic%' then 'Stirling Adriatic'
    when e.event_name ilike '%planet royale%' then 'Planet Royale'
    when e.event_name ilike '%south perth bowls%' then 'South Perth Bowls Club'
    when e.event_name ilike '%the duke%'    then 'The Duke'
    when e.event_name ilike '%malaga%' or e.event_name ilike '%lcb%' then 'LCB Malaga'
    else 'Other/Unknown'
  end as venue,
  nullif(substring(lower(replace(e.event_name, ',', '')) from '\$\s*([0-9]+)\s*(?:entry|buyin|buy in|bounty)'), '')::numeric as buyin_parsed
from public.lp_events e;

create or replace view public.lp_entry_enriched as
select
  en.player_id, en.first_name, en.last_name,
  trim(coalesce(en.first_name,'') || ' ' || coalesce(en.last_name,'')) as full_name,
  en.position, en.winnings, en.entry_count,
  ev.id as event_id, ev.event_date, ev.scheduled_at, ev.event_name,
  ev.night, ev.night_num, ev.venue, ev.buyin_parsed, ev.entries as field_size
from public.lp_entries en
join public.lp_event_enriched ev on ev.id = en.event_id;

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
  where x.player_id = b.player_id group by event_name order by n desc, event_name limit 1) fe on true;

create or replace view public.lp_churn as
with periods as (
  select
    player_id,
    sum(entry_count) filter (where event_date >= date '2025-07-01' and event_date < date '2026-01-01') as entries_h2_2025,
    sum(entry_count) filter (where event_date >= date '2026-01-01' and event_date < date '2026-07-01') as entries_h1_2026
  from public.lp_entry_enriched
  group by player_id
)
select
  s.player_id, s.full_name,
  coalesce(p.entries_h2_2025,0) as entries_jul_dec_2025,
  coalesce(p.entries_h1_2026,0) as entries_jan_jun_2026,
  coalesce(p.entries_h2_2025,0) - coalesce(p.entries_h1_2026,0) as drop_abs,
  case when coalesce(p.entries_h2_2025,0) = 0 then null
       else round(100.0 * (coalesce(p.entries_h2_2025,0) - coalesce(p.entries_h1_2026,0)) / p.entries_h2_2025, 0) end as drop_pct,
  s.last_seen, s.days_since_last,
  s.prominent_night, s.prominent_venue, s.favourite_event,
  s.events_attended as lifetime_events, s.total_entries as lifetime_entries,
  s.total_winnings, s.best_finish, s.avg_buyin_parsed
from public.lp_player_summary s
left join periods p on p.player_id = s.player_id;

create or replace view public.lp_event_summary as
select
  event_name,
  max(venue) as venue,
  mode() within group (order by night) as typical_night,
  count(*) as times_run,
  round(avg(field_size)::numeric, 1) as avg_field_size,
  sum(field_size) as total_entries_all_runs,
  round(avg(buyin_parsed), 2) as avg_buyin_parsed,
  sum(prize_paid) as total_prize_paid,
  round(avg(prize_paid)::numeric, 2) as avg_prize_paid_per_run,
  min(event_date) as first_run,
  max(event_date) as last_run
from (
  select ev.id, ev.event_name, ev.venue, ev.night, ev.event_date, ev.entries as field_size, ev.buyin_parsed,
         coalesce((select sum(winnings) from public.lp_entries en where en.event_id = ev.id), 0) as prize_paid
  from public.lp_event_enriched ev
) x
group by event_name
order by times_run desc;

grant select on public.lp_event_enriched, public.lp_entry_enriched,
               public.lp_player_summary, public.lp_churn, public.lp_event_summary
  to service_role;
