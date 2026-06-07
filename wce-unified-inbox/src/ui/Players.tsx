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

function mergeRows(rows: Row[]): { primary: Row; merged: Partial<Row>; dropIds: string[] } {
  const ordered = [...rows].sort(
    (a, b) =>
      (b.beeper_chat_id ? 4 : 0) - (a.beeper_chat_id ? 4 : 0) +
      ((b.airtable_id.startsWith('receipt:') ? 0 : 2) - (a.airtable_id.startsWith('receipt:') ? 0 : 2)) +
      (filledCount(b) - filledCount(a)),
  )
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
}
const toEdit = (r: Row): Edit => ({
  player_name: r.player_name ?? '',
  phone: r.phone ?? '',
  region: r.region ?? '',
  stakes: (r.stakes ?? []).join(', '),
  activity: r.activity ?? '',
  do_not_message: r.do_not_message,
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
      if (regionFilter !== 'all' && r.region !== regionFilter) return false
      if (q && !(r.player_name ?? '').toLowerCase().includes(q) && !(r.phone ?? '').includes(q))
        return false
      return true
    })
  }, [rows, query, regionFilter])

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

      {/* Merge duplicates */}
      {dupGroups.length > 0 && (
        <button
          onClick={() => void mergeAllDuplicates()}
          disabled={busy}
          className="mb-4 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
        >
          Merge all {dupGroups.length} phone-duplicate groups
        </button>
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
      </div>
      <p className="mb-2 text-xs text-slate-400">{filtered.length} shown</p>

      <ul className="space-y-2">
        {filtered.slice(0, 300).map((r) => {
          const e = edits[r.id]
          if (!e) return null
          return (
            <li key={r.id} className="rounded-lg border border-slate-200 bg-white p-2">
              <div className="flex flex-wrap items-center gap-2">
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
