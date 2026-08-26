import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

type Conv = Database['public']['Views']['inbox_batch_conversion']['Row']

const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0)

const WEEK_MS = 7 * 86_400_000
/** Monday 00:00 local for the week containing d (Perth has no DST). */
function weekStart(d: Date): number {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x.getTime()
}

type Metric = 'sent' | 'replied' | 'yes' | 'replyPct' | 'yesPct'
const METRICS: { id: Metric; label: string }[] = [
  { id: 'sent', label: 'Sent' },
  { id: 'replied', label: 'Replied' },
  { id: 'yes', label: 'Yes' },
  { id: 'replyPct', label: 'Reply %' },
  { id: 'yesPct', label: 'Yes %' },
]
const METRIC_TITLE: Record<Metric, string> = {
  sent: 'Messages sent',
  replied: 'Replies',
  yes: 'Yes replies',
  replyPct: 'Reply rate',
  yesPct: 'Yes rate',
}
type Range = '4' | '8' | '13' | '26' | 'all'
const RANGES: { id: Range; label: string }[] = [
  { id: '4', label: '4w' },
  { id: '8', label: '8w' },
  { id: '13', label: '13w' },
  { id: '26', label: '26w' },
  { id: 'all', label: 'all' },
]

/** Selectable chip (metric row) — accent fill when on, 7% ink tint on hover. */
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className="cursor-pointer whitespace-nowrap text-xs hover:bg-[color-mix(in_srgb,var(--color-text)_7%,transparent)]"
      style={{
        flex: 'none',
        padding: '5px 12px',
        border: '1px solid var(--color-divider)',
        background: on ? 'var(--color-accent)' : undefined,
        color: on ? 'var(--color-bg)' : 'var(--color-text)',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  )
}

/**
 * Analytics tab — outreach conversion per batch and rolled up by venue. Shows, for
 * each batch we sent, how many replied and how many said yes/no/maybe, so you can
 * see which wording and venues actually convert. Attribution is approximate (first
 * classified reply within 7 days of the batch). The chart buckets the same batch
 * numbers by week.
 */
