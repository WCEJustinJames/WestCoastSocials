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

/**
 * Global live-sync strip — a slim, always-visible health bar of the background
 * integrations, pinned to the top of every page. Polls every 20s so it reflects
 * the real state without a refresh. Green pulses = healthy and current.
 */
export function SyncStrip() {
  const [items, setItems] = useState<Item[]>([])

  async function load() {
    const { data } = await supabase.from('sync_status').select('integration, last_run, detail')
    const rows = (data as { integration: string; last_run: string | null; detail: string | null }[]) ?? []
    const now = Date.now()
    setItems(
      SPECS.map((spec) => {
        const row = rows.find((r) => r.integration === spec.key)
        const s = row?.last_run ? Math.floor((now - new Date(row.last_run).getTime()) / 1000) : null
        const okWord = spec.ok ?? 'up to date'
        const g: { tone: Tone; status: string } =
          s == null
            ? { tone: 'off', status: 'not run yet' }
            : s < spec.fresh
              ? { tone: 'ok', status: okWord }
              : s < spec.fresh * 8
                ? { tone: 'warn', status: `${rel(s)} ago` }
                : { tone: 'bad', status: `${rel(s)} ago` }
        return { key: spec.key, label: spec.label, detail: row?.detail, ...g }
      }),
    )
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
