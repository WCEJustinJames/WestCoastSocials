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
    const { error: upErr } = await supabase.from('inbox_outreach').upsert(
      {
        airtable_id: `receipt:${r.id}`,
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

  return (
    <div className="mx-auto h-full w-full max-w-3xl overflow-y-auto p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Receipts to review</h2>
        <button onClick={load} className="text-sm text-emerald-700 hover:underline">
          Refresh
        </button>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Extracted from the “Poker Banking and Cash Chips” chat by{' '}
        <code className="rounded bg-slate-100 px-1">npm run receipts</code>. Fix any misread field,
        then Confirm to add the player to the CRM.
      </p>
      {status && <p className="mb-3 text-sm text-emerald-700">{status}</p>}

      {rows.length === 0 && (
        <p className="text-sm text-slate-400">
          Nothing pending. Run <code className="rounded bg-slate-100 px-1">npm run receipts</code> to
          pull more, then Refresh.
        </p>
      )}

      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.id} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="mb-2 flex flex-wrap gap-3 text-xs text-slate-500">
              <span>{r.venue ?? 'venue ?'}</span>
              {r.club && <span>· {r.club}</span>}
              {r.game_type && <span>· {r.game_type}</span>}
              {r.total_winnings != null && <span>· win ${r.total_winnings}</span>}
              {r.receipt_date && <span>· {r.receipt_date}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={edits[r.id]?.name ?? ''}
                onChange={(ev) =>
                  setEdits((p) => ({ ...p, [r.id]: { ...p[r.id], name: ev.target.value } }))
                }
                placeholder="Player name"
                className="min-w-[12rem] flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
              />
              <input
                value={edits[r.id]?.mobile ?? ''}
                onChange={(ev) =>
                  setEdits((p) => ({ ...p, [r.id]: { ...p[r.id], mobile: ev.target.value } }))
                }
                placeholder="Mobile"
                className="w-40 rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
              />
              <button
                onClick={() => void confirm(r)}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
              >
                Confirm → CRM
              </button>
              <button
                onClick={() => void reject(r)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
              >
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
