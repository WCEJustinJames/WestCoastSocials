import { REGIONS, VENUES, STAKES, sourceLabel, type Edit, type PlayerRow as Row } from './usePlayers'

/** "messaged 3d ago" / "never messaged" from a last_contacted date. */
function sinceLabel(iso: string | null): string {
  if (!iso) return 'never messaged'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'messaged today'
  if (days === 1) return 'messaged 1d ago'
  if (days < 30) return `messaged ${days}d ago`
  return `messaged ${Math.floor(days / 30)}mo ago`
}

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
}

/** One editable player record. Shared by the Players list and the review queue. */
export function PlayerCard({
  r, e, setE, busy, isReviewed,
  onSave, onToggleHide, onUnmarkReviewed,
  showSelect = false, selected = false, onToggleSel,
  threadNetwork = null,
}: PlayerCardProps) {
  const stakeArr = e.stakes.split(',').map((s) => s.trim()).filter(Boolean)
  const venueArr = e.venues.split(',').map((s) => s.trim()).filter(Boolean)
  // A linked Beeper thread is only "Messenger" when its network actually is —
  // most are SMS (Google Messages). Resolve the real channel from the network.
  const isMsgrThread = !!r.beeper_chat_id && /messenger|facebook|instagram/i.test(threadNetwork ?? '')
  const isSmsThread = !!r.beeper_chat_id && /google messages|sms|messages|rcs/i.test(threadNetwork ?? '')
  const otherNetwork =
    !!r.beeper_chat_id && !isMsgrThread && !isSmsThread ? (threadNetwork || null) : null
  const hasSms = !!e.phone.trim() || isSmsThread
  const hasThread = isMsgrThread
  return (
    <li
      className={`rounded-lg border p-2 ${r.hidden ? 'opacity-60 ' : ''}${
        isReviewed
          ? 'border-emerald-300 border-l-4 border-l-emerald-500 bg-emerald-50/60 shadow-sm'
          : 'border-slate-200 bg-white'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {showSelect && (
          <input
            type="checkbox"
            title="Select to merge"
            checked={selected}
            onChange={() => onToggleSel?.(r.id)}
          />
        )}
        <input
          value={e.player_name}
          onChange={(ev) => setE(r.id, { player_name: ev.target.value })}
          placeholder="Name"
          className="min-w-[10rem] flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
        />
        <input
          value={e.phone}
          onChange={(ev) => setE(r.id, { phone: ev.target.value })}
          placeholder={!e.phone.trim() && r.beeper_chat_id ? 'no mobile' : 'Phone'}
          className="w-32 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
        />
        {/* Channels this player is reachable on. Both shown as chips; the
            preferred one is highlighted. Default to Messenger/FB (some players
            only have FB, no number yet) — toggle to SMS once they share a
            number and rapport builds. */}
        {hasSms && hasThread ? (
          <span className="flex items-center gap-1">
            <span className="text-[10px] text-slate-400">reach via</span>
            <button
              type="button"
              title="Prefer Messenger/FB for this player (default)"
              onClick={() => setE(r.id, { preferred_channel: 'thread' })}
              className={`rounded-full px-1.5 py-0.5 text-[10px] ${e.preferred_channel !== 'sms' ? 'bg-indigo-600 text-white' : 'bg-indigo-100 text-indigo-700'}`}
            >{isMsgrThread ? 'Messenger' : (threadNetwork || 'thread')}</button>
            <button
              type="button"
              title="Prefer SMS for this player (once you have their number)"
              onClick={() => setE(r.id, { preferred_channel: 'sms' })}
              className={`rounded-full px-1.5 py-0.5 text-[10px] ${e.preferred_channel === 'sms' ? 'bg-sky-600 text-white' : 'bg-sky-100 text-sky-700'}`}
            >SMS</button>
          </span>
        ) : hasThread ? (
          <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700">Messenger</span>
        ) : hasSms ? (
          <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700">SMS</span>
        ) : otherNetwork ? (
          <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700">{otherNetwork}</span>
        ) : (
          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">no contact</span>
        )}
        {/* Where this contact came from (phone / facebook / raffle / letspoker …).
            Hover shows the full raw Airtable source when we have it. */}
        <span
          title={r.source ? `Source: ${r.source}` : `Source: ${sourceLabel(r)}`}
          className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500"
        >
          {sourceLabel(r)}
        </span>
        {isReviewed && (
          <button
            type="button"
            title="Reviewed — click to clear"
            onClick={() => onUnmarkReviewed(r.id)}
            className="rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium text-white"
          >✓ reviewed</button>
        )}
        <label className="flex items-center gap-1 text-xs text-rose-700">
          <input
            type="checkbox"
            checked={e.do_not_message}
            onChange={(ev) => setE(r.id, { do_not_message: ev.target.checked })}
          />
          ban
        </label>
        <label className="flex items-center gap-1 text-xs text-violet-700" title="Staff — exclude from player outreach">
          <input
            type="checkbox"
            checked={e.staff}
            onChange={(ev) => setE(r.id, { staff: ev.target.checked })}
          />
          staff
        </label>
        <label className="flex items-center gap-1 text-xs text-amber-700" title="Tournament player — skip cash sends, include in tourney/event promos">
          <input
            type="checkbox"
            checked={e.tournament}
            onChange={(ev) => setE(r.id, { tournament: ev.target.checked })}
          />
          tourney
        </label>
        <label className="flex items-center gap-1 text-xs text-teal-700" title="Cash-game player — include in cash promos">
          <input
            type="checkbox"
            checked={e.cash}
            onChange={(ev) => setE(r.id, { cash: ev.target.checked })}
          />
          cash
        </label>
        <label className="flex items-center gap-1 text-xs text-emerald-700" title="On the weekly cash message list (on by default; uncheck to leave them off)">
          <input
            type="checkbox"
            checked={e.weekly}
            onChange={(ev) => setE(r.id, { weekly: ev.target.checked })}
          />
          weekly
        </label>
        <button
          onClick={() => void onSave(r.id)}
          disabled={busy}
          className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
        >
          Save
        </button>
        <button
          onClick={() => void onToggleHide(r.id, r.hidden)}
          title={r.hidden ? 'Unhide' : 'Hide from lists'}
          className="text-xs text-slate-400 hover:text-rose-600"
        >
          {r.hidden ? 'unhide' : 'hide'}
        </button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {/* Region (zone) — single-select */}
        <select
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
          className="w-32 rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-emerald-500"
        >
          <option value="">Region —</option>
          {e.region && !REGIONS.includes(e.region) && (
            <option value="__custom__">{e.region}</option>
          )}
          {REGIONS.map((x) => (
            <option key={x} value={x}>{x}</option>
          ))}
          <option value="__other__">+ Other…</option>
        </select>

        {/* Venue — multi-select */}
        <MultiSelect
          value={venueArr}
          options={VENUES}
          addLabel="+ venue…"
          otherLabel="New venue"
          onChange={(next) => setE(r.id, { venues: next.join(', ') })}
        />

        {/* Tags / stakes — multi-select */}
        <MultiSelect
          value={stakeArr}
          options={STAKES}
          addLabel="+ stake / tag…"
          otherLabel="New tag / stake"
          onChange={(next) => setE(r.id, { stakes: next.join(', ') })}
        />

        <input
          value={e.activity}
          onChange={(ev) => setE(r.id, { activity: ev.target.value })}
          placeholder="Activity"
          className="w-24 rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-emerald-500"
        />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-400">contact:</span>
        <select
          value={e.contact_day}
          onChange={(ev) => setE(r.id, { contact_day: ev.target.value })}
          className="rounded-md border border-slate-200 px-1 py-1"
        >
          <option value="">day —</option>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select
          value={e.contact_window}
          onChange={(ev) => setE(r.id, { contact_window: ev.target.value })}
          className="rounded-md border border-slate-200 px-1 py-1"
        >
          <option value="">time —</option>
          {['Morning', 'Afternoon', 'Evening'].map((w) => (
            <option key={w} value={w}>{w}</option>
          ))}
        </select>
        <input
          value={e.contact_frequency_days}
          onChange={(ev) => setE(r.id, { contact_frequency_days: ev.target.value.replace(/\D/g, '') })}
          placeholder="every N days"
          className="w-24 rounded-md border border-slate-200 px-2 py-1"
        />
        <span className="ml-1 text-slate-400">rapport:</span>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onClick={() => setE(r.id, { rapport: e.rapport === n ? 0 : n })}
            title={`${n} star${n > 1 ? 's' : ''}`}
            className={n <= e.rapport ? 'text-amber-500' : 'text-slate-300 hover:text-amber-400'}
          >
            ★
          </button>
        ))}
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${
            r.last_contacted ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-700'
          }`}
          title={r.last_contacted ? `last messaged ${r.last_contacted}` : 'no message sent yet'}
        >
          {sinceLabel(r.last_contacted)}
        </span>
      </div>
    </li>
  )
}

// Reusable multi-select: removable chips + an "add" dropdown of fixed options
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
    <div className="flex flex-wrap items-center gap-1">
      {value.map((s) => (
        <span
          key={s}
          className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs"
        >
          {s}
          <button
            onClick={() => onChange(value.filter((x) => x !== s))}
            className="text-slate-400 hover:text-rose-600"
          >
            ×
          </button>
        </span>
      ))}
      <select
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
        className="rounded-md border border-slate-200 px-1 py-1 text-xs"
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
