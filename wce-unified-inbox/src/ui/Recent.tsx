import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface Row {
  key: string
  name: string
  sent_at: string
}

interface ViewRow {
  recipient: string
  name: string | null
  sent_at: string
}

// inbox_recent_contacts (a view) isn't in the generated Database types — cast it.
// The view already resolves the display name (CRM player → Beeper contact →
// conversation title) and dedups to one row per recipient, so the client just
// reads it. See supabase/migrations/0026_inbox_recent_contacts_view.sql.
const recentView = supabase as unknown as {
  from: (t: string) => {
    select: (c: string) => {
      order: (col: string, o: { ascending: boolean }) => {
        limit: (n: number) => Promise<{ data: ViewRow[] | null }>
      }
    }
  }
}

/** "2h ago" / "3d ago" / "just now" from an ISO timestamp. */
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

/**
 * Players recently contacted — deduped to one row per recipient (their most
 * recent send), newest first, with how long ago. Sourced from the send ledger,
 * so it covers every channel (SMS + Messenger). Name resolution + dedup happen
 * in the inbox_recent_contacts view, so a Beeper room id never leaks into the UI.
 */
export function Recent() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const { data } = await recentView
      .from('inbox_recent_contacts')
      .select('recipient, name, sent_at')
      .order('sent_at', { ascending: false })
      .limit(500)
    const out: Row[] = (data ?? []).map((d) => ({
      key: d.recipient,
      name: (d.name ?? '').trim() || d.recipient,
      sent_at: d.sent_at,
    }))
    setRows(out)
    setLoading(false)
  }
  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="mx-auto h-full w-full max-w-2xl overflow-y-auto p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Recently contacted</h2>
        <button onClick={() => void load()} className="text-sm text-emerald-700 hover:underline">
          Refresh
        </button>
      </div>
      <p className="mb-4 text-sm text-slate-500">{rows.length} people messaged (most recent first).</p>
      {loading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-400">Nothing sent yet.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li
              key={r.key}
              className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
            >
              <span className="flex-1 font-medium">{r.name}</span>
              <span className="text-xs text-slate-400">{ago(r.sent_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
