# HANDOVER — WCE Unified Inbox / Player CRM

**How to use this:** start a FRESH chat and say *"Read wce-unified-inbox/HANDOVER.md and continue."* This doc is the source of truth; long chats get slow. `NEXT-SESSION-TODO.md` = the prioritised roadmap.

_Last updated: 2026-07-02 (Perth). Source of truth is now **Supabase-only** (Airtable retired). Running sync code: `g27-queue-noise` — RESTART `run-wce.bat` to activate (whale draft tone + invite-variant generator + noise-tag fix). Many UI features shipped this session (see Changelog)._

---

## Architecture (30-second version)
- **UI**: Vite/React, reads **Supabase** (project `dexdftcmcixppbuucjfd`). Tabs: Home, Inbox, Batches, Drafts, Confirmed, Recent, Receipts, Players, Merge & Review.
- **Sync**: Node process on Justin's always-on home PC (`run-wce.bat` → `npm run sync`, self-scheduling ~15s tick). It is the ONLY thing that talks to **Beeper Desktop** (`localhost:23373`) for **SMS (Google Messages)** + **Facebook Messenger**.
- **Cloud Claude has NO direct Beeper access** — it acts only by writing Supabase (queue `inbox_batches`/`inbox_batch_items`, set CRM flags, run migrations/SQL) and reading results. The PC sync executes sends.
- **PC folder**: `C:\Users\justi\WestCoastSocials\wce-unified-inbox` (anchor `run-wce.bat`). Host = `WESTCOAST1`. `run-ui.bat` = one-click dev UI (pulls + `npm run dev`, localhost:5173).
- **LetsPoker (LP)** attendance lives in the SAME Supabase project (`lp_events`/`lp_entries`), harvested by edge functions + pg_cron. Do **NOT** touch the public `westcoast-poker` Vercel project.

