import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useVenues } from './useVenues'
import type { Database } from '../types/database'

type Fin = Database['public']['Views']['inbox_financial_summary']['Row']

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

// The chart's single-accent palette: past periods neutral, the current period
// accent, everything else drawn with ink mixes so it follows the theme tokens.
const INK_50 = 'color-mix(in srgb, var(--color-text) 50%, transparent)'
const INK_8 = 'color-mix(in srgb, var(--color-text) 8%, transparent)'

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

  // This-week / last-week stats are always weekly and independent of the chart
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

  const headLeft = (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className="kicker">Financials</span>
      <span className="text-xs muted-45">— from the TD sheets</span>
    </span>
  )
  const rangeSeg = (
    <div className="seg">
      {RANGES.map((r) => (
        <button
          key={r.key}
          className="seg-btn seg-btn-sm tnum"
          aria-pressed={rangeW === r.key}
          onClick={() => { setRangeW(r.key); setSelected(null) }}
        >
          {r.label}
        </button>
      ))}
    </div>
  )
  const controlRow = (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="seg">
        <button className="seg-btn seg-btn-sm" aria-pressed={chartType === 'bar'} onClick={() => setChartType('bar')}>bars</button>
        <button className="seg-btn seg-btn-sm" aria-pressed={chartType === 'line'} onClick={() => setChartType('line')}>line</button>
      </div>
      <div className="seg">
        <button className="seg-btn seg-btn-sm" aria-pressed={mode === 'time'} onClick={() => { setMode('time'); setSelected(null) }}>over time</button>
        <button className="seg-btn seg-btn-sm" aria-pressed={mode === 'venue'} onClick={() => { setMode('venue'); setSelected(null) }}>by venue</button>
      </div>
      {mode === 'time' && (
        <>
          <select
            value={venue}
            onChange={(e) => { setVenue(e.target.value); setSelected(null) }}
            className="input !min-h-0 !w-auto px-2 py-1 text-xs"
          >
            <option value="all">all venues</option>
            {VENUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <div className="seg">
            {(['game', 'week', 'month'] as const).map((gr) => (
              <button
                key={gr}
                className="seg-btn seg-btn-sm"
                aria-pressed={grain === gr}
                onClick={() => { setGrain(gr); setSelected(null) }}
              >
                {gr === 'game' ? 'per game' : gr === 'week' ? 'weekly' : 'monthly'}
              </button>
            ))}
          </div>
        </>
      )}
      <label className="ml-auto flex items-center gap-1.5 text-xs muted" title="Jump straight to any past game night — opens that week's games">
        find a date
        <input type="date" onChange={(e) => jumpTo(e.target.value)} className="input !min-h-0 !w-auto px-2 py-1 text-xs tnum" />
      </label>
    </div>
  )

  if (loaded && rows.length === 0) {
    return (
      <section className="mb-7">
        <div className="section-head mb-0 mt-7 pt-5">{headLeft}</div>
        <p className="m-0 mt-3 text-sm font-semibold">Nothing harvested yet</p>
        <p className="m-0 mt-0.5 text-xs muted">Game financials mirror from the TD sheets as they sync.</p>
      </section>
    )
  }
  if (!buckets.length) {
    return (
      <section className="mb-7">
        <div className="section-head mb-0 mt-7 pt-5">
          {headLeft}
          {rangeSeg}
        </div>
        <p className="m-0 mt-3 text-sm font-semibold">No games match this range/venue</p>
        <p className="m-0 mt-0.5 text-xs muted">Widen the range or switch venue.</p>
        {controlRow}
      </section>
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

  const hovered = hover != null ? buckets[hover] : null
  // Non-empty points for the line path (gaps break the line).
  const linePts = buckets.map((b, i) => ({ b, i })).filter((p) => p.b.games.length > 0)
  const lastNonEmpty = linePts.length ? linePts[linePts.length - 1].i : -1

  return (
    <section className="mb-7">
      <div className="section-head mb-0 mt-7 pt-5">
        {headLeft}
        {rangeSeg}
      </div>

      {/* chart header: what's charted + the real this-wk/last-wk figures */}
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
        <p className="m-0 text-[13px] font-semibold">
          {metricLabel} — {mode === 'venue'
            ? `by venue/night, ${RANGES.find((r) => r.key === rangeW)?.label ?? ''} total (best first)`
            : grain === 'game' ? `last ${buckets.length} games`
            : grain === 'month' ? `monthly, last ${buckets.length} months`
            : `weekly, last ${buckets.length} weeks`}
          {mode === 'time' && venue !== 'all' ? ` · ${venue}` : ''}
        </p>
        <p className="m-0 text-xs muted tnum">
          this wk {fmt(weekTiles.now[metric])} · last wk {fmt(weekTiles.prev[metric])}
        </p>
      </div>

      {/* chart */}
      <div className="relative">
        <svg viewBox={`-30 0 ${W + 52} ${H}`} className="w-full" role="img" aria-label={`${metricLabel} ${chartType} chart`}>
          {ticks.map((t) => {
            const ty = y0 - t * scale
            return (
              <g key={t}>
                <line x1={0} x2={W} y1={ty} y2={ty} stroke={INK_8} strokeWidth={1} />
                <text x={-28} y={ty - 3} fontSize={8.5} fill={INK_50} className="tnum">{fmt(t)}</text>
              </g>
            )
          })}
          <line x1={0} x2={W} y1={y0} y2={y0} stroke="var(--color-divider)" strokeWidth={2} />

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
            return segs.map((pts, si) => (
              <polyline key={si} points={pts} fill="none" stroke="var(--color-neutral-800)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))
          })()}

          {buckets.map((b, i) => {
            const v = b[metric]
            const empty = b.games.length === 0
            const isSel = selected?.key === b.key
            const showLabel = !empty && (i === (chartType === 'line' ? lastNonEmpty : buckets.length - 1) || isSel)
            const highlight = isPeriod && b.key === nowKey
            // The CURRENT period — this wk / this mo / the last game — carries
            // the one accent; every other period stays neutral.
            const current = mode === 'time' && (grain === 'game' ? i === buckets.length - 1 : b.key === nowKey)
            const fill = current ? 'var(--color-accent)' : 'var(--color-neutral-400)'
            return (
              <g key={b.key}
                className={empty ? undefined : 'cursor-pointer'}
                onMouseEnter={() => !empty && setHover(i)} onMouseLeave={() => setHover(null)}
                onClick={() => !empty && setSelected((s) => (s?.key === b.key ? null : b))}>
                <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
                {chartType === 'line' ? (
                  empty ? null : (
                    <circle cx={cx(i)} cy={cy(v)} r={isSel ? 4.5 : 3}
                      fill={fill}
                      opacity={hover != null && hover !== i && !isSel ? 0.5 : 1}
                      stroke={isSel ? 'var(--color-neutral-800)' : 'none'} strokeWidth={isSel ? 1.5 : 0} />
                  )
                ) : empty ? (
                  <line x1={i * slot + (slot - barW) / 2} x2={i * slot + (slot - barW) / 2 + barW} y1={y0} y2={y0} stroke="var(--color-neutral-300)" strokeWidth={2} strokeDasharray="2 3" />
                ) : (() => {
                  const h = Math.max(2, Math.abs(v) * scale)
                  const y = v >= 0 ? y0 - h : y0
                  const x = i * slot + (slot - barW) / 2
                  return (
                    <rect x={x} y={y} width={barW} height={h}
                      fill={fill}
                      opacity={hover != null && hover !== i && !isSel ? 0.45 : 1}
                      stroke={isSel ? 'var(--color-neutral-800)' : 'none'} strokeWidth={isSel ? 1.5 : 0} />
                  )
                })()}
                {showLabel && (
                  <text x={cx(i)} y={v >= 0 ? Math.max(9, cy(v) - 6) : Math.min(H - XAXIS - 4, cy(v) + 13)} textAnchor="middle"
                    fontSize={10} fill="var(--color-text)" className="tnum">{fmt(v)}</text>
                )}
                {(i % tickStep === 0 || highlight) && (
                  <text x={cx(i)} y={H - XAXIS + 11}
                    transform={`rotate(-40 ${cx(i).toFixed(1)} ${H - XAXIS + 11})`}
                    textAnchor="end" fontSize={8.5}
                    fill={highlight ? 'var(--color-text)' : INK_50}
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
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap bg-paper px-2.5 py-1.5 text-xs tnum"
            style={{ border: '1px solid var(--color-divider)', left: `${Math.min(88, Math.max(12, ((hover! + 0.5) / buckets.length) * 100))}%` }}
          >
            <span className="font-semibold">
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
      <p className="m-0 mt-1 text-[11px] muted-45">hover for detail · click a {chartType === 'line' ? 'point' : 'bar'} to open its games</p>

      {/* stat grid — each figure is a button that charts its metric */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-[18px] py-3.5 dt:grid-cols-4">
        {METRICS.map((m) => {
          const sel = metric === m.key
          const nowV = weekTiles.now[m.key]
          const prevV = weekTiles.prev[m.key]
          return (
            <button
              key={m.key}
              onClick={() => setMetric(m.key)}
              className="min-w-0 cursor-pointer bg-transparent p-0 pb-2 text-left"
              style={{ border: 0, borderBottom: `3px solid ${sel ? 'var(--color-accent)' : 'transparent'}` }}
            >
              <span
                className={`block truncate text-[11px] font-semibold uppercase ${sel ? '' : 'muted-70'}`}
                style={{ letterSpacing: '0.08em', ...(sel ? { color: 'var(--color-accent-700)' } : null) }}
              >
                {m.label} · this wk
              </span>
              <span
                className="mt-1 block text-[28px] font-extrabold leading-none tnum"
                style={nowV < 0 ? { color: 'var(--color-accent-700)' } : undefined}
              >
                {fmt(nowV)}
              </span>
              <span className="mt-1 block text-[11px] muted-50 tnum">last wk {fmt(prevV)}</span>
            </button>
          )
        })}
      </div>
      <p className="m-0 text-[11px] muted">Tap a figure to chart it. Full breakdown in Money · Analytics.</p>

      {controlRow}

      {/* drill-down */}
      {selected && (
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between gap-3">
            <p className="m-0 text-sm font-semibold tnum">
              {mode === 'venue' ? selected.label
                : grain === 'game' ? selected.label
                : grain === 'month' ? mLabel(selected.key)
                : `Week ${weekRange(selected.key)}`} — {selected.games.length} game(s)
            </p>
            <button onClick={() => setSelected(null)} className="btn-quiet">close</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr className="text-left">
                  {[
                    ['date', undefined],
                    ['venue', undefined],
                    ['net actual', undefined],
                    ['buy-ins', undefined],
                    ['· cash', 'tournament buy-ins paid in cash'],
                    ['· eftpos', 'tournament buy-ins via EFTPOS'],
                    ['· payid', 'tournament buy-ins via PayID'],
                    ['rake', undefined],
                    ['wages', undefined],
                  ].map(([label, title]) => (
                    <th
                      key={label}
                      title={title}
                      className="py-1.5 pr-3 text-[11px] font-semibold uppercase muted-60"
                      style={{ letterSpacing: '0.08em', borderBottom: '2px solid var(--color-divider)' }}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selected.games
                  .slice()
                  .sort((a, b) => (a.date < b.date ? -1 : 1))
                  .map((g) => (
                    <tr key={g.sheetId} className="row tnum">
                      <td className="py-1.5 pr-3">{dLabel(g.date)}</td>
                      <td className="py-1.5 pr-3">{g.venue ?? '—'}</td>
                      <td className="py-1.5 pr-3" style={g.netActual != null && g.netActual < 0 ? { color: 'var(--color-accent-700)' } : undefined}>{fmt(g.netActual)}</td>
                      <td className="py-1.5 pr-3 font-semibold">{fmt(g.buyins)}</td>
                      <td className="py-1.5 pr-3 muted">{g.buyinsCash == null ? '—' : fmt(g.buyinsCash)}</td>
                      <td className="py-1.5 pr-3 muted">{g.buyinsEftpos == null ? '—' : fmt(g.buyinsEftpos)}</td>
                      <td className="py-1.5 pr-3 muted">{g.buyinsPayid == null ? '—' : fmt(g.buyinsPayid)}</td>
                      <td className="py-1.5 pr-3">{fmt(g.rake)}</td>
                      <td className="py-1.5 muted">{g.wages == null ? '—' : fmt(g.wages)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
