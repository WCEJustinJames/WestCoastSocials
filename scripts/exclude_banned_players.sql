-- Add players to the exclusion list (banned, etc.) and reflect it in the CRM.
-- Resolve player_id from lp_player_summary by name first, then add rows here.
-- Idempotent.

insert into lp_excluded_players (player_id, full_name, reason) values
  ('15e87437aed38b5c', 'Leanne Chapman', 'banned'),
  ('ebdc1b2e56d61b0d', 'Meng Yeow',      'banned'),
  ('b1c8eb47c138b8cf', 'Harry Bui',      'banned')
on conflict (player_id) do update set reason = excluded.reason, full_name = excluded.full_name;

-- Mirror into the CRM: drop the churned tag, mark do-not-message, note the ban.
with banned as (
  select lower(regexp_replace(trim(full_name),'\s+',' ','g')) as nkey from lp_excluded_players
)
update inbox_outreach o
set do_not_message = true,
    activity = case when o.activity = 'churned_regular' then null else o.activity end,
    notes = trim(both ' ' from coalesce(o.notes,'') || case when coalesce(o.notes,'') = '' then '' else ' | ' end || 'banned'),
    synced_at = now()
where lower(regexp_replace(trim(coalesce(o.player_name, o.first_name||' '||o.last_name)),'\s+',' ','g'))
      in (select nkey from banned);
