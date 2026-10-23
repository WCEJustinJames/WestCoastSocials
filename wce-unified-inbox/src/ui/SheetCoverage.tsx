import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

type Cov = Database['public']['Views']['inbox_td_coverage']['Row']

/**
 * TD-sheet coverage — every paid LP tournament event and whether a matching TD
 * sheet was harvested. The missing rows are the sheets to find/create. Collapsed
 * by default; opens to a per-month gap breakdown + the recent missing games.
 */
export function SheetCoverage() {
  const [rows, setRows] = useState<Cov[]>([])
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from('inbox_td_coverage')
        .select('event_date, event_name, venue, entries, has_sheet')
        .order('event_date', { ascending: false })
        .limit(2000)
      setRows((data as Cov[]) ?? [])
    })()
  }, [])

  const missing = useMemo(() => rows.filter((r) => r.has_sheet === false), [rows])
  const have = rows.length - missing.length
  const pct = rows.length ? Math.round((have / rows.length) * 100) : 0

  // Per-month gap counts (last 12 months with any missing).
  const byMonth = useMemo(() => {
    const m = new Map<string, { total: number; miss: number }>()
    for (const r of rows) {
      const k = (r.event_date ?? '').slice(0, 7)
      if (!k) continue
      const cur = m.get(k) ?? { total: 0, miss: 0 }
      cur.total++
      if (r.has_sheet === false) cur.miss++
      m.set(k, cur)
    }
    return [...m.entries()].filter(([, v]) => v.miss > 0).sort((a, b) => b[0].localeCompare(a[0]))
  }, [rows])

  if (rows.length === 0) return null

  const shownMonths = showAll ? byMonth : byMonth.slice(0, 8)

  return (
    <div className="card mb-4 p-3 sm:p-4">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between text-left">
        <span className="text-sm font-semibold">
          TD sheet coverage
          <span className="ml-2 font-normal text-slate-400">
            {have}/{rows.length} paid games have a sheet ({pct}%)
            {missing.length > 0 && <span className="text-amber-600"> · {missing.length} missing</span>}
          </span>
        </span>
        <span className="text-xs text-slate-400">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="mt-3">
          {/* coverage bar */}
          <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
          </div>

          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">Gaps by month</p>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {shownMonths.map(([ym, v]) => (
              <span key={ym} className="chip bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                title={`${v.miss} of ${v.total} games missing a sheet`}>
                {new Date(`${ym}-01T12:00:00`).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })}: {v.miss}
              </span>
            ))}
            {byMonth.length > 8 && (
              <button onClick={() => setShowAll((v) => !v)} className="text-xs text-slate-500 hover:underline">
                {showAll ? 'fewer' : `+${byMonth.length - 8} more months`}
              </button>
            )}
          </div>

          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">Recent missing games</p>
          <ul className="space-y-1">
            {missing.slice(0, 15).map((r, i) => (
              <li key={`${r.event_date}-${i}`} className="flex items-center gap-2 rounded border border-slate-100 bg-slate-50/50 px-2 py-1 text-xs">
                <span className="chip bg-amber-100 text-amber-700">no sheet</span>
                <span className="shrink-0 font-medium">{r.event_date}</span>
                <span className="shrink-0 text-slate-500">{r.venue ?? '?'}</span>
                <span className="min-w-0 flex-1 truncate text-slate-400">{r.event_name}</span>
                <span className="shrink-0 text-slate-400">{r.entries} entries</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-slate-400">
            Missing = a paid LP tournament with no harvested TD sheet for that date + venue. Most gaps are
            older sheets owned by other staff accounts — the backfill now sweeps every connected Google account.
          </p>
        </div>
      )}
    </div>
  )
}
