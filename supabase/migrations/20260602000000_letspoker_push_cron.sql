-- LetsPoker tournament push — scheduled cron (cookie stopgap).
--
-- Fires the `letspoker-push` edge function 6x/day on the Australia/Perth (UTC+8,
-- no DST) tournament schedule. The edge function does the actual GraphQL send,
-- response inspection, fail-loud alerting, and logging.
--
-- Perth  06:00 09:00 12:00 14:00 16:00 17:00
-- UTC    22:00 01:00 04:00 06:00 08:00 09:00   ->  cron: 0 1,4,6,8,9,22 * * *

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

-- Idempotent (re-running this migration replaces the schedule cleanly).
select cron.unschedule('letspoker-tournament-push')
where exists (select 1 from cron.job where jobname = 'letspoker-tournament-push');

-- The function URL and an auth token (the Supabase service_role key — a valid
-- JWT, so it passes the function's verify_jwt) live in Vault, NOT in this file:
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/letspoker-push', 'letspoker_push_function_url');
--   select vault.create_secret('<service_role_key>', 'letspoker_push_function_token');
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
