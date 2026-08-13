import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { namesCompatible } from '../lib/nameMatch'
import type { Database } from '../types/database'

export type PlayerRow = Database['public']['Tables']['inbox_outreach']['Row']
export type AttStats = Database['public']['Views']['inbox_attendance_stats']['Row']
/** A 1:1 Beeper thread — candidate for linking to a no-contact player. */
export interface SingleThread { chatId: string; title: string; network: string }

export const phoneCore = (p: string | null): string =>
  p ? p.replace(/\D/g, '').replace(/^61/, '').replace(/^0/, '') : ''

// Phone health for a contact. An AU national number (61/0 stripped) is 9 digits;
// a mobile starts with 4. Anything else is flagged so bad numbers don't sit
// silently failing to send.
export type PhoneStatus = 'empty' | 'ok' | 'landline' | 'short' | 'long'
export function phoneStatus(p: string | null): PhoneStatus {
  if (!(p ?? '').replace(/\D/g, '')) return 'empty'
  const core = phoneCore(p)
  if (core.length < 9) return 'short'
  if (core.length > 9) return 'long'
  return core.startsWith('4') ? 'ok' : 'landline'
}
export const phoneStatusLabel: Record<PhoneStatus, string> = {
  empty: '', ok: '', landline: 'landline (not a mobile)',
  short: 'too few digits', long: 'too many digits',
}
const firstNonEmpty = (vals: (string | null)[]): string | null =>
  vals.find((v) => v != null && String(v).trim() !== '') ?? null
const unionArr = (arrs: (string[] | null)[]): string[] =>
  Array.from(new Set(arrs.flatMap((a) => a ?? []))).sort()
const filledCount = (r: PlayerRow): number =>
  [r.player_name, r.email, r.region, r.beeper_chat_id, r.activity, r.outreach_status].filter(Boolean)
    .length + (r.stakes?.length ?? 0) + (r.venues?.length ?? 0)

// "Partial / incomplete" = a record still missing something you'd want before
// inviting them: a way to reach them, a region, stakes, or a venue. These are the
// rows to work through in Merge & Review.
export const isIncomplete = (r: PlayerRow): boolean => {
  if (r.do_not_message) return false // banned: never invited, so nothing to complete
  const noContact = !r.phone?.trim() && !r.beeper_chat_id?.trim()
  const noRegion = !(r.region ?? '').trim()
  const noStakes = (r.stakes?.length ?? 0) === 0
  const noVenue = (r.venues?.length ?? 0) === 0
  return noContact || noRegion || noStakes || noVenue
}

// "First name only" = a name with no surname — a single word that isn't just a
// phone number. About a third of the CRM is like this (TD cash-sheet / reservation
// captures that never recorded a surname). These are the rows to work through and
// name; saving a surname makes the row stop matching, so it drops off the list.
export const isFirstNameOnly = (r: PlayerRow): boolean => {
  if (r.do_not_message) return false // banned: not worth naming, keep the backlog honest
  const n = (r.player_name ?? '').trim()
  if (n === '' || /\s/.test(n)) return false // blank or has a surname
  if (/^[0-9 +()-]+$/.test(n)) return false // a bare phone number
  if (n.toLowerCase() === 'unknown') return false // no name at all, not a first name
  return true
}

// Collapse Airtable's free-text "Source" (often a combo like "Google Contacts,
// Facebook Messenger") into one short origin label for the chip + filter.
function sourceFromText(s: string): string {
  if (/facebook|messenger/i.test(s)) return 'facebook'
  if (/raffle/i.test(s)) return 'raffle'
  if (/reservation|pdf/i.test(s)) return 'reservations'
  if (/phone contacts|google contacts/i.test(s)) return 'phone'
  if (/cash players?/i.test(s)) return 'cash list'
  if (/receipt/i.test(s)) return 'receipt'
  if (/\btd\b|transfer/i.test(s)) return 'TD sheet'
  return 'airtable'
}

// Where a contact came from — so the card can show "phone / facebook / raffle /
// TD sheet / letspoker / …" at a glance. Prefix-based for our own imports; for
// Airtable rows we use the mirrored "Source" field (the real origin) when set,
// falling back to the generic "airtable" only when it's blank.
export function sourceLabel(r: { airtable_id: string | null; source?: string | null }): string {
  const a = r.airtable_id ?? ''
  if (a.startsWith('gcsv:') || a.startsWith('gcontact:')) return 'phone'
  if (a.startsWith('receipt:')) return 'receipt'
  if (a.startsWith('td:')) return 'TD sheet'
  if (a.startsWith('mct:')) return 'MCT sheet'
  if (a.startsWith('fb:')) return 'facebook'
  if (a.startsWith('thread:')) return 'beeper'
  if (a.startsWith('lp:')) return 'letspoker'
  if (a.startsWith('staff:')) return 'staff'
  if (a.startsWith('manual:')) return 'manual'
  if (a.startsWith('post-game:')) return 'post-game'
  if (a.startsWith('rec')) return r.source ? sourceFromText(r.source) : 'airtable'
  return 'other'
}

// Poker/venue noise operators append to CRM names (e.g. "Chris Pavitt $2/5/10
// MCT Woodvale"). Stripped so a clean Facebook name still lines up with the record.
const NAME_NOISE =
  /\b(poker|holdem|cash|tourney|tournament|nlh|plo|mtt|mct|short|deck|homegame|hg|woodvale|kenwick|bentley|kingsley|leederville|leedy|stirling|adriatic|kwinana|southside|north|south|central|east|west|hotel|tavern|club|bowls|president|dealer|reserve|home|game|games|player)\b/g
