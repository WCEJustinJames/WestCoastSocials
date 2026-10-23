import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import type { BeeperClient } from '../adapters/beeper/client'
import type { ChannelAdapter } from '../adapters/types'

type DB = SupabaseClient<Database>

// The SMS bridge is the transport our own alert texts ride — so a drop on it
// can't be texted (the message would need the very bridge that's down); it stays
// in-app only. Everything else (WhatsApp, Messenger, …) gets a text.
const SMS_NETWORK = 'Google Messages'

/** One stored row of per-network bridge health. */
interface HealthRow {
  account_id: string
  network: string
  label: string | null
  provider: string | null
  status: string
  connected: boolean
  last_ok: string | null
  since: string | null
}

export interface BridgeEdge {
  network: string
  label: string | null
}

export interface BridgeCheckResult {
  checked: number
  connected: number
  down: number
  unreachable: boolean
  /** Bridges that flipped connected -> not this pass (edge-once, from DB state). */
  newlyDown: BridgeEdge[]
  /** Bridges that flipped back to connected this pass. */
  newlyUp: BridgeEdge[]
}

// The Beeper account object is loosely typed (`[k]: unknown`); pull the fields
// we surface. `status` is the health flag — "connected" is the only good value.
interface RawAccount {
  accountID: string
  network: string
  status?: string
  user?: { displayText?: string; phoneNumber?: string; fullName?: string }
  bridge?: { provider?: string }
}

// inbox_bridge_health post-dates the generated Database types, so cast.
function tbl(db: DB) {
  return db as unknown as {
    from: (t: string) => {
      select: (c: string) => Promise<{ data: HealthRow[] | null }>
      upsert: (v: unknown, o?: unknown) => Promise<{ error: { message?: string } | null }>
    }
  }
}

const labelOf = (a: RawAccount): string | null =>
  a.user?.displayText ?? a.user?.phoneNumber ?? a.user?.fullName ?? null

/**
 * Poll Beeper Desktop for the state of every connected network (WhatsApp, Google
 * Messages, Messenger, Instagram, …) and mirror it into inbox_bridge_health so
 * the dashboard can alarm the moment a bridge drops — even when nothing is being
 * sent (the send-time circuit-breaker only trips on an actual failed send).
 *
 * A bridge is "down" when its account reports status != 'connected', when it
 * vanishes from the accounts list (logged out / removed), or when Beeper Desktop
 * itself is unreachable (then every known bridge is marked unreachable). Never
 * throws — health monitoring must not be able to wedge the sync loop.
 */
export async function checkBridges(db: DB, beeper: BeeperClient): Promise<BridgeCheckResult> {
  const q = tbl(db)
  const now = new Date().toISOString()

  // Prior state: detect connected->down transitions and accounts that vanished.
  const { data: prior } = await q
    .from('inbox_bridge_health')
    .select('account_id, network, label, provider, status, connected, last_ok, since')
  const priorById = new Map((prior ?? []).map((r) => [r.account_id, r]))

  let accounts: RawAccount[]
  try {
    accounts = (await beeper.listAccounts()) as unknown as RawAccount[]
  } catch {
    // Beeper Desktop unreachable — everything we knew is effectively down.
    const rows = (prior ?? []).map((r) => ({
      account_id: r.account_id,
      network: r.network,
      label: r.label,
      provider: r.provider,
      status: 'unreachable',
      connected: false,
      last_ok: r.last_ok,
      last_checked: now,
      since: r.connected ? now : (r.since ?? now),
      updated_at: now,
    }))
    if (rows.length) {
      const { error } = await q.from('inbox_bridge_health').upsert(rows, { onConflict: 'account_id' })
      if (error) console.error('[bridges] write failed:', error.message)
    }
    return { checked: rows.length, connected: 0, down: rows.length, unreachable: true, newlyDown: [], newlyUp: [] }
  }

  const newlyDown: BridgeEdge[] = []
  const newlyUp: BridgeEdge[] = []
  const rows = accounts.map((a) => {
    const connected = a.status === 'connected'
    const label = labelOf(a)
    const p = priorById.get(a.accountID)
    if (p?.connected && !connected) newlyDown.push({ network: a.network, label })
    if (p && !p.connected && connected) newlyUp.push({ network: a.network, label })
    return {
      account_id: a.accountID,
      network: a.network,
      label,
      provider: a.bridge?.provider ?? null,
      status: a.status ?? 'unknown',
      connected,
      last_ok: connected ? now : (p?.last_ok ?? null),
      last_checked: now,
      // Timestamp of when it left 'connected' — held steady while it stays down.
      since: connected ? null : (p && !p.connected ? p.since : now),
      updated_at: now,
    }
  })

  // Accounts we knew before that are gone now = logged out / removed.
  const seen = new Set(accounts.map((a) => a.accountID))
  for (const p of prior ?? []) {
    if (seen.has(p.account_id)) continue
    if (p.connected) newlyDown.push({ network: p.network, label: p.label })
    rows.push({
      account_id: p.account_id,
      network: p.network,
      label: p.label,
      provider: p.provider,
      status: 'missing',
      connected: false,
      last_ok: p.last_ok,
      last_checked: now,
      since: p.connected ? now : (p.since ?? now),
      updated_at: now,
    })
  }

  if (rows.length) {
    const { error } = await q.from('inbox_bridge_health').upsert(rows, { onConflict: 'account_id' })
    if (error) console.error('[bridges] write failed:', error.message)
  }
  const connected = rows.filter((r) => r.connected).length
  return { checked: rows.length, connected, down: rows.length - connected, unreachable: false, newlyDown, newlyUp }
}

async function safeText(adapter: ChannelAdapter, account: string, phone: string, text: string): Promise<void> {
  if (!adapter.startChatAndSend) return
  try {
    await adapter.startChatAndSend(account, phone, text)
  } catch (e) {
    console.error('[bridges] alert send failed:', e instanceof Error ? e.message : e)
  }
}

/**
 * Text Justin when a bridge drops or recovers. Edge-once (the connected<->down
 * transitions come from DB state, so each fires a single text). The SMS bridge
 * itself is skipped for down-alerts — the text would need the very bridge that's
 * down — so that one stays in-app only via the Home banner. Best-effort.
 */
export async function alertBridgeChanges(
  adapter: ChannelAdapter,
  notifyPhone: string,
  result: BridgeCheckResult,
  notifyAccount = 'gmessages',
): Promise<void> {
  if (!notifyPhone) return
  for (const b of result.newlyUp) {
    await safeText(adapter, notifyAccount, notifyPhone, `WCP Beeper: ${b.network}${b.label ? ` (${b.label})` : ''} is back online.`)
  }
  const down = result.newlyDown.filter((b) => b.network !== SMS_NETWORK)
  if (down.length) {
    const list = down.map((b) => `${b.network}${b.label ? ` (${b.label})` : ''}`).join(', ')
    await safeText(
      adapter,
      notifyAccount,
      notifyPhone,
      `WCP Beeper ALARM: ${list} disconnected — messages on it won't send. Open Beeper on the PC and re-link.`,
    )
  }
}
