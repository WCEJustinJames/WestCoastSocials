// A fake PostgREST and a fake Beeper Desktop API for smsEngine tests.
// Every request to any other host THROWS: on WESTCOAST1, localhost:23373 is
// the live Beeper on the club's SMS account, and the real project is live.
// Numbers are ACMA fictional ones (0491 570 xxx and friends).

import type { Deps, EngineConfig } from '../smsEngine'

export const SUPA = 'https://fake-project.supabase.test'
export const BEEPER = 'http://beeper.fake.test:1'
export const SMS = 'gmessages.test/1'

export const KEYS = ['491570156', '491570157', '491570158', '491570159', '491570110', '491570313', '491570737', '491571266', '491571491', '491571804', '491572549', '491572665', '491572983', '491573770', '491573087']

type Row = Record<string, any>
export interface Req { method: string; host: 'pg' | 'beeper'; path: string; url: string; body: any; headers: Record<string, string>; signal: boolean; at: number }

const isoish = (v: unknown) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)
function cmp(a: any, b: string): number {
  if (isoish(a) && isoish(b)) return new Date(a).getTime() - new Date(b).getTime()
  if (typeof a === 'number' || (/^-?\d+(\.\d+)?$/.test(b) && a != null && !isNaN(Number(a)))) return Number(a) - Number(b)
  return String(a) < b ? -1 : String(a) > b ? 1 : 0
}
function test1(row: Row, col: string, expr: string): boolean {
  const v = row[col]
  if (expr === 'is.null') return v == null
  if (expr === 'not.is.null') return v != null
  const dot = expr.indexOf('.')
  const op = expr.slice(0, dot)
  const val = expr.slice(dot + 1)
  switch (op) {
    case 'eq': return v != null && cmp(v, val) === 0
    case 'neq': return v == null || cmp(v, val) !== 0
    case 'lt': return v != null && cmp(v, val) < 0
    case 'lte': return v != null && cmp(v, val) <= 0
    case 'gt': return v != null && cmp(v, val) > 0
    case 'gte': return v != null && cmp(v, val) >= 0
    case 'in': return val.replace(/^\(|\)$/g, '').split(',').includes(String(v))
    default: throw new Error(`fake pg: unsupported op ${op}`)
  }
}
function orMatch(row: Row, expr: string): boolean {
  return expr.replace(/^\(|\)$/g, '').split(',').some((part) => {
    const dot = part.indexOf('.')
    return test1(row, part.slice(0, dot), part.slice(dot + 1))
  })
}
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict'])
function filterRows(list: Row[], params: URLSearchParams): Row[] {
  return list.filter((r) => [...params.entries()].every(([k, v]) => {
    if (RESERVED.has(k)) return true
    if (k === 'or') return orMatch(r, v)
    return test1(r, k, v)
  }))
}

let seq = 0
export const uid = (tag = 'x') => `${tag}-${(++seq).toString().padStart(6, '0')}-aaaa`

export class FakePg {
  tables: Record<string, Row[]> = {
    inbox_settings: [{ id: 1, sends_paused: false, new_chat_daily_cap: 50, new_chat_spacing_seconds: 180 }],
    inbox_batches: [],
    inbox_batch_items: [],
    inbox_new_chat_log: [],
    inbox_outreach: [],
    inbox_conversations: [],
  }
  rpc: Record<string, (body: any) => unknown> = {
    outreach_canonical_suppression_reason: () => null,
    inbox_auto_pause: () => { this.tables.inbox_settings[0].sends_paused = true; return null },
  }
  /** Return a Response to intercept a request (fault injection). */
  intercept: ((req: Req) => Response | undefined | Promise<Response | undefined>) | null = null
  /** Runs before a PATCH is applied (to model a concurrent hub write). */
  beforePatch: ((table: string, params: URLSearchParams, body: Row) => void) | null = null

  constructor(private clock: { now: number }) {}

