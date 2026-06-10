/**
 * Inbound mirror entrypoint — runs on your always-on machine alongside Beeper.
 *
 *   npm run sync          # poll forever
 *   npm run sync:once     # single pass, then exit
 */
import Anthropic from '@anthropic-ai/sdk'
import { env, requireEnv } from '../lib/env'
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

requireEnv(['beeperToken', 'supabaseUrl', 'supabaseServiceKey'])

const adapter = new BeeperAdapter(
  new BeeperClient({
    baseUrl: env.beeperBaseUrl,
    token: env.beeperToken,
    apiVersion: env.beeperApiVersion,
  }),
)

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

async function runOnce(): Promise<void> {
  const since = new Date(Date.now() - env.syncLookbackDays * 86_400_000)
  const r = await mirrorInbound(supabaseAdmin, adapter, since)
  console.log(
    `[mirror ${new Date().toISOString()}] accounts=${r.accounts} chats=${r.chats} scanned=${r.scanned} inserted=${r.inserted}`,
  )

  // LetsPoker App Chats: mirror the player messenger alongside Beeper (no-op
  // until configured). Same normalized pipeline — its threads land in the inbox
  // tagged adapter='letspoker'.
  if (env.letspokerToken) {
    try {
      const lp = await mirrorInbound(supabaseAdmin, letspoker, since)
      console.log(`[letspoker] chats=${lp.chats} scanned=${lp.scanned} inserted=${lp.inserted}`)
    } catch (e) {
      console.error('[letspoker] mirror error:', e instanceof Error ? e.message : e)
    }
  }

  // Phase A: send any drafts the human approved in the UI.
  const out = await processOutbox(supabaseAdmin, adapter)
  if (out.sent || out.failed) {
    console.log(`[outbox] sent=${out.sent} failed=${out.failed}`)
  }

  // Batched variations: send items from any batch the human approved (throttled).
  const batch = await processBatches(supabaseAdmin, adapter)
  if (batch.sent || batch.failed) {
    console.log(`[batch] sent=${batch.sent} failed=${batch.failed}`)
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

  // Auto-reply: thank/acknowledge inbound replies and text Justin who confirmed.
  if (anthropic && env.autoReply) {
    try {
      const rep = await processReplies(
        supabaseAdmin,
        adapter,
        anthropic,
        env.anthropicModel,
        env.autoReplyMaxPerPass,
        env.notifyPhone,
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
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once')
  // Don't let a transient first-pass error (e.g. a dropped Supabase HTTP/2
  // session) kill the whole process — log it and keep looping; the next pass
  // retries. Approved sends are never lost, they just go on a later pass.
  await runOnce().catch((err) => console.error('[mirror] error:', err instanceof Error ? err.message : err))
  if (once) return
  console.log(`[mirror] polling every ${env.syncIntervalMs}ms — Ctrl+C to stop`)
  setInterval(() => {
    runOnce().catch((err) => console.error('[mirror] error:', err instanceof Error ? err.message : err))
  }, env.syncIntervalMs)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
