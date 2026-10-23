import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { VENUES } from './usePlayers'

interface Row {
  key: string
  name: string
  note: string | null
  ts: string | null
  manual?: boolean
}

// Raw shape of the joined replied-yes query (PostgREST embeds the conversation).
interface Raw {
  conversation_id: string
  sender_name: string | null
  reply_note: string | null
  timestamp: string
  conversation: { title: string | null; external_chat_id: string | null } | null
}

interface GamePlayer { name: string; category: string | null; winner: boolean }
interface Game { key: string; game_date: string | null; venue: string | null; title: string | null; players: GamePlayer[] }

const todayLocal = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Confirmed / attendance hub.
 *  - "Tonight": everyone the AI read as a "yes" reply in the last 18h (staff /
 *    hidden / banned excluded), plus anyone added by hand for today.
 *  - Manual entry: add an attendee to any game (stored as a manual row in
 *    inbox_td_attendees, so it also feeds the post-game tool + history).
 *  - "Game history": browse previous games' cash / tournament attendees pulled
 *    from the TD sheets, grouped by night, expandable.
 */
export function Confirmed() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [games, setGames] = useState<Game[]>([])
  const [openGame, setOpenGame] = useState<string | null>(null)

  // manual-entry form
  const [mName, setMName] = useState('')
  const [mVenue, setMVenue] = useState('')
  const [mType, setMType] = useState<'cash' | 'tournament'>('cash')
  const [mDate, setMDate] = useState(todayLocal())
  const [status, setStatus] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const since = new Date(Date.now() - 18 * 3600_000).toISOString()
    const { data } = await supabase
      .from('inbox_messages')
      .select(
        'conversation_id, sender_name, reply_note, timestamp, conversation:inbox_conversations!inner(title, external_chat_id)',
      )
      .eq('direction', 'inbound')
      .eq('reply_intent', 'yes')
      .gt('timestamp', since)
      .order('timestamp', { ascending: false })
    const { data: blocked } = await supabase
      .from('inbox_outreach')
      .select('beeper_chat_id')
      .or('staff.eq.true,hidden.eq.true,do_not_message.eq.true')
      .not('beeper_chat_id', 'is', null)
    const block = new Set((blocked ?? []).map((b) => b.beeper_chat_id as string))

    const seen = new Set<string>()
    const out: Row[] = []
    for (const m of (data as unknown as Raw[]) ?? []) {
      if (seen.has(m.conversation_id)) continue
      seen.add(m.conversation_id)
      if (m.conversation?.external_chat_id && block.has(m.conversation.external_chat_id)) continue
      out.push({
        key: m.conversation_id,
        name: (m.sender_name || m.conversation?.title || 'Player').trim(),
        note: (m.reply_note ?? '').trim() || null,
        ts: m.timestamp,
      })
    }
    // Fold in anyone added by hand for today.
    const { data: manual } = await supabase
      .from('inbox_td_attendees')
      .select('name, category')
      .eq('game_date', todayLocal())
      .like('sheet_id', 'manual:%')
    for (const m of manual ?? []) {
      if (out.some((r) => r.name.toLowerCase() === m.name.toLowerCase())) continue
      out.push({ key: `manual:${m.name}`, name: m.name, note: m.category, ts: null, manual: true })
    }
    setRows(out)
    setLoading(false)
  }

  async function loadGames() {
    const since = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10)
    const { data } = await supabase
      .from('inbox_td_attendees')
      .select('sheet_id, sheet_title, venue, game_date, name, is_winner, category')
      .gte('game_date', since)
      .order('game_date', { ascending: false })
    const map = new Map<string, Game>()
    for (const r of (data ?? []) as {
      sheet_id: string; sheet_title: string | null; venue: string | null
      game_date: string | null; name: string; is_winner: boolean; category: string | null
    }[]) {
      const key = `${r.game_date}|${r.venue ?? ''}`
      const g = map.get(key) ?? { key, game_date: r.game_date, venue: r.venue, title: r.sheet_title, players: [] }
      g.players.push({ name: r.name, category: r.category, winner: r.is_winner })
      map.set(key, g)
    }
    setGames([...map.values()])
  }

  useEffect(() => {
    void load()
    void loadGames()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])

  async function addManual() {
    const name = mName.trim()
    if (!name) return
    const venue = mVenue.trim()
    const { error } = await supabase.from('inbox_td_attendees').upsert(
      {
        sheet_id: `manual:${mDate}:${venue || 'game'}`,
        sheet_title: 'Manual entry',
        venue: venue || null,
        game_date: mDate,
        name,
        category: mType,
        is_winner: false,
        synced_at: new Date().toISOString(),
      },
      { onConflict: 'sheet_id,name', ignoreDuplicates: false },
    )
    if (error) {
      setStatus(`Error: ${error.message}`)
      return
    }
    setStatus(`Added ${name}${venue ? ' · ' + venue : ''} (${mType}).`)
    setMName('')
    void load()
    void loadGames()
    setTimeout(() => setStatus(null), 2500)
  }

  const fmtDate = (d: string | null) =>
    d ? new Date(d + 'T00:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '—'

  return (
    <div className="mx-auto h-full w-full max-w-2xl overflow-y-auto p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Confirmed &amp; attendance</h2>
        <button onClick={() => { void load(); void loadGames() }} className="text-sm text-emerald-700 hover:underline">
          Refresh
        </button>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        {rows.length} confirmed for tonight · replies + manual · staff &amp; hidden excluded.
      </p>

      {/* Tonight */}
      {loading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-400">No confirmations yet.</p>
      ) : (
        <ol className="space-y-1">
          {rows.map((r, i) => (
            <li key={r.key} className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
              <span className="w-5 text-right text-xs text-slate-400">{i + 1}</span>
              <span className="flex-1 font-medium">{r.name}</span>
              {r.manual && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">manual</span>}
              {r.note && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">{r.note}</span>}
              <span className="text-xs text-slate-400">
                {r.ts ? new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
              </span>
            </li>
          ))}
        </ol>
      )}

      {/* Manual entry */}
      <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <p className="mb-2 text-sm font-medium text-slate-700">Add attendee manually</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={mName}
            onChange={(e) => setMName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addManual() }}
            placeholder="Player name"
            className="min-w-[10rem] flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
          />
          <select value={mVenue} onChange={(e) => setMVenue(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
            <option value="">Venue…</option>
            {VENUES.map((v) => (<option key={v} value={v}>{v}</option>))}
          </select>
          <select value={mType} onChange={(e) => setMType(e.target.value as 'cash' | 'tournament')} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
            <option value="cash">cash</option>
            <option value="tournament">tournament</option>
          </select>
          <input type="date" value={mDate} onChange={(e) => setMDate(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
          <button onClick={() => void addManual()} disabled={!mName.trim()} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
            Add
          </button>
        </div>
        {status && <p className="mt-2 text-xs text-emerald-700">{status}</p>}
      </div>

      {/* Game history */}
      <h3 className="mb-2 mt-6 text-base font-semibold">Game history</h3>
      {games.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-400">
          No games yet — they appear here as TD sheets get pulled (or add players manually above).
        </p>
      ) : (
        <ul className="space-y-2">
          {games.map((g) => {
            const cash = g.players.filter((p) => p.category === 'cash').length
            const tourney = g.players.filter((p) => p.category === 'tournament').length
            const winner = g.players.find((p) => p.winner)
            const open = openGame === g.key
            return (
              <li key={g.key} className="rounded-lg border border-slate-200 bg-white">
                <button onClick={() => setOpenGame(open ? null : g.key)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
                  <span className="font-medium">{fmtDate(g.game_date)}</span>
                  <span className="text-slate-500">{g.venue || g.title || 'game'}</span>
                  <span className="ml-auto text-xs text-slate-400">
                    {g.players.length} players{cash ? ` · ${cash} cash` : ''}{tourney ? ` · ${tourney} tourney` : ''}
                  </span>
                  {winner && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">🏆 {winner.name}</span>}
                  <span className="text-slate-400">{open ? '▾' : '▸'}</span>
                </button>
                {open && (
                  <div className="flex flex-wrap gap-1.5 border-t border-slate-100 p-3">
                    {g.players.map((p, i) => (
                      <span key={i} className={`rounded-full px-2 py-0.5 text-xs ${p.winner ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>
                        {p.winner ? '🏆 ' : ''}{p.name}
                        {p.category === 'tournament' ? ' ·T' : p.category === 'cash' ? ' ·$' : ''}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
