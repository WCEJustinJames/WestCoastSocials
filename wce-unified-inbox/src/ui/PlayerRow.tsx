import { useState } from 'react'
import { REGIONS, STAKES, sourceLabel, phoneStatus, phoneStatusLabel, type Edit, type PlayerRow as Row } from './usePlayers'
import { useVenues } from './useVenues'

/** "messaged 3d ago" / "never messaged" from a last_contacted date. */
function sinceLabel(iso: string | null): string {
  if (!iso) return 'never messaged'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'messaged today'
  if (days === 1) return 'messaged 1d ago'
  if (days < 30) return `messaged ${days}d ago`
  return `messaged ${Math.floor(days / 30)}mo ago`
}

/** Short "added 30 Jun" label for a newly-imported contact's added_at date. */
function addedLabel(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `added ${d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`
}
/** How many days ago a contact was added (for highlighting the freshest imports). */
function addedDaysAgo(iso: string | null): number | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return Math.floor((Date.now() - d.getTime()) / 86_400_000)
}

const accent700 = { color: 'var(--color-accent-700)' }

interface PlayerCardProps {
  r: Row
  e: Edit
  setE: (id: string, patch: Partial<Edit>) => void
  busy: boolean
  isReviewed: boolean
  onSave: (id: string) => void
  onToggleHide: (id: string, hidden: boolean) => void
  onUnmarkReviewed: (id: string) => void
  // Merge selection is only shown on the Merge & Review tab.
  showSelect?: boolean
  selected?: boolean
  onToggleSel?: (id: string) => void
  // Real network of this player's linked Beeper thread (so we don't label an SMS
  // thread "Messenger"). e.g. 'Google Messages', 'Facebook/Messenger'.
  threadNetwork?: string | null
  // The linked thread's saved title (the contact's full name in Messenger / the
  // phone) — surfaced as context when the bare player_name is missing a surname.
  threadName?: string | null
  // Attendance scoring (full LP+TD history) + frequency rank when ranked.
  att?: { games: number; tourney_games: number; cash_games: number; last_seen: string | null } | null
  rank?: number | null
  // Candidate Beeper threads for a no-contact player (name-similarity matches
  // the strict auto-linker won't touch) — human confirms with one tap.
  threadSuggestions?: { chatId: string; title: string; network: string }[]
  onLinkThread?: (id: string, chatId: string) => void
  // Put a player on ice (snooze) for N days, or un-ice with days=0.
  onIcePlayer?: (id: string, days: number) => void
  // The player's last SMS batch send failed (dead/wrong number).
  sendFailed?: boolean
}

/** One editable player record. Shared by the Players list and the review queue.
 * Collapsed: a row — name+number / meta / channel tags + quiet actions. "Edit"
 * expands the full editor; every field and flag from before is still there. */
