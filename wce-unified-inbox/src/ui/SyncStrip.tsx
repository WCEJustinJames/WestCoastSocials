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

// Each integration's "how fresh is fresh": under `fresh` = healthy, up to 8x =
// stale, beyond = failed. TD sheets pull every 30m; the engine ticks every 15s;
// the nightly deep sweep, LetsPoker + Contacts run on slow daily-ish cadences.
const SPECS: { key: string; label: string; fresh: number; ok?: string }[] = [
  { key: 'engine', label: 'Sync engine', fresh: 120 },
  { key: 'tdsheets', label: 'TD sheets', fresh: 90 * 60 },
  // The nightly re-read of the last 7 days. Stale here means the stored figures
  // are still on the wall — just not re-checked against Drive since that time.
  { key: 'deep', label: 'Nightly re-read', fresh: 28 * 3600, ok: 'swept' },
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

// Collapse the per-network Beeper health into one strip item. Any bridge down =>
// alarm; the tooltip lists exactly which network (and for how long).
function beeperItem(bridges: BridgeRow[], now: number): Item {
  if (!bridges.length)
    return { key: 'beeper', label: 'Beeper', tone: 'warn', status: 'no signal', detail: 'No bridge health yet — restart the engine to begin polling.' }
  const lastChecked = Math.max(...bridges.map((b) => (b.last_checked ? new Date(b.last_checked).getTime() : 0)))
  const checkedAgo = lastChecked ? (now - lastChecked) / 1000 : null
  // Alarm, not merely stale. A stale poll doesn't mean "slightly out of date" —
  // it means every bridge figure in this strip is frozen fiction, which is
  // exactly how 3 Aug read as healthy for six days.
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
 * Health strip — Home's single-row view of the background integrations,
 * per the redesign: 1px rules above/below, each item a small square + a
 * "Label · status" line. Squares stay neutral while healthy; anything wrong
 * turns the square accent and the status text accent-700 (one accent colour,
 * used only where attention is needed). Polls every 20s.
 */
export function SyncStrip() {
  const [items, setItems] = useState<Item[]>([])

  async function load() {
    const bridgeQ = supabase as unknown as {
      from: (t: string) => {
        select: (c: string) => Promise<{ data: BridgeRow[] | null; error: { message: string } | null }>
      }
    }
    const [{ data, error: statusErr }, { data: bridgeData, error: bridgeErr }] = await Promise.all([
      supabase.from('sync_status').select('integration, last_run, detail'),
      bridgeQ.from('inbox_bridge_health').select('network, label, connected, status, since, last_checked'),
    ])
    const rows = (data as { integration: string; last_run: string | null; detail: string | null }[]) ?? []
    const bridges = bridgeData ?? []

    // Tell "we couldn't read" apart from "there's nothing there".
    //
    // A hard failure surfaces as an error, but the one that actually caught us
    // does not: an RLS denial is a 200 with zero rows, because the policy
    // filters the table away rather than refusing the request. Both sources
    // then look like five dead integrations at once, which is how a
    // password-only session read as a total outage while the database was
    // seconds-fresh.
    //
    // Neither table is ever legitimately empty in a working install — the
    // heartbeat table always carries its slots — so nothing anywhere means we
    // are not allowed to look, not that nothing is running. Say that instead of
    // inventing five failures.
    if (statusErr || bridgeErr) {
      setItems([{
        key: 'read', label: 'Live data', tone: 'bad', status: "can't read",
        detail: `Query failed: ${(statusErr ?? bridgeErr)?.message ?? 'unknown error'}`,
      }])
      return
    }
    if (!rows.length && !bridges.length) {
      setItems([{
        key: 'read', label: 'Live data', tone: 'bad', status: 'not visible to you',
        detail: 'Signed in, but this account cannot read the inbox tables — so integration status is unknown, not necessarily down. Sign out and back in (completing the authenticator step), or ask an admin to check your staff access.',
      }])
      return
    }

    const now = Date.now()
    const base = SPECS.map((spec) => {
      const row = rows.find((r) => r.integration === spec.key)
      const s = row?.last_run ? Math.floor((now - new Date(row.last_run).getTime()) / 1000) : null
      const okWord = spec.ok ?? 'up to date'
      const g: { tone: Tone; status: string } =
        s == null
          ? { tone: 'warn', status: 'no signal' } // row present, never run — awaiting a first run
          : s < spec.fresh
            ? { tone: 'ok', status: okWord }
            : s < spec.fresh * 8
              ? { tone: 'warn', status: `${rel(s)} ago` }
              : { tone: 'bad', status: `failed · ${rel(s)}` }
      return { key: spec.key, label: spec.label, detail: row?.detail, ...g }
    })
    setItems([...base, beeperItem(bridges, now)])
  }

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 20_000)
    return () => clearInterval(t)
  }, [])

  if (!items.length) return null

  const sq = (t: Tone) =>
    t === 'ok' ? 'var(--color-neutral-700)' : t === 'warn' ? 'var(--color-accent-300)' : 'var(--color-accent)'
  const worst: Tone = items.some((i) => i.tone === 'bad') ? 'bad' : items.some((i) => i.tone === 'warn') ? 'warn' : 'ok'

  return (
    <div
      className="mb-[26px] flex flex-wrap items-center gap-x-5 gap-y-2 py-[9px]"
      style={{ borderTop: '1px solid var(--color-divider)', borderBottom: '1px solid var(--color-divider)' }}
    >
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs muted-70">
        <span className="sq-sm" style={{ background: sq(worst) }} />
        Live
      </span>
      {items.map((it) => (
        <span key={it.key} className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs muted-70" title={it.detail ?? undefined}>
          <span className="sq-sm" style={{ background: sq(it.tone) }} />
          {it.label} ·{' '}
          <span className={it.tone === 'bad' ? 'font-semibold' : undefined} style={it.tone === 'bad' ? { color: 'var(--color-accent-700)' } : undefined}>
            {it.status}
          </span>
        </span>
      ))}
    </div>
  )
}