export const normFull = (raw: string): string =>
  raw.toLowerCase().replace(/\$\s*\d[\d/]*/g, ' ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
export const normCore = (raw: string): string =>
  normFull(raw).replace(NAME_NOISE, ' ').replace(/\s+/g, ' ').trim()
// Attendance rows are keyed by the SQL norm_full_name() (letters only, no
// spaces); normCore runs first so operator name-noise doesn't break the join.
export const attKey = (name: string | null): string => normCore(name ?? '').replace(/\s+/g, '')

function dedupeNames(ns: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of ns) {
    const k = n.toLowerCase().trim()
    if (k && !seen.has(k)) { seen.add(k); out.push(n.trim()) }
  }
  return out
}

/**
 * Pull friend names out of whatever gets pasted: Facebook's "Download Your
 * Information" JSON (a `friends_v2` / `friends` array, or a bare array), or a
 * plain newline/comma list. Lines like "Jane Doe (2 mutual friends)" keep just
 * the name before the bracket.
 */
export function parseFriendNames(raw: string): string[] {
  const text = raw.trim()
  if (!text) return []
  const names: string[] = []
  try {
    const j = JSON.parse(text) as unknown
    const obj = j as { friends_v2?: unknown; friends?: unknown }
    const list =
      Array.isArray(j) ? j
      : Array.isArray(obj.friends_v2) ? obj.friends_v2
      : Array.isArray(obj.friends) ? obj.friends
      : null
    if (list) {
      for (const it of list as unknown[]) {
        const n = typeof it === 'string' ? it : (it as { name?: unknown })?.name
        if (n) names.push(String(n))
      }
      return dedupeNames(names)
    }
  } catch { /* not JSON — fall through to HTML / plain-text parsing */ }
  // HTML (the your_friends.html export): strip tags to line breaks + decode a few
  // entities, then line-parse and drop the date/heading rows Facebook interleaves.
  let body = text
  if (/<[a-z!/][^>]*>/i.test(body)) {
    body = body
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, '\n')
      .replace(/&amp;/g, '&')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ')
  }
  for (const line of body.split(/[\n,]+/)) {
    const n = line.replace(/\(.*?\)\s*$/, '').trim()
    if (!n || n.length < 2 || n.length > 60) continue
    if (/^\d/.test(n)) continue // dates / counts
    if (/https?:\/\//i.test(n)) continue
    if (/^(friends|your friends|facebook|name|date added)$/i.test(n)) continue
    if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(n) && /\d/.test(n)) continue // timestamps
    names.push(n)
  }
  return dedupeNames(names)
}

// Canonical dropdown vocabularies. Edit these lists to taste — existing
// non-standard values on a player are preserved and shown as the selection.
// "North + Central" / "South + Central" cover players happy to travel across two
// zones — the substring region filter means they show up under either zone's
// list (e.g. a "South + Central" player matches both a South and a Central game).
export const REGIONS = ['North', 'South', 'Central', 'North + Central', 'South + Central', 'All']
export const VENUES = [
  'MCT', 'Woodvale', 'Bentley', 'Kenwick', 'Kingsley',
  'Leederville', 'Stirling', 'Planet Royale',
]
export const STAKES = ['$2/5', '$5/10', '$2/5/10', 'PLO']

export function mergeRows(
  rows: PlayerRow[],
  keeperId?: string,
): { primary: PlayerRow; merged: Partial<PlayerRow>; dropIds: string[] } {
  let ordered = [...rows].sort(
    (a, b) =>
      (b.beeper_chat_id ? 4 : 0) - (a.beeper_chat_id ? 4 : 0) +
      ((b.airtable_id.startsWith('receipt:') ? 0 : 2) - (a.airtable_id.startsWith('receipt:') ? 0 : 2)) +
      (filledCount(b) - filledCount(a)),
  )
  // If the user chose a record to keep, its name/values win.
  if (keeperId) {
    const keep = ordered.find((r) => r.id === keeperId)
    if (keep) ordered = [keep, ...ordered.filter((r) => r.id !== keeperId)]
  }
  // Which number survives the merge, in order:
  //  1. the record the user explicitly chose as keeper (their pick is the call);
  //  2. a VALID mobile from the phone contacts (gcsv: upload or the live
  //     gcontact: Google sync — both are "the number saved in Justin's phone");
  //  3. any phone-contacts number, then any valid mobile, then anything at all.
  const isContactSrc = (r: PlayerRow) =>
    r.airtable_id.startsWith('gcsv:') || r.airtable_id.startsWith('gcontact:')
  const keeperPhone = keeperId && ordered[0].id === keeperId ? ordered[0].phone : null
  const merged: Partial<PlayerRow> = {
    player_name: firstNonEmpty(ordered.map((r) => r.player_name)),
    first_name: firstNonEmpty(ordered.map((r) => r.first_name)),
    last_name: firstNonEmpty(ordered.map((r) => r.last_name)),
    phone:
      firstNonEmpty([keeperPhone]) ??
      firstNonEmpty(ordered.filter((r) => isContactSrc(r) && phoneStatus(r.phone) === 'ok').map((r) => r.phone)) ??
      firstNonEmpty(ordered.filter(isContactSrc).map((r) => r.phone)) ??
      firstNonEmpty(ordered.filter((r) => phoneStatus(r.phone) === 'ok').map((r) => r.phone)) ??
      firstNonEmpty(ordered.map((r) => r.phone)),
    email: firstNonEmpty(ordered.map((r) => r.email)),
    beeper_chat_id: firstNonEmpty(ordered.map((r) => r.beeper_chat_id)),
    region: firstNonEmpty(ordered.map((r) => r.region)),
    activity: firstNonEmpty(ordered.map((r) => r.activity)),
    outreach_status: firstNonEmpty(ordered.map((r) => r.outreach_status)),
    stakes: unionArr(ordered.map((r) => r.stakes)),
    venues: unionArr(ordered.map((r) => r.venues)),
    notes: ordered.map((r) => r.notes).filter(Boolean).join(' | ') || null,
    do_not_message: ordered.some((r) => r.do_not_message),
    // Flags survive the merge no matter which record they were set on — losing a
    // ban is dangerous, losing cash/tourney/whale/fifo silently drops the player
    // from segments and panels.
    staff: ordered.some((r) => r.staff),
    tournament: ordered.some((r) => r.tournament),
    cash: ordered.some((r) => r.cash),
    fb_friend: ordered.some((r) => r.fb_friend),
    whale: ordered.some((r) => r.whale),
    fifo: ordered.some((r) => r.fifo),
    nickname: firstNonEmpty(ordered.map((r) => r.nickname)),
  }
  return { primary: ordered[0], merged, dropIds: ordered.slice(1).map((r) => r.id) }
}

