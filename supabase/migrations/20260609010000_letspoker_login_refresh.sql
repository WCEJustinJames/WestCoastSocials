-- LetsPoker headless auto-login — scheduled cookie refresh.
--
-- The edge function's "login" mode signs in with LETSPOKER_USERNAME (namespaced,
-- e.g. "wcp:Claude") + LETSPOKER_PASSWORD + a TOTP code generated in-function from
-- LETSPOKER_TOTP_SECRET, then stores the fresh session cookie in letspoker_auth.
-- getCookie() prefers that cookie, so every push/sync runs on auto-refreshed auth
-- and the manual LETSPOKER_COOKIE is only a fallback.
--
-- Runs twice daily so the stored cookie is never more than ~12h old. On failure
-- the function leaves the existing cookie intact and alerts (fail-safe).
--   00:00 / 12:00 UTC  ->  08:00 / 20:00 Australia/Perth

select cron.unschedule(jobname)
from cron.job
where jobname in ('letspoker-login');

select cron.schedule(
  'letspoker-login',
  '0 0,12 * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'letspoker_push_function_url'),
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'letspoker_push_function_token')),
    body := '{"mode":"login"}'::jsonb
  );
  $cron$
);
