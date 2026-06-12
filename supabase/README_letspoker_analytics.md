# LetsPoker player analytics (West Coast Poker)

A server-side pipeline that pulls the club's **full tournament history** from the
LetsPoker admin GraphQL API into Supabase, so churn / attendance / night / venue
analysis is plain SQL instead of thousands of browser page-loads.

## Why this exists

The original goal: find players who *used to play a lot* of West Coast events and
now play much less (the "they've moved online" hypothesis), with each player's
**exact last attendance**, **prominent night**, and **prominent venue**.

The admin UI only exposes that detail one player at a time (~1,900 players). This
pipeline instead loops over **events** (a few hundred) via `getEventList`, which
returns each event's full entrant roster in a single call — the whole 2+ year
history lands in ~30 API calls.

## How it works

```
LetsPoker admin GraphQL  ──(getEventList, event-centric)──►  letspoker-harvest  ──►  lp_events / lp_entries
                                                                                          │
                                                                              analysis views (SQL)
                                                                                          │
                                                          lp_player_summary · lp_churn · lp_event_summary
```

- **Auth** reuses the existing `letspoker-push` mechanism: the session cookie lives
  in the `LETSPOKER_COOKIE` secret (or the `letspoker_auth` table). It never leaves
  Supabase. Club id / session-group are constants (`8f025bf9ecfa14c8` / `wcp`).
- **Endpoint:** `https://wcp.admin.lets.poker/api/graphql` (introspection is off; the
  schema was mapped by field-suggestion probing).
- Key query fields discovered: `getEventList(clubId, startDate, endDate, includeCash)`
  returning `Tournament { id scheduledDate entries rebuys config{general{eventName}}
  players{ playerId firstName lastName position payout{ value } } }`. `getEventList`
  **does** return completed/historical events with full rosters.

## Components

| Path | What |
|------|------|
| `migrations/0001_lp_history_tables.sql` | `lp_events`, `lp_entries` (raw landing tables, RLS on, service-role only) |
| `migrations/0002_lp_analysis_views.sql` | enrichment + summary + churn + event-profitability views |
| `functions/letspoker-harvest/` | edge function: harvest a date window → upsert tables (idempotent) |
| `functions/lp-export/` | edge function: stream a whitelisted view as CSV (token-guarded) |
| `../scripts/harvest_history.sh` | monthly sweep that drives `letspoker-harvest` over the full history |

## Tables & views

- **`lp_events`** — one row per tournament (date in Perth time, name, field size, rebuys).
- **`lp_entries`** — one row per (event, player): finishing `position`, `winnings`
  (AUD), and `entry_count` (re-entries folded in).
- **`lp_event_enriched`** — events + derived `night`, `venue` (keyword map), `buyin_parsed`.
- **`lp_entry_enriched`** — every attendance enriched with night/venue/buy-in.
- **`lp_player_summary`** — per player: first/last seen, days since last, lifetime
  events & entries, total winnings, best finish, ITM finishes, avg buy-in, and
  **prominent night / prominent venue / favourite event**.
- **`lp_churn`** — Jul–Dec 2025 vs Jan–Jun 2026 entry counts, absolute & % drop,
  joined to each player's night/venue/last-seen.
- **`lp_event_summary`** — per recurring event: times run, avg field size, total
  entries, avg buy-in, total prize paid, avg prize per run.

## Refreshing the data

```bash
export SUPABASE_ANON_KEY=<anon key>
# keep current month fresh (idempotent):
./scripts/harvest_history.sh "$(date +%Y-%m-01)"
# or re-sweep everything:
./scripts/harvest_history.sh 2024-01-01
```

Then query the views (Supabase SQL editor, MCP, or `lp-export` for CSV). Example —
historical regulars who've dropped 70%+, with where/when they played:

```sql
select full_name, entries_jul_dec_2025, entries_jan_jun_2026, drop_pct,
       last_seen, prominent_night, prominent_venue, favourite_event
from lp_churn
where entries_jul_dec_2025 >= 15 and drop_pct >= 70
order by drop_abs desc;
```

## CRM enrichment (inbox_outreach)

The harvested history feeds the outreach CRM:

- **`scripts/enrich_outreach_crm.sql`** — backfills `last_active` (exact last
  attendance) and adds each player's **favourite venue** (only when attended more
  than once), matched by unique normalized name. High precision: messy/ambiguous
  CRM labels are left untouched.
- **`scripts/crm_venue_cleanup_and_tag.sql`** — normalizes `venues` to one
  canonical label per room (Airtable mixed `MCT`/`Market City Tavern` etc.) and
  tags the churned-regular segment in the otherwise-unused `activity` field
  (`activity = 'churned_regular'`).
- **`lp_outreach_targets`** view — the ready outreach list: churned regulars
  (15+ entries Jul–Dec 2025, 70%+ drop) joined to a contactable CRM row, one row
  per player, with night/venue/last-seen and phone/DNM status.

Run order after a harvest refresh: `enrich_outreach_crm.sql` →
`crm_venue_cleanup_and_tag.sql`. All three are idempotent.

> Note: `inbox_outreach` mirrors Airtable (`airtable_id`, `synced_at`). If a
> one-way Airtable→Supabase sync runs, confirm it won't overwrite `last_active`,
> `venues`, or `activity`; otherwise re-run these scripts after each sync.

## Notes / caveats

- **Re-entries**: `lp_events.entries` is the full field size; per player, `entry_count`
  folds multiple entries into one attendance row. Use `total_entries` (sum of
  `entry_count`) to match the platform's entry counts; use `events_attended` for
  distinct attendance.
- **Venue / buy-in** are parsed from the free-text event name. Venue coverage is good
  for the regular rooms; anything unmatched is `Other/Unknown`. `buyin_parsed` only
  fills when the name states an explicit entry/buy-in (it deliberately ignores GTD
  guarantee figures), so it is sparse — `winnings` is the reliable money field.
- A drop in play is a strong churn signal but does not by itself confirm a player
  moved to an online platform — that remains a hypothesis to validate.
