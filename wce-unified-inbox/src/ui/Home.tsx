import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { normFull, normCore } from './usePlayers'

/** A trimmed CRM row — only what the post-game matcher / router needs. */
interface CrmRow {
  id: string
  player_name: string | null
  phone: string | null
  beeper_chat_id: string | null
  hidden: boolean | null
}

/**
 * Home / Dashboard tab — the CRM's landing page. At-a-glance counts plus the
 * featured Post-game thank-you tool. More cards can slot in over time.
 */
export function Home() {
  return (
    <div className="mx-auto h-full w-full max-w-4xl overflow-y-auto p-6">
      <h2 className="mb-4 text-lg font-semibold">Home</h2>
      <DashboardCards />
      <PostGame />
    </div>
  )
}

// ----------------------------- dashboard cards ------------------------------

function DashboardCards() {
  const [stats, setStats] = useState<{ players: number; noContact: number; fbDm: number } | null>(null)
  const [beat, setBeat] = useState<{ note: string | null; last: string | null } | null>(null)

  useEffect(() => {
    void (async () => {
      const head = { count: 'exact' as const, head: true }
      const [players, noContact, fbDm] = await Promise.all([
        supabase.from('inbox_outreach').select('id', head).eq('hidden', false),
        supabase
          .from('inbox_outreach')
          .select('id', head)
          .eq('hidden', false)
          .is('phone', null)
          .is('beeper_chat_id', null),
        supabase
          .from('inbox_outreach')
          .select('id', head)
          .eq('hidden', false)
          .eq('fb_friend', true)
          .is('phone', null)
          .is('beeper_chat_id', null),
      ])
      setStats({
        players: players.count ?? 0,
        noContact: noContact.count ?? 0,
        fbDm: fbDm.count ?? 0,
      })
      const { data: hb } = await supabase
        .from('inbox_sync_heartbeat')
        .select('note, last_run')
        .eq('id', 1)
        .maybeSingle()
      setBeat({ note: hb?.note ?? null, last: hb?.last_run ?? null })
    })()
  }, [])

  const ago = (iso: string | null): string => {
    if (!iso) return '—'
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 90) return `${s}s ago`
    if (s < 5400) return `${Math.round(s / 60)}m ago`
    return `${Math.round(s / 3600)}h ago`
  }

  return (
    <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="Players" value={stats?.players} />
      <Stat label="No contact" value={stats?.noContact} tone="amber" />
      <Stat label="FB · DM to open" value={stats?.fbDm} tone="indigo" />
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="text-[11px] uppercase tracking-wide text-slate-400">Sync</div>
        <div className="mt-1 truncate text-sm font-semibold text-slate-700">{beat?.note ?? '—'}</div>
        <div className="text-[11px] text-slate-400">ran {ago(beat?.last ?? null)}</div>
      </div>
    </div>
  )
}

