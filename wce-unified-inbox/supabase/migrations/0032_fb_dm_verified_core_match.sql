-- Loosen inbox_fb_dm_verified's name match: also compare a "core" name with
-- venue/poker tags stripped, so "Chris Pavitt MCT" matches attendee "Chris
-- Pavitt". The tags are only stripped for COMPARISON — the stored player_name /
-- contact label keeps "MCT" and friends untouched (this view never writes).
-- (Full-name match retained as well; a row verifies on either.)
create or replace view public.inbox_fb_dm_verified
with (security_invoker = false) as
with att as (
  select distinct
    regexp_replace(lower(coalesce(name,'')), '[^a-z]', '', 'g') as full_nk,
    regexp_replace(regexp_replace(lower(coalesce(name,'')),
      '\m(poker|holdem|cash|tourney|tournament|nlh|plo|mtt|mct|woodvale|kenwick|bentley|kingsley|leederville|leedy|stirling|adriatic|kwinana|southside|north|south|central|east|west|hotel|tavern|club|bowls|president|dealer|reserve|home|game|games|player)\M',
      ' ', 'g'), '[^a-z]', '', 'g') as core_nk
  from inbox_td_attendees where coalesce(name,'') <> ''
),
cand as (
  select o.id,
    regexp_replace(lower(coalesce(o.player_name,'')), '[^a-z]', '', 'g') as full_nk,
    regexp_replace(regexp_replace(lower(coalesce(o.player_name,'')),
      '\m(poker|holdem|cash|tourney|tournament|nlh|plo|mtt|mct|woodvale|kenwick|bentley|kingsley|leederville|leedy|stirling|adriatic|kwinana|southside|north|south|central|east|west|hotel|tavern|club|bowls|president|dealer|reserve|home|game|games|player)\M',
      ' ', 'g'), '[^a-z]', '', 'g') as core_nk
  from inbox_outreach o
  where o.fb_friend = true and coalesce(o.hidden, false) = false
    and o.phone is null and o.beeper_chat_id is null
)
select c.id
from cand c
where (length(c.full_nk) >= 4 and c.full_nk in (select full_nk from att where length(full_nk) >= 4))
   or (length(c.core_nk) >= 4 and c.core_nk in (select core_nk from att where length(core_nk) >= 4));

grant select on public.inbox_fb_dm_verified to anon, authenticated;
