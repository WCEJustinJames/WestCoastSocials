# letspoker-schedule — deploy

Source of the `letspoker-schedule` Supabase edge function: **recurring LetsPoker
events** — it fills the club's regular weekly games on the live LetsPoker
calendar for the rest of the month.

It belongs to the `wce-unified-inbox` app (alongside `letspoker-push` and
`letspoker-cash`) and reuses their conventions: the shared session cookie from
`letspoker_auth`, the constant `LETSPOKER_CLUB_ID` / `LETSPOKER_SESSION_GROUPID`,
`cash_open_log` for audit (source `"schedule"`), and `alertJustin` for fail-loud
alerts. Only the session cookie is a secret.

## Deploy

```
supabase functions deploy letspoker-schedule --project-ref dexdftcmcixppbuucjfd
```

`verify_jwt` is **true** (called with the anon/service JWT, same as the other
LetsPoker functions). Already deployed to project `dexdftcmcixppbuucjfd`.

## How it works

The club's schedule is week-shaped — each venue's game repeats on the same
weekday at the same time. The function reads the live calendar (`getEventList`),
detects each weekly series from the last 5 weeks of history, and for every
series computes the dates it's *missing* between `from` and `to`. It creates
each missing occurrence with `createTournament` (name + Perth start time) — the
same mutation `letspoker-cash` uses to seed a cash-day container.

Buy-in / blind structure are **not** copied (LetsPoker exposes no captured
config-copy mutation), so a filled event uses the club's defaults until it's
opened in the admin hub.

## Modes (POST body)

| mode          | writes? | what it does |
| ------------- | ------- | ------------ |
| `plan` (default) | no   | Lists detected weekly series + the dates each is missing through end of month. |
| `fill`        | **only when `dryRun:false`** | Creates the missing events. `dryRun` defaults to **true** (this is player-visible), so you must pass `{"dryRun": false}` to actually create. |

Options: `from` / `to` (YYYY-MM-DD; default tomorrow → end of Perth month),
`recentDays` (a series must have run within this many days to count as alive;
default 8, so a deliberately-skipped week is not auto-resumed), and `only`
(case-insensitive substring filter on the event name).

## Examples

```bash
# See what's missing (read-only)
curl -sS -X POST "$SUPABASE_URL/functions/v1/letspoker-schedule" \
  -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"mode":"plan"}'

# Dry-run the creates for one series (writes nothing)
curl -sS -X POST "$SUPABASE_URL/functions/v1/letspoker-schedule" \
  -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"mode":"fill","dryRun":true,"only":"woodvale"}'

# Really create the rest of the month for the Woodvale Thursday game
curl -sS -X POST "$SUPABASE_URL/functions/v1/letspoker-schedule" \
  -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"mode":"fill","dryRun":false,"only":"woodvale"}'
```

## Notes / cautions

- **Idempotent**: a date that already has an event with the series' name is
  skipped, so re-runs (or a future cron) never double-create.
- **Placeholder series**: the club uses named markers like `Tues || NO GAME` and
  `FRI | >>> GAME CANCELLED <<<` as calendar placeholders. These are detected as
  weekly series too, so an unfiltered `fill` would recreate those markers on
  future weeks. Use `only` to target the real games, or set `from`/`to` to a
  narrow window, when you don't want the markers propagated.
- **No un-create**: LetsPoker exposes no delete mutation here, so a wrongly
  created event must be removed by hand in the admin hub. Always `plan` (or
  `fill` + `dryRun`) first.
- **Cron**: to keep the month topped up automatically, schedule a weekly
  `pg_cron` job hitting `mode:"fill", dryRun:false` (mirroring the letspoker-push
  cron). Not wired by default — filling is opt-in per the cautions above.
