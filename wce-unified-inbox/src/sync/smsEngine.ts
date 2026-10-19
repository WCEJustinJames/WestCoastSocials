// smsEngine — the batch send rail, rebuilt for the 2026-10-17 contract
// (westcoast-poker docs/INBOX_WORKER_WRITEBACK.md) and the 2026-10-19
// engine-upgrade checklist (ENG-xx references below).
//
// What changed from the old processBatches():
//   - SMS items are sent BY NUMBER on the configured Google Messages account
//     (SMS_BEEPER_ACCOUNT_ID), never to a stored chat id and never on the
//     literal 'gmessages' account, which has not existed since 18 Oct.
//   - A number with no chat is OPENED with POST /v1/chats/start, under the
//     daily cap and spacing in inbox_settings, each open reserved in
//     inbox_new_chat_log (kind 'marketing', op_id 'item:<id>') BEFORE the open.
//   - A post's 2xx is acceptance, not delivery: the pendingMessageID is parked
//     on the item and read back; only the bridge's FAIL verdict is a failure.
//   - Every write on an item is fenced on the claim it belongs to.
//   - A run of failures, or a dead bridge, calls inbox_auto_pause().
//
// All I/O goes through the injected `deps.fetch`, so smsEngine.test.ts runs
// whole passes against a fake Beeper and a fake PostgREST with no network.
// Nothing here uses supabase-js; the engine's own guard checks (which do)
// come in through `hooks`.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface Deps {
  fetch: FetchLike
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (msg: string) => void
  /** Injected so tests can see that every read-back carries a timeout. */
  timeoutSignal?: (ms: number) => AbortSignal
}

export interface EngineConfig {
  supabaseUrl: string
  serviceKey: string
  beeperUrl: string
  beeperToken: string
  /** The Beeper account id of the club's Google Messages (SMS) line, e.g.
   *  'gmessages.<login>/<n>' since 18 Oct. Never the bare 'gmessages'. */
  smsAccountId: string
}

export const REQUEST_TIMEOUT_MS = 20_000
export const SEND_DELAY_MS = 1500
export const MAX_PER_PASS = 20
/** Approved items read per page of a batch; held ones are paged past (FIX-3). */
export const ITEM_PAGE = 60
export const ITEM_MAX_PAGES = 50
export const STALE_CLAIM_MS = 5 * 60_000
export const FAIL_STREAK_PAUSE = 5
export const UNREACHABLE_PASSES_PAUSE = 2
/** ...and down at least this long before an outage pauses sends. */
export const UNREACHABLE_MIN_MS = 2 * 60_000
export const ENUM_PAGE_LIMIT = 200
export const ENUM_MAX_PAGES = 40
export const COUNT_PAGE = 500
export const CONFIRM_TRIES = 6
export const CONFIRM_WAIT_MS = 1000
/** All read-backs of one pass share this budget (ENG-47). A pass drains up to
 *  MAX_PER_PASS sends, so this is sized for a few quiet windows, not twenty. */
export const CONFIRM_BUDGET_MS = 60_000
export const PARK_MAX_CHECKS = 10
export const PARK_BACKOFF_CAP_MIN = 5
export const MIN_BEEPER_VERSION = '4.2.808'

/** Reads the engine's send settings, naming every missing one (ENG-12). */
export function readEngineConfig(env: Record<string, string | undefined>): EngineConfig {
  const missing: string[] = []
  const need = (name: string, ...alts: string[]): string => {
    for (const n of [name, ...alts]) {
      const v = (env[n] ?? '').trim()
      if (v) return v
    }
    missing.push(name)
    return ''
  }
  const supabaseUrl = need('SUPABASE_URL').replace(/\/+$/, '')
  const serviceKey = need('SUPABASE_SERVICE_ROLE_KEY')
  const beeperToken = need('BEEPER_ACCESS_TOKEN')
  const smsAccountId = need('SMS_BEEPER_ACCOUNT_ID')
  if (missing.length) {
    throw new Error(`engine: missing environment: ${missing.join(', ')} (SMS_BEEPER_ACCOUNT_ID is the Google Messages account id from GET /v1/accounts)`)
  }
  if (smsAccountId === 'gmessages') {
    throw new Error("engine: SMS_BEEPER_ACCOUNT_ID is the bare 'gmessages', which no longer exists; use the full id from GET /v1/accounts")
  }
  const beeperUrl = ((env.BEEPER_BASE_URL ?? env.BEEPER_API_URL ?? '').trim() || 'http://localhost:23373').replace(/\/+$/, '')
  return { supabaseUrl, serviceKey, beeperUrl, beeperToken, smsAccountId }
}

/** readEngineConfig without the throw: a bad SMS setting disables only the
 *  send rail; the mirror and every other job keep running. */
export function tryReadEngineConfig(env: Record<string, string | undefined>): { cfg: EngineConfig | null; error: string | null } {
  try {
    return { cfg: readEngineConfig(env), error: null }
  } catch (e) {
    return { cfg: null, error: (e as Error).message }
  }
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** 9-digit AU key: digits only, then a leading '61', then a leading '0' (ENG-45). */
export function phoneKey(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '').replace(/^61/, '').replace(/^0/, '')
}

/** Only a mobile (4xxxxxxxx) is an SMS destination; a landline also
 *  normalises to nine digits, so the shape is checked, not the length. */
export function isMobileKey(key: string): boolean {
  return /^4\d{8}$/.test(key)
}

/** Perth midnight (fixed UTC+8) of `nowMs`, as an ISO instant. */
export function perthDayStartIso(nowMs: number): string {
  const day = new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10)
  return new Date(`${day}T00:00:00+08:00`).toISOString()
}

export interface BeeperChatLite {
  id?: string
  accountID?: string
  type?: string
  lastActivity?: string | null
  participants?: { items?: Array<{ isSelf?: boolean; phoneNumber?: string | null }> }
}

/** The chat-matching rule (ENG-44): a single chat, on exactly the SMS
 *  account, with a non-self participant whose number reduces to the key.
 *  Most recent wins. Never another network's chat. */
export function chooseChat(chats: unknown, key: string, accountId: string): string | null {
  const list = Array.isArray(chats) ? (chats as BeeperChatLite[]) : []
  const matches = list.filter((c) => {
    if (!c || (c.type && c.type !== 'single')) return false
    if (String(c.accountID ?? '') !== accountId) return false
    return (c.participants?.items ?? []).some((p) => !p.isSelf && phoneKey(p.phoneNumber) === key)
  })
  if (!matches.length) return null
  matches.sort((a, b) => new Date(b.lastActivity ?? 0).getTime() - new Date(a.lastActivity ?? 0).getTime())
  return matches[0].id ?? null
}

/** True when `version` (e.g. '4.3.209' or '4.3.209.0') is at least `min`. */
export function versionAtLeast(version: string, min = MIN_BEEPER_VERSION): boolean {
  const a = version.split('.').map((n) => Number(n) || 0)
  const b = min.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

// ─── I/O ────────────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message)
  }
}

