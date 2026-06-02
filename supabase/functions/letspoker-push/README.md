# LetsPoker tournament push — scheduled cron (cookie stopgap)

Headless 6×/day fire of the captured LetsPoker admin GraphQL mutation
(`sendTournamentPushNotification`). **Interim** — LetsPoker is being replaced,
so this is deliberately lean. Auth is the admin **session cookie** (the fragile
bit; it expires).

LetsPoker renders `timeRelative` ("In 6 hours / 2 hours / 1 hour") **server-side
at send time**, so every fire is the *identical* call — no client time logic.

## Pieces

| File | Role |
|------|------|
| `supabase/functions/letspoker-push/index.ts` | Sends the mutation, inspects the response, **fail-loud alerts**, logs every fire. |
| `supabase/migrations/20260602000000_letspoker_push_cron.sql` | `pg_cron` schedule (6×/day) + `pg_net` call to the function + `letspoker_push_log` table. |

## Schedule — Australia/Perth (UTC+8, no DST)

| Perth | 06:00 | 09:00 | 12:00 | 14:00 | 16:00 | 17:00 |
|-------|-------|-------|-------|-------|-------|-------|
| UTC   | 22:00 (prev) | 01:00 | 04:00 | 06:00 | 08:00 | 09:00 |

Cron (UTC): `0 1,4,6,8,9,22 * * *`

## Secrets — set directly in Supabase, never through chat/code/git

Edge-function secrets (used by `index.ts`):

```bash
supabase secrets set \
  LETSPOKER_COOKIE='<full session cookie string from the captured cURL>' \
  LETSPOKER_SESSION_GROUPID='<x-session-groupid value from the cURL>' \
  LETSPOKER_CLUB_ID='8f025bf9ecfa14c8' \
  TOURNAMENT_EVENT_ID='e60cdde446fda1aa'   # tonight's event — UPDATE DAILY (see below)

# Fail-loud alert channel(s) — set at least one:
supabase secrets set RESEND_API_KEY='<resend key>' ALERT_EMAIL='justin.james@clubwestcoast.com.au'
# and/or a generic webhook (Beeper / SMS gateway / Slack):
supabase secrets set ALERT_WEBHOOK_URL='https://...'
# optional: supabase secrets set ALERT_FROM='letspoker-push@clubwestcoast.com.au'
```

> ⚠️ Verify the request body shape against your real **Copy as cURL**. The
> function sends the Apollo-batched `{"0": {...}}` wrapper described in the spec.
> If your capture shows a different shape (e.g. a top-level `[ {...} ]` array),
> adjust `batchedBody` in `index.ts` to match exactly.

## Deploy

```bash
# 1. Deploy the function
supabase functions deploy letspoker-push

# 2. Apply the migration (creates the log table + schedules the cron)
supabase db push

# 3. Tell the cron where the function is + how to auth, via Vault:
#    (run in the SQL editor / psql)
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/letspoker-push', 'letspoker_push_function_url');
select vault.create_secret('<service_role_key>', 'letspoker_push_function_token');
```

## Test SAFELY first — do not blast the live Kingsley event

Validate against the **Private** Deep Stack Freezeout (`1329992651d749ee`,
Private / 0 players). Override the event id per-request so you never touch the
live event:

```bash
curl -i -X POST 'https://<project-ref>.supabase.co/functions/v1/letspoker-push' \
  -H "Authorization: Bearer <service_role_key>" \
  -H "Content-Type: application/json" \
  -d '{"tournamentEventId":"1329992651d749ee"}'
```

Expect `{"ok":true,...}`. Then check the log:

```sql
select fired_at, source, tournament_event_id, http_status, ok, detail
from public.letspoker_push_log order by fired_at desc limit 10;
```

One fire per tick — **no auto-retry loops**.

## Fail-loud

A dead cookie fails **silently** (sends just stop). So the function alerts Justin
(email via Resend and/or `ALERT_WEBHOOK_URL`) whenever a fire is non-200 or the
GraphQL body looks `UNAUTHENTICATED`. Every fire is logged to
`public.letspoker_push_log` and to the function logs regardless.

## Daily upkeep & known limits (don't build yet)

- **`TOURNAMENT_EVENT_ID` is per-day** → update the secret each day:
  `supabase secrets set TOURNAMENT_EVENT_ID='<tonight's id>'`.
  Later: auto-resolve via the partner API's read-only `getEventList` (needs API
  access enabled by LetsPoker — separate request).
- **Cookie expiry** → manual refresh today; later add a headless-login step to
  mint a fresh cookie.

## Alternative host: Vercel Cron (not used here)

If you'd rather host on Vercel, the Hobby plan throttles cron frequency — 6×/day
likely needs **Pro**. Equivalent `vercel.json`:

```json
{ "crons": [{ "path": "/api/push", "schedule": "0 1,4,6,8,9,22 * * *" }] }
```

…with a serverless `/api/push` route porting the same logic from `index.ts`
(read secrets from Vercel env, POST the batched body, inspect, alert, log).
Supabase is the recommended host — it's already in the stack and has no cron
frequency cap.
