-- player_attendance(name): a player's attendance dates across the full LetsPoker
-- history (lp_entries × lp_events, ~2 years) plus recent TD sheets
-- (inbox_td_attendees), matched on a letters-only full name OR a tag-stripped
-- core name ("Chris Pavitt MCT" → "Chris Pavitt"). SECURITY DEFINER so the
-- browser (anon) can read it without exposing the RLS-protected lp_* tables
-- directly — it returns only dates/labels, no PII beyond what the CRM already has.
-- Powers the Home "Who's out" FIFO pattern explorer.
create or replace function public.player_attendance(p_name text)
returns table(d date, src text, label text)
language sql
stable
security definer
set search_path = public
as $$
  with k as (
    select
      regexp_replace(lower(coalesce(p_name,'')), '[^a-z]', '', 'g') as pf,
      regexp_replace(regexp_replace(lower(coalesce(p_name,'')),
        '\m(poker|holdem|cash|tourney|tournament|nlh|plo|mtt|mct|woodvale|kenwick|bentley|kingsley|leederville|leedy|stirling|adriatic|kwinana|southside|north|south|central|east|west|hotel|tavern|club|bowls|president|dealer|reserve|home|game|games|player)\M',
        ' ', 'g'), '[^a-z]', '', 'g') as pc
  )
  select e.event_date as d, 'LP'::text as src, e.event_name as label
  from lp_entries en
  join lp_events e on e.id = en.event_id
  cross join k
  where e.event_date is not null and length(k.pf) >= 4
    and regexp_replace(lower(coalesce(en.first_name,'') || coalesce(en.last_name,'')), '[^a-z]', '', 'g') in (k.pf, k.pc)
  union all
  select a.game_date as d, 'TD'::text as src, coalesce(a.venue, a.sheet_title) as label
  from inbox_td_attendees a
  cross join k
  where a.game_date is not null and length(k.pf) >= 4
    and regexp_replace(lower(coalesce(a.name,'')), '[^a-z]', '', 'g') in (k.pf, k.pc)
  order by d;
$$;

grant execute on function public.player_attendance(text) to anon, authenticated;
