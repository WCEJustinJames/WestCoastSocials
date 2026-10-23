import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

type ReceiptRow = Database['public']['Tables']['inbox_receipts']['Row']

/**
 * Review queue for receipts extracted from the banking chat. Each pending row
 * shows the vision-extracted fields (editable); Confirm pushes the player +
 * mobile into the CRM (inbox_outreach) so they become a batch recipient, Reject
 * files it away. The receipt image lives on the local Beeper cache and can't be
 * shown in the browser, so cross-check in Beeper if a field looks off.
 */
export function Receipts() {
  const [rows, setRows] = useState<ReceiptRow[]>([])
  const [edits, setEdits] = useState<Record<string, { name: string; mobile: string }>>({})
  const [status, setStatus] = useState<string | null>(null)

  function load() {
    supabase
      .from('inbox_receipts')
      .select('*')
      .eq('review_status', 'pending')
      .order('captured_at', { ascending: false })
      .then(({ data }) => {
        const list = (data as ReceiptRow[]) ?? []
        setRows(list)
        setEdits(
          Object.fromEntries(
            list.map((r) => [r.id, { name: r.player_name ?? '', mobile: r.mobile ?? '' }]),
          ),
        )
      })
  }
  useEffect(load, [])

  async function confirm(r: ReceiptRow) {
    const e = edits[r.id] ?? { name: '', mobile: '' }
    if (!e.mobile.trim()) {
      setStatus('A mobile is required to add a player to the CRM.')
      return
    }
    const [first, ...rest] = e.name.trim().split(/\s+/)
    // Key the CRM row by phone so the same number is never added twice.
    const phoneKey = e.mobile.replace(/\D/g, '').replace(/^61/, '').replace(/^0/, '')
    const { error: upErr } = await supabase.from('inbox_outreach').upsert(
      {
        airtable_id: `receipt:${phoneKey}`,
        player_name: e.name.trim() || null,
        first_name: first ?? null,
        last_name: rest.join(' ') || null,
        phone: e.mobile.trim(),
        region: r.venue ?? null,
        outreach_status: 'from receipt',
      },
      { onConflict: 'airtable_id' },
    )
    if (upErr) {
      setStatus(`Error: ${upErr.message}`)
      return
    }
    await supabase
      .from('inbox_receipts')
      .update({ review_status: 'confirmed', player_name: e.name.trim(), mobile: e.mobile.trim() })
      .eq('id', r.id)
    setRows((prev) => prev.filter((x) => x.id !== r.id))
    setStatus(`Added ${e.name || e.mobile} to the CRM — they’ll appear in Batches → Player Outreach.`)
    setTimeout(() => setStatus(null), 5000)
  }

  async function reject(r: ReceiptRow) {
    await supabase.from('inbox_receipts').update({ review_status: 'not_receipt' }).eq('id', r.id)
    setRows((prev) => prev.filter((x) => x.id !== r.id))
  }

  const fmtDate = (r: ReceiptRow) => {
    if (r.receipt_date) return r.receipt_date
    if (r.captured_at) return new Date(r.captured_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
    return '—'
  }

  return (
    <div className="max-w-[760px]">
      <p className="m-0 mb-4 text-[13px] muted">
        Extracted from the “Poker Banking and Cash Chips” chat by{' '}
        <code>npm run receipts</code>. Fix any misread field, then Confirm to add the player to the CRM.
      </p>
      {status && (
        <p className="m-0 mb-3 text-[13px] font-semibold" style={{ color: 'var(--color-accent-700)' }}>{status}</p>
      )}

      <div style={{ borderTop: '2px solid var(--color-divider)' }}>
        {rows.length === 0 && (
          <p className="row m-0 py-3 text-[13px] muted">
            Nothing pending. Run <code>npm run receipts</code> to pull more, then Refresh.
          </p>
        )}
        <ul className="m-0 list-none p-0">
          {rows.map((r) => (
            <li key={r.id} className="row grid grid-cols-[96px_minmax(0,1fr)_max-content] items-baseline gap-x-4 py-3">
              <span className="text-xs muted-60 tnum">{fmtDate(r)}</span>
              <div className="min-w-0">
                <div className="text-sm font-semibold">{r.player_name || 'Unmatched receipt'}</div>
                <div className="mt-0.5 text-xs muted tnum">
                  {[
                    r.venue ?? 'venue ?',
                    r.club,
                    r.game_type,
                    r.total_winnings != null ? `win $${r.total_winnings}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    value={edits[r.id]?.name ?? ''}
                    onChange={(ev) =>
                      setEdits((p) => ({ ...p, [r.id]: { ...p[r.id], name: ev.target.value } }))
                    }
                    placeholder="Player name"
                    className="input min-w-[11rem] flex-1"
                  />
                  <input
                    value={edits[r.id]?.mobile ?? ''}
                    onChange={(ev) =>
                      setEdits((p) => ({ ...p, [r.id]: { ...p[r.id], mobile: ev.target.value } }))
                    }
                    placeholder="Mobile"
                    className="input !w-36 tnum"
                  />
                  <button onClick={() => void confirm(r)} className="btn btn-secondary !text-xs">
                    Confirm to CRM
                  </button>
                  <button onClick={() => void reject(r)} className="btn-quiet">
                    Reject
                  </button>
                </div>
              </div>
              <span className="text-base font-extrabold tnum">
                {r.amount != null ? `$${r.amount.toLocaleString()}` : '—'}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* The capture itself runs on the PC (`npm run receipts` against the Beeper
          cache) — this button re-pulls whatever that pass has landed. */}
      <button onClick={load} className="btn btn-secondary mt-3.5 text-[13px]">
        Refresh captures
      </button>
    </div>
  )
}
