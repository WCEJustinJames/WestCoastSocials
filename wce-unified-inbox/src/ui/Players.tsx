import { useMemo, useState } from 'react'
import { usePlayers, attKey, normCore, VENUES, type SingleThread } from './usePlayers'
import { PlayerCard } from './PlayerRow'

/**
 * Candidate Beeper threads for a player with no contact details, by name
 * similarity — looser than the auto-linker's exact-unique rule, because a
 * human confirms each link. Matches: same normalised name, one name a subset
 * of the other's words, or first name + surname initial.
 */
function threadCandidates(name: string | null, threads: { core: string; toks: string[]; t: SingleThread }[]): SingleThread[] {
  const core = normCore(name ?? '')
  if (core.length < 3) return []
  const toks = core.split(' ')
  const out: SingleThread[] = []
  for (const th of threads) {
    if (!th.core) continue
    let hit = th.core === core
    if (!hit && toks.length >= 2 && th.toks.length >= 1) {
      const sub = toks.every((x) => th.toks.includes(x)) || th.toks.every((x) => toks.includes(x))
      const initials =
        toks[0] === th.toks[0] &&
        toks.length >= 2 && th.toks.length >= 2 &&
        toks[toks.length - 1][0] === th.toks[th.toks.length - 1][0]
      hit = sub || initials
    }
    if (hit) out.push(th.t)
    if (out.length >= 3) break
  }
  return out
}

/** Players tab — the full contact list + per-player settings (browse / edit).
 * `initialFilter` lets the Home dashboard open this tab pre-filtered (e.g. the
 * "No contact" card jumps straight to the no-contact list). */
