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

// The shared queue-row pattern: desktop [from | subj | actions]; phone stacks
// the subject under a [from | actions] top line via grid areas.
const ROW =
  "row row-hover grid grid-cols-[minmax(0,1fr)_max-content] items-start gap-x-5 gap-y-1 py-3 [grid-template-areas:'from_actions'_'subj_subj'] dt:grid-cols-[170px_minmax(0,1fr)_max-content] dt:[grid-template-areas:'from_subj_actions']"

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
  const [mutes, setMutes] = useState<string[]>([])
  const [showAutomated, setShowAutomated] = useState(false)
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
    // Leon, ...) pin to the top with a "priority" tag, matched on any channel.
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
      .limit(60)
    const allEmails = (em as Email[]) ?? []
    // Muted senders: auto-resolve on sight so they never come back.
    const { data: mu } = await supabase.from('inbox_email_mutes').select('pattern')
    const mutePatterns = ((mu ?? []) as { pattern: string }[]).map((m) => m.pattern.toLowerCase())
    setMutes(mutePatterns)
    const isMuted = (e: Email) => mutePatterns.some((p) => (e.from_email ?? '').toLowerCase().includes(p))
    const mutedNow = allEmails.filter(isMuted)
    if (mutedNow.length) {
      await supabase.from('inbox_emails').update({ resolved: true }).in('id', mutedNow.map((e) => e.id))
    }
    setEmails(allEmails.filter((e) => !isMuted(e)))

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
  /** Mute a sender: resolves everything from them now and forever after. */
  async function muteSender(e: Email) {
    const addr = (e.from_email ?? '').toLowerCase().trim()
    if (!addr) return
    if (!window.confirm(`Mute ${addr}? Their emails stop appearing here (Gmail itself is untouched).`)) return
    setBusy(true)
    await supabase.from('inbox_email_mutes').upsert({ pattern: addr }, { onConflict: 'pattern', ignoreDuplicates: true })
    const gone = emails.filter((x) => (x.from_email ?? '').toLowerCase().includes(addr))
    if (gone.length) await supabase.from('inbox_emails').update({ resolved: true }).in('id', gone.map((x) => x.id))
    setMutes((prev) => [...prev, addr])
    setEmails((prev) => prev.filter((x) => !(x.from_email ?? '').toLowerCase().includes(addr)))
    setBusy(false)
  }

  // Automated/notification mail is triaged into a collapsed group; humans and
  // money stay on top. Mutes (above) remove a sender entirely.
  const NOISE_MAIL = /no-?reply|noreply|do-?not-?reply|notification|mailer|automated|alerts?@|updates?@|newsletter|@txt\.voice|security alert|verification code|receipt from|has been added to your account/i
  const isAutomated = (e: Email) =>
    NOISE_MAIL.test(`${e.from_email ?? ''} ${e.subject ?? ''}`)
  const primaryEmails = emails.filter((e) => !isAutomated(e))
  const automatedEmails = emails.filter(isAutomated)
  async function resolveAllAutomated() {
    if (!automatedEmails.length) return
    setBusy(true)
    await supabase.from('inbox_emails').update({ resolved: true }).in('id', automatedEmails.map((e) => e.id))
    setEmails((prev) => prev.filter((e) => !isAutomated(e)))
    setBusy(false)
  }

  const total = needsYou.length + playerUnread.length + primaryEmails.length + awaited.length
  if (total === 0 && otherUnread.length === 0 && !bridgeDown) return null // nothing needs attention

  const openBtn = (onClick: () => void) => (
    <button onClick={onClick} className="btn btn-ghost py-0.5 text-xs">Open</button>
  )
  const doneBtn = (onClick: () => void) => (
    <button onClick={onClick} disabled={busy} className="btn-quiet">Done</button>
  )
  const groupLabel = (text: string) => (
    <p className="m-0 py-1 text-[11px] uppercase muted-50 tnum" style={{ letterSpacing: '0.08em' }}>{text}</p>
  )

  const shownPlayers = showAllPlayers ? playerUnread : playerUnread.slice(0, CAP)
  const shownEmails = showAllEmails ? primaryEmails : primaryEmails.slice(0, CAP)

  const emailRow = (e: Email) => (
    <li key={e.id} className={ROW}>
      <span className="min-w-0 truncate text-sm font-semibold [grid-area:from]">
        {e.from_name || e.from_email || 'Unknown sender'}
      </span>
      <span className="min-w-0 [grid-area:subj]">
        <span className="block truncate text-sm leading-[1.45]">{e.subject || '(no subject)'}</span>
        {e.snippet ? <span className="mt-0.5 block truncate text-xs muted">{snippet(e.snippet, 90)}</span> : null}
      </span>
      <span className="flex items-center gap-2.5 [grid-area:actions]">
        <a
          href={`https://mail.google.com/mail/u/0/#inbox/${e.gmail_id}`}
          target="_blank"
          rel="noreferrer"
          className="btn btn-ghost py-0.5 text-xs"
        >Open</a>
        <button
          onClick={() => void muteSender(e)}
          disabled={busy}
          title={`Never show ${e.from_email ?? 'this sender'} here again`}
          className="btn-quiet"
        >Mute</button>
        {doneBtn(() => void resolveEmail(e.id))}
      </span>
    </li>
  )

  const threadRow = (c: Unread) => (
    <li key={c.id} className={ROW}>
      <span className="flex min-w-0 items-center gap-2 [grid-area:from]">
        <span className="min-w-0 truncate text-sm font-semibold">{c.title ?? 'Conversation'}</span>
        {c.priority && <span className="tag tag-accent tag-net" title="Priority contact">priority</span>}
      </span>
      <span className="min-w-0 [grid-area:subj]">
        {lastMsg.has(c.id) && (
          <span className="block truncate text-sm leading-[1.45]">{snippet(lastMsg.get(c.id) ?? '', 160)}</span>
        )}
        <span className="mt-0.5 block text-xs muted tnum">{c.unread_count} unread · {c.network}</span>
      </span>
      <span className="flex items-center gap-2.5 [grid-area:actions]">
        {openBtn(() => onOpen(c.id))}
        {doneBtn(() => void resolveThread(c.id))}
      </span>
    </li>
  )

  return (
    <section className="mb-7">
      {bridgeDown && (
        <div className="mb-3 flex items-start gap-2.5 text-[13px] font-extrabold" style={{ color: 'var(--color-accent-700)' }}>
          <span className="sq mt-1" style={{ background: 'var(--color-accent)' }} />
          <span>
            Google Messages bridge is DOWN — SMS sends are held (not failed) until it reconnects.
            Messenger is unaffected. Fix: Beeper → Google Messages → reconnect (phone paired &amp; online).
          </span>
        </div>
      )}
      <div className="section-head">
        <span className="kicker tnum">Needs you · {total}</span>
        <button onClick={() => void load()} className="btn btn-ghost py-0.5 text-xs">Refresh</button>
      </div>

      {needsYou.length > 0 && (
        <>
          {groupLabel(`Replies · ${needsYou.length}`)}
          <ul className="m-0 list-none p-0">
            {needsYou.map((m) => (
              <li key={m.id} className={ROW}>
                <span className="min-w-0 truncate text-sm font-semibold [grid-area:from]">{m.sender_name ?? 'Someone'}</span>
                <span className="min-w-0 [grid-area:subj]">
                  <span className="block text-sm leading-[1.45]">{m.text ? snippet(m.text) : '—'}</span>
                </span>
                <span className="flex items-center gap-2.5 [grid-area:actions]">
                  {openBtn(() => onOpen(m.conversation_id))}
                  {doneBtn(() => void resolveReply(m.id))}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {awaited.length > 0 && (
        <>
          {groupLabel(`Transfers awaited · ${awaited.length}`)}
          <ul className="m-0 list-none p-0">
            {awaited.map((t) => (
              <li key={t.id} className={ROW}>
                <span className="min-w-0 truncate text-sm font-semibold [grid-area:from]">{t.name ?? '(no name)'}</span>
                <span className="min-w-0 [grid-area:subj]">
                  <span className="block text-sm leading-[1.45] tnum">{t.amount ?? '—'}</span>
                  {(t.venue || t.game_date) && (
                    <span className="mt-0.5 block truncate text-xs muted tnum">
                      {[t.venue, t.game_date].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2.5 [grid-area:actions]">
                  {doneBtn(() => void resolveAwaited(t.id))}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {playerUnread.length > 0 && (
        <>
          {groupLabel(`Players · ${playerUnread.length}`)}
          <ul className="m-0 list-none p-0">{shownPlayers.map(threadRow)}</ul>
          {playerUnread.length > CAP && (
            <button onClick={() => setShowAllPlayers((v) => !v)} className="btn btn-ghost mt-1 text-xs tnum">
              {showAllPlayers ? 'Show fewer' : `Show all ${playerUnread.length}`}
            </button>
          )}
        </>
      )}

      {primaryEmails.length > 0 && (
        <>
          {groupLabel(`Email · ${primaryEmails.length}`)}
          <ul className="m-0 list-none p-0">{shownEmails.map(emailRow)}</ul>
          {primaryEmails.length > CAP && (
            <button onClick={() => setShowAllEmails((v) => !v)} className="btn btn-ghost mt-1 text-xs tnum">
              {showAllEmails ? 'Show fewer' : `Show all ${primaryEmails.length}`}
            </button>
          )}
        </>
      )}

      {automatedEmails.length > 0 && (
        <details className="mt-1" open={showAutomated} onToggle={(e) => setShowAutomated((e.target as HTMLDetailsElement).open)}>
          <summary className="cursor-pointer list-none py-2 text-xs muted tnum [&::-webkit-details-marker]:hidden">
            {automatedEmails.length} automated emails (alerts, receipts, no-reply){mutes.length ? ` · ${mutes.length} senders muted` : ''}
          </summary>
          <button onClick={() => void resolveAllAutomated()} disabled={busy} className="btn-quiet mb-1 tnum">
            clear all {automatedEmails.length}
          </button>
          <ul className="m-0 list-none p-0">{automatedEmails.map(emailRow)}</ul>
        </details>
      )}

      {otherUnread.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer list-none py-2 text-xs muted tnum [&::-webkit-details-marker]:hidden">
            {otherUnread.length} other unread (marketing, groups, unknown numbers)
          </summary>
          <button onClick={() => void resolveAllOther()} disabled={busy} className="btn-quiet mb-1 tnum">
            clear all {otherUnread.length}
          </button>
          <ul className="m-0 list-none p-0">{otherUnread.map(threadRow)}</ul>
        </details>
      )}
    </section>
  )
}
