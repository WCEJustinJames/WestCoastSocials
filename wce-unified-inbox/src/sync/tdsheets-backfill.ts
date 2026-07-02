/**
 * One-shot TD-sheet backfill — sweeps the last 10 weeks of "DD/MM Venue" sheets
 * into inbox_td_attendees (the live sync only ever reads today + yesterday, so
 * history has holes wherever the sync wasn't running on game night).
 *
 *   npm run tdsheets:backfill
 *
 * Idempotent (upserts on sheet_id+name); safe to re-run. Prints a per-category
 * breakdown after, so it's obvious whether the cash sections are being parsed.
 */
import { env, requireEnv } from '../lib/env'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { syncTdSheets } from './tdsheets'

requireEnv(['supabaseUrl', 'supabaseServiceKey'])
if (!env.googleRefreshToken) {
  console.error('[backfill] GOOGLE_REFRESH_TOKEN is not set in .env')
  process.exit(1)
}

const LOOKBACK_DAYS = 70 // ~10 weeks

async function main(): Promise<void> {
  console.log(`[backfill] sweeping TD sheets from the last ${LOOKBACK_DAYS} days…`)
  const r = await syncTdSheets(
    supabaseAdmin,
    env.googleClientId,
    env.googleClientSecret,
    env.googleRefreshToken,
    LOOKBACK_DAYS,
  )
  console.log(`[backfill] done: ${r.sheets} sheet(s) read, ${r.attendees} attendee row(s) upserted`)

  const { data } = await supabaseAdmin
    .from('inbox_td_attendees')
    .select('venue, category, game_date')
  const byKey = new Map<string, number>()
  for (const row of data ?? []) {
    const k = `${row.venue ?? '(no venue)'} · ${row.category ?? '?'}`
    byKey.set(k, (byKey.get(k) ?? 0) + 1)
  }
  console.log('[backfill] attendance now on record (all time):')
  for (const [k, n] of [...byKey.entries()].sort()) console.log(`  ${k}: ${n}`)
  console.log(
    '[backfill] if cash counts still look thin, the cash sections in the sheets probably use a different header than "Name | Amount | Time" — send Justin/Claude a screenshot of one cash tab and the parser can be taught it.',
  )
}

main().catch((e) => {
  console.error('[backfill] error:', e instanceof Error ? e.message : e)
  process.exit(1)
})
