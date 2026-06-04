import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

type Conversation = Database['public']['Tables']['inbox_conversations']['Row'] & {
  inbox_people: { display_name: string | null } | null
}
type Message = Database['public']['Tables']['inbox_messages']['Row']

export function Inbox() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from('inbox_conversations')
      .select('*, inbox_people(display_name)')
      .order('last_activity', { ascending: false, nullsFirst: false })
      .then(({ data }) => {
        setConversations((data as unknown as Conversation[]) ?? [])
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    if (!activeId) return
    supabase
      .from('inbox_messages')
      .select('*')
      .eq('conversation_id', activeId)
      .order('timestamp', { ascending: true })
      .then(({ data }) => setMessages((data as Message[]) ?? []))
  }, [activeId])

  const active = conversations.find((c) => c.id === activeId) ?? null
  const nameOf = (c: Conversation) =>
    c.inbox_people?.display_name ?? c.title ?? c.external_chat_id

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900">
      <aside className="flex w-80 flex-col border-r border-slate-200 bg-white">
        <header className="border-b border-slate-200 px-4 py-3">
          <h1 className="font-semibold">WCE Unified Inbox</h1>
          <p className="text-xs text-slate-500">Inbound mirror · Beeper</p>
        </header>
        <div className="flex-1 overflow-y-auto">
          {loading && <p className="p-4 text-sm text-slate-400">Loading…</p>}
          {!loading && conversations.length === 0 && (
            <p className="p-4 text-sm text-slate-400">
              No conversations yet. Run <code className="rounded bg-slate-100 px-1">npm run sync</code> on
              the machine running Beeper Desktop.
            </p>
          )}
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveId(c.id)}
              className={`block w-full border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50 ${
                activeId === c.id ? 'bg-slate-100' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{nameOf(c)}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-400">
                  {c.network}
                </span>
              </div>
              {c.unread_count > 0 && (
                <span className="text-xs text-emerald-600">{c.unread_count} unread</span>
              )}
            </button>
          ))}
        </div>
      </aside>

      <main className="flex flex-1 flex-col">
        {active ? (
          <>
            <header className="border-b border-slate-200 bg-white px-6 py-3">
              <h2 className="font-medium">{nameOf(active)}</h2>
              <p className="text-xs text-slate-500">
                {active.network} · {active.type}
              </p>
            </header>
            <div className="flex-1 space-y-2 overflow-y-auto p-6">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`max-w-lg rounded-2xl px-4 py-2 text-sm ${
                    m.direction === 'outbound'
                      ? 'ml-auto bg-emerald-600 text-white'
                      : 'border border-slate-200 bg-white'
                  }`}
                >
                  <div className="whitespace-pre-wrap">{m.text}</div>
                  <div
                    className={`mt-1 text-[10px] ${
                      m.direction === 'outbound' ? 'text-emerald-100' : 'text-slate-400'
                    }`}
                  >
                    {new Date(m.timestamp).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
            <footer className="border-t border-slate-200 bg-white px-6 py-3 text-xs text-slate-400">
              Phase A (drafting &amp; approve-to-send) lands next. This view is the read-only inbound mirror.
            </footer>
          </>
        ) : (
          <div className="grid flex-1 place-items-center text-slate-400">
            Select a conversation
          </div>
        )}
      </main>
    </div>
  )
}
