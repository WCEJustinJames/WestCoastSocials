import { useState } from 'react'
import { usePlayers, mergeRows, phoneCore, normCore, sourceLabel, type PlayerRow as Row } from './usePlayers'
import { PlayerCard } from './PlayerRow'

const accent700 = { color: 'var(--color-accent-700)' }

/** Merge & Review tab — dedupe (region values + phone duplicates + manual merge)
 *  and work through the review queue of new / unreviewed contacts. */
export function MergeReview() {
  const p = usePlayers()
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false)
  // "Not the same" is a session-local dismissal: it hides the suggestion for
  // this visit only. Nothing is written — the pair is suggested again on the
  // next load, since there is no stored not-a-duplicate record.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const dismiss = (k: string) => setDismissed((prev) => new Set(prev).add(k))

  const reviewList = onlyUnreviewed
    ? p.filtered.filter((r) => !p.reviewed.has(r.id))
    : p.filtered

  const tag = (r: Row) => sourceLabel(r)

  const phoneGroups = p.dupGroups.slice(0, 50).filter((g) => !dismissed.has('ph:' + phoneCore(g[0].phone)))
  const nameGroups = p.nameDupGroups.slice(0, 40).filter((g) => !dismissed.has('nm:' + normCore(g[0].player_name ?? '')))

  /** One suggested-duplicate row: the candidate names (radio picks the keeper),
   * the match basis as a tag, the reason line, then merge / not-the-same. */
  const groupRow = (
    g: Row[],
    key: string,
    basis: string,
    reason: string,
    radioName: string,
    onMerge: () => void,
    dismissKey: string,
  ) => {
    const chosen = p.groupKeeper[key] ?? mergeRows(g).primary.id
    return (
      <li key={dismissKey} className="row py-4">
        <div className="flex flex-wrap items-baseline gap-2.5">
          {g.map((r, i) => (
            <span key={r.id} className="flex items-baseline gap-2.5">
              {i > 0 && <span className="text-xs" style={accent700}>↔</span>}
              <label className="flex cursor-pointer items-center gap-1.5 text-sm font-semibold" title="Keep this record's name / values">
                <input
                  type="radio"
                  className="checkbox"
                  name={radioName}
                  checked={chosen === r.id}
                  onChange={() => p.setGroupKeeper((prev) => ({ ...prev, [key]: r.id }))}
                />
                {r.player_name ?? '(no name)'}
              </label>
            </span>
          ))}
          <span className="tag tag-accent tag-net">{basis}</span>
        </div>
        <p className="m-0 mt-1 text-xs muted tnum">{reason}</p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button className="btn btn-primary !text-xs" onClick={onMerge} disabled={p.busy}>
            Merge — one player
          </button>
          <button
            className="btn btn-secondary !text-xs"
            onClick={() => dismiss(dismissKey)}
            title="Hide this suggestion for now — nothing is changed, and it returns on the next load"
          >
            Not the same
          </button>
        </div>
      </li>
    )
  }

  return (
    <div className="max-w-[760px]">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="m-0 min-w-0 flex-1 text-xs muted tnum">
          {p.rows.length} players · {p.dupGroups.length} phone-duplicate group(s) · {p.regions.length} region values
        </p>
        <button onClick={p.load} className="btn-quiet">Refresh</button>
      </div>
      {p.status && (
        <p className="mb-3 text-xs font-semibold" style={accent700}>{p.status}</p>
      )}

      {/* Suggested duplicates — phone matches, then name matches */}
      <section className="mb-8">
        <div className="section-head">
          <span className="kicker">Suggested duplicates</span>
          <span className="text-xs muted-45 tnum">
            {p.dupGroups.length} by phone · {p.nameDupGroups.length} by name
          </span>
        </div>
        {p.dupGroups.length > 0 && (
          <div className="mt-2.5">
            <button onClick={() => void p.mergeAllDuplicates()} disabled={p.busy} className="btn btn-secondary !text-xs">
              Merge all phone duplicates (auto-pick the most complete name)
            </button>
          </div>
        )}
        <ul className="m-0 list-none p-0">
          {phoneGroups.map((g) => {
            const key = phoneCore(g[0].phone)
            return groupRow(
              g,
              key,
              'same phone',
              `All saved under ${g[0].phone} — sources: ${g.map(tag).join(', ')}. Pick the name to keep.`,
              `grp-${key}`,
              () => void p.mergeOneGroup(g),
              'ph:' + key,
            )
          })}
          {nameGroups.map((g) => {
            const key = normCore(g[0].player_name ?? '')
            return groupRow(
              g,
              key,
              'same name',
              `Same cleaned name, different or missing phone — ${g.map((r) => r.phone ?? 'no phone').join(' / ')}. Check they're really the same person.`,
              `name-${key}`,
              () => void p.mergeNameGroup(g),
              'nm:' + key,
            )
          })}
          {phoneGroups.length === 0 && nameGroups.length === 0 && (
            <li className="py-3 text-sm muted">No duplicate suggestions right now.</li>
          )}
        </ul>
        {p.dupGroups.length > 50 && (
          <p className="mt-2 text-xs muted-45">
            Showing the first 50 phone groups — merge these, then Refresh for the next batch.
          </p>
        )}
        <p className="mt-3 text-xs muted">Merged identities share one thread history and one CRM record.</p>
      </section>

      {/* Tidy region/venue values */}
      <details className="mb-8">
        <summary className="cursor-pointer text-sm font-semibold">
          Tidy region / venue values ({p.regions.length})
        </summary>
        <p className="my-2 text-xs muted">
          Rename a value to merge variants — e.g. set “woodvale” and “the woodvale tavern” both to
          “Woodvale Tavern”. Applies to every player with that value.
        </p>
        <ul className="m-0 list-none p-0">
          {p.regionCounts.map(([region, count]) => (
            <li key={region} className="row flex items-center gap-3 py-1.5">
              <span className="w-10 flex-none text-right text-xs muted-45 tnum">{count}</span>
              <input
                defaultValue={region}
                onChange={(e) => p.setRenames((prev) => ({ ...prev, [region]: e.target.value }))}
                className="input flex-1"
              />
              <button onClick={() => void p.renameRegion(region)} disabled={p.busy} className="btn-quiet">
                Apply
              </button>
            </li>
          ))}
          {p.regions.length === 0 && <li className="py-2 text-sm muted">No region values yet.</li>}
        </ul>
      </details>

      {/* Review queue — search, tick 2+ to merge manually, or edit/triage inline */}
      <section>
        <div className="section-head">
          <span className="kicker">Review queue</span>
          <span className="text-xs muted-45 tnum">{reviewList.length} to review</span>
        </div>
        <div className="mb-2 mt-3 flex flex-wrap items-center gap-2">
          <input
            value={p.query}
            onChange={(e) => p.setQuery(e.target.value)}
            placeholder="Search to review (e.g. fb_unreviewed, messenger, a name)…"
            className="input min-w-[200px] flex-1"
          />
          <input
            list="review-region-list"
            value={p.regionFilter === 'all' ? '' : p.regionFilter}
            onChange={(e) => p.setRegionFilter(e.target.value.trim() || 'all')}
            placeholder="Region…"
            className="input !w-32"
          />
          <datalist id="review-region-list">
            {p.regions.map((r) => (<option key={r} value={r} />))}
          </datalist>
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
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="seg">
            <button
              className="seg-btn seg-btn-sm"
              aria-pressed={p.incompleteOnly}
              onClick={() => p.setIncompleteOnly(!p.incompleteOnly)}
              title="Records still missing contact / region / stakes / venue"
            >
              Incomplete
            </button>
            <button
              className="seg-btn seg-btn-sm"
              aria-pressed={p.noContactOnly}
              onClick={() => p.setNoContactOnly(!p.noContactOnly)}
              title="No phone or thread — collect their details in person"
            >
              No contact
            </button>
            <button
              className="seg-btn seg-btn-sm"
              aria-pressed={p.tournamentOnly}
              onClick={() => p.setTournamentOnly(!p.tournamentOnly)}
              title="Tournament players"
            >
              Tournament
            </button>
            <button
              className="seg-btn seg-btn-sm"
              aria-pressed={p.cashOnly}
              onClick={() => p.setCashOnly(!p.cashOnly)}
              title="Cash-game players"
            >
              Cash
            </button>
            <button
              className="seg-btn seg-btn-sm"
              aria-pressed={p.banOnly}
              onClick={() => p.setBanOnly(!p.banOnly)}
              title="Banned / opted out (do not message)"
            >
              Do not message
            </button>
            <button
              className="seg-btn seg-btn-sm"
              aria-pressed={p.staffOnly}
              onClick={() => p.setStaffOnly(!p.staffOnly)}
              title="Staff / dealers / crew"
            >
              Staff
            </button>
          </div>
          <div className="seg">
            <button className="seg-btn seg-btn-sm" aria-pressed={onlyUnreviewed} onClick={() => setOnlyUnreviewed(!onlyUnreviewed)}>
              Only unreviewed
            </button>
            <button className="seg-btn seg-btn-sm" aria-pressed={p.showHidden} onClick={() => p.setShowHidden(!p.showHidden)}>
              Show hidden
            </button>
          </div>
        </div>

        {/* Manual merge: tick 2+ of the same person, pick the correct name */}
        {p.selectedRows.length >= 2 && (
          <div className="mb-3 bg-surface px-3.5 py-3">
            <p className="m-0 mb-2 text-sm font-semibold tnum">
              Merge {p.selectedRows.length} selected — keep which name?
            </p>
            <div className="mb-2.5 flex flex-wrap gap-3">
              {p.selectedRows.map((r) => (
                <label key={r.id} className="flex cursor-pointer items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    className="checkbox"
                    name="keeper"
                    checked={p.keeperId === r.id}
                    onChange={() => p.setKeeperId(r.id)}
                  />
                  {r.player_name ?? '(no name)'}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void p.mergeSelected()}
                disabled={p.busy || !p.keeperId}
                className="btn btn-primary !text-xs"
              >
                Merge into “{p.selectedRows.find((r) => r.id === p.keeperId)?.player_name ?? '…'}”
              </button>
              <button onClick={() => { p.setSel(new Set()); p.setKeeperId(null) }} className="btn-quiet">
                Cancel
              </button>
            </div>
          </div>
        )}

        <ul className="m-0 list-none p-0" style={{ borderTop: '2px solid var(--color-divider)' }}>
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
                threadName={p.chatTitles.get(r.beeper_chat_id ?? '') ?? null}
              />
            )
          })}
        </ul>
        {reviewList.length > 300 && (
          <p className="mt-2 text-xs muted-45">Showing first 300 — narrow with search.</p>
        )}
      </section>
    </div>
  )
}
