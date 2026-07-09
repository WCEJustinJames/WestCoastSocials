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
 * name to open their thread) and by hand for phone/in-person confirms; × frees
 * a seat (a "yes" player is excluded for today only, never messaged). On nights
 * with several seat-capped games, "yes" replies wait in an assign row so each
 * lands on the right table. Under target on game-day afternoon flags the gap and
 * one-taps into Batches with the venue list to invite the next tranche.
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

  return (
    <div className="card mb-4 p-3 sm:p-4">
      <p className="mb-2 text-sm font-semibold">🪑 Tonight&apos;s seats</p>

      {unassigned.length > 0 && (
        <div className="mb-2 rounded-lg border border-sky-200 bg-sky-50 p-2">
          <p className="mb-1 text-xs font-medium text-sky-800">Said yes today — tap a game to seat them:</p>
          <ul className="space-y-1">
            {unassigned.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="font-medium">{(c.title ?? 'player').trim() || 'player'}</span>
                {scheds.map((s) => (
                  <button key={s.id} onClick={() => void seatManual(s, (c.title ?? 'player'), c.id)}
                    className="chip border border-sky-300 bg-white text-sky-700 hover:bg-sky-100">
                    → {s.venue ?? s.name}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="space-y-2">
        {scheds.map((s) => {
          const seats = seatsFor(s)
          const confirmed = seats.length
          const gap = Math.max(0, s.seat_target - confirmed)
          const pct = Math.min(100, Math.round((confirmed / s.seat_target) * 100))
          const full = gap === 0
          const urgent = !full && afternoon
          return (
            <li key={s.id} className="rounded-lg border border-slate-100 bg-slate-50/50 p-2.5">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{s.venue ?? s.name}</span>
                <span className="chip bg-slate-100 text-slate-500">{s.game_type}{s.event_time ? ` · ${s.event_time}` : ''}</span>
                <span className={`text-sm font-semibold tabular-nums ${full ? 'text-emerald-700' : urgent ? 'text-rose-700' : 'text-slate-700'}`}>
                  {confirmed}/{s.seat_target} seats
                </span>
                {full ? (
                  <span className="chip bg-emerald-100 text-emerald-700">table full ✓</span>
                ) : (
                  <span className={`chip ${urgent ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>
                    {gap} to fill
                  </span>
                )}
                {!full && (
                  <button
                    onClick={() => onFill(s.list_id, s.venue)}
                    className="btn-primary ml-auto px-2.5 py-1 text-xs"
                    title="Open Batches with this venue's list to invite the next tranche"
                  >
                    Fill {gap} →
                  </button>
                )}
              </div>
              <div className="mb-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                <div className={`h-full ${full ? 'bg-emerald-500' : urgent ? 'bg-rose-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }} />
              </div>

              {/* the actual roster */}
              <div className="flex flex-wrap items-center gap-1.5">
                {seats.map((seat, i) => (
                  <span key={seat.key}
                    className={`flex items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-xs ring-1 ring-inset ${
                      i < s.seat_target ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-amber-50 text-amber-800 ring-amber-200'
                    }`}
                    title={i >= s.seat_target ? 'Over the seat target — waitlist' : seat.source === 'reply' ? 'Confirmed by reply today' : 'Seated manually'}>
                    <span className="font-medium tabular-nums text-slate-400">{i + 1}.</span>
                    {seat.conversationId && onOpen ? (
                      <button onClick={() => onOpen(seat.conversationId!)} className="hover:underline">{seat.name}</button>
                    ) : (
                      seat.name
                    )}
                    {seat.source === 'manual' && <span title="added by hand">✍</span>}
                    <button onClick={() => void freeSeat(s, seat)} title="Free this seat (doesn't message them)"
                      className="rounded-full px-1 text-slate-400 hover:bg-rose-100 hover:text-rose-700">×</button>
                  </span>
                ))}
                {/* manual seat entry */}
                <span className="flex items-center gap-1">
                  <input
                    value={adding[s.id] ?? ''}
                    onChange={(e) => setAdding((p) => ({ ...p, [s.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') void seatManual(s, adding[s.id] ?? '') }}
                    placeholder="+ seat a name…"
                    className="w-28 rounded-full border border-slate-200 px-2 py-0.5 text-xs outline-none focus:border-emerald-500"
                  />
                  {(adding[s.id] ?? '').trim() && (
                    <button onClick={() => void seatManual(s, adding[s.id] ?? '')}
                      className="chip border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100">seat</button>
                  )}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      <p className="mt-2 text-[11px] text-slate-400">
        Seats fill from today&apos;s &quot;yes&quot; replies automatically — tap a name to open their thread, × to free the
        seat (nothing is sent), or type a name for phone / walk-in confirms. Fill jumps to Batches with the venue
        list, where the no-double-message and window guardrails still apply.
      </p>
    </div>
  )
}
