# LetsPoker tournament push — automated cron (cookie stopgap)

Headless, start-to-finish automation of the captured LetsPoker admin push
(`sendTournamentPushNotification`). **Interim** — LetsPoker is being replaced.
Auth is the admin **session cookie** (the one fragile bit; it expires).

LetsPoker renders `timeRelative` server-side at send time, so every fire is the
identical call.

## How it runs itself

1. **Sync** (every 4h) pulls the LetsPoker calendar (`getEventList`) and upserts
   every upcoming tournament into `public.tournament_events`, keyed by event id
   (a night can have several games at different venues — each is its own row).
2. **Countdown** (6× day-of) pushes **every** game scheduled today.
3. **Teaser** (night-before 9pm) pushes **every** game scheduled tomorrow.

No manual event-id entry — the calendar feeds itself. If there's a game, it's
pushed; if a night has none, the fire no-ops.

## Pieces

| File | Role |
|------|------|
| `supabase/functions/letspoker-push/index.ts` | Modes: `sync`, `countdown`, `teaser`, plus a `tournamentEventId` override and `dryRun`. Resolves games from `tournament_events`, sends, inspects, **fail-loud alerts**, logs. |
| `supabase/migrations/20260602000000_letspoker_push_cron.sql` | `tournament_events` + `letspoker_push_log` tables, grants, and the three pg_cron jobs. |

## Schedule — Australia/Perth (UTC+8, no DST)

| Job | mode | Perth | UTC cron |
|-----|------|-------|----------|
| `letspoker-tournament-push` | countdown | 06:00 / 09:00 / 12:00 / 14:00 / 16:00 / 17:00 | `0 1,4,6,8,9,22 * * *` |
| `letspoker-evening-teaser` | teaser | 21:00 | `0 13 * * *` |
| `letspoker-calendar-sync` | sync | every 4h | `15 */4 * * *` |

## Secret — set directly in Supabase, never through chat/code/git

Only the cookie is a secret (session-groupid `wcp` and the club id are constants
defaulted in code; event ids come from the calendar sync):

```bash
supabase secrets set LETSPOKER_COOKIE='<full Cookie header from the captured cURL>'
# Fail-loud alert channel — set at least one so a dead cookie pings you:
supabase secrets set RESEND_API_KEY='<key>' ALERT_EMAIL='justin.james@clubwestcoast.com.au'
#   and/or:  supabase secrets set ALERT_WEBHOOK_URL='https://...'
```

Set it in the dashboard: **Project Settings → Edge Functions → Secrets**.

## Test SAFELY — only ever the override

`countdown`/`teaser` push the **live** games, so never trigger them by hand. To
test sending, use the explicit override (and pick a private/0-player event):

```bash
curl -X POST 'https://<ref>.supabase.co/functions/v1/letspoker-push' \
  -H "Authorization: Bearer <anon_or_service_key>" -H "Content-Type: application/json" \
  -d '{"tournamentEventId":"<private event id>"}'
```

Inspect the calendar without sending or writing:
`-d '{"mode":"sync","dryRun":true}'`. Check fires:

```sql
select fired_at, source, tournament_event_id, http_status, ok, detail
from public.letspoker_push_log order by fired_at desc limit 20;
select event_date, tournament_event_id, label from public.tournament_events
where event_date >= current_date order by event_date, starts_at;
```

## Fail-loud

A dead cookie fails silently. The function alerts Justin (Resend email and/or
`ALERT_WEBHOOK_URL`) on any non-200 / `UNAUTHENTICATED`, and logs every fire.

## Known limits / next hardening

- **Cookie expiry** → manual refresh today; next: headless login to mint a fresh
  cookie automatically (so even the cookie is hands-off).
- **Event filtering** → currently pushes every tournament the calendar lists. If
  some listed events should be skipped, add an `exclude` set or a venue filter.
