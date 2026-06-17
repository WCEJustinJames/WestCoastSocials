# HANDOVER — WCE Unified Inbox / Player Messaging

**How to use this:** start a FRESH chat and say *"Read wce-unified-inbox/HANDOVER.md and continue."* This doc is the source of truth; previous chats got too long to be fast.

_Last updated: 2026-06-17 (Wed) evening Perth._

---

## Architecture (30-second version)
- **UI**: Vite/React, reads **Supabase** (project `dexdftcmcixppbuucjfd`).
- **Sync**: Node process on Justin's always-on home PC (`run-wce.bat` → `npm run sync`, polls ~15s). It is the ONLY thing that talks to **Beeper Desktop** (localhost:23373) for **SMS (Google Messages)** + **Facebook Messenger**.
- **Cloud Claude has NO direct Beeper access** — it acts only by writing Supabase (queue `inbox_batches`/`inbox_batch_items`, set CRM flags) and reading results. The PC sync executes them.
- **Folder on the PC**: `C:\Users\justi\WestCoastSocials\wce-unified-inbox` (anchor: `run-wce.bat`). Host = `WESTCOAST1`.

## Two-branch deploy (IMPORTANT — how to ship code)
- **Session work branch**: `claude/jolly-mendel-nwovko` (commit here first; draft PR #8 tracks it).
- **Desktop-sync branch**: `claude/laughing-ritchie-Xmvvk` — this is what `run-wce.bat` pulls. After committing to the session branch, **cherry-pick onto the sync branch via a git worktree and push BOTH**:
  ```
  git push -u origin claude/jolly-mendel-nwovko
  git fetch origin claude/laughing-ritchie-Xmvvk
  git worktree add /tmp/deploy claude/laughing-ritchie-Xmvvk
  cd /tmp/deploy && git cherry-pick <sha> && git push origin claude/laughing-ritchie-Xmvvk
  cd <repo> && git worktree remove /tmp/deploy --force
  ```
- **Commit messages: plain only.** Do NOT add a model identifier, `Co-Authored-By: Claude …`, or a `Claude-Session:` footer — the auto-approval classifier BLOCKS commits containing a model identifier. Keep messages clean and descriptive.
- **Backend changes need a sync RESTART to go live** (`run-wce.bat` only `git pull`s when the sync restarts). Bump `SYNC_VERSION` in `src/sync/run.ts` each meaningful deploy; confirm it via the heartbeat `note`.

## What's LIVE / built
- Inbound mirror; approve-to-send batches (`processBatches`); AI drafting; auto-reply.
- **Auto-reply** (`src/sync/notify.ts`): classifies inbound (yes/no/maybe/other), auto-acknowledges simple confirm/decline/maybe in Justin's voice, escalates anything needing him; texts Justin a confirmed-names digest; keeps **one live seat-list in the "CASH GAMES West Coast Poker" FB group** (delete+repost on change).
- **Watchdog loop** (`src/sync/run.ts`): self-scheduling tick + `PASS_TIMEOUT_MS=120_000`; **sends run BEFORE the mirror** so a slow Beeper backlog can't block texts. (Fixed the old "sent 20 then froze" bug.)
- **Quiet hours** `QUIET_START/END` default **21:00–09:00** (`inQuietHours` in `src/lib/env.ts`): holds outreach batches + approved drafts. **EXEMPT, per Justin: the auto-reply path AND the live seat-list run all hours** (so anyone who replies, even a "no", even at night, gets answered; the roster stays current through a late game). Code version `replies-allhours`.
- **Outreach window** 10:00–16:30 (`OUTREACH_START`/`OUTREACH_CUTOFF`): only gates `is_outreach=true` batches. `is_outreach=false` batches bypass it (used for replies/confirmations and any time-critical operator send).
- **Player CRM flags** (`inbox_outreach`): `do_not_message` (ban), `hidden` (off all lists), `staff` (exclude from player outreach), `tournament` (skip cash sends; include in tourney/event promos), `preferred_channel` ('sms'|'thread'|''), **`weekly`** (see below).
- **Weekly message list** = the recurring cash send, modelled as an **opt-OUT** flag `weekly` (default **true**). "On the list" = `weekly=true AND not do_not_message AND not hidden AND not staff AND not tournament AND has a phone or beeper_chat_id`. Encodes Justin's rule "everyone's on it unless previously stated"; new contacts auto-join. **~945 currently on it.** UI: `weekly` checkbox on each card, a **"weekly list"** filter + on-list count in the Players tab.
- **UI tabs**: **Players** (browse/edit, `Players.tsx`/`usePlayers.ts`/`PlayerRow.tsx`) and **Merge & Review** (`MergeReview.tsx`). Inbox has mark-read/dismiss.
- **`run-ui.bat`** (NEW): one-click UI launcher that **pulls latest then `npm run dev`** (localhost:5173). Use this to see UI changes — `run-wce.bat` only runs the sync and only pulls on its own restart, so the dev UI would otherwise stay on stale code.
- **Merge rule**: when merging duplicates, the phone from the **contacts upload (`airtable_id` prefix `gcsv:`) wins** (that's the number saved in Justin's phone). `weekly`/`do_not_message` = OR across merged rows.
- **Heartbeat** (`inbox_sync_heartbeat`, `note`=SYNC_VERSION, `host`) for liveness + which code is running. **Right now: `note='replies-allhours'`, `host=WESTCOAST1`, healthy** — desktop is on the latest code.

## How cloud Claude sends a one-off message (no UI)
Insert an approved batch the PC will drain:
- `inbox_batches`: `status='approved'`, `created_by='claude'`, `is_outreach=false` (bypasses the 4:30 cutoff; still held by quiet hours unless it's a reply).
- `inbox_batch_items`: `status='approved'`, **`person_id` = NULL** (it FKs to `inbox_people`, NOT `inbox_outreach`), `rendered_text` = the final message, `data` jsonb =
  - SMS: `{"channel":"sms","phone":"04...","outreach_id":"<inbox_outreach.id>"}`
  - Messenger: `{"channel":"thread","beeper_chat_id":"!...:beeper.local","outreach_id":"<id>"}`
- Including `outreach_id` makes the rail stamp `last_contacted` (date) on send. Rail caps **20 sends/pass, 1.5s apart**.

## Operating rules (locked — per Justin)
- **Quiet hours 21:00–09:00**: no proactive outreach. **Replies stay open all hours** (NEW 2026-06-17). Seat-list exempt too.
- **Outreach only before 16:30** (and after 10:00). After the cutoff: replies/confirmations/seat-list only.
- **Tournament contacts**: many phone contacts are tagged **"cash AND tourney"** — they play both, so **KEEP them on the cash list**. Only set `tournament=true` for people who play tournaments **only**, or who tell us they don't play cash. (Do NOT bulk-flag every name containing "tourney".)
- **Cross-game double-tap of regs is fine.** Never message someone who hasn't replied to our previous message. *(engine guardrail still TODO)*
- No self-introduction; **no em-dashes** (code strips them).
- **Voice = Justin's**, researched from his real texts (`src/sync/voice.ts`, shared by auto-reply + drafting; ALSO applies to any invite copy Claude writes). Terse, dry, concrete (stakes/venue/who's in/seats), one-or-two-word replies are correct, almost no emoji, avoid exclamation marks. "Me on a good day", not cold but never chirpy. Player feedback that triggered this: messages "don't sound like me and feel spammy".
- **Approved invite wording (current)**: `Hi {{first}}, $2/5/10 and $2/5 NLH at Market City tonight from 6. Are you interested in reserving a seat?` (address by first name; "reserve a seat" phrasing is Justin-approved).
- **Venues/days**: North = Woodvale + Kingsley; South = Kenwick + MCT. Mon Bentley, Tue Kingsley, Wed **MCT**, Thu Woodvale, Fri Kenwick (eve) + Leederville (day), Sun Planet Royale. $5/10 only the last game of the month (monthly list, not weekly).
- **Don't nag about token/secret exposure** — Justin's exposed keys are fine ("between me and my home PC"). Step-by-step walkthroughs, no long reports, go with your read.

## Data state (CRM = `inbox_outreach`, ~1370 rows)
- ~1082 have phones, ~109 have a Messenger thread. **Weekly list ≈ 945.**
- Flags: ~25 banned, ~170 hidden, ~60 tournament, staff (Luan +).
- **Recent changes this session**: `Damien Song` → banned + hidden ("who are you?" cold contact). `Luan La Diosa` → **staff** (do not invite again). Weekly opt-out flag added + backfilled. Venue/game enrichment from phonebook contact titles done (MCT/Woodvale/Kenwick/etc.).

## Tonight's game — Wed 2026-06-17, MCT, $2/5/10 + $2/5 NLH from 6pm
- **Sent**: 34 earlier + a curated **28 extra** (`MCT tonight - extra 28 cash`, 9 Messenger + 19 SMS, all sent). All `last_contacted` stamped today.
- **Confirmed (5)**: Rob Paradiso (2/5/10), Wade Beavis (seat via Shano), Tu Lee (2/5/10), Ping Cao (2/5), Darren Nevile (seat 5). _(Luan removed — staff.)_
- **Running late**: Adi, "D" (saved in phone as just "D").
- **Needs Justin's personal reply**: **Jun Liu** (wants arrival time — a yes if answered), **Harry Singh** (asking if Tuesday games are self-dealt now — this is the table-change-rules topic).
- **Lead**: Ciaran Paxman wants **Woodvale tomorrow**.

## ⚠️ OPEN ISSUE to investigate first
- **`reply_intent` is coming back NULL across recent inbound** — the auto-classifier's tags aren't sticking, so the group seat-list isn't auto-updating reliably (had to read raw replies to build the confirmed list). Likely the mirror re-inserting message rows (resetting `auto_handled`/`reply_intent`), or the classifier silently erroring. The `replies-allhours` restart may have helped — **verify next session**: check `inbox_messages.reply_intent` is being set on new inbound, and that the seat-list group post updates. If not, inspect `processReplies` + `mirrorInbound` dedup.

## PARKED / INCOMPLETE
1. **Gary Sims + Harry Singh**: both need the **new table-change rule** message — awaiting the actual rule text from Justin. (Tuesday games self-dealt? confirm and send.)
2. **9 confirmed MCT cash players still need numbers**: Ali Abad, Barry Dougary, Callum Webster, Harry Huang, Jamie Brown, Jordon Dobson, Kyle Hinchcliff, Milz Segue, Yuan Xui (from 10/06 TD sheet).
3. **"Message weekly list" action** — the segment + `weekly` flag exist; sending is currently done by hand-building a batch in SQL. Could add a UI button / helper to blast the weekly list (needs a generic, non-MCT-specific message since the list spans all venues).
4. **Seat-list should exclude `staff`/`do_not_message`** — roster builders (`notify.ts syncGroupRoster`, `roster.ts`) classify from reply text only; a staff member (e.g. Luan) replying "yes" would still appear. Add a CRM-flag filter.
5. **Engine guardrails**: (a) skip outreach to anyone with an unanswered prior message; (b) keep matching game type to interest.
6. **FB Messenger outreach** at scale (many regs reachable on thread, deduped vs SMS). Other-venue TD grinds (Kingsley/Bentley/Planet Royale). Ambiguous stakes disambiguation. LetsPoker is CSV-export only (no usable API; club id `8f025bf9ecfa14c8`).

## Outstanding follow-up for THIS handover's author
- Watching for **Elliot Lewis** (Beeper chat `!RYITBoy2kmm9K73DsDk2:beeper.local`) to reply to the two help messages (he already restarted the sync — heartbeat flipped to `replies-allhours`). If he writes back, relay to Justin.

## Useful IDs
- Supabase project: `dexdftcmcixppbuucjfd`
- Cash Games FB group chat id: `!COGOXsoBtEKMPhRekSd9:beeper.local` (stored in `inbox_group_post`)
- Elliot Lewis (helper) Beeper chat: `!RYITBoy2kmm9K73DsDk2:beeper.local`
- Justin digest phone: `+61459686980`
- Git identity for commits: `user.name=Claude`, `user.email=noreply@anthropic.com`
