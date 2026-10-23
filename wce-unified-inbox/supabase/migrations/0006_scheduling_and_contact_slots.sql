-- Scheduled batch sends + per-player weekly contact slot and frequency cap.
alter table inbox_batches add column if not exists scheduled_for timestamptz;
alter table inbox_outreach add column if not exists contact_day text;        -- Mon..Sun
alter table inbox_outreach add column if not exists contact_window text;     -- Morning/Afternoon/Evening
alter table inbox_outreach add column if not exists contact_frequency_days integer; -- min days between contacts
create index if not exists inbox_batches_sched_idx on inbox_batches (status, scheduled_for);
alter table inbox_outreach add column if not exists rapport integer;
