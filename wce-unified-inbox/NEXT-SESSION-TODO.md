# CRM — next-session to-do

_Captured 2026-06-30. Justin's roadmap for the next working session._

## 1. Restructure HOME into an automated to-do list (tasks from Beeper + emails)
Add an **Action queue** panel to Home that aggregates everything needing Justin:
- inbound replies classified `other` / "needs you" (already escalated by `sync/notify.ts`),
- unread Beeper threads (`inbox_conversations.unread_count`),
- emails (needs an email source — Gmail bridge via Beeper, or a Gmail pull).
Render as a tappable task list (each opens the thread / marks done). Home already
stacks DashboardCards · SyncStatus · FifoDue · PlayerContext · PostGame — this slots in at top.

## 2. Core player lists for cash & tourney, per venue
Standing lists keyed by (venue × cash|tourney). Foundations already exist:
- `inbox_outreach.venues[]` + `cash` / `tournament` flags,
- `inbox_lists` / `inbox_list_members` (PR #7),
- attendance to auto-seed: `lp_entries`/`lp_events` (now live again) + `inbox_td_attendees`,
  via the `player_attendance()` fn — who actually plays cash vs tourney at each venue.

## 3. Automate recurring message lists / schedules per game & active venue
Per venue/game-night: auto-build the recipient list (from #2) + template, on a weekly
cadence, queued for approval. Batches already support venue tags + `scheduled_for`; add a
recurring scheduler (a cron or the desktop sync) that materialises each week's batch.

## 4. Automated message drafting with options to select
Extend AI drafting (`sync/drafting.ts` → `inbox_drafts`, currently reply-only) to
**outreach**: generate N invite variants per game/venue for Justin to pick. The post-game
tool's variation pools (OPENERS/THANKS/WINNER/CLOSERS in `ui/Home.tsx`) are the pattern.

## 5. "Whale" icon — highlight & tailor outreach to priority customers
- New `inbox_outreach.whale` flag (mirror the `fifo` pattern: column + toggle on the
  Players card and the panels + a 🐋 chip by the name).
- Tailor: auto-reply (`notify.ts`) + drafting use a higher-touch tone for whales; outreach
  ranks them first.
- Auto-suggest candidates by value: `lp_entries.winnings` / buy-ins + cash-game frequency
  → flag likely whales for Justin to confirm.

## Further ideas — 12 suggestions (Claude, to consider)

6. **Win-back / lapsing-regular panel.** Surface players whose attendance has dropped
   off a cliff (`lp_churn` view from PR #4 + `player_attendance()`), as a Home panel —
   re-engage them before they're gone. Highest-ROI retention play.
7. **Response & conversion analytics.** Per template / venue / batch: sent → yes/no/maybe
   → conversion %. So Justin sees which wording and venues actually convert. Data is in
   `inbox_batch_items` + `inbox_messages.reply_intent`.
8. **Opt-out (STOP) auto-handling.** Classifier detects "stop / don't text me /
   unsubscribe" and auto-sets `do_not_message`. SMS compliance + goodwill; a new
   `reply_intent` value + a guard.
9. **Player 360 profile.** One click → full history in one place: attendance pattern,
   message thread, venues, rapport, LP winnings, FIFO/whale flags. Today it's scattered.
10. **Duplicate detection & assisted merge.** Proactive fuzzy-dupe finder (we saw Gary
    O'Doherty ×3, Sheldon Ingham ×2) — fragments attendance matching + clutters lists.
    Extend Merge & Review with auto-suggested merges.
11. **Best-time-to-contact learning.** Learn each player's actual response window from
    reply timestamps; schedule sends when they're most likely to reply (we already have
    `contact_day`/`contact_window` fields to populate).
12. **A/B template testing.** Track which invite wording wins (yes-rate per variant) and
    promote it. The batch variation machinery already exists.
13. **New-player onboarding nurture.** First-timers (<N LP games) get a tailored welcome
    sequence to convert them into regulars rather than one-and-done.
14. **Pre-game targeting from the live LP calendar.** Auto-know "tonight = MCT" from
    `lp_events` and pull the right venue list with a one-tap "message tonight's venue".
15. **Relationship-health / sentiment trend.** Score reply tone over time; flag players
    going cold or unhappy so Justin can step in personally before they churn.
16. **Send-health & carrier-safety dashboard.** Volume pacing, daily caps, Beeper bridge
    status, failed-send alerts — keeps high-volume nights safe and visible. (Pairs with
    the pre-send bridge health-check offer below.)
17. **Mobile-friendly action view.** A phone-sized view of the Home action queue +
    re-invites, so Justin can work the CRM from the venue floor.

---
### Carry-over from this session
- **Restart needed**: pull `claude/laughing-ritchie-Xmvvk` + restart `run-wce.bat` to
  activate the classifier changes (return-date `back_on` + absence-reason notes) and all
  the new panels. The LP harvest + attendance views are already live server-side.
- **Open offer**: carry the rose "on ice" shading into the Batches picker + Players card
  (parked players visibly greyed wherever you build lists).
- **Open offer**: pre-send Beeper bridge health-check (pause/alert if Google Messages
  bridge is down, so a dead phone connection can't silently swallow sends).
- **FIFO is manual** — never auto-flag from attendance gaps (that conflates sporadic
  players with roster workers). Pattern explorer is a decision aid only.