function bounded(init: RequestInit = {}): RequestInit {
  return { ...init, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
}

const enc = encodeURIComponent

async function rest(deps: Deps, cfg: EngineConfig, path: string, init: RequestInit & { prefer?: string } = {}): Promise<unknown> {
  const { prefer, ...rest_ } = init
  const res = await deps.fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, bounded({
    ...rest_,
    headers: {
      apikey: cfg.serviceKey,
      Authorization: `Bearer ${cfg.serviceKey}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
      ...((rest_.headers as Record<string, string>) ?? {}),
    },
  }))
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new HttpError(`Supabase ${rest_.method ?? 'GET'} ${path.split('?')[0]} → ${res.status} ${text.slice(0, 200)}`, res.status, text)
  }
  if (res.status === 204) return null
  // A 201 with return=minimal has an EMPTY body: never parse nothing (ENG-49).
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

const rows = (v: unknown): any[] => (Array.isArray(v) ? v : [])

async function beeper(deps: Deps, cfg: EngineConfig, path: string, init: RequestInit = {}): Promise<Response> {
  return deps.fetch(`${cfg.beeperUrl}${path}`, bounded({
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.beeperToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  }))
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BatchRow {
  id: string
  status: string
  expires_at: string | null
  is_outreach: boolean | null
  scheduled_for?: string | null
  approved_at?: string | null
  created_at?: string
  attachment_name?: string | null
  attachment_mime?: string | null
}

export interface ItemData {
  channel?: 'sms' | 'thread'
  beeper_chat_id?: string
  conversation_id?: string
  phone?: string
  account_id?: string
  outreach_id?: string
  route_lock?: string
  [k: string]: unknown
}

export interface ItemRow {
  id: string
  batch_id: string
  status?: string
  rendered_text: string | null
  data: ItemData | null
  created_at?: string
  claimed_at?: string | null
  pending_message_id?: string | null
  pending_chat_id?: string | null
  park_checks?: number | null
  park_checked_at?: string | null
  /** Stamped, fenced on the claim, right before POST /messages; never moved.
   *  Set means the message may already be in the chat (FIX-1). */
  post_attempted_at?: string | null
}

export type GuardVerdict = { ok: true } | { ok: false; reason: string }

export interface Hooks {
  /** Engine-side guards run after the claim (rendered text, bans, staff,
   *  no_reply_<n>, live conversation, already-sent ledger). */
  guard?: (ctx: { item: ItemRow; batch: BatchRow; threadChatId: string | null; recipientKey: string }) => Promise<GuardVerdict>
  /** Outreach window / scheduled_for: which approved batches drain now. */
  batchAllowed?: (batch: BatchRow) => boolean
  /** After a 'sent' write (the send ledger). Never writes inbox_outreach. */
  afterSent?: (ctx: { item: ItemRow; batch: BatchRow; chatId: string; recipientKey: string }) => Promise<void>
  /** The batch's own picture, base64 (inbox_batches.attachment_data). */
  attachmentFor?: (batch: BatchRow) => Promise<{ dataBase64: string; fileName?: string; mimeType?: string } | undefined>
}

/** Carried across passes by the caller. */
export interface EngineState {
  unreachablePasses: number
  /** When the current outage was first seen (null while reachable). */
  unreachableSince: number | null
  /** The park and post columns exist (probed until they do, FIX-2). */
  schemaOk: boolean
  /** op_id -> chat id still to fill onto inbox_new_chat_log (ENG-19). */
  fillDebts: Map<string, string>
}

export function newEngineState(): EngineState {
  return { unreachablePasses: 0, unreachableSince: null, schemaOk: false, fillDebts: new Map() }
}

export interface PassOptions {
  /** False in quiet hours: parks still resolve, nothing new is claimed. */
  allowClaims?: boolean
}

export interface PassResult {
  sent: number
  failed: number
  skipped: number
  held: number
  parked: number
  resolved: number
  returned: number
  stuck: number
  paused: boolean
  autoPaused: string | null
  /** Why the send rail did nothing this pass (e.g. the park migration is missing). */
  railDisabled: string | null
}

interface Settings {
  paused: boolean
  cap: number
  spacingSeconds: number
}

interface Pass {
  deps: Deps
  cfg: EngineConfig
  state: EngineState
  hooks: Hooks
  result: PassResult
  settings: Settings | null
  smsReady: boolean
  /** Opens refused for the rest of the pass (count unreadable, reserve failed). */
  opensBlocked: boolean
  failStreak: number
  stop: boolean
  /** Chats this pass opened, by phone key (ENG-15). */
  opened: Map<string, string>
  scan: { chats: BeeperChatLite[]; complete: boolean } | null
  scanFailed: boolean
  sentKeys: Set<string>
  budget: { leftMs: number }
  sends: number
  /** A cap or spacing verdict already known this pass (FIX-3). */
  gateHold: string | null
}

type Outcome = 'sent' | 'failed' | 'skipped' | 'held' | 'parked' | 'lost' | 'returned' | 'uncertain' | 'stopped' | 'batchGone'

// ─── Settings, accounts, auto-pause ─────────────────────────────────────────

async function readSettings(p: Pass): Promise<Settings | null> {
  try {
    const r = rows(await rest(p.deps, p.cfg, 'inbox_settings?id=eq.1&select=sends_paused,new_chat_daily_cap,new_chat_spacing_seconds'))[0]
    if (!r) return null
    return {
      paused: r.sends_paused !== false,
      cap: Number.isFinite(Number(r.new_chat_daily_cap)) ? Math.max(0, Math.floor(Number(r.new_chat_daily_cap))) : 0,
      spacingSeconds: Number.isFinite(Number(r.new_chat_spacing_seconds)) ? Math.max(0, Number(r.new_chat_spacing_seconds)) : 180,
    }
  } catch (e) {
    p.deps.log(`settings unreadable, treating sends as paused: ${(e as Error).message}`)
    return null
  }
}

/** Is the configured SMS account listed and connected (ENG-12)? */
async function checkSmsAccount(p: Pass): Promise<{ reachable: boolean; ready: boolean }> {
  try {
    const res = await beeper(p.deps, p.cfg, '/v1/accounts')
    if (!res.ok) return { reachable: false, ready: false }
    const body = await res.json().catch(() => null)
    const list: any[] = Array.isArray(body) ? body : (body?.items ?? body?.accounts ?? [])
    const acct = list.find((a) => String(a?.accountID ?? a?.id ?? '') === p.cfg.smsAccountId)
    const ready = !!acct && (acct.status === 'connected' || acct.connected === true)
    if (!ready) p.deps.log(`SMS account ${acct ? 'is not connected' : 'is not listed in GET /v1/accounts'}; sms items stay queued`)
    return { reachable: true, ready }
  } catch (e) {
    p.deps.log(`Beeper unreachable: ${(e as Error).message}`)
    return { reachable: false, ready: false }
  }
}

async function autoPause(p: Pass, reason: string): Promise<void> {
  const line = reason.replace(/\s+/g, ' ').slice(0, 280)
  p.stop = true
  p.result.autoPaused = line
  try {
    await rest(p.deps, p.cfg, 'rpc/inbox_auto_pause', { method: 'POST', body: JSON.stringify({ p_reason: line }) })
    p.deps.log(`auto-paused sends: ${line}`)
  } catch (e) {
    p.deps.log(`inbox_auto_pause failed (${(e as Error).message}); stopping claims for this pass anyway`)
  }
}

/** A failure that says the bridge or account is down counts toward the
 *  streak; a per-destination refusal (404 chat, invalid number) does not. */
async function countFailure(p: Pass, perDestination: boolean, what: string): Promise<void> {
  if (perDestination) return
  p.failStreak += 1
  if (p.failStreak >= FAIL_STREAK_PAUSE) {
    await autoPause(p, `${FAIL_STREAK_PAUSE} send failures in a row; last: ${what}`)
  }
}

// ─── Item writes, every one fenced on the claim (ENG-48) ─────────────────────

/** A PostgREST value inside or=(...), double-quoted and escaped. */
function pgQuote(v: string): string {
  return `"${v.slice(0, 200).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function fence(item: { id: string }, claimedAt: string | null, park?: { expect: 'none' | 'id' | 'either'; id?: string }): string {
  let q = `inbox_batch_items?id=eq.${enc(item.id)}&status=eq.sending`
  q += claimedAt ? `&claimed_at=eq.${enc(claimedAt)}` : '&claimed_at=is.null'
  if (park?.expect === 'none') q += '&pending_message_id=is.null'
  if (park?.expect === 'id') q += `&pending_message_id=eq.${enc(park.id ?? '')}`
  if (park?.expect === 'either') q += `&or=${enc(`(pending_message_id.is.null,pending_message_id.eq.${pgQuote(park.id ?? '')})`)}`
  return q
}

async function patchItem(p: Pass, where: string, body: Record<string, unknown>): Promise<number> {
  const r = await rest(p.deps, p.cfg, `${where}&select=id`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: JSON.stringify(body),
  })
  return rows(r).length
}

const nowIso = (p: Pass) => new Date(p.deps.now()).toISOString()

/** 'sent' and chat_id in ONE update, so the outcome trigger heals the
 *  contact's chat id (ENG-29). */
async function writeSent(p: Pass, item: ItemRow, batch: BatchRow, claimedAt: string | null, chatId: string, recipientKey: string, park?: { expect: 'none' | 'id' | 'either'; id?: string }): Promise<Outcome> {
  const n = await patchItem(p, fence(item, claimedAt, park), { status: 'sent', chat_id: chatId })
  if (!n) {
    p.deps.log(`item …${item.id.slice(-3)}: sent write matched nothing (a stale copy); left as is`)
    return 'lost'
  }
  p.failStreak = 0
  p.sentKeys.add(`${batch.id}|${recipientKey}`)
  try {
    await p.hooks.afterSent?.({ item, batch, chatId, recipientKey })
  } catch (e) {
    p.deps.log(`afterSent hook failed: ${(e as Error).message}`)
  }
  return 'sent'
}

/** 'failed' with the API's or bridge's own text, verbatim (ENG-31). */
async function writeFailed(p: Pass, item: ItemRow, claimedAt: string | null, error: string, park?: { expect: 'none' | 'id' | 'either'; id?: string }, clearPark = false): Promise<Outcome> {
  const body: Record<string, unknown> = { status: 'failed', error: error || 'Send failed with no reason from Beeper' }
  if (clearPark) body.pending_message_id = null
  const n = await patchItem(p, fence(item, claimedAt, park), body)
  return n ? 'failed' : 'lost'
}

async function writeSkipped(p: Pass, item: ItemRow, claimedAt: string | null, reason: string): Promise<Outcome> {
  const n = await patchItem(p, fence(item, claimedAt, { expect: 'none' }), { status: 'skipped', guard_flag: true, guard_reason: reason })
  return n ? 'skipped' : 'lost'
}

async function readBatch(p: Pass, batchId: string): Promise<BatchRow | null> {
  return rows(await rest(p.deps, p.cfg, `inbox_batches?id=eq.${enc(batchId)}&select=id,status,expires_at,is_outreach,scheduled_for,approved_at,created_at,attachment_name,attachment_mime`))[0] ?? null
}

function drainable(b: BatchRow | null, nowMs: number): boolean {
  return !!b && (b.status === 'approved' || b.status === 'sending') && !!b.expires_at && new Date(b.expires_at).getTime() > nowMs
}

/** Hand back an item that could not be taken AFTER its claim (ENG-23): only
 *  while its batch still drains; to 'pending' if the batch was parked; left
 *  for a person if the batch was closed. Never after anything was posted. */
async function returnItem(p: Pass, item: ItemRow, claimedAt: string | null, why: string): Promise<Outcome> {
  // A post may already be in the chat (FIX-1): handed back, a fresh claim
  // would post it again. It stays 'sending'; a later reclaim checks the chat
  // before anything is sent.
  if (item.post_attempted_at) {
    p.deps.log(`item …${item.id.slice(-3)} could not go ahead (${why}); it may already have been posted, so it stays 'sending' for a later reclaim`)
    return 'uncertain'
  }
  try {
    const b = await readBatch(p, item.batch_id)
    if (drainable(b, p.deps.now())) {
      await patchItem(p, fence(item, claimedAt, { expect: 'none' }), { status: 'approved', claimed_at: null })
    } else if (b?.status === 'draft') {
      await patchItem(p, fence(item, claimedAt, { expect: 'none' }), { status: 'pending', claimed_at: null })
    } else {
      p.deps.log(`item …${item.id.slice(-3)} could not be taken (${why}) and its batch has left the queue; left 'sending' for a person`)
      p.result.stuck += 1
      return 'uncertain'
    }
  } catch (e) {
    p.deps.log(`item …${item.id.slice(-3)} return failed (${(e as Error).message}); a later pass reclaims it`)
  }
  return 'returned'
}

/** Refresh the claim by compare-and-set on our own stamp (ENG-46). */
async function refreshClaim(p: Pass, item: ItemRow, claimedAt: string | null): Promise<string | null> {
  const r = await rest(p.deps, p.cfg, `${fence(item, claimedAt, { expect: 'none' })}&select=claimed_at`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: JSON.stringify({ claimed_at: nowIso(p) }),
  })
  return rows(r)[0]?.claimed_at ?? null
}

// ─── Finding and opening the SMS chat ───────────────────────────────────────

/** Enumerate the SMS account's single chats ONCE per pass (ENG-13/14). */
async function scanSmsChats(p: Pass): Promise<void> {
  if (p.scan || p.scanFailed) return
  try {
    const chats: BeeperChatLite[] = []
    let cursor: string | null = null
    let complete = false
    for (let page = 0; page < ENUM_MAX_PAGES; page++) {
      const url = `/v1/chats/search?type=single&limit=${ENUM_PAGE_LIMIT}&accountIDs=${enc(p.cfg.smsAccountId)}`
        + (cursor ? `&cursor=${enc(cursor)}&direction=before` : '')
      const res = await beeper(p.deps, p.cfg, url)
      if (!res.ok) throw new Error(`Beeper chat scan → ${res.status}`)
      const body: any = await res.json()
      chats.push(...(Array.isArray(body?.items) ? body.items : []))
      if (!body?.hasMore) { complete = true; break }
      cursor = body?.oldestCursor ?? null
      if (!cursor) break
    }
    if (!complete) p.deps.log(`SMS chat scan stopped before the end (${chats.length} chats read); misses fall back to opening`)
    p.scan = { chats, complete }
  } catch (e) {
    p.scanFailed = true
    p.deps.log(`SMS chat scan failed (${(e as Error).message}); misses fall back to opening`)
  }
}

/** Opened this pass → scan snapshot. Null means "open it". */
async function findSmsChat(p: Pass, key: string): Promise<string | null> {
  const opened = p.opened.get(key)
  if (opened) return opened
  await scanSmsChats(p)
  if (!p.scan) return null
  return chooseChat(p.scan.chats, key, p.cfg.smsAccountId)
}

async function countToday(p: Pass, beforeIso?: string): Promise<number> {
  const start = perthDayStartIso(p.deps.now())
  const cap = p.settings?.cap ?? 0
  let count = 0
  for (let page = 0; ; page++) {
    const q = `inbox_new_chat_log?kind=eq.marketing&opened_at=gte.${enc(start)}`
      + (beforeIso ? `&opened_at=lt.${enc(beforeIso)}` : '')
      + `&select=id&order=opened_at.asc&limit=${COUNT_PAGE}&offset=${page * COUNT_PAGE}`
    const r = rows(await rest(p.deps, p.cfg, q))
    count += r.length
    if (r.length < COUNT_PAGE || count >= cap) return count
  }
}

/** May this item open a chat now? Decided read-only, BEFORE the claim
 *  (ENG-21/22/23). Null = go; a string = hold, with why. */
async function openGate(p: Pass, item: ItemRow): Promise<string | null> {
  if (p.opensBlocked) return 'new chats blocked this pass'
  const s = p.settings
  if (!s) return 'settings unreadable'
  if (s.cap <= 0) return 'new-chat cap is 0'
  try {
    const own = rows(await rest(p.deps, p.cfg, `inbox_new_chat_log?op_id=eq.${enc(`item:${item.id}`)}&select=opened_at`))[0]
    const start = perthDayStartIso(p.deps.now())
    if (own && new Date(own.opened_at).getTime() >= new Date(start).getTime()) {
      // Our own slot today passes while it sits inside the allowance.
      const before = await countToday(p, own.opened_at)
      return before < s.cap ? null : 'cap spent'
    }
    // A verdict already reached this pass holds for the rest of it: held
    // items then cost one read each, not a recount (FIX-3).
    if (p.gateHold) return p.gateHold
    const count = await countToday(p)
    if (count >= s.cap) return (p.gateHold = 'cap spent')
    const latest = rows(await rest(p.deps, p.cfg, 'inbox_new_chat_log?kind=eq.marketing&select=opened_at&order=opened_at.desc&limit=1'))[0]
    if (latest && p.deps.now() - new Date(latest.opened_at).getTime() < s.spacingSeconds * 1000) return (p.gateHold = 'spacing')
    return null
  } catch (e) {
    p.opensBlocked = true
    p.deps.log(`new-chat count unreadable (${(e as Error).message}); opening no chats this pass`)
    return 'count unreadable'
  }
}

type ReserveResult = { ok: true } | { ok: false; returnIt: boolean; error: string }

/** Reserve the slot BEFORE chats/start (ENG-17), one op_id per item. */
async function reserveSlot(p: Pass, item: ItemRow, key: string): Promise<ReserveResult> {
  const opId = `item:${item.id}`
  const post = (outreachId: string | null) => rest(p.deps, p.cfg, 'inbox_new_chat_log?on_conflict=op_id', {
    method: 'POST',
    prefer: 'resolution=ignore-duplicates,return=minimal',
    body: JSON.stringify({ kind: 'marketing', op_id: opId, outreach_id: outreachId, phone_key: key, opened_at: nowIso(p) }),
  })
  try {
    try {
      await post(item.data?.outreach_id ?? null)
    } catch (e) {
      // A contact id the log's FK refuses: reserve without it, once.
      if (e instanceof HttpError && /23503/.test(e.body) && item.data?.outreach_id) await post(null)
      else throw e
    }
  } catch (e) {
    if (e instanceof HttpError && e.status >= 400 && e.status < 500) {
      return { ok: false, returnIt: false, error: `Could not reserve a new-chat slot: ${e.message}` }
    }
    // Timed out or 5xx: it may have committed. Open nothing more this pass;
    // the next pass finds the row by op_id.
    p.opensBlocked = true
    return { ok: false, returnIt: true, error: (e as Error).message }
  }
  // Read it back: ignore-duplicates answers nothing on a conflict.
  const row = rows(await rest(p.deps, p.cfg, `inbox_new_chat_log?op_id=eq.${enc(opId)}&select=opened_at`))[0]
  const start = perthDayStartIso(p.deps.now())
  if (row && new Date(row.opened_at).getTime() < new Date(start).getTime()) {
    // A slot from an earlier Perth day moves onto today before the open (ENG-20).
    await rest(p.deps, p.cfg, `inbox_new_chat_log?op_id=eq.${enc(opId)}&opened_at=lt.${enc(start)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ opened_at: nowIso(p) }),
    })
  }
  return { ok: true }
}

/** POST /v1/chats/start (ENG-16). */
class NoAnswerError extends Error {}

async function startChat(p: Pass, key: string): Promise<string> {
  let res: Response
  try {
    res = await beeper(p.deps, p.cfg, '/v1/chats/start', {
      method: 'POST',
      body: JSON.stringify({ accountID: p.cfg.smsAccountId, user: { phoneNumber: `+61${key}` } }),
    })
  } catch (e) {
    throw new NoAnswerError(`Beeper start chat got no answer: ${(e as Error).message}`)
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new HttpError(`Beeper start chat → ${res.status} ${t.slice(0, 200)}`.trim(), res.status, t)
  }
  const body: any = await res.json().catch(() => ({}))
  const id = body?.id ?? body?.chatID ?? body?.chat?.id ?? null
  if (!id) throw new Error('Beeper start chat answered without a chat id')
  return id
}

async function fillChatId(p: Pass, opId: string, chatId: string): Promise<void> {
  try {
    await rest(p.deps, p.cfg, `inbox_new_chat_log?op_id=eq.${enc(opId)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ chat_id: chatId }),
    })
    p.state.fillDebts.delete(opId)
  } catch {
    p.state.fillDebts.set(opId, chatId)
  }
}

