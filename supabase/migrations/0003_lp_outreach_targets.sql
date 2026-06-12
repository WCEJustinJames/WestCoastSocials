-- Outreach list: churned regulars (15+ entries Jul-Dec 2025, 70%+ drop) matched
-- to a contactable CRM row, deduped to one row per player.
drop view if exists public.lp_outreach_targets;
create view public.lp_outreach_targets as
with pm as (
  select s.player_id, lower(regexp_replace(trim(s.full_name), '\s+', ' ', 'g')) as full_key
  from public.lp_player_summary s where s.full_name is not null and s.full_name <> ''
),
pm1 as (select full_key, min(player_id) player_id from pm group by full_key having count(distinct player_id)=1),
joined as (
  select
    m.player_id,
    o.id as outreach_id, o.player_name, o.phone, o.email,
    o.do_not_message, o.hidden, o.last_contacted, o.contact_day, o.contact_window,
    c.prominent_night, c.prominent_venue, c.favourite_event,
    c.last_seen, c.days_since_last,
    c.entries_jul_dec_2025, c.entries_jan_jun_2026, c.drop_abs, c.drop_pct,
    c.total_winnings, c.best_finish
  from inbox_outreach o
  join pm1 m on m.full_key = lower(regexp_replace(trim(coalesce(o.player_name, o.first_name||' '||o.last_name)), '\s+', ' ', 'g'))
  join public.lp_churn c on c.player_id = m.player_id
  where c.entries_jul_dec_2025 >= 15 and c.drop_pct >= 70
),
dedup as (   -- one CRM row per player: prefer contactable, non-DNM, not hidden
  select distinct on (player_id) *
  from joined
  order by player_id,
    do_not_message asc nulls first,
    hidden asc nulls first,
    (phone is not null) desc,
    (email is not null) desc,
    last_contacted desc nulls last
)
select * from dedup order by drop_abs desc;

grant select on public.lp_outreach_targets to service_role;
