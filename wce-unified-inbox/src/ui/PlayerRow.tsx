import { REGIONS, VENUES, STAKES, type Edit, type PlayerRow as Row } from './usePlayers'

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
}

/** One editable player record. Shared by the Players list and the review queue. */
export function PlayerCard({
  r, e, setE, busy, isReviewed,
  onSave, onToggleHide, onUnmarkReviewed,
  showSelect = false, selected = false, onToggleSel,
}: PlayerCardProps) {
  const stakeArr = e.stakes.split(',').map((s) => s.trim()).filter(Boolean)
  const venueArr = e.venues.split(',').map((s) => s.trim()).filter(Boolean)
  const hasSms = !!e.phone.trim()
  const hasThread = !!r.beeper_chat_id
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
          placeholder={hasThread && !hasSms ? 'no mobile' : 'Phone'}
          className="w-32 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
        />
        {/* Channel(s) this player is reachable on. When they have both SMS
            and Messenger, the chips become a preference toggle. */}
        {hasSms && hasThread ? (
          <span className="flex items-center gap-1">
            <span className="text-[10px] text-slate-400">reach via</span>
            <button
              type="button"
              title="Prefer SMS for this player"
              onClick={() => setE(r.id, { preferred_channel: e.preferred_channel === 'sms' ? '' : 'sms' })}
              className={`rounded-full px-1.5 py-0.5 text-[10px] ${e.preferred_channel === 'sms' ? 'bg-sky-600 text-white' : 'bg-sky-100 text-sky-700'}`}
            >SMS</button>
            <button
              type="button"
              title="Prefer Messenger for this player"
              onClick={() => setE(r.id, { preferred_channel: e.preferred_channel === 'thread' ? '' : 'thread' })}
              className={`rounded-full px-1.5 py-0.5 text-[10px] ${e.preferred_channel === 'thread' ? 'bg-indigo-600 text-white' : 'bg-indigo-100 text-indigo-700'}`}
            >Messenger</button>
          </span>
        ) : hasThread ? (
          <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700">Messenger</span>
        ) : hasSms ? (
          <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700">SMS</span>
        ) : (
          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">no contact</span>
        )}
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