// ─── Sending and confirming ─────────────────────────────────────────────────

type PostResult =
  | { kind: 'accepted'; chatId: string; pendingMessageId: string | null }
  | { kind: 'refused'; status: number; error: string }
  | { kind: 'noAnswer'; error: string }

async function postMessage(p: Pass, chatId: string, text: string, attachment?: unknown): Promise<PostResult> {
  let res: Response
  try {
    res = await beeper(p.deps, p.cfg, `/v1/chats/${enc(chatId)}/messages`, {
      method: 'POST',
      body: JSON.stringify(attachment ? { text, attachment } : { text }),
    })
  } catch (e) {
    return { kind: 'noAnswer', error: `Beeper send got no answer: ${(e as Error).message}` }
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    return { kind: 'refused', status: res.status, error: `Beeper send → ${res.status} ${t.slice(0, 200)}`.trim() }
  }
  const body: any = await res.json().catch(() => ({}))
  return { kind: 'accepted', chatId: body?.chatID ?? chatId, pendingMessageId: body?.pendingMessageID ?? null }
}

/** Is our text already in the chat since `sinceIso`? (ENG-28/53) Throws
 *  when the chat cannot be read: that is no verdict either way. */
async function alreadyInChat(p: Pass, chatId: string, text: string, sinceIso: string): Promise<boolean> {
  const res = await beeper(p.deps, p.cfg, `/v1/chats/${enc(chatId)}/messages?limit=30`)
  if (!res.ok) throw new Error(`Beeper read messages → ${res.status}`)
  const body: any = await res.json()
  const since = new Date(sinceIso).getTime() - 60_000
  return (Array.isArray(body?.items) ? body.items : []).some(
    (m: any) => m?.isSender && (m.text ?? '') === text && new Date(m.timestamp ?? 0).getTime() >= since,
  )
}