## Two-branch deploy (how to ship code)
- **Session work branch**: `claude/jolly-mendel-nwovko` (commit here first; draft PR #8 tracks it).
- **Desktop-sync branch**: `claude/laughing-ritchie-Xmvvk` — what `run-wce.bat` pulls. After committing to the work branch, **cherry-pick onto the sync branch via a git worktree and push BOTH**:
  ```
  git push -u origin claude/jolly-mendel-nwovko
  git worktree add /tmp/deploy claude/laughing-ritchie-Xmvvk
  git -C /tmp/deploy cherry-pick <sha> && git -C /tmp/deploy push origin claude/laughing-ritchie-Xmvvk
  git worktree remove --force /tmp/deploy
  ```
- **Commit messages: PLAIN only.** No model identifier, no `Co-Authored-By`, no session footer — the auto-approval classifier BLOCKS commits containing a model identifier.
- **Backend (sync) changes need a RESTART of `run-wce.bat` to go live** (it only `git pull`s on restart). Bump `SYNC_VERSION` in `src/sync/run.ts`; confirm via heartbeat `note`. **UI changes are live on the next `run-ui.bat` pull** — no sync restart needed.

## What's LIVE / built
**Sends & replies (PC sync, `src/sync/`)**
- Inbound mirror → Supabase; approve-to-send batches (`processBatches`, `batches.ts`); AI drafting (`drafting.ts` → `inbox_drafts`); **auto-reply** (`notify.ts`): classifies inbound `yes/no/maybe/other`, auto-acknowledges simple cases in Justin's voice, escalates anything needing him, texts a confirmed-names digest, keeps one live seat-list in the "CASH GAMES" FB group.
- **KILL-SWITCH**: `inbox_settings.sends_paused` (single-row). `true` halts ALL outbound every pass, no restart: `update inbox_settings set sends_paused=true where id=1;`. UI toggle exists.
- **Send guards** (`guards.ts`, at send time — defense in depth): half-rendered/empty; `do_not_message`; `hidden`; `staff` (outreach only); **`on_ice`** (snoozed until `snooze_until`); `first_time_review` (opt-in `VET_FIRST_TIMERS`); `no_reply_4` (stop after 4 ignored invites). Plus in-pass dedupe + 6-day idempotency (`ledger.ts`/`inbox_sent_log`) + auto opt-out (`optout.ts`: stop/unsubscribe → `do_not_message`). The old fixed "4-day cooldown" was REPLACED by `no_reply_4`.
- **Double-reply fixed**: atomic claim-before-send (conditional UPDATE on `auto_handled=false`).
- **Classifier extracts** (into `inbox_messages`): `reply_intent`, `reply_note` (incl. absence reason / venue distance), **`reply_back_on`** (resolved return date).
- **AI-down alerting** (`alert.ts`): texts Justin if the Anthropic layer goes dark (bad/missing key). The AI layer requires `ANTHROPIC_API_KEY` in the PC `.env`.
- **Google sync** (`contacts.ts`, `tdsheets.ts`): People API contacts + TD-sheet attendees (`inbox_td_attendees`); **FB friend re-match** (`fbmatch.ts`).

**Home dashboard (`ui/Home.tsx`)** — landing tab:
- **Stat cards** (click → filtered Players): Players · No contact · FB·DM to open · First name only.
- **Live sync status** (green/amber/red): contacts, TD sheets, LetsPoker freshness.
- **✈ FIFO players due back** panel — fly-in/out workers projected back now (manual `fifo` flag only; `inbox_fifo_due`). FIFO is a HUMAN judgment — never auto-flag from attendance gaps.
- **"Who's out" panel** — players whose latest reply was no/maybe, with reason + return date. Per-row actions apply **in place** (only "✓ resolved" dismisses): open thread · ＋add to venue cash/tourney list · ❄ on-ice (presets or exact date; shades row rose) · ✎ edit label · ✈ FIFO toggle · 📊 attendance pattern explorer.
- **Post-game** thank-you tool (variation pools; pulls TD/LP attendees).

**Players CRM (`Players.tsx`, `usePlayers.ts`, `PlayerRow.tsx`)**
- Browse/edit `inbox_outreach`. Filters: region, source, tournament, cash, no-contact, **FB·DM (verified players only)**, **first-name-only**, show-hidden. Per-card **context line** surfaces captured detail (Messenger saved name w/ one-tap "use", `beeper_contact_name` tags, notes).
- **FB friends importer** (drag-drop / paste) → `fb_friend`; FB·DM restricted to players verified in TD/LP attendance. Cross-zone regions "North + Central" / "South + Central".

**Other**: Batches (picker with phone+venue distinguisher, last-messaged + 👻 ghost signals, venue auto-tag; preview "why won't it send" reason filter), Recent (resolved names), Confirmed (replied-yes + manual attendance + game history), Merge & Review, Inbox, Receipts, collapsible **SendShelf**.

## Supabase objects we rely on
**Tables**: `inbox_outreach` (CRM, ~1440 rows; flags `do_not_message, hidden, staff, tournament, cash, fb_friend, fifo, snooze_until, preferred_channel, source`), `inbox_people`, `inbox_conversations` (+`context_resolved_at`), `inbox_messages` (+`reply_intent, reply_note, reply_back_on`), `inbox_batches`/`inbox_batch_items`, `inbox_sent_log`, `inbox_drafts`, `inbox_settings` (kill-switch), `inbox_td_attendees`, `inbox_fb_friends`, `inbox_sync_heartbeat`, `inbox_lists`/`inbox_list_members`, `inbox_group_post`. LP: `lp_events`/`lp_entries`.
**Views** (security_invoker=false, anon-readable): `inbox_recent_contacts`, `inbox_outreach_signals`, `inbox_player_context`, `inbox_fb_dm_verified`, `inbox_fifo_due`, `sync_freshness`.
**Function**: `player_attendance(name)` — SECURITY DEFINER; LP+TD attendance dates (full/core name match) for the pattern explorer.
**Cron**: `letspoker-harvest` daily 18:00 UTC, rolling 14-day window (revived this session).

## How cloud Claude sends a one-off message (no UI)
Insert an approved batch the PC drains:
- `inbox_batches`: `status='approved'`, `created_by='claude'`, `is_outreach=false` (bypasses 16:30 cutoff; still held by quiet hours unless a reply), `template_body` required.
- `inbox_batch_items`: `status='approved'`, **`person_id`=NULL** (FKs `inbox_people`, not `inbox_outreach`), `rendered_text`=final message, `data` jsonb:
  - SMS: `{"channel":"sms","phone":"04...","outreach_id":"<inbox_outreach.id>"}`
  - Messenger: `{"channel":"thread","beeper_chat_id":"!...:beeper.local","outreach_id":"<id>"}`
- `outreach_id` makes the rail stamp `last_contacted`. Rail caps **20 sends/pass, 1.5s apart**.

## Operating rules (locked — per Justin)
- **Quiet hours 21:00–09:00**: no proactive outreach. **Replies stay open all hours.** Seat-list exempt.
- **Outreach only 10:00–16:30** (gates `is_outreach=true` only).
- **Tournament tagging**: many contacts are "cash AND tourney" — KEEP them on cash. Only set `tournament=true` for tourney-ONLY players. Do NOT bulk-flag names containing "tourney".
- **Cross-game double-tap of regulars is fine.** Never message someone who hasn't replied to the previous message (→ `no_reply_4`).
- No self-introduction; **no em-dashes** (stripped). **Voice = Justin's** (`src/sync/voice.ts`): terse, dry, concrete (stakes/venue/who's in/seats), one-or-two-word replies fine, almost no emoji, no exclamation marks. "Me on a good day," never chirpy/spammy.
- **Approved invite wording**: `Hi {{first}}, $2/5/10 and $2/5 NLH at Market City tonight from 6. Are you interested in reserving a seat?`
- **Venues/days**: North = Woodvale + Kingsley; South = Kenwick + MCT. Mon Bentley, Tue Kingsley, Wed MCT, Thu Woodvale, Fri Kenwick (eve) + Leederville (day), Sun Planet Royale. $5/10 only the last game of the month.
- **FIFO = manual flag only.** **Don't nag about exposed keys/secrets.** Concise; go with your read.

