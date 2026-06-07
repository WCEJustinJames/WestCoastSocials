import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Database } from '../types/database'

type Row = Database['public']['Tables']['inbox_outreach']['Row']

const phoneCore = (p: string | null): string =>
  p ? p.replace(/\D/g, '').replace(/^61/, '').replace(/^0/, '') : ''

const firstNonEmpty = (vals: (string | null)[]): string | null =>
  vals.find((v) => v != null && String(v).trim() !== '') ?? null

const unionArr = (arrs: (string[] | null)[]): string[] =>
  Array.from(new Set(arrs.flatMap((a) => a ?? []))).sort()

const filledCount = (r: Row): number =>
  [r.player_name, r.email, r.region, r.beeper_chat_id, r.activity, r.outreach_status].filter(Boolean)
    .length + (r.stakes?.length ?? 0) + (r.venues?.length ?? 0)

/** Merge a duplicate group into one record; returns the merged row + the ids to drop. */
function mergeRows(rows: Row[]): { primary: Row; merged: Partial<Row>; dropIds: string[] } {
  // Primary = best-scored: has a Beeper chat, came from the real CRM (not a
  // receipt), then most-complete.
  const ordered = [...rows].sort(
    (a, b) =>
      (b.beeper_chat_id ? 4 : 0) - (a.beeper_chat_id ? 4 : 0) +
      ((b.airtable_id.startsWith('receipt:') ? 0 : 2) - (a.airtable_id.startsWith('receipt:') ? 0 : 2)) +
      (filledCount(b) - filledCount(a)),
  )
  const primary = ordered[0]
  const merged: Partial<Row> = {
    player_name: firstNonEmpty(ordered.map((r) => r.player_name)),
    first_name: firstNonEmpty(ordered.map((r) => r.first_name)),
    last_name: firstNonEmpty(ordered.map((r) => r.last_name)),
    phone: firstNonEmpty(ordered.map((r) => r.phone)),
    email: firstNonEmpty(ordered.map((r) => r.email)),
    beeper_chat_id: firstNonEmpty(ordered.map((r) => r.beeper_chat_id)),
    beeper_contact_name: firstNonEmpty(ordered.map((r) => r.beeper_contact_name)),
    region: firstNonEmpty(ordered.map((r) => r.region)),
    activity: firstNonEmpty(ordered.map((r) => r.activity)),
    outreach_status: firstNonEmpty(ordered.map((r) => r.outreach_status)),
    game_type: firstNonEmpty(ordered.map((r) => r.game_type)),
    stakes: unionArr(ordered.map((r) => r.stakes)),
    venues: unionArr(ordered.map((r) => r.venues)),
    notes: ordered.map((r) => r.notes).filter(Boolean).join(' | ') || null,
  }
  return { primary, merged, dropIds: ordered.slice(1).map((r) => r.id) }
}

export function Players() {
  const [rows, setRows] = useState<Row[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function load() {
    supabase
      .from('inbox_outreach')
      .select('*')
      .order('player_name', { ascending: true })
      .then(({ data }) => setRows((data as Row[]) ?? []))
  }
  useEffect(load, [])

  // Group by normalised phone; only groups with >1 row are duplicates.
  const groups = useMemo(() => {
    const byPhone = new Map<string, Row[]>()
    for (const r of rows) {
      const key = phoneCore(r.phone)
      if (!key) continue
      ;(byPhone.get(key) ?? byPhone.set(key, []).get(key)!).push(r)
    }
    return [...byPhone.values()].filter((g) => g.length > 1)
  }, [rows])

  async function mergeGroup(group: Row[]) {
    setBusy(true)
    const { primary, merged, dropIds } = mergeRows(group)
    const { error } = await supabase.from('inbox_outreach').update(merged).eq('id', primary.id)
    if (!error && dropIds.length) await supabase.from('inbox_outreach').delete().in('id', dropIds)
    setBusy(false)
    if (error) {
      setStatus(`Error: ${error.message}`)
      return
    }
    load()
  }

  async function mergeAll() {
    setBusy(true)
    setStatus('Merging all duplicates…')
    for (const g of groups) {
      const { primary, merged, dropIds } = mergeRows(g)
      await supabase.from('inbox_outreach').update(merged).eq('id', primary.id)
      if (dropIds.length) await supabase.from('inbox_outreach').delete().in('id', dropIds)
    }
    setBusy(false)
    setStatus(`Merged ${groups.length} duplicate group(s).`)
    load()
    setTimeout(() => setStatus(null), 5000)
  }

  return (
    <div className="mx-auto h-full w-full max-w-3xl overflow-y-auto p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Players — merge duplicates</h2>
        <button onClick={load} className="text-sm text-emerald-700 hover:underline">
          Refresh
        </button>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        {rows.length} players in the CRM · {groups.length} duplicate group(s) by phone number.
      </p>
      {status && <p className="mb-3 text-sm text-emerald-700">{status}</p>}

      {groups.length > 0 && (
        <button
          onClick={() => void mergeAll()}
          disabled={busy}
          className="mb-4 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
        >
          Merge all {groups.length} groups
        </button>
      )}

      {groups.length === 0 && (
        <p className="text-sm text-slate-400">No phone duplicates — the CRM is clean. 🎉</p>
      )}

      <ul className="space-y-3">
        {groups.map((g) => (
          <li key={phoneCore(g[0].phone)} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">{g[0].phone}</span>
              <button
                onClick={() => void mergeGroup(g)}
                disabled={busy}
                className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                Merge {g.length} →
              </button>
            </div>
            <ul className="space-y-1 text-sm">
              {g.map((r) => (
                <li key={r.id} className="flex flex-wrap gap-2 text-slate-600">
                  <span className="font-medium text-slate-800">{r.player_name ?? '(no name)'}</span>
                  {r.region && <span className="text-xs text-slate-400">{r.region}</span>}
                  {r.beeper_chat_id && (
                    <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">
                      has thread
                    </span>
                  )}
                  <span className="text-xs text-slate-400">
                    {r.airtable_id.startsWith('receipt:') ? 'from receipt' : 'from CRM'}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  )
}
