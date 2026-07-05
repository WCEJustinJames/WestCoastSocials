import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

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

  return (
    <div className={`card mb-4 p-3 sm:p-4 ${held ? 'border-amber-300 bg-amber-50/50' : ''}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">📤 Queued to send</span>
        <span className="chip bg-slate-800 text-white">{totalWaiting} waiting</span>
        {batches.some((b) => b.sending) && <span className="chip animate-pulse bg-sky-100 text-sky-700">sending now…</span>}
        {totalFailed > 0 && <span className="chip bg-rose-100 text-rose-700">{totalFailed} failed</span>}
        <button onClick={() => void load()} className="ml-auto text-xs text-emerald-700 hover:underline">Refresh</button>
      </div>

      {held && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-100/70 px-2.5 py-1.5 text-xs text-amber-800">
          <span className="font-semibold">⏸ Held · {held.label}</span>
          <span className="text-amber-700">— {held.detail}</span>
        </div>
      )}

      <ul className="space-y-1.5">
        {batches.map((b) => {
          const isOpen = open[b.id]
          return (
            <li key={b.id} className="rounded-lg border border-slate-100 bg-white p-2">
              <button onClick={() => setOpen((o) => ({ ...o, [b.id]: !o[b.id] }))} className="flex w-full items-center gap-2 text-left">
                <span className="text-[10px] text-slate-400">{isOpen ? '▾' : '▸'}</span>
                <span className="text-sm font-medium">{b.name}</span>
                <span className="chip bg-slate-100 text-slate-500">{b.isOutreach ? 'outreach' : 'replies'}</span>
                <span className="ml-auto text-xs tabular-nums text-slate-500">
                  {b.sending ? `${b.sending} sending · ` : ''}{b.waiting} to go{b.failed ? ` · ${b.failed} failed` : ''}
                </span>
                {b.scheduledFor && new Date(b.scheduledFor) > now && (
                  <span className="chip bg-sky-50 text-sky-700">⏰ {new Date(b.scheduledFor).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
                )}
              </button>
              {isOpen && (
                <div className="mt-1.5 flex flex-wrap gap-1 pl-4">
                  {b.names.slice(0, 60).map((n, i) => (
                    <span key={i} className="chip bg-slate-50 text-slate-600 ring-1 ring-inset ring-slate-100">{n}</span>
                  ))}
                  {b.names.length > 60 && <span className="text-xs text-slate-400">+{b.names.length - 60} more</span>}
                </div>
              )}
            </li>
          )
        })}
        {drafts > 0 && (
          <li className="flex items-center gap-2 rounded-lg border border-slate-100 bg-white p-2 text-sm">
            <span className="font-medium">Approved 1:1 replies</span>
            <span className="ml-auto text-xs text-slate-500">{drafts} to go</span>
          </li>
        )}
      </ul>
    </div>
  )
}
