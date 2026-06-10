# WCE Unified Inbox — Operating Instruction Set

For the Claude window on Justin's desktop (and any operator). Paste this in, or
keep it open. Tonight's job: bring the backend live, then keep it running.

## Who / context
You're assisting West Coast Poker (WCP). Justin is at the venue. Elliot (his
brother) is at the desktop. Get the player-messaging backend up so tonight's cash
list runs, then babysit it.

## Environment
- Project: `C:\Users\justi\WestCoastSocials\wce-unified-inbox` (anchor file: `run-wce.bat`)
- Git branch: `claude/laughing-ritchie-Xmvvk` (run-wce.bat auto-pulls it)
- Backend = `npm run sync` (`tsx src/sync/run.ts`), kept alive by `run-wce.bat`
- UI = `npm run dev` → `localhost:5173`
- **Beeper Desktop must be running** (local API) for any send/receive
- Data lives in Supabase (UI reads; the sync writes)

## Do first — one at a time, confirm each before moving on
1. **One sync only.** Close any existing "WCE sync" black window. Double-click
   `run-wce.bat`. Leave it open. **Success** = log shows `[drafts] AI drafting on`,
   `[outreach] Airtable CRM sync on`, `[reply] auto-reply on`, and within ~20s
   `[reply] group "CASH GAMES West Coast Poker" -> ...` plus `[mirror] ...` lines.
2. (Optional) **UI**: in the folder, address-bar → `powershell` → `npm run dev` → open `localhost:5173`.
3. (Optional) **Permanence**: `powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1` (admin).
4. Tell Justin when the green lines show.

## What the system does
- Sends approved batches over Beeper (SMS via Google Messages + Facebook Messenger), paced ~1.5s, ~20/pass.
- Auto-replies to player replies (yes/no/maybe), texts Justin a confirmed-names digest, and keeps **one live seat-list** posted in the CASH GAMES West Coast Poker FB group (deletes + reposts on change).
- `Cash` playlist (~174 players, CRM `activity='Cash'`) is the master cash list.

## Hard rules — never break
- Player messages: **never introduce yourself or name the business**; assume an existing relationship.
- **Never use an em-dash (—) or en-dash (–)** — comma or full stop only (code also strips them).
- **Only ONE sync window**, ever.
- Keep **Beeper open and connected** — especially the Google Messages/SMS bridge.
- Don't push code or switch branches unless Justin asks.

## Health checks / fixes
- Sync writes a heartbeat each pass; `[mirror]`/`[batch]`/`[reply]` lines = alive.
- **SMS fails but Facebook works** → Google Messages bridge in Beeper is down. Reconnect it (phone paired, Messages app online). This is the #1 cause of "nothing sending".
- **Loop looks frozen** → a Beeper call stalled; sends run before the mirror and time out at 20s, so closing + reopening `run-wce.bat` clears it.

## Escalate to Justin (text him) if
- Red errors keep looping, the SMS bridge won't reconnect, or anything you're unsure about. Don't guess on anything that sends to players.
