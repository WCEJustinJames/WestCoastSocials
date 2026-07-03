/**
 * One-shot TD-sheet backfill — sweeps "DD/MM Venue" sheets into
 * inbox_td_attendees (the live sync only ever reads today + yesterday, so
 * history has holes wherever the sync wasn't running on game night).
 *
 *   npm run tdsheets:backfill            # the last 10 weeks
 *   npm run tdsheets:backfill -- --all   # ENTIRE history (every year of sheets)
 *
 * --all works because the titles carry no year: 366 days of DD/MM needles match
 * every TD sheet ever named, and each file's Drive createdTime anchors its year.
 * Older-than-5-weeks sheets contribute ATTENDANCE ONLY — no transfer lines, so
 * the EFTPOS auto-JL rule can never edit historical sheets. Idempotent (upserts
 * on sheet_id+name); safe to re-run. Expect a long run on --all (throttled to
 * stay under Google quota) — leave the window open.
 */
import { env, requireEnv } from '../lib/env'
import { supabaseAdmin } from '../lib/supabaseAdmin'
import { syncTdSheets } from './tdsheets'

requireEnv(['supabaseUrl', 'supabaseServiceKey'])
if (!env.googleRefreshToken) {
  console.error('[backfill] GOOGLE_REFRESH_TOKEN is not set in .env')
  process.exit(1)
}

const all = process.argv.includes('--all')
const LOOKBACK_DAYS = all ? 366 : 70

async function main(): Promise<void> {
  console.log(all
    ? '[backfill] sweeping the ENTIRE TD-sheet history (all years)…'
    : `[backfill] sweeping TD sheets from the last ${LOOKBACK_DAYS} days…`)
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
    .limit(50000)
  const byKey = new Map<string, number>()
  const byYear = new Map<string, number>()
  for (const row of data ?? []) {
    const k = `${row.venue ?? '(no venue)'} · ${row.category ?? '?'}`
    byKey.set(k, (byKey.get(k) ?? 0) + 1)
    const y = (row.game_date ?? '').slice(0, 4) || '?'
    byYear.set(y, (byYear.get(y) ?? 0) + 1)
  }
  console.log('[backfill] attendance now on record (all time):')
  for (const [k, n] of [...byKey.entries()].sort()) console.log(`  ${k}: ${n}`)
  console.log('[backfill] by year:')
  for (const [k, n] of [...byYear.entries()].sort()) console.log(`  ${k}: ${n}`)
  console.log(
    '[backfill] if cash counts still look thin, the cash sections in the sheets probably use a different header than "Name | Amount | Time" — send Justin/Claude a screenshot of one cash tab and the parser can be taught it.',
  )
}

main().catch((e) => {
  console.error('[backfill] error:', e instanceof Error ? e.message : e)
  process.exit(1)
})
