-- Persistent do-not-message / ban flag for CRM players. The Airtable sync never
-- includes this column in its upsert payload, so a flag set here survives every
-- re-sync. Batches exclude do_not_message = true.
alter table inbox_outreach add column if not exists do_not_message boolean not null default false;
