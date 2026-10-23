import { useEffect, useMemo, useState } from 'react'
import { usePlayers, attKey, normCore, type SingleThread } from './usePlayers'
import { useVenues } from './useVenues'
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
 * "No contact" card jumps straight to the no-contact list). `search` is the
 * shell-owned "Search players" box — this screen renders no search input of
 * its own. */
export function Players({ initialFilter, search }: { initialFilter?: string | null; search?: string }) {
  const VENUES = useVenues()
  const p = usePlayers(initialFilter ?? undefined)
  // Mirror the shell's search box into the hook's query filter.
  const setQuery = p.setQuery
  useEffect(() => { setQuery(search ?? '') }, [search, setQuery])
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

  const segBtn = (label: string, pressed: boolean, toggle: () => void, title?: string) => (
    <button className="seg-btn seg-btn-sm" aria-pressed={pressed} onClick={toggle} title={title}>
      {label}
    </button>
  )

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="m-0 text-xs muted tnum">
          {p.rows.length} players · {p.regions.length} region values · {p.dupGroups.length} phone-duplicate group(s)
        </p>
        <div className="flex-1" />
        {p.dupGroups.length > 0 && (
          <button
            onClick={() => void p.mergePhoneDuplicates()}
            disabled={p.busy}
            title="Merge records that share a phone number when their names are compatible; clashing names are left for manual review"
            className="btn btn-secondary !text-xs tnum"
          >
            Auto-merge {p.dupGroups.length} shared-number duplicate(s)
          </button>
        )}
        <button onClick={p.load} className="btn-quiet">
          Refresh
        </button>
      </div>
      {p.status && (
        <p className="mb-3 text-xs font-semibold" style={{ color: 'var(--color-accent-700)' }}>{p.status}</p>
      )}

      <FbFriendsImporter p={p} />

      {/* Filters — the name search itself lives in the shell's sub-tab row */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          list="players-region-list"
          value={p.regionFilter === 'all' ? '' : p.regionFilter}
          onChange={(e) => p.setRegionFilter(e.target.value.trim() || 'all')}
          placeholder="Region…"
          className="input !w-36"
        />
        <datalist id="players-region-list">
          {p.regions.map((r) => (<option key={r} value={r} />))}
        </datalist>
        <select
          value={p.venueFilter}
          onChange={(e) => p.setVenueFilter(e.target.value)}
          title="Players who have actually played this venue (LP + TD attendance) or are tagged to it"
          className="input !w-auto"
        >
          <option value="all">All venues</option>
          {VENUES.map((v) => (<option key={v} value={v}>{v}</option>))}
        </select>
        <select
          value={p.sortMode}
          onChange={(e) => p.setSortMode(e.target.value as 'attention' | 'games' | 'recent')}
          title="Order: review workflow, most games played (all-time LP+TD), or most recently seen at a game"
          className="input !w-auto"
        >
          <option value="attention">Needs attention</option>
          <option value="games">Most games</option>
          <option value="recent">Recently seen</option>
        </select>
        <select
          value={p.sourceFilter}
          onChange={(e) => p.setSourceFilter(e.target.value)}
          title="Filter by where the contact came from"
          className="input !w-auto"
        >
          <option value="all">All sources</option>
          {p.sources.map(([s, n]) => (
            <option key={s} value={s}>{s} ({n})</option>
          ))}
        </select>
        <div className="seg">
          {segBtn('Tournament', p.tournamentOnly, () => p.setTournamentOnly(!p.tournamentOnly), 'Show only tournament players')}
          {segBtn('Cash', p.cashOnly, () => p.setCashOnly(!p.cashOnly), 'Show only cash-game players')}
          {segBtn('No contact', p.noContactOnly, () => p.setNoContactOnly(!p.noContactOnly), 'Players with no phone or thread — collect their details in person')}
          {segBtn('FB — DM to open', p.fbFriendOnly, () => p.setFbFriendOnly(!p.fbFriendOnly), 'Facebook friends with no thread yet — send one DM to open the conversation')}
          {segBtn(
            `First name only${p.firstNameOnlyCount ? ` (${p.firstNameOnlyCount})` : ''}`,
            p.firstNameOnly,
            () => p.setFirstNameOnly(!p.firstNameOnly),
            'Players we only have a first name for — work through and add surnames. Saving a surname drops the player from this list.',
          )}
          {segBtn(
            `Bad number${p.badNumberCount ? ` (${p.badNumberCount})` : ''}`,
            p.badNumberOnly,
            () => p.setBadNumberOnly(!p.badNumberOnly),
            'Numbers with the wrong digit count, or whose last SMS failed to send — fix or replace.',
          )}
          {segBtn('Show hidden', p.showHidden, () => p.setShowHidden(!p.showHidden))}
        </div>
      </div>
      <p className="mb-2 text-xs muted-45 tnum">{p.filtered.length} shown</p>

      <ul className="m-0 list-none p-0" style={{ borderTop: '2px solid var(--color-divider)' }}>
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
              onIcePlayer={p.icePlayer}
              sendFailed={p.failedSends.has(r.id)}
            />
          )
        })}
      </ul>
      {p.filtered.length > 300 && (
        <p className="mt-2 text-xs muted-45">Showing first 300 — narrow with search/filter.</p>
      )}
    </div>
  )
}

/**
 * Paste your Facebook friends list (the JSON from "Download Your Information →
 * Friends", or just one name per line). Cross-checks against every CRM name and
 * flags matches: a matched player with no thread yet shows a "FB — DM to open"
 * tag, turning a dead-end "no contact" into "just message him". Re-pasting an
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
    <details className="mb-4 text-sm">
      <summary className="cursor-pointer select-none text-sm font-semibold">
        Import Facebook friends
        {p.fbFriendCount > 0 && (
          <span className="ml-1.5 text-xs font-normal muted tnum">· {p.fbFriendCount} need a first DM</span>
        )}
      </summary>
      <p className="mt-2 text-xs muted">
        From your Facebook download open <em>connections_and_followers</em> and drag{' '}
        <em>your_friends.html</em> (or .json) onto the box below — or{' '}
        <label className="cursor-pointer font-semibold underline" style={{ color: 'var(--color-accent)' }}>
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
        className="input mt-2 h-28 font-mono !text-xs"
        style={drag ? { borderColor: 'var(--color-accent)' } : undefined}
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
          className="btn btn-secondary !text-xs"
        >
          Match &amp; flag
        </button>
        <button
          disabled={p.busy}
          onClick={async () => {
            const n = await p.clearFbFriends()
            setMsg(`Cleared ${n} FB flag(s).`)
          }}
          className="btn-quiet"
        >
          Clear all flags
        </button>
        {msg && (
          <span className="text-xs font-semibold tnum" style={{ color: 'var(--color-accent-700)' }}>{msg}</span>
        )}
      </div>
    </details>
  )
}
