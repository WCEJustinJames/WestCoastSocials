# HANDOVER — WCE Unified Inbox / Player Messaging

**How to use this:** start a FRESH chat and say *"Read wce-unified-inbox/HANDOVER.md and continue."* This doc is the source of truth; the previous chat got too long to be fast.

_Last updated: 2026-06-11 (Thu), mid-afternoon Perth._

---

## Architecture (30-second version)
- **UI**: Vite/React, reads **Supabase** (project `dexdftcmcixppbuucjfd`).
- **Sync**: Node process on Justin's always-on home PC (`run-wce.bat` → `npm run sync`, polls ~15s). It is the ONLY thing that talks to **Beeper Desktop** (localhost) for **SMS (Google Messages)** + **Facebook Messenger**.
- **Cloud Claude has NO direct Beeper access** — it acts only by writing to Supabase (queue `inbox_batches`/items, set flags) and reading results. The PC sync executes them.
- **Git branch**: `claude/laughing-ritchie-Xmvvk`.

## What's LIVE / built
- Inbound mirror; approve-to-send batches; AI drafting.
- **Auto-reply**: classifies inbound (yes/no/maybe/other), auto-acknowledges simple confirm/decline/maybe, escalates anything needing Justin; texts Justin a **confirmed-names digest**; keeps **one live seat-list posted in the "CASH GAMES West Coast Poker" FB group** (delete+repost on change).
- **Messaging rules in code**: no self-introduction; no em-dashes (stripped); **outreach window 10:00–16:30** (`inbox_batches.is_outreach`; replies/confirmations exempt); double-send claim guard; 20s Beeper timeout + sends run before the mirror.
- **Scheduled task** auto-starts the sync on boot, restarts on crash, disables sleep (permanent).
- **Heartbeat** (`inbox_sync_heartbeat`, `note`=SYNC_VERSION) for liveness + which code is running.

## ⚠️ KNOWN ISSUE — desktop on stale code
The desktop sync reports `note='letspoker-inbox-sync'`, `host=null` — that is NOT the latest branch code (latest = `quiet-hours-voice`). So quiet hours, the outreach window and recent fixes are NOT live on the PC (Claude enforces them operationally meanwhile). Per Justin, the working copy is **`Desktop\Claude\Code\Player Messaging\West Coast Game Messaging`** (not `C:\Users\justi\WestCoastSocials`). `run-wce.bat` only pulls on restart, and a restart on 2026-06-11 did NOT flip the version, so the pull isn't landing in that folder.
**Fix:** on the desktop, open a terminal in that folder and run `git pull origin claude/laughing-ritchie-Xmvvk` by hand — the error it prints (wrong branch / local changes / not a repo) is the diagnosis. If it pulls clean: close the sync window + double-click `run-wce.bat`. Fallback: `git fetch origin` then `git reset --hard origin/claude/laughing-ritchie-Xmvvk`. Confirm heartbeat `note` flips to `quiet-hours-voice`.

## Operating rules (locked — per Justin)
- **Hard quiet hours: NO outbound of ANY kind 21:00–09:00** — no batches, drafts, auto-replies, digests or group posts. Nothing exempt. Engine-enforced from code version `quiet-hours-voice` (held sends flush at 09:00); until the desktop runs that version, enforce operationally.
- Outreach only **10:00–16:30**; after that, replies/confirmations/thanks only.
- **Cross-game double-tap of regs is fine.** NEVER message someone who hasn't replied to our previous message (no unanswered pile-up). *(enforce in engine — TODO)*
- **Don't push cash at tournament-predominant players** — match game type to interest. *(enforce in engine — TODO)*
- No self-intro; no em-dashes.
- **Voice = Justin's, researched from his real texts** (see `src/sync/voice.ts`, shared by auto-reply + drafting prompts; ALSO applies to any invite copy Claude writes into batches). Terse, dry, concrete (stakes/venue/who's in/seats left, e.g. "5 handed with Vijay", never "good crowd expected"); one-or-two-word replies are correct; warmth via small acknowledgments, not gush; almost no emoji (rare single 👍/🤣); avoid exclamation marks; "me on a good day", per Justin, not cold but never chirpy. Player feedback that triggered this: messages "don't sound like me and feel spammy".
- **$5/10 runs only the last game of the month** → $5/10-only players are a monthly list, not weekly.
- **Venues**: North = Woodvale + Kingsley; South = Kenwick + MCT. **Days**: Mon Bentley, Tue Kingsley, Wed MCT, Thu Woodvale, Fri Kenwick (evening) + Leederville (daygames), Sun Planet Royale.

