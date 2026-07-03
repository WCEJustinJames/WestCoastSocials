/**
 * Inbound mirror entrypoint — runs on your always-on machine alongside Beeper.
 *
 *   npm run sync          # poll forever
 *   npm run sync:once     # single pass, then exit
 */
import os from 'node:os'
import Anthropic from '@anthropic-ai/sdk'
import { env, requireEnv, inQuietHours } from '../lib/env'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { BeeperClient } from '../adapters/beeper/client'
import { BeeperAdapter } from '../adapters/beeper/adapter'
import { LetsPokerClient } from '../adapters/letspoker/client'
import { LetsPokerAdapter } from '../adapters/letspoker/adapter'
import { mirrorInbound } from './mirror'
import { processOutbox } from './outbox'
import { processBatches } from './batches'
import { generateDrafts } from './drafting'
import { generateInviteVariants } from './variants'
import { syncOutreach } from './outreach'
import { syncGoogleContacts } from './contacts'
import { syncGmail } from './email'
import { syncTdSheets, processTransferConfirms } from './tdsheets'
import { autoLink } from './autolink'
import { matchFbFriends } from './fbmatch'
import { processReplies } from './notify'
import { postSeatList } from './roster'
import { newAiHealth, trackAiHealth, worstOutcome, type AiOutcome } from './alert'
import { getSettings } from './settings'
import { processOptOuts } from './optout'
import { publishSocialPosts } from './social'
import { processKlaviyoPushes } from './klaviyo'
import { generateSocialPromos } from './socialauto'

// Bumped on meaningful deploys so we can see (via the heartbeat) which code the
// desktop is actually running, and confirm a restart picked up the latest.
const SYNC_VERSION = 'g40-lp-banner'

requireEnv(['beeperToken', 'supabaseUrl', 'supabaseServiceKey'])

// Print which Supabase key actually got loaded (a Windows system env var can
// silently shadow .env, since dotenv never overrides existing process env).
{
  const k = env.supabaseServiceKey
  const kind = k.startsWith('sb_secret_')
    ? 'secret, correct'
    : k.startsWith('sb_publishable_')
      ? 'PUBLISHABLE, WRONG KEY'
      : k.startsWith('eyJ')
        ? 'legacy jwt'
        : 'unrecognised'
  console.log(`[env] supabase url: ${env.supabaseUrl}`)
  console.log(`[env] service key: ${k.slice(0, 18)}... (${kind})`)
}

const beeperClient = new BeeperClient({
  baseUrl: env.beeperBaseUrl,
  token: env.beeperToken,
  apiVersion: env.beeperApiVersion,
})
const adapter = new BeeperAdapter(beeperClient)

// Resolved lazily (group chat id for posting confirmations), cached once found.
let notifyGroupChatId: string | null = null
// One resolve attempt per process for the standalone (non-AI) group lookup.
let groupResolveTried = false

// LetsPoker App Chats — opt-in, only mirrors once LETSPOKER_TOKEN is set.
const letspoker = new LetsPokerAdapter(
  new LetsPokerClient({
    baseUrl: env.letspokerBaseUrl,
    token: env.letspokerToken,
    clubId: env.letspokerClubId,
    chatsPath: env.letspokerChatsPath,
    messagesPath: env.letspokerMessagesPath,
    sendPath: env.letspokerSendPath,
    entrantsPath: env.letspokerEntrantsPath,
  }),
)
if (env.letspokerToken) {
  console.log('[letspoker] App Chats mirror on')
}

