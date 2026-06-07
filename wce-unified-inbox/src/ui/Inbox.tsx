import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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

  // reply composer
  const [replyText, setReplyText] = useState('')
  const [replyStatus, setReplyStatus] = useState<string | null>(null)

  // scroll container for the open thread, so it opens on the most recent exchange
  const threadRef = useRef<HTMLDivElement>(null)

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
    setReplyText('')
    setReplyStatus(null)
    setMessages([])
    if (!activeId) return

    let cancelled = false
    const loadMessages = () =>
      supabase
        .from('inbox_messages')
        .select('*')
        .eq('conversation_id', activeId)
        .order('timestamp', { ascending: true })
        .then(({ data }) => {
          if (!cancelled) setMessages((data as Message[]) ?? [])
        })

    loadMessages()
    // Poll the open thread so sent replies + new inbound appear on their own,
    // without having to click away and back.
    const handle = setInterval(loadMessages, 5000)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [activeId])

  // Keep the thread pinned to the most recent exchange: scroll to the bottom
  // when a thread opens and whenever new messages arrive. useLayoutEffect runs
  // before paint (no flash of the top), and the rAF re-pins after any late
  // reflow (e.g. wrapped long messages) so we reliably land on the latest.
  useLayoutEffect(() => {
    const el = threadRef.current
    if (!el) return
    const pin = () => {
      el.scrollTop = el.scrollHeight
    }
    pin()
    const raf = requestAnimationFrame(pin)
    return () => cancelAnimationFrame(raf)
  }, [activeId, messages.length])

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

  async function sendReply() {
    if (!active || !replyText.trim()) return
    setReplyStatus('Queuing…')
    const { error } = await supabase.from('inbox_drafts').insert({
      conversation_id: active.id,
      content: replyText.trim(),
      status: 'approved',
      generated_by: 'manual',
    })
    if (error) {
      setReplyStatus(`Error: ${error.message}`)
      return
    }
    setReplyText('')
    setReplyStatus('Approved ✓ — sends on the next sync (~15s), then appears above.')
    setTimeout(() => setReplyStatus(null), 6000)
  }

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
            <div ref={threadRef} className="flex-1 space-y-2 overflow-y-auto p-6">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`max-w-lg rounded-2xl px-4 py-2 text-sm ${
                    m.direction === 'outbound'
                      ? 'ml-auto bg-emerald-600 text-white'
                      : 'border border-slate-200 bg-white'
                  }`}
                >
                  <div className="whitespace-pre-wrap">{highlight(toPlainText(m.text), query)}</div>
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
            <footer className="border-t border-slate-200 bg-white px-4 py-3">
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    void sendReply()
                  }
                }}
                placeholder={`Reply to ${nameOf(active)} on ${active.network}…`}
                rows={2}
                className="w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-[11px] text-slate-400">
                  {replyStatus ?? 'Approve & send goes out via your local sync. ⌘/Ctrl+Enter to send.'}
                </span>
                <button
                  onClick={() => void sendReply()}
                  disabled={!replyText.trim()}
                  className="shrink-0 rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  Approve &amp; send
                </button>
              </div>
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

// Beeper returns message text as rich text (HTML). Convert it to clean,
// readable plain text — safely, without rendering untrusted HTML.
function toPlainText(raw: string | null): string {
  if (!raw) return ''
  let t = raw
  t = t.replace(/<br\s*\/?>/gi, '\n')
  t = t.replace(/<\/p>/gi, '\n\n').replace(/<p[^>]*>/gi, '')
  t = t.replace(/<li[^>]*>/gi, '• ').replace(/<\/li>/gi, '\n')
  t = t.replace(/<\/?(ol|ul|blockquote|div|span)[^>]*>/gi, '')
  t = t.replace(/<[^>]+>/g, '') // strip any remaining tags
  t = t
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
  return t.replace(/\n{3,}/g, '\n\n').trim()
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