/** 'pending': read back, still in flight. 'unanswered': no read got any
 *  answer at all, so no evidence either way (it spends no park check). */
export type ConfirmResult = { verdict: 'sent' } | { verdict: 'failed'; error: string } | { verdict: 'pending' } | { verdict: 'unanswered' } | { verdict: 'deferred' }

/** Read a send back by its pendingMessageID (ENG-25/26/47). Only the two
 *  FAIL states fail; PENDING or an unknown status keeps polling; a message
 *  read back with no status at the window's end counts as sent. */
export async function confirmSend(deps: Deps, cfg: EngineConfig, chatId: string, messageId: string, tries: number, budget: { leftMs: number }): Promise<ConfirmResult> {
  let seen = false
  let reported = false
  for (let i = 0; i < tries; i++) {
    const t0 = deps.now()
    if (i > 0) await deps.sleep(CONFIRM_WAIT_MS)
    const left = budget.leftMs - Math.max(0, deps.now() - t0)
    if (left < 1000) { budget.leftMs = left; return { verdict: 'deferred' } }
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, left)
    const cut = timeoutMs < REQUEST_TIMEOUT_MS
    const signal = (deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms)))(timeoutMs)
    const res = await deps.fetch(`${cfg.beeperUrl}/v1/chats/${enc(chatId)}/messages/${enc(messageId)}`, {
      headers: { Authorization: `Bearer ${cfg.beeperToken}` },
      signal,
    }).catch(() => null)
    const body: any = res?.ok ? await res.json().catch((e) => (e instanceof SyntaxError ? {} : null)) : null
    budget.leftMs -= Math.max(0, deps.now() - t0)
    if (cut && (res == null || (res.ok && body == null))) return { verdict: 'deferred' }
    if (!res?.ok || body == null) continue
    seen = true
    const status = body?.sendStatus?.status
    if (status === 'SUCCESS') return { verdict: 'sent' }
    if (status === 'FAIL_RETRIABLE' || status === 'FAIL_PERMANENT') {
      const reason = body?.sendStatus?.reason ?? body?.sendStatus?.message ?? ''
      return { verdict: 'failed', error: `Beeper send reported ${status}${reason ? `: ${String(reason).slice(0, 200)}` : ''}` }
    }
    reported = reported || Boolean(status)
  }
  if (seen && !reported) return { verdict: 'sent' }
  return seen ? { verdict: 'pending' } : { verdict: 'unanswered' }
}

