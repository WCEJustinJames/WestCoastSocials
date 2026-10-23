import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'
import { IconChevronRight } from './icons'
import { useInboxSettings } from './useInboxSettings'
import { ReplyQueue } from './ReplyQueue'

type BatchRow = {
  id: string
  name: string | null
  status: string
  created_at: string
  scheduled_for: string | null
}
type ItemRow = Pick<
  Database['public']['Tables']['inbox_batch_items']['Row'],
  'id' | 'batch_id' | 'rendered_text' | 'status' | 'guard_flag' | 'guard_reason' | 'data'
>

// Lists worth showing: ones you're still building (draft), queued/part-sent
// (approved/sending), and recently finished (sent) so you can confirm delivery.
const SHOWN = ['draft', 'approved', 'sending', 'sent'] as const

// One accent, no traffic lights: sent earns the accent tint, queued states
// stay neutral, and failure is accent + weight in the tallies/badges below.
const BATCH_TAG: Record<string, string> = {
  draft: 'tag tag-neutral',
  approved: 'tag tag-outline',
  sending: 'tag tag-neutral',
  sent: 'tag tag-accent',
}

// Per-recipient send result. 'sent' = the text/Messenger send succeeded.
const ITEM_BADGE: Record<string, { cls: string; label: string }> = {
  sent: { cls: 'tag tag-accent', label: 'sent' },
  failed: { cls: '', label: 'failed' }, // rendered as accent + weight, not a tag
  sending: { cls: 'tag tag-neutral', label: 'sending' },
  skipped: { cls: 'tag tag-neutral', label: 'skipped' },
  approved: { cls: 'tag tag-neutral', label: 'queued' },
  pending: { cls: 'tag tag-neutral', label: 'draft' },
}

/**
 * Drafted + sent lists. Build a list and it's saved here the moment you Build
 * preview: come back to pull a player out (even after it's approved/queued),
 * approve it, or cancel it. Sent lists stay here too, with a per-recipient
 * sent / failed indicator so you can confirm every message actually went.
 */
