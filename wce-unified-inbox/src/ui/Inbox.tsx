import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fileToBase64, type PickedImage } from '../lib/attachment'
import type { Database } from '../types/database'
import { IconChevronLeft, IconX } from './icons'
import { useInboxSettings } from './useInboxSettings'

type Conversation = Database['public']['Tables']['inbox_conversations']['Row'] & {
  inbox_people: { display_name: string | null } | null
}
type Message = Database['public']['Tables']['inbox_messages']['Row']

// Row time: today → "6:38 pm", older → "3 Aug".
function shortWhen(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (d.toDateString() === new Date().toDateString())
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

// Message-label time: today → "6:38 pm", older → "3 Aug, 6:38 pm".
function stampWhen(iso: string): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  if (d.toDateString() === new Date().toDateString()) return time
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}

export function Inbox({
  openConversation,
}: {
  openConversation?: { id: string; nonce: number } | null
}) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Phone is single-pane: true = the thread is showing, false = the list.
  const [mobileOpen, setMobileOpen] = useState(false)

  // Deep-link from elsewhere (e.g. Home's "Who's out" panel): open this thread.
  // Keyed on the nonce so clicking the same player again still re-opens it.
  useEffect(() => {
    if (openConversation?.id) {
      setActiveId(openConversation.id)
      setMobileOpen(true)
    }
  }, [openConversation?.id, openConversation?.nonce])
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)

  // search + filter state
  const [query, setQuery] = useState('')
  const [network, setNetwork] = useState<string>('all')
  // Segmented filter: All | Needs reply | Unread.
  const [filterMode, setFilterMode] = useState<'all' | 'needs' | 'unread'>('all')
  const [showBlocked, setShowBlocked] = useState(false)
  // conversation IDs whose messages match a content search (null = not searching content)
  const [contentMatches, setContentMatches] = useState<Set<string> | null>(null)
  // conversation_id -> latest message, one line, for the list's snippet.
  const [snippets, setSnippets] = useState<Map<string, string>>(new Map())

  // reply composer
  const [replyText, setReplyText] = useState('')
  const [replyStatus, setReplyStatus] = useState<string | null>(null)
  // id of the AI-suggested `pending` draft loaded into the composer (null = none)
  const [pendingDraftId, setPendingDraftId] = useState<string | null>(null)
  // the pending draft is being edited in the composer (card → Edit)
  const [editDraft, setEditDraft] = useState(false)
  // image attached to the outgoing reply (null = none)
  const [attachImg, setAttachImg] = useState<PickedImage | null>(null)

  // Auto-reply rail state — the AI draft card only shows while the rail runs.
  const { settings: rail, loaded: railLoaded } = useInboxSettings()

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

  // When a thread opens, reset the composer and pre-fill it with the latest
  // AI-suggested `pending` draft (if any) so Justin can edit and approve it.
  // Runs only on thread switch — NOT on the 5s poll — so it never clobbers what
  // he's typing.
  useEffect(() => {
    setReplyText('')
    setReplyStatus(null)
    setPendingDraftId(null)
    setEditDraft(false)
    setAttachImg(null)
    if (!activeId) return

    let cancelled = false
    supabase
      .from('inbox_drafts')
      .select('id, content')
      .eq('conversation_id', activeId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (cancelled || !data || data.length === 0) return
        setReplyText(data[0].content as string)
        setPendingDraftId(data[0].id as string)
        setReplyStatus('AI suggested this reply — edit and approve, or clear it.')
      })
    return () => {
      cancelled = true
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

  // Latest message per listed thread — the snippet the list rows show, so a
  // thread can be triaged without opening it. One query for the whole list,
  // newest first; the first row seen per conversation wins.
  useEffect(() => {
    if (conversations.length === 0) return
    let cancelled = false
    supabase
      .from('inbox_messages')
      .select('conversation_id, text, direction, timestamp')
      .in('conversation_id', conversations.map((c) => c.id))
      .order('timestamp', { ascending: false })
      .limit(600)
      .then(({ data }) => {
        if (cancelled) return
        const latest = new Map<string, string>()
        for (const m of (data ?? []) as { conversation_id: string; text: string | null; direction: string }[]) {
          if (latest.has(m.conversation_id)) continue
          const body = toPlainText(m.text).replace(/\s+/g, ' ').trim()
          if (!body) continue
          latest.set(m.conversation_id, m.direction === 'outbound' ? `You: ${body}` : body)
        }
        setSnippets(latest)
      })
    return () => {
      cancelled = true
    }
  }, [conversations])

  const nameOf = (c: Conversation) =>
    c.inbox_people?.display_name ?? c.title ?? c.external_chat_id

  // "Needs reply": unread activity, or activity since the thread was last
  // marked done (context_resolved_at — the same signal the Home queue clears).
  const needsReply = (c: Conversation) =>
    c.unread_count > 0 ||
    (c.last_activity != null &&
      (c.context_resolved_at == null || c.context_resolved_at < c.last_activity))

  const networks = useMemo(
    () => Array.from(new Set(conversations.map((c) => c.network))).sort(),
    [conversations],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return conversations.filter((c) => {
      if (!showBlocked && c.hidden) return false
      if (network !== 'all' && c.network !== network) return false
      if (filterMode === 'unread' && c.unread_count <= 0) return false
      if (filterMode === 'needs' && !needsReply(c)) return false
      if (q) {
        const nameHit = nameOf(c).toLowerCase().includes(q)
        const contentHit = contentMatches?.has(c.id) ?? false
        if (!nameHit && !contentHit) return false
      }
      return true
    })
  }, [conversations, query, network, filterMode, contentMatches, showBlocked])

  async function setBlocked(id: string, val: boolean) {
    await supabase.from('inbox_conversations').update({ hidden: val }).eq('id', id)
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, hidden: val } : c)))
    if (val && activeId === id) setActiveId(null)
  }

  // Clear the unread flag on a thread (and its messages). New inbound will
  // re-flag it on the next sync, so this only dismisses what's been seen.
  async function markRead(id: string) {
    await supabase.from('inbox_conversations').update({ unread_count: 0 }).eq('id', id)
    await supabase.from('inbox_messages').update({ is_unread: false })
      .eq('conversation_id', id).eq('is_unread', true)
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)))
  }

  // Dismiss a thread whose enquiry has gone stale: mark it read and archive it
  // out of the inbox (recoverable via "show dismissed"). Distinct from a hard
  // block in intent, same underlying hidden flag.
  async function dismiss(id: string) {
    await markRead(id)
    await setBlocked(id, true)
  }

  const active = conversations.find((c) => c.id === activeId) ?? null

  // "Done" from inside the thread — same effect as the Home queue's done button,
  // so triage doesn't require bouncing back to Home: clears the unread tier
  // (context_resolved_at) and any needs-you reply items for this conversation.
  const [doneFor, setDoneFor] = useState<string | null>(null)
  async function markDone(id: string) {
    await supabase.from('inbox_conversations').update({ context_resolved_at: new Date().toISOString() }).eq('id', id)
    await supabase.from('inbox_messages').update({ action_resolved: true })
      .eq('conversation_id', id).eq('action_resolved', false)
    await markRead(id)
    setDoneFor(id)
    setTimeout(() => setDoneFor((prev) => (prev === id ? null : prev)), 3000)
  }

  async function sendReply() {
    if (!active || (!replyText.trim() && !attachImg)) return
    setReplyStatus('Queuing…')
    const content = replyText.trim()
    const attach = {
      attachment_data: attachImg?.dataBase64 ?? null,
      attachment_name: attachImg?.name ?? null,
      attachment_mime: attachImg?.mime ?? null,
    }
    // If an AI draft is loaded, approve that row (preserving its `ai` provenance
    // and any edits); otherwise create a fresh manual draft. Either way it lands
    // as `approved` and the outbox sends it on the next pass.
    const op = pendingDraftId
      ? supabase.from('inbox_drafts').update({ content, status: 'approved', ...attach }).eq('id', pendingDraftId)
      : supabase.from('inbox_drafts').insert({
          conversation_id: active.id,
          content,
          status: 'approved',
          generated_by: 'manual',
          ...attach,
        })
    const { error } = await op
    if (error) {
      setReplyStatus(`Error: ${error.message}`)
      return
    }
    setReplyText('')
    setAttachImg(null)
    setPendingDraftId(null)
    setReplyStatus('Approved — sends on the next sync (~15s), then appears above.')
    setTimeout(() => setReplyStatus(null), 6000)
  }

  const openRow = (c: Conversation) => {
    setActiveId(c.id)
    setMobileOpen(true)
    if (c.unread_count > 0) void markRead(c.id)
  }

  const firstName = active ? nameOf(active).split(/\s+/)[0] : ''
  // Phone: the thread replaces the list; desktop always shows both panes.
  const showThread = mobileOpen && !!active
  // The AI draft card renders only while the auto-reply rail is running, and
  // hides once "Edit" moves the draft into the composer.
  const draftCard = Boolean(
    pendingDraftId && !editDraft && railLoaded && !rail.repliesPaused && !rail.sendsPaused,
  )

  return (
    <div>
      {/* ————— filters ————— */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="seg">
          <button className="seg-btn" aria-pressed={filterMode === 'all'} onClick={() => setFilterMode('all')}>
            All
          </button>
          <button className="seg-btn" aria-pressed={filterMode === 'needs'} onClick={() => setFilterMode('needs')}>
            Needs reply
          </button>
          <button className="seg-btn" aria-pressed={filterMode === 'unread'} onClick={() => setFilterMode('unread')}>
            Unread
          </button>
        </div>
        <div className="relative">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or message"
            className="input !w-[220px] pr-8"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="btn-quiet absolute right-1.5 top-1/2 -translate-y-1/2"
              aria-label="Clear search"
            >
              <IconX size={14} />
            </button>
          )}
        </div>
        <select
          className="input !w-auto"
          value={network}
          onChange={(e) => setNetwork(e.target.value)}
          aria-label="Network"
        >
          <option value="all">All networks</option>
          {networks.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <label className="flex cursor-pointer items-center gap-2 text-xs muted-70">
          <input
            type="checkbox"
            className="checkbox"
            checked={showBlocked}
            onChange={(e) => setShowBlocked(e.target.checked)}
          />
          Show dismissed
        </label>
      </div>

      {/* ————— two panes under a 2px rule ————— */}
      <div
        className="dt:grid dt:grid-cols-[340px_minmax(0,1fr)]"
        style={{ borderTop: '2px solid var(--color-divider)' }}
      >
        {/* conversation list */}
        <aside
          className={`${showThread ? 'hidden dt:block' : ''} border-divider dt:h-[calc(100vh-320px)] dt:overflow-y-auto dt:border-r`}
        >
          {loading && <p className="m-0 py-4 text-sm muted">Loading…</p>}
          {!loading && filtered.length === 0 && (
            <p className="m-0 py-4 text-sm muted">No conversations match.</p>
          )}
          {filtered.map((c) => {
            const selected = activeId === c.id
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => openRow(c)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') openRow(c)
                }}
                className={`row row-hover group grid cursor-pointer grid-cols-[10px_minmax(0,1fr)_max-content] gap-2.5 py-3 pr-3 ${
                  c.hidden ? 'opacity-60' : ''
                }`}
                style={
                  selected
                    ? {
                        background: 'color-mix(in srgb, var(--color-text) 6%, transparent)',
                        boxShadow: 'inset 3px 0 0 var(--color-accent)',
                      }
                    : undefined
                }
              >
                <span
                  className="sq mt-[5px]"
                  style={{ background: c.unread_count > 0 ? 'var(--color-accent)' : 'transparent' }}
                />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold">{nameOf(c)}</span>
                    <span className="tag tag-neutral tag-net uppercase">{c.network}</span>
                  </div>
                  {/* The design's snippet line: the latest message in the
                      thread, so the list can be triaged without opening rows.
                      Falls back to the unread tally until it loads. */}
                  <p className="m-0 truncate text-xs muted">
                    {snippets.get(c.id) ??
                      (c.unread_count > 0 ? `${c.unread_count} unread` : '')}
                  </p>
                </div>
                {/* Time sits alone in the third column (per the design); the
                    triage actions reveal underneath it on hover/focus so the
                    row keeps one line's height at rest. */}
                <div className="flex flex-col items-end gap-1">
                  <span className="text-[11px] muted-45 tnum">{shortWhen(c.last_activity)}</span>
                  <span className="flex items-center gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  {c.hidden ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void setBlocked(c.id, false)
                      }}
                      title="Restore to inbox"
                      className="btn-quiet !text-[10px]"
                    >
                      Restore
                    </button>
                  ) : (
                    <>
                      {c.unread_count > 0 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            void markRead(c.id)
                          }}
                          title="Mark as read"
                          className="btn-quiet !text-[10px]"
                        >
                          Read
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void dismiss(c.id)
                        }}
                        title="Dismiss — archive this thread out of the inbox"
                        className="btn-quiet !text-[10px]"
                      >
                        Dismiss
                      </button>
                    </>
                  )}
                  </span>
                </div>
              </div>
            )
          })}
          <div className="py-2 text-[11px] muted-45 tnum">
            {filtered.length} of {conversations.length} conversations
          </div>
        </aside>

        {/* thread pane */}
        <section
          className={`${showThread ? 'flex' : 'hidden dt:flex'} h-[calc(100vh-300px)] min-h-[320px] flex-col dt:h-[calc(100vh-320px)] dt:pl-6`}
        >
          {active ? (
            <>
              {/* thread header */}
              <div
                className="flex items-center gap-3 py-3"
                style={{ borderBottom: '1px solid var(--color-divider)' }}
              >
                <button
                  className="btn btn-secondary btn-icon dt:hidden"
                  aria-label="Back to list"
                  onClick={() => setMobileOpen(false)}
                >
                  <IconChevronLeft />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[16px] font-semibold">{nameOf(active)}</span>
                    <span className="tag tag-neutral tag-net uppercase">{active.network}</span>
                  </div>
                  <p className="m-0 truncate text-[11px] muted-50 tnum">
                    {active.external_chat_id} · {active.type}
                  </p>
                </div>
                <button
                  onClick={() => void markDone(active.id)}
                  title="Handled — clears this thread from the Home queue (it comes back on new activity)"
                  className={`btn-quiet ${doneFor === active.id ? '!text-xs font-semibold' : ''}`}
                  style={doneFor === active.id ? { color: 'var(--color-accent-700)' } : undefined}
                >
                  {doneFor === active.id ? 'Cleared' : 'Done'}
                </button>
                <button
                  onClick={() => void dismiss(active.id)}
                  title="Dismiss — archive this thread out of the inbox (recoverable via show dismissed)"
                  className="btn-quiet"
                >
                  Dismiss
                </button>
              </div>

              {/* transcript */}
              <div ref={threadRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto py-4">
                {messages.map((m) => {
                  const out = m.direction === 'outbound'
                  return (
                    <div key={m.id} className="max-w-[62ch]">
                      <div
                        className={`text-[10px] uppercase tnum ${out ? '' : 'muted-50'}`}
                        style={{
                          letterSpacing: '0.08em',
                          ...(out ? { color: 'var(--color-accent-700)' } : {}),
                        }}
                      >
                        {out ? 'You' : firstName} · {stampWhen(m.timestamp)}
                      </div>
                      <div
                        className={`mt-1 whitespace-pre-wrap text-sm leading-[1.5] ${out ? 'bg-surface' : ''}`}
                        style={out ? { padding: '9px 12px' } : undefined}
                      >
                        {highlight(toPlainText(m.text), query)}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* AI draft card — only while the auto-reply rail is running */}
              {draftCard && (
                <div
                  className="mb-1 mt-2 max-w-[62ch] p-3.5"
                  style={{ border: '2px solid var(--color-accent)' }}
                >
                  <p
                    className="m-0 text-[10px] font-semibold uppercase"
                    style={{ letterSpacing: '0.1em', color: 'var(--color-accent-700)' }}
                  >
                    AI draft — pending your approval
                  </p>
                  <p className="m-0 mt-1.5 whitespace-pre-wrap text-sm leading-[1.5]">{replyText}</p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <button className="btn btn-primary !text-xs" onClick={() => void sendReply()}>
                      Approve &amp; send
                    </button>
                    <button className="btn btn-secondary !text-xs" onClick={() => setEditDraft(true)}>
                      Edit
                    </button>
                    <button
                      className="btn-quiet"
                      onClick={() => {
                        setReplyText('')
                        setPendingDraftId(null)
                        setReplyStatus(null)
                      }}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              )}

              {/* composer */}
              {!draftCard && (
                <div className="mt-2 pt-3.5" style={{ borderTop: '2px solid var(--color-divider)' }}>
                  <div className="flex items-end gap-2">
                    <textarea
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault()
                          void sendReply()
                        }
                      }}
                      placeholder={`Reply to ${firstName}`}
                      rows={2}
                      autoFocus={editDraft}
                      className="input flex-1 resize-none"
                    />
                    <button
                      onClick={() => void sendReply()}
                      disabled={!replyText.trim() && !attachImg}
                      className="btn btn-primary"
                    >
                      Send
                    </button>
                  </div>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                    <label className="btn btn-secondary !text-xs cursor-pointer">
                      Attach image
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={async (e) => {
                          const f = e.target.files?.[0]
                          e.target.value = ''
                          if (!f) return
                          try {
                            setAttachImg(await fileToBase64(f))
                            setReplyStatus(null)
                          } catch (err) {
                            setReplyStatus(err instanceof Error ? err.message : 'Could not read image')
                          }
                        }}
                      />
                    </label>
                    {attachImg && (
                      <span className="tag tag-neutral inline-flex max-w-[14rem] items-center gap-1">
                        <span className="truncate">{attachImg.name}</span>
                        <button
                          onClick={() => setAttachImg(null)}
                          className="btn-quiet"
                          aria-label="Remove attached image"
                        >
                          <IconX size={12} />
                        </button>
                      </span>
                    )}
                    <span className="truncate text-[11px] muted-45">
                      {replyStatus ?? '⌘/Ctrl+Enter to send'}
                    </span>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="grid flex-1 place-items-center text-sm muted">
              Select a conversation
            </div>
          )}
        </section>
      </div>
    </div>
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
      <mark
        className="px-0.5"
        style={{ background: 'color-mix(in srgb, var(--color-accent) 30%, transparent)', color: 'inherit' }}
      >
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  )
}
