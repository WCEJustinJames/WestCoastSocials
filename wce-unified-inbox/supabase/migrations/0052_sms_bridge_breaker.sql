-- 0052_sms_bridge_breaker.sql
-- Google Messages bridge circuit-breaker: when SMS sends fail repeatedly the sync
-- trips this flag, holds further SMS items (instead of burning them to 'failed'),
-- probes with one canary per pass, and the UI shows a red banner. Additive.
alter table public.inbox_settings add column if not exists sms_bridge_down boolean not null default false;
alter table public.inbox_settings add column if not exists sms_bridge_since timestamptz;
-- The bridge is known-down right now (19 straight SMS failures today) — start tripped.
update public.inbox_settings set sms_bridge_down = true, sms_bridge_since = now() where id = 1;
