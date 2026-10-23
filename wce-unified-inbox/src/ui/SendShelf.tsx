import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface Item {
  id: string
  status: string
  name: string
}

// Sort order in the shelf: failures jump to the top so they're never missed,
// then in-flight, then still-queued, then the sent ones fade to the bottom.
const ORDER: Record<string, number> = {
  failed: 0,
  sending: 1,
  approved: 2,
  pending: 2,
  skipped: 3,
  sent: 4,
}

/**
 * Live send shelf — a slim panel pinned to the right that appears only while a
 * batch is approved/sending. It polls the batch's items every couple of seconds:
 * failed recipients pin to the top (red), in-flight pulse, queued sit below, and
 * each name fades + strikes through the moment it sends. Disappears when done.
 */
export function SendShelf() {
  const [batch, setBatch] = useState<{ name: string; status: string; scheduledFor: string | null } | null>(null)
  const [items, setItems] = useState<Item[]>([])
  // Collapsed by default (just the batch + send time); auto-expands the moment
  // sending starts so you can watch it fly, and a click toggles it any time.
  const [open, setOpen] = useState(false)

  async function load() {
    const { data: b } = await supabase
      .from('inbox_batches')
      .select('id, name, status, scheduled_for')
      .in('status', ['approved', 'sending'] as const)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!b) {
      setBatch(null)
      setItems([])
      return
    }
    setBatch({
      name: b.name ?? 'batch',
      status: b.status,
      scheduledFor: (b as { scheduled_for?: string | null }).scheduled_for ?? null,
    })
    const { data: its } = await supabase
      .from('inbox_batch_items')
      .select('id, status, data')
      .eq('batch_id', b.id)
    const list: Item[] = (its ?? []).map((it) => ({
      id: it.id,
      status: it.status,
      name: ((it.data as { name?: string } | null)?.name ?? '—').trim() || '—',
    }))
    list.sort((a, b) => (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5) || a.name.localeCompare(b.name))
    setItems(list)
  }
  useEffect(() => {
    void load()
    const t = setInterval(load, 2500)
    return () => clearInterval(t)
  }, [])

  const sending = batch?.status === 'sending' || items.some((i) => i.status === 'sending')
  // Pop the list open the moment a send goes live (you can still collapse it).
  useEffect(() => {
    if (sending) setOpen(true)
  }, [sending])

  if (!batch || items.length === 0) return null
  const sent = items.filter((i) => i.status === 'sent').length
  const failed = items.filter((i) => i.status === 'failed').length
  const sendTime = sending
    ? 'sending now…'
    : batch.scheduledFor && new Date(batch.scheduledFor) > new Date()
      ? `sends ${new Date(batch.scheduledFor).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
      : 'queued'

  return (
    <div className="fixed right-0 top-12 z-40 flex max-h-[80vh] w-56 flex-col overflow-hidden rounded-l-lg border border-slate-200 bg-white/95 shadow-lg backdrop-blur">
      <button
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Collapse' : 'Expand to see each recipient'}
        className="shrink-0 border-b border-slate-100 px-3 py-2 text-left hover:bg-slate-50"
      >
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-slate-400">{open ? '▾' : '▸'}</span>
          <span className="flex-1 truncate text-xs font-semibold text-slate-700">
            {sending ? 'Sending' : 'Queued'}: {batch.name}
          </span>
        </div>
        <div className="pl-3.5 text-[11px] text-slate-500">
          {sent}/{items.length} sent{failed ? ` · ${failed} failed` : ''} · {sendTime}
        </div>
      </button>
      {open && (
      <ul className="overflow-y-auto px-2 py-1 text-sm">
        {items.map((i) => (
          <li
            key={i.id}
            className={`flex items-center gap-2 rounded px-2 py-0.5 ${
              i.status === 'failed'
                ? 'bg-rose-50 font-medium text-rose-700'
                : i.status === 'sent'
                  ? 'text-slate-300 line-through'
                  : i.status === 'sending'
                    ? 'animate-pulse text-sky-700'
                    : 'text-slate-700'
            }`}
          >
            <span className="w-3 text-center text-[10px]">
              {i.status === 'failed' ? '✗' : i.status === 'sent' ? '✓' : i.status === 'sending' ? '➤' : '·'}
            </span>
            <span className="flex-1 truncate">{i.name}</span>
          </li>
        ))}
      </ul>
      )}
    </div>
  )
}
