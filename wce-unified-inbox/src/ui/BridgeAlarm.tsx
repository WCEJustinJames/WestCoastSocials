import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface BridgeRow {
  network: string
  label: string | null
  connected: boolean
  status: string
  since: string | null
}

const rel = (s: number): string =>
  s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`

/**
 * Loud, always-on alarm for a dropped Beeper bridge. A disconnected network
 * (WhatsApp / Google Messages / Messenger / …) silently swallows every send on
 * it, so this sits at the top of Home in red whenever one is down — and stays
 * until it reconnects. Renders nothing while everything's healthy.
 */
export function BridgeAlarm() {
  const [down, setDown] = useState<BridgeRow[]>([])
  const [unreachable, setUnreachable] = useState(false)

  useEffect(() => {
    const q = supabase as unknown as {
      from: (t: string) => { select: (c: string) => Promise<{ data: BridgeRow[] | null }> }
    }
    async function load() {
      const { data } = await q.from('inbox_bridge_health').select('network, label, connected, status, since')
      const rows = data ?? []
      setUnreachable(rows.length > 0 && rows.every((r) => r.status === 'unreachable'))
      setDown(rows.filter((r) => !r.connected))
    }
    void load()
    const t = setInterval(() => void load(), 20_000)
    return () => clearInterval(t)
  }, [])

  if (!down.length) return null
  const now = Date.now()

  return (
    <div className="mb-4 rounded-lg border-2 border-rose-300 bg-rose-50 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-rose-800">
        <span className="animate-pulse">🔴</span>
        {unreachable
          ? 'Beeper Desktop isn’t responding — every message bridge is offline'
          : `${down.length} message bridge${down.length > 1 ? 's are' : ' is'} down`}
      </div>
      <p className="mt-0.5 text-xs text-rose-700">
        Messages on {unreachable ? 'any network' : 'these networks'} won’t send until reconnected — open Beeper on the PC and re-link.
      </p>
      {!unreachable && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {down.map((b, i) => (
            <li key={i} className="flex items-center gap-1.5 rounded-md bg-white px-2 py-1 text-xs ring-1 ring-rose-200">
              <span className="rounded bg-rose-600 px-1.5 py-0.5 font-medium text-white">{b.network}</span>
              {b.label && <span className="text-slate-600">{b.label}</span>}
              <span className="text-rose-700">
                {b.status}
                {b.since ? ` · ${rel((now - new Date(b.since).getTime()) / 1000)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
