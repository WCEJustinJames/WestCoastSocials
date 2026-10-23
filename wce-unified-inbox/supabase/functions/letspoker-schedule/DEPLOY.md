# letspoker-schedule — deploy

Source of the `letspoker-schedule` Supabase edge function: **recurring LetsPoker
events, behind a review gate**. It stages the club's regular weekly games for
the rest of the month in our own DB (private), and only creates the ones Justin
approves on the live LetsPoker calendar.

It belongs to the `wce-unified-inbox` app (alongside `letspoker-push` and
`letspoker-cash`) and reuses their conventions: the shared session cookie from
`letspoker_auth`, the constant `LETSPOKER_CLUB_ID` / `LETSPOKER_SESSION_GROUPID`,
`cash_open_log` for audit (source `"schedule"`), and `alertJustin` for fail-loud
alerts. Only the session cookie is a secret.

## Why a review gate (not a "Private" flag)

LetsPoker **tournaments** have no public/private flag we can set — that flag
(`isPublic`) only exists on cash **tables** (`AddTable`/`ModifyTable`). And there
is no delete/un-create for tournaments. So instead of creating events on the
calendar and hiding them, we stage each occurrence in
`public.letspoker_scheduled_events` (status `pending`) — a private review list
players can't see — and only create the **approved** rows on LetsPoker.

## Deploy

```
supabase functions deploy letspoker-schedule --project-ref dexdftcmcixppbuucjfd
```

Requires migration `0067_letspoker_scheduled_events.sql` (the queue table).
`verify_jwt` is **true**; the function writes to Supabase with the service role
(bypasses RLS) and reads the shared LetsPoker cookie.

## Flow

```
plan  →  queue  →  review  →  approve / reject  →  publish
```

| mode | writes? | what it does |
| --- | --- | --- |
| `plan` (default) | no | Detect the weekly series + the dates each is missing through end of month. |
| `queue` | DB only | Stage the missing occurrences as `pending`. Idempotent (skips dates already on the calendar or already queued). **Nothing on LetsPoker.** |
| `review` | no | List queue rows (default `status:"pending"`). This is the review list. |
| `approve` | DB only | Mark selected `pending` rows `approved`. Selector required. |
| `reject` | DB only | Mark selected `pending` rows `rejected`. Selector required. |
| `publish` | **LetsPoker (only when `dryRun:false`)** | Create the `approved` rows via `createTournament`, record the id. `dryRun` defaults **true**. Re-checks the calendar and skips anything already there. |

**Selectors** (`approve` / `reject` / `publish`): `ids:[1,2,3]`, `only:"woodvale"`
(name substring), `all:true`, and `from`/`to` (YYYY-MM-DD window). `approve` /
`reject` require a selector; `publish` with no selector = all `approved`.

**Detection options** (`plan` / `queue`): `from` / `to` (default tomorrow → end
of Perth month), `recentDays` (a series must have run within this many days to
count as alive; default 8), `only`.

## Typical session

```bash
SB=$SUPABASE_URL; K=$ANON_KEY
post(){ curl -sS -X POST "$SB/functions/v1/letspoker-schedule" -H "Authorization: Bearer $K" -H "Content-Type: application/json" -d "$1"; }

post '{"mode":"queue"}'                        # stage the month as pending (private)
post '{"mode":"review"}'                       # see the pending list (note the ids)
post '{"mode":"approve","ids":[12,13,14]}'     # approve the games you want
# or: post '{"mode":"approve","only":"woodvale"}'   /   '{"mode":"approve","all":true}'
post '{"mode":"publish"}'                       # DRY RUN — preview what will be created
post '{"mode":"publish","dryRun":false}'        # create the approved games on LetsPoker
```

## Queue table (`letspoker_scheduled_events`)

One row per (event_date, series_name). Statuses: `pending` → `approved`/`rejected`
→ `created`/`failed`/`skipped`. `tournament_event_id` is filled once created;
failures land as `failed` with the error in `note` (never silently retried into a
duplicate). See the migration for the full schema + RLS.

## Cautions

- **Placeholder markers**: the club uses named markers like `Tues || NO GAME` and
  `FRI | >>> GAME CANCELLED <<<`. These are detected as weekly series too, so
  they'll appear in the queue — just leave them `pending` or `reject` them (or
  use `only` when queueing) so they're never published forward.
- **No un-create**: LetsPoker exposes no delete mutation here. `publish` is the
  only mode that touches the live calendar, it only ever creates `approved` rows,
  it defaults to a dry run, and it re-checks the calendar to avoid duplicates.
- **Cron**: a weekly `pg_cron` job hitting `mode:"queue"` keeps the review list
  topped up automatically (still nothing goes live without an approve + publish).