// AI drafting is opt-in: only runs when ANTHROPIC_API_KEY is set.
const anthropic = env.anthropicKey ? new Anthropic({ apiKey: env.anthropicKey }) : null
if (anthropic) {
  console.log(`[drafts] AI drafting on (model ${env.anthropicModel}, max ${env.draftMaxPerPass}/pass)`)
} else if (env.autoReply) {
  console.warn('[ai] ANTHROPIC_API_KEY not set — auto-reply + drafting are OFF (alerter will text Justin)')
}
if (env.airtableSync && env.airtableKey) {
  console.log(`[outreach] Airtable CRM sync on (every ${env.outreachSyncMinutes}m)`)
} else {
  console.log('[outreach] Airtable retired — Supabase inbox_outreach is the source of truth')
}
if (env.googleRefreshToken) {
  console.log(`[contacts] Google Contacts sync on (every ${env.contactsSyncMinutes}m)`)
  console.log(`[tdsheets] TD-sheet attendee pull on (every ${env.tdSheetsSyncMinutes}m)`)
  console.log('[email] Gmail inbox pull on (every 10m, needs gmail.readonly on the token)')
}
console.log(`[autolink] name-match auto-linker on (every ${env.autoLinkMinutes}m)`)
console.log(
  env.postizKey
    ? `[social] Postiz publishing on (${env.postizUrl})`
    : '[social] Postiz key not set — Social-tab posts hold as scheduled until POSTIZ_API_KEY lands in .env',
)
console.log(
  env.klaviyoKey
    ? '[klaviyo] Klaviyo blast prep on'
    : '[klaviyo] Klaviyo key not set — queued blasts hold until KLAVIYO_API_KEY lands in .env',
)
if (anthropic && env.autoReply) {
  console.log(`[reply] auto-reply on — digest texts to ${env.notifyPhone}`)
}

// Airtable CRM sync runs on its own slower cadence, not every pass.
let lastOutreachSync = 0
// Google Contacts sync also runs on a slow cadence (default twice a day).
let lastContactsSync = 0
// TD-sheet attendee pull runs on its own slow cadence.
let lastTdSheets = 0
// Name-match auto-linker runs on its own slow cadence too.
let lastAutoLink = 0
// FB-friend re-match runs on the same slow cadence.
let lastFbMatch = 0
// Invite-variant generation runs on a slow (~hourly) cadence.
let lastVariants = 0
// Gmail action-queue pull runs every ~10 minutes.
let lastEmailSync = 0
// Social publishing + Klaviyo blast prep check every ~2 minutes (both are a
// single cheap select when nothing is due/queued).
let lastMarketing = 0
// Game-week promo generator runs a few times a day (idempotent via source_key).
let lastSocialAuto = 0

// Log quiet-hours transitions once, not every 15s pass.
let wasQuiet = false

// Log kill-switch transitions once, not every pass.
let wasPaused = false
let wasRepliesPaused = false

// In-memory AI-health tracker for the fail-loud alerter. Resets on restart,
// which is fine: a process that comes back still broken should re-alert once.
const aiHealth = newAiHealth()

