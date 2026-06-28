import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

export type PlayerRow = Database['public']['Tables']['inbox_outreach']['Row']

export const phoneCore = (p: string | null): string =>
  p ? p.replace(/\D/g, '').replace(/^61/, '').replace(/^0/, '') : ''
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
  const noContact = !r.phone?.trim() && !r.beeper_chat_id?.trim()
  const noRegion = !(r.region ?? '').trim()
  const noStakes = (r.stakes?.length ?? 0) === 0
  const noVenue = (r.venues?.length ?? 0) === 0
  return noContact || noRegion || noStakes || noVenue
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
  /\b(poker|holdem|cash|tourney|tournament|nlh|plo|mtt|mct|woodvale|kenwick|bentley|kingsley|leederville|leedy|stirling|adriatic|kwinana|southside|north|south|central|east|west|hotel|tavern|club|bowls|president|dealer|reserve|home|game|games|player)\b/g
export const normFull = (raw: string): string =>
  raw.toLowerCase().replace(/\$\s*\d[\d/]*/g, ' ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
export const normCore = (raw: string): string =>
  normFull(raw).replace(NAME_NOISE, ' ').replace(/\s+/g, ' ').trim()

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
  } catch { /* not JSON — fall through to line parsing */ }
  for (const line of text.split(/[\n,]+/)) {
    const n = line.replace(/\(.*?\)\s*$/, '').trim()
    if (n) names.push(n)
  }
  return dedupeNames(names)
}

// Canonical dropdown vocabularies. Edit these lists to taste — existing
// non-standard values on a player are preserved and shown as the selection.
export const REGIONS = ['North', 'South', 'Central', 'All']
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
  const merged: Partial<PlayerRow> = {
    player_name: firstNonEmpty(ordered.map((r) => r.player_name)),
    first_name: firstNonEmpty(ordered.map((r) => r.first_name)),
    last_name: firstNonEmpty(ordered.map((r) => r.last_name)),
    // Phone MUST come from the contacts upload (gcsv:) when the person has one
    // there — that's the number saved in Justin's phone. Only fall back to other
    // sources (receipts, TD sheets, Airtable) when there's no contacts number.
    phone:
      firstNonEmpty(ordered.filter((r) => r.airtable_id.startsWith('gcsv:')).map((r) => r.phone)) ??
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
})

/**
 * Shared player-CRM data + operations, used by both the Players tab (browse /
 * edit) and the Merge & Review tab (dedupe / triage). Each consumer gets its own
 * instance; only one tab is mounted at a time, so the cost is a reload on switch.
 */
