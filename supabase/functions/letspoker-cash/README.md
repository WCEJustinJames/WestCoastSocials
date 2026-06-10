# letspoker-cash

Headless cash-game automation for the LetsPoker (LP) admin GraphQL API, the
companion to `letspoker-push` (tournaments). It **opens** cash games, **seats**
reused player names onto events, and **pushes** per cash event. Same endpoint,
same cookie auth (`letspoker_auth` / `LETSPOKER_COOKIE`), same fail-loud alerts.

## Discovered LP cash schema

LP's admin GraphQL has introspection disabled; the surface below was mapped via
field-suggestion probing (validation-only — no mutations were executed).

| Operation | Signature | Purpose |
|---|---|---|
| `createCashStake` | `(clubId: ID!, input: SavedCashStakeInput!) : CustomerPreferences!` | Define a stake (shows in lobby) |
| `createCashGameType` | `(clubId: ID!, input: CashGameTypeInput!) : CustomerPreferences!` | Define a game type |
| `registerPlayerIntoEvent` | `(clubId: ID!, eventId: ID!, buyinVariantId: ID!, paymentMethod: String!, transactionId: ID!, playerId: ID) : RegisterPlayerIntoEventResponse!` | Seat/register a player into an event (tournament **or** cash) |
| `sendCashPushNotification` | `(clubId: ID!, tableId: ID!, tournamentEventId: ID!, templateParts: [String!]!)` | Push about a cash table |
| `getEventList` | `(clubId, startDate, endDate, includeCash)` | Calendar feed (cash events when `includeCash: true`) |

Input shapes (exact, minimal):

```graphql
input SavedCashStakeInput { blinds: [Float!]!  currency: Currency!  text: String! }
input CashGameTypeInput   { name: String!      abbreviation: String! }
```

`Currency` is a string scalar (e.g. `"AUD"`). `transactionId` is a client-minted
UUID — there is **no** `createTransaction` mutation. `playerId` is optional.

### Not available in the admin API
There is **no** seat/bot/dummy mutation and **no** live-table runtime query
(`getCashGames`, `getActiveCashTables`, `getLobby`, `getTables` do not exist),
and `Tournament` has no `tableId`/`isCash` field. "Filling" a table is therefore
modelled as **registering real player names** (`registerPlayerIntoEvent`), not
spawning bots. The `tableId` required by `sendCashPushNotification` comes from a
running table, not from `getEventList` — supply it explicitly to `push`.

## Modes (`POST { "mode": ... }`)

- **sync** — diff `getEventList(includeCash:true)` vs the tournament-only list,
  upsert cash-only events into `public.cash_events`.
- **prefill** — `{ mode:"prefill", horizonDays?, lookbackDays? }` — for each
  upcoming scheduled game, copy the entrants of the **same weekly game last
  week** (same venue + weekday) into a `cash_plan` + `cash_seat_roster`. Pure
  DB (no cookie); idempotent. Backed by `public.prefill_cash_from_history`.
- **open** — `{ mode:"open", date|planId, dryRun? }` — create the plan's
  `stakes[]` + `game_types[]`. `dryRun` reports the intended calls.
- **seat** — `{ mode:"seat", date|planId, paymentMethod?, dryRun? }` — register
  the plan's roster names onto `event_id`. **Money-touching → `dryRun` defaults
  to `true`**; set `dryRun:false` to fire. Enforces one name/user per Perth day
  across tournament + cash via `cash_day_user_ledger`.
- **push** — `{ mode:"push", eventId, tableId, templateParts?, dryRun? }`.
- **tick** — orchestrates today's plans (open then seat). `dryRun` defaults true.

## Data model

- `cash_plan` — what to open per event/date (stakes, game types, anticipated
  tables/players, `event_id`, `buyin_variant_id`).
- `cash_seat_roster` — player names to seat for a plan (resolved to `player_id`
  from the harvested `lp_entries`).
- `cash_day_user_ledger` — one name/user per Perth day (the cost guard).
- `cash_events` / `cash_open_log` / `cash_fired` — synced events, audit, dedupe.

## To go live (operator inputs)

1. Insert a `cash_plan` row per event with real `stakes` / `game_types` (and,
   for seating, `event_id` + `buyin_variant_id`).
2. Add `cash_seat_roster` rows (the regular names to reuse).
3. Set `CASH_PAYMENT_METHOD` (or pass `paymentMethod`) — the string LP expects
   for a comp/house registration.
4. Call `open` (live), then `seat` with `dryRun:false`.

## Scheduling

A daily pg_cron job **`letspoker-cash-prefill`** (`0 21 * * *` UTC = 05:00 Perth)
calls this function with `{"mode":"prefill"}`, so each upcoming day's roster is
auto-built from the same weekly game the week before. It reads the function URL
from the `letspoker_cash_function_url` vault secret and reuses the existing
`letspoker_push_function_token` for auth — mirroring the `letspoker-*` crons.
