import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useVenues } from './useVenues'
import type { Database } from '../types/database'

type Schedule = Database['public']['Tables']['inbox_schedules']['Row']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] // Postgres dow 0..6

/**
 * Schedules tab — recurring per-venue/game outreach. Each schedule materialises the
 * next game's batch the evening before as a DRAFT (built from the matching venue
 * list), which Justin approves in Batches before it sends. Driven by pg_cron; the
 * "Build due drafts now" button runs the same materialiser on demand.
 */
export function Schedules({ onMessageList }: { onMessageList: (listId: string | null) => void }) {
  const VENUES = useVenues()
  const [rows, setRows] = useState<Schedule[]>([])
  const [lists, setLists] = useState<{ id: string; name: string; venue: string | null; game_type: string | null }[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
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
    <div className="max-w-[860px]">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="m-0 min-w-[240px] flex-1 text-[13px] muted">
          Each schedule builds the next game&apos;s batch the evening before as a draft, from its venue
          list, for you to approve in Batches. Runs nightly automatically.
        </p>
        <button onClick={() => void materialiseNow()} disabled={busy} className="btn btn-primary text-[13px]">
          Build due drafts now
        </button>
        <button onClick={() => void load()} className="btn-quiet">Refresh</button>
      </div>
      {status && (
        <p className="m-0 mb-3 text-[13px] font-semibold" style={{ color: 'var(--color-accent-700)' }}>{status}</p>
      )}

      {/* schedule rows */}
      <ul className="m-0 list-none p-0" style={{ borderTop: '2px solid var(--color-divider)' }}>
        {rows.map((s) => {
          const matchingLists = lists.filter((l) => !l.venue || !s.venue || l.venue === s.venue)
          const open = editing === s.id
          return (
            <li key={s.id} className="row">
              <div className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-x-4 py-3 dt:grid-cols-[120px_90px_90px_minmax(0,1fr)_max-content]">
                <div className={`text-sm font-semibold ${s.active ? '' : 'muted-45'}`}>{s.venue ?? '—'}</div>
                <div className="col-start-2 text-xs muted-60 dt:col-auto">{DOW[s.day_of_week]}</div>
                <div className="col-start-2 text-xs muted-60 tnum dt:col-auto">{(time[s.id] ?? '').trim() || '—'}</div>
                <div className={`col-start-2 min-w-0 text-[13px] dt:col-auto ${s.active ? '' : 'muted-45'}`}>
                  {s.name}
                  <span className="ml-1.5 text-[11px] muted-50">{s.game_type}</span>
                  {!s.active && <span className="tag tag-neutral ml-1.5 text-[10px] uppercase">off</span>}
                </div>
                <div className="col-start-2 flex items-baseline gap-2 dt:col-auto">
                  <button className="btn btn-ghost text-xs" onClick={() => onMessageList(s.list_id ?? null)}>
                    Message list
                  </button>
                  <button className="btn-quiet" onClick={() => setEditing(open ? null : s.id)}>
                    {open ? 'Close' : 'Edit'}
                  </button>
                </div>
              </div>
              {open && (
                <div className="pb-3.5">
                  <div className="field mb-2.5">
                    <label>
                      message — use {'{{first_name}}'}
                      <textarea
                        value={tmpl[s.id] ?? ''}
                        onChange={(e) => setTmpl((p) => ({ ...p, [s.id]: e.target.value }))}
                        rows={2}
                        className="input"
                        placeholder="Message — use {{first_name}}"
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                    <div className="field">
                      <label>
                        time
                        <input
                          value={time[s.id] ?? ''}
                          onChange={(e) => setTime((p) => ({ ...p, [s.id]: e.target.value }))}
                          placeholder="6pm"
                          className="input !w-24 tnum"
                        />
                      </label>
                    </div>
                    <div className="field">
                      <label>
                        list
                        <select
                          value={s.list_id ?? ''}
                          onChange={(e) => void patch(s.id, { list_id: e.target.value || null })}
                          className="input"
                        >
                          <option value="">auto (match venue + type)</option>
                          {matchingLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </select>
                      </label>
                    </div>
                    <div className="field">
                      <label>
                        lead
                        <select
                          value={s.lead_days}
                          onChange={(e) => void patch(s.id, { lead_days: Number(e.target.value) })}
                          className="input"
                        >
                          <option value={0}>same day</option>
                          <option value={1}>1 day before</option>
                          <option value={2}>2 days before</option>
                        </select>
                      </label>
                    </div>
                    <div className="field" title="Seats to fill (cash tables). 0 = uncapped / not monitored on Home">
                      <label>
                        seats
                        <input
                          type="number"
                          min={0}
                          max={20}
                          value={s.seat_target}
                          onChange={(e) => void patch(s.id, { seat_target: Math.max(0, Number(e.target.value) || 0) })}
                          className="input !w-20 tnum"
                        />
                      </label>
                    </div>
                    <label className="flex items-center gap-1.5 pb-2 text-xs muted-70">
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={s.active}
                        onChange={(e) => void patch(s.id, { active: e.target.checked })}
                      />
                      active
                    </label>
                    <button onClick={() => void saveRow(s)} disabled={busy} className="btn btn-secondary !text-xs">
                      Save
                    </button>
                    <button onClick={() => void del(s)} className="btn-quiet pb-2">delete</button>
                    {s.last_materialised_for && (
                      <span className="pb-2 text-[11px] muted-45 tnum">last built for {s.last_materialised_for}</span>
                    )}
                  </div>
                </div>
              )}
            </li>
          )
        })}
        {rows.length === 0 && <li className="row py-3 text-[13px] muted">No schedules yet.</li>}
      </ul>

      {/* new schedule */}
      <div className="mt-8">
        <div className="section-head">
          <span className="kicker">New schedule</span>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-2">
          <div className="field">
            <label>
              name
              <input
                value={nName}
                onChange={(e) => setNName(e.target.value)}
                placeholder="e.g. Sat Stirling"
                className="input !w-44"
              />
            </label>
          </div>
          <div className="field">
            <label>
              venue
              <select value={nVenue} onChange={(e) => setNVenue(e.target.value)} className="input !w-40">
                <option value="">—</option>
                {VENUES.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
          <div className="field">
            <label>
              day
              <select value={nDow} onChange={(e) => setNDow(e.target.value)} className="input !w-24">
                {DOW.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </label>
          </div>
          <div className="field">
            <label>
              type
              <select value={nType} onChange={(e) => setNType(e.target.value as 'tourney' | 'cash')} className="input !w-28">
                <option value="tourney">tourney</option>
                <option value="cash">cash</option>
              </select>
            </label>
          </div>
          <button onClick={() => void createNew()} disabled={busy} className="btn btn-secondary text-[13px]">
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