async function runOnce(): Promise<void> {
  const since = new Date(Date.now() - env.syncLookbackDays * 86_400_000)

  // Outcomes of this pass's Anthropic calls, fed to the fail-loud alerter below.
  let replyAi: AiOutcome | undefined
  let draftAi: AiOutcome | undefined

  // Heartbeat first, so liveness reflects the loop turning even when the mirror
  // (below) is slow. Best-effort, but log failures — a silently dead heartbeat
  // cost hours of debugging once.
  try {
    await (supabaseAdmin as unknown as {
      from: (t: string) => { upsert: (v: unknown) => Promise<{ error?: { message?: string } | null }> }
    })
      .from('inbox_sync_heartbeat')
      .upsert({ id: 1, last_run: new Date().toISOString(), host: os.hostname(), note: SYNC_VERSION })
      .then((r) => {
        if (r?.error) console.error('[heartbeat] write failed:', r.error.message ?? r.error)
      })
  } catch (e) {
    console.error('[heartbeat] write failed:', e instanceof Error ? e.message : e)
  }

  // SENDS FIRST. A slow or hung inbound mirror must never delay approved sends
  // again (one stuck Beeper call after downtime once blocked every text for
  // hours). Everything that sends runs before the mirror.

  // Hard quiet hours: between QUIET_START and QUIET_END (default 21:00-09:00)
  // proactive OUTREACH is held — approved drafts and batches. EXEMPT, per Justin:
  // the auto-reply path and the live seat-list, so a player who replies is always
  // answered (even a "no", even at night) and the roster stays current through a
  // late game. The inbound mirror and AI drafting below also run, so anything held
  // flushes the moment quiet hours end.
  const quiet = inQuietHours()
  if (quiet !== wasQuiet) {
    console.log(
      quiet
        ? '[quiet] quiet hours, holding ALL outbound sends until the window ends'
        : '[quiet] quiet hours over, outbound sends resume',
    )
    wasQuiet = quiet
  }

  // Global send KILL-SWITCH (inbox_settings.sends_paused). Checked every pass so
  // sends can be halted instantly from the UI / SQL / cloud without restarting the
  // PC. Gates ALL outbound below, including the quiet-hours-exempt auto-reply and
  // seat-list. Fails open (see getSettings) so a DB blip can't wedge sends.
  const { sendsPaused, repliesPaused, rosterPaused, smsBridgeDown } = await getSettings(supabaseAdmin)
  if (sendsPaused !== wasPaused) {
    console.log(sendsPaused ? '[paused] sends_paused ON, holding ALL outbound' : '[paused] sends_paused OFF, outbound resumes')
    wasPaused = sendsPaused
  }
  // Independent replies switch: pauses ONLY the AI auto-reply rail below, while
  // proactive outreach keeps running. The master sends_paused still gates replies
  // too, so the auto-reply is held when EITHER flag is on.
  if (repliesPaused !== wasRepliesPaused) {
    console.log(repliesPaused ? '[paused] replies_paused ON, auto-replies held' : '[paused] replies_paused OFF, auto-replies resume')
    wasRepliesPaused = repliesPaused
  }

  // Resolve + store the Cash Games group chat id once per process, independent
  // of the AI auto-reply layer, so seat-list rosters can be posted to it from
  // the cloud (a batch item with channel='thread' targeting this chat). This is
  // a lookup + DB write, not a player send, so quiet hours don't apply.
  if (env.notifyGroupName && !notifyGroupChatId && !groupResolveTried) {
    groupResolveTried = true
    try {
      notifyGroupChatId = await beeperClient.resolveGroupChatId(env.notifyGroupName)
      if (notifyGroupChatId) {
        console.log(`[group] "${env.notifyGroupName}" -> ${notifyGroupChatId}`)
        await (supabaseAdmin as unknown as {
          from: (t: string) => { upsert: (v: unknown) => Promise<{ error?: { message?: string } | null }> }
        })
          .from('inbox_group_post')
          .upsert({ id: 1, chat_id: notifyGroupChatId })
          .then((r) => { if (r?.error) console.error('[group] store failed:', r.error.message ?? r.error) })
      } else {
        console.warn(`[group] "${env.notifyGroupName}" not found — bump it in Beeper so it shows in recent group chats, then restart`)
      }
    } catch (e) {
      console.error('[group] resolve error:', e instanceof Error ? e.message : e)
    }
  }

  // Keep the live confirmed seat list posted in the cash-games group. Per Justin
  // this is the deliberate EXCEPTION to both the 4:30pm outreach cutoff AND quiet
  // hours: a game runs into the night, so the seat list must stay current the
  // whole time. It can't spam — it only delete+reposts when the roster actually
  // changes. Runs only when the AI auto-reply is OFF (otherwise that path owns
  // the roster).
  if (!sendsPaused && !rosterPaused && !anthropic && notifyGroupChatId && env.rosterKeywordFallback) {
    try {
      await postSeatList(supabaseAdmin, adapter, notifyGroupChatId)
    } catch (e) {
      console.error('[roster] error:', e instanceof Error ? e.message : e)
    }
  }

  // Phase A: send any drafts the human approved in the UI.
  const out = (quiet || sendsPaused) ? { sent: 0, failed: 0 } : await processOutbox(supabaseAdmin, adapter)
  if (out.sent || out.failed) {
    console.log(`[outbox] sent=${out.sent} failed=${out.failed}`)
  }

  // Batched variations: send items from any batch the human approved (throttled).
  const batch = (quiet || sendsPaused) ? { sent: 0, failed: 0 } : await processBatches(supabaseAdmin, adapter, smsBridgeDown)
  if (batch.sent || batch.failed) {
    console.log(`[batch] sent=${batch.sent} failed=${batch.failed}`)
  }

  // Auto opt-out: honour stop / unsubscribe / cold-contact replies (keyword-based,
  // no AI needed). Flags the CRM row do_not_message and escalates to Justin, and
  // marks the message handled so the auto-reply never acknowledges an opt-out. Runs
  // before the auto-reply, regardless of quiet hours / kill-switch — it's protective
  // plus an operator alert, not a player send.
  try {
    const oo = await processOptOuts(supabaseAdmin, adapter, env.notifyPhone)
    if (oo.flagged || oo.escalated) {
      console.log(`[optout] flagged=${oo.flagged} escalated=${oo.escalated}`)
    }
  } catch (e) {
    console.error('[optout] error:', e instanceof Error ? e.message : e)
  }

  // Auto-reply: thank/acknowledge inbound replies and text Justin who confirmed.
  // NOT gated by quiet hours, per Justin: if a player takes the time to get back
  // to us we answer them whatever the hour. This path is purely reactive (only
  // responds to people who just messaged, never proactively outreaches), so it's
  // safe to run any time. The 4:30pm cutoff never applied here either — it only
  // gates outreach batches above. Per Justin it is ALSO exempt from the master
  // STOP (sends_paused): hitting STOP halts proactive outreach, but auto-replies
  // keep answering players who message in. Only the dedicated replies switch
  // (replies_paused) pauses this rail.
  if (!repliesPaused && anthropic && env.autoReply) {
    // Resolve the cash-games group once (so confirmations can be posted there).
    if (env.notifyGroupName && !notifyGroupChatId) {
      try {
        notifyGroupChatId = await beeperClient.resolveGroupChatId(env.notifyGroupName)
        if (notifyGroupChatId) {
          console.log(`[reply] group "${env.notifyGroupName}" -> ${notifyGroupChatId}`)
        }
      } catch (e) {
        console.error('[reply] group resolve error:', e instanceof Error ? e.message : e)
      }
    }
    try {
      const rep = await processReplies(
        supabaseAdmin,
        adapter,
        anthropic,
        env.anthropicModel,
        env.autoReplyMaxPerPass,
        env.notifyPhone,
        rosterPaused ? null : notifyGroupChatId,
      )
      replyAi = rep.ai
      if (rep.replied || rep.confirmed || rep.escalated) {
        console.log(
          `[reply] replied=${rep.replied} confirmed=${rep.confirmed} escalated=${rep.escalated}`,
        )
      }
    } catch (e) {
      console.error('[reply] error:', e instanceof Error ? e.message : e)
    }
  }

  // Player Outreach CRM: mirror Airtable on a slow cadence (not every pass).
  // Retired by default — only runs when AIRTABLE_SYNC=1 is explicitly set, so a
  // stale key lingering in .env never reawakens it (or spams 401s into the log).
  if (env.airtableSync && env.airtableKey && Date.now() - lastOutreachSync > env.outreachSyncMinutes * 60_000) {
    lastOutreachSync = Date.now()
    try {
      const o = await syncOutreach(
        supabaseAdmin,
        env.airtableKey,
        env.airtableBaseId,
        env.airtableOutreachTable,
      )
      console.log(`[outreach] synced=${o.synced} players from Airtable`)
    } catch (e) {
      console.error('[outreach] sync error:', e instanceof Error ? e.message : e)
    }
  }

  // Google Contacts: pull newly-added contacts into the CRM on a slow cadence,
  // so numbers Justin saves in person show up for outreach without a CSV export.
  if (env.googleRefreshToken && Date.now() - lastContactsSync > env.contactsSyncMinutes * 60_000) {
    lastContactsSync = Date.now()
    try {
      const gc = await syncGoogleContacts(
        supabaseAdmin,
        env.googleClientId,
        env.googleClientSecret,
        env.googleRefreshToken,
      )
      if (gc.created) console.log(`[contacts] ${gc.created} new contact(s) imported (${gc.autoHidden} auto-hidden as non-person, ${gc.scanned} changed)`)
    } catch (e) {
      console.error('[contacts] sync error:', e instanceof Error ? e.message : e)
    }
  }

  // Gmail: mirror unread inbox emails for the Home action queue (read-only; the
  // queue's "done" never touches Gmail). No-op until the refresh token carries the
  // gmail.readonly scope — the module detects that and logs the fix once.
  if (env.googleRefreshToken && Date.now() - lastEmailSync > 10 * 60_000) {
    lastEmailSync = Date.now()
    try {
      const em = await syncGmail(supabaseAdmin, env.googleClientId, env.googleClientSecret, env.googleRefreshToken)
      if (em.inserted) console.log(`[email] ${em.inserted} new unread email(s) mirrored (${em.scanned} unread)`)
    } catch (e) {
      console.error('[email] sync error:', e instanceof Error ? e.message : e)
    }
  }

  // TD sheets: pull tonight's attendees (cash players, tournament winners, and
  // electronic-paying tournament entrants) from the "DD/MM Venue" Google Sheets
  // into inbox_td_attendees, so the post-game tool has them one tap away.
  if (env.googleRefreshToken && Date.now() - lastTdSheets > env.tdSheetsSyncMinutes * 60_000) {
    lastTdSheets = Date.now()
    try {
      const td = await syncTdSheets(
        supabaseAdmin,
        env.googleClientId,
        env.googleClientSecret,
        env.googleRefreshToken,
      )
      if (td.attendees) console.log(`[tdsheets] ${td.attendees} attendee(s) from ${td.sheets} sheet(s)`)
      // Heartbeat (id=2) so the dashboard's TD-sheets indicator shows its last run.
      await supabaseAdmin
        .from('inbox_sync_heartbeat')
        .upsert({ id: 2, last_run: new Date().toISOString(), host: os.hostname(), note: `tdsheets ${td.sheets}/${td.attendees}` })
    } catch (e) {
      console.error('[tdsheets] sync error:', e instanceof Error ? e.message : e)
    }
  }

  // Transfer confirmations: write queued JL initials (+ receipt refs) back into
  // the TD sheets. Cheap when nothing is queued; a read-only token logs once.
  if (env.googleRefreshToken) {
    try {
      const tw = await processTransferConfirms(
        supabaseAdmin, env.googleClientId, env.googleClientSecret, env.googleRefreshToken,
      )
      if (tw.written) console.log(`[transfers] wrote ${tw.written} JL confirmation(s) back to the sheets`)
    } catch (e) {
      console.error('[transfers] write-back error:', e instanceof Error ? e.message : e)
    }
  }

  // Auto-linker: reconnect no-contact players to their existing Beeper thread,
  // and fill missing phones from another record — by exact, unique name match.
  if (Date.now() - lastAutoLink > env.autoLinkMinutes * 60_000) {
    lastAutoLink = Date.now()
    try {
      const al = await autoLink(supabaseAdmin)
      if (al.threadsLinked || al.phonesFilled) {
        console.log(`[autolink] linked ${al.threadsLinked} thread(s), filled ${al.phonesFilled} phone(s)`)
      }
    } catch (e) {
      console.error('[autolink] error:', e instanceof Error ? e.message : e)
    }
  }

  // FB-friend re-match: keep the fb_friend flag current as new players land, from
  // the stored friends list (the in-app importer writes it). No-op until imported.
  if (Date.now() - lastFbMatch > env.autoLinkMinutes * 60_000) {
    lastFbMatch = Date.now()
    try {
      const fm = await matchFbFriends(supabaseAdmin)
      if (fm.flagged || fm.cleared) console.log(`[fbmatch] flagged ${fm.flagged}, cleared ${fm.cleared}`)
    } catch (e) {
      console.error('[fbmatch] error:', e instanceof Error ? e.message : e)
    }
  }

  // AI drafting: suggest replies into inbox_drafts as `pending` for review.
  if (anthropic) {
    const d = await generateDrafts(
      supabaseAdmin,
      anthropic,
      env.anthropicModel,
      env.draftMaxPerPass,
    )
    draftAi = d.ai
    if (d.generated) {
      console.log(`[drafts] generated=${d.generated} skipped=${d.skipped}`)
    }
  }

  // Game-week social autopilot: draft the week's promo posts (day-before +
  // morning-of per scheduled game) onto the Social calendar for approval.
  // Idempotent, so the 6h cadence just tops up whatever's missing.
  if (anthropic && Date.now() - lastSocialAuto > 6 * 60 * 60_000) {
    lastSocialAuto = Date.now()
    try {
      const sa = await generateSocialPromos(supabaseAdmin, anthropic, env.anthropicModel)
      if (sa.created) console.log(`[socialauto] ${sa.created} promo draft(s) added`)
    } catch (e) {
      console.error('[socialauto] error:', e instanceof Error ? e.message : e)
    }
  }

  // Invite variants: pre-write 3 invite options per venue for the Batches picker.
  if (anthropic && Date.now() - lastVariants > 60 * 60_000) {
    lastVariants = Date.now()
    try {
      const v = await generateInviteVariants(supabaseAdmin, anthropic, env.anthropicModel)
      if (v.generated) console.log(`[variants] generated ${v.generated} invite(s) across ${v.venues} venue(s)`)
    } catch (e) {
      console.error('[variants] error:', e instanceof Error ? e.message : e)
    }
  }

  // Marketing rail: publish due Social-tab posts through Postiz and build
  // Klaviyo lists for queued blasts. Not player DMs, so quiet hours and the
  // outreach window don't apply — but the master STOP still holds them, since
  // "stop everything" should mean everything outbound.
  if (!sendsPaused && Date.now() - lastMarketing > 2 * 60_000) {
    lastMarketing = Date.now()
    try {
      const sp = await publishSocialPosts(supabaseAdmin, env.postizUrl, env.postizKey)
      if (sp.published || sp.rolled) console.log(`[social] published=${sp.published} rolled=${sp.rolled}`)
    } catch (e) {
      console.error('[social] error:', e instanceof Error ? e.message : e)
    }
    try {
      const kp = await processKlaviyoPushes(supabaseAdmin, env.klaviyoKey)
      if (kp.prepared) console.log(`[klaviyo] prepared=${kp.prepared} blast list(s)`)
    } catch (e) {
      console.error('[klaviyo] error:', e instanceof Error ? e.message : e)
    }
  }

  // Fail-loud: text Justin once when the AI layer goes dark — almost always a
  // bad/expired Anthropic key — so it surfaces in minutes instead of staying
  // silently quiet for days. Exempt from quiet hours: it's an operator alert to
  // his own phone, not a player send. A MISSING key makes no calls at all (so
  // there's nothing to "fail"), but the layer is just as dark — so when AI is
  // expected on (autoReply) yet unconfigured, treat that as a hard failure too.
  const aiSignal: AiOutcome | undefined = anthropic
    ? worstOutcome(replyAi, draftAi)
    : env.autoReply
      ? { ok: false, hard: true, message: 'ANTHROPIC_API_KEY is not set, auto-reply + drafting are disabled' }
      : undefined
  try {
    await trackAiHealth(aiHealth, aiSignal, adapter, env.notifyPhone)
  } catch (e) {
    console.error('[alert] tracker error:', e instanceof Error ? e.message : e)
  }

  // Inbound mirror LAST. Each Beeper request is now bounded by a timeout, so a
  // stuck call can't freeze the loop; and running after the sends means a slow
  // mirror never holds them up.
  try {
    const r = await mirrorInbound(supabaseAdmin, adapter, since)
    console.log(
      `[mirror ${new Date().toISOString()}] accounts=${r.accounts} chats=${r.chats} scanned=${r.scanned} inserted=${r.inserted}`,
    )
  } catch (e) {
    console.error('[mirror] error:', e instanceof Error ? e.message : e)
  }

  // LetsPoker App Chats: mirror alongside Beeper (no-op until configured).
  if (env.letspokerToken) {
    try {
      const lp = await mirrorInbound(supabaseAdmin, letspoker, since)
      console.log(`[letspoker] chats=${lp.chats} scanned=${lp.scanned} inserted=${lp.inserted}`)
    } catch (e) {
      console.error('[letspoker] mirror error:', e instanceof Error ? e.message : e)
    }
  }
}

