import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

type DB = SupabaseClient<Database>

export interface FbMatchResult {
  flagged: number
  cleared: number
}

// Poker/venue noise operators append to CRM names — stripped so a clean Facebook
// name still lines up. Kept in sync with the same lists in ui/usePlayers.ts.
const NAME_NOISE =
  /\b(poker|holdem|cash|tourney|tournament|nlh|plo|mtt|mct|woodvale|kenwick|bentley|kingsley|leederville|leedy|stirling|adriatic|kwinana|southside|north|south|central|east|west|hotel|tavern|club|bowls|president|dealer|reserve|home|game|games|player)\b/g
const normFull = (raw: string): string =>
  raw.toLowerCase().replace(/\$\s*\d[\d/]*/g, ' ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
const normCore = (raw: string): string =>
  normFull(raw).replace(NAME_NOISE, ' ').replace(/\s+/g, ' ').trim()

type Row = { id: string; player_name: string | null; fb_friend: boolean | null }

/**
 * Re-match the stored Facebook friends list (written by the in-app importer into
 * inbox_fb_friends) against the whole CRM, so a player added AFTER the last import
 * — by the TD/contacts/Airtable syncs — still gets the fb_friend flag if they're a
 * friend, and anyone no longer on the list is cleared. Runs on a slow cadence; the
 * import itself still does an immediate match for instant feedback. No-op when no
 * list has been imported yet.
 */
export async function matchFbFriends(db: DB): Promise<FbMatchResult> {
  const { data: row } = await db.from('inbox_fb_friends').select('names').eq('id', 1).maybeSingle()
  const names = ((row?.names as unknown as string[] | null) ?? []).filter((n) => typeof n === 'string')
  if (!names.length) return { flagged: 0, cleared: 0 }

  const friendKeys = new Set<string>()
  for (const n of names) {
    const a = normFull(n), b = normCore(n)
    if (a.length >= 3) friendKeys.add(a)
    if (b.length >= 3) friendKeys.add(b)
  }

  const players: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data } = await db
      .from('inbox_outreach')
      .select('id, player_name, fb_friend')
      .range(from, from + 999)
    const r = (data as Row[]) ?? []
    players.push(...r)
    if (r.length < 1000) break
  }

  const toTrue: string[] = []
  const toFalse: string[] = []
  for (const p of players) {
    if (!p.player_name) continue
    const a = normFull(p.player_name), b = normCore(p.player_name)
    const isFriend = (a.length >= 3 && friendKeys.has(a)) || (b.length >= 3 && friendKeys.has(b))
    if (isFriend && !p.fb_friend) toTrue.push(p.id)
    else if (!isFriend && p.fb_friend) toFalse.push(p.id)
  }

  for (let i = 0; i < toTrue.length; i += 500)
    await db.from('inbox_outreach').update({ fb_friend: true }).in('id', toTrue.slice(i, i + 500))
  for (let i = 0; i < toFalse.length; i += 500)
    await db.from('inbox_outreach').update({ fb_friend: false }).in('id', toFalse.slice(i, i + 500))

  return { flagged: toTrue.length, cleared: toFalse.length }
}