export function usePlayers() {
  const [rows, setRows] = useState<PlayerRow[]>([])
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  // external_chat_id -> network ('Google Messages', 'Facebook/Messenger', …) so a
  // card can show the thread's REAL channel instead of assuming Messenger.
  const [chatNetworks, setChatNetworks] = useState<Map<string, string>>(new Map())
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
  // collect-their-number-in-person list.
  const [noContactOnly, setNoContactOnly] = useState(false)
  // "Banned" view: do_not_message set (opted out / barred).
  const [banOnly, setBanOnly] = useState(false)
  // "Staff" view: dealers / permit holders / crew (never proactively invited).
  const [staffOnly, setStaffOnly] = useState(false)
  // "Incomplete" view: records still missing contact / region / stakes / venue.
  const [incompleteOnly, setIncompleteOnly] = useState(false)
  // Filter by where the contact came from (phone / TD sheet / facebook / …).
  const [sourceFilter, setSourceFilter] = useState('all')
  // "FB · DM to open" view: Facebook friends with no thread yet (from importer).
  const [fbFriendOnly, setFbFriendOnly] = useState(false)
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
    setEdits(Object.fromEntries(list.map((r) => [r.id, toEdit(r)])))
    setRenames({})

    // Resolve each linked thread's network (a Beeper thread is often SMS via
    // Google Messages, not Messenger) so the card badge shows the right channel.
    const { data: convs } = await supabase
      .from('inbox_conversations')
      .select('external_chat_id, network')
      .limit(5000)
    const nets = new Map<string, string>()
    for (const c of (convs as { external_chat_id: string | null; network: string | null }[]) ?? []) {
      if (c.external_chat_id && c.network) nets.set(c.external_chat_id, c.network)
    }
    setChatNetworks(nets)
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
      if (!key) continue
      ;(byPhone.get(key) ?? byPhone.set(key, []).get(key)!).push(r)
    }
    return [...byPhone.values()].filter((g) => g.length > 1)
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = rows.filter((r) => {
      if (!showHidden && r.hidden) return false
      if (tournamentOnly && !(r.tournament ?? false)) return false
      if (cashOnly && !(r.cash ?? false)) return false
      if (noContactOnly && (!!r.phone?.trim() || !!r.beeper_chat_id?.trim())) return false
      if (banOnly && !r.do_not_message) return false
      if (staffOnly && !(r.staff ?? false)) return false
      if (incompleteOnly && !isIncomplete(r)) return false
      if (sourceFilter !== 'all' && sourceLabel(r) !== sourceFilter) return false
      if (fbFriendOnly && !(r.fb_friend && !r.phone?.trim() && !r.beeper_chat_id?.trim())) return false
      if (regionFilter !== 'all') {
        const rg = (r.region ?? '').toLowerCase()
        if (!rg.includes('all area') && !rg.includes(regionFilter.toLowerCase())) return false
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
    // Surface the rows still needing attention: unreviewed first, then most
    // recently added/updated, then alphabetical. Reviewed rows sink to the bottom.
    out.sort((a, b) => {
      const ar = reviewed.has(a.id) ? 1 : 0
      const br = reviewed.has(b.id) ? 1 : 0
      if (ar !== br) return ar - br
      const at = a.synced_at ?? ''
      const bt = b.synced_at ?? ''
      if (at !== bt) return at < bt ? 1 : -1
      return (a.player_name ?? '').localeCompare(b.player_name ?? '')
    })
    return out
  }, [rows, query, regionFilter, showHidden, tournamentOnly, cashOnly, noContactOnly, banOnly, staffOnly, incompleteOnly, sourceFilter, fbFriendOnly, reviewed])

  // Distinct sources present, with counts, for the Merge & Review source filter.
  const sources = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) {
      const s = sourceLabel(r)
      m.set(s, (m.get(s) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])

  // FB friends still needing a first DM (friend flag set, no thread/phone yet).
  const fbFriendCount = useMemo(
    () => rows.filter((r) => r.fb_friend && !r.phone?.trim() && !r.beeper_chat_id?.trim()).length,
    [rows],
  )

  const selectedRows = useMemo(() => rows.filter((r) => sel.has(r.id)), [rows, sel])

  // Cross-check a pasted Facebook friends list against every CRM name and set the
  // fb_friend flag. Matches on the cleaned name (with and without venue/stake
  // noise), so "Chris Pavitt $2/5/10 MCT Woodvale" still lines up with "Chris
  // Pavitt". Reconciles: a name no longer on the list is un-flagged.
  async function importFbFriends(raw: string): Promise<{ friends: number; flagged: number; cleared: number }> {
    const friends = parseFriendNames(raw)
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

  async function mergeSelected() {
    if (selectedRows.length < 2) return
    setBusy(true)
    const { primary, merged, dropIds } = mergeRows(selectedRows, keeperId ?? undefined)
    await supabase.from('inbox_outreach').update(merged).eq('id', primary.id)
    if (dropIds.length) await supabase.from('inbox_outreach').delete().in('id', dropIds)
    setBusy(false)
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
    const { primary, merged, dropIds } = mergeRows(group, groupKeeper[key])
    await supabase.from('inbox_outreach').update(merged).eq('id', primary.id)
    if (dropIds.length) await supabase.from('inbox_outreach').delete().in('id', dropIds)
    setBusy(false)
    load()
  }

  async function mergeAllDuplicates() {
    setBusy(true)
    setStatus('Merging duplicates…')
    for (const g of dupGroups) {
      const { primary, merged, dropIds } = mergeRows(g)
      await supabase.from('inbox_outreach').update(merged).eq('id', primary.id)
      if (dropIds.length) await supabase.from('inbox_outreach').delete().in('id', dropIds)
    }
    setBusy(false)
    setStatus(`Merged ${dupGroups.length} duplicate group(s).`)
    load()
    setTimeout(() => setStatus(null), 4000)
  }

  const setE = (id: string, patch: Partial<Edit>) =>
    setEdits((p) => ({ ...p, [id]: { ...p[id], ...patch } }))

  return {
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
    reviewed, unmarkReviewed,
    chatNetworks,
    load, regionCounts, regions, dupGroups, filtered,
    mergeSelected, toggleHidePlayer, savePlayer, renameRegion,
    mergeOneGroup, mergeAllDuplicates,
  }
}
