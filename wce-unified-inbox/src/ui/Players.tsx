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
  activity: string
  do_not_message: boolean
  contact_day: string
  contact_window: string
  contact_frequency_days: string
  rapport: number
}
const toEdit = (r: Row): Edit => ({
  player_name: r.player_name ?? '',
  phone: r.phone ?? '',
  region: r.region ?? '',
  stakes: (r.stakes ?? []).join(', '),
  activity: r.activity ?? '',
  do_not_message: r.do_not_message,
  contact_day: r.contact_day ?? '',
  contact_window: r.contact_window ?? '',
  contact_frequency_days: r.contact_frequency_days != null ? String(r.contact_frequency_days) : '',
  rapport: r.rapport ?? 0,
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

  function load() {
    supabase
      .from('inbox_outreach')
      .select('*')
      .order('player_name', { ascending: true })
      .then(({ data }) => {
        const list = (data as Row[]) ?? []
        setRows(list)
        setEdits(Object.fromEntries(list.map((r) => [r.id, toEdit(r)])))
        setRenames({})
      })
  }
  useEffect(load, [])

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
    return rows.filter((r) => {
      if (!showHidden && r.hidden) return false
      if (regionFilter !== 'all' && r.region !== regionFilter) return false
      if (q && !(r.player_name ?? '').toLowerCase().includes(q) && !(r.phone ?? '').includes(q))
        return false
      return true
    })
  }, [rows, query, regionFilter, showHidden])

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
        activity: e.activity.trim() || null,
        do_not_message: e.do_not_message,
        contact_day: e.contact_day || null,
        contact_window: e.contact_window || null,
        contact_frequency_days: e.contact_frequency_days ? Number(e.contact_frequency_days) : null,
        rapport: e.rapport || null,
      })
      .eq('id', id)
    setBusy(false)
    if (error) return setStatus(`Error: ${error.message}`)
    setStatus('Saved.')
    setRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              player_name: e.player_name.trim() || null,
              phone: e.phone.trim() || null,
              region: e.region.trim() || null,
              stakes: e.stakes.split(',').map((s) => s.trim()).filter(Boolean),
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
        <select
          value={regionFilter}
          onChange={(e) => setRegionFilter(e.target.value)}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="all">All regions</option>
          {regions.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
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
          return (
            <li
              key={r.id}
              className={`rounded-lg border bg-white p-2 ${r.hidden ? 'border-slate-200 opacity-60' : 'border-slate-200'}`}
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
                  placeholder="Phone"
                  className="w-32 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
                />
                {r.beeper_chat_id && (
                  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">thread</span>
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
                <input
                  value={e.region}
                  onChange={(ev) => setE(r.id, { region: ev.target.value })}
                  placeholder="Region / venue"
                  className="w-44 rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-emerald-500"
                />
                <input
                  value={e.stakes}
                  onChange={(ev) => setE(r.id, { stakes: ev.target.value })}
                  placeholder="Tags / stakes (comma-separated)"
                  className="min-w-[12rem] flex-1 rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-emerald-500"
                />
                <input
                  value={e.activity}
                  onChange={(ev) => setE(r.id, { activity: ev.target.value })}
                  placeholder="Activity"
                  className="w-28 rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-emerald-500"
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
