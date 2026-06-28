import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

type DB = SupabaseClient<Database>

export interface AutoLinkResult {
  threadsLinked: number
  phonesFilled: number
}

// Strip the venue / stake / game-type noise operators append to contact names so
// two records for the same person line up (e.g. "Ian Ivory Poker Tourney Bentley"
// → "ian ivory"). We still require an EXACT match on the cleaned name AND that it
// resolves to exactly ONE record on each side before touching anything — so a
// common first name or an ambiguous match is always skipped, never guessed.
const NOISE =
  /\b(poker|holdem|cash|tourney|tournament|nlh|plo|mtt|mct|woodvale|kenwick|bentley|kingsley|leederville|stirling|adriatic|kwinana|southside|north|south|central|east|west|self|dealt|dealer|newbie|hopeful|reserve|home|game|games|friday|monday|tuesday|wednesday|thursday|saturday|sunday|president|lic|casino|table|reservations?)\b/g

function normName(raw: string | null): string {
  if (!raw) return ''
  return raw
    .toLowerCase()
    .replace(/\$\s*\d[\d/]*/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const phoneCore = (p: string | null): string =>
  p ? p.replace(/\D/g, '').replace(/^61/, '').replace(/^0/, '') : ''

type Row = {
  id: string
  player_name: string | null
  phone: string | null
  beeper_chat_id: string | null
  hidden: boolean | null
}
type Conv = { external_chat_id: string | null; title: string | null }

/** Names that map to exactly one value (ambiguous names are dropped). */
function uniqueByName<T>(pairs: [string, T][]): Map<string, T> {
  const all = new Map<string, T[]>()
  for (const [k, v] of pairs) {
    if (k.length < 3) continue
    const arr = all.get(k) ?? all.set(k, []).get(k)!
    arr.push(v)
  }
  const uniq = new Map<string, T>()
  for (const [k, arr] of all) if (arr.length === 1) uniq.set(k, arr[0])
  return uniq
}

/**
 * Continuously recover contact details for no-contact players, the safe way:
 *  - Op A: link an UNLINKED Beeper thread to a no-thread player when their names
 *    match exactly and uniquely (the thread is a real conversation, so this just
 *    reconnects a record to its existing chat — no sends, no new rows).
 *  - Op B: fill a missing phone from another record that already has one, when
 *    the name matches exactly + uniquely and that name maps to a single number.
 * Additive only — never deletes or overwrites existing data, and skips hidden
 * rows. Runs on a slow cadence from the sync loop.
 */
export async function autoLink(db: DB): Promise<AutoLinkResult> {
  const rows: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data } = await db
      .from('inbox_outreach')
      .select('id, player_name, phone, beeper_chat_id, hidden')
      .range(from, from + 999)
    const r = (data as Row[]) ?? []
    rows.push(...r)
    if (r.length < 1000) break
  }
  const { data: convData } = await db
    .from('inbox_conversations')
    .select('external_chat_id, title')
    .eq('type', 'single')
    .limit(5000)
  const convs = (convData as Conv[]) ?? []

  const linkedChatIds = new Set(
    rows.map((r) => r.beeper_chat_id).filter(Boolean) as string[],
  )
  let threadsLinked = 0
  let phonesFilled = 0

  // ---- Op A: link an unlinked thread to a no-thread player by exact name. ----
  const unlinkedThreadByName = uniqueByName(
    convs
      .filter((c) => c.external_chat_id && c.title && !linkedChatIds.has(c.external_chat_id))
      .map((c) => [normName(c.title), c.external_chat_id!] as [string, string]),
  )
  const noThreadPlayerByName = uniqueByName(
    rows
      .filter((r) => !r.beeper_chat_id && !r.hidden && r.player_name)
      .map((r) => [normName(r.player_name), r] as [string, Row]),
  )
  for (const [name, chatId] of unlinkedThreadByName) {
    const player = noThreadPlayerByName.get(name)
    if (!player) continue
    const { error } = await db
      .from('inbox_outreach')
      .update({ beeper_chat_id: chatId })
      .eq('id', player.id)
      .is('beeper_chat_id', null)
    if (!error) {
      threadsLinked++
      player.beeper_chat_id = chatId
      linkedChatIds.add(chatId)
    }
  }

  // ---- Op B: fill a phone for a no-phone player from a uniquely-named record. ----
  const phoneByName = (() => {
    const sets = new Map<string, Set<string>>()
    for (const r of rows) {
      const pc = phoneCore(r.phone)
      const k = normName(r.player_name)
      if (!pc || k.length < 3) continue
      ;(sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(pc)
    }
    const uniq = new Map<string, string>()
    for (const [k, set] of sets) if (set.size === 1) uniq.set(k, [...set][0])
    return uniq
  })()
  const noPhonePlayerByName = uniqueByName(
    rows
      .filter((r) => !phoneCore(r.phone) && !r.hidden && r.player_name)
      .map((r) => [normName(r.player_name), r] as [string, Row]),
  )
  for (const [name, player] of noPhonePlayerByName) {
    const pc = phoneByName.get(name)
    if (!pc) continue
    const { error } = await db
      .from('inbox_outreach')
      .update({ phone: '0' + pc })
      .eq('id', player.id)
    if (!error) phonesFilled++
  }

  return { threadsLinked, phonesFilled }
}
