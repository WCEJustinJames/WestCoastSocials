# WCE Unified Inbox — Session Handover

_Last updated: 2026-06-07. Read this first when resuming._

## TL;DR status
- **Step 1 (inbound mirror) is DONE and working.** 108 people, 111 conversations,
  1,463 messages mirrored from Beeper into Supabase. The UI works (search,
  channel filters, unread toggle, clean rich-text rendering).
- **Phase A (approve-to-send) is DONE and CONFIRMED LIVE (2026-06-07).** Completed a
  real end-to-end send: approved a draft in the UI → outbox logged `[outbox] sent=1`
  → message delivered. The send rail (outbox worker + reply composer) is working.
- **UI polish (2026-06-07):** the open thread now auto-refreshes (polls every 5s) and
  auto-scrolls to the most recent exchange — no more clicking away/back or manual scroll.
- **AI drafting (Roadmap item 1) is DONE and CONFIRMED LIVE (2026-06-07).** `[drafts] generated=N`
  in the sync loop; suggestions pre-fill the composer; approve → outbox sends. Defaults to
  `claude-opus-4-8`; opt-in via `ANTHROPIC_API_KEY`. (Note: drafts for every inbound-last thread,
  so it spends until all are covered — set `ANTHROPIC_MODEL=claude-haiku-4-5` to cut cost.)
- **Batched variations (Roadmap item 2) is BUILT (2026-06-07), not yet live-tested.** New "Batches"
  tab in the UI: write one template (`{{name}}` / `{{first_name}}`), pick recipients, preview each
  rendered message (contact-data guard unticks anyone messaged in the last 24h), approve. A throttled
  server sender (`src/sync/batches.ts`, ~1.5s between sends, 20/pass) pushes approved items through
  the Beeper adapter — logs `[batch] sent=N`. **Live test:** open Batches, build a tiny batch to a
  self-thread, approve, watch for `[batch] sent=`.
- All code is on branch **`claude/laughing-ritchie-Xmvvk`** in
  **`WCEJustinJames/WestCoastSocials`**, folder **`wce-unified-inbox/`**, draft **PR #2**.
  (A standalone repo, `WCEJustinJames/West-Coast-Game-Messaging`, was also created 2026-06-07
  as the intended future home — not yet the source of truth; PR #2 here still is.)

## Immediate next step (resume here)
Live-test **batched variations**: open the **Batches** tab, write a short template with
`{{first_name}}`, pick one or two recipients (a self-thread is safest), Build preview → Approve &
send, and confirm the sync window logs `[batch] sent=N`. After that, the next targets are the
**contact-data guard** beyond the 24h flag (Roadmap item 3) and **Phase B auto-send** (item 4).

### AI drafting knobs (.env)
- `ANTHROPIC_API_KEY` — unset = drafting off. Server-side only (the Node sync); never the browser.
- `ANTHROPIC_MODEL` — defaults to `claude-opus-4-8`.
- `DRAFT_MAX_PER_PASS` — cap on suggestions generated per 15s pass (default 5), so it never
  fans out into a burst of API calls. Drafting only fires for a conversation whose latest
  message is inbound and that has no open (`pending`/`approved`) draft.

### Getting the local stack running again (verified 2026-06-07)
1. `.env` needs **`BEEPER_BASE_URL=http://localhost:23373`** — Remote Access is OFF, so the
   bridge only answers on localhost, never the LAN IP `192.168.0.69`.
2. `.env` needs a valid `BEEPER_ACCESS_TOKEN=bdapi_…`. Cleanest write that dodges the
   PowerShell paste/BOM/newline traps: one here-string with the token **inline**, piped to
   `Set-Content -Encoding ascii`. (Notepad-editing `.env` directly is the no-fuss fallback.)
3. `npm run beeper:probe` → should list 3 accounts (matrix/Beeper, facebookgo/Facebook,
   gmessages/Google Messages). Then `npm run sync` (no ECONNREFUSED, no 401).
4. UI test send: open the **"Justin Lewis" (Google Messages)** self-thread, type a test,
   **Approve & send**, confirm the sync window logs `[outbox] sent=1` and it lands.

## Architecture (what runs where)
- **Mirror + outbox** = a Node process on Justin's PC (the only machine that can reach
  Beeper). `npm run sync` loops every 15s: pulls inbound 1:1 messages AND sends approved drafts.
