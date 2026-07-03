-- 0050_priority_contacts.sql
-- Priority contacts (staff/ops people whose messages must never be missed):
-- pinned with a star at the top of the Home action queue. Additive.
alter table public.inbox_outreach add column if not exists priority boolean not null default false;