## Data state (CRM = `inbox_outreach`)
- `activity='Cash'` segment ≈ 194 players (with numbers); ~1070 rows have phones.
- **LetsPoker**: NO API (cookie-auth GraphQL; data only via CSV export; App Chats can't be a live channel). Player export imported → 56 had mobiles (**29 new added**); full 1950-name roster used to build the games-played **chase list**.
- **Stakes/region tagged**: 60 players (stakes array + region North/South/ALL Areas). 34 ambiguous (shorthand matched >1 record — needs disambiguation). 54 in the stake lists have no number.
- **do_not_message**: Aaron Marshall, Juneyong Park, Carla, "Dylan MCT VM", Mouloud Khenfri, Mike Brown, Daisy, **Hayley Chipun (Chiplin), Jaime Dalton**. Also exclude the **"Bazza Smith" FB thread** (not in CRM, FB-only). **Jason Lei** = on holiday ~3 weeks (noted, NOT banned).

## Active sends (today)
- **Woodvale (Thu) $2/5 + $2/5/10** — 75/76 SMS invites delivered; game 6pm. Confirmed: Paul Derrick, Ling Xu (main table), Ethan Crifo, Dee Gupta (in person), Ali Seif (2/5/10). Replies handled: Ali (straddle), 0418 516 760 (tourney link), James Newberry (seat 7/8), + invited Jerome Brooking, Ciaran Paxman, Zac Pongas, Paul Rhoades. **David Aces** wants last night's MCT winner photos — JUSTIN to send (Claude can't access the image files).
- **Leederville Friday daygame** — ~36 invites **scheduled 8pm tonight** (`is_outreach=false` so it bypasses the cutoff). 3 removed (unanswered Woodvale invite).

## PARKED / INCOMPLETE (priority order)
1. **Fix desktop stale code** (see KNOWN ISSUE) — unblocks the outreach window + all recent code.
2. **Facebook Messenger outreach** — big one. Many chase-list regulars are reachable on Messenger but were never sent game invites (all outreach was SMS): **Danny Poolman (79 games), Gary O'Doherty (64), Brion Weedman, Tom Lab, Prak Sangthong, Jaxon Byrne, Chris Smitton, Vanda Williams, Ciaran Paxman, Jake Connelly**, etc. Fold FB threads into outreach via `channel='thread'`, deduped vs SMS, excluding do_not_message (incl. the Bazza thread). *(Offered to punch tonight's Woodvale to them over Messenger — awaiting Justin's go.)*
3. **Kenwick FC Friday EVENING game (tomorrow)** — grind Friday-Kenwick TD for evening regs, match numbers, schedule a send for **tomorrow daytime** (in-window), worded as the "last Friday-night event until something better comes along." NOT started.
4. **34 ambiguous stakes matches** — disambiguate (two Paul Derricks, multiple Andys/Chrises…).
5. **Chase list** — top players by games with no number (overlaps #2 — many are on Messenger). Justin supplies numbers for the rest (name + contact screenshot → Claude slots in with region/stakes).
6. **Engine guardrails to build**: (a) skip outreach to anyone with an unanswered message; (b) exclude tourney-predominant players from cash sends (needs tourney-vs-cash classification). Need desktop on current code.
7. **Other-venue TD grinds**: Kingsley (Tue), Bentley (Mon), Planet Royale (Sun) not scraped. (MCT + Woodvale + Leederville done.)
8. **Duplicate-number players** — merge (Dee Gupta, Andy Brown, Ethan Crifo, Tu Le have 2+ numbers). **Merge rule**: show the differences between records, default to the mobile that matches the phone's contact list.
9. **Per-game weekly core lists** — proper multi-list/segment backbone (a player can be on MCT + Woodvale + Kenwick). Currently approximated via activity='Cash' + region + stakes.
10. **LetsPoker tournament/event/attendance CSV exports** — not yet pulled (would give per-event attendance + finish tourney-vs-cash classification).

## Justin's working style
Step-by-step walkthroughs, no long reports, go with your read, assume he'll take suggestions. Don't nag about token/secret exposure.

## Useful IDs
- Supabase project: `dexdftcmcixppbuucjfd`
- LetsPoker club id: `8f025bf9ecfa14c8` (admin `wcp.admin.lets.poker`, GraphQL `/api/graphql`, cookie auth — no usable API)
- Cash group resolved chat id starts `!COGOX…` (stored in `inbox_group_post` once a roster posts)