  async handle(req: Req): Promise<Response> {
    const hit = this.intercept && (await this.intercept(req))
    if (hit) return hit
    const u = new URL(req.url)
    const path = u.pathname.replace(/^\/rest\/v1\//, '')
    const params = u.searchParams
    if (path.startsWith('rpc/')) {
      const fn = this.rpc[path.slice(4)]
      if (!fn) return new Response('{"message":"no such rpc"}', { status: 404 })
      const out = fn(req.body)
      return new Response(JSON.stringify(out ?? null), { status: 200 })
    }
    const table = this.tables[path]
    if (!table) return new Response(`{"message":"no table ${path}"}`, { status: 404 })
    const prefer = req.headers.Prefer ?? ''
    if (req.method === 'GET') {
      let out = filterRows(table, params)
      const order = params.get('order')
      if (order) {
        const keys = order.split(',').map((o) => o.split('.'))
        out = [...out].sort((a, b) => {
          for (const [col, dir, nulls] of keys) {
            const av = a[col], bv = b[col]
            if (av == null || bv == null) {
              if (av == null && bv == null) continue
              const nf = nulls === 'nullsfirst' ? -1 : 1
              return av == null ? nf : -nf
            }
            const c = cmp(av, String(bv))
            if (c) return dir === 'desc' ? -c : c
          }
          return 0
        })
      }
      const off = Number(params.get('offset') ?? 0)
      const lim = Math.min(Number(params.get('limit') ?? 1000), 1000) // the project's max rows
      return json(out.slice(off, off + lim).map((r) => ({ ...r })))
    }
    if (req.method === 'PATCH') {
      this.beforePatch?.(path, params, req.body)
      const hits = filterRows(table, params)
      for (const r of hits) Object.assign(r, structuredClone(req.body))
      if (prefer.includes('return=representation')) return json(hits.map((r) => ({ ...r })))
      return new Response(null, { status: 204 })
    }
    if (req.method === 'POST') {
      const body = Array.isArray(req.body) ? req.body : [req.body]
      const conflict = params.get('on_conflict')
      for (const b of body) {
        if (path === 'inbox_new_chat_log') {
          if (b.phone_key != null && String(b.phone_key).length !== 9) return new Response('{"code":"23514","message":"violates check constraint"}', { status: 400 })
          if (b.outreach_id && !this.tables.inbox_outreach.some((o) => o.id === b.outreach_id)) return new Response('{"code":"23503","message":"violates foreign key constraint"}', { status: 409 })
        }
        if (conflict && table.some((r) => r[conflict] === b[conflict])) {
          if (prefer.includes('ignore-duplicates')) continue
          return new Response('{"code":"23505"}', { status: 409 })
        }
        table.push({ id: uid('row'), opened_at: new Date(this.clock.now).toISOString(), ...b })
      }
      return new Response(null, { status: 201 }) // return=minimal: EMPTY body
    }
    throw new Error(`fake pg: ${req.method} unsupported`)
  }
}

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
}

export interface FakeChat { id: string; accountID: string; type?: string; title?: string; lastActivity?: string; participants?: { items: Array<{ isSelf?: boolean; phoneNumber?: string }> } }

export class FakeBeeper {
  accounts: Row[] = [
    { accountID: SMS, network: 'Google Messages', status: 'connected' },
    { accountID: 'whatsapp.test', network: 'WhatsApp', status: 'connected' },
  ]
  chats: FakeChat[] = []
  messages = new Map<string, Row[]>()
  /** Read-back statuses per pending message id: consumed one per read; the
   *  last repeats. Default SUCCESS. Use null for "no sendStatus". */
  statuses = new Map<string, Array<string | null>>()
  defaultStatus: Array<string | null> = ['SUCCESS']
  intercept: ((req: Req) => Response | undefined | 'throw' | Promise<Response | undefined | 'throw'>) | null = null
  honoursAccountFilter = true
  private n = 0
  constructor(private clock: { now: number }) {}

  addSmsChat(key: string, opts: Partial<FakeChat> = {}): string {
    const id = opts.id ?? `!sms-${key}:beeper.local`
    this.chats.push({ id, accountID: SMS, type: 'single', title: 'Contact Name', lastActivity: new Date(this.clock.now - 86_400_000).toISOString(), participants: { items: [{ isSelf: true, phoneNumber: '+61491579999' }, { phoneNumber: `+61${key}` }] }, ...opts })
    return id
  }
  addChat(c: FakeChat): void { this.chats.push(c) }

  async handle(req: Req): Promise<Response> {
    const hit = this.intercept && (await this.intercept(req))
    if (hit === 'throw') throw new Error('fetch failed: connection refused')
    if (hit) return hit
    const u = new URL(req.url)
    const p = decodeURIComponent(u.pathname)
    if (req.method === 'GET' && p === '/v1/accounts') return json(this.accounts)
    if (req.method === 'GET' && p === '/v1/chats/search') {
      const accts = u.searchParams.getAll('accountIDs')
      let list = this.chats.filter((c) => (u.searchParams.get('type') ? (c.type ?? 'single') === u.searchParams.get('type') : true))
      if (accts.length && this.honoursAccountFilter) list = list.filter((c) => accts.includes(c.accountID))
      const limit = Number(u.searchParams.get('limit') ?? 50)
      const start = Number(u.searchParams.get('cursor') ?? 0)
      const page = list.slice(start, start + limit)
      const more = start + limit < list.length
      return json({ items: page, hasMore: more, oldestCursor: more ? String(start + limit) : null })
    }
    if (req.method === 'POST' && p === '/v1/chats/start') {
      const phone = req.body?.user?.phoneNumber
      const existing = this.chats.find((c) => c.accountID === req.body?.accountID && c.participants?.items.some((x) => !x.isSelf && x.phoneNumber === phone))
      if (existing) return json({ id: existing.id })
      const id = `!opened-${++this.n}:beeper.local`
      this.chats.push({ id, accountID: req.body.accountID, type: 'single', title: 'Contact Name', lastActivity: new Date(this.clock.now).toISOString(), participants: { items: [{ isSelf: true }, { phoneNumber: phone }] } })
      return json({ id })
    }
    let m = p.match(/^\/v1\/chats\/(.+)\/messages\/([^/]+)$/)
    if (req.method === 'GET' && m) {
      const seqList = this.statuses.get(m[2]) ?? this.defaultStatus
      const s = seqList.length > 1 ? seqList.shift()! : seqList[0]
      return json({ id: m[2], chatID: m[1], ...(s ? { sendStatus: { status: s, ...(s.startsWith('FAIL') ? { reason: 'carrier rejected' } : {}) } } : {}) })
    }
    m = p.match(/^\/v1\/chats\/(.+)\/messages$/)
    if (m) {
      const chatId = m[1]
      if (!this.chats.some((c) => c.id === chatId)) return new Response('{"message":"chat not found"}', { status: 404 })
      if (req.method === 'GET') return json({ items: [...(this.messages.get(chatId) ?? [])].reverse() })
      const pm = `pm-${++this.n}`
      const list = this.messages.get(chatId) ?? []
      list.push({ id: pm, isSender: true, text: req.body?.text ?? '', timestamp: new Date(this.clock.now).toISOString(), attachment: req.body?.attachment })
      this.messages.set(chatId, list)
      return json({ chatID: chatId, pendingMessageID: pm })
    }
    if (req.method === 'POST' && p === '/v1/assets/upload/base64') return json({ uploadID: 'up-1', mimeType: 'image/jpeg' })
    return new Response(`{"message":"fake beeper: no route ${req.method} ${p}"}`, { status: 404 })
  }

