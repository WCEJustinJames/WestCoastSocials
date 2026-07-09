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
 * still awaited can be flagged ⏳ pending — those also sit in the Home queue.
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

  // Direction totals across the whole window (for the filter chips + summary).
  const totals = useMemo(() => {
    let inSum = 0, outSum = 0, inN = 0, outN = 0
    for (const r of rows) {
      if (dirOf(r) === 'in') { inSum += amountNum(r.amount); inN++ }
      else { outSum += amountNum(r.amount); outN++ }
    }
    return { inSum, outSum, inN, outN }
  }, [rows])

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

  const dirChip = (t: Transfer) =>
    t.direction === 'in' ? (
      <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">in</span>
    ) : (
      <span className="shrink-0 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700">
        {t.kind === 'winner_payout' ? 'payout' : 'out'}
      </span>
    )

  const lineRow = (t: Transfer, actions: boolean) => (
    <li
      key={t.id}
      className={`flex flex-wrap items-center gap-2 rounded border p-1.5 text-sm ${
        t.pending ? 'border-amber-300 bg-amber-50' : 'border-slate-100 bg-white'
      }`}
    >
      {dirChip(t)}
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{t.name ?? '(no name)'}</span>
        <span className="text-slate-500"> {t.amount ?? ''}</span>
        <span className="text-[11px] text-slate-400">
          {' '}· {t.venue ?? t.sheet_title ?? ''} {t.game_date ?? ''} · {t.tab_title}
          {t.receipt ? ` · rcpt ${t.receipt}` : ''}
          {t.pay_method ? ` · ${t.pay_method}` : ''}
        </span>
      </span>
      {actions ? (
        <>
          {t.direction === 'out' && (
            <input
              value={refs[t.id] ?? ''}
              onChange={(e) => setRefs((p) => ({ ...p, [t.id]: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
              placeholder="last 4"
              inputMode="numeric"
              className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-emerald-500"
            />
          )}
          <button
            onClick={() => void confirmLine(t)}
            disabled={busy}
            className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            ✓ JL
          </button>
          <button
            onClick={() => void togglePending(t)}
            title={t.pending ? 'Clear the awaiting flag' : 'Flag as awaited (not received yet) — also shows on Home'}
            className={`text-xs ${t.pending ? 'text-amber-600' : 'text-slate-400 hover:text-amber-600'}`}
          >
            ⏳
          </button>
        </>
      ) : (
        <span className="text-[10px] text-slate-400">
          {t.confirm_state === 'queued' ? 'JL queued for the sheet…' : `confirmed ${t.office_confirm || 'JL'}`}
          {t.confirm_ref ? ` · ref ${t.confirm_ref}` : ''}
        </span>
      )}
    </li>
  )

  return (
    <div className="mx-auto h-full w-full max-w-6xl overflow-y-auto p-4 sm:p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Transfers</h2>
        <button onClick={() => void load()} className="text-sm text-emerald-700 hover:underline">Refresh</button>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Bank transfers from the last {WINDOW_DAYS} days of TD sheets missing your office confirmation.
        Ticking writes JL (and the ref) back into the sheet. EFTPOS ins auto-confirm as ref 1111.
      </p>
      {status && <p className="mb-3 text-sm text-emerald-700">{status}</p>}

      {/* received / sent filter + running totals */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setDir('all')}
          className={`rounded-full border px-3 py-1 text-xs font-medium ${dir === 'all' ? 'border-slate-700 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-600 hover:border-slate-500'}`}
        >
          All · {rows.length}
        </button>
        <button
          onClick={() => setDir('in')}
          title="Money received into the club"
          className={`rounded-full border px-3 py-1 text-xs font-medium ${dir === 'in' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50'}`}
        >
          ↓ Received · {money(totals.inSum)} <span className="opacity-60">({totals.inN})</span>
        </button>
        <button
          onClick={() => setDir('out')}
          title="Payouts and money sent out"
          className={`rounded-full border px-3 py-1 text-xs font-medium ${dir === 'out' ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-indigo-300 bg-white text-indigo-700 hover:bg-indigo-50'}`}
        >
          ↑ Sent · {money(totals.outSum)} <span className="opacity-60">({totals.outN})</span>
        </button>
        {dir !== 'all' && (
          <span className="text-xs text-slate-400">net {money(totals.inSum - totals.outSum)}</span>
        )}
      </div>

      {pendingFlagged.length > 0 && (
        <>
          <h3 className="mb-1 text-sm font-semibold text-amber-700">⏳ Awaiting receipt · {pendingFlagged.length}</h3>
          <ul className="mb-4 space-y-1">{pendingFlagged.map((t) => lineRow(t, true))}</ul>
        </>
      )}

      <h3 className="mb-1 text-sm font-semibold text-slate-700">Needs your confirmation · {unconfirmed.length}</h3>
      {unconfirmed.length === 0 ? (
        <p className="mb-4 text-sm text-slate-400">
          Nothing outstanding. {rows.length === 0 ? 'No transfer lines mirrored yet — the sync reads them from the sheets (restart to activate, backfill for history).' : ''}
        </p>
      ) : (
        <ul className="mb-4 space-y-1">{unconfirmed.filter((t) => !t.pending).map((t) => lineRow(t, true))}</ul>
      )}

      {inFlight.length > 0 && (
        <>
          <h3 className="mb-1 text-sm font-semibold text-slate-500">Writing to sheets · {inFlight.length}</h3>
          <ul className="mb-4 space-y-1">{inFlight.map((t) => lineRow(t, false))}</ul>
        </>
      )}

      <label className="mb-2 flex items-center gap-1 text-xs text-slate-500">
        <input type="checkbox" checked={showConfirmed} onChange={(e) => setShowConfirmed(e.target.checked)} />
        show confirmed ({confirmed.length})
      </label>
      {showConfirmed && <ul className="space-y-1">{confirmed.map((t) => lineRow(t, false))}</ul>}
    </div>
  )
}
