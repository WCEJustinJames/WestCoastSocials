-- LetsPoker push — tick scheduler cutover.
--
-- Replaces the 6 fixed-time countdown fires + the night-before teaser with a
-- single 30-minute "tick". The edge function computes each game's own fire
-- instants (teaser + countdown + in-event) and sends any slot due in the
-- current 30-min bucket exactly once (claimed in letspoker_fired).
--
-- Per-game schedule (auto-bucketed by Perth start time; <=14:00 -> daytime):
--   Evening (6/6:30pm starts)   countdown 06 09 12 15 17 18   + in-event +30..+150
--   Daytime (11:30am-1pm starts) countdown 06 09 10 11 12 12:30 + in-event +30..+150
--   Teaser (both)               20:30 the night before
-- Countdown fires at/after start are dropped (in-event covers those instants).
--
-- The tick cron MUST run on :00/:30 so every fire instant lands in a bucket.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- One row per (event, slot) that has fired — the function's idempotency guard.
create table if not exists public.letspoker_fired (
  event_id   text not null,
  slot       text not null,
  fired_at   timestamptz not null default now(),
  primary key (event_id, slot)
);
comment on table public.letspoker_fired is
  'Idempotency guard for the tick scheduler: one row per (event_id, slot) sent, '
  'so a 30-minute tick never double-sends. A failed send releases its row to retry.';

grant select, insert, delete on table public.letspoker_fired to service_role;
notify pgrst, 'reload schema';

-- Retire the legacy fixed-time push jobs (calendar-sync stays as-is).
select cron.unschedule(jobname)
from cron.job
where jobname in ('letspoker-tournament-push', 'letspoker-evening-teaser', 'letspoker-tick');

-- The 30-minute tick. Must align to :00/:30 so fire instants hit a bucket.
select cron.schedule(
  'letspoker-tick',
  '0,30 * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'letspoker_push_function_url'),
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'letspoker_push_function_token')),
    body := '{"mode":"tick"}'::jsonb
  );
  $cron$
);
