-- OPERATIONAL (shared "WCE App" Supabase project) — applied live, recorded here.
--
-- The LetsPoker attendance history (lp_events / lp_entries) is populated by the
-- letspoker-harvest edge function, which was only ever run as a manual monthly
-- sweep — so attendance silently froze at the last run (2026-06-09) while the
-- (healthy, auto-refreshing) cookie and the other LP crons kept working. That
-- stale history fed the inbox's FIFO / last-seen / attendance features.
--
-- This schedules the harvest daily (18:00 UTC ≈ 02:00 Perth, after games finish)
-- over a rolling 14-day window — idempotent (merge-duplicates), and wide enough
-- to catch late-posted results — so lp_entries stays current going forward.
-- Reuses the existing vault function URL + invoke token (deriving the harvest URL
-- from the push one). cron.schedule upserts by name, so this is safe to re-run.
select cron.schedule('letspoker-harvest', '0 18 * * *', $job$
  select net.http_post(
    url := replace((select decrypted_secret from vault.decrypted_secrets where name='letspoker_push_function_url'), 'letspoker-push', 'letspoker-harvest'),
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='letspoker_push_function_token')
    ),
    body := jsonb_build_object(
      'start', (current_date - 14)::text || 'T00:00:00.000Z',
      'end',   (current_date + 1)::text || 'T00:00:00.000Z'
    ),
    timeout_milliseconds := 120000
  );
$job$);
