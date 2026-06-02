-- LetsPoker tournament push — scheduled cron (cookie stopgap), fully automated.
--
-- The letspoker-push edge function does the work in three modes:
--   sync      -> pull the LetsPoker calendar (getEventList) into tournament_events
--   countdown -> push every game scheduled today   (6x day-of)
--   teaser    -> push every game scheduled tomorrow (night-before 9pm)
--
-- A night can have several tournaments (different venues); each is its own row
-- and gets its own push. The sync keeps the table current, so the cycle repeats
-- with no manual input.
--
-- Australia/Perth (UTC+8, no DST):
--   Day-of countdown  06:00 09:00 12:00 14:00 16:00 17:00 -> UTC 0 1,4,6,8,9,22 * * *
--   Night-before 9pm  21:00                               -> UTC 0 13       * * *
--   Calendar sync     every 4h                            -> UTC 15 */4     * * *

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Per-tournament schedule, auto-populated by the sync. Keyed on the event id so
-- multiple games can share a date (event_date is the Perth local date).
create table if not exists public.tournament_events (
  tournament_event_id  text primary key,
  event_date           date not null,
  label                text,
  starts_at            timestamptz,
  synced_at            timestamptz,
  created_at           timestamptz not null default now()
);
create index if not exists tournament_events_event_date_idx on public.tournament_events (event_date);
comment on table public.tournament_events is
  'Per-tournament LetsPoker schedule; auto-filled by the push function''s sync mode.';

-- Audit log of every fire.
create table if not exists public.letspoker_push_log (
  id                   bigint generated always as identity primary key,
  fired_at             timestamptz not null default now(),
  source               text        not null default 'cron',
  tournament_event_id  text,
  http_status          int,
  ok                   boolean,
  detail               text
);
comment on table public.letspoker_push_log is
  'Audit log of LetsPoker tournament push fires (cookie-stopgap cron).';

-- The edge function reads/writes these via the service_role key (PostgREST).
grant usage on schema public to service_role;
grant select, insert, update on table public.tournament_events to service_role;
grant select, insert on table public.letspoker_push_log to service_role;
grant usage, select on sequence public.letspoker_push_log_id_seq to service_role;
notify pgrst, 'reload schema';

-- The function URL and a project JWT (anon/publishable key passes verify_jwt)
-- live in Vault, NOT in this file:
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/letspoker-push', 'letspoker_push_function_url');
--   select vault.create_secret('<anon_key>', 'letspoker_push_function_token');

-- Idempotent: drop existing jobs before (re)creating.
select cron.unschedule(jobname)
from cron.job
where jobname in ('letspoker-tournament-push', 'letspoker-evening-teaser', 'letspoker-calendar-sync');

-- Helper note: each job POSTs the function URL with the mode in the body.
-- countdown (6x day-of):
select cron.schedule(
  'letspoker-tournament-push',
  '0 1,4,6,8,9,22 * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'letspoker_push_function_url'),
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'letspoker_push_function_token')),
    body := '{"mode":"countdown"}'::jsonb
  );
  $cron$
);

-- teaser (night-before 9pm):
select cron.schedule(
  'letspoker-evening-teaser',
  '0 13 * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'letspoker_push_function_url'),
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'letspoker_push_function_token')),
    body := '{"mode":"teaser"}'::jsonb
  );
  $cron$
);

-- calendar sync (every 4h):
select cron.schedule(
  'letspoker-calendar-sync',
  '15 */4 * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'letspoker_push_function_url'),
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'letspoker_push_function_token')),
    body := '{"mode":"sync"}'::jsonb
  );
  $cron$
);
