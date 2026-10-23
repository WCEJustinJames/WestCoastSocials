-- Temporary hide flag — keep the record but drop it from the messaging lists
-- (recipient pickers, CRM). Distinct from do_not_message (a hard ban). Applies
-- to both inbox threads and CRM players.
alter table inbox_conversations add column if not exists hidden boolean not null default false;
alter table inbox_outreach add column if not exists hidden boolean not null default false;
