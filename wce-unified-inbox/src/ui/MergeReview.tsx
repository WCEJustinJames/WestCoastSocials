import { useState } from 'react'
import { usePlayers, mergeRows, phoneCore, type PlayerRow as Row } from './usePlayers'
import { PlayerCard } from './PlayerRow'

/** Merge & Review tab — dedupe (region values + phone duplicates + manual merge)
 *  and work through the review queue of new / unreviewed contacts. */
export function MergeReview() {
  const p = usePlayers()
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false)
  const reviewList = onlyUnreviewed
    ? p.filtered.filter((r) => !p.reviewed.has(r.id))
    : p.filtered

  const tag = (r: Row) =>
    r.airtable_id.startsWith('gcsv:') || r.airtable_id.startsWith('gcontact:') ? 'google'
      : r.airtable_id.startsWith('receipt:') ? 'receipt'
        : r.airtable_id.startsWith('fb:') ? 'messenger'
          : r.airtable_id.startsWith('thread:') ? 'thread' : 'airtable'

  return (
    <div className="mx-auto h-full w-full max-w-4xl overflow-y-auto p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Merge &amp; Review</h2>
        <button onClick={p.load} className="text-sm text-emerald-700 hover:underline">
          Refresh
        </button>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        {p.rows.length} players · {p.dupGroups.length} phone-duplicate group(s) · {p.regions.length} region values.
      </p>
      {p.status && <p className="mb-3 text-sm text-emerald-700">{p.status}</p>}

      {/* Tidy region/venue values */}
      <details className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Tidy region / venue values ({p.regions.length})
        </summary>
        <p className="my-2 text-xs text-slate-500">
          Rename a value to merge variants — e.g. set “woodvale” and “the woodvale tavern” both to
          “Woodvale Tavern”. Applies to every player with that value.
        </p>
        <ul className="space-y-1">
          {p.regionCounts.map(([region, count]) => (
            <li key={region} className="flex items-center gap-2">
              <span className="w-10 text-right text-xs text-slate-400">{count}</span>
              <input
                defaultValue={region}
                onChange={(e) => p.setRenames((prev) => ({ ...prev, [region]: e.target.value }))}
                className="flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
              />
              <button
                onClick={() => void p.renameRegion(region)}
                disabled={p.busy}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-40"
              >
                Apply
              </button>
            </li>
          ))}
          {p.regions.length === 0 && <li className="text-sm text-slate-400">No region values yet.</li>}
        </ul>
      </details>

      {/* Merge duplicates — pick the name to keep per group */}
      {p.dupGroups.length > 0 && (
        <details className="mb-4 rounded-lg border border-slate-200 bg-white p-3" open>
          <summary className="cursor-pointer text-sm font-medium">
            Phone duplicates ({p.dupGroups.length}) — pick the correct name, then Merge
          </summary>
          <button
            onClick={() => void p.mergeAllDuplicates()}
            disabled={p.busy}
            className="my-2 rounded-md border border-slate-300 px-3 py-1 text-xs hover:bg-slate-100 disabled:opacity-40"
          >
            Merge all (auto-pick the most complete name)
          </button>
          <ul className="space-y-2">
            {p.dupGroups.slice(0, 50).map((g) => {
              const key = phoneCore(g[0].phone)
              const chosen = p.groupKeeper[key] ?? mergeRows(g).primary.id
              return (
                <li key={key} className="rounded border border-slate-100 p-2">
                  <div className="mb-1 text-xs text-slate-400">{g[0].phone}</div>
                  <div className="flex flex-wrap items-center gap-3">
                    {g.map((r) => (
                      <label key={r.id} className="flex items-center gap-1 text-sm">
                        <input
                          type="radio"
                          name={`grp-${key}`}
                          checked={chosen === r.id}
                          onChange={() => p.setGroupKeeper((prev) => ({ ...prev, [key]: r.id }))}
                        />
                        {r.player_name ?? '(no name)'}
                        <span className="text-[10px] text-slate-400">{tag(r)}</span>
                      </label>
                    ))}
                    <button
                      onClick={() => void p.mergeOneGroup(g)}
                      disabled={p.busy}
                      className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                    >
                      Merge
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
          {p.dupGroups.length > 50 && (
            <p className="mt-1 text-xs text-slate-400">
              Showing first 50 — merge these, then Refresh for the next batch.
            </p>
          )}
        </details>
      )}

      {/* Review queue — search, tick 2+ to merge manually, or edit/triage inline */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={p.query}
          onChange={(e) => p.setQuery(e.target.value)}
          placeholder="Search to review (e.g. fb_unreviewed, messenger, a name)…"
          className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
        />
        <input
          list="review-region-list"
          value={p.regionFilter === 'all' ? '' : p.regionFilter}
          onChange={(e) => p.setRegionFilter(e.target.value.trim() || 'all')}
          placeholder="Region…"
          className="w-32 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
        />
        <datalist id="review-region-list">
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
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex items-center gap-1 text-xs text-rose-700" title="Records still missing contact / region / stakes / venue">
          <input type="checkbox" checked={p.incompleteOnly} onChange={(e) => p.setIncompleteOnly(e.target.checked)} />
          incomplete
        </label>
        <label className="flex items-center gap-1 text-xs text-amber-700" title="No phone or thread — collect their details in person">
          <input type="checkbox" checked={p.noContactOnly} onChange={(e) => p.setNoContactOnly(e.target.checked)} />
          no contact
        </label>
        <label className="flex items-center gap-1 text-xs text-emerald-700" title="On the recurring weekly cash send">
          <input type="checkbox" checked={p.weeklyOnly} onChange={(e) => p.setWeeklyOnly(e.target.checked)} />
          weekly
        </label>
        <label className="flex items-center gap-1 text-xs text-purple-700" title="Tournament players">
          <input type="checkbox" checked={p.tournamentOnly} onChange={(e) => p.setTournamentOnly(e.target.checked)} />
          tournament
        </label>
        <label className="flex items-center gap-1 text-xs text-teal-700" title="Cash-game players">
          <input type="checkbox" checked={p.cashOnly} onChange={(e) => p.setCashOnly(e.target.checked)} />
          cash
        </label>
        <label className="flex items-center gap-1 text-xs text-red-700" title="Banned / opted out (do not message)">
          <input type="checkbox" checked={p.banOnly} onChange={(e) => p.setBanOnly(e.target.checked)} />
          ban
        </label>
        <label className="flex items-center gap-1 text-xs text-indigo-700" title="Staff / dealers / crew">
          <input type="checkbox" checked={p.staffOnly} onChange={(e) => p.setStaffOnly(e.target.checked)} />
          staff
        </label>
        <span className="mx-1 hidden h-4 w-px bg-slate-200 sm:block" />
        <label className="flex items-center gap-1 text-xs text-slate-500">
          <input type="checkbox" checked={onlyUnreviewed} onChange={(e) => setOnlyUnreviewed(e.target.checked)} />
          only unreviewed
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-500">
          <input type="checkbox" checked={p.showHidden} onChange={(e) => p.setShowHidden(e.target.checked)} />
          show hidden
        </label>
      </div>
      <p className="mb-2 text-xs text-slate-400">{reviewList.length} to review</p>

      {/* Manual merge: tick 2+ of the same person, pick the correct name */}
      {p.selectedRows.length >= 2 && (
        <div className="mb-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3">
          <p className="mb-2 text-sm font-medium">
            Merge {p.selectedRows.length} selected — keep which name?
          </p>
          <div className="mb-2 flex flex-wrap gap-3">
            {p.selectedRows.map((r) => (
              <label key={r.id} className="flex items-center gap-1 text-sm">
                <input
                  type="radio"
                  name="keeper"
                  checked={p.keeperId === r.id}
                  onChange={() => p.setKeeperId(r.id)}
                />
                {r.player_name ?? '(no name)'}
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void p.mergeSelected()}
              disabled={p.busy || !p.keeperId}
              className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              Merge into “{p.selectedRows.find((r) => r.id === p.keeperId)?.player_name ?? '…'}”
            </button>
            <button
              onClick={() => { p.setSel(new Set()); p.setKeeperId(null) }}
              className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ul className="space-y-2">
        {reviewList.slice(0, 300).map((r) => {
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
              showSelect
              selected={p.sel.has(r.id)}
              onToggleSel={p.toggleSel}
              threadNetwork={p.chatNetworks.get(r.beeper_chat_id ?? '') ?? null}
            />
          )
        })}
      </ul>
      {reviewList.length > 300 && (
        <p className="mt-2 text-xs text-slate-400">Showing first 300 — narrow with search.</p>
      )}
    </div>
  )
}
