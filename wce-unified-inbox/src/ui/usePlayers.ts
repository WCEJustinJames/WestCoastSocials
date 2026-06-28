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

// Canonical dropdown vocabularies. Edit these lists to taste — existing
// non-standard values on a player are preserved and shown as the selection.
export const REGIONS = ['North', 'South', 'Central', 'All']
export const VENUES = [
  'MCT', 'Woodvale', 'Bentley', 'Kenwick', 'Kingsley',
  'Leederville', 'Adriatic', 'Stirling', 'Planet Royale',
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
    // Stay on the weekly list if any merged record was on it.
    weekly: ordered.some((r) => r.weekly ?? true),
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
  weekly: boolean
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
  weekly: r.weekly ?? true,
})

/**
 * Shared player-CRM data + operations, used by both the Players tab (browse /
 * edit) and the Merge & Review tab (dedupe / triage). Each consumer gets its own
 * instance; only one tab is mounted at a time, so the cost is a reload on switch.
 */
export function usePlayers() {
  const [rows, setRows] = useState<PlayerRow[]>([])
  const [edits, setEdits] = useState<Record<string, Edit>>({})
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
  // "Weekly list" view: only the players who are actually on the recurring
  // weekly cash send — weekly flag on, and none of the exclusion flags set.
  const [weeklyOnly, setWeeklyOnly] = useState(false)
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
      if (weeklyOnly) {
        // On the weekly list = opted in and not excluded by any standing flag,
        // and actually reachable on some channel.
        const onList =
          (r.weekly ?? true) && !r.do_not_message && !r.hidden &&
          !(r.staff ?? false) && !(r.tournament ?? false) &&
          (!!r.phone?.trim() || !!r.beeper_chat_id?.trim())
        if (!onList) return false
      }
      if (tournamentOnly && !(r.tournament ?? false)) return false
      if (cashOnly && !(r.cash ?? false)) return false
      if (noContactOnly && (!!r.phone?.trim() || !!r.beeper_chat_id?.trim())) return false
      if (banOnly && !r.do_not_message) return false
      if (staffOnly && !(r.staff ?? false)) return false
      if (incompleteOnly && !isIncomplete(r)) return false
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
  }, [rows, query, regionFilter, showHidden, weeklyOnly, tournamentOnly, cashOnly, noContactOnly, banOnly, staffOnly, incompleteOnly, reviewed])

  // How many players are actually on the weekly send right now.
  const weeklyCount = useMemo(
    () =>
      rows.filter(
        (r) =>
          (r.weekly ?? true) && !r.do_not_message && !r.hidden &&
          !(r.staff ?? false) && !(r.tournament ?? false) &&
          (!!r.phone?.trim() || !!r.beeper_chat_id?.trim()),
      ).length,
    [rows],
  )

  const selectedRows = useMemo(() => rows.filter((r) => sel.has(r.id)), [rows, sel])

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
        weekly: e.weekly,
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
              weekly: e.weekly,
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
    weeklyOnly, setWeeklyOnly, weeklyCount,
    tournamentOnly, setTournamentOnly,
    cashOnly, setCashOnly,
    noContactOnly, setNoContactOnly,
    banOnly, setBanOnly,
    staffOnly, setStaffOnly,
    incompleteOnly, setIncompleteOnly,
    reviewed, unmarkReviewed,
    load, regionCounts, regions, dupGroups, filtered,
    mergeSelected, toggleHidePlayer, savePlayer, renameRegion,
    mergeOneGroup, mergeAllDuplicates,
  }
}
