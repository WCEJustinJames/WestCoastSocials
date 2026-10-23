-- "Back on" date for a decline/maybe reply: when the player said they'd be free
-- to play again, resolved to a calendar date by the auto-reply classifier
-- (sync/notify.ts). Lets the Home "Who's out" panel flag players ready to
-- re-invite once the date passes.
alter table inbox_messages add column if not exists reply_back_on date;

-- Recreate inbox_player_context to carry back_on through from the latest reply.
create or replace view public.inbox_player_context
with (security_invoker = false) as
with ranked as (
  select
    m.conversation_id, m.text, m.reply_intent, m.reply_note, m.reply_back_on, m.timestamp,
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
  r.timestamp as replied_at,
  r.reply_back_on as back_on
from ranked r
join inbox_conversations c on c.id = r.conversation_id
left join inbox_people p on p.id = c.person_id
left join inbox_outreach o on o.beeper_chat_id = c.external_chat_id
where r.rn = 1 and r.reply_intent in ('no','maybe');

grant select on public.inbox_player_context to anon, authenticated;
