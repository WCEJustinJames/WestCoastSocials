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
export function Home({ onNavigate }: { onNavigate: (filter: string | null) => void }) {
  return (
    <div className="mx-auto h-full w-full max-w-4xl overflow-y-auto p-6">
      <h2 className="mb-4 text-lg font-semibold">Home</h2>
      <DashboardCards onNavigate={onNavigate} />
      <SyncStatus />
      <PostGame />
    </div>
  )
}

// ----------------------------- dashboard cards ------------------------------

function DashboardCards({ onNavigate }: { onNavigate: (filter: string | null) => void }) {
  const [stats, setStats] = useState<{ players: number; noContact: number; fbDm: number; firstName: number } | null>(null)
  const [beat, setBeat] = useState<{ note: string | null; last: string | null } | null>(null)

  useEffect(() => {
    void (async () => {
      const head = { count: 'exact' as const, head: true }
      const [players, noContact, fbDm, firstName] = await Promise.all([
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
        // First-name-only: a name with no space (no surname), excluding the
        // nameless "Unknown" rows. Mirrors isFirstNameOnly in usePlayers.
        supabase
          .from('inbox_outreach')
          .select('id', head)
          .eq('hidden', false)
          .not('player_name', 'is', null)
          .neq('player_name', '')
          .not('player_name', 'ilike', '% %')
          .not('player_name', 'ilike', 'unknown'),
      ])
      setStats({
        players: players.count ?? 0,
        noContact: noContact.count ?? 0,
        fbDm: fbDm.count ?? 0,
        firstName: firstName.count ?? 0,
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
      <Stat label="Players" value={stats?.players} onClick={() => onNavigate(null)} />
      <Stat label="No contact" value={stats?.noContact} tone="amber" onClick={() => onNavigate('noContact')} />
      <Stat label="FB · DM to open" value={stats?.fbDm} tone="indigo" onClick={() => onNavigate('fbDm')} />
      <Stat label="First name only" value={stats?.firstName} tone="rose" onClick={() => onNavigate('firstName')} />
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="text-[11px] uppercase tracking-wide text-slate-400">Sync</div>
        <div className="mt-1 truncate text-sm font-semibold text-slate-700">{beat?.note ?? '—'}</div>
        <div className="text-[11px] text-slate-400">ran {ago(beat?.last ?? null)}</div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'slate',
  onClick,
}: {
  label: string
  value?: number
  tone?: 'slate' | 'amber' | 'indigo' | 'rose'
  onClick?: () => void
}) {
  const color =
    tone === 'amber' ? 'text-amber-700'
    : tone === 'indigo' ? 'text-indigo-700'
    : tone === 'rose' ? 'text-rose-700'
    : 'text-slate-800'
  const body = (
    <>
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${color}`}>{value ?? '—'}</div>
    </>
  )
  if (onClick) {
    return (
      <button
        onClick={onClick}
        title={`Open ${label} in Players →`}
        className="rounded-lg border border-slate-200 bg-white p-3 text-left transition hover:border-emerald-400 hover:shadow-sm"
      >
        {body}
        <div className="mt-0.5 text-[10px] text-emerald-600">work through →</div>
      </button>
    )
  }
  return <div className="rounded-lg border border-slate-200 bg-white p-3">{body}</div>
}

// ------------------------------ live sync panel -----------------------------

/** Live freshness of each integration: green = up to date, amber = overdue, red =
 * stale, grey = not run yet. Reads anon-safe timestamps only (heartbeats + the
 * sync_freshness view, which exposes last-run times with no secrets). */
function SyncStatus() {
  const [items, setItems] = useState<{ label: string; tone: 'ok' | 'warn' | 'bad' | 'off'; status: string }[]>([])
  useEffect(() => {
    void (async () => {
      const now = Date.now()
      const secs = (iso?: string | null) => (iso ? Math.floor((now - new Date(iso).getTime()) / 1000) : null)
      const rel = (s: number) =>
        s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
      const grade = (
        s: number | null,
        freshSecs: number,
        okWord = 'up to date',
      ): { tone: 'ok' | 'warn' | 'bad' | 'off'; status: string } =>
        s == null
          ? { tone: 'off', status: 'not run yet' }
          : s < freshSecs
            ? { tone: 'ok', status: okWord }
            : s < freshSecs * 8
              ? { tone: 'warn', status: `${rel(s)} ago` }
              : { tone: 'bad', status: `${rel(s)} ago · stale` }

      const { data: hbs } = await supabase.from('inbox_sync_heartbeat').select('id, last_run').in('id', [1, 2])
      const hb = (id: number) => ((hbs ?? []).find((h) => h.id === id)?.last_run ?? null) as string | null
      const fresh = supabase as unknown as {
        from: (t: string) => {
          select: (c: string) => Promise<{ data: { integration: string; last_run: string | null }[] | null }>
        }
      }
      const fr = await fresh.from('sync_freshness').select('integration, last_run')
      const frv = (k: string) => (fr.data ?? []).find((r) => r.integration === k)?.last_run ?? null

      setItems([
        { label: 'Sync engine', ...grade(secs(hb(1)), 120) },
        { label: 'LetsPoker', ...grade(secs(frv('letspoker')), 2 * 86400, 'synced') },
        { label: 'Google Contacts', ...grade(secs(frv('contacts')), 26 * 3600, 'synced') },
        { label: 'TD Sheets', ...grade(secs(hb(2)), 90 * 60) },
      ])
    })()
  }, [])

  const dot = (t: 'ok' | 'warn' | 'bad' | 'off') =>
    t === 'ok' ? 'bg-emerald-500' : t === 'warn' ? 'bg-amber-500' : t === 'bad' ? 'bg-rose-500' : 'bg-slate-300'
  const txt = (t: 'ok' | 'warn' | 'bad' | 'off') =>
    t === 'ok' ? 'text-emerald-600' : t === 'warn' ? 'text-amber-600' : t === 'bad' ? 'text-rose-600' : 'text-slate-400'

  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-400">Live sync</div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {items.map((it) => (
          <div key={it.label} className="flex items-center gap-2 text-sm">
            <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${dot(it.tone)} ${it.tone === 'ok' ? 'animate-pulse' : ''}`} />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-slate-700">{it.label}</span>{' '}
              <span className={`text-xs ${txt(it.tone)}`}>{it.status}</span>
            </span>
          </div>
        ))}
      </div>
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

interface TdGame {
  sheet_id: string
  title: string
  venue: string
  game_date: string | null
  entries: { name: string; winner: boolean }[]
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
  const [tdGames, setTdGames] = useState<TdGame[]>([])

  // Attendees the sync pulled from recent TD sheets, grouped per game.
  useEffect(() => {
    void (async () => {
      const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)
      const { data } = await supabase
        .from('inbox_td_attendees')
        .select('sheet_id, sheet_title, venue, game_date, name, is_winner')
        .gte('game_date', since)
        .order('game_date', { ascending: false })
      const groups = new Map<string, TdGame>()
      for (const r of (data ?? []) as {
        sheet_id: string; sheet_title: string | null; venue: string | null
        game_date: string | null; name: string; is_winner: boolean
      }[]) {
        const g =
          groups.get(r.sheet_id) ??
          { sheet_id: r.sheet_id, title: r.sheet_title ?? r.venue ?? 'game', venue: r.venue ?? '', game_date: r.game_date, entries: [] }
        g.entries.push({ name: r.name, winner: r.is_winner })
        groups.set(r.sheet_id, g)
      }
      setTdGames([...groups.values()])
    })()
  }, [])

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
  // Core matcher — shared by the paste box and the TD-sheet pull. Takes a list of
  // {name, winner}, dedupes, matches each to a CRM record (creating unknowns as
  // no-contact rows), and builds the editable review list. venueArg is passed
  // explicitly so the TD loader isn't bitten by stale `venue` state.
  async function buildFrom(entries: { name: string; winner: boolean }[], venueArg = venue) {
    const map = new Map<string, { name: string; winner: boolean }>()
    for (const e of entries) {
      const n = e.name.trim()
      if (!n) continue
      const k = n.toLowerCase()
      const prev = map.get(k)
      if (!prev) map.set(k, { name: n, winner: e.winner })
      else if (e.winner) prev.winner = true
    }
    const list = [...map.values()]
    if (list.length === 0) {
      setStatus('Add at least one attendee name.')
      return
    }
    const v = venueArg.trim()
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
    const unknowns = list.map((e) => e.name).filter((n) => findUnique(n) === 'none')
    let created = 0
    if (unknowns.length) {
      const ins = unknowns.map((n) => ({
        airtable_id: `post-game:${crypto.randomUUID()}`,
        player_name: n,
        venues: v ? [v] : [],
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
    const built: Attendee[] = list.map(({ name, winner }) => {
      const m = findUnique(name)
      if (m === 'many') {
        return { name, player: null, status: 'ambiguous', channel: null, winner, message: genMessage(name, v, winner), include: false }
      }
      const player = m === 'none' ? null : m
      const route = player ? routeOf(player) : { status: 'nocontact' as RowStatus, channel: null }
      const status: RowStatus = createdSet.has(name.toLowerCase()) ? 'new' : route.status
      return {
        name,
        player,
        status,
        channel: route.channel,
        winner,
        message: genMessage(name, v, winner),
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

  function build() {
    const names = raw.split(/\n+/).map((l) => l.replace(/\(.*?\)\s*$/, '').trim()).filter(Boolean)
    void buildFrom(names.map((name) => ({ name, winner: false })))
  }

  function loadTd(g: TdGame) {
    setVenue(g.venue)
    void buildFrom(g.entries, g.venue)
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

      {tdGames.length > 0 && (
        <div className="mt-3 rounded-md border border-emerald-200 bg-white p-2">
          <p className="mb-1 text-xs font-medium text-slate-600">From TD sheets — tap to load that night's players:</p>
          <div className="flex flex-wrap gap-2">
            {tdGames.map((g) => (
              <button
                key={g.sheet_id}
                disabled={busy}
                onClick={() => loadTd(g)}
                className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-800 hover:bg-emerald-100 disabled:opacity-40"
              >
                {g.title} · {g.entries.length} players{g.entries.some((e) => e.winner) ? ' · 🏆' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

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
