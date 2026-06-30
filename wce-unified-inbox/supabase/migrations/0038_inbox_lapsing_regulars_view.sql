-- "Win-back" panel data: players who used to play LetsPoker regularly and have
-- gone quiet. Unlike lp_churn (which compares fixed calendar halves and so goes
-- stale once the current half closes), this computes a ROLLING window from
-- lp_entries so it stays current every day:
--   baseline = games in the 90-270-day window (the prior ~6 months)
--   recent   = games in the last 90 days
-- A "lapsing regular" was a regular across the baseline (>= 3 games) but has
-- nearly stopped (recent <= 1) and hasn't been seen for 30+ days.
--
-- Name matching mirrors inbox_fifo_due: the CRM player_name is normalised to
-- lower/alpha-only both as-is (pf) and with poker/venue noise stripped (pc), and
-- compared to the LP name. lp_churn supplies the clean LP identity + rich stats
-- (prominent night/venue, winnings, lifetime entries); the rolling counts come
-- from lp_entries keyed on player_id, so that join is exact (no name drift).
--
-- Only reachable, actionable contacts surface: a phone or thread, and not
-- staff / banned / hidden / FIFO / on-ice, and not already contacted in the last
-- 21 days. So every row is someone worth a personal re-invite right now.
--
-- security_invoker stays OFF (definer's rights) so the anon UI can read this
-- through the RLS-protected lp_* analytics tables, same as the other inbox views.

CREATE OR REPLACE VIEW public.inbox_lapsing_regulars
WITH (security_invoker = false) AS
WITH cand AS (
  SELECT o.id, o.player_name, o.beeper_chat_id, o.phone,
         regexp_replace(lower(COALESCE(o.player_name, '')), '[^a-z]', '', 'g') AS pf,
         regexp_replace(regexp_replace(lower(COALESCE(o.player_name, '')),
           '\m(poker|holdem|cash|tourney|tournament|nlh|plo|mtt|mct|woodvale|kenwick|bentley|kingsley|leederville|leedy|stirling|adriatic|kwinana|southside|north|south|central|east|west|hotel|tavern|club|bowls|president|dealer|reserve|home|game|games|player)\M',
           ' ', 'g'), '[^a-z]', '', 'g') AS pc
  FROM inbox_outreach o
  WHERE COALESCE(o.hidden, false) = false
    AND COALESCE(o.do_not_message, false) = false
    AND COALESCE(o.staff, false) = false
    AND COALESCE(o.fifo, false) = false
    AND (o.phone IS NOT NULL OR o.beeper_chat_id IS NOT NULL)
    AND (o.snooze_until IS NULL OR o.snooze_until <= CURRENT_DATE)
    AND (o.last_contacted IS NULL OR o.last_contacted < (now() - interval '21 days'))
),
matched AS (
  SELECT DISTINCT ON (c.id)
         c.id AS outreach_id, c.player_name, c.beeper_chat_id, c.phone,
         ch.player_id, ch.prominent_night, ch.prominent_venue, ch.favourite_event,
         ch.total_winnings, ch.lifetime_entries, ch.last_seen
  FROM cand c
  JOIN lp_churn ch ON length(c.pf) >= 4
    AND (regexp_replace(lower(ch.full_name), '[^a-z]', '', 'g') = c.pf
      OR regexp_replace(lower(ch.full_name), '[^a-z]', '', 'g') = c.pc)
  ORDER BY c.id, ch.lifetime_entries DESC
),
roll AS (
  SELECT m.outreach_id,
    count(*) FILTER (WHERE e.event_date >= CURRENT_DATE - 90) AS recent_games,
    count(*) FILTER (WHERE e.event_date >= CURRENT_DATE - 270
                       AND e.event_date <  CURRENT_DATE - 90) AS baseline_games
  FROM matched m
  JOIN lp_entries en ON en.player_id = m.player_id
  JOIN lp_events e ON e.id = en.event_id AND e.event_date IS NOT NULL
  GROUP BY m.outreach_id
)
SELECT m.outreach_id,
       m.player_name,
       cv.id AS conversation_id,
       m.phone,
       m.beeper_chat_id,
       m.last_seen,
       (CURRENT_DATE - m.last_seen) AS days_since_last,
       r.baseline_games,
       r.recent_games,
       m.prominent_night,
       m.prominent_venue,
       m.favourite_event,
       m.total_winnings,
       m.lifetime_entries
FROM matched m
JOIN roll r ON r.outreach_id = m.outreach_id
LEFT JOIN inbox_conversations cv ON cv.external_chat_id = m.beeper_chat_id
WHERE r.baseline_games >= 3
  AND r.recent_games <= 1
  AND (CURRENT_DATE - m.last_seen) >= 30
ORDER BY r.baseline_games DESC, m.last_seen DESC;

GRANT SELECT ON public.inbox_lapsing_regulars TO anon, authenticated;
