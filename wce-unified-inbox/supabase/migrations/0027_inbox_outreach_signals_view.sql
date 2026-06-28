-- Per-player send signals for the batch recipient picker: when each player was
-- last messaged (and for which venue), plus how many outreach messages they've
-- had with no reply since — which drives the 👻 "ghost" marker in the UI.
--
-- One row per CRM player (left joins, so players never messaged still appear with
-- nulls / 0). security_invoker = false so the browser's anon role reads through it
-- regardless of the underlying tables' RLS (matches inbox_recent_contacts).
create or replace view public.inbox_outreach_signals
with (security_invoker = false) as
with last_reply as (
  -- newest inbound (their reply) per thread, keyed by the Beeper room id
  select c.external_chat_id, max(m.timestamp) as ts
  from inbox_messages m
  join inbox_conversations c on c.id = m.conversation_id
  where m.direction = 'inbound'
  group by c.external_chat_id
),
sends as (
  select l.outreach_id, l.sent_at, l.batch_item_id
  from inbox_sent_log l
  where l.outreach_id is not null
),
last_send as (
  -- most recent send per player, with the venue of the batch it belonged to
  select distinct on (s.outreach_id) s.outreach_id, s.sent_at, b.venue
  from sends s
  left join inbox_batch_items bi on bi.id = s.batch_item_id
  left join inbox_batches b on b.id = bi.batch_id
  order by s.outreach_id, s.sent_at desc
),
unanswered as (
  -- count of sends to this player since their last reply (0 if they replied since
  -- the most recent send; never-replied players count every send)
  select s.outreach_id, count(*) as n
  from sends s
  join inbox_outreach o on o.id = s.outreach_id
  left join last_reply lr on lr.external_chat_id = o.beeper_chat_id
  where s.sent_at > coalesce(lr.ts, '1970-01-01')
  group by s.outreach_id
)
select
  o.id as outreach_id,
  ls.sent_at as last_sent_at,
  ls.venue as last_venue,
  coalesce(u.n, 0) as unanswered_outreach
from inbox_outreach o
left join last_send ls on ls.outreach_id = o.id
left join unanswered u on u.outreach_id = o.id;

grant select on public.inbox_outreach_signals to anon, authenticated;
