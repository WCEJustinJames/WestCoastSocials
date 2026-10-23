-- 0042_whale.sql
-- Roadmap #5: whale (priority customer) flag. Manual, mirrors the fifo flag. Additive.
alter table public.inbox_outreach add column if not exists whale boolean not null default false;