export function Drafts() {
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [items, setItems] = useState<ItemRow[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [include, setInclude] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const { settings: rail, loaded: railLoaded } = useInboxSettings()

  async function load() {
    const { data: bs } = await supabase
      .from('inbox_batches')
      .select('id, name, status, created_at, scheduled_for')
      .in('status', SHOWN)
      .order('created_at', { ascending: false })
      .limit(100)
    const rows = (bs as BatchRow[]) ?? []
    setBatches(rows)
    if (rows.length) {
      const { data: its } = await supabase
        .from('inbox_batch_items')
        .select('id, batch_id, rendered_text, status, guard_flag, guard_reason, data')
        .in(
          'batch_id',
          rows.map((b) => b.id),
        )
        .order('status', { ascending: true })
      const list = (its as ItemRow[]) ?? []
      setItems(list)
      setInclude(Object.fromEntries(list.map((it) => [it.id, !it.guard_flag])))
    } else {
      setItems([])
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const itemsOf = (batchId: string) => items.filter((it) => it.batch_id === batchId)

  // Per-batch tally for the header: how many sent / failed / still to go.
  function summary(batchId: string) {
    const mine = itemsOf(batchId)
    const c = (s: string) => mine.filter((it) => it.status === s).length
    return {
      total: mine.length,
      sent: c('sent'),
      failed: c('failed'),
      queued: c('pending') + c('approved') + c('sending'),
      skipped: c('skipped'),
    }
  }

  function nameOf(it: ItemRow): string {
    const d = it.data as { name?: string } | null
    return d?.name?.trim() || it.rendered_text.slice(0, 40) || '—'
  }

  async function removeItem(it: ItemRow) {
    if (!window.confirm(`Remove ${nameOf(it)} from this list?`)) return
    setItems((p) => p.filter((x) => x.id !== it.id))
    await supabase.from('inbox_batch_items').delete().eq('id', it.id)
  }

  async function approve(b: BatchRow) {
    const mine = items.filter((it) => it.batch_id === b.id && it.status === 'pending')
    const inc = mine.filter((it) => include[it.id]).map((it) => it.id)
    const exc = mine.filter((it) => !include[it.id]).map((it) => it.id)
    if (inc.length === 0) {
      setStatus('Tick at least one player to send.')
      setTimeout(() => setStatus(null), 4000)
      return
    }
    if (
      !window.confirm(
        `Approve ${inc.length} player(s)? They send on the next sync — subject to the STOP switch and the send guardrails.`,
      )
    )
      return
    setBusy(true)
    if (inc.length) await supabase.from('inbox_batch_items').update({ status: 'approved' }).in('id', inc)
    if (exc.length) await supabase.from('inbox_batch_items').update({ status: 'skipped' }).in('id', exc)
    await supabase.from('inbox_batches').update({ status: 'approved' }).eq('id', b.id)
    setBusy(false)
    setOpenId(null)
    setStatus(`Approved — ${inc.length} will send on the next sync.`)
    await load()
    setTimeout(() => setStatus(null), 6000)
  }

  async function cancel(b: BatchRow) {
    if (!window.confirm(`Cancel "${b.name ?? 'this list'}"? Anything not already sent won't send.`)) return
    setBusy(true)
    await supabase
      .from('inbox_batch_items')
      .update({ status: 'skipped' })
      .eq('batch_id', b.id)
      .in('status', ['pending', 'approved', 'sending'])
    await supabase.from('inbox_batches').update({ status: 'canceled' }).eq('id', b.id)
    setBusy(false)
    setOpenId(null)
    await load()
  }

  return (
    <div className="max-w-[760px]">
      {/* The approval queue proper: every AI reply waiting on you, across all
          threads. Batch lists follow below — a different kind of draft. */}
      <ReplyQueue />

      <div className="section-head">
        <span className="kicker">Lists — drafted &amp; sent</span>
        <button onClick={() => void load()} className="btn btn-ghost !text-xs">
          Refresh
        </button>
      </div>
      <p className="mb-3 mt-3 max-w-[62ch] text-xs muted">
        Lists you've built — drafts to finish, queued lists to review, and sent lists with a
        per-player sent / failed result so you can confirm every message went. Approving still
        respects the STOP switch and every send guardrail.
      </p>
      {status && (
        <p className="mb-3 text-sm font-semibold" style={{ color: 'var(--color-accent-700)' }}>
          {status}
        </p>
      )}

      <div style={{ borderTop: '2px solid var(--color-divider)' }}>
        {batches.length === 0 && (
          <p className="m-0 py-4 text-sm muted">
            No drafted, queued or recently-sent lists. Build one in the Batches tab and it'll show here.
          </p>
        )}

        {batches.map((b) => {
          const s = summary(b.id)
          const open = openId === b.id
          const editable = b.status === 'draft' || b.status === 'approved' || b.status === 'sending'
          return (
            <div key={b.id} className="row py-4">
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  onClick={() => setOpenId(open ? null : b.id)}
                  aria-expanded={open}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-sm font-semibold"
                >
                  <span className={`flex-none transition-transform ${open ? 'rotate-90' : ''}`}>
                    <IconChevronRight size={14} />
                  </span>
                  <span className="truncate">{b.name || '(unnamed list)'}</span>
                </button>
                <span className={BATCH_TAG[b.status] ?? 'tag tag-neutral'}>{b.status}</span>
                {/* sent / failed / queued tally */}
                <span className="text-xs muted tnum">
                  {s.sent > 0 && <span style={{ color: 'var(--color-accent-700)' }}>{s.sent} sent</span>}
                  {s.sent > 0 && (s.failed > 0 || s.queued > 0) && ' · '}
                  {s.failed > 0 && (
                    <span className="font-semibold" style={{ color: 'var(--color-accent-700)' }}>
                      {s.failed} failed
                    </span>
                  )}
                  {s.failed > 0 && s.queued > 0 && ' · '}
                  {s.queued > 0 && <span>{s.queued} to go</span>}
                </span>
                <span className="text-[11px] muted-45 tnum">{new Date(b.created_at).toLocaleDateString()}</span>
                {b.scheduled_for && (
                  <span className="tag tag-neutral tnum">
                    Scheduled {new Date(b.scheduled_for).toLocaleString()}
                  </span>
                )}
                {b.status === 'draft' && (
                  <button onClick={() => void approve(b)} disabled={busy} className="btn btn-primary !text-xs">
                    Approve &amp; send
                  </button>
                )}
                {editable && (
                  <button onClick={() => void cancel(b)} disabled={busy} className="btn-quiet">
                    Cancel list
                  </button>
                )}
              </div>

              {open && (
                <div className="mt-2.5">
                  {itemsOf(b.id).length === 0 && (
                    <p className="m-0 py-1 text-xs muted">No players in this list.</p>
                  )}
                  {itemsOf(b.id).map((it) => {
                    const badge = ITEM_BADGE[it.status] ?? ITEM_BADGE.pending
                    const canRemove = editable && it.status !== 'sent' && it.status !== 'sending'
                    const canInclude = b.status === 'draft' && it.status === 'pending'
                    return (
                      <div key={it.id} className="flex items-start gap-2.5 py-2">
                        {canInclude && (
                          <input
                            type="checkbox"
                            className="checkbox mt-1"
                            checked={include[it.id] ?? false}
                            onChange={() => setInclude((p) => ({ ...p, [it.id]: !p[it.id] }))}
                            title="Include in the send"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold">{nameOf(it)}</span>
                            {it.status === 'failed' ? (
                              <span
                                className="text-[11px] font-semibold"
                                style={{ color: 'var(--color-accent-700)' }}
                              >
                                failed
                              </span>
                            ) : (
                              <span className={badge.cls}>{badge.label}</span>
                            )}
                            {it.guard_flag && it.status !== 'sent' && (
                              <span
                                className="text-[11px] font-semibold"
                                style={{ color: 'var(--color-accent-700)' }}
                              >
                                {it.guard_reason ?? 'guarded'}
                              </span>
                            )}
                            {canRemove && (
                              <button
                                onClick={() => void removeItem(it)}
                                title="Remove from this list"
                                className="btn-quiet ml-auto"
                              >
                                Remove
                              </button>
                            )}
                          </div>
                          <p
                            className="m-0 mt-2 max-w-[62ch] whitespace-pre-wrap bg-surface text-sm leading-[1.5]"
                            style={{ borderLeft: '3px solid var(--color-accent)', padding: '8px 12px' }}
                          >
                            {it.rendered_text}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {railLoaded && (
        <p className="mt-3 text-xs muted">
          {rail.sendsPaused
            ? 'All sends are stopped — approved lists will not go out until the STOP switch is released.'
            : rail.repliesPaused
              ? 'Auto-reply is paused — no new drafts are being generated.'
              : 'New lists land here the moment you build a preview — approve from anywhere.'}
        </p>
      )}
    </div>
  )
}
