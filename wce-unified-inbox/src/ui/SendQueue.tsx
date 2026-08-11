import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { IconChevronRight } from './icons'

interface QueuedBatch {
  id: string
  name: string
  status: string
  scheduledFor: string | null
  isOutreach: boolean
  waiting: number // items not yet sent/failed/skipped
  sending: number
  failed: number
  names: string[]
}

// Quiet hours + outreach window mirror the sync defaults (env.ts). Used only to
// EXPLAIN why a queue is held — the sync is the source of truth on actual gating.
const QUIET_START = 21, QUIET_END = 9
const OUT_START = 10 * 60, OUT_END = 17 * 60 + 15

// Queue row: desktop [name | meta | figures]; phone stacks the meta under a
// [name | figures] top line via grid areas. The rule lives on the <li> so an
// expanded name list sits inside the same row.
const ROW_GRID =
  "row-hover grid grid-cols-[minmax(0,1fr)_max-content] items-baseline gap-x-4 gap-y-1 py-3 [grid-template-areas:'name_figs'_'meta_meta'] dt:grid-cols-[minmax(0,1fr)_minmax(0,220px)_max-content] dt:[grid-template-areas:'name_meta_figs']"

/**
 * Send queue — a persistent Home panel of everything APPROVED/PENDING to go out,
 * always in place (not just during a live send). When STOP is on, it's quiet
 * hours, or outside the outreach window, it shows the held reason and when the
 * queue will release — so nothing waiting to send is ever a surprise.
 */
