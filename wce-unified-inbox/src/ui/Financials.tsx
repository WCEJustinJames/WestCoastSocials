import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useVenues } from './useVenues'
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
  { key: 'outgoings', label: 'Outgoings' },
  { key: 'overlay', label: 'Overlay' },
  { key: 'wages', label: 'Wages' },
] as const
type MetricKey = (typeof METRICS)[number]['key']

const RANGES = [
  { key: 1, label: '1w' },
  { key: 4, label: '4w' },
  { key: 8, label: '8w' },
  { key: 13, label: '13w' },
  { key: 26, label: '26w' },
  { key: 999, label: 'all' },
] as const

const fmt = (n: number | null | undefined): string =>
  n == null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`

/** Local YYYY-MM-DD for a date (no UTC drift). */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** Monday-start key for a date, local. */
function weekStart(d: Date): string {
  return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)))
}
/** Month-start key for a date, local. */
function monthStart(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
const dLabel = (iso: string): string =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
const mLabel = (iso: string): string =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })
/** "29 Jun – 5 Jul" for a Monday-start week key. */
function weekRange(k: string): string {
  const end = new Date(`${k}T12:00:00`)
  end.setDate(end.getDate() + 6)
  return `${dLabel(k)} – ${end.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`
}

interface Game {
  sheetId: string
  date: string
  venue: string | null
  netActual: number | null
  netCalc: number | null
  buyins: number | null
  buyinsCash: number | null
  buyinsEftpos: number | null
  buyinsPayid: number | null
  rake: number | null
  outgoings: number | null
  overlay: number | null
  wages: number | null
}
interface Bucket {
  key: string
  label: string
  netActual: number
  netCalc: number
  buyins: number
  rake: number
  outgoings: number
  overlay: number
  wages: number
  games: Game[]
}

const zero = () => ({ netActual: 0, netCalc: 0, buyins: 0, rake: 0, outgoings: 0, overlay: 0, wages: 0 })
const newBucket = (key: string, label: string): Bucket => ({ key, label, ...zero(), games: [] })
/** Fold one game's money into a bucket (net falls back across actual/calc). */
function acc(b: Bucket, g: Game) {
  b.netActual += g.netActual ?? g.netCalc ?? 0
  b.netCalc += g.netCalc ?? g.netActual ?? 0
  b.buyins += g.buyins ?? 0
  b.rake += g.rake ?? 0
  b.outgoings += g.outgoings ?? 0
  b.overlay += g.overlay ?? 0
  b.wages += g.wages ?? 0
  b.games.push(g)
}

/**
 * Home financials — interactive explorer over the TD-sheet money harvest
 * (inbox_financial_summary): pick the metric, range, venue and granularity;
 * hover for the full breakdown; click a bar/point to open that period's games.
 * Bars or a trend line; weekly, monthly, or per game; one venue or all.
 */
export function Financials() {
  const VENUES = useVenues()
  const [rows, setRows] = useState<Game[]>([])
  const [loaded, setLoaded] = useState(false)
  const [metric, setMetric] = useState<MetricKey>('netActual')
  const [rangeW, setRangeW] = useState<number>(8)
  const [venue, setVenue] = useState('all')
  const [grain, setGrain] = useState<'game' | 'week' | 'month'>('week')
  const [chartType, setChartType] = useState<'bar' | 'line'>('bar')
  // 'time' = trend over weeks/months/games; 'venue' = one bar per venue/night
  // summed over the range, sorted best-first — the which-night-makes-money view.
  const [mode, setMode] = useState<'time' | 'venue'>('time')
  const [hover, setHover] = useState<number | null>(null)
  const [selected, setSelected] = useState<Bucket | null>(null)
  // "Jump to date": pick any past date -> switch to the covering range and
  // auto-open that week's games. Resolves after buckets recompute.
  const [pendingWeek, setPendingWeek] = useState<string | null>(null)
  function jumpTo(dateStr: string) {
    if (!dateStr) return
    const wk = weekStart(new Date(`${dateStr}T12:00:00`))
    const weeksBack = Math.ceil((Date.now() - new Date(`${wk}T12:00:00`).getTime()) / (7 * 86_400_000)) + 1
    setMode('time')
    setGrain('week')
    setVenue('all')
    setRangeW(RANGES.find((r) => r.key >= weeksBack)?.key ?? 999)
    setPendingWeek(wk)
  }

  useEffect(() => {
    void (async () => {
      const today = ymd(new Date())
      const { data } = await supabase
        .from('inbox_financial_summary')
        .select('*')
        .not('game_date', 'is', null)
        .order('game_date', { ascending: true })
        .limit(2000)
      setRows(
        ((data as Fin[]) ?? [])
          .map((r) => ({
            sheetId: r.sheet_id,
            date: r.game_date ?? '',
            venue: r.venue,
            netActual: r.net_profit_actual == null ? null : Number(r.net_profit_actual),
            netCalc: r.net_profit_calc == null ? null : Number(r.net_profit_calc),
            buyins: r.gross_buyins == null ? null : Number(r.gross_buyins),
            buyinsCash: r.buyins_cash == null ? null : Number(r.buyins_cash),
            buyinsEftpos: r.buyins_eftpos == null ? null : Number(r.buyins_eftpos),
            buyinsPayid: r.buyins_payid == null ? null : Number(r.buyins_payid),
            rake: r.cash_rake == null ? null : Number(r.cash_rake),
            outgoings: r.outgoings == null ? null : Number(r.outgoings),
            overlay: r.overlay == null ? null : Number(r.overlay),
            wages: r.wages == null ? null : Number(r.wages),
          }))
          // Drop future scheduled games — LP calendar seeds blank TD sheets ahead
          // of time, which land here as all-$0 rows and made "this wk" read $0.
          .filter((g) => g.date && g.date <= today),
      )
      setLoaded(true)
    })()
  }, [])

  const buckets = useMemo(() => {
    const cutoff = ymd(new Date(Date.now() - rangeW * 7 * 86_400_000))
    const inRange = rows.filter(
      (g) => g.date >= cutoff && (mode === 'venue' || venue === 'all' || (g.venue ?? '').toLowerCase() === venue.toLowerCase()),
    )
    if (mode === 'venue') {
      const map = new Map<string, Bucket>()
      for (const g of inRange) {
        const k = g.venue ?? '(unknown)'
        const b = map.get(k) ?? newBucket(k, k)
        acc(b, g)
        map.set(k, b)
      }
      return [...map.values()].sort((a, b) => b[metric] - a[metric])
    }
    if (grain === 'game') {
      return inRange.slice(-40).map<Bucket>((g) => {
        const b = newBucket(`${g.sheetId}`, `${dLabel(g.date)}${g.venue ? ` ${g.venue.slice(0, 4)}` : ''}`)
        acc(b, g)
        return b
      })
    }
    // Weekly or monthly: bucket, then lay out a CONTINUOUS axis so every period
    // in the chosen range gets a slot — switching range/grain visibly changes the
    // span and dataless periods read as gaps (not silently skipped).
    const startKey = grain === 'month' ? monthStart : weekStart
    const map = new Map<string, Bucket>()
    for (const g of inRange) {
      const k = startKey(new Date(`${g.date}T12:00:00`))
      const b = map.get(k) ?? newBucket(k, grain === 'month' ? mLabel(k) : dLabel(k))
      acc(b, g)
      map.set(k, b)
    }
    const firstKey = rangeW >= 999
      ? (inRange.length ? startKey(new Date(`${inRange[0].date}T12:00:00`)) : startKey(new Date()))
      : startKey(new Date(Date.now() - (rangeW - 1) * 7 * 86_400_000))
    const nowKey = startKey(new Date())
    const out: Bucket[] = []
    const cur = new Date(`${firstKey}T12:00:00`)
    while (out.length < 120) {
      const k = startKey(cur)
      out.push(map.get(k) ?? newBucket(k, grain === 'month' ? mLabel(k) : dLabel(k)))
      if (k === nowKey) break
      if (grain === 'month') cur.setMonth(cur.getMonth() + 1)
      else cur.setDate(cur.getDate() + 7)
    }
    return out
  }, [rows, rangeW, venue, grain, mode, metric])

  // Resolve a pending "jump to date" once the buckets for its range exist.
  useEffect(() => {
    if (!pendingWeek) return
    const b = buckets.find((x) => x.key === pendingWeek)
    if (b) {
      setSelected(b)
      setPendingWeek(null)
    }
  }, [buckets, pendingWeek])

  // This-week / last-week tiles are always weekly and independent of the chart
  // grain (respecting only the venue filter), so switching to monthly/line view
  // never blanks them out.
  const weekTiles = useMemo(() => {
    const build = (k: string): Bucket => {
      const b = newBucket(k, '')
      for (const g of rows) {
        if (venue !== 'all' && (g.venue ?? '').toLowerCase() !== venue.toLowerCase()) continue
        if (weekStart(new Date(`${g.date}T12:00:00`)) !== k) continue
        acc(b, g)
      }
      return b
    }
    return { now: build(weekStart(new Date())), prev: build(weekStart(new Date(Date.now() - 7 * 86_400_000))) }
  }, [rows, venue])

  const thisWeekKey = weekStart(new Date())
  const thisMonthKey = monthStart(new Date())
  const nowKey = grain === 'month' ? thisMonthKey : thisWeekKey

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

  // ----- geometry (zero-baseline) -----
  // XAXIS is the bottom band reserved for the (rotated) date labels.
  const W = 560, H = 190, PAD = 20, XAXIS = 40
  const vals = buckets.map((b) => b[metric])
  const top = Math.max(...vals, 0)
  const bot = Math.min(...vals, 0)
  const span = top - bot || 1
  const scale = (H - PAD - XAXIS) / span
  const y0 = PAD + top * scale
  // Recessive gridlines at the extremes (and halfway when there's room).
  const ticks = [...new Set([top, top > 0 ? top / 2 : 0, bot < 0 ? bot : 0])].filter((t) => t !== 0)
  const slot = W / buckets.length
  const barW = Math.max(6, Math.min(36, slot - 8))
  // Thin the x-axis ticks to what actually fits, then rotate them, so dense
  // per-game / long venue labels never collapse into an unreadable smear.
  const labelChars = Math.max(4, ...buckets.map((b) => b.label.length))
  const tickStep = Math.max(1, Math.ceil((labelChars * 2.4) / slot))
  const metricLabel = METRICS.find((m) => m.key === metric)?.label ?? metric
  const isPeriod = mode === 'time' && grain !== 'game'
  const cx = (i: number) => i * slot + slot / 2
  const cy = (v: number) => y0 - v * scale

  const tiles: { name: string; now: number | null; prev: number | null }[] = [
    { name: 'Net (actual)', now: weekTiles.now.netActual, prev: weekTiles.prev.netActual },
    { name: 'Net (calc)', now: weekTiles.now.netCalc, prev: weekTiles.prev.netCalc },
    { name: 'Buy-ins', now: weekTiles.now.buyins, prev: weekTiles.prev.buyins },
    { name: 'Cash rake', now: weekTiles.now.rake, prev: weekTiles.prev.rake },
    { name: 'Outgoings', now: weekTiles.now.outgoings, prev: weekTiles.prev.outgoings },
    { name: 'Overlay', now: weekTiles.now.overlay, prev: weekTiles.prev.overlay },
    { name: 'Wages', now: weekTiles.now.wages, prev: weekTiles.prev.wages },
  ]

  const hovered = hover != null ? buckets[hover] : null
  // Non-empty points for the line path (gaps break the line).
  const linePts = buckets.map((b, i) => ({ b, i })).filter((p) => p.b.games.length > 0)
  const lastNonEmpty = linePts.length ? linePts[linePts.length - 1].i : -1

  return (
    <div className="card mb-4 p-3 sm:p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-sm font-semibold">Financials</p>
        <span className="text-[11px] text-slate-400">from the TD sheets</span>
      </div>

      {/* this-week tiles */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
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
      </div>

      {/* view row: bar/line · over time / by venue · venue · granularity */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <div className="inline-flex overflow-hidden rounded-md border border-slate-300">
          <button onClick={() => setChartType('bar')}
            className={`px-2 py-0.5 text-xs ${chartType === 'bar' ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>
            ▮ bars
          </button>
          <button onClick={() => setChartType('line')}
            className={`px-2 py-0.5 text-xs ${chartType === 'line' ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>
            ⟋ line
          </button>
        </div>
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
            <div className="inline-flex overflow-hidden rounded-md border border-slate-300">
              {(['game', 'week', 'month'] as const).map((gr) => (
                <button key={gr} onClick={() => { setGrain(gr); setSelected(null) }}
                  className={`px-2 py-0.5 text-xs ${grain === gr ? 'bg-emerald-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>
                  {gr === 'game' ? 'per game' : gr === 'week' ? 'weekly' : 'monthly'}
                </button>
              ))}
            </div>
          </>
        )}
        <label className="ml-auto flex items-center gap-1 text-xs text-slate-500" title="Jump straight to any past game night — opens that week's games">
          find a date
          <input type="date" onChange={(e) => jumpTo(e.target.value)} className="input px-1.5 py-0.5 text-xs" />
        </label>
      </div>

      {/* chart */}
      <p className="mb-1 text-xs font-medium text-slate-500">
        {metricLabel} — {mode === 'venue'
          ? `by venue/night, ${RANGES.find((r) => r.key === rangeW)?.label ?? ''} total (best first)`
          : grain === 'game' ? `last ${buckets.length} games`
          : grain === 'month' ? `monthly, last ${buckets.length} months`
          : `weekly, last ${buckets.length} weeks`}
        {mode === 'time' && venue !== 'all' ? ` · ${venue}` : ''}
      </p>
      <div className="relative">
        <svg viewBox={`-30 0 ${W + 52} ${H}`} className="w-full" role="img" aria-label={`${metricLabel} ${chartType} chart`}>
          {ticks.map((t) => {
            const ty = y0 - t * scale
            return (
              <g key={t}>
                <line x1={0} x2={W} y1={ty} y2={ty} stroke="#f1f5f9" strokeWidth={1} />
                <text x={-28} y={ty - 3} fontSize={8.5} fill="#94a3b8" className="tabular-nums">{fmt(t)}</text>
              </g>
            )
          })}
          <line x1={0} x2={W} y1={y0} y2={y0} stroke="#cbd5e1" strokeWidth={1} />

          {/* line path — drawn as segments so dataless gaps break the line */}
          {chartType === 'line' && linePts.length > 1 && (() => {
            const segs: string[] = []
            let cur: string[] = []
            let prevI = -2
            for (const { b, i } of linePts) {
              if (i !== prevI + 1 && cur.length) { segs.push(cur.join(' ')); cur = [] }
              cur.push(`${cx(i).toFixed(1)},${cy(b[metric]).toFixed(1)}`)
              prevI = i
            }
            if (cur.length) segs.push(cur.join(' '))
            return segs.map((pts, si) => <polyline key={si} points={pts} fill="none" stroke={POS} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)
          })()}

          {buckets.map((b, i) => {
            const v = b[metric]
            const empty = b.games.length === 0
            const isSel = selected?.key === b.key
            const showLabel = !empty && (i === (chartType === 'line' ? lastNonEmpty : buckets.length - 1) || isSel)
            const highlight = isPeriod && b.key === nowKey
            return (
              <g key={b.key}
                className={empty ? undefined : 'cursor-pointer'}
                onMouseEnter={() => !empty && setHover(i)} onMouseLeave={() => setHover(null)}
                onClick={() => !empty && setSelected((s) => (s?.key === b.key ? null : b))}>
                <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
                {chartType === 'line' ? (
                  empty ? null : (
                    <circle cx={cx(i)} cy={cy(v)} r={isSel ? 4.5 : 3}
                      fill={v >= 0 ? POS : NEG}
                      opacity={hover != null && hover !== i && !isSel ? 0.5 : 1}
                      stroke={isSel ? '#0f172a' : '#fff'} strokeWidth={isSel ? 1.5 : 1} />
                  )
                ) : empty ? (
                  <line x1={i * slot + (slot - barW) / 2} x2={i * slot + (slot - barW) / 2 + barW} y1={y0} y2={y0} stroke="#cbd5e1" strokeWidth={2} strokeDasharray="2 3" />
                ) : (() => {
                  const h = Math.max(2, Math.abs(v) * scale)
                  const y = v >= 0 ? y0 - h : y0
                  const x = i * slot + (slot - barW) / 2
                  return (
                    <rect x={x} y={y} width={barW} height={h} rx={3}
                      fill={v >= 0 ? POS : NEG}
                      opacity={hover != null && hover !== i && !isSel ? 0.45 : 1}
                      stroke={isSel ? '#0f172a' : 'none'} strokeWidth={isSel ? 1.5 : 0} />
                  )
                })()}
                {showLabel && (
                  <text x={cx(i)} y={v >= 0 ? Math.max(9, cy(v) - 6) : Math.min(H - XAXIS - 4, cy(v) + 13)} textAnchor="middle"
                    fontSize={10} fill="#334155" className="tabular-nums">{fmt(v)}</text>
                )}
                {(i % tickStep === 0 || highlight) && (
                  <text x={cx(i)} y={H - XAXIS + 11}
                    transform={`rotate(-40 ${cx(i).toFixed(1)} ${H - XAXIS + 11})`}
                    textAnchor="end" fontSize={8.5}
                    fill={highlight ? '#334155' : '#94a3b8'}
                    fontWeight={highlight ? 600 : 400}>
                    {highlight ? (grain === 'month' ? 'this mo' : 'this wk') : b.label}
                  </text>
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
            <span className="font-medium">
              {mode === 'time' && grain === 'week' ? `wk ${weekRange(hovered.key)}`
                : mode === 'time' && grain === 'month' ? hovered.label
                : hovered.label}
            </span>
            {' · net '}{fmt(hovered.netActual)}
            {' · buy-ins '}{fmt(hovered.buyins)}
            {' · rake '}{fmt(hovered.rake)}
            {(mode === 'venue' || isPeriod) && ` · ${hovered.games.length} game(s)`}
            {mode === 'venue' && hovered.games.length > 0 && ` · avg ${fmt(hovered[metric] / hovered.games.length)}/game`}
            {mode === 'time' && grain === 'game' && hovered.games[0]?.venue ? ` · ${hovered.games[0].venue}` : ''}
          </div>
        )}
      </div>
      <p className="mt-0.5 text-[10px] text-slate-400">hover for detail · click a {chartType === 'line' ? 'point' : 'bar'} to open its games</p>

      {/* drill-down */}
      {selected && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50/60 p-2">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-semibold">
              {mode === 'venue' ? selected.label
                : grain === 'game' ? selected.label
                : grain === 'month' ? mLabel(selected.key)
                : `Week ${weekRange(selected.key)}`} — {selected.games.length} game(s)
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
                  <th className="py-1 pr-3 font-medium">buy-ins</th>
                  <th className="py-1 pr-3 font-medium" title="tournament buy-ins paid in cash">· cash</th>
                  <th className="py-1 pr-3 font-medium" title="tournament buy-ins via EFTPOS">· eftpos</th>
                  <th className="py-1 pr-3 font-medium" title="tournament buy-ins via PayID">· payid</th>
                  <th className="py-1 pr-3 font-medium">rake</th>
                  <th className="py-1 font-medium">wages</th>
                </tr>
              </thead>
              <tbody>
                {selected.games
                  .slice()
                  .sort((a, b) => (a.date < b.date ? -1 : 1))
                  .map((g) => (
                    <tr key={g.sheetId} className="border-t border-slate-200/70 tabular-nums">
                      <td className="py-1 pr-3">{dLabel(g.date)}</td>
                      <td className="py-1 pr-3">{g.venue ?? '—'}</td>
                      <td className={`py-1 pr-3 ${g.netActual != null && g.netActual < 0 ? 'text-rose-700' : ''}`}>{fmt(g.netActual)}</td>
                      <td className="py-1 pr-3 font-medium">{fmt(g.buyins)}</td>
                      <td className="py-1 pr-3 text-slate-500">{g.buyinsCash == null ? '—' : fmt(g.buyinsCash)}</td>
                      <td className="py-1 pr-3 text-slate-500">{g.buyinsEftpos == null ? '—' : fmt(g.buyinsEftpos)}</td>
                      <td className="py-1 pr-3 text-slate-500">{g.buyinsPayid == null ? '—' : fmt(g.buyinsPayid)}</td>
                      <td className="py-1 pr-3">{fmt(g.rake)}</td>
                      <td className="py-1 text-slate-500">{g.wages == null ? '—' : fmt(g.wages)}</td>
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
