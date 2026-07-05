import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { normFull, normCore, VENUES } from './usePlayers'
import { ActionQueue } from './ActionQueue'
import { SendQueue } from './SendQueue'
import { Financials } from './Financials'
import { SheetCoverage } from './SheetCoverage'
import { SeatMonitor } from './SeatMonitor'

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
export function Home({
  onNavigate,
  onOpenConversation,
  onFillSeats,
}: {
  onNavigate: (filter: string | null) => void
  onOpenConversation: (conversationId: string) => void
  onFillSeats: (listId: string | null, venue: string | null) => void
}) {
  return (
    <div className="mx-auto h-full w-full max-w-6xl overflow-y-auto p-6">
      <h2 className="mb-4 text-lg font-semibold">Home</h2>
      <SendQueue />
      <ActionQueue onOpen={onOpenConversation} />
      <SeatMonitor onFill={onFillSeats} />
      <Financials />
      <SheetCoverage />
      <DashboardCards onNavigate={onNavigate} />
      <FifoDue onOpen={onOpenConversation} />
      <WinBack onOpen={onOpenConversation} />
      <PlayerContext onOpen={onOpenConversation} />
      <PostGame />
    </div>
  )
}

// ---------------------------- FIFO due-back panel ----------------------------

interface FifoRow {
  outreach_id: string
  player_name: string
  conversation_id: string | null
  games: number
  last_game: string
  avg_away: number | null
  due_around: string
  away_days: number
}

/**
 * FIFO (fly-in/fly-out) players projected to be back in town around now, from
 * their LP/TD attendance cadence — so you can re-invite them the moment their
 * roster brings them home. Reads inbox_fifo_due; shows overdue + due-this-week,
 * each one click into their thread.
 */