// ─── One item ───────────────────────────────────────────────────────────────

type Route =
  | { kind: 'thread'; chatId: string | null }
  | { kind: 'sms' }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'none' }

/** Routing (ENG-11/32/33/55): a route-locked or thread item goes to its own
 *  chat; an sms item goes by number on the configured account, whatever its
 *  stored chat id or data.account_id says. */
export function routeOf(data: ItemData | null): Route {
  const d = data ?? {}
  if (d.route_lock === 'messenger') return { kind: 'thread', chatId: d.beeper_chat_id ?? null }
  if (d.channel === 'sms') return { kind: 'sms' }
  if (d.channel === 'thread') return { kind: 'thread', chatId: d.beeper_chat_id ?? null }
  if (d.beeper_chat_id) return { kind: 'thread', chatId: d.beeper_chat_id }
  if (d.conversation_id) return { kind: 'conversation', conversationId: d.conversation_id }
  if (d.phone) return { kind: 'sms' }
  return { kind: 'none' }
}

async function claim(p: Pass, item: ItemRow): Promise<string | null> {
  const r = await rest(p.deps, p.cfg, `inbox_batch_items?id=eq.${enc(item.id)}&status=eq.approved&select=claimed_at`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: JSON.stringify({ status: 'sending', claimed_at: nowIso(p) }),
  })
  return rows(r)[0]?.claimed_at ?? null
}

interface ItemCtx {
  /** A reclaimed item that may already have been posted (ENG-53). */
  reclaimedFrom?: string | null
  claimedAt?: string | null
}

/** Re-read the pause and the batch right before a claim (ENG-03, FIX-5). */
async function claimGate(p: Pass, batchId: string): Promise<BatchRow | 'stopped' | 'batchGone'> {
  const s = await readSettings(p)
  if (!s || s.paused) {
    p.result.paused = true
    p.stop = true
    return 'stopped'
  }
  p.settings = s
  const b = await readBatch(p, batchId)
  if (!drainable(b, p.deps.now())) return 'batchGone'
  if (p.hooks.batchAllowed && !p.hooks.batchAllowed(b!)) return 'batchGone'
  return b!
}

