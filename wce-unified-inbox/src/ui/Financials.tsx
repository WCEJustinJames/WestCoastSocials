import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { VENUES } from './usePlayers'
import type { Database } from '../types/database'

type Fin = Database['public']['Views']['inbox_financial_summary']['Row']

// Profit/loss poles — validated diverging pair (CVD-safe on the light surface).
// Magnitude metrics (buy-ins, rake) stay single-hue blue; red is reserved for
// a genuinely negative value.
const POS = '#2a78d6'
const NEG = '#e34948'

const METRICS = [
  { key: 'netActual', label: 'Net (actual)' },
  { key: 'netCalc', label: 'Net (calc)' },
  { key: 'buyins', label: 'Buy-ins' },
  { key: 'rake', label: 'Cash rake' },
] as const
type MetricKey = (typeof METRICS)[number]['key']

const RANGES = [
  { key: 4, label: '4w' },
  { key: 8, label: '8w' },
  { key: 13, label: '13w' },
  { key: 26, label: '26w' },
  { key: 999, label: 'all' },
] as const

const fmt = (n: number | null | undefined): string =>
  n == null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`

/** Monday-start key for a date, local. */
function weekStart(d: Date): string {
  const w = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
  return `${w.getFullYear()}-${String(w.getMonth() + 1).padStart(2, '0')}-${String(w.getDate()).padStart(2, '0')}`
}
const dLabel = (iso: string): string =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })

interface Game {
  sheetId: string
  date: string
  venue: string | null
  netActual: number | null
  netCalc: number | null
  buyins: number | null
  rake: number | null
}
interface Bucket {
  key: string
  label: string
  netActual: number
  netCalc: number
  buyins: number
  rake: number
  games: Game[]
}

/**
 * Home financials — interactive explorer over the TD-sheet money harvest
 * (inbox_financial_summary): pick the metric, range, venue and granularity;
 * hover for the full breakdown; click a bar to open that week's games.
 */
export function Financials() {
  const [rows, setRows] = useState<Game[]>([])
  const [loaded, setLoaded] = useState(false)
  const [metric, setMetric] = useState<MetricKey>('netActual')
  const [rangeW, setRangeW] = useState<number>(8)
  const [venue, setVenue] = useState('all')
  const [perGame, setPerGame] = useState(false)
  // 'time' = trend over weeks/games; 'venue' = one bar per venue/night summed
  // over the range, sorted best-first — the which-night-makes-money view.
  const [mode, setMode] = useState<'time' | 'venue'>('time')
  const [hover, setHover] = useState<number | null>(null)
  const [selected, setSelected] = useState<Bucket | null>(null)

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from('inbox_financial_summary')
        .select('*')
        .not('game_date', 'is', null)
        .order('game_date', { ascending: true })
        .limit(2000)
      setRows(((data as Fin[]) ?? []).map((r) => ({
        sheetId: r.sheet_id,
        date: r.game_date ?? '',
        venue: r.venue,
        netActual: r.net_profit_actual == null ? null : Number(r.net_profit_actual),
        netCalc: r.net_profit_calc == null ? null : Number(r.net_profit_calc),
        buyins: r.gross_buyins == null ? null : Number(r.gross_buyins),
        rake: r.cash_rake == null ? null : Number(r.cash_rake),
      })))
      setLoaded(true)
    })()
  }, [])

  const buckets = useMemo(() => {
    const cutoff = new Date(Date.now() - rangeW * 7 * 86_400_000).toISOString().slice(0, 10)
    const inRange = rows.filter(
      (g) => g.date >= cutoff && (mode === 'venue' || venue === 'all' || (g.venue ?? '').toLowerCase() === venue.toLowerCase()),
    )
    if (mode === 'venue') {
      const map = new Map<string, Bucket>()
      for (const g of inRange) {
        const k = g.venue ?? '(unknown)'
        const b = map.get(k) ?? { key: k, label: k, netActual: 0, netCalc: 0, buyins: 0, rake: 0, games: [] }
        b.netActual += g.netActual ?? g.netCalc ?? 0
        b.netCalc += g.netCalc ?? g.netActual ?? 0
        b.buyins += g.buyins ?? 0
        b.rake += g.rake ?? 0
        b.games.push(g)
        map.set(k, b)
      }
      return [...map.values()].sort((a, b) => b[metric] - a[metric])
    }
    if (perGame) {
      return inRange.slice(-40).map<Bucket>((g) => ({
        key: `${g.sheetId}`,
        label: `${dLabel(g.date)}${g.venue ? ` ${g.venue.slice(0, 4)}` : ''}`,
        netActual: g.netActual ?? g.netCalc ?? 0,
        netCalc: g.netCalc ?? g.netActual ?? 0,
        buyins: g.buyins ?? 0,
        rake: g.rake ?? 0,
        games: [g],
      }))
    }
    const map = new Map<string, Bucket>()
    for (const g of inRange) {
      const k = weekStart(new Date(`${g.date}T12:00:00`))
      const b = map.get(k) ?? { key: k, label: dLabel(k), netActual: 0, netCalc: 0, buyins: 0, rake: 0, games: [] }
      b.netActual += g.netActual ?? g.netCalc ?? 0
      b.netCalc += g.netCalc ?? g.netActual ?? 0
      b.buyins += g.buyins ?? 0
      b.rake += g.rake ?? 0
      b.games.push(g)
      map.set(k, b)
    }
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key)).slice(-Math.max(rangeW, 4))
  }, [rows, rangeW, venue, perGame, mode, metric])

  const thisWeekKey = weekStart(new Date())
  const thisWeek = buckets.find((b) => !perGame && b.key === thisWeekKey)
  const lastWeek = !perGame && buckets.length >= 2 ? buckets[buckets.length - 2] : null

  if (loaded && rows.length === 0) {
    return (
      <div className="card mb-4 p-3">
        <p className="text-sm font-semibold">Financials</p>
        <p className="text-xs text-slate-400">Nothing harvested yet — game financials mirror from the TD sheets as they sync.</p>
      </div>
    )
  }
  if (!buckets.length) {
    return (
      <div className="card mb-4 p-3">
        <p className="text-sm font-semibold">Financials</p>
        <p className="text-xs text-slate-400">No games match this range/venue — widen the range or switch venue.</p>
      </div>
    )
  }

  // ----- geometry (zero-baseline bars) -----
  const W = 560, H = 170, PAD = 22, LABEL_H = 16
  const vals = buckets.map((b) => b[metric])
  const top = Math.max(...vals, 0)
  const bot = Math.min(...vals, 0)
  const span = top - bot || 1
  const scale = (H - PAD * 2 - LABEL_H) / span
  const y0 = PAD + top * scale
  // Recessive gridlines at the extremes (and halfway when there's room).
  const ticks = [...new Set([top, top > 0 ? top / 2 : 0, bot < 0 ? bot : 0])].filter((t) => t !== 0)
  const slot = W / buckets.length
  const barW = Math.max(6, Math.min(36, slot - 8))
  const metricLabel = METRICS.find((m) => m.key === metric)?.label ?? metric

  const tiles: { name: string; now: number | null; prev: number | null }[] = [
    { name: 'Net (actual)', now: thisWeek?.netActual ?? null, prev: lastWeek?.netActual ?? null },
    { name: 'Net (calc)', now: thisWeek?.netCalc ?? null, prev: lastWeek?.netCalc ?? null },
    { name: 'Buy-ins', now: thisWeek?.buyins ?? null, prev: lastWeek?.buyins ?? null },
    { name: 'Cash rake', now: thisWeek?.rake ?? null, prev: lastWeek?.rake ?? null },
  ]

  const hovered = hover != null ? buckets[hover] : null

  return (
    <div className="card mb-4 p-3 sm:p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-sm font-semibold">Financials</p>
        <span className="text-[11px] text-slate-400">from the TD sheets</span>
      </div>

      {/* this-week tiles */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.name} className="rounded-lg border border-slate-100 bg-slate-50/60 px-2.5 py-2">
            <p className="text-[11px] text-slate-500">{t.name} · this wk</p>
            <p className={`text-lg font-semibold tabular-nums ${t.now != null && t.now < 0 ? 'text-rose-700' : 'text-slate-900'}`}>{fmt(t.now)}</p>
            <p className="text-[11px] text-slate-400">last wk {fmt(t.prev)}</p>
          </div>
        ))}
      </div>

      {/* filter row */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {METRICS.map((m) => (
          <button key={m.key} onClick={() => setMetric(m.key)}
            className={`chip border ${metric === m.key ? 'border-slate-700 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-500 hover:border-slate-500'}`}>
            {m.label}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-slate-200" />
        {RANGES.map((r) => (
          <button key={r.key} onClick={() => { setRangeW(r.key); setSelected(null) }}
            className={`chip border ${rangeW === r.key ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300 bg-white text-slate-500 hover:border-emerald-400'}`}>
            {r.label}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-slate-200" />
        <button onClick={() => { setMode('time'); setSelected(null) }}
          className={`chip border ${mode === 'time' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300 bg-white text-slate-500 hover:border-emerald-400'}`}>
          over time
        </button>
        <button onClick={() => { setMode('venue'); setSelected(null) }}
          className={`chip border ${mode === 'venue' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300 bg-white text-slate-500 hover:border-emerald-400'}`}>
          by venue
        </button>
        {mode === 'time' && (
          <>
            <select value={venue} onChange={(e) => { setVenue(e.target.value); setSelected(null) }} className="input px-2 py-0.5 text-xs">
              <option value="all">all venues</option>
              {VENUES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <label className="ml-auto flex items-center gap-1 text-xs text-slate-500">
              <input type="checkbox" checked={perGame} onChange={(e) => { setPerGame(e.target.checked); setSelected(null) }} />
              per game
            </label>
          </>
        )}
      </div>

      {/* chart */}
      <p className="mb-1 text-xs font-medium text-slate-500">
        {metricLabel} — {mode === 'venue'
          ? `by venue/night, ${RANGES.find((r) => r.key === rangeW)?.label ?? ''} total (best first)`
          : perGame ? `last ${buckets.length} games` : `weekly, last ${buckets.length} weeks`}
        {mode === 'time' && venue !== 'all' ? ` · ${venue}` : ''}
      </p>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${metricLabel} bar chart`}>
          {ticks.map((t) => {
            const ty = y0 - t * scale
            return (
              <g key={t}>
                <line x1={0} x2={W} y1={ty} y2={ty} stroke="#f1f5f9" strokeWidth={1} />
                <text x={2} y={ty - 3} fontSize={8.5} fill="#94a3b8" className="tabular-nums">{fmt(t)}</text>
              </g>
            )
          })}
          <line x1={0} x2={W} y1={y0} y2={y0} stroke="#cbd5e1" strokeWidth={1} />
          {buckets.map((b, i) => {
            const v = b[metric]
            const h = Math.max(2, Math.abs(v) * scale)
            const y = v >= 0 ? y0 - h : y0
            const x = i * slot + (slot - barW) / 2
            const isSel = selected?.key === b.key
            return (
              <g key={b.key}
                className="cursor-pointer"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                onClick={() => setSelected((s) => (s?.key === b.key ? null : b))}>
                <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
                <rect x={x} y={y} width={barW} height={h} rx={3}
                  fill={v >= 0 ? POS : NEG}
                  opacity={hover != null && hover !== i && !isSel ? 0.45 : 1}
                  stroke={isSel ? '#0f172a' : 'none'} strokeWidth={isSel ? 1.5 : 0} />
                {(i === buckets.length - 1 || isSel) && (
                  <text x={x + barW / 2} y={v >= 0 ? Math.max(9, y - 4) : Math.min(H - LABEL_H, y + h + 11)} textAnchor="middle"
                    fontSize={10} fill="#334155" className="tabular-nums">{fmt(v)}</text>
                )}
                {(buckets.length <= 14 || i % Math.ceil(buckets.length / 14) === 0) && (
                  <text x={i * slot + slot / 2} y={H - 3} textAnchor="middle" fontSize={8.5} fill="#94a3b8">{b.label}</text>
                )}
              </g>
            )
          })}
        </svg>
        {hovered && (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md"
            style={{ left: `${Math.min(88, Math.max(12, ((hover! + 0.5) / buckets.length) * 100))}%` }}
          >
            <span className="font-medium">{hovered.label}</span>
            {' · net '}{fmt(hovered.netActual)}
            {' · buy-ins '}{fmt(hovered.buyins)}
            {' · rake '}{fmt(hovered.rake)}
            {(mode === 'venue' || !perGame) && ` · ${hovered.games.length} game(s)`}
            {mode === 'venue' && hovered.games.length > 0 && ` · avg ${fmt(hovered[metric] / hovered.games.length)}/game`}
            {mode === 'time' && perGame && hovered.games[0]?.venue ? ` · ${hovered.games[0].venue}` : ''}
          </div>
        )}
      </div>
      <p className="mt-0.5 text-[10px] text-slate-400">hover for detail · click a bar to open its games</p>

      {/* drill-down */}
      {selected && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50/60 p-2">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-semibold">
              {mode === 'venue' ? selected.label : perGame ? selected.label : `Week of ${selected.label}`} — {selected.games.length} game(s)
            </p>
            <button onClick={() => setSelected(null)} className="text-xs text-slate-400 hover:text-rose-600">close</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="py-1 pr-3 font-medium">date</th>
                  <th className="py-1 pr-3 font-medium">venue</th>
                  <th className="py-1 pr-3 font-medium">net actual</th>
                  <th className="py-1 pr-3 font-medium">net calc</th>
                  <th className="py-1 pr-3 font-medium">buy-ins</th>
                  <th className="py-1 font-medium">rake</th>
                </tr>
              </thead>
              <tbody>
                {selected.games.map((g) => (
                  <tr key={g.sheetId} className="border-t border-slate-200/70 tabular-nums">
                    <td className="py-1 pr-3">{dLabel(g.date)}</td>
                    <td className="py-1 pr-3">{g.venue ?? '—'}</td>
                    <td className={`py-1 pr-3 ${g.netActual != null && g.netActual < 0 ? 'text-rose-700' : ''}`}>{fmt(g.netActual)}</td>
                    <td className="py-1 pr-3">{fmt(g.netCalc)}</td>
                    <td className="py-1 pr-3">{fmt(g.buyins)}</td>
                    <td className="py-1">{fmt(g.rake)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