export function SendQueue() {
  const [batches, setBatches] = useState<QueuedBatch[]>([])
  const [drafts, setDrafts] = useState(0)
  const [paused, setPaused] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  async function load() {
    const { data: bs } = await supabase
      .from('inbox_batches')
      .select('id, name, status, scheduled_for, is_outreach')
      .in('status', ['approved', 'sending'] as const)
      .order('created_at', { ascending: false })
      .limit(20)
    const rows = (bs as { id: string; name: string | null; status: string; scheduled_for: string | null; is_outreach: boolean }[]) ?? []
    const out: QueuedBatch[] = []
    for (const b of rows) {
      const { data: its } = await supabase
        .from('inbox_batch_items')
        .select('status, data')
        .eq('batch_id', b.id)
      const items = (its ?? []) as { status: string; data: { name?: string } | null }[]
      const waitingItems = items.filter((i) => !['sent', 'failed', 'skipped'].includes(i.status))
      if (waitingItems.length === 0 && !items.some((i) => i.status === 'sending')) continue
      out.push({
        id: b.id,
        name: b.name ?? 'batch',
        status: b.status,
        scheduledFor: b.scheduled_for,
        isOutreach: b.is_outreach,
        waiting: waitingItems.length,
        sending: items.filter((i) => i.status === 'sending').length,
        failed: items.filter((i) => i.status === 'failed').length,
        names: waitingItems.map((i) => (i.data?.name ?? '—').trim() || '—'),
      })
    }
    setBatches(out)

    const { count } = await supabase
      .from('inbox_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'approved')
    setDrafts(count ?? 0)

    const s = supabase as unknown as {
      from: (t: string) => { select: (c: string) => { eq: (col: string, v: number) => { maybeSingle: () => Promise<{ data: { sends_paused?: boolean } | null }> } } }
    }
    const { data: st } = await s.from('inbox_settings').select('sends_paused').eq('id', 1).maybeSingle()
    setPaused(st?.sends_paused ?? false)
  }
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 10_000)
    return () => clearInterval(t)
  }, [])

  const totalWaiting = batches.reduce((n, b) => n + b.waiting, 0) + drafts
  if (totalWaiting === 0 && !batches.some((b) => b.sending)) return null

  // Why is the queue held right now?
  const now = new Date()
  const h = now.getHours(), mins = h * 60 + now.getMinutes()
  const inQuiet = QUIET_START > QUIET_END ? (h >= QUIET_START || h < QUIET_END) : (h >= QUIET_START && h < QUIET_END)
  const outreachClosed = mins < OUT_START || mins >= OUT_END
  const anyOutreach = batches.some((b) => b.isOutreach && b.waiting > 0)
  const held =
    paused ? { label: 'STOP is ON', detail: 'all outbound held — flip the STOP switch to release' }
    : inQuiet ? { label: 'Quiet hours', detail: 'holds until 9am (replies still answered)' }
    : anyOutreach && outreachClosed ? { label: 'Outside the outreach window', detail: 'invite batches wait for 10:00–17:15' }
    : null

  const totalFailed = batches.reduce((n, b) => n + b.failed, 0)
  const anySending = batches.some((b) => b.sending)

  return (
    <section className="mb-7">
      <div className="section-head">
        <span className="kicker tnum">Queued to send · {totalWaiting}</span>
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {anySending && <span className="tag tag-accent tag-net">sending now</span>}
          {totalFailed > 0 && <span className="tag tag-accent tag-net tnum">{totalFailed} failed</span>}
          <button onClick={() => void load()} className="btn btn-ghost !text-xs">Refresh</button>
        </span>
      </div>

      {/* Why the queue is held right now — STOP is an alarm, the windows are
          scheduled behaviour, so they get the alarm and the quiet treatment. */}
      {held && (paused ? (
        <div className="mt-3 flex items-start gap-2.5 text-[13px] font-extrabold" style={{ color: 'var(--color-accent-700)' }}>
          <span className="sq mt-1.5" style={{ background: 'var(--color-accent)' }} />
          <span>Held · {held.label} — {held.detail}</span>
        </div>
      ) : (
        <p className="m-0 mt-3 text-xs muted tnum">Held · {held.label} — {held.detail}</p>
      ))}

      <ul className="m-0 mt-1 list-none p-0">
        {batches.map((b) => {
          const isOpen = open[b.id]
          return (
            <li key={b.id} className="row">
              <div className={ROW_GRID}>
                <span className="flex min-w-0 flex-wrap items-baseline gap-2 [grid-area:name]">
                  <span className="min-w-0 truncate text-sm font-semibold">{b.name}</span>
                  <span className="tag tag-neutral tag-net">{b.isOutreach ? 'outreach' : 'replies'}</span>
                  {b.sending > 0 && <span className="tag tag-accent tag-net tnum">{b.sending} sending</span>}
                  {b.failed > 0 && <span className="tag tag-accent tag-net tnum">{b.failed} failed</span>}
                </span>
                <span className="min-w-0 truncate text-xs muted tnum [grid-area:meta]">
                  {b.scheduledFor && new Date(b.scheduledFor) > now
                    ? `scheduled ${new Date(b.scheduledFor).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
                    : ''}
                </span>
                <span className="flex items-baseline gap-2.5 [grid-area:figs]">
                  <span className="text-[15px] font-extrabold tnum">{b.waiting}</span>
                  <span className="text-xs muted">to go</span>
                  <button
                    onClick={() => setOpen((o) => ({ ...o, [b.id]: !o[b.id] }))}
                    aria-expanded={!!isOpen}
                    className="btn-quiet inline-flex items-center gap-1"
                  >
                    <span className={`flex-none transition-transform ${isOpen ? 'rotate-90' : ''}`}>
                      <IconChevronRight size={13} />
                    </span>
                    {isOpen ? 'Hide' : 'Names'}
                  </button>
                </span>
              </div>
              {isOpen && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 pb-3 text-[13px]">
                  {b.names.slice(0, 60).map((n, i) => (
                    <span key={i}>{n}</span>
                  ))}
                  {b.names.length > 60 && <span className="muted-45 tnum">+{b.names.length - 60} more</span>}
                </div>
              )}
            </li>
          )
        })}
        {drafts > 0 && (
          <li className={`row ${ROW_GRID}`}>
            <span className="min-w-0 truncate text-sm font-semibold [grid-area:name]">Approved 1:1 replies</span>
            <span className="text-xs muted [grid-area:meta]" />
            <span className="flex items-baseline gap-2.5 [grid-area:figs]">
              <span className="text-[15px] font-extrabold tnum">{drafts}</span>
              <span className="text-xs muted">to go</span>
            </span>
          </li>
        )}
      </ul>
    </section>
  )
}
