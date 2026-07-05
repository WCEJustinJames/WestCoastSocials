-- Cash push targets a specific table within a per-day cash event. Store the
-- event id and the table ids (from the LP cash-control runtime / a captured
-- request) so the push step can fan out per table.
alter table public.cash_plan
  add column if not exists push_event_id text,
  add column if not exists table_ids jsonb not null default '[]'::jsonb;

comment on column public.cash_plan.push_event_id is
  'LP cash event id (the "cash-games for <date>" container) used as tournamentEventId in sendCashPushNotification.';
comment on column public.cash_plan.table_ids is
  'Array of {id,name} cash tables for this event, used as tableId in sendCashPushNotification.';
