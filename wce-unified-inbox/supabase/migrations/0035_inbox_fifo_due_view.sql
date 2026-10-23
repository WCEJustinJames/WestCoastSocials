-- FIFO players due back: for each fifo-flagged player, infer their roster cadence
-- from full LP + TD attendance (avg away spell = gaps > 10 days) and project a
-- due-back date (last game + avg away). The Home "FIFO · due back" panel reads
-- this and surfaces anyone due around now, so a fly-in/out worker gets re-invited
-- the moment they're back in town. Includes the linked thread id for one-tap
-- re-invite. security_invoker = false so anon can read it without direct access
-- to the RLS-protected lp_* tables.
create or replace view public.inbox_fifo_due
with (security_invoker = false) as
with fifo as (
  select o.id, o.player_name, o.beeper_chat_id,
    regexp_replace(lower(coalesce(o.player_name,'')),'[^a-z]','','g') as pf,
    regexp_replace(regexp_replace(lower(coalesce(o.player_name,'')),
      '\m(poker|holdem|cash|tourney|tournament|nlh|plo|mtt|mct|woodvale|kenwick|bentley|kingsley|leederville|leedy|stirling|adriatic|kwinana|southside|north|south|central|east|west|hotel|tavern|club|bowls|president|dealer|reserve|home|game|games|player)\M',
      ' ', 'g'),'[^a-z]','','g') as pc
  from inbox_outreach o where o.fifo = true and coalesce(o.hidden, false) = false
),
att as (
  select f.id, e.event_date as gd from fifo f
    join lp_entries en on regexp_replace(lower(coalesce(en.first_name,'')||coalesce(en.last_name,'')),'[^a-z]','','g') in (f.pf,f.pc)
    join lp_events e on e.id = en.event_id where e.event_date is not null and length(f.pf) >= 4
  union
  select f.id, a.game_date from fifo f
    join inbox_td_attendees a on regexp_replace(lower(coalesce(a.name,'')),'[^a-z]','','g') in (f.pf,f.pc)
    where a.game_date is not null and length(f.pf) >= 4
),
g as (select id, gd, gd - lag(gd) over (partition by id order by gd) as gap from att),
agg as (
  select id, count(*) as games, max(gd) as last_game, round(avg(gap) filter (where gap > 10)) as avg_away
  from g group by id
)
select f.id as outreach_id, f.player_name, c.id as conversation_id,
  a.games, a.last_game, a.avg_away,
  (a.last_game + coalesce(a.avg_away, 30)::int) as due_around,
  (current_date - a.last_game) as away_days
from fifo f
join agg a on a.id = f.id
left join inbox_conversations c on c.external_chat_id = f.beeper_chat_id
where a.games >= 2;

grant select on public.inbox_fifo_due to anon, authenticated;