- **UI** = Vite/React app reading Supabase. Runs anywhere; he runs it on the desktop
  (`npm run dev` → http://localhost:5173). Browser never touches Beeper.
- **Send gate:** UI writes `inbox_drafts` rows with `status='approved'`; the outbox sends
  them. Nothing sends without an explicit approve. On send failure a draft reverts to
  `pending` (never silent auto-resend → no double-message risk).

## Key facts
**Beeper bridge** (verified against live `/v1/spec`, OpenAPI 5.0.0, Beeper 4.2.876):
- `http://localhost:23373`, bearer token auth. Remote Access = OFF (keep it off).
- `GET /v1/accounts`, `GET /v1/messages/search` (limit hard-capped at 20 → cursor paging),
  `POST /v1/chats/{chatID}/messages` (send; returns `{chatID, pendingMessageID}`, no success field),
  `ws://localhost:23373/v1/ws` (live events — not used yet).
- Connected accounts: `matrix` (Beeper), `facebookgo` (Facebook/Messenger), `gmessages`
  (Google Messages = SMS). WhatsApp / Instagram / other SMS numbers from the brief are
  **not connected in Beeper yet** — they'll flow in automatically when added (no code change).

**Supabase** project "WCE App" — ref `dexdftcmcixppbuucjfd`, region ap-southeast-2.
- Inbox tables (all `inbox_`-prefixed): people, identities, conversations, messages,
  batches, batch_items, drafts. Coexist with existing `letspoker_*` / `tournament_events` / `wcp_sync`.
- RLS enabled but **permissive** (local single-user). `anon` + `authenticated` have table
  GRANTs. The mirror uses the **publishable key** (`sb_publishable_…`) for both keys in `.env`
  (works because of permissive RLS + grants — no service_role secret needed locally).

**Local machine (Windows):** repo at `C:\Users\justi\WestCoastSocials\wce-unified-inbox`.
Node + Git installed. PowerShell execution policy set to RemoteSigned (CurrentUser).
`.env` is gitignored and lives in that folder.

## Runtime commands (Windows, two PowerShell windows)
- Window 1: `npm run dev` → the UI at http://localhost:5173 (leave running).
- Window 2: `npm run sync` → mirror + outbox loop (leave running). `npm run sync:once` = one pass.
- `npm run beeper:probe` → sanity-check the bridge + token.
- To update after a push: stop, `git pull`, restart.

## Gotchas that ate most of the last session (avoid these)
1. **PowerShell paste concatenation:** pasting a second command before the first finished
   ran them merged (e.g. `npm run sync(Get-Content…)` which piped npm output over `.env`).
   → Give Justin **one command at a time**; tell him to press Enter and wait for the prompt.
2. **Token trailing newline:** copying the token brought a `\n`, so `Bearer …\n` → 401.
   → Trim it. Cleanest: write `.env` with a single here-string command that includes the token.
3. **`Set-Content -Encoding utf8` adds a BOM** in Windows PowerShell 5.1 (corrupts the first
   env var). → Use `-Encoding ascii`.
4. **RLS ≠ grants:** permissive RLS still 42501'd until `anon`/`authenticated` got table GRANTs
   (now in migration `0001_inbox_init.sql`).

## Security TODO (not yet done)
- **Rotate the Beeper token** — several flashed through the chat transcript. Generate a fresh
  one, update `.env`. (Low urgency now: Remote Access is off, so leaked tokens are local-only.)
- Before any hosted/remote deploy: tighten RLS to authenticated-only, drop `anon` grants, add
  Supabase Auth login, and never bundle a service_role key in the browser.

## Roadmap (after live send is confirmed)
1. **AI drafting** — generate suggested replies into `inbox_drafts` as `pending`; Justin edits/approves
   in the UI. Needs an `ANTHROPIC_API_KEY` (Claude API) added to `.env` + a draft-generation step.
2. **Batched variations** — `inbox_batches` + `inbox_batch_items` (already in schema): approve a
   template + variation logic once, preview each rendered message, send. Same approve surface.
3. **Contact-data guard** — before draft/batch, check recent outbound per person
   (`inbox_people.last_outbound_at`, maintained by a DB trigger) and flag double-message risk.
4. **Phase B** — graduate trusted threads to auto-send (paced; Beeper warns send volume can get
   accounts suspended — throttle).
5. **LetsPoker adapter** — implement `ChannelAdapter` for LetsPoker; pairs with the existing
   `LetspokerMCP` repo + `letspoker_*` Supabase tables. Slots in with no schema change.
6. **Repo home** — currently staged inside `WestCoastSocials`. Justin wants it separate but said
   leave the empty `WCE-APP` repo alone; the session integration can't create repos. Decide a home.

## Repo map
- `src/adapters/types.ts` — `ChannelAdapter` interface (pluggable; LetsPoker slots here).
- `src/adapters/beeper/{client,adapter,probe}.ts` — Beeper REST client + adapter + probe script.
- `src/sync/{mirror,identity,outbox,run}.ts` — inbound mirror, cross-channel identity matching,
  approve-to-send outbox, entrypoint loop.
- `src/ui/Inbox.tsx` — the inbox UI (list + thread + search/filter + reply composer).
- `src/lib/{supabase,supabaseAdmin,env}.ts` — Supabase clients + env loading.
- `src/types/database.ts` — generated Supabase types.
- `supabase/migrations/0001_inbox_init.sql` — full schema + RLS + grants (already applied).
