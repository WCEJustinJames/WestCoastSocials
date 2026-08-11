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

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })

  return (
    <div className="max-w-[760px]">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="m-0 flex-1 text-[13px] muted tnum">{rows.length} people messaged (most recent first).</p>
        <button onClick={() => void load()} className="btn-quiet">Refresh</button>
      </div>
      {loading ? (
        <p className="m-0 py-3 text-[13px] muted" style={{ borderTop: '2px solid var(--color-divider)' }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p className="m-0 py-3 text-[13px] muted" style={{ borderTop: '2px solid var(--color-divider)' }}>Nothing sent yet.</p>
      ) : (
        <ul className="m-0 list-none p-0" style={{ borderTop: '2px solid var(--color-divider)' }}>
          {rows.map((r) => (
            <li
              key={r.key}
              className="row grid grid-cols-[96px_minmax(0,1fr)_max-content] items-baseline gap-x-4 py-3"
            >
              <span className="text-xs muted-60 tnum">{fmtDate(r.sent_at)}</span>
              <span className="min-w-0 truncate text-sm font-semibold">{r.name}</span>
              <span className="text-xs muted tnum">{ago(r.sent_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
