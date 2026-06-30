import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

/** Beeper stores rich text (HTML); flatten to a short plain-text snippet. */
function snippet(raw: string | null, n = 90): string {
  if (!raw) return ''
  const t = raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

interface NeedsYou {
  id: string
  conversation_id: string
  sender_name: string | null
  text: string | null
}
interface Unread {
  id: string
  title: string | null
  network: string
  unread_count: number
}

/**
 * Home action queue — everything needing Justin himself, at the top of Home and
 * hidden when empty. Two sources: replies the classifier flagged as "needs you"
 * (reply_intent='other'), and unread Beeper threads. Each item opens the thread or
 * is marked done; "done" is durable (action_resolved on the message,
 * context_resolved_at on the conversation) so it stays cleared across devices.
 * (Email is a planned third source — see NEXT-SESSION notes; needs a Gmail source.)
 */
export function ActionQueue({ onOpen }: { onOpen: (conversationId: string) => void }) {
  const [needsYou, setNeedsYou] = useState<NeedsYou[]>([])
  const [unread, setUnread] = useState<Unread[]>([])
  const [busy, setBusy] = useState(false)

  async function load() {
    const { data: ny } = await supabase
      .from('inbox_messages')
      .select('id, conversation_id, sender_name, text')
      .eq('reply_intent', 'other')
      .eq('action_resolved', false)
      .order('timestamp', { ascending: false })
      .limit(40)
    setNeedsYou((ny as NeedsYou[]) ?? [])

    const { data: ur } = await supabase
      .from('inbox_conversations')
      .select('id, title, network, unread_count, last_activity, context_resolved_at')
      .gt('unread_count', 0)
      .eq('hidden', false)
      .order('last_activity', { ascending: false })
      .limit(40)
    const rows = (ur as (Unread & { last_activity: string | null; context_resolved_at: string | null })[]) ?? []
    // "Done" on a thread sets context_resolved_at; it reappears only if newer activity lands.
    setUnread(rows.filter((c) => !c.context_resolved_at || (c.last_activity ?? '') > c.context_resolved_at))
  }
  useEffect(() => { void load() }, [])

  async function resolveReply(id: string) {
    setBusy(true)
    await supabase.from('inbox_messages').update({ action_resolved: true }).eq('id', id)
    setNeedsYou((prev) => prev.filter((m) => m.id !== id))
    setBusy(false)
  }
  async function resolveThread(id: string) {
    setBusy(true)
    await supabase.from('inbox_conversations').update({ context_resolved_at: new Date().toISOString() }).eq('id', id)
    setUnread((prev) => prev.filter((c) => c.id !== id))
    setBusy(false)
  }

  const total = needsYou.length + unread.length
  if (total === 0) return null // auto-hide when the queue is empty

  return (
    <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-rose-800">Needs you · {total}</h3>
        <button onClick={() => void load()} className="text-xs text-rose-700 hover:underline">Refresh</button>
      </div>

      {needsYou.length > 0 && (
        <ul className="mb-2 space-y-1">
          {needsYou.map((m) => (
            <li key={m.id} className="flex items-center gap-2 rounded border border-rose-100 bg-white p-1.5 text-sm">
              <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] text-rose-700">reply</span>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{m.sender_name ?? 'Someone'}</span>
                {m.text ? <span className="text-slate-500"> — {snippet(m.text)}</span> : null}
              </span>
              <button onClick={() => onOpen(m.conversation_id)} className="rounded-md bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-emerald-700">open</button>
              <button onClick={() => void resolveReply(m.id)} disabled={busy} className="text-xs text-slate-400 hover:text-rose-600">done</button>
            </li>
          ))}
        </ul>
      )}

      {unread.length > 0 && (
        <ul className="space-y-1">
          {unread.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded border border-rose-100 bg-white p-1.5 text-sm">
              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">{c.unread_count} unread</span>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{c.title ?? 'Conversation'}</span>
                <span className="text-[11px] text-slate-400"> · {c.network}</span>
              </span>
              <button onClick={() => onOpen(c.id)} className="rounded-md bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-emerald-700">open</button>
              <button onClick={() => void resolveThread(c.id)} disabled={busy} className="text-xs text-slate-400 hover:text-rose-600">done</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