function FifoDue({ onOpen }: { onOpen: (conversationId: string) => void }) {
  const [rows, setRows] = useState<FifoRow[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const v = supabase as unknown as {
      from: (t: string) => { select: (c: string) => Promise<{ data: FifoRow[] | null }> }
    }
    v.from('inbox_fifo_due')
      .select('outreach_id, player_name, conversation_id, games, last_game, avg_away, due_around, away_days')
      .then(({ data }) => {
        setRows(data ?? [])
        setLoading(false)
      })
  }, [])

  const todayN = Math.floor(Date.now() / 86_400_000)
  const fmt = (iso: string): string =>
    new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  // Due back this week or already overdue, and currently away.
  const due = rows
    .filter((r) => r.away_days >= 7 && dayNum(r.due_around) <= todayN + 7)
    .sort((a, b) => (a.due_around < b.due_around ? -1 : 1))
  if (loading || due.length === 0) return null

  return (
    <div className="mb-6">
      <h3 className="mb-1 text-sm font-semibold text-slate-700">✈ FIFO players due back</h3>
      <p className="mb-2 text-xs text-slate-400">
        {due.length} fly-in/out {due.length === 1 ? 'player is' : 'players are'} due back around now — good time to re-invite.
      </p>
      <ul className="space-y-1">
        {due.map((r) => {
          const overdue = dayNum(r.due_around) < todayN
          return (
            <li key={r.outreach_id}>
              <button
                onClick={() => r.conversation_id && onOpen(r.conversation_id)}
                disabled={!r.conversation_id}
                title={r.conversation_id ? 'Open their thread to re-invite' : 'No thread linked yet'}
                className="flex w-full items-center gap-2 rounded-md border border-sky-200 bg-sky-50/50 px-3 py-2 text-left text-sm transition enabled:hover:border-sky-400 enabled:hover:shadow-sm disabled:cursor-default"
              >
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${
                    overdue ? 'bg-amber-500 text-white' : 'bg-sky-600 text-white'
                  }`}
                >
                  {overdue ? `overdue ${todayN - dayNum(r.due_around)}d` : 'due ▸'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{r.player_name}</span>
                  <span className="ml-1 text-xs text-slate-500">
                    due ~{fmt(r.due_around)} · away {r.away_days}d · {r.games} games, ~{r.avg_away ?? '?'}d spells
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ----------------------------- win-back panel ------------------------------

interface LapsedRow {
  outreach_id: string
  player_name: string
  conversation_id: string | null
  phone: string | null
  beeper_chat_id: string | null
  last_seen: string
  days_since_last: number
  baseline_games: number
  recent_games: number
  prominent_night: string | null
  prominent_venue: string | null
  favourite_event: string | null
  total_winnings: number | string | null
  lifetime_entries: number | null
}

/**
 * "Win back" — players who used to play LetsPoker regularly and have gone quiet:
 * a sharp drop over a rolling 90-day window vs the prior ~6 months, unseen 30+
 * days. Reads inbox_lapsing_regulars, where every row is already a reachable,
 * non-excluded contact (no staff/banned/hidden/FIFO/on-ice, not just messaged),
 * so each one is a real customer worth a personal re-invite before they're gone.
 * Click opens their thread when one exists; phone-only players show an SMS chip
 * (their number is in the tooltip — reach them from Batches). Highest-ROI save.
 */
function WinBack({ onOpen }: { onOpen: (conversationId: string) => void }) {
  const [rows, setRows] = useState<LapsedRow[]>([])
  const [loading, setLoading] = useState(true)
  // Rows Justin has actioned this session drop off the list (local, not saved).
  const [done, setDone] = useState<Set<string>>(new Set())
  useEffect(() => {
    const v = supabase as unknown as {
      from: (t: string) => { select: (c: string) => Promise<{ data: LapsedRow[] | null }> }
    }
    v.from('inbox_lapsing_regulars')
      .select(
        'outreach_id, player_name, conversation_id, phone, beeper_chat_id, last_seen, days_since_last, baseline_games, recent_games, prominent_night, prominent_venue, favourite_event, total_winnings, lifetime_entries',
      )
      .then(({ data }) => {
        setRows(data ?? [])
        setLoading(false)
      })
  }, [])

  // "47d" while it still reads as days, otherwise round to months.
  const fmtGone = (days: number): string => (days < 60 ? `${days}d` : `${Math.round(days / 30)}mo`)
  // total_winnings is numeric → PostgREST returns it as a string; coerce.
  const money = (n: number | string | null): string | null => {
    const v = Number(n)
    return v > 0 ? `$${Math.round(v).toLocaleString()}` : null
  }

  const visible = rows.filter((r) => !done.has(r.outreach_id))
  if (loading || visible.length === 0) return null

  return (
    <div className="mb-6">
      <h3 className="mb-1 text-sm font-semibold text-slate-700">🎣 Win back — lapsed regulars</h3>
      <p className="mb-2 text-xs text-slate-400">
        {visible.length} former {visible.length === 1 ? 'regular has' : 'regulars have'} gone quiet — a
        personal note now is the best save.
      </p>
      <ul className="space-y-1">
        {visible.map((r) => {
          const where = [
            r.prominent_night,
            r.prominent_venue && r.prominent_venue !== 'Other/Unknown' ? r.prominent_venue : null,
          ]
            .filter(Boolean)
            .join(' · ')
          const won = money(r.total_winnings)
          return (
            <li key={r.outreach_id} className="flex items-stretch gap-1">
              <button
                onClick={() => r.conversation_id && onOpen(r.conversation_id)}
                disabled={!r.conversation_id}
                title={
                  r.conversation_id
                    ? 'Open their thread to re-invite'
                    : r.phone
                      ? `No thread yet — text ${r.phone} (or reach them from Batches)`
                      : 'No thread linked yet'
                }
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2 text-left text-sm transition enabled:hover:border-amber-400 enabled:hover:shadow-sm disabled:cursor-default"
              >
                <span className="shrink-0 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] text-white">
                  {r.recent_games === 0 ? 'gone' : 'fading'} {fmtGone(r.days_since_last)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{r.player_name}</span>
                  <span className="ml-1 text-xs text-slate-500">
                    was ~{r.baseline_games} games/6mo, now {r.recent_games || 'none'}
                    {where ? ` · ${where}` : ''}
                    {won ? ` · ${won} won` : ''}
                  </span>
                </span>
                {!r.conversation_id && r.phone && (
                  <span className="shrink-0 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700">
                    SMS
                  </span>
                )}
              </button>
              <button
                onClick={() => setDone((s) => new Set(s).add(r.outreach_id))}
                title="Dismiss for now (back next reload)"
                className="shrink-0 rounded-md px-1.5 text-slate-300 hover:text-slate-600"
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// --------------------------- player context panel ---------------------------

interface ContextRow {
  conversation_id: string
  player_name: string
  outreach_id: string | null
  reply_intent: 'no' | 'maybe'
  reply_note: string | null
  reply_text: string
  replied_at: string
  back_on: string | null
  fifo: boolean
  note: string | null
  snooze_until: string | null
}

interface PatternInfo {
  games: number
  first: string
  last: string
  sinceLast: number
  avgAway: number
  maxGap: number
  visits: number
  status: 'in town' | 'away' | 'unknown'
  dueAround: string | null
}
const dayNum = (iso: string): number => Math.floor(new Date(iso + 'T00:00:00').getTime() / 86_400_000)
const addDays = (iso: string, n: number): string =>
  new Date((dayNum(iso) + n) * 86_400_000).toISOString().slice(0, 10)
/**
 * Infer a fly-in/fly-out pattern from a player's attendance dates: cluster games
 * into "visits" separated by away spells (gaps > 10 days), and report whether
 * they're currently in town or away, plus a rough due-back from their typical
 * away length. Needs ≥2 games to say anything about cadence.
 */
function analyzeAttendance(isoDates: string[]): PatternInfo | null {
  const days = Array.from(new Set(isoDates.filter(Boolean))).sort()
  if (days.length === 0) return null
  const nums = days.map(dayNum)
  const last = days[days.length - 1]
  const sinceLast = Math.floor(Date.now() / 86_400_000) - nums[nums.length - 1]
  const gaps: number[] = []
  for (let i = 1; i < nums.length; i++) gaps.push(nums[i] - nums[i - 1])
  const away = gaps.filter((g) => g > 10)
  const avgAway = away.length ? Math.round(away.reduce((a, b) => a + b, 0) / away.length) : 0
  const maxGap = gaps.length ? Math.max(...gaps) : 0
  const status: PatternInfo['status'] = days.length < 2 ? 'unknown' : sinceLast > 10 ? 'away' : 'in town'
  const dueAround = status === 'away' && avgAway ? addDays(last, avgAway) : null
  return { games: days.length, first: days[0], last, sinceLast, avgAway, maxGap, visits: 1 + away.length, status, dueAround }
}

/**
 * "Who's out" — players whose most recent reply was a decline / maybe, with the
 * reason and any return date they gave ("back first week of July", "away in
 * Thailand for a month", "works night shifts"), so Justin knows who to re-invite
 * and when. Reads inbox_player_context (latest no/maybe per thread, minus anyone
 * who's since said yes). Throwaway one-liners ("Ah bugger") are filtered out so
 * only replies that actually carry context show.
 */
function PlayerContext({ onOpen }: { onOpen: (conversationId: string) => void }) {
  const [rows, setRows] = useState<ContextRow[]>([])
  const [loading, setLoading] = useState(true)
  // Players actioned this session (added to a list / on ice / resolved) drop off.
  const [handled, setHandled] = useState<Set<string>>(new Set())
  // Which row's contact label is being edited, + the draft text.
  const [labelDraft, setLabelDraft] = useState<{ id: string; text: string } | null>(null)
  // Expanded FIFO attendance pattern (which row, loading, computed info).
  const [pattern, setPattern] = useState<{ id: string; loading: boolean; info: PatternInfo | null } | null>(null)
  // Per-row "added to <list>" confirmations (so add-to-list applies in place).
  const [added, setAdded] = useState<Record<string, string>>({})

  useEffect(() => {
    const v = supabase as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          gt: (col: string, val: string) => {
            order: (col: string, o: { ascending: boolean }) => {
              limit: (n: number) => Promise<{ data: ContextRow[] | null }>
            }
          }
        }
      }
    }
    const since = new Date(Date.now() - 45 * 86_400_000).toISOString()
    v.from('inbox_player_context')
      .select('conversation_id, player_name, outreach_id, reply_intent, reply_note, reply_text, replied_at, back_on, fifo, note, snooze_until')
      .gt('replied_at', since)
      .order('replied_at', { ascending: false })
      .limit(40)
      .then(({ data }) => {
        setRows(data ?? [])
        setLoading(false)
      })
  }, [])

  const today = new Date().toISOString().slice(0, 10)
  const isReady = (r: ContextRow): boolean => !!r.back_on && r.back_on <= today

  // Keep replies that carry context: a return date, a note, or a non-trivial body
  // (drops "Ah bugger" / "All good"). Players whose return date has passed — ready
  // to re-invite — sort to the very top; otherwise most recent first.
  const shown = useMemo(() => {
    const keep = rows.filter(
      (r) => !!r.back_on || (r.reply_note ?? '').trim() !== '' || (r.reply_text ?? '').trim().length >= 14,
    )
    return keep.sort((a, b) => {
      const ar = (a.back_on && a.back_on <= today ? 0 : 1)
      const br = (b.back_on && b.back_on <= today ? 0 : 1)
      if (ar !== br) return ar - br
      return a.replied_at < b.replied_at ? 1 : -1
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  const ago = (iso: string): string => {
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`
  }
  const fmtBack = (iso: string): string =>
    new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

  const plusDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  // Re-segment a player onto a venue's cash/tourney outreach (merges the venue,
  // flags the game type) so the next batch for that venue picks them up.
  async function addToList(r: ContextRow, venue: string, type: 'cash' | 'tournament') {
    if (!r.outreach_id) return
    const { data } = await supabase.from('inbox_outreach').select('venues').eq('id', r.outreach_id).maybeSingle()
    const venues = Array.from(new Set([...(((data?.venues as string[] | null) ?? [])), venue]))
    const patch = type === 'cash' ? { venues, cash: true } : { venues, tournament: true }
    await supabase.from('inbox_outreach').update(patch).eq('id', r.outreach_id)
    // Apply in place (don't dismiss) — show a running confirmation of what's added.
    const label = `${venue} ${type === 'cash' ? 'cash' : 'tourney'}`
    setAdded((a) => ({
      ...a,
      [r.conversation_id]: [a[r.conversation_id], label].filter(Boolean).join(', '),
    }))
  }
  // Park a player from outreach until a date (the send guard skips them till then).
  // Applies in place + shades the row; "✓ resolved" is what removes the entry.
  async function onIce(r: ContextRow, until: string) {
    if (!r.outreach_id) return
    await supabase.from('inbox_outreach').update({ snooze_until: until }).eq('id', r.outreach_id)
    setRows((rs) => rs.map((x) => (x.conversation_id === r.conversation_id ? { ...x, snooze_until: until } : x)))
  }
  // Mark this entry resolved — dismiss it for good (until they reply again).
  async function resolve(r: ContextRow) {
    await supabase
      .from('inbox_conversations')
      .update({ context_resolved_at: new Date().toISOString() })
      .eq('id', r.conversation_id)
    setHandled((s) => new Set(s).add(r.conversation_id))
  }
  // Flag / unflag a fly-in-fly-out worker (doesn't dismiss — stays so you can
  // explore their pattern). Optimistic so the chip flips immediately.
  async function toggleFifo(r: ContextRow) {
    if (!r.outreach_id) return
    const next = !r.fifo
    await supabase.from('inbox_outreach').update({ fifo: next }).eq('id', r.outreach_id)
    setRows((rs) => rs.map((x) => (x.conversation_id === r.conversation_id ? { ...x, fifo: next } : x)))
  }
  // Edit the player's contact label (the free note that carries venue/cash tags).
  async function saveLabel(r: ContextRow, text: string) {
    if (!r.outreach_id) return
    await supabase.from('inbox_outreach').update({ notes: text.trim() || null }).eq('id', r.outreach_id)
    setRows((rs) => rs.map((x) => (x.conversation_id === r.conversation_id ? { ...x, note: text.trim() || null } : x)))
    setLabelDraft(null)
  }
  // Pull this player's full TD + LP attendance and infer their fly-in/out pattern.
  async function loadPattern(r: ContextRow) {
    setPattern({ id: r.conversation_id, loading: true, info: null })
    const rpc = supabase as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: { d: string }[] | null }>
    }
    const { data } = await rpc.rpc('player_attendance', { p_name: r.player_name })
    setPattern({ id: r.conversation_id, loading: false, info: analyzeAttendance((data ?? []).map((x) => x.d)) })
  }

  const visible = shown.filter((r) => !handled.has(r.conversation_id))
  if (loading || visible.length === 0) return null
  const readyCount = visible.filter(isReady).length

  return (
    <div className="mb-6">
      <h3 className="mb-1 text-sm font-semibold text-slate-700">Who&apos;s out — reasons &amp; when they&apos;re back</h3>
      <p className="mb-2 text-xs text-slate-400">
        {visible.length} recently said they can&apos;t make it
        {readyCount > 0 ? ` · ${readyCount} ready to re-invite` : ''}. Tap a name to open their thread. Add to a
        list, set a return date, edit the label — it all applies in place; only ✓ resolved clears the entry.
      </p>
      <ul className="space-y-1">
        {visible.map((r) => {
          const ready = isReady(r)
          const iced = !!r.snooze_until && r.snooze_until > today
          return (
            <li
              key={r.conversation_id}
              className={`rounded-md border px-3 py-2 ${
                iced
                  ? 'border-rose-200 bg-rose-50/70 opacity-80'
                  : ready
                    ? 'border-emerald-300 bg-emerald-50/60'
                    : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex items-start gap-2">
                <button
                  onClick={() => onOpen(r.conversation_id)}
                  title="Open this player's thread to message them"
                  className="flex min-w-0 flex-1 items-start gap-2 text-left text-sm"
                >
                  <span
                    className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${
                      ready
                        ? 'bg-emerald-600 text-white'
                        : r.reply_intent === 'no'
                          ? 'bg-rose-100 text-rose-700'
                          : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {ready ? 're-invite ▸' : r.reply_intent === 'no' ? "can't make it" : 'maybe'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{r.player_name}</span>
                    {r.fifo && (
                      <span className="ml-1 rounded bg-sky-100 px-1 text-[9px] font-medium text-sky-700" title="Fly-in/fly-out worker">
                        ✈ FIFO
                      </span>
                    )}
                    {r.reply_note ? (
                      <span className="ml-1 text-emerald-700">— {r.reply_note}</span>
                    ) : (
                      <span className="ml-1 italic text-slate-500">— “{r.reply_text.trim()}”</span>
                    )}
                    {r.back_on && (
                      <span className="ml-1 whitespace-nowrap text-xs text-slate-400">(back {fmtBack(r.back_on)})</span>
                    )}
                  </span>
                </button>
                <span className="shrink-0 text-xs text-slate-400">{ago(r.replied_at)}</span>
              </div>
              {(iced || added[r.conversation_id]) && (
                <div className="mt-1 flex flex-wrap items-center gap-2 pl-1 text-[11px]">
                  {iced && (
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 font-medium text-rose-700">
                      ❄ on ice until {fmtBack(r.snooze_until!)} — off invites till then
                    </span>
                  )}
                  {added[r.conversation_id] && (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700">
                      ✓ added to {added[r.conversation_id]}
                    </span>
                  )}
                </div>
              )}
              {r.outreach_id && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-1 text-[11px]">
                  <select
                    value=""
                    onChange={(ev) => {
                      const v = ev.target.value
                      if (!v) return
                      const [venue, type] = v.split('|') as [string, 'cash' | 'tournament']
                      void addToList(r, venue, type)
                    }}
                    title="Add this player to a venue's cash or tournament outreach"
                    className="rounded border border-slate-200 px-1 py-0.5 text-[11px] text-slate-600"
                  >
                    <option value="">＋ add to game list…</option>
                    {VENUES.map((vn) => (
                      <optgroup key={vn} label={vn}>
                        <option value={`${vn}|cash`}>{vn} · cash</option>
                        <option value={`${vn}|tournament`}>{vn} · tourney</option>
                      </optgroup>
                    ))}
                  </select>
                  <select
                    value=""
                    onChange={(ev) => {
                      const v = ev.target.value
                      if (!v) return
                      void onIce(r, v === 'back' && r.back_on ? r.back_on : plusDays(Number(v)))
                    }}
                    title="Put on ice — skip proactive outreach until this date"
                    className="rounded border border-slate-200 px-1 py-0.5 text-[11px] text-slate-600"
                  >
                    <option value="">❄ on ice…</option>
                    <option value="7">1 week</option>
                    <option value="14">2 weeks</option>
                    <option value="30">1 month</option>
                    <option value="60">2 months</option>
                    {r.back_on && <option value="back">until {fmtBack(r.back_on)} (their date)</option>}
                  </select>
                  <label
                    className="inline-flex items-center gap-1 text-[11px] text-slate-500"
                    title="On ice until an exact date — held off invites until then"
                  >
                    ❄ until
                    <input
                      type="date"
                      value={r.snooze_until ?? ''}
                      onChange={(ev) => ev.target.value && void onIce(r, ev.target.value)}
                      className="rounded border border-slate-200 px-1 py-0.5 text-[11px] text-slate-600"
                    />
                  </label>
                  {labelDraft?.id === r.conversation_id ? (
                    <span className="inline-flex items-center gap-1">
                      <input
                        autoFocus
                        value={labelDraft.text}
                        onChange={(ev) => setLabelDraft({ id: r.conversation_id, text: ev.target.value })}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter') void saveLabel(r, labelDraft.text)
                          if (ev.key === 'Escape') setLabelDraft(null)
                        }}
                        placeholder="contact label / note"
                        className="w-40 rounded border border-slate-300 px-1 py-0.5 text-[11px]"
                      />
                      <button onClick={() => void saveLabel(r, labelDraft.text)} className="text-emerald-700 hover:underline">save</button>
                      <button onClick={() => setLabelDraft(null)} className="text-slate-400 hover:underline">×</button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setLabelDraft({ id: r.conversation_id, text: r.note ?? '' })}
                      title="Edit this player's contact label / note"
                      className="rounded border border-slate-200 px-1 py-0.5 text-slate-600 hover:border-slate-300"
                    >
                      ✎ {r.note ? <span className="text-slate-500">{r.note}</span> : 'label'}
                    </button>
                  )}
                  <button
                    onClick={() => void toggleFifo(r)}
                    title="Mark as fly-in/fly-out (FIFO) worker"
                    className={`rounded border px-1 py-0.5 ${
                      r.fifo ? 'border-sky-400 bg-sky-50 text-sky-700' : 'border-slate-200 text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    ✈ FIFO{r.fifo ? ' ✓' : ''}
                  </button>
                  <button
                    onClick={() => (pattern?.id === r.conversation_id ? setPattern(null) : void loadPattern(r))}
                    title="Explore their TD-sheet + LetsPoker attendance for a fly-in/out pattern"
                    className="rounded border border-slate-200 px-1 py-0.5 text-slate-600 hover:border-slate-300"
                  >
                    📊 pattern
                  </button>
                  <button
                    onClick={() => void resolve(r)}
                    title="Resolved — dismiss from this panel for good"
                    className="ml-auto rounded border border-slate-200 px-1 py-0.5 text-slate-500 hover:border-emerald-300 hover:text-emerald-700"
                  >
                    ✓ resolved
                  </button>
                </div>
              )}
              {pattern?.id === r.conversation_id && (
                <div className="mt-1.5 rounded bg-slate-50 px-2 py-1.5 text-[11px] text-slate-600">
                  {pattern.loading ? (
                    'Reading TD + LP attendance…'
                  ) : !pattern.info ? (
                    'No TD/LP attendance on record for this name.'
                  ) : (
                    <div className="space-y-0.5">
                      <div>
                        <span className="font-medium">{pattern.info.games}</span> games · {pattern.info.first} → {pattern.info.last} ·
                        last seen {pattern.info.sinceLast}d ago
                      </div>
                      {pattern.info.games >= 2 && (
                        <div>
                          {pattern.info.visits} visits · away spells avg ~{pattern.info.avgAway || '—'}d (longest{' '}
                          {pattern.info.maxGap}d)
                        </div>
                      )}
                      <div>
                        status:{' '}
                        <span
                          className={
                            pattern.info.status === 'away' ? 'font-medium text-amber-700' : 'font-medium text-emerald-700'
                          }
                        >
                          {pattern.info.status}
                          {pattern.info.status === 'away' ? ` ${pattern.info.sinceLast}d` : ''}
                        </span>
                        {pattern.info.dueAround &&
                          ` · due back ~${pattern.info.dueAround}${
                            dayNum(pattern.info.dueAround) < Math.floor(Date.now() / 86_400_000)
                              ? ' (overdue — good time to invite)'
                              : ''
                          }`}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
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
          .eq('do_not_message', false) // banned: no point chasing their number
          .is('phone', null)
          .is('beeper_chat_id', null),
        // FB · DM to open — verified players only (in TD/LP attendance).
        (supabase as unknown as {
          from: (t: string) => { select: (c: string, o: typeof head) => Promise<{ count: number | null }> }
        }).from('inbox_fb_dm_verified').select('id', head),
        // First-name-only: a name with no space (no surname), excluding the
        // nameless "Unknown" rows. Mirrors isFirstNameOnly in usePlayers.
        supabase
          .from('inbox_outreach')
          .select('id', head)
          .eq('hidden', false)
          .eq('do_not_message', false)
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
