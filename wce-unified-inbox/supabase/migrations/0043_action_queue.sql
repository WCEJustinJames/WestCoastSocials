-- 0043_action_queue.sql
-- Roadmap #4: Home action queue. Durable resolve flag for 'needs-you' (reply_intent
-- = 'other') replies so dismissing one survives a refresh / other device. Additive.
alter table public.inbox_messages add column if not exists action_resolved boolean not null default false;
create index if not exists inbox_messages_needsyou_idx
  on public.inbox_messages (action_resolved, reply_intent)
  where reply_intent is not null;
