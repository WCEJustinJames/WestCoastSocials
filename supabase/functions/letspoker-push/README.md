# LetsPoker tournament push — scheduled cron (cookie stopgap)

Fully-automated, headless fire of the captured LetsPoker admin GraphQL mutation
(`sendTournamentPushNotification`). **Interim** — LetsPoker is being replaced, so
this is deliberately lean. Auth is the admin **session cookie** (the fragile bit;
it expires).

LetsPoker renders `timeRelative` ("In 6 hours / 2 hours / 1 hour") **server-side
at send time**, so every fire is the *identical* call — no client time logic.

## Pieces

| File | Role |
|------|------|
| `supabase/functions/letspoker-push/index.ts` | Resolves the game from `tournament_events`, sends the mutation, inspects the response, **fail-loud alerts**, logs every fire. |
| `supabase/migrations/20260602000000_letspoker_push_cron.sql` | `tournament_events` + `letspoker_push_log` tables, `pg_cron`/`pg_net`, and the two scheduled jobs. |

## How a game gets pushed

One row per game night in `public.tournament_events` (`event_date` = the **Perth
local date** of the game). The function resolves which game to push by date:

- **countdown** fires (day-of) → **today's** row
- **teaser** fire (night-before 9pm) → **tomorrow's** row
- no row for that date → **no game → no-op** (logged, not an error, no alert)

```sql
insert into public.tournament_events (event_date, tournament_event_id, label)
values (date '2026-06-03', '<event id>', 'Kingsley');
```

This is the only per-day task (replaces juggling an env var). Later it can be
auto-filled from the partner API's read-only `getEventList`.

## Schedule — Australia/Perth (UTC+8, no DST)

| Job | mode | Perth | UTC cron |
|-----|------|-------|----------|
| `letspoker-tournament-push` | countdown ×6 | 06:00 / 09:00 / 12:00 / 14:00 / 16:00 / 17:00 | `0 1,4,6,8,9,22 * * *` |
| `letspoker-evening-teaser` | teaser | 21:00 | `0 13 * * *` |

## Secrets — set directly in Supabase, never through chat/code/git

Only the auth bits are secrets (event ids live in `tournament_events`, not here):

```bash
supabase secrets set \
  LETSPOKER_COOKIE='<full Cookie header from the captured cURL>' \
  LETSPOKER_SESSION_GROUPID='<x-session-groupid value from the cURL>' \
  LETSPOKER_CLUB_ID='8f025bf9ecfa14c8'

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

## Deploy (already done on the WCE App project)

```bash
supabase functions deploy letspoker-push
supabase db push
# Vault (cron -> function auth): function URL + a project JWT (anon key is enough):
#   select vault.create_secret('https://<ref>.supabase.co/functions/v1/letspoker-push', 'letspoker_push_function_url');
#   select vault.create_secret('<anon_key>', 'letspoker_push_function_token');
```

## Test SAFELY — only ever the Private event

`countdown`/`teaser` modes resolve the **live** game, so never trigger them by
hand. To test, use the explicit override against the **Private** Deep Stack
Freezeout (`1329992651d749ee`, 0 players):

```bash
curl -i -X POST 'https://<ref>.supabase.co/functions/v1/letspoker-push' \
  -H "Authorization: Bearer <anon_or_service_key>" \
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
(email via Resend and/or `ALERT_WEBHOOK_URL`) whenever a real fire is non-200 or
the GraphQL body looks `UNAUTHENTICATED`. Every fire is logged to
`public.letspoker_push_log` and to the function logs regardless. (A no-game skip
is logged `ok=true` and does **not** alert.)

## Known limits / next hardening (don't build yet)

- **`tournament_events` is filled per game** → auto-resolve later via the partner
  API's read-only `getEventList` (needs API access enabled by LetsPoker —
  separate request).
- **Cookie expiry** → manual refresh today; later add a headless-login step to
  mint a fresh cookie.

## Alternative host: Vercel Cron (not used here)

If you'd rather host on Vercel, the Hobby plan throttles cron frequency — 6×/day
likely needs **Pro**. Equivalent `vercel.json`:

```json
{ "crons": [
  { "path": "/api/push?mode=countdown", "schedule": "0 1,4,6,8,9,22 * * *" },
  { "path": "/api/push?mode=teaser",    "schedule": "0 13 * * *" }
] }
```

…with a serverless `/api/push` route porting the same logic from `index.ts`.
Supabase is the recommended host — it's already in the stack and has no cron
frequency cap.