## Changelog — this session (2026-06-30)
- **Retired Airtable** → Supabase sole source: backfilled `source` for 454 rows; gated the mirror behind `AIRTABLE_SYNC=1` (off) so the dead key stops 401-ing. (The old "weekly list" opt-out flag is also retired in favour of venue-based lists — roadmap #2.)
- **Revived LP attendance**: `lp_events`/`lp_entries` had frozen at 2026-06-09 (harvest was a manual sweep, not a cron — auth was healthy throughout). Backfilled June 10–30 (13 events / 429 entries) and **scheduled `letspoker-harvest` daily** — attendance now self-maintaining. (`migrations/0036`.)
- **Recovered 50 "Unknown" contacts** (names were misfiled into `notes` by the contacts import).
- **New views/fn/columns** (migrations ~0022–0037): see "Supabase objects".
- **UI**: Home dashboard + Who's-out + FIFO panels, attendance pattern explorer, context surfacing, FB-verified filter, last-messaged/ghost signals, batch preview reason filter, collapsible SendShelf, region combos, first-name-only filter, on-ice/snooze + guard, in-place panel actions.
- **Double auto-reply fixed**; classifier now extracts return-date + absence reason.

### Roadmap build — Lists / Schedules / Analytics / whale / action queue / variants (2026-06-30, parallel session)
Shipped the prioritised roadmap (migrations `0038`–`0044`, **all applied live**; UI on `laughing-ritchie`). Strictly additive; pre-change backups in `bak.inbox_*_20260630`. **Backend needs a `run-wce.bat` restart** (`SYNC_VERSION=g27-queue-noise`) for the whale draft tone + invite-variant generator.
- **Venue lists** (`0039`): adopted the stranded `inbox_lists`/`inbox_list_members` into the repo; `game_type` on lists, `pinned`/`added_by` on members; `canon_venue()`, `inbox_attendance_norm` view, `seed_tourney_list()` (≥2 tourneys/90d at a venue, add-only — cash lists are manual). New **Lists tab**; Batches "Load a venue list".
- **Recurring schedules** (`0040`): `inbox_schedules` seeded from the locked weekly map; `materialise_due_schedules()` builds the next game's batch the evening before as a DRAFT from the venue list; pg_cron `wce-materialise-schedules` (09:00 UTC = 17:00 Perth). New **Schedules tab**; Batches surfaces scheduler drafts to approve. (Existing 5 lists untouched — link/re-key them in the Lists/Schedules tabs.)
- **Conversion analytics** (`0041`): `inbox_batch_conversion` view (sent→reply/yes per batch + by venue, 7-day attribution). New **Analytics tab**.
- **Whale flag** (`0042`): `inbox_outreach.whale` (manual), card toggle + finished the previously-missing fifo card toggle; whale players get a warmer AI reply draft. _(Follow-ups: whale-first ordering in Batches + auto-reply tone in `notify.ts`.)_
- **Home action queue** (`0043`): top-of-Home panel (needs-you replies via new `inbox_messages.action_resolved` + unread threads via `context_resolved_at`); hides when empty. **Email source NOT wired** — needs a Gmail source (the People-API token's scope is contacts/sheets only).
- **Invite variants** (`0044`): sync pre-writes 3 invite options/venue into `inbox_invite_variants` (refreshed ~daily); pick one in Batches. Populates after the restart.
- **On-ice shading** carried into the player card + Batches picker. **Assisted dup-merge** (by full name, phone-dedup misses) added to Merge & Review.
- **Review pass (0045, 2026-07-02)**: action-queue flood fixed (noise is now `reply_intent='noise'`, 329 historical rows backfilled resolved, 14-day window); **merges no longer lose venue-list memberships or cash/tourney/whale/fifo/staff/ban flags** from dropped dupes; scheduler dates now Perth-local; whale follow-ups done (whales sort first + 🐋 in the Batches picker, 🐋 in the reply digest).

## Open items
- **Restart `run-wce.bat`** (pull `laughing-ritchie`) to activate the classifier's `reply_back_on`/absence extraction + the whale draft tone + invite-variant generator (`SYNC_VERSION=g27-queue-noise`). Ensure `ANTHROPIC_API_KEY` is set on the PC.
- Open offers: carry "on ice" shading into Batches picker + Players card; pre-send Beeper bridge health-check (Google Messages bridge can silently swallow sends if the phone connection drops — it shows "Not sent" even when delivered).
- **Roadmap**: `NEXT-SESSION-TODO.md` — 5 prioritised items + 12 further suggestions.

## Useful IDs
- Supabase project: `dexdftcmcixppbuucjfd` · LP club id: `8f025bf9ecfa14c8`
- Cash Games FB group chat id: `!COGOXsoBtEKMPhRekSd9:beeper.local` (`inbox_group_post`)
- Justin digest phone: `+61459686980`
- Git commit identity: `user.name=Claude`, `user.email=noreply@anthropic.com`
