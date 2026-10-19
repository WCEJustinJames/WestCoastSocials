-- PROPOSED for the westcoast-poker repo (supabase/migrations). Not applied.
-- The upgraded engine (src/sync/smsEngine.ts) needs it before its first run.
--
-- Park an accepted send on the item (ENG-27): Beeper's 2xx on a post is
-- acceptance, not delivery, so the engine records the pending message id and
-- the chat it went to straight after the 2xx, then reads it back, now or on a
-- later pass. A parked item stays 'sending' and is RESOLVED, never reposted.
-- Engine-owned columns, so the hub's data jsonb is never rewritten (ENG-09).
--
-- park, dismiss and the expiry tick already leave 'sending' rows alone, so
-- nothing else needs to change for a parked item.

alter table public.inbox_batch_items
  add column if not exists pending_message_id text check (pending_message_id is null or length(pending_message_id) <= 200),
  add column if not exists pending_chat_id    text check (pending_chat_id is null or length(pending_chat_id) <= 200),
  add column if not exists park_checks        int not null default 0 check (park_checks between 0 and 100),
  add column if not exists park_checked_at    timestamptz;

comment on column public.inbox_batch_items.pending_message_id is
  'Engine: Beeper pendingMessageID of an accepted send still being confirmed. Set on a sending item only; cleared only by the bridge''s own FAIL verdict.';
comment on column public.inbox_batch_items.pending_chat_id is
  'Engine: the chat the parked send went to.';
comment on column public.inbox_batch_items.park_checks is
  'Engine: read-backs made on a parked send (at most 10, then left for a person).';
comment on column public.inbox_batch_items.park_checked_at is
  'Engine: when the parked send was last read back; the re-check backoff (1 to 5 minutes) is measured from it.';

-- The park query reads sending rows with a pending id.
create index if not exists inbox_batch_items_parked_idx
  on public.inbox_batch_items (park_checked_at)
  where status = 'sending' and pending_message_id is not null;
