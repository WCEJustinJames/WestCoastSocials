/**
 * One-shot receipt extraction — run ON YOUR MACHINE (needs the local Beeper
 * media cache + ANTHROPIC_API_KEY).
 *
 *   npm run receipts             # process up to 10 newest receipt photos
 *   npm run receipts -- 30       # process up to 30
 *
 * Reads photos from the "Poker Banking and Cash Chips" chat, extracts player +
 * mobile + winnings via Claude vision, and saves them to inbox_receipts
 * (review_status='pending'). Dedupes on message id, so re-running is safe.
 */
import Anthropic from '@anthropic-ai/sdk'
import { env, requireEnv } from '../lib/env'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { BeeperClient } from '../adapters/beeper/client'
import { extractReceipts } from './receipts'

requireEnv(['beeperToken', 'anthropicKey', 'supabaseUrl', 'supabaseServiceKey'])

const limit = Number(process.argv[2] ?? 10)
const beeper = new BeeperClient({
  baseUrl: env.beeperBaseUrl,
  token: env.beeperToken,
  apiVersion: env.beeperApiVersion,
})
const anthropic = new Anthropic({ apiKey: env.anthropicKey })

extractReceipts(supabaseAdmin, beeper, anthropic, env.anthropicModel, limit)
  .then((r) => {
    console.log(`\n[receipts] done — processed=${r.processed} skipped=${r.skipped}`)
    process.exit(0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
