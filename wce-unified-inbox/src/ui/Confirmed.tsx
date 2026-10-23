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
  const [openTonight, setOpenTonight] = useState(true)

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
    <div className="max-w-[760px]">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="m-0 flex-1 text-[13px] muted tnum">
          {rows.length} confirmed for tonight · replies + manual · staff &amp; hidden excluded.
        </p>
        <button onClick={() => { void load(); void loadGames() }} className="btn-quiet">Refresh</button>
      </div>

      {/* Tonight */}
      <div style={{ borderTop: '2px solid var(--color-divider)' }}>
        {loading ? (
          <p className="row m-0 py-3 text-[13px] muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="row m-0 py-3 text-[13px] muted">No confirmations yet.</p>
        ) : (
          <div className="row">
            <div className="grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold">Tonight</div>
                <div className="mt-0.5 truncate text-xs muted">{rows.map((r) => r.name).join(' · ')}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[20px] font-extrabold tnum">{rows.length}</span>
                <button className="btn-quiet" onClick={() => setOpenTonight((v) => !v)}>
                  {openTonight ? 'Hide' : 'Detail'}
                </button>
              </div>
            </div>
            {openTonight && (
              <ol className="m-0 list-none p-0 pb-3">
                {rows.map((r, i) => (
                  <li key={r.key} className="flex items-baseline gap-2 py-1 text-[13px]">
                    <span className="w-5 flex-none text-right text-xs muted-45 tnum">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate font-semibold">{r.name}</span>
                    {r.manual && <span className="tag tag-neutral text-[10px] uppercase">manual</span>}
                    {r.note && <span className="tag tag-accent text-[10px]">{r.note}</span>}
                    <span className="text-xs muted-45 tnum">
                      {r.ts ? new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
      <p className="m-0 mt-2.5 text-[11px] muted">
        RSVPs land from replies and the LetsPoker app in near-real-time.
      </p>

      {/* Manual entry */}
      <div className="mt-8">
        <div className="section-head">
          <span className="kicker">Add attendee manually</span>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-2">
          <div className="field min-w-[10rem] flex-1">
            <label>
              player name
              <input
                value={mName}
                onChange={(e) => setMName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void addManual() }}
                placeholder="Player name"
                className="input"
              />
            </label>
          </div>
          <div className="field">
            <label>
              venue
              <select value={mVenue} onChange={(e) => setMVenue(e.target.value)} className="input !w-36">
                <option value="">—</option>
                {VENUES.map((v) => (<option key={v} value={v}>{v}</option>))}
              </select>
            </label>
          </div>
          <div className="field">
            <label>
              type
              <select value={mType} onChange={(e) => setMType(e.target.value as 'cash' | 'tournament')} className="input !w-32">
                <option value="cash">cash</option>
                <option value="tournament">tournament</option>
              </select>
            </label>
          </div>
          <div className="field">
            <label>
              date
              <input type="date" value={mDate} onChange={(e) => setMDate(e.target.value)} className="input tnum" />
            </label>
          </div>
          <button onClick={() => void addManual()} disabled={!mName.trim()} className="btn btn-secondary text-[13px]">
            Add
          </button>
        </div>
        {status && (
          <p className="m-0 mt-2 text-xs font-semibold" style={{ color: 'var(--color-accent-700)' }}>{status}</p>
        )}
      </div>

      {/* Game history */}
      <div className="mt-8">
        <div className="section-head">
          <span className="kicker">Game history</span>
          <span className="text-xs muted tnum">{games.length}</span>
        </div>
        {games.length === 0 ? (
          <p className="m-0 py-3 text-[13px] muted">
            No games yet — they appear here as TD sheets get pulled (or add players manually above).
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {games.map((g) => {
              const cash = g.players.filter((p) => p.category === 'cash').length
              const tourney = g.players.filter((p) => p.category === 'tournament').length
              const winner = g.players.find((p) => p.winner)
              const open = openGame === g.key
              return (
                <li key={g.key} className="row">
                  <div className="grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-4 py-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold tnum">
                        {fmtDate(g.game_date)} · {g.venue || g.title || 'game'}
                      </div>
                      <div className="mt-0.5 truncate text-xs muted tnum">
                        {cash ? `${cash} cash` : ''}{cash && tourney ? ' · ' : ''}{tourney ? `${tourney} tourney` : ''}
                        {(cash || tourney) && winner ? ' · ' : ''}{winner ? `winner ${winner.name}` : ''}
                        {!cash && !tourney && !winner ? g.players.map((p) => p.name).join(' · ') : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-[20px] font-extrabold tnum">{g.players.length}</span>
                      <button className="btn-quiet" onClick={() => setOpenGame(open ? null : g.key)}>
                        {open ? 'Hide' : 'Detail'}
                      </button>
                    </div>
                  </div>
                  {open && (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 pb-3 text-[13px]">
                      {g.players.map((p, i) => (
                        <span key={i} className={p.winner ? 'font-semibold' : ''}>
                          {p.name}
                          <span className="muted-45">
                            {p.category === 'tournament' ? ' T' : p.category === 'cash' ? ' $' : ''}
                          </span>
                          {p.winner && <span className="tag tag-accent ml-1 text-[10px] uppercase">winner</span>}
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
    </div>
  )
}
