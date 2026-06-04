/**
 * Inbound mirror entrypoint — runs on your always-on machine alongside Beeper.
 *
 *   npm run sync          # poll forever
 *   npm run sync:once     # single pass, then exit
 */
import { env, requireEnv } from '../lib/env'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { BeeperClient } from '../adapters/beeper/client'
import { BeeperAdapter } from '../adapters/beeper/adapter'
import { mirrorInbound } from './mirror'

requireEnv(['beeperToken', 'supabaseUrl', 'supabaseServiceKey'])

const adapter = new BeeperAdapter(
  new BeeperClient({
    baseUrl: env.beeperBaseUrl,
    token: env.beeperToken,
    apiVersion: env.beeperApiVersion,
  }),
)

async function runOnce(): Promise<void> {
  const since = new Date(Date.now() - env.syncLookbackDays * 86_400_000)
  const r = await mirrorInbound(supabaseAdmin, adapter, since)
  console.log(
    `[mirror ${new Date().toISOString()}] accounts=${r.accounts} chats=${r.chats} scanned=${r.scanned} inserted=${r.inserted}`,
  )
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
