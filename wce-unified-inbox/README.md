# WCE Unified Inbox

One place to read, triage, and reply to player messages across every channel —
backed by Supabase, built as a unified inbox with **pluggable channel adapters**.

> Status: **Step 1 — inbound mirror through the Beeper adapter.** Read-only today.
> Drafting/approve-to-send (Phase A) and batched variations come next.

---

## Architecture

```
                 ┌────────────────────────┐
  Beeper bridge  │  BeeperAdapter         │
  localhost:23373│  (WhatsApp, Messenger, │
  ───────────────▶  SMS×3, IG, FB)        │──┐
                 └────────────────────────┘  │   normalized shapes
  LetsPoker (later, NOT via Beeper)          │   (ChannelAdapter)
                 ┌────────────────────────┐  │
                 │  LetsPokerAdapter      │──┤
                 │  (placeholder)         │  │
                 └────────────────────────┘  ▼
                              ┌──────────────────────────────┐
                              │  mirror  (src/sync)          │
                              │  identity-match → upsert      │
                              └──────────────┬───────────────┘
                                             ▼
   Supabase "WCE App"  ── inbox_people / inbox_identities / inbox_conversations
                          inbox_messages / inbox_batches / inbox_batch_items / inbox_drafts
                                             ▲
                              ┌──────────────┴───────────────┐
                              │  React + Vite + Tailwind UI   │
                              └──────────────────────────────┘
```

- **Adapters are pluggable.** Every source implements `ChannelAdapter`
  (`src/adapters/types.ts`) and returns the same normalized shapes. A new
  adapter (LetsPoker) slots in with **zero schema change**.
- **Unified person record.** One player = one `inbox_people` row. Every channel
  handle (each SMS number, WhatsApp, Messenger, IG, FB, LetsPoker) hangs off it
  via `inbox_identities`. Cross-channel identity matching is core
  (`src/sync/identity.ts`).
- **The mirror runs on your machine** (Node), next to Beeper Desktop. The UI is a
  separate Vite app that reads from Supabase.

---

## Beeper API — verified

Confirmed against Beeper's developer docs (https://developers.beeper.com/desktop-api).
**Run the probe against your live bridge to confirm for your install** (below).

| Thing | Value |
|---|---|
| Base URL | `http://localhost:23373` |
| Auth | `Authorization: Bearer <token>` — Beeper Desktop → Settings → Integrations → Approved connections → "+" |
| Accounts | `GET /v1/accounts` — one per channel/number |
| Read messages | `GET /v1/messages/search` (v0: `/v0/search-messages`) — filters incl. `chatType=single`, cursor pagination |
| Send / reply | `POST /v1/chats/{chatID}/messages` (v0: `/v0/send-message`) — `text` + optional `replyToMessageID` ✅ |
| Live updates | `ws://localhost:23373/v1/ws` |

Message fields used: `id, chatID, accountID, senderID, senderName, timestamp,
sortKey, text, isSender` (→ inbound/outbound), `isUnread`, `attachments`,
`reactions`. Chats carry `network`, `title`, `type`, `lastActivity`, `unreadCount`.

> ⚠️ Beeper notes the **send** API is personal-use only; high send volume risks
> network account suspension. The batch engine (Phase B) will pace sends. The
> mirror (Step 1) is read-only, so it's unaffected.

---

## Setup

```bash
cp .env.example .env      # fill in BEEPER_ACCESS_TOKEN + SUPABASE_SERVICE_ROLE_KEY
npm install
```

### 1. Verify your bridge (run where Beeper Desktop runs)

```bash
npm run beeper:probe
```

Prints `/info`, your channel accounts, and a few sample 1:1 messages. Confirms
the token + API shape before the mirror relies on it.

### 2. Run the inbound mirror

```bash
npm run sync:once    # single pass
npm run sync         # poll on SYNC_INTERVAL_MS
```

### 3. Run the inbox UI

```bash
npm run dev          # http://localhost:5173
```

---

## Data model (Supabase project "WCE App")

| Table | Purpose |
|---|---|
| `inbox_people` | unified person record (`last_outbound_at` = contact-data guard) |
| `inbox_identities` | every channel handle → person (cross-channel identity core) |
| `inbox_conversations` | one per chat/thread (`auto_send_enabled` = Phase A→B graduation) |
| `inbox_messages` | the mirror; `direction`, `kind` (1to1/batch), `adapter_source`, `raw` |
| `inbox_batches` | template + variation logic, approved once |
| `inbox_batch_items` | one per recipient, rendered from its own data; `guard_flag` |
| `inbox_drafts` | Phase A draft → approve → send for 1:1 replies |

Schema lives in `supabase/migrations/0001_inbox_init.sql` (already applied).
Coexists with the existing `letspoker_*` / `tournament_events` / `wcp_sync` tables.

---

## Security note (read before deploying anywhere)

This is a **local, single-user** tool. RLS is enabled but policies are permissive
and the UI uses the anon key. The Node mirror uses the **service role key**, which
must stay server-side — it's in `.env` (gitignored) and must never be bundled into
the browser or committed. Before exposing any of this beyond your local machine,
tighten RLS to authenticated-only and move the UI to a Supabase Auth session.

---

## Roadmap

- **Step 1 (this):** inbound mirror via Beeper. ✅
- **Phase A:** Claude drafts → you approve → send (1:1).
- **Batched variations:** approve template + variation logic once, preview the
  rendered batch (each message from its own data), send. Shares the draft surface.
- **Contact-data guard:** before any draft/batch, check recent outbound per person
  (don't trust CRM "Last Contacted") and flag double-message risk.
- **Phase B:** graduate trusted threads to full auto-send (paced).
- **LetsPoker adapter:** slots into `ChannelAdapter`; pairs with the existing
  `LetspokerMCP` repo + `letspoker_*` Supabase tables. No schema change.