export function Analytics() {
  const [rows, setRows] = useState<Conv[]>([])
  const [loading, setLoading] = useState(true)
  const [metric, setMetric] = useState<Metric>('sent')
  const [range, setRange] = useState<Range>('8')

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('inbox_batch_conversion')
      .select('*')
      .order('created_at', { ascending: false })
    setRows((data as Conv[]) ?? [])
    setLoading(false)
  }
  useEffect(() => { void load() }, [])

  // Roll up by venue (falling back to '—' when a batch has no venue tag).
  const byVenue = useMemo(() => {
    const m = new Map<string, { sent: number; replied: number; yes: number; no: number; maybe: number }>()
    for (const r of rows) {
      const k = (r.venue ?? '').trim() || '—'
      const a = m.get(k) ?? { sent: 0, replied: 0, yes: 0, no: 0, maybe: 0 }
      a.sent += r.sent; a.replied += r.replied; a.yes += r.yes; a.no += r.no; a.maybe += r.maybe
      m.set(k, a)
    }
    return [...m.entries()].sort((a, b) => b[1].sent - a[1].sent)
  }, [rows])

  const totals = useMemo(() => rows.reduce(
    (a, r) => ({ sent: a.sent + r.sent, replied: a.replied + r.replied, yes: a.yes + r.yes }),
    { sent: 0, replied: 0, yes: 0 },
  ), [rows])

  // Weekly buckets, oldest → newest, for the selected range (from the batch
  // rows already loaded — same numbers as the tables below).
  const weekly = useMemo(() => {
    const now = weekStart(new Date())
    let n: number
    if (range === 'all') {
      const earliest = rows.length
        ? Math.min(...rows.map((r) => weekStart(new Date(r.created_at))))
        : now
      n = Math.min(52, Math.round((now - earliest) / WEEK_MS) + 1)
    } else {
      n = Number(range)
    }
    n = Math.max(n, 1)
    const buckets = Array.from({ length: n }, () => ({ sent: 0, replied: 0, yes: 0 }))
    for (const r of rows) {
      const idx = Math.round((now - weekStart(new Date(r.created_at))) / WEEK_MS)
      if (idx >= 0 && idx < n) {
        const b = buckets[n - 1 - idx]
        b.sent += r.sent; b.replied += r.replied; b.yes += r.yes
      }
    }
    return buckets
  }, [rows, range])

  const values = useMemo(() => weekly.map((b) => {
    if (metric === 'sent') return b.sent
    if (metric === 'replied') return b.replied
    if (metric === 'yes') return b.yes
    if (metric === 'replyPct') return pct(b.replied, b.sent)
    return pct(b.yes, b.sent)
  }), [weekly, metric])

  // ----- flat bar chart (SVG) -----
  const W = 720
  const H = 140
  const posMax = Math.max(...values, 0)
  const negMin = Math.min(...values, 0)
  const span = posMax - negMin || 1
  const chartH = H - 8 // 4px breathing room top and bottom
  const zeroY = 4 + (posMax / span) * (chartH - 2)
  const slot = W / values.length
  const barW = slot * 0.72

  const numHead = (label: string) => (
    <span className="text-right text-[10px] uppercase muted-50" style={{ letterSpacing: '0.08em' }}>{label}</span>
  )

  return (
    <div className="max-w-[860px]">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="m-0 flex-1 text-[13px] muted tnum">
          Outreach conversion per batch and by venue. {totals.sent} sent · {totals.replied} replied ({pct(totals.replied, totals.sent)}%) · {totals.yes} yes ({pct(totals.yes, totals.sent)}%).
        </p>
        <button onClick={() => void load()} className="btn-quiet">Refresh</button>
      </div>

      {loading ? (
        <p className="m-0 py-3 text-[13px] muted" style={{ borderTop: '2px solid var(--color-divider)' }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p className="m-0 py-3 text-[13px] muted" style={{ borderTop: '2px solid var(--color-divider)' }}>No sent batches yet.</p>
      ) : (
        <>
          {/* ----- weekly chart ----- */}
          <div className="section-head">
            <span className="kicker">{METRIC_TITLE[metric]} · weekly</span>
            <div className="seg">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  className="seg-btn seg-btn-sm"
                  aria-pressed={range === r.id}
                  onClick={() => setRange(r.id)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="mt-3 block w-full"
            style={{ height: H }}
            role="img"
            aria-label={`${METRIC_TITLE[metric]} per week, last ${values.length} weeks`}
          >
            {values.map((v, i) => {
              const h = (Math.abs(v) / span) * (chartH - 2)
              const y = v >= 0 ? zeroY - h : zeroY + 2
              return (
                <rect
                  key={i}
                  x={i * slot + (slot - barW) / 2}
                  y={y}
                  width={barW}
                  height={h}
                  fill={i === values.length - 1 ? 'var(--color-accent)' : 'var(--color-neutral-400)'}
                />
              )
            })}
            <rect x={0} y={zeroY} width={W} height={2} fill="var(--color-divider)" />
          </svg>
          <div className="mt-1 flex justify-between text-[10px] uppercase muted-50 tnum" style={{ letterSpacing: '0.08em' }}>
            <span>{values.length - 1} wk ago</span>
            <span>this wk</span>
          </div>
          <div className="mt-3.5 flex flex-wrap gap-1.5">
            {METRICS.map((m) => (
              <Chip key={m.id} on={metric === m.id} onClick={() => setMetric(m.id)}>
                {m.label}
              </Chip>
            ))}
          </div>

          {/* ----- by venue ----- */}
          <div className="mt-8">
            <div className="section-head">
              <span className="kicker">By venue</span>
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[520px]">
                <div className="grid grid-cols-[minmax(120px,1fr)_repeat(5,72px)] gap-x-3 py-2">
                  <span className="text-[10px] uppercase muted-50" style={{ letterSpacing: '0.08em' }}>Venue</span>
                  {numHead('Sent')}
                  {numHead('Replied')}
                  {numHead('Reply %')}
                  {numHead('Yes')}
                  {numHead('Yes %')}
                </div>
                {byVenue.map(([venue, a]) => (
                  <div key={venue} className="row grid grid-cols-[minmax(120px,1fr)_repeat(5,72px)] items-center gap-x-3 py-[9px]">
                    <span className="truncate text-[13px] font-semibold">{venue}</span>
                    <span className="text-right text-[13px] tnum">{a.sent}</span>
                    <span className="text-right text-[13px] tnum">{a.replied}</span>
                    <span className="text-right text-[13px] tnum">{pct(a.replied, a.sent)}%</span>
                    <span className="text-right text-[13px] tnum">{a.yes}</span>
                    <span className="text-right text-[13px] font-semibold tnum">{pct(a.yes, a.sent)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ----- per batch ----- */}
          <div className="mt-8">
            <div className="section-head">
              <span className="kicker">Per batch</span>
              <span className="text-xs muted tnum">{rows.length}</span>
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[640px]">
                <div className="grid grid-cols-[72px_minmax(140px,1fr)_repeat(6,56px)] gap-x-3 py-2">
                  <span className="text-[10px] uppercase muted-50" style={{ letterSpacing: '0.08em' }}>Date</span>
                  <span className="text-[10px] uppercase muted-50" style={{ letterSpacing: '0.08em' }}>Batch</span>
                  {numHead('Sent')}
                  {numHead('Replied')}
                  {numHead('Yes')}
                  {numHead('No')}
                  {numHead('Maybe')}
                  {numHead('Yes %')}
                </div>
                {rows.map((r) => (
                  <div key={r.batch_id} className="row grid grid-cols-[72px_minmax(140px,1fr)_repeat(6,56px)] items-baseline gap-x-3 py-[9px]">
                    <span className="text-xs muted-60 tnum">
                      {new Date(r.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
                    </span>
                    <span className="truncate text-[13px]">
                      {r.venue ? <span className="muted-50">{r.venue} · </span> : ''}
                      {r.name}
                    </span>
                    <span className="text-right text-[13px] tnum">{r.sent}</span>
                    <span className="text-right text-[13px] tnum">{r.replied}</span>
                    <span className="text-right text-[13px] tnum">{r.yes}</span>
                    <span className="text-right text-[13px] tnum">{r.no}</span>
                    <span className="text-right text-[13px] tnum">{r.maybe}</span>
                    <span className="text-right text-[13px] font-semibold tnum">{pct(r.yes, r.sent)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