export function Players({ initialFilter }: { initialFilter?: string | null }) {
  const p = usePlayers(initialFilter ?? undefined)
  // Pre-normalise every 1:1 thread once; only threads not already linked to a
  // CRM row are offered as candidates.
  const linkedChats = useMemo(
    () => new Set(p.rows.map((r) => r.beeper_chat_id).filter(Boolean)),
    [p.rows],
  )
  const threadIndex = useMemo(
    () =>
      p.singleThreads
        .filter((t) => !linkedChats.has(t.chatId) && !/^[\d\s+()-]{6,}$/.test(t.title))
        .map((t) => ({ core: normCore(t.title), toks: normCore(t.title).split(' '), t })),
    [p.singleThreads, linkedChats],
  )
  return (
    <div className="mx-auto h-full w-full max-w-6xl overflow-y-auto p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Players (CRM)</h2>
        <button onClick={p.load} className="text-sm text-emerald-700 hover:underline">
          Refresh
        </button>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        {p.rows.length} players ·{' '}
        {p.regions.length} region values ·{' '}
        {p.dupGroups.length} phone-duplicate group(s) — clean up in Merge &amp; Review.
      </p>
      {p.status && <p className="mb-3 text-sm text-emerald-700">{p.status}</p>}

      <FbFriendsImporter p={p} />

      {/* Search + filters */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={p.query}
          onChange={(e) => p.setQuery(e.target.value)}
          placeholder="Search name, phone, status, region…"
          className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
        />
        <input
          list="players-region-list"
          value={p.regionFilter === 'all' ? '' : p.regionFilter}
          onChange={(e) => p.setRegionFilter(e.target.value.trim() || 'all')}
          placeholder="Region…"
          className="w-40 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
        />
        <datalist id="players-region-list">
          {p.regions.map((r) => (<option key={r} value={r} />))}
        </datalist>
        <select
          value={p.venueFilter}
          onChange={(e) => p.setVenueFilter(e.target.value)}
          title="Players who have actually played this venue (LP + TD attendance) or are tagged to it"
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
        >
          <option value="all">All venues</option>
          {VENUES.map((v) => (<option key={v} value={v}>{v}</option>))}
        </select>
        <select
          value={p.sortMode}
          onChange={(e) => p.setSortMode(e.target.value as 'attention' | 'games' | 'recent')}
          title="Order: review workflow, most games played (all-time LP+TD), or most recently seen at a game"
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
        >
          <option value="attention">Needs attention</option>
          <option value="games">Most games</option>
          <option value="recent">Recently seen</option>
        </select>
        <select
          value={p.sourceFilter}
          onChange={(e) => p.setSourceFilter(e.target.value)}
          title="Filter by where the contact came from"
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
        >
          <option value="all">All sources</option>
          {p.sources.map(([s, n]) => (
            <option key={s} value={s}>{s} ({n})</option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-purple-700" title="Show only tournament players">
          <input type="checkbox" checked={p.tournamentOnly} onChange={(e) => p.setTournamentOnly(e.target.checked)} />
          tournament
        </label>
        <label className="flex items-center gap-1 text-xs text-teal-700" title="Show only cash-game players">
          <input type="checkbox" checked={p.cashOnly} onChange={(e) => p.setCashOnly(e.target.checked)} />
          cash
        </label>
        <label className="flex items-center gap-1 text-xs text-amber-700" title="Players with no phone or thread — collect their details in person">
          <input type="checkbox" checked={p.noContactOnly} onChange={(e) => p.setNoContactOnly(e.target.checked)} />
          no contact
        </label>
        <label className="flex items-center gap-1 text-xs text-indigo-700" title="Facebook friends with no thread yet — send one DM to open the conversation">
          <input type="checkbox" checked={p.fbFriendOnly} onChange={(e) => p.setFbFriendOnly(e.target.checked)} />
          FB · DM to open
        </label>
        <label className="flex items-center gap-1 text-xs text-rose-700" title="Players we only have a first name for — work through and add surnames. Saving a surname drops the player from this list.">
          <input type="checkbox" checked={p.firstNameOnly} onChange={(e) => p.setFirstNameOnly(e.target.checked)} />
          first name only{p.firstNameOnlyCount ? ` (${p.firstNameOnlyCount})` : ''}
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-500">
          <input type="checkbox" checked={p.showHidden} onChange={(e) => p.setShowHidden(e.target.checked)} />
          show hidden
        </label>
      </div>
      <p className="mb-2 text-xs text-slate-400">{p.filtered.length} shown</p>

      <ul className="space-y-2">
        {p.filtered.slice(0, 300).map((r, i) => {
          const e = p.edits[r.id]
          if (!e) return null
          return (
            <PlayerCard
              key={r.id}
              r={r}
              e={e}
              setE={p.setE}
              busy={p.busy}
              isReviewed={p.reviewed.has(r.id)}
              onSave={p.savePlayer}
              onToggleHide={p.toggleHidePlayer}
              onUnmarkReviewed={p.unmarkReviewed}
              threadNetwork={p.chatNetworks.get(r.beeper_chat_id ?? '') ?? null}
              threadName={p.chatTitles.get(r.beeper_chat_id ?? '') ?? null}
              att={p.att.get(attKey(r.player_name)) ?? null}
              rank={p.sortMode === 'games' ? i + 1 : null}
              threadSuggestions={
                !r.beeper_chat_id && !r.phone ? threadCandidates(r.player_name, threadIndex) : []
              }
              onLinkThread={p.linkThread}
            />
          )
        })}
      </ul>
      {p.filtered.length > 300 && (
        <p className="mt-2 text-xs text-slate-400">Showing first 300 — narrow with search/filter.</p>
      )}
    </div>
  )
}

/**
 * Paste your Facebook friends list (the JSON from "Download Your Information →
 * Friends", or just one name per line). Cross-checks against every CRM name and
 * flags matches: a matched player with no thread yet shows a "FB · DM to open"
 * chip, turning a dead-end "no contact" into "just message him". Re-pasting an
 * updated list reconciles, so un-friended people clear automatically.
 */
function FbFriendsImporter({ p }: { p: ReturnType<typeof usePlayers> }) {
  const [raw, setRaw] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const readFile = (f?: File) => {
    if (!f) return
    const r = new FileReader()
    r.onload = () => {
      setRaw(String(r.result ?? ''))
      setMsg(`Loaded “${f.name}” — now click Match & flag.`)
    }
    r.readAsText(f)
  }
  return (
    <details className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-2 text-sm">
      <summary className="cursor-pointer select-none font-medium text-slate-700">
        Import Facebook friends
        {p.fbFriendCount > 0 && (
          <span className="ml-1 text-xs font-normal text-indigo-600">· {p.fbFriendCount} need a first DM</span>
        )}
      </summary>
      <p className="mt-2 text-xs text-slate-500">
        From your Facebook download open <em>connections_and_followers</em> and drag{' '}
        <em>your_friends.html</em> (or .json) onto the box below — or{' '}
        <label className="cursor-pointer font-medium text-indigo-600 hover:underline">
          choose a file
          <input
            type="file"
            accept=".json,.html,.htm,.txt"
            className="hidden"
            onChange={(e) => readFile(e.target.files?.[0])}
          />
        </label>
        , or paste names one per line. JSON or HTML both work — matching is by name, so review first.
      </p>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          readFile(e.dataTransfer.files?.[0])
        }}
        placeholder={'Drag your_friends.html / .json here — or paste names, one per line'}
        className={`mt-2 h-28 w-full rounded-md border p-2 font-mono text-xs outline-none focus:border-emerald-500 ${drag ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300'}`}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          disabled={p.busy || !raw.trim()}
          onClick={async () => {
            const r = await p.importFbFriends(raw)
            setMsg(
              `Read ${r.friends} friend name(s) · flagged ${r.flagged} CRM player(s)` +
                (r.cleared ? ` · cleared ${r.cleared} no longer on the list` : '') + '.',
            )
          }}
          className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          Match &amp; flag
        </button>
        <button
          disabled={p.busy}
          onClick={async () => {
            const n = await p.clearFbFriends()
            setMsg(`Cleared ${n} FB flag(s).`)
          }}
          className="text-xs text-slate-400 hover:text-rose-600"
        >
          Clear all flags
        </button>
        {msg && <span className="text-xs text-emerald-700">{msg}</span>}
      </div>
    </details>
  )
}
