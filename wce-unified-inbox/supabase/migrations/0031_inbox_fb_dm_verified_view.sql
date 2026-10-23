-- "FB · DM to open", restricted to verified players. A Facebook friend is only a
-- worthwhile cold-DM target if they actually play — i.e. their name appears in
-- TD-sheet / LetsPoker attendance (inbox_td_attendees, which mirrors both). This
-- view returns the ids of fb_friend players with no other contact whose name
-- matches an attendee, so the Players "FB · DM to open" filter/count and the Home
-- card only surface real players (not the whole friends list).
--
-- Match is on the full name normalised to letters-only, so it's deliberately
-- conservative: a first-name-only friend won't false-match a specific attendee.
create or replace view public.inbox_fb_dm_verified
with (security_invoker = false) as
with att as (
  select distinct regexp_replace(lower(coalesce(name,'')), '[^a-z]', '', 'g') as nk
  from inbox_td_attendees where coalesce(name,'') <> ''
)
select o.id
from inbox_outreach o
where o.fb_friend = true
  and coalesce(o.hidden, false) = false
  and o.phone is null
  and o.beeper_chat_id is null
  and length(regexp_replace(lower(coalesce(o.player_name,'')), '[^a-z]', '', 'g')) >= 4
  and regexp_replace(lower(coalesce(o.player_name,'')), '[^a-z]', '', 'g') in (select nk from att);

grant select on public.inbox_fb_dm_verified to anon, authenticated;
