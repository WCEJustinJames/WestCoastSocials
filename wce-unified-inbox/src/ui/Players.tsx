import { useState } from 'react'
import { usePlayers } from './usePlayers'
import { PlayerCard } from './PlayerRow'

/** Players tab — the full contact list + per-player settings (browse / edit). */
export function Players() {
  const p = usePlayers()
  return (
    <div className="mx-auto h-full w-full max-w-4xl overflow-y-auto p-6">
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
        <label className="flex items-center gap-1 text-xs text-slate-500">
          <input type="checkbox" checked={p.showHidden} onChange={(e) => p.setShowHidden(e.target.checked)} />
          show hidden
        </label>
      </div>
      <p className="mb-2 text-xs text-slate-400">{p.filtered.length} shown</p>

      <ul className="space-y-2">
        {p.filtered.slice(0, 300).map((r) => {
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
  return (
    <details className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-2 text-sm">
      <summary className="cursor-pointer select-none font-medium text-slate-700">
        Import Facebook friends
        {p.fbFriendCount > 0 && (
          <span className="ml-1 text-xs font-normal text-indigo-600">· {p.fbFriendCount} need a first DM</span>
        )}
      </summary>
      <p className="mt-2 text-xs text-slate-500">
        Facebook → Settings → <em>Download Your Information</em> → select only “Friends and followers” →
        Format JSON → download, then paste the file here. Or paste one name per line. Matching is by
        name, so it’s an indicator only — review before relying on it.
      </p>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder={"Chris O'Brien\nJane Smith\n…   (or paste the whole friends.json)"}
        className="mt-2 h-28 w-full rounded-md border border-slate-300 p-2 font-mono text-xs outline-none focus:border-emerald-500"
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
