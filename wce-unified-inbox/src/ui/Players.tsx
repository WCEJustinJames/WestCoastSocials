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
        {p.rows.length} players · {p.weeklyCount} on weekly list ·{' '}
        {p.regions.length} region values ·{' '}
        {p.dupGroups.length} phone-duplicate group(s) — clean up in Merge &amp; Review.
      </p>
      {p.status && <p className="mb-3 text-sm text-emerald-700">{p.status}</p>}

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
        <label className="flex items-center gap-1 text-xs text-emerald-700" title="Show only players on the recurring weekly cash send">
          <input type="checkbox" checked={p.weeklyOnly} onChange={(e) => p.setWeeklyOnly(e.target.checked)} />
          weekly list
        </label>
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