  posts(chatId?: string): Row[] {
    return [...this.messages.entries()].filter(([c]) => !chatId || c === chatId).flatMap(([, l]) => l)
  }
}

export interface World {
  clock: { now: number }
  pg: FakePg
  bp: FakeBeeper
  reqs: Req[]
  deps: Deps
  cfg: EngineConfig
  logs: string[]
  readSignals: number[]
}

export function makeWorld(startIso = '2026-10-20T02:00:00.000Z'): World {
  const clock = { now: new Date(startIso).getTime() }
  const pg = new FakePg(clock)
  const bp = new FakeBeeper(clock)
  const reqs: Req[] = []
  const logs: string[] = []
  const readSignals: number[] = []
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url)
    const host = u.origin === SUPA ? 'pg' : u.origin === BEEPER ? 'beeper' : null
    if (!host) throw new Error(`fake world: refused request to ${u.origin} (only fakes are allowed)`)
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : init.body
    const req: Req = { method: init.method ?? 'GET', host, path: decodeURIComponent(u.pathname), url, body, headers: (init.headers as Record<string, string>) ?? {}, signal: !!init.signal, at: clock.now }
    reqs.push(req)
    return host === 'pg' ? pg.handle(req) : bp.handle(req)
  }
  const deps: Deps = {
    fetch,
    now: () => clock.now,
    sleep: async (ms) => { clock.now += ms },
    log: (m) => logs.push(m),
    timeoutSignal: (ms) => { readSignals.push(ms); return AbortSignal.timeout(ms) },
  }
  const cfg: EngineConfig = { supabaseUrl: SUPA, serviceKey: 'fake-service-key', beeperUrl: BEEPER, beeperToken: 'fake-token', smsAccountId: SMS }
  return { clock, pg, bp, reqs, deps, cfg, logs, readSignals }
}

/** Seed a batch with items. Items get strictly increasing created_at. */
export function seedBatch(w: World, status: string, items: Array<Partial<Row> & { data?: Row }>, extra: Row = {}): { batch: Row; items: Row[] } {
  const batch = { id: uid('batch'), status, expires_at: new Date(w.clock.now + 12 * 3_600_000).toISOString(), is_outreach: true, created_at: new Date(w.clock.now - 3_600_000 + w.pg.tables.inbox_batches.length).toISOString(), ...extra }
  w.pg.tables.inbox_batches.push(batch)
  const rowsOut = items.map((it, i) => {
    const r = { id: uid('item'), batch_id: batch.id, status: 'approved', rendered_text: `Hi there, game on tonight ${i}`, data: {}, claimed_at: null, error: null, guard_reason: null, guard_flag: false, chat_id: null, pending_message_id: null, pending_chat_id: null, park_checks: 0, park_checked_at: null, created_at: new Date(w.clock.now - 1_800_000 + i * 1000).toISOString(), ...it }
    w.pg.tables.inbox_batch_items.push(r)
    return r
  })
  return { batch, items: rowsOut }
}

export const smsItem = (key: string, extra: Row = {}) => ({ data: { channel: 'sms', phone: `0${key}`, account_id: 'gmessages', ...extra } })
export const threadItem = (chatId: string, extra: Row = {}) => ({ data: { channel: 'thread', beeper_chat_id: chatId, ...extra } })

export function item(w: World, id: string): Row {
  return w.pg.tables.inbox_batch_items.find((r) => r.id === id)!
}

export const beeperReqs = (w: World, re?: RegExp) => w.reqs.filter((r) => r.host === 'beeper' && (!re || re.test(`${r.method} ${r.path}`)))
export const pgReqs = (w: World, re?: RegExp) => w.reqs.filter((r) => r.host === 'pg' && (!re || re.test(`${r.method} ${r.path.replace(/^\/rest\/v1\//, '')}`)))