export interface Edit {
  player_name: string
  phone: string
  region: string
  stakes: string
  venues: string
  activity: string
  do_not_message: boolean
  contact_day: string
  contact_window: string
  contact_frequency_days: string
  rapport: number
  preferred_channel: string
  staff: boolean
  tournament: boolean
  cash: boolean
  whale: boolean
  fifo: boolean
}
const toEdit = (r: PlayerRow): Edit => ({
  player_name: r.player_name ?? '',
  phone: r.phone ?? '',
  region: r.region ?? '',
  stakes: (r.stakes ?? []).join(', '),
  venues: (r.venues ?? []).join(', '),
  activity: r.activity ?? '',
  do_not_message: r.do_not_message,
  contact_day: r.contact_day ?? '',
  contact_window: r.contact_window ?? '',
  contact_frequency_days: r.contact_frequency_days != null ? String(r.contact_frequency_days) : '',
  rapport: r.rapport ?? 0,
  preferred_channel: r.preferred_channel ?? '',
  staff: r.staff ?? false,
  tournament: r.tournament ?? false,
  cash: r.cash ?? false,
  whale: r.whale ?? false,
  fifo: r.fifo ?? false,
})

/**
 * Shared player-CRM data + operations, used by both the Players tab (browse /
 * edit) and the Merge & Review tab (dedupe / triage). Each consumer gets its own
 * instance; only one tab is mounted at a time, so the cost is a reload on switch.
 */
