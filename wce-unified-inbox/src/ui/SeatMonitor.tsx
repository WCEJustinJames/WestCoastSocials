import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

type Schedule = Database['public']['Tables']['inbox_schedules']['Row']

/** One filled seat: an auto "yes" reply, or a manually assigned player. */
interface Seat {
  key: string
  name: string
  conversationId: string | null
  source: 'reply' | 'manual'
  rosterId: string | null // inbox_seat_roster row id when persisted (manual)
}

interface RosterRow {
  id: string
  schedule_id: string
  conversation_id: string | null
  player_name: string
  kind: 'manual' | 'exclude'
}

interface YesConv {
  id: string
  title: string | null
}

// inbox_seat_roster post-dates the generated Database types; cast for access.
function rosterTable() {
  return supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, v: string) => Promise<{ data: RosterRow[] | null }>
      }
      insert: (v: unknown) => { select: (c: string) => { single: () => Promise<{ data: RosterRow | null }> } }
      delete: () => { eq: (c: string, v: string) => Promise<unknown> }
    }
  }
}

const localDate = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Seat-target monitor — tonight's seat-capped games with an ACTUAL named roster,
 * not just a count. Seats fill automatically from today's "yes" replies (tap a
 * name to open their thread) and by hand for phone/in-person confirms; "Free"
 * frees a seat (a "yes" player is excluded for today only, never messaged). On
 * nights with several seat-capped games, "yes" replies wait in an assign row so
 * each lands on the right table. Under target on game-day afternoon flags the gap
 * and one-taps into Batches with the venue list to invite the next tranche.
 */
