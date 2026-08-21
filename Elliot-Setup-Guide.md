# WCE Inbox — Desktop Setup (for Elliot)

Hey Elliot — I'm Claude, the assistant that runs Justin's player-messaging system
for West Coast Poker. Justin's away setting up at the venue and asked me to get you
to switch the desktop system on so we can run tonight's cash game list. The PC is
unlocked. This is ~5 minutes, mostly double-clicking. Follow it top to bottom.

If you get stuck, see **"Talk to Claude"** at the bottom — you can paste a briefing
prompt into the Claude window on the desktop and I'll walk you through it live.

---

## 1. Find the project folder
- Open **File Explorer** (might already be open).
- Go to: `C:\Users\justi\WestCoastSocials\wce-unified-inbox`
  (it's the folder that contains a file called **`run-wce.bat`**).

## 2. Start the engine (the sync) — the important one
1. If there's already a black **Command Prompt** window open titled *"WCE … sync"*
   (or full of `[wce]` / `[mirror]` text), **close it** (click the **X**). We only
   ever want **one**.
2. In the folder, **double-click `run-wce.bat`**.
3. A black window opens, shows *"pulling latest code"*, installs, then *"starting sync"*.
   **Leave this window open** (closing it turns everything off).

**Success looks like this** (see the green screen in the image):
```
[drafts]   AI drafting on (model claude-opus-4-8)
[outreach] Airtable CRM sync on (every 10m)
[reply]    auto-reply on  digest texts to +61459686980
[reply]    group "CASH GAMES West Coast Poker" -> !....
[mirror]   accounts=6 chats=160 scanned=20 inserted=3
```
The line `[reply] group "CASH GAMES West Coast Poker" -> ...` is the key one — it
means it found the cash-games group and will post seat lists there. If you see all
of the above, **you're done with the critical part.** Text Justin: *"sync's up."*

## 3. Open the dashboard (optional, nice to have)
1. In the same folder, click the **address bar** at the top, type `powershell`, press **Enter**.
   (A blue window opens, already pointed at the folder.)
2. Type `npm run dev` and press **Enter**. Wait until it says `Local: http://localhost:5173/`.
3. Open **Chrome** and go to `localhost:5173`.

## 4. Make it permanent (so it never dies again)
1. In the folder, **right-click → Open in Terminal** (choose admin/yes if it asks).
2. Paste this and press Enter:
   ```
   powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
   ```
3. It registers the sync to **auto-start on boot** and stops the PC sleeping. That's it.

---

## Troubleshooting
- **`localhost:5173` says "can't be reached"** → the `npm run dev` step (3) isn't running.
  Redo step 3 and make sure you're in the right folder.
- **The black sync window shows red errors over and over** → screenshot it and send Justin.
- **Two black sync windows** → close the extra one. Only one `run-wce.bat`.
- **Beeper** must be open/running for messages to send — if it's closed, open it.

## Talk to Claude (for further info)
There's a Claude window open on the desktop. Paste the **briefing prompt** Justin
sends you into it, and Claude will have the full context of this task and can walk
you through anything. (Justin can also relay questions to me directly.)
