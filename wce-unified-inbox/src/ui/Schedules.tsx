import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { VENUES } from './usePlayers'
import type { Database } from '../types/database'

type Schedule = Database['public']['Tables']['inbox_schedules']['Row']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] // Postgres dow 0..6

/**
 * Schedules tab — recurring per-venue/game outreach. Each schedule materialises the
 * next game's batch the evening before as a DRAFT (built from the matching venue
 * list), which Justin approves in Batches before it sends. Driven by pg_cron; the
 * "Build due drafts now" button runs the same materialiser on demand.
 */
export function Schedules() {
  const [rows, setRows] = useState<Schedule[]>([])
  const [lists, setLists] = useState<{ id: string; name: string; venue: string | null; game_type: string | null }[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // per-row local edits
  const [tmpl, setTmpl] = useState<Record<string, string>>({})
  const [time, setTime] = useState<Record<string, string>>({})
  // new schedule
  const [nName, setNName] = useState('')
  const [nVenue, setNVenue] = useState('')
  const [nDow, setNDow] = useState('1')
  const [nType, setNType] = useState<'tourney' | 'cash'>('tourney')

  const flash = (m: string) => { setStatus(m); setTimeout(() => setStatus(null), 4000) }

  async function load() {
    const { data } = await supabase.from('inbox_schedules').select('*').order('day_of_week').order('name')
    const list = (data as Schedule[]) ?? []
    setRows(list)
    setTmpl(Object.fromEntries(list.map((s) => [s.id, s.template_body])))
    setTime(Object.fromEntries(list.map((s) => [s.id, s.event_time ?? ''])))
    const { data: ls } = await supabase.from('inbox_lists').select('id, name, venue, game_type').order('venue').order('name')
    setLists((ls as typeof lists) ?? [])
  }
  useEffect(() => { void load() }, [])

  async function saveRow(s: Schedule) {
    setBusy(true)
    await supabase.from('inbox_schedules').update({
      template_body: (tmpl[s.id] ?? '').trim() || s.template_body,
      event_time: (time[s.id] ?? '').trim() || null,
    }).eq('id', s.id)
    setBusy(false)
    flash('Saved.')
    await load()
  }
  async function patch(id: string, p: Partial<Schedule>) {
    await supabase.from('inbox_schedules').update(p).eq('id', id)
    await load()
  }
  async function del(s: Schedule) {
    if (!window.confirm(`Delete the "${s.name}" schedule? Drafts already built are unaffected.`)) return
    await supabase.from('inbox_schedules').delete().eq('id', s.id)
    await load()
  }
  async function createNew() {
    if (!nName.trim()) return flash('Name required.')
    setBusy(true)
    const { error } = await supabase.from('inbox_schedules').insert({
      name: nName.trim(),
      venue: nVenue || null,
      game_type: nType,
      day_of_week: Number(nDow),
      template_body: `Hi {{first_name}}, ${nVenue || 'the game'} is on. Want a seat?`,
    })
    setBusy(false)
    if (error) return flash(`Error: ${error.message}`)
    setNName(''); setNVenue('')
    flash('Schedule created.')
    await load()
  }
  async function materialiseNow() {
    setBusy(true)
    const { data, error } = await supabase.rpc('materialise_due_schedules')
    setBusy(false)
    if (error) return flash(`Error: ${error.message}`)
    flash(`Built ${data ?? 0} draft batch(es). Approve them in Batches.`)
    await load()
  }

  return (
    <div className="mx-auto h-full w-full max-w-4xl overflow-y-auto p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Schedules</h2>
        <div className="flex items-center gap-3">
          <button onClick={() => void materialiseNow()} disabled={busy}
            className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
            Build due drafts now
          </button>
          <button onClick={() => void load()} className="text-sm text-emerald-700 hover:underline">Refresh</button>
        </div>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Each schedule builds the next game&apos;s batch the evening before as a draft, from its venue list, for you to approve in Batches. Runs nightly automatically.
      </p>
      {status && <p className="mb-3 text-sm text-emerald-700">{status}</p>}

      {/* new schedule */}
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3">
        <label className="flex flex-col text-xs text-slate-500">name
          <input value={nName} onChange={(e) => setNName(e.target.value)} placeholder="e.g. Sat Stirling"
            className="mt-0.5 w-40 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500" />
        </label>
        <label className="flex flex-col text-xs text-slate-500">venue
          <select value={nVenue} onChange={(e) => setNVenue(e.target.value)}
            className="mt-0.5 w-36 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500">
            <option value="">—</option>
            {VENUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-500">day
          <select value={nDow} onChange={(e) => setNDow(e.target.value)}
            className="mt-0.5 w-24 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500">
            {DOW.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-500">type
          <select value={nType} onChange={(e) => setNType(e.target.value as 'tourney' | 'cash')}
            className="mt-0.5 w-28 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500">
            <option value="tourney">tourney</option>
            <option value="cash">cash</option>
          </select>
        </label>
        <button onClick={() => void createNew()} disabled={busy}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
          Create
        </button>
      </div>

      <ul className="space-y-3">
        {rows.map((s) => {
          const matchingLists = lists.filter((l) => !l.venue || !s.venue || l.venue === s.venue)
          return (
            <li key={s.id} className={`rounded-lg border p-3 ${s.active ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50 opacity-70'}`}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{s.name}</span>
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{DOW[s.day_of_week]}</span>
                {s.venue && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{s.venue}</span>}
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${s.game_type === 'cash' ? 'bg-teal-100 text-teal-700' : 'bg-amber-100 text-amber-700'}`}>{s.game_type}</span>
                <label className="ml-auto flex items-center gap-1 text-xs text-slate-500">
                  <input type="checkbox" checked={s.active} onChange={(e) => void patch(s.id, { active: e.target.checked })} />
                  active
                </label>
                <button onClick={() => void del(s)} className="text-xs text-slate-400 hover:text-rose-600">delete</button>
              </div>
              <textarea value={tmpl[s.id] ?? ''} onChange={(e) => setTmpl((p) => ({ ...p, [s.id]: e.target.value }))}
                rows={2}
                className="mb-2 w-full rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
                placeholder="Message — use {{first_name}}" />
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-400">time</span>
                <input value={time[s.id] ?? ''} onChange={(e) => setTime((p) => ({ ...p, [s.id]: e.target.value }))} placeholder="6pm"
                  className="w-20 rounded-md border border-slate-200 px-2 py-1" />
                <span className="text-slate-400">list</span>
                <select value={s.list_id ?? ''} onChange={(e) => void patch(s.id, { list_id: e.target.value || null })}
                  className="rounded-md border border-slate-200 px-2 py-1">
                  <option value="">auto (match venue + type)</option>
                  {matchingLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <span className="text-slate-400">lead</span>
                <select value={s.lead_days} onChange={(e) => void patch(s.id, { lead_days: Number(e.target.value) })}
                  className="rounded-md border border-slate-200 px-2 py-1">
                  <option value={0}>same day</option>
                  <option value={1}>1 day before</option>
                  <option value={2}>2 days before</option>
                </select>
                <span className="text-slate-400" title="Seats to fill (cash tables). 0 = uncapped / not monitored on Home">seats</span>
                <input type="number" min={0} max={20} value={s.seat_target}
                  onChange={(e) => void patch(s.id, { seat_target: Math.max(0, Number(e.target.value) || 0) })}
                  className="w-14 rounded-md border border-slate-200 px-2 py-1" />
                <button onClick={() => void saveRow(s)} disabled={busy}
                  className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40">Save</button>
                {s.last_materialised_for && <span className="ml-auto text-[11px] text-slate-400">last built for {s.last_materialised_for}</span>}
              </div>
            </li>
          )
        })}
        {rows.length === 0 && <li className="text-sm text-slate-400">No schedules yet.</li>}
      </ul>
    </div>
  )
}
