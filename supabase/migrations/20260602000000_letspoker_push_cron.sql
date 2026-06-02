-- LetsPoker tournament push — scheduled cron (cookie stopgap).
--
-- Two recurring jobs, both calling the `letspoker-push` edge function (which does
-- the GraphQL send, response inspection, fail-loud alerting, and logging). Both
-- fire the SAME mutation using the current TOURNAMENT_EVENT_ID env var, so the
-- workflow is: by each evening, set TOURNAMENT_EVENT_ID to the NEXT game's id —
-- that id then serves tonight's 9pm teaser and tomorrow's day-of countdown.
--
-- Australia/Perth (UTC+8, no DST):
--   Day-of countdown  06:00 09:00 12:00 14:00 16:00 17:00  ->  UTC 0 1,4,6,8,9,22 * * *
--   Night-before 9pm  21:00                                ->  UTC 0 13       * * *

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Fire log (the edge function inserts a row per fire; queryable history).
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

-- The function URL and an auth token (a project JWT — the anon/publishable key is
-- enough to pass the function's verify_jwt) live in Vault, NOT in this file:
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/letspoker-push', 'letspoker_push_function_url');
--   select vault.create_secret('<anon_key>', 'letspoker_push_function_token');

-- Idempotent: drop existing jobs before (re)creating.
select cron.unschedule(jobname)
from cron.job
where jobname in ('letspoker-tournament-push', 'letspoker-evening-teaser');

-- Day-of countdown (6x).
select cron.schedule(
  'letspoker-tournament-push',
  '0 1,4,6,8,9,22 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets
            where name = 'letspoker_push_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                     where name = 'letspoker_push_function_token')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Night-before 9pm teaser for the next game.
select cron.schedule(
  'letspoker-evening-teaser',
  '0 13 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets
            where name = 'letspoker_push_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                     where name = 'letspoker_push_function_token')
    ),
    body := '{}'::jsonb
  );
  $$
);