export function usePlayers(initialFilter?: string) {
  const [rows, setRows] = useState<PlayerRow[]>([])
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  // Rows as of the last load(), for telling an untouched edit buffer from one
  // the user has typed in (see load()).
  const loadedRows = useRef<Map<string, PlayerRow>>(new Map())
  // Per-player attendance scoring (full LP+TD history; live view, keyed by the
  // SQL name-norm). Powers the games count/rank, venue filter and sort modes.
  const [att, setAtt] = useState<Map<string, AttStats>>(new Map())
  const [venueFilter, setVenueFilter] = useState('all')
  const [sortMode, setSortMode] = useState<'attention' | 'games' | 'recent'>('attention')
  // external_chat_id -> network ('Google Messages', 'Facebook/Messenger', …) so a
  // card can show the thread's REAL channel instead of assuming Messenger.
  const [chatNetworks, setChatNetworks] = useState<Map<string, string>>(new Map())
  // external_chat_id -> the thread's saved title (usually the contact's full name
  // as it appears in Messenger / the phone), so the card can surface a last name
  // the bare player_name is missing.
  const [chatTitles, setChatTitles] = useState<Map<string, string>>(new Map())
  // Every 1:1 thread — for suggesting Messenger matches to no-contact players.
  const [singleThreads, setSingleThreads] = useState<SingleThread[]>([])
  // CRM ids whose last SMS batch send FAILED (dead/wrong number), last 60d.
  const [failedSends, setFailedSends] = useState<Set<string>>(new Set())
  // "Bad number" view: invalid-length or send-failed numbers to fix.
  const [badNumberOnly, setBadNumberOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [regionFilter, setRegionFilter] = useState('all')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // region cleanup inputs, keyed by current value
  const [renames, setRenames] = useState<Record<string, string>>({})
  // manual merge selection
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [keeperId, setKeeperId] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  // "Tournament" view: only players flagged tournament (play tourneys / events).
  const [tournamentOnly, setTournamentOnly] = useState(false)
  // "Cash" view: only players flagged cash (cash-game segment).
  const [cashOnly, setCashOnly] = useState(false)
  // "No contact" view: players with no phone AND no Messenger thread — the
  // collect-their-number-in-person list. Can be opened pre-filtered from the
  // Home dashboard's "No contact" card.
  const [noContactOnly, setNoContactOnly] = useState(initialFilter === 'noContact')
  // "Banned" view: do_not_message set (opted out / barred).
  const [banOnly, setBanOnly] = useState(false)
  // "Staff" view: dealers / permit holders / crew (never proactively invited).
  const [staffOnly, setStaffOnly] = useState(false)
  // "Incomplete" view: records still missing contact / region / stakes / venue.
  const [incompleteOnly, setIncompleteOnly] = useState(false)
  // Filter by where the contact came from (phone / TD sheet / facebook / …).
  const [sourceFilter, setSourceFilter] = useState('all')
  // "FB · DM to open" view: Facebook friends with no thread yet (from importer).
  const [fbFriendOnly, setFbFriendOnly] = useState(initialFilter === 'fbDm')
  // "First name only" view: players we have just a first name for — the naming
  // backlog. Can be opened pre-filtered from the Home dashboard card.
  const [firstNameOnly, setFirstNameOnly] = useState(initialFilter === 'firstName')
  // Ids of fb_friend players who verify as real players (their name appears in
  // TD/LP attendance) — the only ones "FB · DM to open" surfaces, so the filter
  // isn't cluttered with non-player Facebook friends. From inbox_fb_dm_verified.
  const [verifiedFbIds, setVerifiedFbIds] = useState<Set<string>>(new Set())
  // per phone-duplicate-group: which record's name to keep
  const [groupKeeper, setGroupKeeper] = useState<Record<string, string>>({})
  // Which players the user has reviewed (saved). Persisted in the browser so the
  // marker survives reloads. Reviewed rows are highlighted and sink down the list
  // so the ones still needing a look stay at the top.
  const [reviewed, setReviewed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('wce_reviewed') || '[]') as string[]) }
    catch { return new Set<string>() }
  })
  function markReviewed(id: string) {
    setReviewed((prev) => {
      const next = new Set(prev)
      next.add(id)
      try { localStorage.setItem('wce_reviewed', JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }
  function unmarkReviewed(id: string) {
    setReviewed((prev) => {
      const next = new Set(prev)
      next.delete(id)
      try { localStorage.setItem('wce_reviewed', JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }

  async function load() {
    // Page through every player — a single select() is capped at 1000 rows by
    // PostgREST, which would hide everyone past the first 1000 (e.g. names late
    // in the alphabet). There are more players than that.
    const list: PlayerRow[] = []
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data } = await supabase
        .from('inbox_outreach')
        .select('*')
        .order('player_name', { ascending: true })
        .range(from, from + PAGE - 1)
      const rows = (data as PlayerRow[]) ?? []
      list.push(...rows)
      if (rows.length < PAGE) break
    }
    setRows(list)
    // Refresh the edit buffers WITHOUT clobbering unsaved typing: a buffer that
    // differs from the row it was loaded from is the user's work-in-progress
    // (reloads happen behind their back after every merge), so it stays; only
    // untouched buffers pick up the fresh row.
    setEdits((prev) => {
      const next: Record<string, Edit> = {}
      for (const r of list) {
        const old = loadedRows.current.get(r.id)
        const prevE = prev[r.id]
        const dirty = old && prevE && JSON.stringify(prevE) !== JSON.stringify(toEdit(old))
        next[r.id] = dirty ? prevE : toEdit(r)
      }
      return next
    })
    loadedRows.current = new Map(list.map((r) => [r.id, r]))
    setRenames({})

    // Resolve each linked thread's network (a Beeper thread is often SMS via
    // Google Messages, not Messenger) so the card badge shows the right channel.
    const { data: convs } = await supabase
      .from('inbox_conversations')
      .select('external_chat_id, network, title, type')
      .limit(5000)
    const nets = new Map<string, string>()
    const titles = new Map<string, string>()
    const singles: SingleThread[] = []
    for (const c of (convs as { external_chat_id: string | null; network: string | null; title: string | null; type: string | null }[]) ?? []) {
      if (c.external_chat_id && c.network) nets.set(c.external_chat_id, c.network)
      if (c.external_chat_id && c.title) titles.set(c.external_chat_id, c.title)
      if (c.external_chat_id && c.title && c.type === 'single') {
        singles.push({ chatId: c.external_chat_id, title: c.title, network: c.network ?? '' })
      }
    }
    setChatNetworks(nets)
    setChatTitles(titles)
    setSingleThreads(singles)

    // Which fb_friend no-contact players are verified as real players (in TD/LP).
    const fbView = supabase as unknown as {
      from: (t: string) => { select: (c: string) => Promise<{ data: { id: string }[] | null }> }
    }
    const { data: vfb } = await fbView.from('inbox_fb_dm_verified').select('id')
    setVerifiedFbIds(new Set((vfb ?? []).map((x) => x.id)))

    // SMS batch sends that FAILED in the last 60d, keyed by CRM id — a dead or
    // wrong number to fix. (A later success would show as a fresh signal; this
    // list is a starting point, cleared once the number is corrected + re-sent.)
    const { data: fails } = await supabase
      .from('inbox_batch_items')
      .select('data')
      .eq('status', 'failed')
      .gte('created_at', new Date(Date.now() - 60 * 86_400_000).toISOString())
      .limit(2000)
    const fs = new Set<string>()
    for (const it of (fails ?? []) as { data: { outreach_id?: string } | null }[]) {
      if (it.data?.outreach_id) fs.add(it.data.outreach_id)
    }
    setFailedSends(fs)

    // Attendance scoring: page through the stats view (~2k norms and growing).
    const stats = new Map<string, AttStats>()
    for (let from = 0; ; from += PAGE) {
      const { data: st } = await supabase
        .from('inbox_attendance_stats')
        .select('*')
        .order('norm')
        .range(from, from + PAGE - 1)
      const page = (st as AttStats[]) ?? []
      for (const s of page) stats.set(s.norm, s)
      if (page.length < PAGE) break
    }
    setAtt(stats)
  }
  useEffect(() => {
    void load()
  }, [])

  const regionCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) if (r.region) m.set(r.region, (m.get(r.region) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])
  const regions = useMemo(() => regionCounts.map(([r]) => r), [regionCounts])

  const dupGroups = useMemo(() => {
    const byPhone = new Map<string, PlayerRow[]>()
    for (const r of rows) {
      const key = phoneCore(r.phone)
      // A real AU number is 9 digits once 61/0 are stripped; shorter "numbers"
      // are carrier codes and typos ("Call Waiting *43#" ended up a duplicate
      // "group" keyed on 43) — junk to fix by hand, not merge candidates.
      if (key.length < 9) continue
      ;(byPhone.get(key) ?? byPhone.set(key, []).get(key)!).push(r)
    }
    return [...byPhone.values()].filter((g) => g.length > 1)
  }, [rows])

  // Likely duplicate PEOPLE the phone-dedup misses: records sharing the same cleaned
  // full name (surname required, so different "Jack"s don't collide) but with
  // differing or missing phones. Suggestions only — you pick the keeper and merge.
  const nameDupGroups = useMemo(() => {
    const byName = new Map<string, PlayerRow[]>()
    for (const r of rows) {
      const nm = (r.player_name ?? '').trim()
      if (r.hidden || !/\s/.test(nm)) continue // full names only (has a surname)
      const k = normCore(nm)
      if (k.length < 5) continue
      ;(byName.get(k) ?? byName.set(k, []).get(k)!).push(r)
    }
    return [...byName.values()]
      .filter((g) => g.length > 1)
      // drop groups already caught as a single shared phone (those are in dupGroups)
      .filter((g) => {
        const phones = new Set(g.map((r) => phoneCore(r.phone)).filter(Boolean))
        return phones.size >= 2 || g.some((r) => !phoneCore(r.phone))
      })
      .sort((a, b) => b.length - a.length)
      .slice(0, 60)
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = rows.filter((r) => {
      if (!showHidden && r.hidden) return false
      if (tournamentOnly && !(r.tournament ?? false)) return false
      if (cashOnly && !(r.cash ?? false)) return false
      // Banned players are excluded from the no-contact work queue: they're
      // never messaged, so chasing their number is wasted effort.
      if (noContactOnly && (r.do_not_message || !!r.phone?.trim() || !!r.beeper_chat_id?.trim())) return false
      if (banOnly && !r.do_not_message) return false
      if (staffOnly && !(r.staff ?? false)) return false
      if (incompleteOnly && !isIncomplete(r)) return false
      if (sourceFilter !== 'all' && sourceLabel(r) !== sourceFilter) return false
      if (fbFriendOnly && !verifiedFbIds.has(r.id)) return false
      if (firstNameOnly && !isFirstNameOnly(r)) return false
      if (badNumberOnly) {
        const st = phoneStatus(r.phone)
        const bad = st === 'short' || st === 'long' || failedSends.has(r.id)
        if (!bad) return false
      }
      if (regionFilter !== 'all') {
        const rg = (r.region ?? '').toLowerCase()
        if (!rg.includes('all area') && !rg.includes(regionFilter.toLowerCase())) return false
      }
      if (venueFilter !== 'all') {
        // Venue = where they've actually PLAYED (LP+TD attendance) or the CRM
        // venues field — either counts.
        const v = venueFilter.toLowerCase()
        const played = (att.get(attKey(r.player_name))?.venues ?? []).some((x) => x.toLowerCase() === v)
        const tagged = (r.venues ?? []).some((x) => x.toLowerCase().includes(v))
        if (!played && !tagged) return false
      }
      if (q) {
        // Search across the fields a person would type, not just name/phone — so
        // e.g. "fb_unreviewed", a region, or "messenger" all filter the list.
        const hay = [
          r.player_name, r.phone, r.region, r.activity, r.outreach_status, r.notes,
          r.beeper_chat_id ? 'messenger thread' : '', r.phone ? 'sms mobile' : '',
        ].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    if (sortMode === 'games') {
      // Frequency ranking: most games played (full LP+TD history) first.
      out.sort((a, b) => {
        const ga = att.get(attKey(a.player_name))?.games ?? 0
        const gb = att.get(attKey(b.player_name))?.games ?? 0
        if (ga !== gb) return gb - ga
        return (a.player_name ?? '').localeCompare(b.player_name ?? '')
      })
      return out
    }
    if (sortMode === 'recent') {
      out.sort((a, b) => {
        const la = att.get(attKey(a.player_name))?.last_seen ?? ''
        const lb = att.get(attKey(b.player_name))?.last_seen ?? ''
        if (la !== lb) return la < lb ? 1 : -1
        return (a.player_name ?? '').localeCompare(b.player_name ?? '')
      })
      return out
    }
    // Surface the rows still needing attention: unreviewed first, then freshly
    // added contacts (newest contact-list import at the very top), then most
    // recently synced, then alphabetical. Reviewed rows sink to the bottom.
    out.sort((a, b) => {
      const ar = reviewed.has(a.id) ? 1 : 0
      const br = reviewed.has(b.id) ? 1 : 0
      if (ar !== br) return ar - br
      // Rows with an added_at (just imported from a contacts upload) come first,
      // newest-added first; rows without one ('' sorts last) fall through.
      const aa = a.added_at ?? ''
      const ba = b.added_at ?? ''
      if (aa !== ba) return aa < ba ? 1 : -1
      const at = a.synced_at ?? ''
      const bt = b.synced_at ?? ''
      if (at !== bt) return at < bt ? 1 : -1
      return (a.player_name ?? '').localeCompare(b.player_name ?? '')
    })
    return out
  }, [rows, query, regionFilter, venueFilter, sortMode, att, showHidden, tournamentOnly, cashOnly, noContactOnly, banOnly, staffOnly, incompleteOnly, sourceFilter, fbFriendOnly, firstNameOnly, badNumberOnly, failedSends, verifiedFbIds, reviewed])

  // How many records have a bad or failed number — for the filter chip count.
  const badNumberCount = useMemo(
    () => rows.filter((r) => { const s = phoneStatus(r.phone); return s === 'short' || s === 'long' || failedSends.has(r.id) }).length,
    [rows, failedSends],
  )

  // Distinct sources present, with counts, for the Merge & Review source filter.
  const sources = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) {
      const s = sourceLabel(r)
      m.set(s, (m.get(s) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])

  // FB friends still needing a first DM — verified players only (no-contact
  // fb_friend whose name appears in TD/LP attendance), matching the filter.
  const fbFriendCount = verifiedFbIds.size

  // Players we only have a first name for — the naming backlog (chip + count).
  const firstNameOnlyCount = useMemo(() => rows.filter(isFirstNameOnly).length, [rows])

  const selectedRows = useMemo(() => rows.filter((r) => sel.has(r.id)), [rows, sel])

  // Cross-check a pasted Facebook friends list against every CRM name and set the
  // fb_friend flag. Matches on the cleaned name (with and without venue/stake
  // noise), so "Chris Pavitt $2/5/10 MCT Woodvale" still lines up with "Chris
  // Pavitt". Reconciles: a name no longer on the list is un-flagged.
  async function importFbFriends(raw: string): Promise<{ friends: number; flagged: number; cleared: number }> {
    const friends = parseFriendNames(raw)
    // Persist the list so the sync keeps re-flagging newly-added players (no re-import).
    await supabase.from('inbox_fb_friends').upsert({ id: 1, names: friends, updated_at: new Date().toISOString() })
    const friendKeys = new Set<string>()
    for (const f of friends) {
      const a = normFull(f), b = normCore(f)
      if (a.length >= 3) friendKeys.add(a)
      if (b.length >= 3) friendKeys.add(b)
    }
    const matchedIds = new Set<string>()
    for (const r of rows) {
      if (!r.player_name) continue
      const a = normFull(r.player_name), b = normCore(r.player_name)
      if ((a.length >= 3 && friendKeys.has(a)) || (b.length >= 3 && friendKeys.has(b))) matchedIds.add(r.id)
    }
    const toTrue = rows.filter((r) => matchedIds.has(r.id) && !r.fb_friend).map((r) => r.id)
    const toFalse = rows.filter((r) => !matchedIds.has(r.id) && r.fb_friend).map((r) => r.id)
    setBusy(true)
    for (let i = 0; i < toTrue.length; i += 500)
      await supabase.from('inbox_outreach').update({ fb_friend: true }).in('id', toTrue.slice(i, i + 500))
    for (let i = 0; i < toFalse.length; i += 500)
      await supabase.from('inbox_outreach').update({ fb_friend: false }).in('id', toFalse.slice(i, i + 500))
    setBusy(false)
    await load()
    return { friends: friends.length, flagged: matchedIds.size, cleared: toFalse.length }
  }

  async function clearFbFriends(): Promise<number> {
    const ids = rows.filter((r) => r.fb_friend).map((r) => r.id)
    setBusy(true)
    for (let i = 0; i < ids.length; i += 500)
      await supabase.from('inbox_outreach').update({ fb_friend: false }).in('id', ids.slice(i, i + 500))
    setBusy(false)
    await load()
    return ids.length
  }

  function toggleSel(id: string) {
    setSel((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Deleting a duplicate cascades its inbox_list_members rows away — so before a
  // merge deletes the dropped records, their venue-list memberships are re-pointed
  // at the keeper (ignore-duplicates keeps existing memberships intact).
  async function moveListMemberships(dropIds: string[], keeperId: string): Promise<string | null> {
    if (dropIds.length === 0) return null
    const { data: mem, error: mErr } = await supabase
      .from('inbox_list_members')
      .select('list_id')
      .in('outreach_id', dropIds)
    if (mErr) return mErr.message
    const listIds = [...new Set(((mem ?? []) as { list_id: string }[]).map((m) => m.list_id))]
    if (listIds.length === 0) return null
    const { error } = await supabase.from('inbox_list_members').upsert(
      listIds.map((list_id) => ({ list_id, outreach_id: keeperId })),
      { onConflict: 'list_id,outreach_id', ignoreDuplicates: true },
    )
    return error?.message ?? null
  }

  /**
   * The one safe merge sequence, shared by every merge path. Everything that
   * points at a dropped duplicate is re-pointed at the keeper BEFORE the delete:
   *  - the dropped rows' source keys are tombstoned, so the Google Contacts /
   *    Airtable syncs can never re-import the duplicate (the "merges kept
   *    coming back" bug — a full resync re-inserted every deleted source key);
   *  - the send ledger moves across, so the no-reply guard and "messaged Nd
   *    ago" keep counting sends made under the duplicate's id;
   *  - queued batch items move across, so send-time guards (ban / on-ice /
   *    frequency) check the surviving record instead of a deleted id;
   *  - venue-list memberships move across (the delete would cascade them away).
   * Every step is error-checked; the delete only runs when all of it landed.
   * Returns an error message, or null on success.
   */
  async function applyMerge(group: PlayerRow[], keeper?: string): Promise<string | null> {
    if (group.length < 2) return null
    const { primary, merged, dropIds } = mergeRows(group, keeper)
    const dropped = group.filter((r) => dropIds.includes(r.id))

    const tomb = dropped
      .filter((r) => r.airtable_id)
      .map((r) => ({ airtable_id: r.airtable_id, merged_into: primary.id }))
    if (tomb.length) {
      // Cast: the tombstones table post-dates the generated Database types.
      const t = supabase as unknown as {
        from: (x: string) => {
          upsert: (v: unknown, o: unknown) => Promise<{ error: { message: string } | null }>
        }
      }
      const { error } = await t
        .from('inbox_merge_tombstones')
        .upsert(tomb, { onConflict: 'airtable_id', ignoreDuplicates: true })
      // A missing table means migration 0068 isn't applied yet: the merge still
      // works, it just can't outlive the next Google full resync. Don't block.
      if (error && !/does not exist|schema cache/i.test(error.message)) {
        return `tombstones: ${error.message}`
      }
    }

    {
      // Cast: inbox_sent_log post-dates the generated Database types.
      const l = supabase as unknown as {
        from: (x: string) => {
          update: (v: unknown) => { in: (c: string, v2: string[]) => Promise<{ error: { message: string } | null }> }
        }
      }
      const { error } = await l.from('inbox_sent_log').update({ outreach_id: primary.id }).in('outreach_id', dropIds)
      if (error) return `send ledger: ${error.message}`
    }

    {
      const { data: liveItems, error: qErr } = await supabase
        .from('inbox_batch_items')
        .select('id, data')
        .in('status', ['pending', 'approved', 'sending'])
        .in('data->>outreach_id', dropIds)
      if (qErr) return `batch items: ${qErr.message}`
      for (const it of (liveItems ?? []) as { id: string; data: Record<string, unknown> | null }[]) {
        const { error } = await supabase
          .from('inbox_batch_items')
          .update({ data: { ...(it.data ?? {}), outreach_id: primary.id } })
          .eq('id', it.id)
        if (error) return `batch items: ${error.message}`
      }
    }

    const memErr = await moveListMemberships(dropIds, primary.id)
    if (memErr) return `list memberships: ${memErr}`

    const { error: upErr } = await supabase.from('inbox_outreach').update(merged).eq('id', primary.id)
    if (upErr) return upErr.message
    if (dropIds.length) {
      const { error: delErr } = await supabase.from('inbox_outreach').delete().in('id', dropIds)
      if (delErr) return delErr.message
    }
    return null
  }

  async function mergeSelected() {
    if (selectedRows.length < 2) return
    setBusy(true)
    const err = await applyMerge(selectedRows, keeperId ?? undefined)
    setBusy(false)
    if (err) {
      setStatus(`Merge failed: ${err}`)
      setTimeout(() => setStatus(null), 8000)
      return
    }
    setSel(new Set())
    setKeeperId(null)
    setStatus('Merged.')
    load()
    setTimeout(() => setStatus(null), 3000)
  }

  async function toggleHidePlayer(id: string, currentlyHidden: boolean) {
    await supabase.from('inbox_outreach').update({ hidden: !currentlyHidden }).eq('id', id)
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, hidden: !currentlyHidden } : r)))
  }

  /** Put a player on ice for N days (snooze_until = today + N); days=0 un-ices. */
  async function icePlayer(id: string, days: number) {
    const until = days > 0
      ? new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
      : null
    await supabase.from('inbox_outreach').update({ snooze_until: until }).eq('id', id)
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, snooze_until: until } : r)))
    setStatus(until ? `On ice until ${until}.` : 'Un-iced.')
    setTimeout(() => setStatus(null), 3000)
  }

  /**
   * Auto-merge exact phone-number duplicates (the same person saved in both
   * Google accounts, receipts, TD sheets, …). Only merges when every pair of
   * names in the group is COMPATIBLE — identical after noise-stripping, or
   * differing only by a nickname/diminutive (Pat/Patrick), a truncation
   * (Knez/Knezevic), an initial (Andi L/Andi), or a one-letter typo
   * (Mcdermit/Mcdermott). A genuinely different name on the same number (a
   * father/son sharing a phone, a venue's line) is left for manual review,
   * never silently fused. Uses the same safe merge sequence as the manual path.
   */
  async function mergePhoneDuplicates(): Promise<{ merged: number; skipped: number }> {
    const nameOk = (g: PlayerRow[]): boolean => {
      const names = g.map((r) => normCore(r.player_name ?? '')).filter(Boolean)
      if (names.length <= 1) return true // ≤1 named record: safe
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          if (!namesCompatible(names[i], names[j])) return false
        }
      }
      return true
    }
    setBusy(true)
    let merged = 0, skipped = 0
    let firstError: string | null = null
    for (const g of dupGroups) {
      if (!nameOk(g)) { skipped++; continue }
      const err = await applyMerge(g)
      if (err) { firstError = err; break } // stop rather than plough into more failures
      merged++
    }
    setBusy(false)
    setStatus(
      firstError
        ? `Merged ${merged}, then stopped on an error: ${firstError}`
        : `Merged ${merged} phone-duplicate group(s)${skipped ? `, skipped ${skipped} with clashing names (review manually)` : ''}.`,
    )
    await load()
    setTimeout(() => setStatus(null), 8000)
    return { merged, skipped }
  }

  async function savePlayer(id: string) {
    const e = edits[id]
    if (!e) return
    setBusy(true)
    const { error } = await supabase
      .from('inbox_outreach')
      .update({
        player_name: e.player_name.trim() || null,
        phone: e.phone.trim() || null,
        region: e.region.trim() || null,
        stakes: e.stakes.split(',').map((s) => s.trim()).filter(Boolean),
        venues: e.venues.split(',').map((s) => s.trim()).filter(Boolean),
        activity: e.activity.trim() || null,
        do_not_message: e.do_not_message,
        contact_day: e.contact_day || null,
        contact_window: e.contact_window || null,
        contact_frequency_days: e.contact_frequency_days ? Number(e.contact_frequency_days) : null,
        rapport: e.rapport || null,
        preferred_channel: e.preferred_channel || null,
        staff: e.staff,
        tournament: e.tournament,
        cash: e.cash,
        whale: e.whale,
        fifo: e.fifo,
      })
      .eq('id', id)
    setBusy(false)
    if (error) return setStatus(`Error: ${error.message}`)
    setStatus('Saved.')
    markReviewed(id)
    setRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              player_name: e.player_name.trim() || null,
              phone: e.phone.trim() || null,
              region: e.region.trim() || null,
              stakes: e.stakes.split(',').map((s) => s.trim()).filter(Boolean),
              venues: e.venues.split(',').map((s) => s.trim()).filter(Boolean),
              activity: e.activity.trim() || null,
              do_not_message: e.do_not_message,
              staff: e.staff,
              tournament: e.tournament,
              cash: e.cash,
              whale: e.whale,
              fifo: e.fifo,
            }
          : r,
      ),
    )
    setTimeout(() => setStatus(null), 2500)
  }

  async function renameRegion(from: string) {
    const to = (renames[from] ?? '').trim()
    if (!to || to === from) return
    setBusy(true)
    const { error } = await supabase
      .from('inbox_outreach')
      .update({ region: to })
      .eq('region', from)
    setBusy(false)
    if (error) return setStatus(`Error: ${error.message}`)
    setStatus(`Renamed “${from}” → “${to}”.`)
    load()
    setTimeout(() => setStatus(null), 3000)
  }

  async function mergeOneGroup(group: PlayerRow[]) {
    const key = phoneCore(group[0].phone)
    setBusy(true)
    const err = await applyMerge(group, groupKeeper[key])
    setBusy(false)
    if (err) {
      setStatus(`Merge failed: ${err}`)
      setTimeout(() => setStatus(null), 8000)
      return
    }
    load()
  }

  // Merge a name-suggested group (keyed by the cleaned name in groupKeeper).
  async function mergeNameGroup(group: PlayerRow[]) {
    const key = normCore(group[0].player_name ?? '')
    setBusy(true)
    const err = await applyMerge(group, groupKeeper[key])
    setBusy(false)
    if (err) {
      setStatus(`Merge failed: ${err}`)
      setTimeout(() => setStatus(null), 8000)
      return
    }
    load()
  }

  const setE = (id: string, patch: Partial<Edit>) =>
    setEdits((p) => ({ ...p, [id]: { ...p[id], ...patch } }))

  /** Hand-link a player to a Beeper thread (from the suggested-match chip). */
  async function linkThread(id: string, chatId: string) {
    setBusy(true)
    const { error } = await supabase.from('inbox_outreach').update({ beeper_chat_id: chatId }).eq('id', id)
    setBusy(false)
    if (error) { setStatus(`Error: ${error.message}`); return }
    setStatus('Thread linked.')
    await load()
    setTimeout(() => setStatus(null), 4000)
  }

  return {
    att, venueFilter, setVenueFilter, sortMode, setSortMode,
    singleThreads, linkThread,
    rows, edits, setE, query, setQuery, regionFilter, setRegionFilter,
    status, busy, renames, setRenames, sel, toggleSel, setSel, selectedRows,
    keeperId, setKeeperId, showHidden, setShowHidden, groupKeeper, setGroupKeeper,
    tournamentOnly, setTournamentOnly,
    cashOnly, setCashOnly,
    noContactOnly, setNoContactOnly,
    banOnly, setBanOnly,
    staffOnly, setStaffOnly,
    incompleteOnly, setIncompleteOnly,
    sourceFilter, setSourceFilter, sources,
    fbFriendOnly, setFbFriendOnly, fbFriendCount, importFbFriends, clearFbFriends,
    firstNameOnly, setFirstNameOnly, firstNameOnlyCount,
    badNumberOnly, setBadNumberOnly, badNumberCount, failedSends,
    reviewed, unmarkReviewed,
    chatNetworks, chatTitles,
    load, regionCounts, regions, dupGroups, nameDupGroups, filtered,
    mergeSelected, toggleHidePlayer, savePlayer, renameRegion,
    mergeOneGroup, mergeNameGroup,
    icePlayer, mergePhoneDuplicates,
  }
}
