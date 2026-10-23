import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useInboxSettings } from './useInboxSettings'

/** Beeper stores rich text (HTML); flatten to plain text for display. */
function plain(raw: string | null, n = 200): string {
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

interface DraftRow {
  id: string
  conversationId: string
  content: string
  createdAt: string
  /** Thread display name + network, from inbox_conversations. */
  name: string
  network: string
  /** The inbound message this draft answers, if one is on record. */
  inbound: string | null
}

const timeLabel = (iso: string): string => {
  const d = new Date(iso)
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'yesterday'
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/**
 * The approval queue across all conversations — every AI reply waiting on you,
 * in one pass, so you never have to open threads one by one to clear them.
 *
 * These are the same `inbox_drafts` rows the Inbox thread card shows: approving
 * here sets status='approved' and the sync's outbox sends it on the next pass
 * (~15s), exactly as it does from the thread. Rejecting sets 'rejected', the
 * same status the drafter uses to retire a stale suggestion. Nothing is sent
 * from the browser, and the STOP switch still gates every send.
 */
export function ReplyQueue() {
  const [rows, setRows] = useState<DraftRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  // Which draft is being edited before sending, and the working text.
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null)
  const { settings: rail, loaded: railLoaded } = useInboxSettings()

  async function load() {
    const { data: ds } = await supabase
      .from('inbox_drafts')
      .select('id, conversation_id, content, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50)
    const drafts = (ds ?? []) as { id: string; conversation_id: string; content: string; created_at: string }[]
    if (drafts.length === 0) {
      setRows([])
      setLoaded(true)
      return
    }

    const convIds = [...new Set(drafts.map((d) => d.conversation_id))]
    const [{ data: cs }, { data: ms }] = await Promise.all([
      supabase.from('inbox_conversations').select('id, title, network').in('id', convIds),
      supabase
        .from('inbox_messages')
        .select('conversation_id, text, timestamp')
        .in('conversation_id', convIds)
        .eq('direction', 'inbound')
        .order('timestamp', { ascending: false })
        .limit(300),
    ])
    const convs = new Map(
      ((cs ?? []) as { id: string; title: string | null; network: string }[]).map((c) => [c.id, c]),
    )
    // First row per conversation is its latest inbound message — what the
    // draft is answering.
    const latestInbound = new Map<string, string>()
    for (const m of (ms ?? []) as { conversation_id: string; text: string | null }[]) {
      if (!latestInbound.has(m.conversation_id) && m.text) latestInbound.set(m.conversation_id, m.text)
    }

    setRows(
      drafts.map((d) => ({
        id: d.id,
        conversationId: d.conversation_id,
        content: d.content,
        createdAt: d.created_at,
        name: convs.get(d.conversation_id)?.title ?? 'Conversation',
        network: convs.get(d.conversation_id)?.network ?? '',
        inbound: latestInbound.get(d.conversation_id) ?? null,
      })),
    )
    setLoaded(true)
  }

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 20_000)
    return () => clearInterval(t)
  }, [])

  /** Approve: the outbox sends it on the next sync pass. */
  async function approve(r: DraftRow, text: string) {
    if (busy) return
    setBusy(true)
    const { error } = await supabase
      .from('inbox_drafts')
      .update({ content: text, status: 'approved' })
      .eq('id', r.id)
    setBusy(false)
    if (error) {
      setStatus(`Error: ${error.message}`)
      return
    }
    setEdit(null)
    setRows((prev) => prev.filter((x) => x.id !== r.id))
    setStatus(`Approved for ${r.name} — sends on the next sync (~15s).`)
    setTimeout(() => setStatus(null), 6000)
  }

  /** Reject: retires the suggestion; the thread stays open for a manual reply. */
  async function reject(r: DraftRow) {
    if (busy) return
    setBusy(true)
    const { error } = await supabase.from('inbox_drafts').update({ status: 'rejected' }).eq('id', r.id)
    setBusy(false)
    if (error) {
      setStatus(`Error: ${error.message}`)
      return
    }
    setRows((prev) => prev.filter((x) => x.id !== r.id))
  }

  const note =
    railLoaded && rail.sendsPaused
      ? 'All sends are STOPPED — approving holds the reply in the queue until you resume.'
      : railLoaded && rail.repliesPaused
        ? 'Auto-reply is paused — no new drafts are being generated. Anything already here can still be approved.'
        : 'New drafts appear here as replies land — approve from anywhere.'

  return (
    <section className="mb-7">
      <div className="section-head">
        <span className="kicker">Reply drafts{rows.length > 0 ? ` · ${rows.length}` : ''}</span>
        <button onClick={() => void load()} className="btn btn-ghost !text-xs">
          Refresh
        </button>
      </div>

      {status && (
        <p className="mb-0 mt-3 text-sm font-semibold" style={{ color: 'var(--color-accent-700)' }}>
          {status}
        </p>
      )}

      {loaded && rows.length === 0 && (
        <p className="m-0 py-4 text-sm muted">
          No replies waiting on you. Drafts land here as players write in.
        </p>
      )}

      {rows.map((r) => {
        const editing = edit?.id === r.id
        return (
          <div key={r.id} className="row py-4">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-semibold">{r.name}</span>
              {r.network && <span className="tag tag-neutral tag-net">{r.network}</span>}
              <span className="text-[11px] muted-45 tnum">{timeLabel(r.createdAt)}</span>
            </div>

            {r.inbound && (
              <div className="mt-1 text-xs muted">They said: “{plain(r.inbound)}”</div>
            )}

            {editing ? (
              <textarea
                autoFocus
                value={edit.text}
                onChange={(e) => setEdit({ id: r.id, text: e.target.value })}
                rows={3}
                className="input mt-2 max-w-[62ch] !text-sm"
              />
            ) : (
              <div
                className="mt-2 max-w-[62ch] px-3 py-2 text-sm leading-normal"
                style={{ background: 'var(--color-surface)', borderLeft: '3px solid var(--color-accent)' }}
              >
                {r.content}
              </div>
            )}

            <div className="mt-2.5 flex flex-wrap gap-2">
              <button
                disabled={busy}
                onClick={() => void approve(r, editing ? edit.text : r.content)}
                className="btn btn-primary !text-xs"
              >
                Approve &amp; send
              </button>
              {editing ? (
                <button onClick={() => setEdit(null)} className="btn btn-secondary !text-xs">
                  Cancel edit
                </button>
              ) : (
                <button
                  onClick={() => setEdit({ id: r.id, text: r.content })}
                  className="btn btn-secondary !text-xs"
                >
                  Edit
                </button>
              )}
              <button disabled={busy} onClick={() => void reject(r)} className="btn-quiet">
                Reject
              </button>
            </div>
          </div>
        )
      })}

      <p className="m-0 mt-3 text-xs muted">{note}</p>
    </section>
  )
}
