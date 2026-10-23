-- 0047_batch_approved_at.sql
-- Outreach-cutoff grandfathering: record when a batch was approved so the send rail
-- can keep draining a batch approved inside the 10:00-16:30 window even after the
-- cutoff passes (quiet hours remain the hard stop). Additive.
alter table public.inbox_batches add column if not exists approved_at timestamptz;
