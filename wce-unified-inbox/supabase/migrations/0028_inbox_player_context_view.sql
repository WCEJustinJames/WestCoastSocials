-- Player context for the Home dashboard: players whose most recent classified
-- reply was a decline / maybe, surfaced with the reason and any "back when" they
-- gave — so Justin knows who's out and when to re-invite. Anyone whose latest
-- reply is a "yes" is excluded (they're around again).
--
-- The auto-reply classifier (sync/notify.ts) already tags each inbound reply with
-- reply_intent (yes/no/maybe) + a short reply_note; this view just rolls that up
-- to one row per thread. security_invoker = false so the browser's anon role can
-- read it (matches the other inbox_* views).
create or replace view public.inbox_player_context
with (security_invoker = false) as
with ranked as (
  select
    m.conversation_id, m.text, m.reply_intent, m.reply_note, m.timestamp,
    row_number() over (partition by m.conversation_id order by m.timestamp desc) as rn
  from inbox_messages m
  where m.direction = 'inbound' and m.reply_intent in ('yes','no','maybe')
)
select
  r.conversation_id,
  coalesce(nullif(btrim(o.player_name),''), nullif(btrim(p.display_name),''),
           nullif(btrim(c.title),''), 'Unknown') as player_name,
  o.id as outreach_id,
  r.reply_intent,
  r.reply_note,
  r.text as reply_text,
  r.timestamp as replied_at
from ranked r
join inbox_conversations c on c.id = r.conversation_id
left join inbox_people p on p.id = c.person_id
left join inbox_outreach o on o.beeper_chat_id = c.external_chat_id
where r.rn = 1 and r.reply_intent in ('no','maybe');

grant select on public.inbox_player_context to anon, authenticated;
