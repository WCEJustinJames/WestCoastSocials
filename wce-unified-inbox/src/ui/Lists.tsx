import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useVenues } from './useVenues'
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

// "On ice" = snoozed to a future date (matches the Who's-out panel's flagging).
const onIce = (iso: string | null): boolean => !!iso && iso >= new Date().toISOString().slice(0, 10)

/**
 * Lists tab — standing player lists keyed by (venue x cash|tourney) for the weekly
 * games. Tourney lists auto-seed from attendance (>=2 games at the venue in 90d);
 * cash lists are built by hand. Membership is add-only from the seed; you remove
 * by hand. These lists are the recipient source the Batches picker loads from.
 * `onStartBatch` jumps to the Batches composer with the list pre-loaded.
 */
export function Lists({ onStartBatch }: { onStartBatch: (listId: string | null) => void }) {
  const VENUES = useVenues()
  const [lists, setLists] = useState<ListRow[]>([])
  const [counts, setCounts] = useState<Map<string, number>>(new Map())
  const [selId, setSelId] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)

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

  // Monotonic ticket so a slow early query can never overwrite the results of a
  // later keystroke (type-fast races showed stale hit lists).
  const searchSeq = useRef(0)
  async function searchPlayers(text: string) {
    setQ(text)
    const seq = ++searchSeq.current
    if (text.trim().length < 2) return setHits([])
    const have = new Set(members.map((m) => m.outreach_id))
    const { data } = await supabase
      .from('inbox_outreach')
      .select('id, player_name, phone')
      .ilike('player_name', `%${text.trim()}%`)
      .eq('hidden', false)
      .order('player_name')
      .limit(20)
    if (seq !== searchSeq.current) return // superseded by a newer keystroke
    setHits(((data as { id: string; player_name: string | null; phone: string | null }[]) ?? []).filter((h) => !have.has(h.id)))
  }
  async function addMember(id: string) {
    if (!selId) return
    // Upsert with ignore-duplicates: a double-click or a race with auto-seed
    // must not error out (membership PK is list_id+outreach_id).
    const { error } = await supabase.from('inbox_list_members').upsert(
      { list_id: selId, outreach_id: id, added_by: 'manual' },
      { onConflict: 'list_id,outreach_id', ignoreDuplicates: true },
    )
    if (error) return flash(`Error: ${error.message}`)
    setQ(''); setHits([])
    await loadMembers(selId)
    await load()
  }

  /** "Fri 6pm · Woodvale · 32 players · tourney" — real fields only. */
  const listMeta = (l: ListRow): string =>
    [
      l.event_day ? `${l.event_day}${l.event_time ? ' ' + l.event_time : ''}` : null,
      l.venue,
      `${counts.get(l.id) ?? 0} players`,
      l.game_type ?? 'untyped',
    ]
      .filter(Boolean)
      .join(' · ')

  return (
    <div className="max-w-[720px]">
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <p className="m-0 min-w-0 flex-1 text-[13px] muted">
          Standing player lists per venue and game type. Tourney lists auto-seed from attendance; cash
          lists are built by hand. Load a list in Batches to message it.
        </p>
        <button onClick={() => void load()} className="btn-quiet">Refresh</button>
      </div>
      {status && (
        <p className="mb-3 text-xs font-semibold" style={{ color: 'var(--color-accent-700)' }}>{status}</p>
      )}

      <ul className="m-0 list-none p-0" style={{ borderTop: '2px solid var(--color-divider)' }}>
        {lists.map((l) => (
          <li key={l.id} className="row">
            <div
              className="grid cursor-pointer grid-cols-[minmax(0,1fr)_max-content] items-center gap-4 py-3.5 row-hover"
              onClick={() => (selId === l.id ? setSelId(null) : select(l.id))}
              title={selId === l.id ? 'Close member list' : 'Open member list'}
            >
              <div className="min-w-0">
                <p className="m-0 truncate text-[15px] font-semibold leading-tight">{l.name}</p>
                <p className="m-0 mt-0.5 text-xs muted tnum">{listMeta(l)}</p>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  className="btn btn-ghost text-xs"
                  onClick={(e) => { e.stopPropagation(); onStartBatch(l.id) }}
                  title="Open the Batches composer with this list loaded"
                >
                  Start a batch
                </button>
                {l.game_type === 'tourney' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); void seed(l) }}
                    disabled={busy}
                    className="btn-quiet"
                    title="Add players with >=2 tournaments at this venue in the last 90 days"
                  >
                    Auto-seed
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); void deleteList(l) }}
                  className="btn-quiet"
                  title="Delete this list (players are kept)"
                >
                  Delete
                </button>
                <button
                  className="btn-quiet"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (selId === l.id) setSelId(null)
                    else select(l.id)
                  }}
                >
                  {selId === l.id ? 'Close' : 'Members'}
                </button>
              </div>
            </div>

            {selId === l.id && selected && (
              <div className="pb-4">
                <div className="mb-2 flex flex-wrap items-center gap-3">
                  <span className="text-xs font-semibold tnum">{members.length} players</span>
                  {selected.game_type === 'tourney' && (
                    <button onClick={() => void seed(selected)} disabled={busy} className="btn-quiet">Auto-seed</button>
                  )}
                </div>
                {/* add member */}
                <div className="relative mb-2">
                  <input
                    value={q}
                    onChange={(e) => void searchPlayers(e.target.value)}
                    placeholder="Add a player by name…"
                    className="input"
                  />
                  {hits.length > 0 && (
                    <ul className="absolute z-10 mt-1 max-h-56 w-full list-none overflow-y-auto border bg-paper p-0 shadow-lg" style={{ borderColor: 'var(--color-divider)' }}>
                      {hits.map((h) => (
                        <li key={h.id}>
                          <button
                            onClick={() => void addMember(h.id)}
                            className="flex w-full cursor-pointer items-baseline justify-between gap-3 border-0 bg-transparent px-2.5 py-1.5 text-left text-sm row-hover"
                          >
                            <span className="min-w-0 truncate">{h.player_name ?? '(no name)'}</span>
                            <span className="text-[11px] muted-45 tnum">{h.phone ?? ''}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <ul className="m-0 max-h-[60vh] list-none overflow-y-auto p-0">
                  {members.map((m) => (
                    <li key={m.outreach_id} className="row flex flex-wrap items-center gap-2 py-1.5 text-sm">
                      <button
                        onClick={() => void togglePin(m)}
                        title={m.pinned ? 'Pinned — unpin' : 'Pin (protect from auto-prune)'}
                        className="btn-quiet"
                        style={m.pinned ? { color: 'var(--color-accent-700)', fontWeight: 600 } : undefined}
                      >
                        {m.pinned ? 'Pinned' : 'Pin'}
                      </button>
                      <span className="min-w-0 flex-1 truncate">{m.player_name ?? '(no name)'}</span>
                      {onIce(m.snooze_until) && <span className="tag tag-accent tag-net">On ice</span>}
                      {m.do_not_message && <span className="tag tag-outline tag-net">Do not message</span>}
                      <span className="tag tag-neutral tag-net">{m.added_by}</span>
                      <span className="text-[10px] uppercase muted-45" style={{ letterSpacing: '0.06em' }}>
                        {m.beeper_chat_id ? 'thread' : m.phone ? 'sms' : 'no contact'}
                      </span>
                      <button onClick={() => void removeMember(m)} className="btn-quiet" title="Remove from list">
                        Remove
                      </button>
                    </li>
                  ))}
                  {members.length === 0 && (
                    <li className="py-2 text-sm muted">No players yet. Auto-seed (tourney) or add by name.</li>
                  )}
                </ul>
              </div>
            )}
          </li>
        ))}
        {lists.length === 0 && <li className="py-3.5 text-sm muted">No lists yet.</li>}
      </ul>

      {/* New list */}
      <button className="btn btn-secondary mt-3.5 text-[13px]" onClick={() => setCreating((c) => !c)}>
        {creating ? 'Close' : 'New list'}
      </button>
      {creating && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="field w-48">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Woodvale tourney" className="input" />
          </div>
          <div className="field w-36">
            <label>Venue</label>
            <select value={venue} onChange={(e) => setVenue(e.target.value)} className="input">
              <option value="">—</option>
              {VENUES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div className="field w-28">
            <label>Type</label>
            <select value={gameType} onChange={(e) => setGameType(e.target.value as 'tourney' | 'cash')} className="input">
              <option value="tourney">tourney</option>
              <option value="cash">cash</option>
            </select>
          </div>
          <div className="field w-24">
            <label>Day</label>
            <select value={day} onChange={(e) => setDay(e.target.value)} className="input">
              <option value="">—</option>
              {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="field w-20">
            <label>Time</label>
            <input value={time} onChange={(e) => setTime(e.target.value)} placeholder="6pm" className="input tnum" />
          </div>
          <button onClick={() => void createList()} disabled={busy} className="btn btn-primary !text-xs">
            Create
          </button>
        </div>
      )}
    </div>
  )
}
