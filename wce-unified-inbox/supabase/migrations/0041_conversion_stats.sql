-- 0041_conversion_stats.sql
-- Roadmap #8: per-batch conversion analytics. For each batch, count sent recipients
-- and attribute each one's first classified inbound reply within 7 days (matched via
-- the player's linked Beeper thread). Approximate attribution (a reply is tied to the
-- most recent prior batch's window), good enough to compare wording/venues. READ-ONLY view.
create or replace view public.inbox_batch_conversion as
with sent as (
  select bi.batch_id, (bi.data->>'outreach_id')::uuid as outreach_id
  from public.inbox_batch_items bi
  where bi.status = 'sent'
    and bi.data->>'outreach_id' ~ '^[0-9a-fA-F-]{36}$'
),
attrib as (
  select s.batch_id,
    (select m.reply_intent
     from public.inbox_messages m
     join public.inbox_conversations c on c.id = m.conversation_id
     where m.direction = 'inbound' and m.reply_intent is not null
       and o.beeper_chat_id is not null
       and c.external_chat_id = o.beeper_chat_id
       and m.timestamp >= b.created_at
       and m.timestamp <= b.created_at + interval '7 days'
     order by m.timestamp asc limit 1) as intent
  from sent s
  join public.inbox_batches b on b.id = s.batch_id
  join public.inbox_outreach o on o.id = s.outreach_id
)
select b.id as batch_id, b.name, b.venue, b.created_at,
  count(a.*) as sent,
  count(a.intent) as replied,
  count(*) filter (where a.intent = 'yes') as yes,
  count(*) filter (where a.intent = 'no') as no,
  count(*) filter (where a.intent = 'maybe') as maybe
from public.inbox_batches b
join attrib a on a.batch_id = b.id
group by b.id, b.name, b.venue, b.created_at;

grant select on public.inbox_batch_conversion to anon, authenticated;
