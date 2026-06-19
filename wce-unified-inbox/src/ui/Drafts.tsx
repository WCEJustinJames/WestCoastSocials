import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

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

// "Active" = not yet finished: a draft you're still building, or one approved /
// part-sent that you might still want to pull a player from or cancel.
const ACTIVE = ['draft', 'approved', 'sending'] as const

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-slate-200 text-slate-700',
  approved: 'bg-emerald-100 text-emerald-700',
  sending: 'bg-sky-100 text-sky-700',
}

/**
 * Drafted-lists tab. Every list you build is saved as a draft batch the moment
 * you Build preview, so this is where you come back to one: open it, pull a
 * player out (even after it's approved/queued), then approve it or bin it.
 */
export function Drafts() {
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [items, setItems] = useState<ItemRow[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [include, setInclude] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  async function load() {
    const { data: bs } = await supabase
      .from('inbox_batches')
      .select('id, name, status, created_at, scheduled_for')
      .in('status', ACTIVE)
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
        .order('guard_flag', { ascending: true })
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

  const liveItems = (batchId: string) =>
    items.filter(
      (it) => it.batch_id === batchId && (it.status === 'pending' || it.status === 'approved' || it.status === 'sending'),
    )

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
    setStatus(`Approved ✓ — ${inc.length} will send on the next sync.`)
    await load()
    setTimeout(() => setStatus(null), 6000)
  }

  async function cancel(b: BatchRow) {
    if (!window.confirm(`Cancel "${b.name ?? 'this list'}"? Nothing in it will send.`)) return
    setBusy(true)
    await supabase.from('inbox_batches').update({ status: 'canceled' }).eq('id', b.id)
    setBusy(false)
    setOpenId(null)
    await load()
  }

  return (
    <div className="mx-auto h-full w-full max-w-3xl overflow-y-auto p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Drafted lists</h2>
        <button onClick={() => void load()} className="text-sm text-emerald-700 hover:underline">
          Refresh
        </button>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Lists you've built but not finished. Open one to pull a player out, then approve it to send
        or cancel it. Approving still respects the STOP switch and every send guardrail.
      </p>
      {status && <p className="mb-3 text-sm text-emerald-700">{status}</p>}

      {batches.length === 0 && (
        <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-400">
          No drafted or queued lists. Build one in the Batches tab and it'll show here.
        </p>
      )}

      <ul className="space-y-2">
        {batches.map((b) => {
          const live = liveItems(b.id)
          const open = openId === b.id
          return (
            <li key={b.id} className="rounded-lg border border-slate-200 bg-white">
              <div className="flex flex-wrap items-center gap-2 p-3">
                <button
                  onClick={() => setOpenId(open ? null : b.id)}
                  className="flex-1 text-left text-sm font-medium hover:underline"
                >
                  {open ? '▾' : '▸'} {b.name || '(unnamed list)'}
                </button>
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_STYLE[b.status] ?? 'bg-slate-100 text-slate-600'}`}>
                  {b.status}
                </span>
                <span className="text-xs text-slate-400">{live.length} player(s)</span>
                <span className="text-xs text-slate-400">{new Date(b.created_at).toLocaleDateString()}</span>
                {b.scheduled_for && (
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] text-violet-700">
                    ⏱ {new Date(b.scheduled_for).toLocaleString()}
                  </span>
                )}
                {b.status === 'draft' && (
                  <button
                    onClick={() => void approve(b)}
                    disabled={busy}
                    className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                  >
                    Approve &amp; send
                  </button>
                )}
                <button
                  onClick={() => void cancel(b)}
                  disabled={busy}
                  className="rounded-md border border-slate-300 px-3 py-1 text-xs hover:bg-rose-50 hover:text-rose-700 disabled:opacity-40"
                >
                  Cancel list
                </button>
              </div>

              {open && (
                <ul className="space-y-1 border-t border-slate-100 p-3">
                  {live.length === 0 && (
                    <li className="text-xs text-slate-400">No players left in this list.</li>
                  )}
                  {live.map((it) => (
                    <li key={it.id} className="flex items-start gap-2 rounded-md border border-slate-100 bg-slate-50/60 p-2">
                      {b.status === 'draft' && (
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={include[it.id] ?? false}
                          onChange={() => setInclude((p) => ({ ...p, [it.id]: !p[it.id] }))}
                          title="Include in the send"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{nameOf(it)}</span>
                          {it.guard_flag && (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-700">
                              ⚠ {it.guard_reason}
                            </span>
                          )}
                        </div>
                        <p className="truncate text-xs text-slate-500">{it.rendered_text}</p>
                      </div>
                      <button
                        onClick={() => void removeItem(it)}
                        title="Remove from this list"
                        className="text-xs text-slate-300 hover:text-rose-600"
                      >
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