export function PlayerCard({
  r, e, setE, busy, isReviewed,
  onSave, onToggleHide, onUnmarkReviewed,
  showSelect = false, selected = false, onToggleSel,
  threadNetwork = null, threadName = null,
  att = null, rank = null,
  threadSuggestions = [], onLinkThread,
  onIcePlayer, sendFailed = false,
}: PlayerCardProps) {
  const VENUES = useVenues()
  const [open, setOpen] = useState(false)
  // Bad-number flag: invalid digit count (from the edited value so it updates
  // as you type) or a failed SMS send on record.
  const pStatus = phoneStatus(e.phone)
  const badLen = pStatus === 'short' || pStatus === 'long'
  const numberFlag = badLen ? phoneStatusLabel[pStatus] : sendFailed ? 'last SMS failed — check the number' : ''
  const stakeArr = e.stakes.split(',').map((s) => s.trim()).filter(Boolean)
  const venueArr = e.venues.split(',').map((s) => s.trim()).filter(Boolean)
  // Captured context the structured fields don't show yet — the thread's saved
  // name (often the full name), the original contact label (carries venue / cash
  // tags like "Abel cash kingsley"), and any free note ("Skimpy"). Surfacing it
  // lets you see who someone is and fill in the gaps. A fuller saved name gets a
  // one-tap "use" to drop it straight into the name field.
  const nameKey = e.player_name.trim().toLowerCase().replace(/[^a-z]/g, '')
  const savedName = (threadName ?? '').trim()
  const fullerSaved =
    savedName && /\s/.test(savedName) && savedName.toLowerCase().replace(/[^a-z]/g, '') !== nameKey
      ? savedName
      : ''
  const contactLabel = (r.beeper_contact_name ?? '').trim()
  const showContact = contactLabel && contactLabel.toLowerCase().replace(/[^a-z]/g, '') !== nameKey
  const noteText = (r.notes ?? '').trim()
  // A linked Beeper thread is only "Messenger" when its network actually is —
  // most are SMS (Google Messages). Resolve the real channel from the network.
  const isMsgrThread = !!r.beeper_chat_id && /messenger|facebook|instagram/i.test(threadNetwork ?? '')
  const isSmsThread = !!r.beeper_chat_id && /google messages|sms|messages|rcs/i.test(threadNetwork ?? '')
  const otherNetwork =
    !!r.beeper_chat_id && !isMsgrThread && !isSmsThread ? (threadNetwork || null) : null
  const hasSms = !!e.phone.trim() || isSmsThread
  const hasThread = isMsgrThread
  // Freshly-imported contacts (added_at set by a contacts upload) get a date label
  // so the latest import reads at a glance; the newest (≤14d) are emphasised.
  const added = addedLabel(r.added_at)
  const addedFresh = (addedDaysAgo(r.added_at) ?? 99) <= 14
  // "On ice" = snoozed to a future date — flagged in the meta wherever it appears
  // (matches the Who's-out panel + Lists), so parked players read at a glance.
  const onIce = !!r.snooze_until && r.snooze_until >= new Date().toISOString().slice(0, 10)
  const displayName = e.player_name.trim() || savedName || r.phone || '(unnamed)'
  return (
    <li className={`row row-hover ${r.hidden ? 'opacity-60' : ''}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-x-3 gap-y-1 py-3 [grid-template-areas:'name_channel'_'meta_meta'] dt:grid-cols-[200px_minmax(0,1fr)_max-content] dt:gap-x-5 dt:[grid-template-areas:'name_meta_channel']">
        {/* — name + number — */}
        <div className="flex min-w-0 items-start gap-2 [grid-area:name]">
          {showSelect && (
            <input
              type="checkbox"
              className="checkbox mt-0.5"
              title="Select to merge"
              checked={selected}
              onChange={() => onToggleSel?.(r.id)}
            />
          )}
          <div className="min-w-0">
            <p className="m-0 truncate text-sm font-semibold leading-tight">{displayName}</p>
            {(e.phone.trim() || fullerSaved) && (
              <p className="m-0 mt-0.5 truncate text-[11px] muted-50 tnum">{e.phone.trim() || fullerSaved}</p>
            )}
          </div>
        </div>

        {/* — meta: whatever exists — */}
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-xs muted [grid-area:meta]">
          {rank != null && <span className="tnum" title="frequency rank in this view">#{rank}</span>}
          <span
            className={r.last_contacted ? 'tnum' : 'font-semibold'}
            style={r.last_contacted ? undefined : accent700}
            title={r.last_contacted ? `last messaged ${r.last_contacted}` : 'no message sent yet'}
          >
            {sinceLabel(r.last_contacted)}
          </span>
          {att && (
            <span
              className="tnum"
              title={`${att.games} game night(s) all-time — ${att.tourney_games} tourney / ${att.cash_games} cash — last seen ${att.last_seen ?? '?'}`}
            >
              {att.games} games · {att.tourney_games}T/{att.cash_games}C
              {att.last_seen ? ` · ${new Date(att.last_seen).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}` : ''}
            </span>
          )}
          {venueArr.length > 0 && <span className="min-w-0">{venueArr.join(', ')}</span>}
          {e.region && <span>{e.region}</span>}
          <span title={r.source ? `Source: ${r.source}` : `Source: ${sourceLabel(r)}`}>{sourceLabel(r)}</span>
          {e.tournament && <span title="Tournament player">tourney</span>}
          {e.cash && <span title="Cash-game player">cash</span>}
          {e.whale && <span title="Whale — priority customer">whale</span>}
          {e.fifo && <span title="FIFO worker — fly-in/fly-out">fifo</span>}
          {e.staff && <span title="Staff — excluded from player outreach">staff</span>}
          {r.fb_friend && !hasThread && !hasSms && !otherNetwork && (
            <span title="Facebook friend, no thread yet — one Messenger DM opens the conversation">FB friend</span>
          )}
          {added && (
            <span
              className={addedFresh ? 'font-semibold tnum' : 'tnum'}
              style={addedFresh ? accent700 : undefined}
              title={`Added to the CRM on ${r.added_at?.slice(0, 10)}`}
            >
              {added}
            </span>
          )}
          {onIce && (
            <span className="font-semibold tnum" style={accent700} title={`On ice until ${r.snooze_until}`}>
              on ice until {r.snooze_until?.slice(0, 10)}
            </span>
          )}
          {numberFlag && (
            <span className="font-semibold" style={accent700}>
              bad number — {numberFlag}
            </span>
          )}
        </div>

        {/* — channel + quiet actions — */}
        <div className="flex flex-wrap items-center justify-end gap-1.5 [grid-area:channel]">
          {/* Channels this player is reachable on. Both shown as tags; the
              preferred one is highlighted. Default to Messenger/FB (some players
              only have FB, no number yet) — tap to switch once they share a
              number and rapport builds. */}
          {hasSms && hasThread ? (
            <>
              <button
                type="button"
                title="Prefer Messenger/FB for this player (default) — Save to keep"
                onClick={() => setE(r.id, { preferred_channel: 'thread' })}
                className={`tag tag-net cursor-pointer border-0 ${e.preferred_channel !== 'sms' ? 'tag-accent' : 'tag-neutral'}`}
              >
                {isMsgrThread ? 'Messenger' : threadNetwork || 'Thread'}
              </button>
              <button
                type="button"
                title="Prefer SMS for this player (once you have their number) — Save to keep"
                onClick={() => setE(r.id, { preferred_channel: 'sms' })}
                className={`tag tag-net cursor-pointer border-0 ${e.preferred_channel === 'sms' ? 'tag-accent' : 'tag-neutral'}`}
              >
                SMS
              </button>
            </>
          ) : hasThread ? (
            <span className="tag tag-neutral tag-net">Messenger</span>
          ) : hasSms ? (
            <span className="tag tag-neutral tag-net">SMS</span>
          ) : otherNetwork ? (
            <span className="tag tag-neutral tag-net">{otherNetwork}</span>
          ) : r.fb_friend ? (
            <span
              className="tag tag-neutral tag-net"
              title="Facebook friend, no thread yet — send one Messenger message to open the conversation; it links to this record automatically on the next sync."
            >
              FB — DM to open
            </span>
          ) : (
            <span className="tag tag-neutral tag-net">No contact</span>
          )}
          {e.do_not_message && <span className="tag tag-outline tag-net">Do not message</span>}
          {isReviewed && (
            <button type="button" className="btn-quiet" title="Reviewed — click to clear" onClick={() => onUnmarkReviewed(r.id)}>
              reviewed
            </button>
          )}
          <button className="btn-quiet" onClick={() => void onSave(r.id)} disabled={busy}>
            Save
          </button>
          <button className="btn-quiet" onClick={() => setOpen((o) => !o)}>
            {open ? 'Close' : 'Edit'}
          </button>
          <button className="btn-quiet" onClick={() => void onToggleHide(r.id, r.hidden)} title={r.hidden ? 'Unhide' : 'Hide from lists'}>
            {r.hidden ? 'Unhide' : 'Hide'}
          </button>
        </div>
      </div>

      {threadSuggestions.length > 0 && onLinkThread && (
        <div className="-mt-1 mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 bg-surface px-2.5 py-1.5 text-[11px]">
          <span className="font-semibold" style={accent700}>possible thread match:</span>
          {threadSuggestions.map((s) => (
            <span key={s.chatId} className="flex items-baseline gap-1.5">
              <span className="font-semibold">{s.title}</span>
              <span className="muted-50">· {s.network}</span>
              <button
                onClick={() => onLinkThread(r.id, s.chatId)}
                disabled={busy}
                title="Link this thread to the player — they become reachable from Batches/Inbox"
                className="btn-quiet !text-[11px]"
              >
                Link
              </button>
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="mb-3 flex flex-col gap-3 bg-surface px-3 py-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="field w-52">
              <label>Name</label>
              <input
                className="input"
                value={e.player_name}
                onChange={(ev) => setE(r.id, { player_name: ev.target.value })}
                placeholder="Name"
              />
            </div>
            <div className="field w-40">
              <label>Phone</label>
              <input
                className="input tnum"
                value={e.phone}
                onChange={(ev) => setE(r.id, { phone: ev.target.value })}
                placeholder={!e.phone.trim() && r.beeper_chat_id ? 'no mobile' : 'Phone'}
                title={numberFlag || undefined}
                style={numberFlag ? { borderColor: 'var(--color-accent)' } : undefined}
              />
              {numberFlag && (
                <p className="m-0 mt-1 text-[10px] font-semibold" style={accent700}>
                  {numberFlag}
                </p>
              )}
            </div>
            {/* Region (zone) — single-select */}
            <div className="field w-40">
              <label>Region</label>
              <select
                className="input"
                value={!e.region ? '' : REGIONS.includes(e.region) ? e.region : '__custom__'}
                onChange={(ev) => {
                  const v = ev.target.value
                  if (v === '__custom__') return
                  if (v === '__other__') {
                    const x = window.prompt('New region')?.trim()
                    if (x) setE(r.id, { region: x })
                    return
                  }
                  setE(r.id, { region: v })
                }}
              >
                <option value="">Region —</option>
                {e.region && !REGIONS.includes(e.region) && <option value="__custom__">{e.region}</option>}
                {REGIONS.map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
                <option value="__other__">+ Other…</option>
              </select>
            </div>
            <div className="field w-28">
              <label>Activity</label>
              <input
                className="input"
                value={e.activity}
                onChange={(ev) => setE(r.id, { activity: ev.target.value })}
                placeholder="Activity"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
            {/* Venue — multi-select */}
            <div className="field">
              <label>Venues</label>
              <MultiSelect
                value={venueArr}
                options={VENUES}
                addLabel="+ venue…"
                otherLabel="New venue"
                onChange={(next) => setE(r.id, { venues: next.join(', ') })}
              />
            </div>
            {/* Tags / stakes — multi-select */}
            <div className="field">
              <label>Stakes / tags</label>
              <MultiSelect
                value={stakeArr}
                options={STAKES}
                addLabel="+ stake / tag…"
                otherLabel="New tag / stake"
                onChange={(next) => setE(r.id, { stakes: next.join(', ') })}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="field">
              <label>Contact day</label>
              <select className="input !w-auto" value={e.contact_day} onChange={(ev) => setE(r.id, { contact_day: ev.target.value })}>
                <option value="">day —</option>
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Time</label>
              <select className="input !w-auto" value={e.contact_window} onChange={(ev) => setE(r.id, { contact_window: ev.target.value })}>
                <option value="">time —</option>
                {['Morning', 'Afternoon', 'Evening'].map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </div>
            <div className="field w-28">
              <label>Every N days</label>
              <input
                className="input tnum"
                value={e.contact_frequency_days}
                onChange={(ev) => setE(r.id, { contact_frequency_days: ev.target.value.replace(/\D/g, '') })}
                placeholder="e.g. 14"
              />
            </div>
            <div className="field">
              <label>Rapport</label>
              <div className="seg">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="seg-btn seg-btn-sm"
                    aria-pressed={e.rapport >= n}
                    title={`${n} of 5`}
                    onClick={() => setE(r.id, { rapport: e.rapport === n ? 0 : n })}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
            <label className="flex cursor-pointer items-center gap-1.5" title="Banned / opted out — never messaged">
              <input type="checkbox" className="checkbox" checked={e.do_not_message} onChange={(ev) => setE(r.id, { do_not_message: ev.target.checked })} />
              Do not message
            </label>
            <label className="flex cursor-pointer items-center gap-1.5" title="Staff — exclude from player outreach">
              <input type="checkbox" className="checkbox" checked={e.staff} onChange={(ev) => setE(r.id, { staff: ev.target.checked })} />
              Staff
            </label>
            <label className="flex cursor-pointer items-center gap-1.5" title="Tournament player — skip cash sends, include in tourney/event promos">
              <input type="checkbox" className="checkbox" checked={e.tournament} onChange={(ev) => setE(r.id, { tournament: ev.target.checked })} />
              Tournament
            </label>
            <label className="flex cursor-pointer items-center gap-1.5" title="Cash-game player — include in cash promos">
              <input type="checkbox" className="checkbox" checked={e.cash} onChange={(ev) => setE(r.id, { cash: ev.target.checked })} />
              Cash
            </label>
            <label className="flex cursor-pointer items-center gap-1.5" title="Whale — priority customer; higher-touch outreach, ranked first">
              <input type="checkbox" className="checkbox" checked={e.whale} onChange={(ev) => setE(r.id, { whale: ev.target.checked })} />
              Whale
            </label>
            <label className="flex cursor-pointer items-center gap-1.5" title="FIFO worker — fly-in/fly-out; surfaces on the 'due back' panel when a swing ends">
              <input type="checkbox" className="checkbox" checked={e.fifo} onChange={(ev) => setE(r.id, { fifo: ev.target.checked })} />
              FIFO
            </label>
          </div>

          {(fullerSaved || showContact || noteText) && (
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[11px] muted-50">
              <span title="Captured context — transcribe into the fields above">context:</span>
              {fullerSaved && (
                <span>
                  saved as <span className="muted-70">“{fullerSaved}”</span>
                  <button
                    type="button"
                    onClick={() => setE(r.id, { player_name: fullerSaved })}
                    className="btn-quiet ml-1.5 !text-[11px]"
                    title="Use this full name as the player's name"
                  >
                    Use
                  </button>
                </span>
              )}
              {showContact && (
                <span>
                  contact “<span className="muted-70">{contactLabel}</span>”
                </span>
              )}
              {noteText && (
                <span>
                  note: <span className="muted-70">{noteText}</span>
                </span>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2.5">
            <button className="btn btn-primary !text-xs" onClick={() => void onSave(r.id)} disabled={busy}>
              Save
            </button>
            {onIcePlayer &&
              (onIce ? (
                <button
                  className="btn-quiet"
                  onClick={() => onIcePlayer(r.id, 0)}
                  title={`On ice until ${r.snooze_until?.slice(0, 10)} — click to un-ice`}
                >
                  Un-ice
                </button>
              ) : (
                <select
                  className="input !w-auto"
                  value=""
                  onChange={(ev) => { if (ev.target.value) onIcePlayer(r.id, Number(ev.target.value)) }}
                  title="Put on ice (pause outreach) for a period"
                >
                  <option value="">Put on ice…</option>
                  <option value="14">2 weeks</option>
                  <option value="30">1 month</option>
                  <option value="60">2 months</option>
                  <option value="90">3 months</option>
                  <option value="180">6 months</option>
                </select>
              ))}
          </div>
        </div>
      )}
    </li>
  )
}

// Reusable multi-select: removable tags + an "add" dropdown of fixed options
// (with an Other… prompt). Stores nothing itself; parent owns the value array.
function MultiSelect({
  value,
  options,
  onChange,
  addLabel,
  otherLabel,
}: {
  value: string[]
  options: string[]
  onChange: (next: string[]) => void
  addLabel: string
  otherLabel: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((s) => (
        <span key={s} className="tag tag-neutral">
          {s}
          <button
            onClick={() => onChange(value.filter((x) => x !== s))}
            className="ml-1.5 cursor-pointer border-0 bg-transparent p-0 text-[11px] muted-50 hover:text-ink"
            title={`Remove ${s}`}
          >
            ×
          </button>
        </span>
      ))}
      <select
        className="input !w-auto !text-xs"
        value=""
        onChange={(ev) => {
          const v = ev.target.value
          if (!v) return
          if (v === '__other__') {
            const x = window.prompt(otherLabel)?.trim()
            if (x && !value.includes(x)) onChange([...value, x])
            return
          }
          if (!value.includes(v)) onChange([...value, v])
        }}
      >
        <option value="">{addLabel}</option>
        {options.filter((o) => !value.includes(o)).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
        <option value="__other__">Other…</option>
      </select>
    </div>
  )
}