async function processItem(p: Pass, item: ItemRow, batch: BatchRow, ctx: ItemCtx = {}): Promise<Outcome> {
  const data = item.data ?? {}
  let route = routeOf(data)

  // Legacy items routed by conversation row.
  let threadChatId: string | null = route.kind === 'thread' ? route.chatId : null
  if (route.kind === 'conversation') {
    const conv = rows(await rest(p.deps, p.cfg, `inbox_conversations?id=eq.${enc(route.conversationId)}&select=external_chat_id,adapter`))[0]
    threadChatId = conv?.adapter === 'beeper' ? conv.external_chat_id ?? null : null
    route = { kind: 'thread', chatId: threadChatId }
  }

  // ── Read-only decisions BEFORE the claim ──
  let key = ''
  let smsChat: string | null = null
  let needsOpen = false
  let preClaimError: string | null = null
  // A reclaimed item already holds a claim: a wait hands it back (ENG-23).
  // A maybe-posted one is never handed back (returnItem refuses; FIX-1).
  const hold = (why: string): Promise<Outcome> | Outcome =>
    ctx.reclaimedFrom !== undefined
      ? returnItem(p, item, ctx.claimedAt ?? null, why).then((o) => (o === 'returned' ? 'held' : o))
      : 'held'
  if (route.kind === 'sms') {
    key = phoneKey(data.phone)
    if (!key && data.outreach_id) {
      const c = rows(await rest(p.deps, p.cfg, `inbox_outreach?id=eq.${enc(data.outreach_id)}&select=phone`))[0]
      key = phoneKey(c?.phone)
    }
    if (!isMobileKey(key)) {
      preClaimError = key ? 'The number on this item is not an Australian mobile (a landline or malformed), so it cannot get an SMS' : 'This sms item has no phone number'
    } else {
      if (!p.smsReady) return hold('SMS account not ready')
      smsChat = await findSmsChat(p, key)
      if (!smsChat) {
        needsOpen = true
        const why = await openGate(p, item)
        if (why) return hold(why)
      }
    }
  } else if (route.kind === 'thread') {
    if (!threadChatId) preClaimError = 'This thread item has no chat id to send to'
  } else {
    preClaimError = 'This item has neither a chat id nor a phone number'
  }

  // ── The claim (ENG-04) ──
  let claimedAt: string | null
  if (ctx.reclaimedFrom !== undefined) {
    claimedAt = ctx.claimedAt ?? null
  } else {
    // Status, deadline and pause re-read IMMEDIATELY before the claim, after
    // the scan and the cap reads above, which can take a while (FIX-5).
    const gate = await claimGate(p, item.batch_id)
    if (gate === 'stopped' || gate === 'batchGone') return gate
    batch = gate
    claimedAt = await claim(p, item)
    if (!claimedAt) return 'lost'
  }

  if (preClaimError) {
    return writeFailed(p, item, claimedAt, preClaimError, { expect: 'none' })
  }

  const recipientKey = route.kind === 'sms' ? `+61${key}` : threadChatId!
  const dedupeKey = `${batch.id}|${recipientKey}`

  // Canonical suppression, before any lookup that spends anything (ENG-10).
  if (data.outreach_id) {
    let reason: unknown
    try {
      reason = await rest(p.deps, p.cfg, 'rpc/outreach_canonical_suppression_reason', {
        method: 'POST',
        body: JSON.stringify({ p_outreach_id: data.outreach_id }),
      })
    } catch (e) {
      return returnItem(p, item, claimedAt, `suppression check failed: ${(e as Error).message}`)
    }
    if (typeof reason === 'string' && reason) return writeSkipped(p, item, claimedAt, reason)
  }

  if (p.hooks.guard) {
    const v = await p.hooks.guard({ item, batch, threadChatId, recipientKey })
    if (!v.ok) return writeSkipped(p, item, claimedAt, v.reason)
  }
  if (p.sentKeys.has(dedupeKey)) return writeSkipped(p, item, claimedAt, 'dup_in_pass')

  // ── Open the chat if none was found (ENG-16/17/19/20) ──
  let chatId = route.kind === 'sms' ? smsChat : threadChatId
  if (route.kind === 'sms' && needsOpen) {
    const again = p.opened.get(key)
    if (again) {
      chatId = again
    } else {
      claimedAt = await refreshClaim(p, item, claimedAt)
      if (!claimedAt) return 'lost'
      const r = await reserveSlot(p, item, key)
      if (!r.ok) {
        if (r.returnIt) return returnItem(p, item, claimedAt, r.error)
        return writeFailed(p, item, claimedAt, r.error, { expect: 'none' })
      }
      try {
        chatId = await startChat(p, key)
      } catch (e) {
        const msg = (e as Error).message
        if (e instanceof NoAnswerError) {
          // The chat may exist now; nothing was posted. Hand the item back and
          // let the next pass's scan find the chat under the same slot.
          p.opensBlocked = true
          await countFailure(p, false, msg)
          return returnItem(p, item, claimedAt, msg)
        }
        const perDest = e instanceof HttpError && (e.status === 400 || e.status === 404 || e.status === 422)
        const o = await writeFailed(p, item, claimedAt, msg, { expect: 'none' })
        await countFailure(p, perDest, msg)
        return o
      }
      p.opened.set(key, chatId)
      await fillChatId(p, `item:${item.id}`, chatId)
    }
  }

  // ── Post (ENG-46: refresh the claim right before, never after) ──
  const text = item.rendered_text ?? ''
  let postAttemptedAt: string
  if (item.post_attempted_at) {
    // It may already be in the chat (a crash after the post, or a row that
    // carries an earlier attempt): look before any resend (FIX-1, ENG-53).
    claimedAt = await refreshClaim(p, item, claimedAt)
    if (!claimedAt) return 'lost'
    postAttemptedAt = item.post_attempted_at
    try {
      if (await alreadyInChat(p, chatId!, text, postAttemptedAt)) {
        return writeSent(p, item, batch, claimedAt, chatId!, recipientKey, { expect: 'none' })
      }
    } catch (e) {
      p.deps.log(`item …${item.id.slice(-3)}: could not check the chat before a resend (${(e as Error).message}); left for a later pass`)
      return 'uncertain'
    }
  } else {
    // Stamp the attempt with the claim refresh, fenced on our claim, BEFORE
    // the post, and never move it afterwards (FIX-1).
    const stamp = rows(await rest(p.deps, p.cfg, `${fence(item, claimedAt, { expect: 'none' })}&post_attempted_at=is.null&select=claimed_at,post_attempted_at`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: JSON.stringify({ claimed_at: nowIso(p), post_attempted_at: nowIso(p) }),
    }))[0]
    if (!stamp?.claimed_at) return 'lost'
    claimedAt = stamp.claimed_at as string
    postAttemptedAt = stamp.post_attempted_at as string
    item.post_attempted_at = postAttemptedAt
  }

  let attachment: unknown
  if (p.hooks.attachmentFor) {
    try {
      const a = await p.hooks.attachmentFor(batch)
      if (a) attachment = await uploadAttachment(p, a)
    } catch (e) {
      p.deps.log(`picture upload failed (${(e as Error).message}); sending the text alone`)
      attachment = undefined
    }
  }

  const post = await postMessage(p, chatId!, text, attachment)
  if (post.kind === 'refused') {
    const o = await writeFailed(p, item, claimedAt, post.error, { expect: 'none' })
    await countFailure(p, post.status === 404, post.error)
    return o
  }
  if (post.kind === 'noAnswer') {
    // It may still deliver: never repost; look for it first (ENG-28).
    try {
      if (await alreadyInChat(p, chatId!, text, postAttemptedAt)) {
        return writeSent(p, item, batch, claimedAt, chatId!, recipientKey, { expect: 'none' })
      }
    } catch {
      await countFailure(p, false, post.error)
      p.deps.log(`item …${item.id.slice(-3)}: post got no answer and the chat could not be read; left 'sending' for a later pass`)
      return 'uncertain'
    }
    const o = await writeFailed(p, item, claimedAt, post.error, { expect: 'none' })
    await countFailure(p, false, post.error)
    return o
  }

  if (!post.pendingMessageId) return writeSent(p, item, batch, claimedAt, post.chatId, recipientKey, { expect: 'none' })

  // Park BEFORE the read-back (ENG-27).
  const pm = post.pendingMessageId
  try {
    await patchItem(p, fence(item, claimedAt, { expect: 'none' }), { pending_message_id: pm, pending_chat_id: post.chatId, park_checked_at: nowIso(p), park_checks: 0 })
  } catch (e) {
    p.deps.log(`item …${item.id.slice(-3)}: park write failed (${(e as Error).message}); confirming anyway`)
  }
  const v = await confirmSend(p.deps, p.cfg, post.chatId, pm, CONFIRM_TRIES, p.budget)
  try {
    if (v.verdict === 'sent') return await writeSent(p, item, batch, claimedAt, post.chatId, recipientKey, { expect: 'either', id: pm })
    if (v.verdict === 'failed') {
      const o = await writeFailed(p, item, claimedAt, v.error, { expect: 'either', id: pm }, true)
      await countFailure(p, false, v.error)
      return o
    }
  } catch (e) {
    p.deps.log(`item …${item.id.slice(-3)}: write after read-back failed (${(e as Error).message}); the park stands`)
  }
  return 'parked'
}

async function uploadAttachment(p: Pass, a: { dataBase64: string; fileName?: string; mimeType?: string }): Promise<unknown> {
  const res = await beeper(p.deps, p.cfg, '/v1/assets/upload/base64', {
    method: 'POST',
    body: JSON.stringify({ content: a.dataBase64, fileName: a.fileName, mimeType: a.mimeType }),
  })
  if (!res.ok) throw new Error(`upload → ${res.status}`)
  const up: any = await res.json()
  if (!up?.uploadID) throw new Error(up?.error ?? 'upload answered without an id')
  const mime = up.mimeType ?? a.mimeType ?? ''
  return { uploadID: up.uploadID, mimeType: mime || undefined, fileName: up.fileName ?? a.fileName, type: mime.startsWith('image/') ? 'image' : 'file' }
}

// ─── Parks (ENG-27) ─────────────────────────────────────────────────────────

