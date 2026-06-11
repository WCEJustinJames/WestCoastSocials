import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

type ListRow = Database['public']['Tables']['inbox_lists']['Row']
type OutreachRow = Database['public']['Tables']['inbox_outreach']['Row']

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

interface ListEdit {
  name: string
  event_day: string
  event_time: string
  venue: string
  notes: string
}
const toEdit = (l: ListRow): ListEdit => ({
  name: l.name,
  event_day: l.event_day ?? '',
  event_time: l.event_time ?? '',
  venue: l.venue ?? '',
  notes: l.notes ?? '',
})

/**
 * Core player message lists. Each list is the standing set of players for a
 * recurring scheduled event (e.g. the Friday cash game). Build the list once
 * here; the Batches tab then picks the whole list as recipients in one click.
 */
export function Lists() {
  const [lists, setLists] = useState<ListRow[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [members, setMembers] = useState<Set<string>>(new Set())
  const [players, setPlayers] = useState<OutreachRow[]>([])
  const [edit, setEdit] = useState<ListEdit | null>(null)
  const [newName, setNewName] = useState('')
  const [newDay, setNewDay] = useState('Fri')
  const [query, setQuery] = useState('')
  const [regionFilter, setRegionFilter] = useState('all')
  const [activityFilter, setActivityFilter] = useState('all')
  const [venueFilter, setVenueFilter] = useState('all')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const flash = (msg: string) => {
    setStatus(msg)
    setTimeout(() => setStatus(null), 3000)
  }

  async function loadLists() {
    const { data } = await supabase
      .from('inbox_lists')
      .select('*')
      .order('created_at', { ascending: true })
    const rows = (data as ListRow[]) ?? []
    setLists(rows)
    const { data: mem } = await supabase.from('inbox_list_members').select('list_id')
    const c: Record<string, number> = {}
    for (const m of mem ?? []) c[m.list_id] = (c[m.list_id] ?? 0) + 1
    setCounts(c)
  }

  async function loadPlayers() {
    // Page through the CRM — a single select() is capped at 1000 rows by
    // PostgREST and there are more players than that.
    const all: OutreachRow[] = []
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data } = await supabase
        .from('inbox_outreach')
        .select('*')
        .eq('do_not_message', false)
        .eq('hidden', false)
        .order('player_name', { ascending: true })
        .range(from, from + PAGE - 1)
      const rows = (data as OutreachRow[]) ?? []
      all.push(...rows)
      if (rows.length < PAGE) break
    }
    setPlayers(all)
  }

  useEffect(() => {
    void loadLists()
    void loadPlayers()
  }, [])

  async function openList(l: ListRow) {
    setActiveId(l.id)
    setEdit(toEdit(l))
    const { data } = await supabase
      .from('inbox_list_members')
      .select('outreach_id')
      .eq('list_id', l.id)
    setMembers(new Set((data ?? []).map((m) => m.outreach_id)))
  }

  async function createList() {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    const { data, error } = await supabase
      .from('inbox_lists')
      .insert({ name, event_day: newDay || null })
      .select('*')
      .single()
    setBusy(false)
    if (error) return flash(`Error: ${error.message}`)
    setNewName('')
    await loadLists()
    if (data) void openList(data as ListRow)
    flash('List created.')
  }

  async function saveDetails() {
    if (!activeId || !edit) return
    setBusy(true)
    const { error } = await supabase
      .from('inbox_lists')
      .update({
        name: edit.name.trim() || 'Untitled list',
        event_day: edit.event_day || null,
        event_time: edit.event_time.trim() || null,
        venue: edit.venue.trim() || null,
        notes: edit.notes.trim() || null,
      })
      .eq('id', activeId)
    setBusy(false)
    if (error) return flash(`Error: ${error.message}`)
    flash('Saved.')
    loadLists()
  }

  async function deleteList() {
    if (!activeId) return
    const l = lists.find((x) => x.id === activeId)
    if (!window.confirm(`Delete list “${l?.name}” and its ${counts[activeId] ?? 0} member(s)?`))
      return
    setBusy(true)
    await supabase.from('inbox_lists').delete().eq('id', activeId)
    setBusy(false)
    setActiveId(null)
    setEdit(null)
    setMembers(new Set())
    loadLists()
    flash('List deleted.')
  }

  async function addMember(outreachId: string) {
    if (!activeId) return
    await supabase
      .from('inbox_list_members')
      .upsert({ list_id: activeId, outreach_id: outreachId })
    setMembers((p) => new Set(p).add(outreachId))
    setCounts((p) => ({ ...p, [activeId]: (p[activeId] ?? 0) + 1 }))
  }

  async function removeMember(outreachId: string) {
    if (!activeId) return
    await supabase
      .from('inbox_list_members')
      .delete()
      .eq('list_id', activeId)
      .eq('outreach_id', outreachId)
    setMembers((p) => {
      const next = new Set(p)
      next.delete(outreachId)
      return next
    })
    setCounts((p) => ({ ...p, [activeId]: Math.max(0, (p[activeId] ?? 1) - 1) }))
  }

  async function addAllFiltered() {
    if (!activeId || candidates.length === 0) return
    setBusy(true)
    const rows = candidates.map((p) => ({ list_id: activeId, outreach_id: p.id }))
    const { error } = await supabase.from('inbox_list_members').upsert(rows)
    setBusy(false)
    if (error) return flash(`Error: ${error.message}`)
    setMembers((prev) => new Set([...prev, ...candidates.map((p) => p.id)]))
    setCounts((p) => ({ ...p, [activeId]: (p[activeId] ?? 0) + candidates.length }))
    flash(`Added ${candidates.length} player(s).`)
  }

  const regions = useMemo(
    () => Array.from(new Set(players.map((p) => p.region).filter(Boolean) as string[])).sort(),
    [players],
  )
  const activities = useMemo(
    () => Array.from(new Set(players.map((p) => p.activity).filter(Boolean) as string[])).sort(),
    [players],
  )
  const venueOpts = useMemo(
    () => Array.from(new Set(players.flatMap((p) => p.venues ?? []))).sort(),
    [players],
  )

  const playerName = (p: OutreachRow) =>
    p.player_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || '—'

  // Players matching the add-panel filters who aren't members yet.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase()
    return players.filter((p) => {
      if (members.has(p.id)) return false
      if (regionFilter !== 'all') {
        const rg = (p.region ?? '').toLowerCase()
        if (!rg.includes('all area') && !rg.includes(regionFilter.toLowerCase())) return false
      }
      if (activityFilter !== 'all' && p.activity !== activityFilter) return false
      if (venueFilter !== 'all' && !(p.venues ?? []).includes(venueFilter)) return false
      if (q && !playerName(p).toLowerCase().includes(q) && !(p.phone ?? '').includes(q))
        return false
      return true
    })
  }, [players, members, query, regionFilter, activityFilter, venueFilter])

  const memberRows = useMemo(
    () => players.filter((p) => members.has(p.id)),
    [players, members],
  )
  const active = lists.find((l) => l.id === activeId) ?? null

  return (
    <div className="mx-auto h-full w-full max-w-4xl overflow-y-auto p-6">
      <h2 className="text-lg font-semibold">Player lists</h2>
      <p className="mb-4 text-sm text-slate-500">
        One standing list per scheduled event (e.g. Friday cash game). Build it once here,
        then pick the whole list as recipients on the Batches tab.
      </p>
      {status && <p className="mb-3 text-sm text-emerald-700">{status}</p>}

      {/* List picker + create */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {lists.map((l) => (
          <button
            key={l.id}
            onClick={() => void openList(l)}
            className={`rounded-full px-3 py-1 text-sm ${
              l.id === activeId ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {l.name}
            {l.event_day ? ` · ${l.event_day}` : ''} ({counts[l.id] ?? 0})
          </button>
        ))}
        <div className="flex items-center gap-1">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void createList()}
            placeholder="New list name…"
            className="w-44 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
          />
          <select
            value={newDay}
            onChange={(e) => setNewDay(e.target.value)}
            className="rounded-md border border-slate-300 px-1 py-1 text-sm"
          >
            <option value="">day —</option>
            {DAYS.map((d) => (<option key={d} value={d}>{d}</option>))}
          </select>
          <button
            onClick={() => void createList()}
            disabled={busy || !newName.trim()}
            className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            Create
          </button>
        </div>
      </div>

      {!active && (
        <p className="text-sm text-slate-400">
          Pick a list above to manage its players{lists.length === 0 && ', or create one'}.
        </p>
      )}

      {active && edit && (
        <>
          {/* List details */}
          <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                className="min-w-[12rem] flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm font-medium outline-none focus:border-emerald-500"
              />
              <select
                value={edit.event_day}
                onChange={(e) => setEdit({ ...edit, event_day: e.target.value })}
                className="rounded-md border border-slate-300 px-1 py-1 text-sm"
              >
                <option value="">day —</option>
                {DAYS.map((d) => (<option key={d} value={d}>{d}</option>))}
              </select>
              <input
                value={edit.event_time}
                onChange={(e) => setEdit({ ...edit, event_time: e.target.value })}
                placeholder="time, e.g. 7pm"
                className="w-28 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
              />
              <input
                value={edit.venue}
                onChange={(e) => setEdit({ ...edit, venue: e.target.value })}
                placeholder="venue"
                className="w-36 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
              />
              <button
                onClick={() => void saveDetails()}
                disabled={busy}
                className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                Save
              </button>
              <button
                onClick={() => void deleteList()}
                disabled={busy}
                className="text-xs text-slate-400 hover:text-rose-600"
              >
                delete list
              </button>
            </div>
            <input
              value={edit.notes}
              onChange={(e) => setEdit({ ...edit, notes: e.target.value })}
              placeholder="notes (buy-in, format, anything the operator should know)"
              className="mt-2 w-full rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-emerald-500"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {/* Members */}
            <div>
              <h3 className="mb-1 text-sm font-medium">
                On the list ({memberRows.length})
              </h3>
              <div className="max-h-96 overflow-y-auto rounded-md border border-slate-200 bg-white">
                {memberRows.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-sm last:border-0"
                  >
                    <span className="flex-1">{playerName(p)}</span>
                    <span className="text-xs text-slate-400">{p.region ?? ''}</span>
                    {p.beeper_chat_id && (
                      <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">thread</span>
                    )}
                    <button
                      onClick={() => void removeMember(p.id)}
                      className="text-xs text-slate-300 hover:text-rose-600"
                    >
                      remove
                    </button>
                  </div>
                ))}
                {memberRows.length === 0 && (
                  <p className="p-3 text-sm text-slate-400">
                    No players yet — add them from the right.
                  </p>
                )}
              </div>
            </div>

            {/* Add players */}
            <div>
              <h3 className="mb-1 text-sm font-medium">Add players</h3>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name or phone…"
                  className="min-w-[10rem] flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
                />
                <input
                  list="lists-region-list"
                  value={regionFilter === 'all' ? '' : regionFilter}
                  onChange={(e) => setRegionFilter(e.target.value.trim() || 'all')}
                  placeholder="Region…"
                  className="w-28 rounded-md border border-slate-300 px-2 py-1"
                />
                <datalist id="lists-region-list">
                  {regions.map((r) => (<option key={r} value={r} />))}
                </datalist>
                <select
                  value={activityFilter}
                  onChange={(e) => setActivityFilter(e.target.value)}
                  className="rounded-md border border-slate-300 px-1 py-1"
                >
                  <option value="all">All activity</option>
                  {activities.map((a) => (<option key={a} value={a}>{a}</option>))}
                </select>
                <select
                  value={venueFilter}
                  onChange={(e) => setVenueFilter(e.target.value)}
                  className="rounded-md border border-slate-300 px-1 py-1"
                >
                  <option value="all">All venues</option>
                  {venueOpts.map((v) => (<option key={v} value={v}>{v}</option>))}
                </select>
                <button
                  onClick={() => void addAllFiltered()}
                  disabled={busy || candidates.length === 0}
                  className="rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
                >
                  Add all shown ({candidates.length})
                </button>
              </div>
              <div className="max-h-96 overflow-y-auto rounded-md border border-slate-200 bg-white">
                {candidates.slice(0, 300).map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-sm last:border-0 hover:bg-slate-50"
                  >
                    <span className="flex-1">{playerName(p)}</span>
                    <span className="text-xs text-slate-400">{p.region ?? ''}</span>
                    <span className="text-xs text-slate-400">{p.activity ?? ''}</span>
                    <button
                      onClick={() => void addMember(p.id)}
                      className="rounded-md bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-emerald-700"
                    >
                      Add
                    </button>
                  </div>
                ))}
                {candidates.length === 0 && (
                  <p className="p-3 text-sm text-slate-400">
                    {players.length === 0
                      ? 'CRM empty — run the sync with AIRTABLE_API_KEY set.'
                      : 'Everyone matching is already on the list.'}
                  </p>
                )}
              </div>
              {candidates.length > 300 && (
                <p className="mt-1 text-xs text-slate-400">
                  Showing first 300 — narrow with search, or “Add all shown” adds every match.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
