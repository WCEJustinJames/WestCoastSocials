import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface Row {
  key: string
  name: string
  sent_at: string
}

interface LogRaw {
  recipient: string
  sent_at: string
  outreach_id: string | null
}

// inbox_sent_log isn't in the generated Database types yet — cast for this table.
const sentLog = supabase as unknown as {
  from: (t: string) => {
    select: (c: string) => {
      order: (col: string, o: { ascending: boolean }) => {
        limit: (n: number) => Promise<{ data: LogRaw[] | null }>
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
 * so it covers every channel (SMS + Messenger), and names resolve from the CRM
 * where the send was linked to a player.
 */
export function Recent() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const { data: logs } = await sentLog
      .from('inbox_sent_log')
      .select('recipient, sent_at, outreach_id')
      .order('sent_at', { ascending: false })
      .limit(500)
    const dedup = new Map<string, LogRaw>()
    for (const l of logs ?? []) {
      if (!dedup.has(l.recipient)) dedup.set(l.recipient, l)
    }
    const ids = [...new Set([...dedup.values()].map((d) => d.outreach_id).filter(Boolean))] as string[]
    const nameById = new Map<string, string>()
    if (ids.length) {
      const { data: outs } = await supabase.from('inbox_outreach').select('id, player_name').in('id', ids)
      for (const o of outs ?? []) nameById.set(o.id, (o.player_name ?? '').trim())
    }
    const out: Row[] = [...dedup.values()].map((d) => ({
      key: d.recipient,
      name: (d.outreach_id ? nameById.get(d.outreach_id) : '') || d.recipient,
      sent_at: d.sent_at,
    }))
    out.sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1))
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
