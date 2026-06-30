import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

type Conv = Database['public']['Views']['inbox_batch_conversion']['Row']

const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0)

/**
 * Analytics tab — outreach conversion per batch and rolled up by venue. Shows, for
 * each batch we sent, how many replied and how many said yes/no/maybe, so you can
 * see which wording and venues actually convert. Attribution is approximate (first
 * classified reply within 7 days of the batch).
 */
export function Analytics() {
  const [rows, setRows] = useState<Conv[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('inbox_batch_conversion')
      .select('*')
      .order('created_at', { ascending: false })
    setRows((data as Conv[]) ?? [])
    setLoading(false)
  }
  useEffect(() => { void load() }, [])

  // Roll up by venue (falling back to '—' when a batch has no venue tag).
  const byVenue = useMemo(() => {
    const m = new Map<string, { sent: number; replied: number; yes: number; no: number; maybe: number }>()
    for (const r of rows) {
      const k = (r.venue ?? '').trim() || '—'
      const a = m.get(k) ?? { sent: 0, replied: 0, yes: 0, no: 0, maybe: 0 }
      a.sent += r.sent; a.replied += r.replied; a.yes += r.yes; a.no += r.no; a.maybe += r.maybe
      m.set(k, a)
    }
    return [...m.entries()].sort((a, b) => b[1].sent - a[1].sent)
  }, [rows])

  const totals = useMemo(() => rows.reduce(
    (a, r) => ({ sent: a.sent + r.sent, replied: a.replied + r.replied, yes: a.yes + r.yes }),
    { sent: 0, replied: 0, yes: 0 },
  ), [rows])

  return (
    <div className="mx-auto h-full w-full max-w-4xl overflow-y-auto p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Analytics</h2>
        <button onClick={() => void load()} className="text-sm text-emerald-700 hover:underline">Refresh</button>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Outreach conversion per batch and by venue. {totals.sent} sent · {totals.replied} replied ({pct(totals.replied, totals.sent)}%) · {totals.yes} yes ({pct(totals.yes, totals.sent)}%).
      </p>

      {loading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">No sent batches yet.</p>
      ) : (
        <>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">By venue</h3>
          <div className="mb-6 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">Venue</th>
                  <th className="px-3 py-2 text-right">Sent</th>
                  <th className="px-3 py-2 text-right">Replied</th>
                  <th className="px-3 py-2 text-right">Reply %</th>
                  <th className="px-3 py-2 text-right">Yes</th>
                  <th className="px-3 py-2 text-right">Yes %</th>
                </tr>
              </thead>
              <tbody>
                {byVenue.map(([venue, a]) => (
                  <tr key={venue} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium">{venue}</td>
                    <td className="px-3 py-2 text-right">{a.sent}</td>
                    <td className="px-3 py-2 text-right">{a.replied}</td>
                    <td className="px-3 py-2 text-right">{pct(a.replied, a.sent)}%</td>
                    <td className="px-3 py-2 text-right">{a.yes}</td>
                    <td className="px-3 py-2 text-right font-semibold text-emerald-700">{pct(a.yes, a.sent)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mb-2 text-sm font-semibold text-slate-700">Per batch</h3>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">Batch</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2 text-right">Sent</th>
                  <th className="px-3 py-2 text-right">Replied</th>
                  <th className="px-3 py-2 text-right">Yes</th>
                  <th className="px-3 py-2 text-right">No</th>
                  <th className="px-3 py-2 text-right">Maybe</th>
                  <th className="px-3 py-2 text-right">Yes %</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.batch_id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{r.venue ? <span className="text-slate-400">{r.venue} · </span> : ''}{r.name}</td>
                    <td className="px-3 py-2 text-slate-500">{new Date(r.created_at).toLocaleDateString()}</td>
                    <td className="px-3 py-2 text-right">{r.sent}</td>
                    <td className="px-3 py-2 text-right">{r.replied}</td>
                    <td className="px-3 py-2 text-right text-emerald-700">{r.yes}</td>
                    <td className="px-3 py-2 text-right text-rose-600">{r.no}</td>
                    <td className="px-3 py-2 text-right text-amber-600">{r.maybe}</td>
                    <td className="px-3 py-2 text-right font-semibold">{pct(r.yes, r.sent)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
