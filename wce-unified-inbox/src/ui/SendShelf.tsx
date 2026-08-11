import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { IconChevronRight } from './icons'

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
 * failed recipients pin to the top (accent + weight), in-flight pulse, queued
 * sit below, and each name fades + strikes through the moment it sends.
 * Disappears when done.
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
    <div
      className="fixed bottom-24 right-0 z-40 flex max-h-[70vh] w-60 flex-col overflow-hidden bg-paper dt:bottom-6"
      style={{ border: '2px solid var(--color-divider)', borderRight: 0 }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Collapse' : 'Expand to see each recipient'}
        className="row-hover shrink-0 px-3 py-2 text-left"
        style={{ borderBottom: open ? '1px solid var(--color-divider)' : undefined }}
      >
        <div className="flex items-center gap-1.5">
          <span className={`flex-none muted-45 transition-transform ${open ? 'rotate-90' : ''}`}>
            <IconChevronRight size={12} />
          </span>
          <span className="flex-1 truncate text-xs font-semibold">
            {sending ? 'Sending' : 'Queued'}: {batch.name}
          </span>
        </div>
        <div className="pl-4 text-[11px] muted tnum">
          {sent}/{items.length} sent{failed ? ` · ${failed} failed` : ''} · {sendTime}
        </div>
      </button>
      {open && (
        <ul className="overflow-y-auto px-3 py-1 text-sm">
          {items.map((i) => (
            <li
              key={i.id}
              className={`flex items-center gap-2 py-0.5 ${
                i.status === 'failed'
                  ? 'font-semibold'
                  : i.status === 'sent'
                    ? 'line-through muted-45'
                    : i.status === 'sending'
                      ? 'animate-pulse'
                      : ''
              }`}
              style={i.status === 'failed' ? { color: 'var(--color-accent-700)' } : undefined}
            >
              {/* Status reads off the square, as it does in the health strip:
                  accent = live or failed, neutral = queued, hollow = sent. */}
              <span
                className="sq-sm"
                title={i.status}
                style={{
                  background:
                    i.status === 'failed' || i.status === 'sending'
                      ? 'var(--color-accent)'
                      : i.status === 'sent'
                        ? 'transparent'
                        : 'var(--color-neutral-400)',
                  boxShadow: i.status === 'sent' ? 'inset 0 0 0 1px var(--color-neutral-400)' : undefined,
                }}
              />
              <span className="flex-1 truncate">{i.name}</span>
              {i.status === 'failed' && <span className="text-[10px] font-semibold">failed</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
