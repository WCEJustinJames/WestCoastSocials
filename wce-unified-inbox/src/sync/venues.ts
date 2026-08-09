import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

/**
 * Venues, and the many ways a TD writes them down.
 *
 * This used to be two hardcoded maps — a regex list in notify.ts for reading
 * the venue out of an invite, and an alias table in outreach.ts for folding CRM
 * values onto a canonical name. Keeping them in the code meant opening a room
 * needed a deploy, and it meant the two lists could disagree. They now come
 * from inbox_venues, the same rows the dashboard's venue manager edits, so an
 * alias typed into the UI is honoured by the engine on its next refresh.
 */

export interface Venue {
  name: string
  aliases: string[]
}

// Refreshed on a slow cadence: an alias added in the dashboard is live within
// ten minutes, and a database hiccup doesn't cost us the list we already have.
const TTL_MS = 10 * 60_000
let cache: Venue[] = []
let cachedAt = 0

type DB = SupabaseClient<Database>

export async function loadVenues(db: DB): Promise<Venue[]> {
  if (cache.length && Date.now() - cachedAt < TTL_MS) return cache
  const { data, error } = await db
    .from('inbox_venues')
    .select('name, aliases')
    .eq('active', true)
  if (error || !data) {
    // Keep serving the last good list rather than silently matching nothing —
    // a venue that stops being recognised turns every digest line into an
    // unlabelled name, which reads as "no game" rather than "lookup failed".
    console.error('[venues] load failed, using the cached list:', error?.message)
    return cache
  }
  cache = data
  cachedAt = Date.now()
  return cache
}

/** Force a refresh on the next call — for tests and manual re-syncs. */
export function clearVenueCache(): void {
  cache = []
  cachedAt = 0
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The canonical venue named in a piece of free text (an invite, a reply).
 * Longest match wins, so "Planet Royale" isn't beaten by a shorter alias that
 * happens to sit inside it.
 */
export function venueFromText(text: string, venues: Venue[]): string | null {
  let best: { v: string; len: number } | null = null
  for (const v of venues) {
    for (const needle of [v.name, ...v.aliases]) {
      if (!needle) continue
      // Word-bounded: "MCT" must not fire on "MCTavern", and a two-letter alias
      // must not fire on a fragment of someone's name.
      const re = new RegExp(`\\b${esc(needle)}\\b`, 'i')
      if (re.test(text) && (!best || needle.length > best.len)) best = { v: v.name, len: needle.length }
    }
  }
  return best?.v ?? null
}

/**
 * Fold one recorded value onto its canonical venue. Unknown values pass through
 * untouched — a venue nobody has registered yet is data we keep, not data we
 * throw away.
 */
export function canonVenue(raw: string, venues: Venue[]): string {
  const t = raw.trim()
  if (!t) return t
  const lower = t.toLowerCase()
  for (const v of venues) {
    if (v.name.toLowerCase() === lower) return v.name
    if (v.aliases.some((a) => a.toLowerCase() === lower)) return v.name
  }
  return t
}

export function canonVenues(raws: string[], venues: Venue[]): string[] {
  const out: string[] = []
  for (const r of raws) {
    const c = canonVenue(r, venues)
    if (c && !out.includes(c)) out.push(c)
  }
  return out
}
