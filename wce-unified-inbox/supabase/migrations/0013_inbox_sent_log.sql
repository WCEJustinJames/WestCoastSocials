-- WCE Unified Inbox — per-send audit ledger.
-- Records every outbound send (recipient, message-hash, when) so there is a
-- reliable "what did we send whom" trail, and so proactive-outreach sends can be
-- made idempotent (never fire the identical invite to the same recipient twice,
-- even across a restart). Additive; permissive RLS to match the other inbox_
-- tables. Applied to project "WCE App" (dexdftcmcixppbuucjfd).

create table if not exists inbox_sent_log (
  id uuid primary key default gen_random_uuid(),
  outreach_id uuid,
  recipient text not null,     -- normalized phone or chat id
  text_hash text not null,     -- short hash of the normalized message body
  batch_item_id uuid,
  rendered_text text,
  sent_at timestamptz not null default now()
);
create index if not exists inbox_sent_log_recipient_idx on inbox_sent_log (recipient, sent_at desc);
create index if not exists inbox_sent_log_hash_idx on inbox_sent_log (recipient, text_hash, sent_at desc);

alter table inbox_sent_log enable row level security;
drop policy if exists inbox_sent_log_all on inbox_sent_log;
create policy inbox_sent_log_all on inbox_sent_log for all using (true) with check (true);
grant select, insert, update, delete on inbox_sent_log to anon, authenticated, service_role;
