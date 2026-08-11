import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

type Transfer = Database['public']['Tables']['inbox_transfers']['Row']

const WINDOW_DAYS = 35 // rolling ~5 weeks

/**
 * Transfers tab — TD-sheet bank-transfer reconciliation. Every in/out line from
 * the last 5 weeks of sheets that's missing the Office Confirm initials, in one
 * queue. Ticking a line records JL (outgoing money requires the last-4 receipt
 * ref first) and the PC sync writes it back into the sheet's exact cell. Lines
 * still awaited can be flagged pending — those also sit in the Home queue.
 */
export function Transfers() {
  const [rows, setRows] = useState<Transfer[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // per-row last-4 ref inputs for outgoing confirmations
  const [refs, setRefs] = useState<Record<string, string>>({})
  const [showConfirmed, setShowConfirmed] = useState(false)
  // Received (money IN) vs Sent (payouts + money OUT).
  const [dir, setDir] = useState<'all' | 'in' | 'out'>('all')

  const flash = (m: string) => { setStatus(m); setTimeout(() => setStatus(null), 4000) }

  const dirOf = (t: Transfer): 'in' | 'out' => (t.direction === 'in' ? 'in' : 'out')
  const inDir = (t: Transfer): boolean => dir === 'all' || dirOf(t) === dir
  const amountNum = (a: string | null): number => Number((a ?? '').replace(/[^0-9.]/g, '')) || 0
  const money = (n: number): string => `$${Math.round(n).toLocaleString()}`

  async function load() {
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
    const { data } = await supabase
      .from('inbox_transfers')
      .select('*')
      .gte('game_date', since)
      .order('game_date', { ascending: false })
      .order('tab_title')
      .order('row_num')
      .limit(1000)
    setRows((data as Transfer[]) ?? [])
  }
  useEffect(() => { void load() }, [])

  const shown = useMemo(() => rows.filter(inDir), [rows, dir])
  const unconfirmed = useMemo(
    () => shown.filter((r) => r.confirm_state === 'unconfirmed' && !(r.office_confirm ?? '').trim()),
    [shown],
  )
  const inFlight = useMemo(() => shown.filter((r) => r.confirm_state === 'queued'), [shown])
  const pendingFlagged = useMemo(() => shown.filter((r) => r.pending), [shown])
  const confirmed = useMemo(
    () => shown.filter((r) => (r.office_confirm ?? '').trim() || r.confirm_state === 'written'),
    [shown],
  )

  // Direction totals across the whole window (for the filter seg + summary).
  const totals = useMemo(() => {
    let inSum = 0, outSum = 0, inN = 0, outN = 0
    for (const r of rows) {
      if (dirOf(r) === 'in') { inSum += amountNum(r.amount); inN++ }
      else { outSum += amountNum(r.amount); outN++ }
    }
    return { inSum, outSum, inN, outN }
  }, [rows])
  const net = totals.inSum - totals.outSum

  async function confirmLine(t: Transfer) {
    const isOut = t.direction === 'out'
    const ref = (refs[t.id] ?? '').trim()
    if (isOut && !/^\d{4}$/.test(ref)) {
      flash('Outgoing money needs the last 4 digits of the transaction receipt.')
      return
    }
    setBusy(true)
    const { error } = await supabase
      .from('inbox_transfers')
      .update({ confirm_state: 'queued', confirm_ref: isOut ? ref : ref || null, pending: false })
      .eq('id', t.id)
      .eq('confirm_state', 'unconfirmed')
    setBusy(false)
    if (error) return flash(`Error: ${error.message}`)
    flash(`${t.name ?? 'Line'} confirmed — JL writes to the sheet on the next sync pass.`)
    await load()
  }

  async function togglePending(t: Transfer) {
    await supabase.from('inbox_transfers').update({ pending: !t.pending }).eq('id', t.id)
    await load()
  }

  const fmtDate = (d: string | null) =>
    d ? new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '—'

  const dirLabel = (t: Transfer) =>
    t.direction === 'in' ? 'Received' : t.kind === 'winner_payout' ? 'Payout' : 'Sent'

  const groupHead = (label: string, n: number) => (
    <div className="flex items-baseline justify-between pb-1.5 pt-5">
      <span className="kicker">{label}</span>
      <span className="text-xs muted tnum">{n}</span>
    </div>
  )

  const lineRow = (t: Transfer, actions: boolean) => {
    const isOut = dirOf(t) === 'out'
    const amt = amountNum(t.amount)
    return (
      <li key={t.id} className="row grid grid-cols-[96px_minmax(0,1fr)_max-content] items-baseline gap-x-4 py-3">
        <span className="text-xs muted-60 tnum">{fmtDate(t.game_date)}</span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold">{t.name ?? '(no name)'}</span>
            {t.pending && <span className="tag tag-outline text-[10px] uppercase">awaiting</span>}
          </div>
          <div className="mt-0.5 text-xs muted">
            {dirLabel(t)} · {t.venue ?? t.sheet_title ?? '—'} · {t.tab_title}
            {t.receipt ? ` · rcpt ${t.receipt}` : ''}
            {t.pay_method ? ` · ${t.pay_method}` : ''}
          </div>
          {actions ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {t.direction === 'out' && (
                <input
                  value={refs[t.id] ?? ''}
                  onChange={(e) => setRefs((p) => ({ ...p, [t.id]: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                  placeholder="last 4"
                  inputMode="numeric"
                  className="input !w-24 tnum"
                />
              )}
              <button onClick={() => void confirmLine(t)} disabled={busy} className="btn-quiet">
                Confirm JL
              </button>
              <button
                onClick={() => void togglePending(t)}
                title={t.pending ? 'Clear the awaiting flag' : 'Flag as awaited (not received yet) — also shows on Home'}
                className="btn-quiet"
              >
                {t.pending ? 'Clear awaiting flag' : 'Flag as awaited'}
              </button>
            </div>
          ) : (
            <div className="mt-0.5 text-[11px] muted-45 tnum">
              {t.confirm_state === 'queued' ? 'JL queued for the sheet…' : `confirmed ${t.office_confirm || 'JL'}`}
              {t.confirm_ref ? ` · ref ${t.confirm_ref}` : ''}
            </div>
          )}
        </div>
        <span
          className="text-base font-extrabold tnum"
          style={isOut ? { color: 'var(--color-accent-700)' } : undefined}
        >
          {isOut ? `−${money(amt)}` : money(amt)}
        </span>
      </li>
    )
  }

  return (
    <div className="max-w-[760px]">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <p className="m-0 min-w-[240px] flex-1 text-[13px] muted tnum">
          Bank transfers from the last {WINDOW_DAYS} days of TD sheets missing your office confirmation.
          Ticking writes JL (and the ref) back into the sheet. EFTPOS ins auto-confirm as ref 1111.
        </p>
        <button onClick={() => void load()} className="btn-quiet">Refresh</button>
      </div>
      {status && (
        <p className="m-0 mb-3 text-[13px] font-semibold" style={{ color: 'var(--color-accent-700)' }}>{status}</p>
      )}

      {/* received / sent filter + running totals */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="seg">
          <button className="seg-btn seg-btn-sm" aria-pressed={dir === 'all'} onClick={() => setDir('all')}>
            All · {rows.length}
          </button>
          <button
            className="seg-btn seg-btn-sm"
            aria-pressed={dir === 'in'}
            onClick={() => setDir('in')}
            title="Money received into the club"
          >
            Received · {money(totals.inSum)} ({totals.inN})
          </button>
          <button
            className="seg-btn seg-btn-sm"
            aria-pressed={dir === 'out'}
            onClick={() => setDir('out')}
            title="Payouts and money sent out"
          >
            Sent · {money(totals.outSum)} ({totals.outN})
          </button>
        </div>
        {dir !== 'all' && (
          <span
            className={`text-xs tnum ${net < 0 ? 'font-semibold' : 'muted'}`}
            style={net < 0 ? { color: 'var(--color-accent-700)' } : undefined}
          >
            net {net < 0 ? `−${money(-net)}` : money(net)}
          </span>
        )}
      </div>

      <div style={{ borderTop: '2px solid var(--color-divider)' }}>
        {pendingFlagged.length > 0 && (
          <>
            {groupHead('Awaiting receipt', pendingFlagged.length)}
            <ul className="m-0 list-none p-0">{pendingFlagged.map((t) => lineRow(t, true))}</ul>
          </>
        )}

        {groupHead('Needs your confirmation', unconfirmed.length)}
        {unconfirmed.length === 0 ? (
          <p className="m-0 pb-3 text-[13px] muted">
            Nothing outstanding. {rows.length === 0 ? 'No transfer lines mirrored yet — the sync reads them from the sheets (restart to activate, backfill for history).' : ''}
          </p>
        ) : (
          <ul className="m-0 list-none p-0">{unconfirmed.filter((t) => !t.pending).map((t) => lineRow(t, true))}</ul>
        )}

        {inFlight.length > 0 && (
          <>
            {groupHead('Writing to sheets', inFlight.length)}
            <ul className="m-0 list-none p-0">{inFlight.map((t) => lineRow(t, false))}</ul>
          </>
        )}

        <label className="flex items-center gap-1.5 pb-2 pt-4 text-xs muted tnum">
          <input
            type="checkbox"
            className="checkbox"
            checked={showConfirmed}
            onChange={(e) => setShowConfirmed(e.target.checked)}
          />
          show confirmed ({confirmed.length})
        </label>
        {showConfirmed && <ul className="m-0 list-none p-0">{confirmed.map((t) => lineRow(t, false))}</ul>}
      </div>
    </div>
  )
}