function parkDue(it: ItemRow, nowMs: number): boolean {
  const checks = Number(it.park_checks) || 0
  if (checks >= PARK_MAX_CHECKS) return false
  if (!it.park_checked_at) return true
  const wait = Math.min(checks + 1, PARK_BACKOFF_CAP_MIN) * 60_000
  return nowMs - new Date(it.park_checked_at).getTime() >= wait
}

/** The send-ledger key for an item: '+61<key>' for SMS however it was
 *  resolved, the chat id otherwise (FIX-6). */
async function recipientKeyOf(p: Pass, it: ItemRow, chat: string): Promise<string> {
  const data = it.data ?? {}
  if (routeOf(data).kind !== 'sms') return data.beeper_chat_id ?? chat
  let key = phoneKey(data.phone)
  if (!key && data.outreach_id) {
    const c = rows(await rest(p.deps, p.cfg, `inbox_outreach?id=eq.${enc(data.outreach_id)}&select=phone`))[0]
    key = phoneKey(c?.phone)
  }
  return isMobileKey(key) ? `+61${key}` : chat
}

async function parkSent(p: Pass, it: ItemRow, chat: string, pm: string): Promise<void> {
  const n = await patchItem(p, fence(it, it.claimed_at ?? null, { expect: 'id', id: pm }), { status: 'sent', chat_id: chat })
  if (!n) return
  p.result.resolved += 1
  const batch = await readBatch(p, it.batch_id)
  if (batch) {
    try {
      await p.hooks.afterSent?.({ item: it, batch, chatId: chat, recipientKey: await recipientKeyOf(p, it, chat) })
    } catch { /* the ledger is best-effort */ }
  }
}

/** Is the outbound copy in the inbox mirror? (An exhausted park's last test.) */
async function inMirror(p: Pass, chat: string, text: string, sinceIso: string): Promise<boolean> {
  const convs = rows(await rest(p.deps, p.cfg, `inbox_conversations?external_chat_id=eq.${enc(chat)}&select=id`))
  if (!convs.length) return false
  const since = new Date(new Date(sinceIso).getTime() - 60_000).toISOString()
  const msgs = rows(await rest(p.deps, p.cfg,
    `inbox_messages?conversation_id=in.(${convs.map((c) => c.id).join(',')})&direction=eq.outbound&timestamp=gte.${enc(since)}&select=text&limit=50`))
  return msgs.some((m) => (m.text ?? '') === text)
}

async function resolveParks(p: Pass): Promise<void> {
  const PAGE = 100
  for (let page = 0; page < 5 && !p.stop; page++) {
    const list = rows(await rest(p.deps, p.cfg,
      'inbox_batch_items?status=eq.sending&pending_message_id=not.is.null'
      + `&park_checks=lt.${PARK_MAX_CHECKS}`
      + '&select=id,batch_id,claimed_at,rendered_text,data,pending_message_id,pending_chat_id,park_checks,park_checked_at,post_attempted_at'
      + `&order=park_checked_at.asc.nullsfirst&limit=${PAGE}&offset=${page * PAGE}`)) as ItemRow[]
    for (const it of list) {
      if (!parkDue(it, p.deps.now())) continue
      if (p.budget.leftMs < 1000) return
      const pm = it.pending_message_id!
      const chat = it.pending_chat_id!
      const v = await confirmSend(p.deps, p.cfg, chat, pm, 1, p.budget)
      const fenced = { expect: 'id' as const, id: pm }
      try {
        if (v.verdict === 'sent') {
          await parkSent(p, it, chat, pm)
        } else if (v.verdict === 'failed') {
          const n = await patchItem(p, fence(it, it.claimed_at ?? null, fenced), { status: 'failed', error: v.error, pending_message_id: null })
          if (n) p.result.resolved += 1
        } else if (v.verdict === 'pending') {
          const checks = (Number(it.park_checks) || 0) + 1
          if (checks < PARK_MAX_CHECKS) {
            await patchItem(p, fence(it, it.claimed_at ?? null, fenced), { park_checks: checks, park_checked_at: nowIso(p) })
          } else if (await inMirror(p, chat, it.rendered_text ?? '', it.post_attempted_at ?? it.claimed_at ?? nowIso(p))) {
            // Out of checks: the mirror is the last word. Its copy proves it went.
            await parkSent(p, it, chat, pm)
          } else {
            const n = await patchItem(p, fence(it, it.claimed_at ?? null, fenced), {
              status: 'failed',
              park_checks: checks,
              error: `Beeper never confirmed this send after ${checks} checks, and its copy is not in the inbox mirror, so it may not have arrived`,
            })
            if (n) p.result.resolved += 1
          }
        }
        // 'unanswered' (nobody answered the read) and 'deferred' (cut short by
        // the budget): no verdict, and no check spent.
      } catch (e) {
        p.deps.log(`park …${it.id.slice(-3)}: write failed (${(e as Error).message}); retried next pass`)
      }
    }
    if (list.length < PAGE) return
  }
}

// ─── Stale claims (ENG-53) ──────────────────────────────────────────────────

const RECLAIM_PAGE = 20
const RECLAIM_MAX_PAGES = 10

async function reclaimStale(p: Pass): Promise<void> {
  const cutoff = new Date(p.deps.now() - STALE_CLAIM_MS).toISOString()
  const batches = new Map<string, BatchRow | null>()
  // Rows left alone this pass (stuck in a closed batch, or waiting for the
  // SMS account) stay in the stale set; page past them so they never starve
  // a real orphan behind them.
  let skipped = 0
  for (let page = 0; page < RECLAIM_MAX_PAGES; page++) {
    const list = rows(await rest(p.deps, p.cfg,
      'inbox_batch_items?status=eq.sending&pending_message_id=is.null'
      + `&or=(claimed_at.lt.${enc(cutoff)},claimed_at.is.null)`
      + '&select=id,batch_id,claimed_at,rendered_text,data,created_at,post_attempted_at'
      + `&order=claimed_at.asc.nullsfirst,id.asc&limit=${RECLAIM_PAGE}&offset=${skipped}`)) as ItemRow[]
    for (const it of list) {
      if (p.stop || p.sends >= MAX_PER_PASS) return
      if (!batches.has(it.batch_id)) batches.set(it.batch_id, await readBatch(p, it.batch_id))
      const listed = batches.get(it.batch_id) ?? null
      if (!drainable(listed, p.deps.now()) || (p.hooks.batchAllowed && !p.hooks.batchAllowed(listed!))) {
        if (!drainable(listed, p.deps.now())) {
          p.deps.log(`stale item …${it.id.slice(-3)}: its batch has left the queue; left 'sending' for a person`)
          p.result.stuck += 1
        }
        skipped++
        continue
      }
      // An sms item whose chat cannot be looked up now might already have
      // been posted; wait for the account rather than hand it back unchecked.
      if (routeOf(it.data).kind === 'sms' && !p.smsReady) { skipped++; continue }
      try {
        // A reclaim is a claim: the pause and the batch, re-read right before (FIX-5).
        const gate = await claimGate(p, it.batch_id)
        if (gate === 'stopped') return
        if (gate === 'batchGone') { batches.set(it.batch_id, null); skipped++; continue }
        const old = it.claimed_at ?? null
        const r = await rest(p.deps, p.cfg, `${fence(it, old, { expect: 'none' })}&select=claimed_at`, {
          method: 'PATCH',
          prefer: 'return=representation',
          body: JSON.stringify({ claimed_at: nowIso(p) }),
        })
        const mine = rows(r)[0]?.claimed_at ?? null
        if (!mine) continue
        const outcome = await processItem(p, it, gate, { reclaimedFrom: old, claimedAt: mine })
        tally(p, outcome)
      } catch (e) {
        p.deps.log(`stale item …${it.id.slice(-3)}: ${(e as Error).message}`)
      }
    }
    if (list.length < RECLAIM_PAGE) return
  }
}

