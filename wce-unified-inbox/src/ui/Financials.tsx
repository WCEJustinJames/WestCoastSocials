import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

type Fin = Database['public']['Views']['inbox_financial_summary']['Row']

// Profit/loss poles — validated diverging pair (CVD ΔE 74.6 on the light surface).
const POS = '#2a78d6'
const NEG = '#e34948'

const fmt = (n: number | null | undefined): string =>
  n == null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`

/** Monday-start key for a date, local. */
function weekStart(d: Date): string {
  const w = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
  return `${w.getFullYear()}-${String(w.getMonth() + 1).padStart(2, '0')}-${String(w.getDate()).padStart(2, '0')}`
}

interface Week {
  start: string
  label: string
  netActual: number
  netCalc: number
  buyins: number
  rake: number
  games: number
}

/**
 * Home financials — headline tiles for the current week plus a weekly
 * net-profit trend, from the TD sheets' financial tabs (inbox_financial_summary
 * view). Per game, "net" prefers the sheet's actual over the calculated figure.
 */
export function Financials() {
  const [rows, setRows] = useState<Fin[]>([])
  const [loaded, setLoaded] = useState(false)
  const [hover, setHover] = useState<Week | null>(null)

  useEffect(() => {
    void (async () => {
      const since = new Date(Date.now() - 10 * 7 * 86_400_000).toISOString().slice(0, 10)
      const { data } = await supabase
        .from('inbox_financial_summary')
        .select('*')
        .gte('game_date', since)
        .order('game_date', { ascending: true })
        .limit(500)
      setRows((data as Fin[]) ?? [])
      setLoaded(true)
    })()
  }, [])

  const weeks = useMemo(() => {
    const map = new Map<string, Week>()
    for (const r of rows) {
      if (!r.game_date) continue
      const start = weekStart(new Date(`${r.game_date}T12:00:00`))
      const w = map.get(start) ?? {
        start,
        label: new Date(`${start}T12:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }),
        netActual: 0, netCalc: 0, buyins: 0, rake: 0, games: 0,
      }
      w.netActual += r.net_profit_actual ?? r.net_profit_calc ?? 0
      w.netCalc += r.net_profit_calc ?? r.net_profit_actual ?? 0
      w.buyins += r.gross_buyins ?? 0
      w.rake += r.cash_rake ?? 0
      w.games++
      map.set(start, w)
    }
    return [...map.values()].sort((a, b) => a.start.localeCompare(b.start)).slice(-8)
  }, [rows])

  const thisWeek = weeks.find((w) => w.start === weekStart(new Date()))
  const lastWeek = weeks.length >= 2 ? weeks[weeks.length - 2] : null

  if (loaded && rows.length === 0) {
    return (
      <div className="card mb-4 p-3">
        <p className="text-sm font-semibold">Financials</p>
        <p className="text-xs text-slate-400">
          Nothing harvested yet — game financials mirror from the TD sheets after the next sync restart
          (and the <code>--all</code> backfill fills the history).
        </p>
      </div>
    )
  }
  if (!weeks.length) return null

  // ----- chart geometry (weekly net profit, zero baseline) -----
  const W = 560, H = 130, PAD = 6, LABEL_H = 16
  const span = Math.max(...weeks.map((w) => w.netActual), 0) - Math.min(...weeks.map((w) => Math.min(w.netActual, 0)), 0) || 1
  const scale = (H - PAD * 2 - LABEL_H) / span
  const slot = W / weeks.length
  const barW = Math.min(36, slot - 10)

  const tiles: { name: string; now: number | null; prev: number | null }[] = [
    { name: 'Net profit (actual)', now: thisWeek?.netActual ?? null, prev: lastWeek?.netActual ?? null },
    { name: 'Net profit (calc)', now: thisWeek?.netCalc ?? null, prev: lastWeek?.netCalc ?? null },
    { name: 'Gross buy-ins', now: thisWeek?.buyins ?? null, prev: lastWeek?.buyins ?? null },
    { name: 'Cash rake', now: thisWeek?.rake ?? null, prev: lastWeek?.rake ?? null },
  ]

  return (
    <div className="card mb-4 p-3 sm:p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-sm font-semibold">Financials <span className="font-normal text-slate-400">— this week</span></p>
        <span className="text-[11px] text-slate-400">from the TD sheets</span>
      </div>

      {/* tiles */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.name} className="rounded-lg border border-slate-100 bg-slate-50/60 px-2.5 py-2">
            <p className="text-[11px] text-slate-500">{t.name}</p>
            <p className={`text-lg font-semibold tabular-nums ${t.now != null && t.now < 0 ? 'text-rose-700' : 'text-slate-900'}`}>{fmt(t.now)}</p>
            <p className="text-[11px] text-slate-400">last wk {fmt(t.prev)}</p>
          </div>
        ))}
      </div>

      {/* weekly net profit bars */}
      <p className="mb-1 text-xs font-medium text-slate-500">Weekly net profit — last {weeks.length} weeks</p>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Weekly net profit bar chart">
          {/* zero baseline */}
          {(() => {
            const top = Math.max(...weeks.map((w) => w.netActual), 0)
            const y0 = PAD + top * scale
            return (
              <>
                <line x1={0} x2={W} y1={y0} y2={y0} stroke="#e2e8f0" strokeWidth={1} />
                {weeks.map((w, i) => {
                  const h = Math.max(2, Math.abs(w.netActual) * scale)
                  const y = w.netActual >= 0 ? y0 - h : y0
                  const x = i * slot + (slot - barW) / 2
                  const last = i === weeks.length - 1
                  return (
                    <g key={w.start}
                      onMouseEnter={() => setHover(w)} onMouseLeave={() => setHover(null)}>
                      {/* generous hit target */}
                      <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
                      <rect x={x} y={y} width={barW} height={h} rx={3}
                        fill={w.netActual >= 0 ? POS : NEG} opacity={hover && hover.start !== w.start ? 0.45 : 1} />
                      {last && (
                        <text x={x + barW / 2} y={w.netActual >= 0 ? y - 4 : y + h + 11} textAnchor="middle"
                          className="tabular-nums" fontSize={10} fill="#334155">{fmt(w.netActual)}</text>
                      )}
                      <text x={i * slot + slot / 2} y={H - 3} textAnchor="middle" fontSize={9} fill="#94a3b8">{w.label}</text>
                    </g>
                  )
                })}
              </>
            )
          })()}
        </svg>
        {hover && (
          <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md">
            <span className="font-medium">wk {hover.label}</span> · net {fmt(hover.netActual)} · buy-ins {fmt(hover.buyins)} · rake {fmt(hover.rake)} · {hover.games} game(s)
          </div>
        )}
      </div>

      {/* table view */}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-600">weekly table</summary>
        <div className="mt-1 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400">
                <th className="py-1 pr-3 font-medium">week</th>
                <th className="py-1 pr-3 font-medium">net actual</th>
                <th className="py-1 pr-3 font-medium">net calc</th>
                <th className="py-1 pr-3 font-medium">buy-ins</th>
                <th className="py-1 pr-3 font-medium">rake</th>
                <th className="py-1 font-medium">games</th>
              </tr>
            </thead>
            <tbody>
              {[...weeks].reverse().map((w) => (
                <tr key={w.start} className="border-t border-slate-100 tabular-nums">
                  <td className="py-1 pr-3">{w.label}</td>
                  <td className={`py-1 pr-3 ${w.netActual < 0 ? 'text-rose-700' : ''}`}>{fmt(w.netActual)}</td>
                  <td className="py-1 pr-3">{fmt(w.netCalc)}</td>
                  <td className="py-1 pr-3">{fmt(w.buyins)}</td>
                  <td className="py-1 pr-3">{fmt(w.rake)}</td>
                  <td className="py-1">{w.games}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
