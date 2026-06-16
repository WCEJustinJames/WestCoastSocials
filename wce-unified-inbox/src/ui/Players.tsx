import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

type Row = Database['public']['Tables']['inbox_outreach']['Row']

const phoneCore = (p: string | null): string =>
  p ? p.replace(/\D/g, '').replace(/^61/, '').replace(/^0/, '') : ''
const firstNonEmpty = (vals: (string | null)[]): string | null =>
  vals.find((v) => v != null && String(v).trim() !== '') ?? null
const unionArr = (arrs: (string[] | null)[]): string[] =>
  Array.from(new Set(arrs.flatMap((a) => a ?? []))).sort()
const filledCount = (r: Row): number =>
  [r.player_name, r.email, r.region, r.beeper_chat_id, r.activity, r.outreach_status].filter(Boolean)
    .length + (r.stakes?.length ?? 0) + (r.venues?.length ?? 0)

// Canonical dropdown vocabularies. Edit these lists to taste — existing
// non-standard values on a player are preserved and shown as the selection.
const REGIONS = ['North', 'South', 'Central', 'All']
const VENUES = [
  'MCT', 'Woodvale', 'Bentley', 'Kenwick', 'Kingsley',
  'Leederville', 'Adriatic', 'Stirling', 'Planet Royale',
]
const STAKES = ['$2/5', '$5/10', '$2/5/10', 'PLO']

