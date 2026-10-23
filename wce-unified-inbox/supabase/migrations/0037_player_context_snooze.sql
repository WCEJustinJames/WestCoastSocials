-- Carry snooze_until through inbox_player_context so the "Who's out" panel can
-- shade on-ice players and show "on ice until <date>" — and so on-ice / add-to-
-- list actions apply in place (visible) instead of dismissing the row, leaving
-- "✓ resolved" as the only thing that removes an entry.
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
  r.reply_back_on as back_on,
  coalesce(o.fifo, false) as fifo,
  o.notes as note,
  o.snooze_until as snooze_until
from ranked r
join inbox_conversations c on c.id = r.conversation_id
left join inbox_people p on p.id = c.person_id
left join inbox_outreach o on o.beeper_chat_id = c.external_chat_id
where r.rn = 1 and r.reply_intent in ('no','maybe')
  and (c.context_resolved_at is null or c.context_resolved_at < r.timestamp);

grant select on public.inbox_player_context to anon, authenticated;
