import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { VENUES, normCore, type PlayerRow } from './usePlayers'

type ListRow = { id: string; name: string; venue: string | null; game_type: string | null }
type Member = { list_id: string; outreach_id: string; pinned: boolean }
type Att = { norm: string; venue: string | null; fmt: string; d: string }

// Match the SQL norm_full_name(): letters only, no spaces — applied after
// normCore so operator name-noise ("$2/5 MCT") doesn't break the join.
const squash = (s: string | null): string => normCore(s ?? '').replace(/\s+/g, '')

const iced = (r: PlayerRow): boolean => !!r.snooze_until && new Date(r.snooze_until) > new Date()
const usable = (r: PlayerRow): boolean => !r.hidden && !r.staff && !r.do_not_message

function displayName(r: PlayerRow): string {
  return r.player_name || [r.first_name, r.last_name].filter(Boolean).join(' ') || r.phone || '(unnamed)'
}

const CAP = 30

/**
 * Venues tab — one sub-tab per venue: the STANDING lists (venue list members),
 * RECOMMENDED players (attended here in the last 10 weeks but not on a list yet),
 * ICED players tied to this venue, and NEW contacts to place. Everything is
 * read-from-live data; the only writes are add/remove list membership and un-ice.
 */
export function Venues() {
  const [venue, setVenue] = useState<string>(VENUES[0])
  const [lists, setLists] = useState<ListRow[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [players, setPlayers] = useState<PlayerRow[]>([])
  const [att, setAtt] = useState<Att[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})
  const [showUnplaced, setShowUnplaced] = useState(false)

  const flash = (m: string) => { setStatus(m); setTimeout(() => setStatus(null), 4000) }

  async function load() {
    const [{ data: ls }, { data: ms }, { data: os }, { data: as }] = await Promise.all([
      supabase.from('inbox_lists').select('id, name, venue, game_type').order('name'),
      supabase.from('inbox_list_members').select('list_id, outreach_id, pinned').limit(5000),
      supabase.from('inbox_outreach').select('*').limit(5000),
      supabase
        .from('inbox_attendance_norm')
        .select('norm, venue, fmt, d')
        .gte('d', new Date(Date.now() - 70 * 86_400_000).toISOString().slice(0, 10))
        .limit(5000),
    ])
    setLists((ls as ListRow[]) ?? [])
    setMembers((ms as Member[]) ?? [])
    setPlayers((os as PlayerRow[]) ?? [])
    setAtt((as as Att[]) ?? [])
  }
  useEffect(() => { void load() }, [])

  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players])
  const byNorm = useMemo(() => {
    const m = new Map<string, PlayerRow>()
    for (const p of players) {
      const k = squash(displayName(p))
      if (k && !m.has(k)) m.set(k, p)
    }
    return m
  }, [players])

  const vLists = useMemo(() => lists.filter((l) => l.venue === venue), [lists, venue])
  const vListIds = useMemo(() => new Set(vLists.map((l) => l.id)), [vLists])
  const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists])

  // memberships at THIS venue, grouped per player
  const standing = useMemo(() => {
    const per = new Map<string, Member[]>()
    for (const m of members) {
      if (!vListIds.has(m.list_id)) continue
      per.set(m.outreach_id, [...(per.get(m.outreach_id) ?? []), m])
    }
    const rows = [...per.entries()]
      .map(([id, ms]) => ({ p: byId.get(id), ms }))
      .filter((x): x is { p: PlayerRow; ms: Member[] } => !!x.p)
    rows.sort((a, b) => {
      const ap = a.ms.some((m) => m.pinned) ? 0 : 1
      const bp = b.ms.some((m) => m.pinned) ? 0 : 1
      if (ap !== bp) return ap - bp
      if (a.p.whale !== b.p.whale) return a.p.whale ? -1 : 1
      return displayName(a.p).localeCompare(displayName(b.p))
    })
    return rows
  }, [members, vListIds, byId])
  const standingIds = useMemo(() => new Set(standing.map((s) => s.p.id)), [standing])

  // attendance at THIS venue, aggregated per player norm
  const vAtt = useMemo(() => {
    const m = new Map<string, { n: number; last: string; fmts: Set<string> }>()
    for (const a of att) {
      if (a.venue !== venue || !a.norm) continue
      const cur = m.get(a.norm) ?? { n: 0, last: a.d, fmts: new Set<string>() }
      cur.n++
      if (a.d > cur.last) cur.last = a.d
      cur.fmts.add(a.fmt)
      m.set(a.norm, cur)
    }
    return m
  }, [att, venue])

  // norms that attended ANY venue (used to spot brand-new unplaced contacts)
  const anyAttNorms = useMemo(() => new Set(att.map((a) => a.norm)), [att])
  const memberAnywhere = useMemo(() => new Set(members.map((m) => m.outreach_id)), [members])

  const recommended = useMemo(() => {
    const rows: { p: PlayerRow; n: number; last: string; fmts: string[] }[] = []
    for (const [norm, agg] of vAtt) {
      const p = byNorm.get(norm)
      if (!p || !usable(p) || iced(p) || standingIds.has(p.id)) continue
      rows.push({ p, n: agg.n, last: agg.last, fmts: [...agg.fmts] })
    }
    rows.sort((a, b) => b.n - a.n || b.last.localeCompare(a.last))
    return rows
  }, [vAtt, byNorm, standingIds])

  const affiliated = (p: PlayerRow): boolean =>
    standingIds.has(p.id) || (p.venues ?? []).includes(venue) || vAtt.has(squash(displayName(p)))

  const icedHere = useMemo(
    () => players.filter((p) => iced(p) && !p.hidden && affiliated(p))
      .sort((a, b) => (a.snooze_until ?? '').localeCompare(b.snooze_until ?? '')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [players, standingIds, vAtt, venue],
  )

  const fresh = useMemo(() => {
    const cutoff = new Date(Date.now() - 45 * 86_400_000).toISOString()
    return players.filter((p) => usable(p) && !iced(p) && (p.added_at ?? '') > cutoff)
  }, [players])
  const freshHere = useMemo(
    () => fresh.filter((p) => affiliated(p) && !standingIds.has(p.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fresh, standingIds, vAtt, venue],
  )
  const freshUnplaced = useMemo(
    () => fresh.filter((p) => !memberAnywhere.has(p.id) && !anyAttNorms.has(squash(displayName(p))) && !(p.venues ?? []).length),
    [fresh, memberAnywhere, anyAttNorms],
  )

  async function addToList(listId: string, outreachId: string) {
    const { error } = await supabase
      .from('inbox_list_members')
      .upsert({ list_id: listId, outreach_id: outreachId, added_by: 'venues-tab' }, { onConflict: 'list_id,outreach_id', ignoreDuplicates: true })
    if (error) return flash(`Error: ${error.message}`)
    flash(`Added to ${listById.get(listId)?.name ?? 'list'}.`)
    await load()
  }
  async function removeFromList(listId: string, outreachId: string, name: string) {
    if (!window.confirm(`Take ${name} off "${listById.get(listId)?.name}"?`)) return
    await supabase.from('inbox_list_members').delete().eq('list_id', listId).eq('outreach_id', outreachId)
    await load()
  }
  async function unIce(p: PlayerRow) {
    if (!window.confirm(`Un-ice ${displayName(p)}? They become contactable again.`)) return
    const { error } = await supabase.from('inbox_outreach').update({ snooze_until: null }).eq('id', p.id)
    if (error) return flash(`Error: ${error.message}`)
    flash(`${displayName(p)} un-iced.`)
    await load()
  }

  const capped = <T,>(key: string, rows: T[]): T[] => (showAll[key] ? rows : rows.slice(0, CAP))
  const moreBtn = (key: string, total: number) =>
    total > CAP && !showAll[key] ? (
      <button onClick={() => setShowAll((s) => ({ ...s, [key]: true }))} className="mt-1 text-xs text-emerald-700 hover:underline">
        show all {total}
      </button>
    ) : null

  const flagChips = (p: PlayerRow) => (
    <>
      {p.whale && <span title="whale">🐋</span>}
      {p.priority && <span title="priority">★</span>}
      {iced(p) && <span className="chip bg-rose-100 text-rose-600" title={`on ice until ${p.snooze_until?.slice(0, 10)}`}>❄</span>}
    </>
  )

  const addButtons = (p: PlayerRow) =>
    vLists.length > 0 ? (
      <span className="ml-auto flex flex-wrap gap-1.5">
        {vLists.map((l) => (
          <button key={l.id} onClick={() => void addToList(l.id, p.id)}
            className="chip border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50">
            + {l.game_type ?? l.name}
          </button>
        ))}
      </span>
    ) : null

  return (
    <div className="mx-auto h-full w-full max-w-5xl overflow-y-auto p-4 sm:p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Venues</h2>
        <button onClick={() => void load()} className="text-sm text-emerald-700 hover:underline">Refresh</button>
      </div>
      <p className="mb-3 text-sm text-slate-500">
        Per-venue roster room: who&apos;s standing, who&apos;s earned a spot (played here in the last 10 weeks),
        who&apos;s iced, and new contacts to place.
      </p>
      {status && <p className="mb-3 text-sm font-medium text-emerald-700">{status}</p>}

      {/* venue sub-tabs */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {VENUES.map((v) => (
          <button key={v} onClick={() => { setVenue(v); setShowAll({}) }}
            className={`btn px-3 py-1.5 ${v === venue ? 'bg-emerald-600 text-white' : 'border border-slate-300 bg-white text-slate-600 hover:border-emerald-400'}`}>
            {v}
          </button>
        ))}
      </div>

      {/* standing */}
      <div className="card mb-4 p-3 sm:p-4">
        <p className="mb-2 text-sm font-semibold">
          Standing lists <span className="font-normal text-slate-400">— {standing.length} player(s) across {vLists.length} list(s)</span>
        </p>
        {vLists.length === 0 && (
          <p className="text-sm text-slate-400">No lists for {venue} yet — create one in the Lists tab and it shows up here.</p>
        )}
        <ul className="space-y-1.5">
          {capped('standing', standing).map(({ p, ms }) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/50 px-2 py-1.5">
              <span className={`text-sm font-medium ${iced(p) ? 'text-rose-700' : ''}`}>{displayName(p)}</span>
              {flagChips(p)}
              {ms.map((m) => (
                <span key={m.list_id} className="chip bg-slate-100 text-slate-500">
                  {m.pinned ? '📌 ' : ''}{listById.get(m.list_id)?.game_type ?? listById.get(m.list_id)?.name}
                  <button onClick={() => void removeFromList(m.list_id, p.id, displayName(p))}
                    className="ml-1 text-slate-400 hover:text-rose-600" title="remove from this list">✕</button>
                </span>
              ))}
            </li>
          ))}
        </ul>
        {moreBtn('standing', standing.length)}
      </div>

      {/* recommended */}
      <div className="card mb-4 p-3 sm:p-4">
        <p className="mb-2 text-sm font-semibold">
          Recommended <span className="font-normal text-slate-400">— played {venue} in the last 10 weeks, not on a list ({recommended.length})</span>
        </p>
        <ul className="space-y-1.5">
          {capped('rec', recommended).map(({ p, n, last, fmts }) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/50 px-2 py-1.5">
              <span className="text-sm font-medium">{displayName(p)}</span>
              {flagChips(p)}
              <span className="text-xs text-slate-400">
                {n}× · last {new Date(last).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} · {fmts.join(' + ')}
              </span>
              {addButtons(p)}
            </li>
          ))}
          {recommended.length === 0 && <li className="text-sm text-slate-400">Nobody waiting — everyone who played here recently is already listed.</li>}
        </ul>
        {moreBtn('rec', recommended.length)}
      </div>

      {/* iced */}
      <div className="card mb-4 p-3 sm:p-4">
        <p className="mb-2 text-sm font-semibold">On ice <span className="font-normal text-slate-400">— tied to {venue} ({icedHere.length})</span></p>
        <ul className="space-y-1.5">
          {capped('iced', icedHere).map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-100 bg-rose-50/40 px-2 py-1.5">
              <span className="text-sm font-medium text-rose-800">{displayName(p)}</span>
              <span className="text-xs text-rose-500">❄ until {p.snooze_until?.slice(0, 10)}</span>
              <button onClick={() => void unIce(p)} className="ml-auto text-xs font-medium text-emerald-700 hover:underline">un-ice</button>
            </li>
          ))}
          {icedHere.length === 0 && <li className="text-sm text-slate-400">Nobody on ice here.</li>}
        </ul>
        {moreBtn('iced', icedHere.length)}
      </div>

      {/* new contacts */}
      <div className="card mb-6 p-3 sm:p-4">
        <p className="mb-2 text-sm font-semibold">
          New contacts <span className="font-normal text-slate-400">— added in the last 45 days, seen at {venue} ({freshHere.length})</span>
        </p>
        <ul className="space-y-1.5">
          {capped('fresh', freshHere).map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/50 px-2 py-1.5">
              <span className="text-sm font-medium">{displayName(p)}</span>
              {flagChips(p)}
              <span className="text-xs text-slate-400">added {p.added_at?.slice(0, 10)}</span>
              {addButtons(p)}
            </li>
          ))}
          {freshHere.length === 0 && <li className="text-sm text-slate-400">No new faces at {venue} recently.</li>}
        </ul>
        {moreBtn('fresh', freshHere.length)}

        {freshUnplaced.length > 0 && (
          <div className="mt-3 border-t border-slate-100 pt-2">
            <button onClick={() => setShowUnplaced((s) => !s)} className="text-xs font-medium text-slate-500 hover:text-slate-700">
              {showUnplaced ? '▾' : '▸'} New &amp; unplaced — no venue anywhere yet ({freshUnplaced.length})
            </button>
            {showUnplaced && (
              <ul className="mt-2 space-y-1.5">
                {freshUnplaced.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-100 bg-amber-50/40 px-2 py-1.5">
                    <span className="text-sm font-medium">{displayName(p)}</span>
                    <span className="text-xs text-slate-400">added {p.added_at?.slice(0, 10)}</span>
                    {addButtons(p)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
