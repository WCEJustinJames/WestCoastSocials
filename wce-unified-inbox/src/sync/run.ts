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
import { syncOutreach } from './outreach'
import { processReplies } from './notify'

// Bumped on meaningful deploys so we can see (via the heartbeat) which code the
// desktop is actually running, and confirm a restart picked up the latest.
const SYNC_VERSION = 'pass-watchdog'

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
}
if (env.airtableKey) {
  console.log(`[outreach] Airtable CRM sync on (every ${env.outreachSyncMinutes}m)`)
}
if (anthropic && env.autoReply) {
  console.log(`[reply] auto-reply on — digest texts to ${env.notifyPhone}`)
}

// Airtable CRM sync runs on its own slower cadence, not every pass.
let lastOutreachSync = 0

// Log quiet-hours transitions once, not every 15s pass.
let wasQuiet = false

async function runOnce(): Promise<void> {
  const since = new Date(Date.now() - env.syncLookbackDays * 86_400_000)

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
  // every send rail is held — approved drafts, batches, auto-replies, digests,
  // group posts. Nothing is exempt, per Justin. The inbound mirror and AI
  // drafting below still run, so the queue flushes the moment quiet hours end.
  const quiet = inQuietHours()
  if (quiet !== wasQuiet) {
    console.log(
      quiet
        ? '[quiet] quiet hours, holding ALL outbound sends until the window ends'
        : '[quiet] quiet hours over, outbound sends resume',
    )
    wasQuiet = quiet
  }

  // Phase A: send any drafts the human approved in the UI.
  const out = quiet ? { sent: 0, failed: 0 } : await processOutbox(supabaseAdmin, adapter)
  if (out.sent || out.failed) {
    console.log(`[outbox] sent=${out.sent} failed=${out.failed}`)
  }

  // Batched variations: send items from any batch the human approved (throttled).
  const batch = quiet ? { sent: 0, failed: 0 } : await processBatches(supabaseAdmin, adapter)
  if (batch.sent || batch.failed) {
    console.log(`[batch] sent=${batch.sent} failed=${batch.failed}`)
  }

  // Auto-reply: thank/acknowledge inbound replies and text Justin who confirmed.
  if (!quiet && anthropic && env.autoReply) {
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
        notifyGroupChatId,
      )
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
  if (env.airtableKey && Date.now() - lastOutreachSync > env.outreachSyncMinutes * 60_000) {
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

  // AI drafting: suggest replies into inbox_drafts as `pending` for review.
  if (anthropic) {
    const d = await generateDrafts(
      supabaseAdmin,
      anthropic,
      env.anthropicModel,
      env.draftMaxPerPass,
    )
    if (d.generated) {
      console.log(`[drafts] generated=${d.generated} skipped=${d.skipped}`)
    }
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
