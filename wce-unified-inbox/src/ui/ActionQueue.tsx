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
  priority?: boolean
}

const phoneCore = (p: string | null): string =>
  p ? p.replace(/\D/g, '').replace(/^61/, '').replace(/^0/, '') : ''
interface Email {
  id: string
  gmail_id: string
  from_name: string | null
  from_email: string | null
  subject: string | null
  snippet: string | null
}
interface AwaitedTransfer {
  id: string
  name: string | null
  amount: string | null
  venue: string | null
  game_date: string | null
}

// Rows shown per section before the "show all" expander kicks in — keeps the
// landing page a to-do list, not a wall.
const CAP = 6

/**
 * Home action queue — everything needing Justin himself, at the top of Home and
 * hidden when empty. Three sources: replies the classifier flagged "needs you",
 * unread threads from PLAYERS (a thread linked to a CRM record), and unread inbox
 * email (mirrored by the sync, read-only). Non-player unread — marketing SMS,
 * group rooms, unknown numbers — is collapsed behind an expander with a one-tap
 * clear, so it never swamps the queue. Every "done" is durable (action_resolved /
 * context_resolved_at / inbox_emails.resolved), so cleared items stay cleared
 * across refreshes and devices.
 */
export function ActionQueue({ onOpen }: { onOpen: (conversationId: string) => void }) {
  const [needsYou, setNeedsYou] = useState<NeedsYou[]>([])
  const [playerUnread, setPlayerUnread] = useState<Unread[]>([])
  const [otherUnread, setOtherUnread] = useState<Unread[]>([])
  const [emails, setEmails] = useState<Email[]>([])
  const [awaited, setAwaited] = useState<AwaitedTransfer[]>([])
  // conversation_id -> last inbound message text, for triage-at-a-glance rows.
  const [lastMsg, setLastMsg] = useState<Map<string, string>>(new Map())
  const [bridgeDown, setBridgeDown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showAllPlayers, setShowAllPlayers] = useState(false)
  const [showAllEmails, setShowAllEmails] = useState(false)

  async function load() {
    // Recent items only — the queue is a to-do list, not an archive. Older
    // escalations were already texted to Justin in the digest at the time.
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString()
    const { data: ny } = await supabase
      .from('inbox_messages')
      .select('id, conversation_id, sender_name, text')
      .eq('reply_intent', 'other')
      .eq('action_resolved', false)
      .gte('timestamp', since)
      .order('timestamp', { ascending: false })
      .limit(40)
    // Belt-and-braces: rows written by pre-'noise'-tag sync code can still be
    // system events ("X joined the chat") — drop anything that reads like one.
    const NOISE = /\b(joined|left|added|removed|created|changed|renamed|set the|started|ended|missed|deleted)\b.*\b(chat|group|call|name|photo|message)\b|^\s*(👍|👎|❤️|reacted)/i
    setNeedsYou(((ny as NeedsYou[]) ?? []).filter((m) => {
      const t = snippet(m.text, 400)
      return t.length > 0 && !NOISE.test(t)
    }))

    const { data: ur } = await supabase
      .from('inbox_conversations')
      .select('id, title, network, unread_count, last_activity, context_resolved_at, external_chat_id, type')
      .gt('unread_count', 0)
      .eq('hidden', false)
      .gte('last_activity', since)
      .order('last_activity', { ascending: false })
      .limit(80)
    const rows = (ur as (Unread & {
      last_activity: string | null
      context_resolved_at: string | null
      external_chat_id: string | null
      type: string
    })[]) ?? []
    // "Done" on a thread sets context_resolved_at; it reappears only on newer activity.
    const open = rows.filter((c) => !c.context_resolved_at || (c.last_activity ?? '') > c.context_resolved_at)

    // Last inbound message per open thread, so a row can be triaged (done /
    // deprioritise) without opening it.
    if (open.length) {
      const { data: lm } = await supabase
        .from('inbox_messages')
        .select('conversation_id, text, timestamp')
        .in('conversation_id', open.map((c) => c.id))
        .eq('direction', 'inbound')
        .order('timestamp', { ascending: false })
        .limit(400)
      const firstPer = new Map<string, string>()
      for (const m of (lm ?? []) as { conversation_id: string; text: string | null }[]) {
        if (!firstPer.has(m.conversation_id) && m.text) firstPer.set(m.conversation_id, m.text)
      }
      setLastMsg(firstPer)
    } else {
      setLastMsg(new Map())
    }

    // A thread is a PLAYER'S when it's linked to a CRM record (by thread id or a
    // phone-number title match). Everything else — marketing SMS, group rooms,
    // unknown numbers — goes to the collapsed tier. PRIORITY contacts (Carla,
    // Leon, ...) pin to the top with a star, matched on any of their channels.
    const { data: linked } = await supabase
      .from('inbox_outreach')
      .select('beeper_chat_id, phone, priority')
      .or('beeper_chat_id.not.is.null,phone.not.is.null')
    const crmChats = new Set<string>()
    const crmPhones = new Set<string>()
    const prioChats = new Set<string>()
    const prioPhones = new Set<string>()
    for (const o of (linked ?? []) as { beeper_chat_id: string | null; phone: string | null; priority: boolean }[]) {
      if (o.beeper_chat_id) crmChats.add(o.beeper_chat_id)
      const pc = phoneCore(o.phone)
      if (pc) crmPhones.add(pc)
      if (o.priority) {
        if (o.beeper_chat_id) prioChats.add(o.beeper_chat_id)
        if (pc) prioPhones.add(pc)
      }
    }
    const isKnown = (c: (typeof open)[number]) =>
      c.type === 'single' &&
      ((c.external_chat_id && crmChats.has(c.external_chat_id)) ||
        (!!c.title && /^[\d\s+()-]{6,}$/.test(c.title) && crmPhones.has(phoneCore(c.title))))
    const isPrio = (c: (typeof open)[number]) =>
      (c.external_chat_id && prioChats.has(c.external_chat_id)) ||
      (!!c.title && /^[\d\s+()-]{6,}$/.test(c.title) && prioPhones.has(phoneCore(c.title)))
    setPlayerUnread(
      open
        .filter(isKnown)
        .map((c) => ({ ...c, priority: isPrio(c) }))
        .sort((a, b) => Number(b.priority) - Number(a.priority)),
    )
    setOtherUnread(open.filter((c) => !isKnown(c)))

    const { data: em } = await supabase
      .from('inbox_emails')
      .select('id, gmail_id, from_name, from_email, subject, snippet')
      .eq('resolved', false)
      .order('received_at', { ascending: false })
      .limit(40)
    setEmails((em as Email[]) ?? [])

    const { data: tf } = await supabase
      .from('inbox_transfers')
      .select('id, name, amount, venue, game_date')
      .eq('pending', true)
      .order('game_date', { ascending: false })
      .limit(20)
    setAwaited((tf as AwaitedTransfer[]) ?? [])

    const sq = supabase as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (col: string, v: number) => { maybeSingle: () => Promise<{ data: { sms_bridge_down?: boolean } | null }> }
        }
      }
    }
    const { data: st } = await sq.from('inbox_settings').select('sms_bridge_down').eq('id', 1).maybeSingle()
    setBridgeDown(st?.sms_bridge_down ?? false)
  }
  useEffect(() => { void load() }, [])

  async function resolveAwaited(id: string) {
    setBusy(true)
    await supabase.from('inbox_transfers').update({ pending: false }).eq('id', id)
    setAwaited((prev) => prev.filter((t) => t.id !== id))
    setBusy(false)
  }

  async function resolveReply(id: string) {
    setBusy(true)
    await supabase.from('inbox_messages').update({ action_resolved: true }).eq('id', id)
    setNeedsYou((prev) => prev.filter((m) => m.id !== id))
    setBusy(false)
  }
  async function resolveThread(id: string) {
    setBusy(true)
    await supabase.from('inbox_conversations').update({ context_resolved_at: new Date().toISOString() }).eq('id', id)
    setPlayerUnread((prev) => prev.filter((c) => c.id !== id))
    setOtherUnread((prev) => prev.filter((c) => c.id !== id))
    setBusy(false)
  }
  async function resolveAllOther() {
    if (otherUnread.length === 0) return
    setBusy(true)
    const now = new Date().toISOString()
    const ids = otherUnread.map((c) => c.id)
    for (let i = 0; i < ids.length; i += 100) {
      await supabase.from('inbox_conversations').update({ context_resolved_at: now }).in('id', ids.slice(i, i + 100))
    }
    setOtherUnread([])
    setBusy(false)
  }
  async function resolveEmail(id: string) {
    setBusy(true)
    await supabase.from('inbox_emails').update({ resolved: true }).eq('id', id)
    setEmails((prev) => prev.filter((e) => e.id !== id))
    setBusy(false)
  }

  const total = needsYou.length + playerUnread.length + emails.length + awaited.length
  if (total === 0 && otherUnread.length === 0 && !bridgeDown) return null // nothing needs attention

  const chip = (text: string, cls: string) => (
    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${cls}`}>{text}</span>
  )
  const openBtn = (onClick: () => void, label = 'open') => (
    <button onClick={onClick} className="rounded-md bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-emerald-700">{label}</button>
  )
  const doneBtn = (onClick: () => void) => (
    <button onClick={onClick} disabled={busy} className="text-xs text-slate-400 hover:text-rose-600 disabled:opacity-40">done</button>
  )

  const shownPlayers = showAllPlayers ? playerUnread : playerUnread.slice(0, CAP)
  const shownEmails = showAllEmails ? emails : emails.slice(0, CAP)

  return (
    <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50/60 p-3">
      {bridgeDown && (
        <div className="mb-2 rounded-md border border-rose-400 bg-rose-600 p-2 text-sm font-medium text-white">
          ⚠ Google Messages bridge is DOWN — SMS sends are held (not failed) until it reconnects.
          Messenger is unaffected. Fix: Beeper → Google Messages → reconnect (phone paired &amp; online).
        </div>
      )}
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-rose-800">Needs you · {total}</h3>
        <button onClick={() => void load()} className="text-xs text-rose-700 hover:underline">Refresh</button>
      </div>

      {needsYou.length > 0 && (
        <ul className="mb-2 space-y-1">
          {needsYou.map((m) => (
            <li key={m.id} className="flex items-center gap-2 rounded border border-rose-100 bg-white p-1.5 text-sm">
              {chip('reply', 'bg-rose-100 text-rose-700')}
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{m.sender_name ?? 'Someone'}</span>
                {m.text ? <span className="text-slate-500"> — {snippet(m.text)}</span> : null}
              </span>
              {openBtn(() => onOpen(m.conversation_id))}
              {doneBtn(() => void resolveReply(m.id))}
            </li>
          ))}
        </ul>
      )}

      {awaited.length > 0 && (
        <>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">Transfers awaited · {awaited.length}</p>
          <ul className="mb-2 space-y-1">
            {awaited.map((t) => (
              <li key={t.id} className="flex items-center gap-2 rounded border border-rose-100 bg-white p-1.5 text-sm">
                {chip('⏳ transfer', 'bg-amber-100 text-amber-700')}
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{t.name ?? '(no name)'}</span>
                  <span className="text-slate-500"> {t.amount ?? ''}</span>
                  <span className="text-[11px] text-slate-400"> · {t.venue ?? ''} {t.game_date ?? ''}</span>
                </span>
                {doneBtn(() => void resolveAwaited(t.id))}
              </li>
            ))}
          </ul>
        </>
      )}

      {playerUnread.length > 0 && (
        <>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">Players · {playerUnread.length}</p>
          <ul className="mb-1 space-y-1">
            {shownPlayers.map((c) => (
              <li
                key={c.id}
                className={`flex items-center gap-2 rounded border p-1.5 text-sm ${
                  c.priority ? 'border-amber-400 bg-amber-50' : 'border-rose-100 bg-white'
                }`}
              >
                {c.priority && <span title="Priority contact" className="shrink-0 text-amber-500">★</span>}
                {chip(`${c.unread_count} unread`, 'bg-amber-100 text-amber-700')}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    <span className="font-medium">{c.title ?? 'Conversation'}</span>
                    <span className="text-[11px] text-slate-400"> · {c.network}</span>
                  </span>
                  {lastMsg.has(c.id) && (
                    <span className="block text-xs text-slate-500">{snippet(lastMsg.get(c.id) ?? '', 160)}</span>
                  )}
                </span>
                {openBtn(() => onOpen(c.id))}
                {doneBtn(() => void resolveThread(c.id))}
              </li>
            ))}
          </ul>
          {playerUnread.length > CAP && (
            <button onClick={() => setShowAllPlayers((v) => !v)} className="mb-2 text-xs text-slate-500 hover:underline">
              {showAllPlayers ? 'show fewer' : `show all ${playerUnread.length}`}
            </button>
          )}
        </>
      )}

      {emails.length > 0 && (
        <>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">Email · {emails.length}</p>
          <ul className="mb-1 space-y-1">
            {shownEmails.map((e) => (
              <li key={e.id} className="flex items-center gap-2 rounded border border-rose-100 bg-white p-1.5 text-sm">
                {chip('email', 'bg-sky-100 text-sky-700')}
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{e.from_name || e.from_email || 'Unknown sender'}</span>
                  {e.subject ? <span className="text-slate-600"> — {e.subject}</span> : null}
                  {e.snippet ? <span className="text-slate-400"> · {snippet(e.snippet, 60)}</span> : null}
                </span>
                <a
                  href={`https://mail.google.com/mail/u/0/#inbox/${e.gmail_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-emerald-700"
                >open</a>
                {doneBtn(() => void resolveEmail(e.id))}
              </li>
            ))}
          </ul>
          {emails.length > CAP && (
            <button onClick={() => setShowAllEmails((v) => !v)} className="mb-2 text-xs text-slate-500 hover:underline">
              {showAllEmails ? 'show fewer' : `show all ${emails.length}`}
            </button>
          )}
        </>
      )}

      {otherUnread.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
            {otherUnread.length} other unread (marketing, groups, unknown numbers)
          </summary>
          <button
            onClick={() => void resolveAllOther()}
            disabled={busy}
            className="my-1 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
          >
            ✓ clear all {otherUnread.length}
          </button>
          <ul className="space-y-1">
            {otherUnread.map((c) => (
              <li key={c.id} className="flex items-center gap-2 rounded border border-slate-100 bg-white/70 p-1.5 text-sm">
                {chip(`${c.unread_count}`, 'bg-slate-100 text-slate-500')}
                <span className="min-w-0 flex-1 text-slate-600">
                  <span className="block truncate">
                    {c.title ?? 'Conversation'}
                    <span className="text-[11px] text-slate-400"> · {c.network}</span>
                  </span>
                  {lastMsg.has(c.id) && (
                    <span className="block truncate text-xs text-slate-400">{snippet(lastMsg.get(c.id) ?? '', 120)}</span>
                  )}
                </span>
                {openBtn(() => onOpen(c.id))}
                {doneBtn(() => void resolveThread(c.id))}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
