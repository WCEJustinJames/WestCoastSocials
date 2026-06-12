-- Enrich the inbox_outreach CRM from harvested LetsPoker history.
--   * last_active  <- player's exact last attendance (lp_player_summary.last_seen)
--   * venues       <- merge existing venues with the player's FAVOURITE venue,
--                     but only when that venue was attended more than once
--                     (prominent_venue_count > 1) and is a real room (not Other/Unknown)
--
-- High-precision match only: outreach name == a UNIQUE normalized LetsPoker
-- full name. Ambiguous / messy CRM labels are intentionally left untouched.
-- Idempotent — safe to re-run after each harvest refresh.

with pm as (
  select s.player_id, s.last_seen, s.prominent_venue, s.prominent_venue_count,
    lower(regexp_replace(trim(s.full_name), '\s+', ' ', 'g')) as full_key
  from lp_player_summary s
  where s.full_name is not null and s.full_name <> ''
),
pm1 as (
  select full_key,
    min(player_id) as player_id,
    max(last_seen) as last_seen,
    max(prominent_venue) as prominent_venue,
    max(prominent_venue_count) as prominent_venue_count
  from pm group by full_key having count(distinct player_id) = 1
),
matches as (
  select o.id as outreach_id, m.last_seen,
    case when m.prominent_venue_count > 1 and m.prominent_venue is not null
              and m.prominent_venue <> 'Other/Unknown'
         then m.prominent_venue end as fav_venue
  from inbox_outreach o
  join pm1 m
    on m.full_key = lower(regexp_replace(trim(coalesce(o.player_name, o.first_name||' '||o.last_name)), '\s+', ' ', 'g'))
)
update inbox_outreach o
set last_active = matches.last_seen,
    venues = (
      select coalesce(array_agg(distinct e order by e), '{}')
      from unnest(coalesce(o.venues, '{}'::text[]) ||
                  case when matches.fav_venue is not null then array[matches.fav_venue] else '{}'::text[] end) e
      where e is not null and e <> ''
    ),
    synced_at = now()
from matches
where o.id = matches.outreach_id;