// ─── The pass ───────────────────────────────────────────────────────────────

function tally(p: Pass, o: Outcome): void {
  const r = p.result
  if (o === 'sent') { r.sent++; p.sends++ }
  else if (o === 'failed') { r.failed++; p.sends++ }
  else if (o === 'skipped') r.skipped++
  else if (o === 'held') r.held++
  else if (o === 'parked') { r.parked++; p.sends++ }
  else if (o === 'returned') r.returned++
}

async function payFillDebts(p: Pass): Promise<void> {
  for (const [opId, chatId] of [...p.state.fillDebts]) await fillChatId(p, opId, chatId)
}

/** The park and post columns this rail needs (proposed migration 20261019120000). */
const SCHEMA_PROBE = 'inbox_batch_items?select=pending_message_id,pending_chat_id,park_checks,park_checked_at,post_attempted_at&limit=0'

export async function runPass(deps: Deps, cfg: EngineConfig, state: EngineState, hooks: Hooks = {}, opts: PassOptions = {}): Promise<PassResult> {
  const p: Pass = {
    deps, cfg, state, hooks,
    result: { sent: 0, failed: 0, skipped: 0, held: 0, parked: 0, resolved: 0, returned: 0, stuck: 0, paused: false, autoPaused: null, railDisabled: null },
    settings: null, smsReady: false, opensBlocked: false, failStreak: 0, stop: false,
    opened: new Map(), scan: null, scanFailed: false, sentKeys: new Set(),
    budget: { leftMs: CONFIRM_BUDGET_MS }, sends: 0, gateHold: null,
  }

  // No send rail without its columns: probed until they exist (FIX-2).
  if (!state.schemaOk) {
    try {
      await rest(deps, cfg, SCHEMA_PROBE)
      state.schemaOk = true
    } catch (e) {
      p.result.railDisabled = `send rail OFF: the park columns are missing (apply migration 20261019120000): ${(e as Error).message}`
      deps.log(p.result.railDisabled)
      return p.result
    }
  }

  try {
    await drain(p, opts)
  } catch (e) {
    // Nothing in the rail may take the rest of the engine down with it.
    deps.log(`send rail error (pass abandoned, retried next pass): ${(e as Error).message}`)
  }
  return p.result
}

async function drain(p: Pass, opts: PassOptions): Promise<void> {
  const { deps, cfg, state, hooks } = p
  // Read-only bookkeeping runs even while paused (ENG-06).
  await payFillDebts(p)
  p.settings = await readSettings(p)
  const acct = await checkSmsAccount(p)
  p.smsReady = acct.ready
  const paused = !p.settings || p.settings.paused
  p.result.paused = paused

  // With Beeper unreachable a read-back can prove nothing; spend no checks.
  if (acct.reachable) {
    try {
      await resolveParks(p)
    } catch (e) {
      deps.log(`park resolution failed: ${(e as Error).message}`)
    }
  }

  // ENG-38(b): Beeper or the SMS account unreachable on consecutive passes
  // AND for at least UNREACHABLE_MIN_MS (Justin, 2026-10-19), counted only
  // while claims are allowed: an overnight restart in quiet hours must not
  // pause the next day's sends.
  if (acct.ready || opts.allowClaims === false) {
    state.unreachablePasses = 0
    state.unreachableSince = null
  } else {
    state.unreachablePasses += 1
    state.unreachableSince ??= deps.now()
  }
  const downMs = state.unreachableSince == null ? 0 : deps.now() - state.unreachableSince
  if (!paused && state.unreachablePasses >= UNREACHABLE_PASSES_PAUSE && downMs >= UNREACHABLE_MIN_MS) {
    const mins = Math.round(downMs / 60_000)
    await autoPause(p, acct.reachable
      ? `The SMS account has not been connected in Beeper for ${mins} min (${state.unreachablePasses} passes in a row)`
      : `Beeper Desktop has been unreachable for ${mins} min (${state.unreachablePasses} passes in a row)`)
    return
  }
  if (paused || opts.allowClaims === false || p.stop) return

  try {
    await reclaimStale(p)
  } catch (e) {
    deps.log(`stale-claim reclaim failed: ${(e as Error).message}`)
  }

  const batches = (rows(await rest(deps, cfg,
    `inbox_batches?status=in.(approved,sending)&expires_at=gt.${enc(nowIso(p))}`
    + '&select=id,status,expires_at,is_outreach,scheduled_for,approved_at,created_at,attachment_name,attachment_mime'
    + '&order=created_at.asc&limit=20')) as BatchRow[])
    .filter((b) => !hooks.batchAllowed || hooks.batchAllowed(b))

  for (const listed of batches) {
    if (p.stop || p.sends >= MAX_PER_PASS) break
    try {
      await drainBatch(p, listed)
    } catch (e) {
      deps.log(`batch …${listed.id.slice(-3)}: ${(e as Error).message}`)
    }
  }
}

async function drainBatch(p: Pass, listed: BatchRow): Promise<void> {
  const { deps, cfg } = p
  await rest(deps, cfg, `inbox_batches?id=eq.${enc(listed.id)}&status=eq.approved`, {
    method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'sending' }),
  })
  // Page through the batch's approved items. Items taken this pass leave the
  // approved set; held or handed-back ones stay, so the next page starts
  // past them and they never starve the items behind them (FIX-3).
  let offset = 0
  let gone = false
  for (let page = 0; page < ITEM_MAX_PAGES && !gone; page++) {
    if (p.stop || p.sends >= MAX_PER_PASS) break
    const items = rows(await rest(deps, cfg,
      `inbox_batch_items?batch_id=eq.${enc(listed.id)}&status=eq.approved`
      + '&select=id,batch_id,status,rendered_text,data,created_at,post_attempted_at'
      + `&order=created_at.asc,id.asc&limit=${ITEM_PAGE}&offset=${offset}`)) as ItemRow[]
    let stayed = 0
    for (const item of items) {
      if (p.stop || p.sends >= MAX_PER_PASS) break
      const before = p.sends
      let outcome: Outcome
      try {
        outcome = await processItem(p, item, listed)
      } catch (e) {
        deps.log(`item …${item.id.slice(-3)}: ${(e as Error).message}`)
        outcome = 'uncertain'
      }
      if (outcome === 'stopped') return
      if (outcome === 'batchGone') { gone = true; break }
      if (outcome === 'held' || outcome === 'returned' || outcome === 'uncertain') stayed++
      tally(p, outcome)
      if (p.sends > before) await deps.sleep(SEND_DELAY_MS)
    }
    offset += stayed
    if (items.length < ITEM_PAGE) break
  }

  // Close only when nothing is left to drain (ENG-54).
  const left = rows(await rest(deps, cfg, `inbox_batch_items?batch_id=eq.${enc(listed.id)}&status=in.(approved,sending)&select=id&limit=1`))
  if (!left.length) {
    await rest(deps, cfg, `inbox_batches?id=eq.${enc(listed.id)}&status=in.(approved,sending)`, {
      method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'sent' }),
    })
  }
}
