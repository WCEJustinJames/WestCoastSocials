import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { IconChevronRight } from './icons'
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
    <section className="mb-7">
      <div className="section-head">
        <span className="kicker tnum">TD sheet coverage{missing.length > 0 ? ` · ${missing.length} missing` : ''}</span>
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-xs muted tnum">
            {have}/{rows.length} paid games have a sheet ({pct}%)
          </span>
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="btn-quiet inline-flex items-center gap-1"
          >
            <span className={`flex-none transition-transform ${open ? 'rotate-90' : ''}`}>
              <IconChevronRight size={13} />
            </span>
            {open ? 'Hide' : 'Detail'}
          </button>
        </span>
      </div>

      {open && (
        <div className="mt-3">
          {/* coverage bar — one accent, no traffic light */}
          <div className="mb-4 h-[3px] w-full" style={{ background: 'color-mix(in srgb, var(--color-text) 12%, transparent)' }}>
            <div className="h-full" style={{ width: `${pct}%`, background: 'var(--color-accent)' }} />
          </div>

          <p className="m-0 py-1 text-[11px] uppercase muted-50" style={{ letterSpacing: '0.08em' }}>Gaps by month</p>
          <ul className="m-0 list-none p-0">
            {shownMonths.map(([ym, v]) => (
              <li
                key={ym}
                className="row row-hover grid grid-cols-[minmax(0,1fr)_max-content] items-baseline gap-x-4 py-3"
                title={`${v.miss} of ${v.total} games missing a sheet`}
              >
                <span className="min-w-0 truncate text-sm font-semibold tnum">
                  {new Date(`${ym}-01T12:00:00`).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })}
                  <span className="ml-2 text-xs font-normal muted tnum">{v.miss} of {v.total} missing a sheet</span>
                </span>
                <span className="text-[15px] font-extrabold tnum" style={{ color: 'var(--color-accent-700)' }}>{v.miss}</span>
              </li>
            ))}
          </ul>
          {byMonth.length > 8 && (
            <button onClick={() => setShowAll((v) => !v)} className="btn-quiet mt-1.5 tnum">
              {showAll ? 'fewer' : `+${byMonth.length - 8} more months`}
            </button>
          )}

          <p className="m-0 mt-6 py-1 text-[11px] uppercase muted-50" style={{ letterSpacing: '0.08em' }}>Recent missing games</p>
          <ul className="m-0 list-none p-0">
            {missing.slice(0, 15).map((r, i) => (
              <li
                key={`${r.event_date}-${i}`}
                className="row row-hover grid grid-cols-[minmax(0,1fr)_max-content] items-baseline gap-x-4 gap-y-1 py-3 [grid-template-areas:'name_figs'_'meta_meta'] dt:grid-cols-[150px_minmax(0,1fr)_max-content] dt:[grid-template-areas:'name_meta_figs']"
              >
                <span className="flex min-w-0 items-baseline gap-2 [grid-area:name]">
                  <span className="truncate text-sm font-semibold tnum">{r.event_date}</span>
                  <span className="tag tag-accent tag-net">no sheet</span>
                </span>
                <span className="min-w-0 truncate text-xs muted [grid-area:meta]">
                  {r.venue ?? '?'} · {r.event_name}
                </span>
                <span className="text-xs muted tnum [grid-area:figs]">{r.entries} entries</span>
              </li>
            ))}
          </ul>
          <p className="m-0 mt-2 text-[11px] muted">
            Missing = a paid LP tournament with no harvested TD sheet for that date + venue. Most gaps are
            older sheets owned by other staff accounts — the backfill now sweeps every connected Google account.
          </p>
        </div>
      )}
    </section>
  )
}
