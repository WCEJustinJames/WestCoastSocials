-- FIFO flag (fly-in/fly-out worker) on a player, and a per-thread "resolved"
-- timestamp so a "Who's out" entry can be dismissed for good (until they reply
-- again). inbox_player_context now excludes resolved threads and carries fifo.
alter table inbox_outreach add column if not exists fifo boolean not null default false;
alter table inbox_conversations add column if not exists context_resolved_at timestamptz;

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
  o.notes as note
from ranked r
join inbox_conversations c on c.id = r.conversation_id
left join inbox_people p on p.id = c.person_id
left join inbox_outreach o on o.beeper_chat_id = c.external_chat_id
where r.rn = 1 and r.reply_intent in ('no','maybe')
  and (c.context_resolved_at is null or c.context_resolved_at < r.timestamp);

grant select on public.inbox_player_context to anon, authenticated;