// Hard ceiling on a single pass. A wedged Beeper/Supabase call (e.g. a dropped
// HTTP/2 session, or a huge first-run mirror backlog) must never stall the loop:
// if a pass exceeds this, we log and schedule the next one anyway. Approved
// sends run first and are claimed atomically, so a slow pass overlapping the
// next can't double-send. Comfortably above a healthy pass (~20 sends x 1.5s
// plus the mirror).
const PASS_TIMEOUT_MS = 120_000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(t)) as Promise<T>
}

async function main(): Promise<void> {
  if (process.argv.includes('--once')) {
    await runOnce().catch((e) => console.error('[pass] error:', e instanceof Error ? e.message : e))
    return
  }
  console.log(`[mirror] polling every ${env.syncIntervalMs}ms — Ctrl+C to stop`)
  // Self-scheduling loop. The NEXT pass is always scheduled in `finally`, even
  // if this one throws or times out — so the loop can never get stuck the way a
  // blocking first-pass await (which never reaches the interval setup) or a
  // frozen pass could. This is the fix for "sent 20 then froze forever".
  const tick = (): void => {
    withTimeout(runOnce(), PASS_TIMEOUT_MS, 'pass')
      .catch((e) => console.error('[pass] error/timeout:', e instanceof Error ? e.message : e))
      .finally(() => setTimeout(tick, env.syncIntervalMs))
  }
  tick()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
