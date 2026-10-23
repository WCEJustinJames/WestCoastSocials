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

extractReceipts(supabaseAdmin, beeper, anthropic, env.receiptsModel, limit)
  .then((r) => {
    // "done — processed=0 skipped=0" is what a missing banking group used to
    // look like from here, which reads as "nothing to do" and exits 0. Say what
    // actually happened and fail the exit code, so a scripted or scheduled
    // caller can tell the difference.
    if (!r.chatFound) {
      console.error('\n[receipts] FAILED — banking group not found in the 20 most recent group chats.')
      process.exit(1)
    }
    console.log(`\n[receipts] done — processed=${r.processed} skipped=${r.skipped} errors=${r.errors}`)
    process.exit(r.candidates > 0 && r.processed === 0 && r.errors > 0 ? 1 : 0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
