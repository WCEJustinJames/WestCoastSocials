import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface Row {
  conversation_id: string
  name: string
  note: string | null
  ts: string
}

// Raw shape of the joined query (cast — PostgREST embeds the conversation).
interface Raw {
  conversation_id: string
  sender_name: string | null
  reply_note: string | null
  timestamp: string
  conversation: { title: string | null; external_chat_id: string | null } | null
}

/**
 * Confirmed-tonight list: everyone whose reply the AI read as "yes" in the last
 * 18h, deduped to one row per person, with staff / hidden / banned contacts
 * filtered out (the same exclusion the seat list uses). This is the read-only
 * view of the roster — it does NOT post anything to the group.
 */
export function Confirmed() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const since = new Date(Date.now() - 18 * 3600_000).toISOString()
    const { data } = await supabase
      .from('inbox_messages')
      .select(
        'conversation_id, sender_name, reply_note, timestamp, conversation:inbox_conversations!inner(title, external_chat_id)',
      )
      .eq('direction', 'inbound')
      .eq('reply_intent', 'yes')
      .gt('timestamp', since)
      .order('timestamp', { ascending: false })
    // Chat ids of staff / hidden / banned contacts — never list them.
    const { data: blocked } = await supabase
      .from('inbox_outreach')
      .select('beeper_chat_id')
      .or('staff.eq.true,hidden.eq.true,do_not_message.eq.true')
      .not('beeper_chat_id', 'is', null)
    const block = new Set((blocked ?? []).map((b) => b.beeper_chat_id as string))

    const seen = new Set<string>()
    const out: Row[] = []
    for (const m of (data as unknown as Raw[]) ?? []) {
      if (seen.has(m.conversation_id)) continue
      seen.add(m.conversation_id)
      if (m.conversation?.external_chat_id && block.has(m.conversation.external_chat_id)) continue
      out.push({
        conversation_id: m.conversation_id,
        name: (m.sender_name || m.conversation?.title || 'Player').trim(),
        note: (m.reply_note ?? '').trim() || null,
        ts: m.timestamp,
      })
    }
    setRows(out)
    setLoading(false)
  }
  useEffect(() => {
    void load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="mx-auto h-full w-full max-w-2xl overflow-y-auto p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Confirmed tonight</h2>
        <button onClick={() => void load()} className="text-sm text-emerald-700 hover:underline">
          Refresh
        </button>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        {rows.length} player(s) replied yes in the last 18h · staff &amp; hidden excluded · group posting is paused.
      </p>
      {loading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-400">
          No confirmations yet.
        </p>
      ) : (
        <ol className="space-y-1">
          {rows.map((r, i) => (
            <li
              key={r.conversation_id}
              className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
            >
              <span className="w-5 text-right text-xs text-slate-400">{i + 1}</span>
              <span className="flex-1 font-medium">{r.name}</span>
              {r.note && (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">{r.note}</span>
              )}
              <span className="text-xs text-slate-400">
                {new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
