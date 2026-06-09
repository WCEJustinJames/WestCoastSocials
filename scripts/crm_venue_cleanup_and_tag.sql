-- CRM cleanup + segmentation, run after enrich_outreach_crm.sql.
-- Idempotent.

-- 1) Normalize inbox_outreach.venues to one canonical label per room
--    (Airtable used short forms like 'MCT' / 'Woodvale' alongside full names).
update inbox_outreach o
set venues = (
  select coalesce(array_agg(distinct canon order by canon), '{}')
  from (
    select case
      when v ilike 'mct' or v ilike 'market city%' then 'Market City Tavern'
      when v ilike 'woodvale%'                      then 'Woodvale Tavern'
      when v ilike 'bentley%' or v ilike 'the bentley%' then 'The Bentley Hotel'
      when v ilike 'kenwick%'                        then 'Kenwick FC'
      when v ilike 'kingsley%' or v ilike 'kingstack%' then 'Kingsley Tavern'
      when v ilike 'leederville%'                    then 'Leederville Hotel'
      when v ilike 'stirling%' or v ilike 'adriatic%' then 'Stirling Adriatic'
      when v ilike 'currambine%'                     then 'Currambine Bar & Bistro'
      when v ilike 'planet royale%'                  then 'Planet Royale'
      when v ilike 'lcb%' or v ilike '%malaga%'      then 'LCB Malaga'
      when v ilike 'south perth bowls%'              then 'South Perth Bowls Club'
      else v end as canon
    from unnest(o.venues) v
  ) t where canon is not null and canon <> ''
)
where coalesce(array_length(o.venues,1),0) > 0;

-- 2) Tag the churned-regular segment in the (otherwise unused) activity field.
with pm as (
  select s.player_id, lower(regexp_replace(trim(s.full_name), '\s+', ' ', 'g')) as full_key
  from lp_player_summary s where s.full_name is not null and s.full_name <> ''
),
pm1 as (select full_key, min(player_id) player_id from pm group by full_key having count(distinct player_id)=1),
churned as (select player_id from lp_churn where entries_jul_dec_2025 >= 15 and drop_pct >= 70),
matches as (
  select o.id as outreach_id
  from inbox_outreach o
  join pm1 m on m.full_key = lower(regexp_replace(trim(coalesce(o.player_name, o.first_name||' '||o.last_name)), '\s+', ' ', 'g'))
  join churned ch on ch.player_id = m.player_id
)
update inbox_outreach o
set activity = 'churned_regular', synced_at = now()
from matches where o.id = matches.outreach_id;
