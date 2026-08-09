import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Tone = 'ok' | 'warn' | 'bad' | 'off'
interface Item {
  key: string
  label: string
  tone: Tone
  status: string
  detail?: string | null
}

// Each integration's "how fresh is fresh": under `fresh` = green, up to 8x =
// amber, beyond = red. TD sheets pull every 30m; the engine ticks every 15s;
// LetsPoker + Contacts run on slow daily-ish cadences.
const SPECS: { key: string; label: string; fresh: number; ok?: string }[] = [
  { key: 'engine', label: 'Sync engine', fresh: 120 },
  { key: 'tdsheets', label: 'TD sheets', fresh: 90 * 60 },
  { key: 'letspoker', label: 'LetsPoker', fresh: 2 * 86400, ok: 'synced' },
  { key: 'contacts', label: 'Contacts', fresh: 26 * 3600, ok: 'synced' },
]

function rel(s: number): string {
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}

interface BridgeRow {
  network: string
  label: string | null
  connected: boolean
  status: string
  since: string | null
  last_checked: string | null
}

// Collapse the per-network Beeper health into one strip chip. Any bridge down =>
// red alarm; the tooltip lists exactly which network (and for how long).
function beeperItem(bridges: BridgeRow[], now: number): Item {
  if (!bridges.length)
    return { key: 'beeper', label: 'Beeper', tone: 'warn', status: 'no signal', detail: 'No bridge health yet — restart the engine to begin polling.' }
  const lastChecked = Math.max(...bridges.map((b) => (b.last_checked ? new Date(b.last_checked).getTime() : 0)))
  const checkedAgo = lastChecked ? (now - lastChecked) / 1000 : null
  // Red, not amber. A stale poll doesn't mean "slightly out of date" — it means
  // every bridge figure in this strip is frozen fiction, which is exactly how
  // 3 Aug read as healthy for six days.
  if (checkedAgo == null || checkedAgo > 300)
    return { key: 'beeper', label: 'Beeper', tone: 'bad', status: checkedAgo == null ? 'no signal' : `${rel(checkedAgo)} ago`, detail: 'Bridge poll is stale — these numbers are not live. The engine is probably down.' }
  const down = bridges.filter((b) => !b.connected)
  const networks = [...new Set(bridges.map((b) => b.network))]
  if (bridges.every((b) => b.status === 'unreachable'))
    return { key: 'beeper', label: 'Beeper', tone: 'bad', status: 'unreachable', detail: 'Beeper Desktop is not responding — all bridges offline.' }
  if (down.length) {
    const detail = down
      .map((b) => `${b.network}${b.label ? ` (${b.label})` : ''} — ${b.status}${b.since ? `, ${rel((now - new Date(b.since).getTime()) / 1000)}` : ''}`)
      .join(' · ')
    return { key: 'beeper', label: 'Beeper', tone: 'bad', status: `${down.length} down`, detail }
  }
  return { key: 'beeper', label: 'Beeper', tone: 'ok', status: `${bridges.length}/${bridges.length} up`, detail: `${networks.join(', ')} — all connected` }
}

/**
 * Global live-sync strip — a slim, always-visible health bar of the background
 * integrations, pinned to the top of every page. Polls every 20s so it reflects
 * the real state without a refresh. Green pulses = healthy and current.
 */
export function SyncStrip() {
  const [items, setItems] = useState<Item[]>([])

  async function load() {
    const bridgeQ = supabase as unknown as {
      from: (t: string) => { select: (c: string) => Promise<{ data: BridgeRow[] | null }> }
    }
    const [{ data }, { data: bridgeData }] = await Promise.all([
      supabase.from('sync_status').select('integration, last_run, detail'),
      bridgeQ.from('inbox_bridge_health').select('network, label, connected, status, since, last_checked'),
    ])
    const rows = (data as { integration: string; last_run: string | null; detail: string | null }[]) ?? []
    const now = Date.now()
    const base = SPECS.map((spec) => {
      const row = rows.find((r) => r.integration === spec.key)
      const s = row?.last_run ? Math.floor((now - new Date(row.last_run).getTime()) / 1000) : null
      const okWord = spec.ok ?? 'up to date'
      const g: { tone: Tone; status: string } =
        s == null
          ? { tone: 'warn', status: 'no signal' } // no timestamp — awaiting a restart or first run
          : s < spec.fresh
            ? { tone: 'ok', status: okWord }
            : s < spec.fresh * 8
              ? { tone: 'warn', status: `${rel(s)} ago` }
              : { tone: 'bad', status: `failed · ${rel(s)}` }
      return { key: spec.key, label: spec.label, detail: row?.detail, ...g }
    })
    setItems([...base, beeperItem(bridgeData ?? [], now)])
  }

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 20_000)
    return () => clearInterval(t)
  }, [])

  if (!items.length) return null

  const dot = (t: Tone) =>
    t === 'ok' ? 'bg-emerald-500' : t === 'warn' ? 'bg-amber-500' : t === 'bad' ? 'bg-rose-500' : 'bg-slate-300'
  const txt = (t: Tone) =>
    t === 'ok' ? 'text-emerald-600' : t === 'warn' ? 'text-amber-600' : t === 'bad' ? 'text-rose-600' : 'text-slate-400'

  const worst = items.some((i) => i.tone === 'bad') ? 'bad' : items.some((i) => i.tone === 'warn') ? 'warn' : 'ok'

  return (
    <div className="flex items-center gap-x-4 gap-y-1 overflow-x-auto whitespace-nowrap border-b border-slate-200 bg-slate-50/80 px-3 py-1 text-xs">
      <span className="flex shrink-0 items-center gap-1.5 font-medium text-slate-400">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot(worst)} ${worst === 'ok' ? 'animate-pulse' : ''}`} />
        Live
      </span>
      {items.map((it) => (
        <span key={it.key} className="flex shrink-0 items-center gap-1.5" title={it.detail ?? undefined}>
          <span className={`inline-block h-2 w-2 rounded-full ${dot(it.tone)} ${it.tone === 'ok' ? 'animate-pulse' : ''}`} />
          <span className="text-slate-600">{it.label}</span>
          <span className={txt(it.tone)}>{it.status}</span>
        </span>
      ))}
    </div>
  )
}
