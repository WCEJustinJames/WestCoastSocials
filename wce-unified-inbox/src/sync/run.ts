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
import { mirrorInbound } from './mirror'
import { processOutbox } from './outbox'
import { processBatches } from './batches'
import { generateDrafts } from './drafting'
import { syncOutreach } from './outreach'

requireEnv(['beeperToken', 'supabaseUrl', 'supabaseServiceKey'])

const adapter = new BeeperAdapter(
  new BeeperClient({
    baseUrl: env.beeperBaseUrl,
    token: env.beeperToken,
    apiVersion: env.beeperApiVersion,
  }),
)

// AI drafting is opt-in: only runs when ANTHROPIC_API_KEY is set.
const anthropic = env.anthropicKey ? new Anthropic({ apiKey: env.anthropicKey }) : null
if (anthropic) {
  console.log(`[drafts] AI drafting on (model ${env.anthropicModel}, max ${env.draftMaxPerPass}/pass)`)
}
if (env.airtableKey) {
  console.log(`[outreach] Airtable CRM sync on (every ${env.outreachSyncMinutes}m)`)
}

// Airtable CRM sync runs on its own slower cadence, not every pass.
let lastOutreachSync = 0

async function runOnce(): Promise<void> {
  const since = new Date(Date.now() - env.syncLookbackDays * 86_400_000)
  const r = await mirrorInbound(supabaseAdmin, adapter, since)
  console.log(
    `[mirror ${new Date().toISOString()}] accounts=${r.accounts} chats=${r.chats} scanned=${r.scanned} inserted=${r.inserted}`,
  )

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
  await runOnce()
  if (once) return
  console.log(`[mirror] polling every ${env.syncIntervalMs}ms — Ctrl+C to stop`)
  setInterval(() => {
    runOnce().catch((err) => console.error('[mirror] error:', err))
  }, env.syncIntervalMs)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
