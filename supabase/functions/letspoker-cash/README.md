# letspoker-cash

Headless cash-game automation for LetsPoker (LP), companion to `letspoker-push`.
It **opens** cash tables, **seats** reused tournament names onto them (the
money-saving "fill"), and **pushes** per table — all on the day's cash event.

> The real LP cash API is `createTournamentLogItem`. See **CASH_API.md** for the
> full decoded spec (eventTypes, the seat chain, how ids resolve).

## Modes (`POST { "mode": ... }`)

- **prefill** — `{ horizonDays?, lookbackDays? }` — fill each upcoming game's
  roster from the same weekly game last week (same venue + weekday), honouring
  `cash_exclusions`. Pure DB; idempotent. Backed by `prefill_cash_from_history`.
- **log** — `{ date? }` — read-only: resolve the day's cash event and report its
  open tables, seated count, and free seats. Handy for debugging.
- **open** — `{ date|planId, start?, dryRun? }` — open the plan's `tables_spec`
  via `AddTable` (and optionally `Command{start}` the day). `dryRun` supported.
- **seat** — `{ date|planId, buyin?, buyinPct?, notes?, dryRun? }` — for each
  pending roster player: `Registered → Seated` into the next free seat across
  the day's open tables, optional `AddCashBuyin` (`buyinPct` default 0.8 of the
  table max, i.e. ~75–85%). **Outward-facing → `dryRun` defaults true.** Enforces
  one name/user per Perth day (`cash_day_user_ledger`); skips already-seated.
- **push** — `{ date|planId, templateParts?, slot?, dryRun? }` —
  `sendCashPushNotification` per open table (table ids resolved from the log).
  **`dryRun` defaults true.** Idempotent per table/slot via `cash_fired`.
- **tick** — orchestrate open + seat for today's plans (cron). `dryRun` true.

## How the day resolves

The cash "Check-in and cash-games" container is the `getEventList` entry with an
**empty `eventName`** on that Perth date; its id is the `tournamentId` used by
every call. Open tables + seat occupancy are read from
`getTournamentLog(tournamentId, …)`.

## Data model

- `cash_plan` — per event/date: `tables_spec` (tables to open), anticipated
  players. (`stakes`/`game_types`/`buyin_variant_id`/`push_event_id`/`table_ids`
  from earlier iterations are unused by v4 and kept only for history.)
- `cash_seat_roster` — names to seat (resolved to `player_id` from `lp_entries`).
- `cash_day_user_ledger` — one name/user per Perth day (cost guard).
- `cash_exclusions` — never-auto-seat list (honoured by prefill).
- `cash_open_log` / `cash_fired` — audit + push dedupe.

## Scheduling

Daily pg_cron **`letspoker-cash-prefill`** (05:00 Perth) keeps rosters built.
Add open/seat/push crons (or use `tick`) once you're ready to fire live.

## To go live

1. Ensure the day's cash event exists and a table is open (UI, or `open` with a
   `tables_spec`).
2. `seat` with `dryRun:false` (add `buyin:true` to give chips). Reused tournament
   names are billed as one user/day across tournament + cash.
