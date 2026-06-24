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
  const [batchName, setBatchName] = useState<string | null>(null)
  const [items, setItems] = useState<Item[]>([])

  async function load() {
    const { data: batch } = await supabase
      .from('inbox_batches')
      .select('id, name')
      .in('status', ['approved', 'sending'] as const)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!batch) {
      setBatchName(null)
      setItems([])
      return
    }
    setBatchName(batch.name ?? 'batch')
    const { data: its } = await supabase
      .from('inbox_batch_items')
      .select('id, status, data')
      .eq('batch_id', batch.id)
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

  if (!batchName || items.length === 0) return null
  const sent = items.filter((i) => i.status === 'sent').length
  const failed = items.filter((i) => i.status === 'failed').length

  return (
    <div className="fixed right-0 top-12 z-40 flex max-h-[80vh] w-56 flex-col overflow-hidden rounded-l-lg border border-slate-200 bg-white/95 shadow-lg backdrop-blur">
      <div className="shrink-0 border-b border-slate-100 px-3 py-2">
        <div className="truncate text-xs font-semibold text-slate-700">Sending: {batchName}</div>
        <div className="text-[11px] text-slate-500">
          {sent}/{items.length} sent{failed ? ` · ${failed} failed` : ''}
        </div>
      </div>
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
    </div>
  )
}