export function SeatMonitor({
  onFill,
  onOpen,
}: {
  onFill: (listId: string | null, venue: string | null) => void
  onOpen?: (conversationId: string) => void
}) {
  const [scheds, setScheds] = useState<Schedule[]>([])
  const [yesConvs, setYesConvs] = useState<YesConv[]>([])
  const [roster, setRoster] = useState<RosterRow[]>([])
  const [adding, setAdding] = useState<Record<string, string>>({}) // scheduleId -> draft name

  async function load() {
    const today = new Date().getDay() // Perth-local in the browser
    const { data: s } = await supabase
      .from('inbox_schedules')
      .select('*')
      .eq('active', true)
      .gt('seat_target', 0)
      .eq('day_of_week', today)
    const list = (s as Schedule[]) ?? []
    setScheds(list)
    if (list.length === 0) return

    // Auto candidates: distinct conversations with a 'yes' reply since local midnight.
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
    const { data: yes } = await supabase
      .from('inbox_messages')
      .select('conversation_id')
      .eq('reply_intent', 'yes')
      .gte('timestamp', midnight.toISOString())
      .limit(500)
    const ids = [...new Set(((yes ?? []) as { conversation_id: string }[]).map((m) => m.conversation_id))]
    if (ids.length) {
      const { data: convs } = await supabase
        .from('inbox_conversations')
        .select('id, title')
        .in('id', ids)
      setYesConvs(((convs ?? []) as YesConv[]))
    } else setYesConvs([])

    const { data: r } = await rosterTable().from('inbox_seat_roster')
      .select('id, schedule_id, conversation_id, player_name, kind')
      .eq('game_date', localDate())
    setRoster(r ?? [])
  }
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 30_000)
    return () => clearInterval(t)
  }, [])

  if (scheds.length === 0) return null

  const singleGame = scheds.length === 1
  const manualByConv = new Set(roster.filter((r) => r.kind === 'manual' && r.conversation_id).map((r) => r.conversation_id))

  // Roster for one game: manual seats + (single-game nights) every un-excluded,
  // un-pinned auto "yes". On multi-game nights autos wait in the assign row.
  function seatsFor(s: Schedule): Seat[] {
    const excluded = new Set(
      roster.filter((r) => r.kind === 'exclude' && r.schedule_id === s.id && r.conversation_id).map((r) => r.conversation_id),
    )
    const manual: Seat[] = roster
      .filter((r) => r.kind === 'manual' && r.schedule_id === s.id)
      .map((r) => ({ key: r.id, name: r.player_name, conversationId: r.conversation_id, source: (r.conversation_id ? 'reply' : 'manual') as Seat['source'], rosterId: r.id }))
    const auto: Seat[] = singleGame
      ? yesConvs
          .filter((c) => !excluded.has(c.id) && !manualByConv.has(c.id))
          .map((c) => ({ key: c.id, name: (c.title ?? 'player').trim() || 'player', conversationId: c.id, source: 'reply' as const, rosterId: null }))
      : []
    return [...manual, ...auto]
  }

  // "Yes" replies not yet pinned to any game (multi-game nights only).
  const unassigned = singleGame
    ? []
    : yesConvs.filter((c) => !manualByConv.has(c.id))

  async function seatManual(s: Schedule, name: string, conversationId: string | null = null) {
    const nm = name.trim()
    if (!nm) return
    const { data } = await rosterTable().from('inbox_seat_roster')
      .insert({ schedule_id: s.id, game_date: localDate(), player_name: nm, conversation_id: conversationId, kind: 'manual' })
      .select('id, schedule_id, conversation_id, player_name, kind')
      .single()
    if (data) setRoster((p) => [...p, data])
    setAdding((p) => ({ ...p, [s.id]: '' }))
  }

  async function freeSeat(s: Schedule, seat: Seat) {
    if (seat.rosterId) {
      await rosterTable().from('inbox_seat_roster').delete().eq('id', seat.rosterId)
      setRoster((p) => p.filter((r) => r.id !== seat.rosterId))
    } else if (seat.conversationId) {
      // Auto "yes": exclude for today (this game) — no message is sent to them.
      const { data } = await rosterTable().from('inbox_seat_roster')
        .insert({ schedule_id: s.id, game_date: localDate(), player_name: seat.name, conversation_id: seat.conversationId, kind: 'exclude' })
        .select('id, schedule_id, conversation_id, player_name, kind')
        .single()
      if (data) setRoster((p) => [...p, data])
    }
  }

  const hour = new Date().getHours()
  const afternoon = hour >= 13 // past 1pm, the fill-up window

  // Panel-level tally for the kicker — seats filled against target across
  // tonight's capped games (the same figures each row shows).
  const seatedTotal = scheds.reduce((n, s) => n + seatsFor(s).length, 0)
  const targetTotal = scheds.reduce((n, s) => n + s.seat_target, 0)

  return (
    <section className="mb-7">
      <div className="section-head">
        <span className="kicker tnum">Tonight&apos;s seats · {seatedTotal}/{targetTotal}</span>
      </div>

      {unassigned.length > 0 && (
        <>
          <p className="m-0 py-1 text-[11px] uppercase muted-50" style={{ letterSpacing: '0.08em' }}>
            Said yes today — tap a game to seat them
          </p>
          <ul className="m-0 list-none p-0">
            {unassigned.map((c) => (
              <li
                key={c.id}
                className="row row-hover grid grid-cols-[minmax(0,1fr)_max-content] items-baseline gap-x-4 gap-y-1 py-3"
              >
                <span className="min-w-0 truncate text-sm font-semibold">{(c.title ?? 'player').trim() || 'player'}</span>
                <span className="flex flex-wrap items-baseline justify-end gap-x-3 gap-y-1">
                  {scheds.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => void seatManual(s, (c.title ?? 'player'), c.id)}
                      title={`Seat them at ${s.venue ?? s.name}`}
                      className="btn btn-ghost !text-xs"
                    >
                      {s.venue ?? s.name}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <ul className="m-0 list-none p-0">
        {scheds.map((s) => {
          const seats = seatsFor(s)
          const confirmed = seats.length
          const gap = Math.max(0, s.seat_target - confirmed)
          const pct = Math.min(100, Math.round((confirmed / s.seat_target) * 100))
          const full = gap === 0
          const urgent = !full && afternoon
          return (
            <li key={s.id} className="row">
              <div className="row-hover grid grid-cols-[minmax(0,1fr)_max-content] items-baseline gap-x-4 gap-y-1 py-3 [grid-template-areas:'name_figs'_'meta_meta'] dt:grid-cols-[minmax(0,1fr)_minmax(0,200px)_max-content] dt:[grid-template-areas:'name_meta_figs']">
                <span className="min-w-0 truncate text-sm font-semibold [grid-area:name]">{s.venue ?? s.name}</span>
                <span className="min-w-0 truncate text-xs muted tnum [grid-area:meta]">
                  {s.game_type}{s.event_time ? ` · ${s.event_time}` : ''}
                </span>
                <span className="flex flex-wrap items-baseline justify-end gap-x-3 gap-y-1 [grid-area:figs]">
                  <span
                    className={`text-[15px] tnum ${urgent ? 'font-extrabold' : 'font-semibold'}`}
                    style={urgent ? { color: 'var(--color-accent-700)' } : undefined}
                  >
                    {confirmed}/{s.seat_target} seats
                  </span>
                  {full ? (
                    <span className="tag tag-neutral tag-net">table full</span>
                  ) : (
                    <span className={`tag tag-net tnum ${urgent ? 'tag-accent' : 'tag-neutral'}`}>{gap} to fill</span>
                  )}
                  {!full && (
                    <button
                      onClick={() => onFill(s.list_id, s.venue)}
                      className="btn btn-ghost !text-xs tnum"
                      title="Open Batches with this venue's list to invite the next tranche"
                    >
                      Fill {gap}
                    </button>
                  )}
                </span>
              </div>

              {/* seats filled against target — a flat meter, not a traffic light */}
              <div className="mb-2 h-[3px] w-full" style={{ background: 'color-mix(in srgb, var(--color-text) 12%, transparent)' }}>
                <div className="h-full" style={{ width: `${pct}%`, background: 'var(--color-accent)' }} />
              </div>

              {/* the actual roster */}
              <ol className="m-0 list-none p-0 pb-3">
                {seats.map((seat, i) => (
                  <li
                    key={seat.key}
                    className="flex items-baseline gap-2 py-1 text-[13px]"
                    title={i >= s.seat_target ? 'Over the seat target — waitlist' : seat.source === 'reply' ? 'Confirmed by reply today' : 'Seated manually'}
                  >
                    <span className="w-5 flex-none text-right text-xs muted-45 tnum">{i + 1}</span>
                    {seat.conversationId && onOpen ? (
                      <button
                        onClick={() => onOpen(seat.conversationId!)}
                        className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-[13px] font-semibold hover:underline"
                        style={{ color: 'inherit', fontFamily: 'inherit' }}
                      >
                        {seat.name}
                      </button>
                    ) : (
                      <span className="min-w-0 truncate font-semibold">{seat.name}</span>
                    )}
                    {seat.source === 'manual' && (
                      <span className="tag tag-neutral tag-net uppercase" title="added by hand">manual</span>
                    )}
                    {i >= s.seat_target && <span className="tag tag-outline tag-net uppercase">waitlist</span>}
                    <button
                      onClick={() => void freeSeat(s, seat)}
                      title="Free this seat (doesn't message them)"
                      className="btn-quiet ml-auto"
                    >
                      Free
                    </button>
                  </li>
                ))}
                {/* manual seat entry */}
                <li className="flex items-center gap-2 py-1">
                  <span className="w-5 flex-none" />
                  <input
                    value={adding[s.id] ?? ''}
                    onChange={(e) => setAdding((p) => ({ ...p, [s.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') void seatManual(s, adding[s.id] ?? '') }}
                    placeholder="Seat a name…"
                    className="input !w-44"
                  />
                  {(adding[s.id] ?? '').trim() && (
                    <button onClick={() => void seatManual(s, adding[s.id] ?? '')} className="btn btn-ghost !text-xs">
                      Seat
                    </button>
                  )}
                </li>
              </ol>
            </li>
          )
        })}
      </ul>
      <p className="m-0 mt-2 text-[11px] muted">
        Seats fill from today&apos;s &quot;yes&quot; replies automatically — tap a name to open their thread, Free to
        release the seat (nothing is sent), or type a name for phone / walk-in confirms. Fill jumps to Batches with
        the venue list, where the no-double-message and window guardrails still apply.
      </p>
    </section>
  )
}
