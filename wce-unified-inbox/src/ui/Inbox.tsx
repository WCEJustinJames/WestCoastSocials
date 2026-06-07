import { useEffect, useMemo, useState } from 'react'
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

  // search + filter state
  const [query, setQuery] = useState('')
  const [network, setNetwork] = useState<string>('all')
  const [unreadOnly, setUnreadOnly] = useState(false)
  // conversation IDs whose messages match a content search (null = not searching content)
  const [contentMatches, setContentMatches] = useState<Set<string> | null>(null)

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

  // Debounced message-content search: when the query is 2+ chars, also find
  // conversations whose *message text* matches (not just the contact name).
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setContentMatches(null)
      return
    }
    const handle = setTimeout(() => {
      supabase
        .from('inbox_messages')
        .select('conversation_id')
        .ilike('text', `%${q}%`)
        .limit(2000)
        .then(({ data }) => {
          setContentMatches(
            new Set((data ?? []).map((r) => r.conversation_id as string)),
          )
        })
    }, 250)
    return () => clearTimeout(handle)
  }, [query])

  const nameOf = (c: Conversation) =>
    c.inbox_people?.display_name ?? c.title ?? c.external_chat_id

  const networks = useMemo(
    () => Array.from(new Set(conversations.map((c) => c.network))).sort(),
    [conversations],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return conversations.filter((c) => {
      if (network !== 'all' && c.network !== network) return false
      if (unreadOnly && c.unread_count <= 0) return false
      if (q) {
        const nameHit = nameOf(c).toLowerCase().includes(q)
        const contentHit = contentMatches?.has(c.id) ?? false
        if (!nameHit && !contentHit) return false
      }
      return true
    })
  }, [conversations, query, network, unreadOnly, contentMatches])

  const active = conversations.find((c) => c.id === activeId) ?? null

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900">
      <aside className="flex w-80 flex-col border-r border-slate-200 bg-white">
        <header className="border-b border-slate-200 px-4 py-3">
          <h1 className="font-semibold">WCE Unified Inbox</h1>
          <p className="text-xs text-slate-500">Inbound mirror · Beeper</p>
        </header>

        {/* Search + filters */}
        <div className="space-y-2 border-b border-slate-200 px-3 py-3">
          <div className="relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or message…"
              className="w-full rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 focus:bg-white"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-1">
            <FilterChip active={network === 'all'} onClick={() => setNetwork('all')}>
              All
            </FilterChip>
            {networks.map((n) => (
              <FilterChip key={n} active={network === n} onClick={() => setNetwork(n)}>
                {n}
              </FilterChip>
            ))}
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => setUnreadOnly(e.target.checked)}
              className="accent-emerald-600"
            />
            Unread only
          </label>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && <p className="p-4 text-sm text-slate-400">Loading…</p>}
          {!loading && filtered.length === 0 && (
            <p className="p-4 text-sm text-slate-400">No conversations match.</p>
          )}
          {filtered.map((c) => (
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

        <div className="border-t border-slate-200 px-4 py-2 text-[11px] text-slate-400">
          {filtered.length} of {conversations.length} conversations
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
                  <div className="whitespace-pre-wrap">{highlight(m.text, query)}</div>
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

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-2.5 py-0.5 text-xs ${
        active
          ? 'bg-emerald-600 text-white'
          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
      }`}
    >
      {children}
    </button>
  )
}

// Highlight the search term inside a message body.
function highlight(text: string | null, query: string) {
  if (!text) return null
  const q = query.trim()
  if (q.length < 2) return text
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-yellow-200 px-0.5">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  )
}
