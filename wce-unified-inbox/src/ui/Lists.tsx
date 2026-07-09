import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { VENUES } from './usePlayers'
import type { Database } from '../types/database'

type ListRow = Database['public']['Tables']['inbox_lists']['Row']
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

interface Member {
  outreach_id: string
  added_by: string
  pinned: boolean
  player_name: string | null
  phone: string | null
  beeper_chat_id: string | null
  snooze_until: string | null
  do_not_message: boolean
}

// "On ice" = snoozed to a future date (matches the Who's-out panel's rose shading).
const onIce = (iso: string | null): boolean => !!iso && iso >= new Date().toISOString().slice(0, 10)

/**
 * Lists tab — standing player lists keyed by (venue x cash|tourney) for the weekly
 * games. Tourney lists auto-seed from attendance (>=2 games at the venue in 90d);
 * cash lists are built by hand. Membership is add-only from the seed; you remove
 * by hand. These lists are the recipient source the Batches picker loads from.
 */
export function Lists() {
  const [lists, setLists] = useState<ListRow[]>([])
  const [counts, setCounts] = useState<Map<string, number>>(new Map())
  const [selId, setSelId] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // create-list form
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')
  const [gameType, setGameType] = useState<'tourney' | 'cash'>('tourney')
  const [day, setDay] = useState('')
  const [time, setTime] = useState('')

  // add-member search
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<{ id: string; player_name: string | null; phone: string | null }[]>([])

  const flash = (m: string) => { setStatus(m); setTimeout(() => setStatus(null), 3000) }

  async function load() {
    const { data: ls } = await supabase.from('inbox_lists').select('*').order('venue').order('game_type').order('name')
    setLists((ls as ListRow[]) ?? [])
    const { data: mc } = await supabase.from('inbox_list_members').select('list_id')
    const m = new Map<string, number>()
    for (const r of (mc as { list_id: string }[]) ?? []) m.set(r.list_id, (m.get(r.list_id) ?? 0) + 1)
    setCounts(m)
  }
  useEffect(() => { void load() }, [])

  async function loadMembers(listId: string) {
    const { data: mm } = await supabase
      .from('inbox_list_members')
      .select('outreach_id, added_by, pinned')
      .eq('list_id', listId)
    const rows = (mm as { outreach_id: string; added_by: string; pinned: boolean }[]) ?? []
    const ids = rows.map((r) => r.outreach_id)
    const byId = new Map<string, { player_name: string | null; phone: string | null; beeper_chat_id: string | null; snooze_until: string | null; do_not_message: boolean }>()
    for (let i = 0; i < ids.length; i += 500) {
      const { data: os } = await supabase
        .from('inbox_outreach')
        .select('id, player_name, phone, beeper_chat_id, snooze_until, do_not_message')
        .in('id', ids.slice(i, i + 500))
      for (const o of (os as { id: string; player_name: string | null; phone: string | null; beeper_chat_id: string | null; snooze_until: string | null; do_not_message: boolean }[]) ?? [])
        byId.set(o.id, o)
    }
    const merged: Member[] = rows.map((r) => ({
      outreach_id: r.outreach_id,
      added_by: r.added_by,
      pinned: r.pinned,
      player_name: byId.get(r.outreach_id)?.player_name ?? null,
      phone: byId.get(r.outreach_id)?.phone ?? null,
      beeper_chat_id: byId.get(r.outreach_id)?.beeper_chat_id ?? null,
      snooze_until: byId.get(r.outreach_id)?.snooze_until ?? null,
      do_not_message: byId.get(r.outreach_id)?.do_not_message ?? false,
    }))
    merged.sort((a, b) => (a.player_name ?? '').localeCompare(b.player_name ?? ''))
    setMembers(merged)
  }
  function select(id: string) { setSelId(id); setQ(''); setHits([]); void loadMembers(id) }

  const selected = useMemo(() => lists.find((l) => l.id === selId) ?? null, [lists, selId])

  async function createList() {
    if (!name.trim()) return flash('Name required.')
    setBusy(true)
    const { error } = await supabase.from('inbox_lists').insert({
      name: name.trim(),
      venue: venue || null,
      game_type: gameType,
      event_day: day || null,
      event_time: time.trim() || null,
    })
    setBusy(false)
    if (error) return flash(`Error: ${error.message}`)
    setName(''); setVenue(''); setDay(''); setTime('')
    flash('List created.')
    await load()
  }

  async function deleteList(l: ListRow) {
    if (!window.confirm(`Delete list "${l.name}" and its ${counts.get(l.id) ?? 0} member(s)? This only removes the list, not the players.`)) return
    setBusy(true)
    await supabase.from('inbox_lists').delete().eq('id', l.id)
    setBusy(false)
    if (selId === l.id) { setSelId(null); setMembers([]) }
    flash('List deleted.')
    await load()
  }

  async function seed(l: ListRow) {
    setBusy(true)
    const { data, error } = await supabase.rpc('seed_tourney_list', { p_list_id: l.id })
    setBusy(false)
    if (error) return flash(`Error: ${error.message}`)
    flash(`Auto-seeded ${data ?? 0} player(s) from attendance.`)
    await load()
    if (selId === l.id) await loadMembers(l.id)
  }

  async function removeMember(m: Member) {
    if (!selId) return
    await supabase.from('inbox_list_members').delete().eq('list_id', selId).eq('outreach_id', m.outreach_id)
    await loadMembers(selId)
    await load()
  }
  async function togglePin(m: Member) {
    if (!selId) return
    await supabase.from('inbox_list_members').update({ pinned: !m.pinned }).eq('list_id', selId).eq('outreach_id', m.outreach_id)
    await loadMembers(selId)
  }

  async function searchPlayers(text: string) {
    setQ(text)
    if (text.trim().length < 2) return setHits([])
    const have = new Set(members.map((m) => m.outreach_id))
    const { data } = await supabase
      .from('inbox_outreach')
      .select('id, player_name, phone')
      .ilike('player_name', `%${text.trim()}%`)
      .eq('hidden', false)
      .order('player_name')
      .limit(20)
    setHits(((data as { id: string; player_name: string | null; phone: string | null }[]) ?? []).filter((h) => !have.has(h.id)))
  }
  async function addMember(id: string) {
    if (!selId) return
    await supabase.from('inbox_list_members').insert({ list_id: selId, outreach_id: id, added_by: 'manual' })
    setQ(''); setHits([])
    await loadMembers(selId)
    await load()
  }

  const chip = (text: string, cls: string) => (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${cls}`}>{text}</span>
  )

  return (
    <div className="mx-auto h-full w-full max-w-7xl overflow-y-auto p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Lists</h2>
        <button onClick={() => void load()} className="text-sm text-emerald-700 hover:underline">Refresh</button>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Standing player lists per venue and game type. Tourney lists auto-seed from attendance; cash lists are built by hand. Load a list in Batches to message it.
      </p>
      {status && <p className="mb-3 text-sm text-emerald-700">{status}</p>}

      {/* New list */}
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3">
        <label className="flex flex-col text-xs text-slate-500">name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Woodvale tourney"
            className="mt-0.5 w-48 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500" />
        </label>
        <label className="flex flex-col text-xs text-slate-500">venue
          <select value={venue} onChange={(e) => setVenue(e.target.value)}
            className="mt-0.5 w-36 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500">
            <option value="">—</option>
            {VENUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-500">type
          <select value={gameType} onChange={(e) => setGameType(e.target.value as 'tourney' | 'cash')}
            className="mt-0.5 w-28 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500">
            <option value="tourney">tourney</option>
            <option value="cash">cash</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-500">day
          <select value={day} onChange={(e) => setDay(e.target.value)}
            className="mt-0.5 w-24 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500">
            <option value="">—</option>
            {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-500">time
          <input value={time} onChange={(e) => setTime(e.target.value)} placeholder="6pm"
            className="mt-0.5 w-20 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500" />
        </label>
        <button onClick={() => void createList()} disabled={busy}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
          Create
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Lists column */}
        <ul className="space-y-2">
          {lists.map((l) => (
            <li key={l.id}
              className={`cursor-pointer rounded-lg border p-2 ${selId === l.id ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
              onClick={() => select(l.id)}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{l.name}</span>
                {l.venue && chip(l.venue, 'bg-slate-100 text-slate-600')}
                {l.game_type === 'cash'
                  ? chip('cash', 'bg-teal-100 text-teal-700')
                  : l.game_type === 'tourney'
                    ? chip('tourney', 'bg-amber-100 text-amber-700')
                    : chip('untyped', 'bg-slate-100 text-slate-400')}
                {l.event_day && chip(`${l.event_day}${l.event_time ? ' ' + l.event_time : ''}`, 'bg-slate-100 text-slate-500')}
                <span className="ml-auto text-xs text-slate-500">{counts.get(l.id) ?? 0} players</span>
              </div>
              <div className="mt-1 flex items-center gap-3 text-[11px]">
                {l.game_type === 'tourney' && (
                  <button onClick={(e) => { e.stopPropagation(); void seed(l) }} disabled={busy}
                    className="text-emerald-700 hover:underline disabled:opacity-40" title="Add players with >=2 tournaments at this venue in the last 90 days">
                    ⟲ auto-seed
                  </button>
                )}
                <button onClick={(e) => { e.stopPropagation(); void deleteList(l) }} className="text-slate-400 hover:text-rose-600">delete</button>
              </div>
            </li>
          ))}
          {lists.length === 0 && <li className="text-sm text-slate-400">No lists yet.</li>}
        </ul>

        {/* Members column */}
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          {!selected ? (
            <p className="text-sm text-slate-400">Select a list to see its players.</p>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">{selected.name} · {members.length} players</span>
                {selected.game_type === 'tourney' && (
                  <button onClick={() => void seed(selected)} disabled={busy} className="text-xs text-emerald-700 hover:underline disabled:opacity-40">⟲ auto-seed</button>
                )}
              </div>
              {/* add member */}
              <div className="relative mb-2">
                <input value={q} onChange={(e) => void searchPlayers(e.target.value)} placeholder="Add a player by name…"
                  className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500" />
                {hits.length > 0 && (
                  <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-slate-200 bg-white shadow">
                    {hits.map((h) => (
                      <li key={h.id}>
                        <button onClick={() => void addMember(h.id)} className="flex w-full items-center justify-between px-2 py-1 text-left text-sm hover:bg-emerald-50">
                          <span>{h.player_name ?? '(no name)'}</span>
                          <span className="text-[10px] text-slate-400">{h.phone ?? ''}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
                {members.map((m) => (
                  <li key={m.outreach_id}
                    className={`flex items-center gap-2 rounded border p-1.5 text-sm ${onIce(m.snooze_until) ? 'border-rose-200 bg-rose-50' : m.do_not_message ? 'border-red-200 bg-red-50' : 'border-slate-100'}`}>
                    <button onClick={() => void togglePin(m)} title={m.pinned ? 'Pinned — unpin' : 'Pin (protect from auto-prune)'}
                      className={m.pinned ? 'text-amber-500' : 'text-slate-300 hover:text-amber-400'}>★</button>
                    <span className="flex-1">{m.player_name ?? '(no name)'}</span>
                    {onIce(m.snooze_until) && chip('❄ on ice', 'bg-rose-100 text-rose-700')}
                    {m.do_not_message && chip('ban', 'bg-red-100 text-red-700')}
                    {chip(m.added_by, m.added_by === 'auto' ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-500')}
                    <span className="text-[10px] text-slate-400">{m.beeper_chat_id ? 'thread' : m.phone ? 'sms' : 'no contact'}</span>
                    <button onClick={() => void removeMember(m)} className="text-slate-400 hover:text-rose-600" title="Remove from list">×</button>
                  </li>
                ))}
                {members.length === 0 && <li className="text-sm text-slate-400">No players yet. Auto-seed (tourney) or add by name.</li>}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
