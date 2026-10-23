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

// The engine upserts heartbeat id=3 first thing every pass (15s cadence, pass
// hard-capped at 120s), so a live engine is never much more than 2 minutes
// stale. 300s is generous headroom for clock skew without letting a dead engine
// hide for long.
const ENGINE_HEARTBEAT_ID = 3
const ENGINE_STALE_S = 300

/**
 * Loud, always-on alarm for a dropped Beeper bridge — or for the sync engine
 * being dead, which is worse and used to be invisible here.
 *
 * When the engine stops, nothing polls Beeper, so every inbox_bridge_health row
 * FREEZES at whatever it last said. On 2026-08-03 that was "6/6 connected", and
 * because this banner only tested connected=false it stayed hidden for six days
 * while no member message moved in either direction. A silent heartbeat is
 * therefore its own alarm, and the louder of the two.
 *
 * The two states get separate copy on purpose: a dead engine is fixed by
 * starting run-wce.bat on the PC, a dropped bridge by re-linking in Beeper.
 * Renders nothing while everything's healthy.
 */
export function BridgeAlarm() {
  const [down, setDown] = useState<BridgeRow[]>([])
  const [unreachable, setUnreachable] = useState(false)
  // Seconds since the engine's last heartbeat; null = no heartbeat row at all.
  const [engineAgo, setEngineAgo] = useState<number | null>(null)
  const [engineDead, setEngineDead] = useState(false)

  useEffect(() => {
    const q = supabase as unknown as {
      from: (t: string) => { select: (c: string) => Promise<{ data: BridgeRow[] | null }> }
    }
    async function load() {
      const [{ data }, { data: hb, error: hbErr }] = await Promise.all([
        q.from('inbox_bridge_health').select('network, label, connected, status, since'),
        supabase.from('inbox_sync_heartbeat').select('last_run').eq('id', ENGINE_HEARTBEAT_ID).maybeSingle(),
      ])
      const rows = data ?? []
      setUnreachable(rows.length > 0 && rows.every((r) => r.status === 'unreachable'))
      setDown(rows.filter((r) => !r.connected))
      // Judge liveness only on a clean read — a failed request is our problem,
      // not the engine's, and must not cry wolf.
      if (!hbErr) {
        const secs = hb?.last_run ? Math.round((Date.now() - new Date(hb.last_run).getTime()) / 1000) : null
        setEngineAgo(secs)
        setEngineDead(secs === null || secs > ENGINE_STALE_S)
      }
    }
    void load()
    const t = setInterval(() => void load(), 20_000)
    return () => clearInterval(t)
  }, [])

  if (!engineDead && !down.length) return null
  const now = Date.now()

  return (
    <div className="mb-4 space-y-3 rounded-lg border-2 border-rose-300 bg-rose-50 p-3">
      {engineDead && (
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-rose-800">
            <span className="animate-pulse">🔴</span>
            {engineAgo === null
              ? 'Sync engine has never checked in — nothing is running'
              : `Sync engine isn’t running — no heartbeat for ${rel(engineAgo)}`}
          </div>
          <p className="mt-0.5 text-xs text-rose-700">
            Nothing is being sent, received or auto-replied to. Any bridge status below is frozen from the
            last poll and is not live. Start the sync on the PC (run-wce.bat) — this is a dead engine, not a
            dropped bridge, so re-linking Beeper won’t fix it.
          </p>
        </div>
      )}
      {down.length > 0 && (
        <div>
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
                {b.since ? ` · ${rel(Math.round((now - new Date(b.since).getTime()) / 1000))}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
        </div>
      )}
    </div>
  )
}