function Stat({ label, value, tone = 'slate' }: { label: string; value?: number; tone?: 'slate' | 'amber' | 'indigo' }) {
  const color =
    tone === 'amber' ? 'text-amber-700' : tone === 'indigo' ? 'text-indigo-700' : 'text-slate-800'
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${color}`}>{value ?? '—'}</div>
    </div>
  )
}

// ------------------------------ post-game tool ------------------------------

type RowStatus = 'matched' | 'new' | 'nocontact' | 'ambiguous'

interface Attendee {
  name: string
  player: CrmRow | null
  status: RowStatus
  channel: 'thread' | 'sms' | null
  winner: boolean
  message: string
  include: boolean
}

/** Heavily-varied post-game message pools (casual Aussie poker-host voice). */
const OPENERS = ['Hey {n}', '{n}!', 'Gday {n}', 'Hi {n}', 'Evening {n}', 'Cheers {n}', '{n} 👋']
const THANKS = [
  'thanks for coming down to {v} tonight',
  'great to see you at {v} tonight',
  'cheers for getting around the game at {v} tonight',
  'good to have you at the table tonight',
  'appreciate you coming out to {v} tonight',
  'thanks for playing {v} tonight',
]
const THANKS_NV = [
  'thanks for coming down tonight',
  'great to see you at the table tonight',
  'cheers for getting around the game tonight',
  'good to have you out tonight',
  'appreciate you coming along tonight',
]
const WINNER = [
  'and a massive well done on the win! 🏆',
  'and huge congrats taking it down tonight 👏',
  'and well played grabbing the win!',
  'and what a result — well-deserved win 🎉',
  'and cracking effort taking out the win!',
]
const CLOSERS = [
  'Hope to see you at the next one.',
  'Catch you at the next game.',
  'Look forward to having you back next week.',
  'See you at the next one!',
  'Hope you can make the next game.',
]

const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)]

function genMessage(name: string, venue: string, winner: boolean): string {
  const n = (name.split(/\s+/)[0] || name).trim()
  const opener = pick(OPENERS).replace('{n}', n)
  const thanks = (venue.trim() ? pick(THANKS).replace('{v}', venue.trim()) : pick(THANKS_NV))
  const win = winner ? ' ' + pick(WINNER) : ''
  const closer = pick(CLOSERS)
  return `${opener}, ${thanks}${win}. ${closer}`
}

function PostGame() {
  const [venue, setVenue] = useState('')
  const [raw, setRaw] = useState('')
  const [rows, setRows] = useState<Attendee[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const sendable = useMemo(() => rows.filter((r) => r.include && r.channel), [rows])

  // Pull the full CRM (paged past PostgREST's 1000 cap) for name matching.
  async function loadCrm(): Promise<CrmRow[]> {
    const out: CrmRow[] = []
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from('inbox_outreach')
        .select('id, player_name, phone, beeper_chat_id, hidden')
        .range(from, from + 999)
      const page = (data as CrmRow[]) ?? []
      out.push(...page)
      if (page.length < 1000) break
    }
    return out
  }

  function routeOf(p: CrmRow): { status: RowStatus; channel: 'thread' | 'sms' | null } {
    if (p.beeper_chat_id) return { status: 'matched', channel: 'thread' }
    if (p.phone?.trim()) return { status: 'matched', channel: 'sms' }
    return { status: 'nocontact', channel: null }
  }

  // Match pasted names to CRM records, CREATING any unknowns so they're pulled
  // into the CRM (per Justin's rule). Then build the editable review list.
  async function build() {
    const names = Array.from(
      new Map(
        raw
          .split(/\n+/)
          .map((l) => l.replace(/\(.*?\)\s*$/, '').trim())
          .filter(Boolean)
          .map((n) => [n.toLowerCase(), n]),
      ).values(),
    )
    if (names.length === 0) {
      setStatus('Paste at least one attendee name.')
      return
    }
    setBusy(true)
    setStatus('Matching…')
    const crm = await loadCrm()

    // name -> unique non-hidden player (full match, then noise-stripped fallback).
    const byFull = new Map<string, CrmRow[]>()
    const byCore = new Map<string, CrmRow[]>()
    for (const p of crm) {
      if (p.hidden || !p.player_name) continue
      const a = normFull(p.player_name), b = normCore(p.player_name)
      if (a.length >= 3) (byFull.get(a) ?? byFull.set(a, []).get(a)!).push(p)
      if (b.length >= 3) (byCore.get(b) ?? byCore.set(b, []).get(b)!).push(p)
    }
    const findUnique = (name: string): CrmRow | 'none' | 'many' => {
      const a = normFull(name), b = normCore(name)
      const hit = (byFull.get(a)?.length ? byFull.get(a) : byCore.get(b)) ?? []
      if (hit.length === 1) return hit[0]
      return hit.length === 0 ? 'none' : 'many'
    }

    // Create rows for the unknown names so they land in the CRM as no-contact.
    const unknowns = names.filter((n) => findUnique(n) === 'none')
    let created = 0
    if (unknowns.length) {
      const ins = unknowns.map((n) => ({
        airtable_id: `post-game:${crypto.randomUUID()}`,
        player_name: n,
        venues: venue.trim() ? [venue.trim()] : [],
        source: 'Post-game',
        synced_at: new Date().toISOString(),
      }))
      const { data: newRows } = await supabase.from('inbox_outreach').insert(ins).select('id, player_name, phone, beeper_chat_id, hidden')
      for (const r of (newRows as CrmRow[]) ?? []) {
        if (r.player_name) (byFull.get(normFull(r.player_name)) ?? byFull.set(normFull(r.player_name), []).get(normFull(r.player_name))!).push(r)
      }
      created = (newRows as CrmRow[] | null)?.length ?? 0
    }

    const createdSet = new Set(unknowns.map((n) => n.toLowerCase()))
    const built: Attendee[] = names.map((name) => {
      const m = findUnique(name)
      if (m === 'many') {
        return { name, player: null, status: 'ambiguous', channel: null, winner: false, message: genMessage(name, venue, false), include: false }
      }
      const player = m === 'none' ? null : m
      const route = player ? routeOf(player) : { status: 'nocontact' as RowStatus, channel: null }
      const status: RowStatus = createdSet.has(name.toLowerCase()) ? 'new' : route.status
      return {
        name,
        player,
        status,
        channel: route.channel,
        winner: false,
        message: genMessage(name, venue, false),
        include: !!route.channel,
      }
    })
    setRows(built)
    setBusy(false)
    setStatus(
      `Matched ${built.filter((r) => r.channel).length} reachable · ${built.filter((r) => r.status === 'nocontact' || r.status === 'new').length} no contact yet` +
        (created ? ` · added ${created} new to CRM` : '') +
        (built.some((r) => r.status === 'ambiguous') ? ` · ${built.filter((r) => r.status === 'ambiguous').length} ambiguous (skipped)` : ''),
    )
  }

  function patch(i: number, p: Partial<Attendee>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...p } : r)))
  }
  function toggleWinner(i: number) {
    setRows((prev) =>
      prev.map((r, idx) =>
        idx === i ? { ...r, winner: !r.winner, message: genMessage(r.name, venue, !r.winner) } : r,
      ),
    )
  }
  function reroll(i: number) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, message: genMessage(r.name, venue, r.winner) } : r)))
  }

  // Queue the included messages as an approved, non-outreach batch. The sync's
  // batch rail sends them (paced, per-channel) the moment Sends is un-paused —
  // and the global Sends pause still gates everything, so nothing leaves early.
  async function queue() {
    if (sendable.length === 0) return
    setBusy(true)
    setStatus('Queueing…')
    const label = `Post-game · ${venue.trim() || 'game'} · ${new Date().toISOString().slice(0, 10)}`
    const { data: batch, error: bErr } = await supabase
      .from('inbox_batches')
      .insert({
        name: label,
        status: 'approved',
        created_by: 'post-game',
        is_outreach: false,
        venue: venue.trim() || null,
        // Per-recipient text lives on each item; this is just a human label for
        // the batch (post-game messages are individually worded, not templated).
        template_body: '(post-game — uniquely worded per player)',
      })
      .select('id')
      .single()
    if (bErr || !batch) {
      setBusy(false)
      setStatus(`Error: ${bErr?.message ?? 'could not create batch'}`)
      return
    }
    const items = sendable.map((r) => ({
      batch_id: batch.id,
      rendered_text: r.message,
      status: 'approved' as const,
      data: {
        name: r.name,
        outreach_id: r.player?.id,
        channel: r.channel,
        ...(r.channel === 'thread' ? { beeper_chat_id: r.player?.beeper_chat_id } : {}),
        ...(r.channel === 'sms' ? { phone: r.player?.phone, account_id: 'gmessages' } : {}),
      },
    }))
    const { error: iErr } = await supabase.from('inbox_batch_items').insert(items)
    setBusy(false)
    if (iErr) return setStatus(`Error: ${iErr.message}`)
    setRows([])
    setRaw('')
    setStatus(`Queued ${items.length} message(s) as “${label}”. They send once Sends is un-paused.`)
  }

  return (
    <section className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
      <h3 className="text-base font-semibold text-emerald-900">Post-game thank-you</h3>
      <p className="mt-1 text-xs text-slate-500">
        Paste tonight's players (one per line). Unknown names are added to the CRM automatically. Each
        gets a uniquely-worded thanks (mark winners for a congrats), then it all goes to your normal
        approve-then-send queue. Auto-pull from LP / TD sheets drops in here once those are connected.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={venue}
          onChange={(e) => setVenue(e.target.value)}
          placeholder="Venue (e.g. Leederville)"
          className="w-48 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
        />
      </div>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder={'Chris O\'Brien\nJane Smith\nMick Taylor\n…'}
        className="mt-2 h-28 w-full rounded-md border border-slate-300 p-2 font-mono text-xs outline-none focus:border-emerald-500"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          disabled={busy || !raw.trim()}
          onClick={() => void build()}
          className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
        >
          Match &amp; add new
        </button>
        {status && <span className="text-xs text-slate-600">{status}</span>}
      </div>

      {rows.length > 0 && (
        <>
          <ul className="mt-3 space-y-2">
            {rows.map((r, i) => (
              <li key={i} className="rounded-md border border-slate-200 bg-white p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="checkbox"
                    checked={r.include}
                    disabled={!r.channel}
                    onChange={(e) => patch(i, { include: e.target.checked })}
                    title={r.channel ? 'Include in send' : 'No channel yet — can’t send'}
                  />
                  <span className="min-w-[8rem] text-sm font-medium">{r.name}</span>
                  <ChannelChip status={r.status} channel={r.channel} />
                  <label className="ml-auto flex items-center gap-1 text-xs text-amber-700">
                    <input type="checkbox" checked={r.winner} onChange={() => toggleWinner(i)} />
                    winner 🏆
                  </label>
                  <button onClick={() => reroll(i)} title="Reword" className="text-xs text-slate-400 hover:text-emerald-700">
                    ↻ reword
                  </button>
                </div>
                <textarea
                  value={r.message}
                  onChange={(e) => patch(i, { message: e.target.value })}
                  disabled={!r.channel}
                  className="mt-1 h-12 w-full rounded border border-slate-200 p-1.5 text-xs outline-none focus:border-emerald-500 disabled:bg-slate-50 disabled:text-slate-400"
                />
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center gap-3">
            <button
              disabled={busy || sendable.length === 0}
              onClick={() => void queue()}
              className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              Approve &amp; queue {sendable.length}
            </button>
            <span className="text-xs text-slate-500">
              {rows.filter((r) => !r.channel).length > 0 &&
                `${rows.filter((r) => !r.channel).length} have no channel yet (added to CRM, message them once they're reachable).`}
            </span>
          </div>
        </>
      )}
    </section>
  )
}

function ChannelChip({ status, channel }: { status: RowStatus; channel: 'thread' | 'sms' | null }) {
  if (channel === 'thread')
    return <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700">Messenger</span>
  if (channel === 'sms')
    return <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700">SMS</span>
  if (status === 'new')
    return <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">new · added to CRM</span>
  if (status === 'ambiguous')
    return <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] text-rose-700">ambiguous · skipped</span>
  return <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">no contact</span>
}