function mergeRows(
  rows: Row[],
  keeperId?: string,
): { primary: Row; merged: Partial<Row>; dropIds: string[] } {
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
  const merged: Partial<Row> = {
    player_name: firstNonEmpty(ordered.map((r) => r.player_name)),
    first_name: firstNonEmpty(ordered.map((r) => r.first_name)),
    last_name: firstNonEmpty(ordered.map((r) => r.last_name)),
    phone: firstNonEmpty(ordered.map((r) => r.phone)),
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

interface Edit {
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
}
const toEdit = (r: Row): Edit => ({
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
})

export function Players() {
  const [rows, setRows] = useState<Row[]>([])
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
    const list: Row[] = []
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data } = await supabase
        .from('inbox_outreach')
        .select('*')
        .order('player_name', { ascending: true })
        .range(from, from + PAGE - 1)
      const rows = (data as Row[]) ?? []
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
    const byPhone = new Map<string, Row[]>()
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
  }, [rows, query, regionFilter, showHidden, reviewed])

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

  async function mergeOneGroup(group: Row[]) {
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

  return (
    <div className="mx-auto h-full w-full max-w-4xl overflow-y-auto p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Players (CRM)</h2>
        <button onClick={load} className="text-sm text-emerald-700 hover:underline">
          Refresh
        </button>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        {rows.length} players · {dupGroups.length} phone-duplicate group(s) · {regions.length} region values.
      </p>
      {status && <p className="mb-3 text-sm text-emerald-700">{status}</p>}

      {/* Tidy region/venue values */}
      <details className="mb-4 rounded-lg border border-slate-200 bg-white p-3" open>
        <summary className="cursor-pointer text-sm font-medium">
          Tidy region / venue values ({regions.length})
        </summary>
        <p className="my-2 text-xs text-slate-500">
          Rename a value to merge variants — e.g. set “woodvale” and “the woodvale tavern” both to
          “Woodvale Tavern”. Applies to every player with that value.
        </p>
        <ul className="space-y-1">
          {regionCounts.map(([region, count]) => (
            <li key={region} className="flex items-center gap-2">
              <span className="w-10 text-right text-xs text-slate-400">{count}</span>
              <input
                defaultValue={region}
                onChange={(e) => setRenames((p) => ({ ...p, [region]: e.target.value }))}
                className="flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
              />
              <button
                onClick={() => void renameRegion(region)}
                disabled={busy}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-40"
              >
                Apply
              </button>
            </li>
          ))}
          {regions.length === 0 && <li className="text-sm text-slate-400">No region values yet.</li>}
        </ul>
      </details>

      {/* Merge duplicates — pick the name to keep per group */}
      {dupGroups.length > 0 && (
        <details className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
          <summary className="cursor-pointer text-sm font-medium">
            Phone duplicates ({dupGroups.length}) — pick the correct name, then Merge
          </summary>
          <button
            onClick={() => void mergeAllDuplicates()}
            disabled={busy}
            className="my-2 rounded-md border border-slate-300 px-3 py-1 text-xs hover:bg-slate-100 disabled:opacity-40"
          >
            Merge all (auto-pick the most complete name)
          </button>
          <ul className="space-y-2">
            {dupGroups.slice(0, 50).map((g) => {
              const key = phoneCore(g[0].phone)
              const chosen = groupKeeper[key] ?? mergeRows(g).primary.id
              const tag = (r: Row) =>
                r.airtable_id.startsWith('gcsv:') ? 'google'
                  : r.airtable_id.startsWith('receipt:') ? 'receipt' : 'airtable'
              return (
                <li key={key} className="rounded border border-slate-100 p-2">
                  <div className="mb-1 text-xs text-slate-400">{g[0].phone}</div>
                  <div className="flex flex-wrap items-center gap-3">
                    {g.map((r) => (
                      <label key={r.id} className="flex items-center gap-1 text-sm">
                        <input
                          type="radio"
                          name={`grp-${key}`}
                          checked={chosen === r.id}
                          onChange={() => setGroupKeeper((p) => ({ ...p, [key]: r.id }))}
                        />
                        {r.player_name ?? '(no name)'}
                        <span className="text-[10px] text-slate-400">{tag(r)}</span>
                      </label>
                    ))}
                    <button
                      onClick={() => void mergeOneGroup(g)}
                      disabled={busy}
                      className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                    >
                      Merge
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
          {dupGroups.length > 50 && (
            <p className="mt-1 text-xs text-slate-400">
              Showing first 50 — merge these, then Refresh for the next batch.
            </p>
          )}
        </details>
      )}

      {/* Player editor */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name or phone…"
          className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
        />
        <input
          list="players-region-list"
          value={regionFilter === 'all' ? '' : regionFilter}
          onChange={(e) => setRegionFilter(e.target.value.trim() || 'all')}
          placeholder="Region…"
          className="w-40 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
        />
        <datalist id="players-region-list">
          {regions.map((r) => (<option key={r} value={r} />))}
        </datalist>
        <label className="flex items-center gap-1 text-xs text-slate-500">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          show hidden
        </label>
      </div>
      <p className="mb-2 text-xs text-slate-400">{filtered.length} shown</p>

      {/* Manual merge: tick 2+ of the same person, pick the correct name */}
      {selectedRows.length >= 2 && (
        <div className="mb-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3">
          <p className="mb-2 text-sm font-medium">
            Merge {selectedRows.length} selected — keep which name?
          </p>
          <div className="mb-2 flex flex-wrap gap-3">
            {selectedRows.map((r) => (
              <label key={r.id} className="flex items-center gap-1 text-sm">
                <input
                  type="radio"
                  name="keeper"
                  checked={keeperId === r.id}
                  onChange={() => setKeeperId(r.id)}
                />
                {r.player_name ?? '(no name)'}
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void mergeSelected()}
              disabled={busy || !keeperId}
              className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              Merge into “{selectedRows.find((r) => r.id === keeperId)?.player_name ?? '…'}”
            </button>
            <button
              onClick={() => { setSel(new Set()); setKeeperId(null) }}
              className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ul className="space-y-2">
        {filtered.slice(0, 300).map((r) => {
          const e = edits[r.id]
          if (!e) return null
          const stakeArr = e.stakes.split(',').map((s) => s.trim()).filter(Boolean)
          const venueArr = e.venues.split(',').map((s) => s.trim()).filter(Boolean)
          const isReviewed = reviewed.has(r.id)
          const hasSms = !!e.phone.trim()
          const hasThread = !!r.beeper_chat_id
          return (
            <li
              key={r.id}
              className={`rounded-lg border p-2 ${r.hidden ? 'opacity-60 ' : ''}${
                isReviewed
                  ? 'border-emerald-300 border-l-4 border-l-emerald-500 bg-emerald-50/60 shadow-sm'
                  : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="checkbox"
                  title="Select to merge"
                  checked={sel.has(r.id)}
                  onChange={() => toggleSel(r.id)}
                />
                <input
                  value={e.player_name}
                  onChange={(ev) => setE(r.id, { player_name: ev.target.value })}
                  placeholder="Name"
                  className="min-w-[10rem] flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
                />
                <input
                  value={e.phone}
                  onChange={(ev) => setE(r.id, { phone: ev.target.value })}
                  placeholder={hasThread && !hasSms ? 'no mobile' : 'Phone'}
                  className="w-32 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
                />
                {/* Channel(s) this player is reachable on. When they have both SMS
                    and Messenger, the chips become a preference toggle. */}
                {hasSms && hasThread ? (
                  <span className="flex items-center gap-1">
                    <span className="text-[10px] text-slate-400">reach via</span>
                    <button
                      type="button"
                      title="Prefer SMS for this player"
                      onClick={() => setE(r.id, { preferred_channel: e.preferred_channel === 'sms' ? '' : 'sms' })}
                      className={`rounded-full px-1.5 py-0.5 text-[10px] ${e.preferred_channel === 'sms' ? 'bg-sky-600 text-white' : 'bg-sky-100 text-sky-700'}`}
                    >SMS</button>
                    <button
                      type="button"
                      title="Prefer Messenger for this player"
                      onClick={() => setE(r.id, { preferred_channel: e.preferred_channel === 'thread' ? '' : 'thread' })}
                      className={`rounded-full px-1.5 py-0.5 text-[10px] ${e.preferred_channel === 'thread' ? 'bg-indigo-600 text-white' : 'bg-indigo-100 text-indigo-700'}`}
                    >Messenger</button>
                  </span>
                ) : hasThread ? (
                  <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700">Messenger</span>
                ) : hasSms ? (
                  <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700">SMS</span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">no contact</span>
                )}
                {isReviewed && (
                  <button
                    type="button"
                    title="Reviewed — click to clear"
                    onClick={() => unmarkReviewed(r.id)}
                    className="rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium text-white"
                  >✓ reviewed</button>
                )}
                <label className="flex items-center gap-1 text-xs text-rose-700">
                  <input
                    type="checkbox"
                    checked={e.do_not_message}
                    onChange={(ev) => setE(r.id, { do_not_message: ev.target.checked })}
                  />
                  ban
                </label>
                <button
                  onClick={() => void savePlayer(r.id)}
                  disabled={busy}
                  className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  Save
                </button>
                <button
                  onClick={() => void toggleHidePlayer(r.id, r.hidden)}
                  title={r.hidden ? 'Unhide' : 'Hide from lists'}
                  className="text-xs text-slate-400 hover:text-rose-600"
                >
                  {r.hidden ? 'unhide' : 'hide'}
                </button>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {/* Region (zone) — single-select */}
                <select
                  value={!e.region ? '' : REGIONS.includes(e.region) ? e.region : '__custom__'}
                  onChange={(ev) => {
                    const v = ev.target.value
                    if (v === '__custom__') return
                    if (v === '__other__') {
                      const x = window.prompt('New region')?.trim()
                      if (x) setE(r.id, { region: x })
                      return
                    }
                    setE(r.id, { region: v })
                  }}
                  className="w-32 rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-emerald-500"
                >
                  <option value="">Region —</option>
                  {e.region && !REGIONS.includes(e.region) && (
                    <option value="__custom__">{e.region}</option>
                  )}
                  {REGIONS.map((x) => (
                    <option key={x} value={x}>{x}</option>
                  ))}
                  <option value="__other__">+ Other…</option>
                </select>

                {/* Venue — multi-select */}
                <MultiSelect
                  value={venueArr}
                  options={VENUES}
                  addLabel="+ venue…"
                  otherLabel="New venue"
                  onChange={(next) => setE(r.id, { venues: next.join(', ') })}
                />

                {/* Tags / stakes — multi-select */}
                <MultiSelect
                  value={stakeArr}
                  options={STAKES}
                  addLabel="+ stake / tag…"
                  otherLabel="New tag / stake"
                  onChange={(next) => setE(r.id, { stakes: next.join(', ') })}
                />

                <input
                  value={e.activity}
                  onChange={(ev) => setE(r.id, { activity: ev.target.value })}
                  placeholder="Activity"
                  className="w-24 rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-emerald-500"
                />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-400">contact:</span>
                <select
                  value={e.contact_day}
                  onChange={(ev) => setE(r.id, { contact_day: ev.target.value })}
                  className="rounded-md border border-slate-200 px-1 py-1"
                >
                  <option value="">day —</option>
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
                <select
                  value={e.contact_window}
                  onChange={(ev) => setE(r.id, { contact_window: ev.target.value })}
                  className="rounded-md border border-slate-200 px-1 py-1"
                >
                  <option value="">time —</option>
                  {['Morning', 'Afternoon', 'Evening'].map((w) => (
                    <option key={w} value={w}>{w}</option>
                  ))}
                </select>
                <input
                  value={e.contact_frequency_days}
                  onChange={(ev) => setE(r.id, { contact_frequency_days: ev.target.value.replace(/\D/g, '') })}
                  placeholder="every N days"
                  className="w-24 rounded-md border border-slate-200 px-2 py-1"
                />
                <span className="ml-1 text-slate-400">rapport:</span>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setE(r.id, { rapport: e.rapport === n ? 0 : n })}
                    title={`${n} star${n > 1 ? 's' : ''}`}
                    className={n <= e.rapport ? 'text-amber-500' : 'text-slate-300 hover:text-amber-400'}
                  >
                    ★
                  </button>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
      {filtered.length > 300 && (
        <p className="mt-2 text-xs text-slate-400">Showing first 300 — narrow with search/filter.</p>
      )}
    </div>
  )
}

// Reusable multi-select: removable chips + an "add" dropdown of fixed options
// (with an Other… prompt). Stores nothing itself; parent owns the value array.
function MultiSelect({
  value,
  options,
  onChange,
  addLabel,
  otherLabel,
}: {
  value: string[]
  options: string[]
  onChange: (next: string[]) => void
  addLabel: string
  otherLabel: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((s) => (
        <span
          key={s}
          className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs"
        >
          {s}
          <button
            onClick={() => onChange(value.filter((x) => x !== s))}
            className="text-slate-400 hover:text-rose-600"
          >
            ×
          </button>
        </span>
      ))}
      <select
        value=""
        onChange={(ev) => {
          const v = ev.target.value
          if (!v) return
          if (v === '__other__') {
            const x = window.prompt(otherLabel)?.trim()
            if (x && !value.includes(x)) onChange([...value, x])
            return
          }
          if (!value.includes(v)) onChange([...value, v])
        }}
        className="rounded-md border border-slate-200 px-1 py-1 text-xs"
      >
        <option value="">{addLabel}</option>
        {options.filter((o) => !value.includes(o)).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
        <option value="__other__">Other…</option>
      </select>
    </div>
  )
}
