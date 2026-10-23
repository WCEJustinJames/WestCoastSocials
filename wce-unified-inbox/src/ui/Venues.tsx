import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { normCore, type PlayerRow } from './usePlayers'
import { useVenues, useVenueRows, reloadVenues, type Venue } from './useVenues'
import { supabase as sb } from '../lib/supabase'

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
const accent700 = { color: 'var(--color-accent-700)' }

/**
 * Venues tab — the venue directory (canonical names + the aliases the matcher
 * folds onto them), then one sub-tab per venue: the STANDING lists (venue list
 * members), RECOMMENDED players (attended here in the last 10 weeks but not on
 * a list yet), ICED players tied to this venue, and NEW contacts to place.
 * Everything is read-from-live data; the only writes are add/remove list
 * membership, un-ice, and the directory's add/alias/retire edits.
 */
export function Venues() {
  const VENUES = useVenues()
  const [venue, setVenue] = useState<string>('')
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
  // The venue list arrives async now, so the first tab can't be picked at
  // useState time. Settle on the first one once it lands, and again if the
  // selected venue is retired out from under us.
  useEffect(() => {
    if (VENUES.length && !VENUES.includes(venue)) setVenue(VENUES[0])
  }, [VENUES, venue])

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
      <button onClick={() => setShowAll((s) => ({ ...s, [key]: true }))} className="btn-quiet mt-1.5 tnum">
        Show all {total}
      </button>
    ) : null

  const flagTags = (p: PlayerRow) => (
    <>
      {p.whale && <span className="tag tag-accent tag-net">whale</span>}
      {p.priority && <span className="tag tag-accent tag-net">priority</span>}
      {iced(p) && (
        <span className="tag tag-outline tag-net" title={`on ice until ${p.snooze_until?.slice(0, 10)}`}>
          on ice
        </span>
      )}
    </>
  )

  const addButtons = (p: PlayerRow) =>
    vLists.length > 0 ? (
      <span className="ml-auto flex flex-wrap gap-1.5">
        {vLists.map((l) => (
          <button key={l.id} onClick={() => void addToList(l.id, p.id)} className="btn btn-ghost !px-1.5 text-xs">
            + {l.game_type ?? l.name}
          </button>
        ))}
      </span>
    ) : null

  return (
    <div className="max-w-[720px]">
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <p className="m-0 min-w-0 flex-1 text-[13px] muted">
          The venue directory and the per-venue roster room: who&apos;s standing, who&apos;s earned a spot
          (played here in the last 10 weeks), who&apos;s iced, and new contacts to place.
        </p>
        <button onClick={() => void load()} className="btn-quiet">Refresh</button>
      </div>
      {status && (
        <p className="mb-3 text-xs font-semibold" style={accent700}>{status}</p>
      )}

      <VenueManager onChanged={flash} />

      {/* venue sub-tabs */}
      <div className="mb-5 seg">
        {VENUES.map((v) => (
          <button key={v} className="seg-btn" aria-pressed={v === venue} onClick={() => { setVenue(v); setShowAll({}) }}>
            {v}
          </button>
        ))}
      </div>

      {/* standing */}
      <section className="mb-7">
        <div className="section-head">
          <span className="kicker">Standing lists</span>
          <span className="text-xs muted-45 tnum">{standing.length} player(s) across {vLists.length} list(s)</span>
        </div>
        {vLists.length === 0 && (
          <p className="mt-2 text-sm muted">No lists for {venue} yet — create one in the Lists tab and it shows up here.</p>
        )}
        <ul className="m-0 list-none p-0">
          {capped('standing', standing).map(({ p, ms }) => (
            <li key={p.id} className="row flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2">
              <span className="text-sm font-semibold" style={iced(p) ? accent700 : undefined}>
                {displayName(p)}
              </span>
              {flagTags(p)}
              {ms.map((m) => (
                <span key={m.list_id} className="tag tag-neutral tag-net">
                  {m.pinned ? 'pinned · ' : ''}
                  {listById.get(m.list_id)?.game_type ?? listById.get(m.list_id)?.name}
                  <button
                    onClick={() => void removeFromList(m.list_id, p.id, displayName(p))}
                    className="ml-1.5 cursor-pointer border-0 bg-transparent p-0 text-[9px] muted-50 hover:text-ink"
                    title="remove from this list"
                  >
                    ×
                  </button>
                </span>
              ))}
            </li>
          ))}
        </ul>
        {moreBtn('standing', standing.length)}
      </section>

      {/* recommended */}
      <section className="mb-7">
        <div className="section-head">
          <span className="kicker">Recommended</span>
          <span className="text-xs muted-45 tnum">played {venue} in the last 10 weeks, not on a list ({recommended.length})</span>
        </div>
        <ul className="m-0 list-none p-0">
          {capped('rec', recommended).map(({ p, n, last, fmts }) => (
            <li key={p.id} className="row flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2">
              <span className="text-sm font-semibold">{displayName(p)}</span>
              {flagTags(p)}
              <span className="text-xs muted tnum">
                {n}× · last {new Date(last).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} · {fmts.join(' + ')}
              </span>
              {addButtons(p)}
            </li>
          ))}
          {recommended.length === 0 && (
            <li className="py-2 text-sm muted">Nobody waiting — everyone who played here recently is already listed.</li>
          )}
        </ul>
        {moreBtn('rec', recommended.length)}
      </section>

      {/* iced */}
      <section className="mb-7">
        <div className="section-head">
          <span className="kicker">On ice</span>
          <span className="text-xs muted-45 tnum">tied to {venue} ({icedHere.length})</span>
        </div>
        <ul className="m-0 list-none p-0">
          {capped('iced', icedHere).map((p) => (
            <li key={p.id} className="row flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2">
              <span className="text-sm font-semibold">{displayName(p)}</span>
              <span className="text-xs font-semibold tnum" style={accent700}>until {p.snooze_until?.slice(0, 10)}</span>
              <button onClick={() => void unIce(p)} className="btn-quiet ml-auto">Un-ice</button>
            </li>
          ))}
          {icedHere.length === 0 && <li className="py-2 text-sm muted">Nobody on ice here.</li>}
        </ul>
        {moreBtn('iced', icedHere.length)}
      </section>

      {/* new contacts */}
      <section className="mb-8">
        <div className="section-head">
          <span className="kicker">New contacts</span>
          <span className="text-xs muted-45 tnum">added in the last 45 days, seen at {venue} ({freshHere.length})</span>
        </div>
        <ul className="m-0 list-none p-0">
          {capped('fresh', freshHere).map((p) => (
            <li key={p.id} className="row flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2">
              <span className="text-sm font-semibold">{displayName(p)}</span>
              {flagTags(p)}
              <span className="text-xs muted tnum">added {p.added_at?.slice(0, 10)}</span>
              {addButtons(p)}
            </li>
          ))}
          {freshHere.length === 0 && <li className="py-2 text-sm muted">No new faces at {venue} recently.</li>}
        </ul>
        {moreBtn('fresh', freshHere.length)}

        {freshUnplaced.length > 0 && (
          <div className="mt-3">
            <button onClick={() => setShowUnplaced((s) => !s)} className="btn-quiet tnum">
              {showUnplaced ? 'Hide' : 'Show'} new &amp; unplaced — no venue anywhere yet ({freshUnplaced.length})
            </button>
            {showUnplaced && (
              <ul className="m-0 mt-2 list-none p-0">
                {freshUnplaced.map((p) => (
                  <li key={p.id} className="row flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2">
                    <span className="text-sm font-semibold">{displayName(p)}</span>
                    <span className="text-xs muted tnum">added {p.added_at?.slice(0, 10)}</span>
                    {addButtons(p)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * Add and edit venues. This exists because the venue list used to be a
 * TypeScript array: opening a room meant a code change and a deploy, and
 * Gosnells sat outside every dropdown in the app while quietly logging 208
 * games.
 *
 * Aliases are the half that's easy to skip and expensive to skip. TD sheets
 * name the same room a dozen ways ("Woody", "Planet R", "Adriatic"), and the
 * sync engine folds those onto the canonical name from this same list — so an
 * alias added here is an alias the invite parser and the CRM importer honour
 * too. Add the venue without its aliases and half the club's history stays
 * filed under a name nothing matches.
 */
function VenueManager({ onChanged }: { onChanged: (m: string) => void }) {
  const rows = useVenueRows()
  const [name, setName] = useState('')
  const [aliases, setAliases] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const parseAliases = (s: string): string[] =>
    [...new Set(s.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean))]

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const clean = name.trim()
    if (!clean) return
    setBusy(true); setErr(null)
    const { error } = await sb.from('inbox_venues').insert({
      name: clean,
      aliases: parseAliases(aliases),
      sort: (rows.reduce((m, r) => Math.max(m, r.sort), 0) || 0) + 10,
    })
    setBusy(false)
    // Say what actually happened. A duplicate name is the common case and it
    // has a specific fix, so don't flatten it into "couldn't save".
    if (error) {
      setErr(error.code === '23505' ? `${clean} is already a venue.` : error.message)
      return
    }
    setName(''); setAliases('')
    await reloadVenues()
    onChanged(`${clean} added — it's now selectable everywhere in the app.`)
  }

  async function save(v: Venue, patch: Partial<Venue>) {
    const { error } = await sb.from('inbox_venues').update(patch).eq('name', v.name)
    if (error) { setErr(error.message); return }
    await reloadVenues()
  }

  return (
    <section className="mb-8">
      <div className="section-head">
        <span className="kicker">Venue directory</span>
        <span className="text-xs muted-45 tnum">{rows.length} venues</span>
      </div>
      <ul className="m-0 list-none p-0">
        {rows.map((v) => (
          <li
            key={v.name}
            className={`row grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-4 py-[11px] ${v.active ? '' : 'opacity-60'}`}
          >
            <span className="min-w-0 text-sm font-semibold">
              {v.name}
              {!v.active && <span className="ml-1.5 text-xs font-normal muted-50">retired</span>}
            </span>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-xs muted-50">
              <span className="min-w-0">{v.aliases.length ? `aka ${v.aliases.join(', ')}` : 'no aliases'}</span>
              <input
                defaultValue={v.aliases.join(', ')}
                onBlur={(e) => {
                  const next = parseAliases(e.target.value)
                  if (next.join('|') !== v.aliases.join('|')) void save(v, { aliases: next })
                }}
                placeholder="add an alias…"
                className="input !w-44 !text-xs"
              />
              <button onClick={() => void save(v, { active: !v.active })} className="btn-quiet">
                {v.active ? 'Retire' : 'Restore'}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-[11px] muted">Aliases feed the matcher — a new spelling is a data change, not code.</p>

      <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-3">
        <div className="field w-44">
          <label>Venue name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gosnells" className="input" />
        </div>
        <div className="field min-w-[16rem] flex-1">
          <label>Also known as (comma separated)</label>
          <input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="GCFC, Thornlie" className="input" />
        </div>
        <button type="submit" disabled={busy || !name.trim()} className="btn btn-secondary">
          {busy ? 'Adding…' : 'Add venue'}
        </button>
      </form>
      {err && (
        <p className="mt-2 text-sm font-semibold" style={accent700}>{err}</p>
      )}
      <p className="mt-2 text-xs muted-45">
        Retiring a venue takes it out of the pickers. Nothing is deleted — past games, lists and
        attendance keep their venue exactly as recorded.
      </p>
    </section>
  )
}
