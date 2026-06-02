-- LetsPoker tournament push — scheduled cron (cookie stopgap).
--
-- Two recurring jobs call the `letspoker-push` edge function, which resolves
-- which game to push from public.tournament_events by Perth date:
--   - countdown (6x day-of)        -> today's game
--   - teaser    (night-before 9pm) -> tomorrow's game
-- No row for that date => no game => no-op.
--
-- Australia/Perth (UTC+8, no DST):
--   Day-of countdown  06:00 09:00 12:00 14:00 16:00 17:00  ->  UTC 0 1,4,6,8,9,22 * * *
--   Night-before 9pm  21:00                                ->  UTC 0 13       * * *

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Per-date game schedule. Populate one row per game night (event_date is the
-- Perth local date of the game). Later this can be auto-filled from the partner
-- API's getEventList; for now it's set per game.
create table if not exists public.tournament_events (
  event_date           date primary key,
  tournament_event_id  text not null,
  label                text,
  created_at           timestamptz not null default now()
);
comment on table public.tournament_events is
  'Per-date LetsPoker game schedule; the push function resolves event ids from here.';

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

-- The edge function reads/writes these via the service_role key (PostgREST).
grant usage on schema public to service_role;
grant select on table public.tournament_events to service_role;
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
where jobname in ('letspoker-tournament-push', 'letspoker-evening-teaser');

-- Day-of countdown (6x) -> today's game.
select cron.schedule(
  'letspoker-tournament-push',
  '0 1,4,6,8,9,22 * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'letspoker_push_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'letspoker_push_function_token')
    ),
    body := '{"mode":"countdown"}'::jsonb
  );
  $cron$
);

-- Night-before 9pm teaser (21:00 Perth = 13:00 UTC) -> tomorrow's game.
select cron.schedule(
  'letspoker-evening-teaser',
  '0 13 * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'letspoker_push_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'letspoker_push_function_token')
    ),
    body := '{"mode":"teaser"}'::jsonb
  );
  $cron$
);
