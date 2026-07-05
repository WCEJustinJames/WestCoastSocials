import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

type Schedule = Database['public']['Tables']['inbox_schedules']['Row']

interface GameStatus {
  schedule: Schedule
  confirmed: number
  gap: number
}

/**
 * Seat-target monitor — tonight's seat-capped games (cash tables) with confirmed
 * seats vs target. Confirmed = distinct players who replied "yes" today. When a
 * game is under target and it's game-day afternoon, it flags the gap and offers a
 * one-tap jump to Batches with that venue's list loaded to fill the tranche.
 */
export function SeatMonitor({ onFill }: { onFill: (listId: string | null, venue: string | null) => void }) {
  const [games, setGames] = useState<GameStatus[]>([])

  useEffect(() => {
    void (async () => {
      const today = new Date().getDay() // Perth-local in the browser
      const { data: scheds } = await supabase
        .from('inbox_schedules')
        .select('*')
        .eq('active', true)
        .gt('seat_target', 0)
        .eq('day_of_week', today)
      const list = (scheds as Schedule[]) ?? []
      if (list.length === 0) { setGames([]); return }

      // Confirmed today = distinct conversations with a 'yes' reply since local midnight.
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
      const { data: yes } = await supabase
        .from('inbox_messages')
        .select('conversation_id')
        .eq('reply_intent', 'yes')
        .gte('timestamp', midnight.toISOString())
        .limit(500)
      const confirmed = new Set(((yes ?? []) as { conversation_id: string }[]).map((m) => m.conversation_id)).size

      setGames(list.map((s) => ({ schedule: s, confirmed, gap: Math.max(0, s.seat_target - confirmed) })))
    })()
  }, [])

  if (games.length === 0) return null

  const hour = new Date().getHours()
  const afternoon = hour >= 13 // past 1pm, the fill-up window

  return (
    <div className="card mb-4 p-3 sm:p-4">
      <p className="mb-2 text-sm font-semibold">🪑 Tonight&apos;s seats</p>
      <ul className="space-y-2">
        {games.map(({ schedule: s, confirmed, gap }) => {
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
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                <div className={`h-full ${full ? 'bg-emerald-500' : urgent ? 'bg-rose-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }} />
              </div>
            </li>
          )
        })}
      </ul>
      <p className="mt-2 text-[11px] text-slate-400">
        Confirmed = players who replied &quot;yes&quot; today. Fill jumps to Batches with the venue list, where the
        no-double-message and window guardrails still apply.
      </p>
    </div>
  )
}
