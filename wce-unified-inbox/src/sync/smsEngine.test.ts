// node --import tsx --test src/sync/smsEngine.test.ts
// Fakes only: see testkit/fakeWorld.ts. No test reaches the live Beeper or
// the real database, and none calls inbox_auto_pause anywhere but the fake.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runPass, newEngineState, readEngineConfig, chooseChat, phoneKey, isMobileKey, perthDayStartIso, routeOf, versionAtLeast,
  type Hooks,
} from './smsEngine'
import { acquireInstanceLock, AlreadyRunningError } from '../lib/instanceLock'
import { makeWorld, seedBatch, smsItem, threadItem, item, beeperReqs, pgReqs, KEYS, SMS, uid } from './testkit/fakeWorld'

const here = path.dirname(fileURLToPath(import.meta.url))
const pass = (w: ReturnType<typeof makeWorld>, state = newEngineState(), hooks: Hooks = {}, opts = {}) => runPass(w.deps, w.cfg, state, hooks, opts)
const status = (w: ReturnType<typeof makeWorld>, id: string) => item(w, id).status
const noSpacing = (w: ReturnType<typeof makeWorld>) => { w.pg.tables.inbox_settings[0].new_chat_spacing_seconds = 0 }

// ── ENG-01 ──────────────────────────────────────────────────────────────────
test('ENG-01 drains only approved and sending batches', async () => {
  const w = makeWorld()
  const ids: Record<string, string> = {}
  for (const [i, st] of ['scheduled', 'draft', 'approved', 'sending', 'canceled', 'sent'].entries()) {
    const chat = `chat-${st}`
    w.bp.addChat({ id: chat, accountID: 'facebookgo.test', type: 'single' })
    const { items } = seedBatch(w, st, [threadItem(chat)], st === 'scheduled' ? { send_at: new Date(w.clock.now - 60_000).toISOString() } : {})
    ids[st] = items[0].id
    void i
  }
  await pass(w)
  assert.equal(status(w, ids.approved), 'sent')
  assert.equal(status(w, ids.sending), 'sent')
  for (const st of ['scheduled', 'draft', 'canceled', 'sent']) {
    assert.equal(status(w, ids[st]), 'approved', st)
    assert.equal(item(w, ids[st]).claimed_at, null)
    assert.equal(beeperReqs(w, new RegExp(`chat-${st}`)).length, 0, st)
  }
})

// ── ENG-02 ──────────────────────────────────────────────────────────────────
test('ENG-02 never claims from a batch past expires_at, even mid-pass', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'c-a', accountID: 'facebookgo.test' })
  w.bp.addChat({ id: 'c-b', accountID: 'facebookgo.test' })
  w.bp.addChat({ id: 'c-b2', accountID: 'facebookgo.test' })
  const A = seedBatch(w, 'approved', [threadItem('c-a')], { expires_at: new Date(w.clock.now - 1000).toISOString() })
  const B = seedBatch(w, 'approved', [threadItem('c-b'), threadItem('c-b2')], { expires_at: new Date(w.clock.now + 60_000).toISOString() })
  // After B's first post, the clock passes B's deadline.
  w.bp.intercept = (r) => { if (r.method === 'POST' && r.path.endsWith('/messages')) w.clock.now += 120_000; return undefined }
  await pass(w)
  assert.equal(status(w, A.items[0].id), 'approved')
  assert.equal(beeperReqs(w, /c-a/).length, 0)
  assert.equal(status(w, B.items[0].id), 'sent')
  assert.equal(status(w, B.items[1].id), 'approved')
  assert.equal(item(w, B.items[1].id).claimed_at, null)
})

test('ENG-02/53 a stale sending item on an expired batch is not reclaimed', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'c-a', accountID: 'facebookgo.test' })
  const A = seedBatch(w, 'sending', [{ ...threadItem('c-a'), status: 'sending', claimed_at: new Date(w.clock.now - 3_600_000).toISOString() }], { expires_at: new Date(w.clock.now - 1000).toISOString() })
  await pass(w)
  assert.equal(status(w, A.items[0].id), 'sending')
  assert.equal(beeperReqs(w, /c-a/).length, 0)
})

// ── ENG-03 ──────────────────────────────────────────────────────────────────
for (const how of ['parked', 'paused', 'expired'] as const) {
  test(`ENG-03 a ${how} batch mid-pass stops the very next claim`, async () => {
    const w = makeWorld()
    for (let i = 0; i < 5; i++) w.bp.addChat({ id: `c${i}`, accountID: 'facebookgo.test' })
    const B = seedBatch(w, 'approved', Array.from({ length: 5 }, (_, i) => threadItem(`c${i}`)))
    w.pg.beforePatch = (table, _params, body) => {
      if (table === 'inbox_batch_items' && body.status === 'sent') {
        const b = w.pg.tables.inbox_batches.find((x) => x.id === B.batch.id)!
        if (how === 'parked') { b.status = 'draft'; for (const it of w.pg.tables.inbox_batch_items) if (it.batch_id === b.id && it.status === 'approved') it.status = 'pending' }
        if (how === 'paused') w.pg.tables.inbox_settings[0].sends_paused = true
        if (how === 'expired') b.expires_at = new Date(w.clock.now - 1).toISOString()
      }
    }
    await pass(w)
    assert.equal(w.bp.posts().length, 1)
    for (const it of B.items.slice(1)) assert.equal(item(w, it.id).claimed_at, null)
  })
}

// ── ENG-04 / ENG-05 ─────────────────────────────────────────────────────────
test('ENG-04 an item changed between read and claim is never posted', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  const B = seedBatch(w, 'approved', [threadItem('c1', { a: 1 }), threadItem('c1', { a: 2 }), threadItem('c1', { a: 3 }), threadItem('c1', { a: 4 })])
  const [i1, i2, i3] = B.items.map((x) => x.id)
  w.pg.beforePatch = (table, params, body) => {
    if (table !== 'inbox_batch_items' || body.status !== 'sending') return
    const id = params.get('id')!.slice(3)
    const r = item(w, id)
    if (id === i1) Object.assign(r, { status: 'skipped', guard_reason: 'Dismissed from the admin hub' })
    if (id === i2) r.status = 'pending'
    if (id === i3) Object.assign(r, { status: 'sent', data: { ...r.data, sent_by: 'phone' } })
  }
  await pass(w)
  await pass(w)
  assert.equal(w.bp.posts('c1').length, 1) // only item 4
  const claims = pgReqs(w, /PATCH inbox_batch_items/).filter((r) => r.body?.status === 'sending')
  for (const c of claims) assert.match(c.url, /status=eq\.approved/)
  // The claim precedes every Beeper call for the claimed item.
  const claimAt = w.reqs.findIndex((r) => r.method === 'PATCH' && r.url.includes(B.items[3].id) && r.body?.status === 'sending')
  const firstPost = w.reqs.findIndex((r) => r.host === 'beeper' && r.method === 'POST')
  assert.ok(claimAt >= 0 && claimAt < firstPost)
})

test('ENG-05 a claimed item finishes when its batch is parked mid-send', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  const B = seedBatch(w, 'approved', [threadItem('c1'), threadItem('c1', { b: 1 })])
  w.bp.intercept = (r) => {
    if (r.method === 'POST' && r.path.endsWith('/messages')) {
      const b = w.pg.tables.inbox_batches[0]
      b.status = 'draft'
      for (const it of w.pg.tables.inbox_batch_items) if (it.status === 'approved') it.status = 'pending'
    }
    return undefined
  }
  await pass(w)
  assert.equal(status(w, B.items[0].id), 'sent')
  assert.ok(item(w, B.items[0].id).chat_id)
  assert.equal(status(w, B.items[1].id), 'pending')
  assert.equal(pgReqs(w, /PATCH inbox_batch_items/).filter((r) => r.url.includes(B.items[0].id) && r.body?.status === 'approved').length, 0)
})

// ── ENG-06 ──────────────────────────────────────────────────────────────────
test('ENG-06 paused: no claims or posts, but parks resolve and fill debts are paid', async () => {
  const w = makeWorld()
  w.pg.tables.inbox_settings[0].sends_paused = true
  w.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  const B = seedBatch(w, 'approved', [threadItem('c1')])
  const parkedAt = new Date(w.clock.now - 10 * 60_000).toISOString()
  const P = seedBatch(w, 'sending', [{ ...threadItem('c1'), status: 'sending', claimed_at: parkedAt, pending_message_id: 'pm-old', pending_chat_id: 'c1', park_checked_at: parkedAt }])
  w.pg.tables.inbox_new_chat_log.push({ id: 'l1', kind: 'marketing', op_id: 'item:debt', chat_id: null, opened_at: new Date(w.clock.now).toISOString() })
  const state = newEngineState()
  state.fillDebts.set('item:debt', '!chat-debt')
  const r = await pass(w, state)
  assert.equal(r.paused, true)
  assert.equal(status(w, B.items[0].id), 'approved')
  assert.equal(beeperReqs(w, /POST/).length, 0)
  assert.equal(status(w, P.items[0].id), 'sent')
  assert.equal(w.pg.tables.inbox_new_chat_log[0].chat_id, '!chat-debt')
})

test('ENG-06 unreadable settings are treated as paused (fail closed)', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  const B = seedBatch(w, 'approved', [threadItem('c1')])
  w.pg.intercept = (r) => (r.path.endsWith('inbox_settings') ? new Response('boom', { status: 500 }) : undefined)
  await pass(w)
  assert.equal(status(w, B.items[0].id), 'approved')
  assert.equal(beeperReqs(w, /POST/).length, 0)
})

test('ENG-06/39 the engine source never writes sends_paused or paused_reason', () => {
  for (const f of ['smsEngine.ts', 'batches.ts']) {
    const src = fs.readFileSync(path.join(here, f), 'utf8')
    assert.doesNotMatch(src, /sends_paused['"]?\s*:/, f)
    assert.doesNotMatch(src, /paused_reason['"]?\s*:/, f)
  }
})

// ── ENG-07 ──────────────────────────────────────────────────────────────────
test('ENG-07 drains in created_at, then id, order', async () => {
  const w = makeWorld()
  for (const c of ['o1', 'o2', 'o3', 'o4']) w.bp.addChat({ id: c, accountID: 'facebookgo.test' })
  const t = new Date(w.clock.now - 60_000).toISOString()
  const B = seedBatch(w, 'approved', [
    { ...threadItem('o1'), rendered_text: 'third', created_at: new Date(w.clock.now - 30_000).toISOString() },
    { ...threadItem('o2'), rendered_text: 'second-b', created_at: t, id: 'item-b' },
    { ...threadItem('o3'), rendered_text: 'second-a', created_at: t, id: 'item-a' },
    { ...threadItem('o4'), rendered_text: 'first', created_at: new Date(w.clock.now - 90_000).toISOString() },
  ])
  void B
  await pass(w)
  assert.deepEqual(beeperReqs(w, /POST .*\/messages$/).map((r) => r.body.text), ['first', 'second-a', 'second-b', 'third'])
  assert.ok(pgReqs(w, /GET inbox_batch_items/).some((r) => r.url.includes('order=created_at.asc%2Cid.asc') || r.url.includes('order=created_at.asc,id.asc')))
})

// ── ENG-09 / ENG-34 / ENG-40 ────────────────────────────────────────────────
test('ENG-09/34 never PATCHes item data and never writes inbox_outreach', async () => {
  const w = makeWorld()
  noSpacing(w)
  w.bp.addChat({ id: 'fb-1', accountID: 'facebookgo.test' })
  w.bp.addSmsChat(KEYS[0])
  const B = seedBatch(w, 'approved', [threadItem('fb-1', { route_lock: 'messenger', route_via: 'own' }), smsItem(KEYS[0]), smsItem(KEYS[1]), smsItem('893001234')])
  const before = B.items.map((x) => JSON.stringify(x.data))
  await pass(w)
  assert.deepEqual(B.items.map((x) => JSON.stringify(item(w, x.id).data)), before)
  assert.equal(pgReqs(w, /PATCH inbox_batch_items/).filter((r) => 'data' in (r.body ?? {}) || 'diagnosis' in (r.body ?? {}) || 'sent_at' in (r.body ?? {})).length, 0)
  assert.equal(pgReqs(w).filter((r) => r.path.includes('inbox_outreach') && r.method !== 'GET').length, 0)
})

test('ENG-40 sends rendered_text byte for byte, one message, no picture upload', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  const text = 'Hi\n\nhttps://example.test/newsletter-images/outreach-x.jpg'
  seedBatch(w, 'approved', [{ ...threadItem('c1', { caption: 'Hi', image_url: 'https://example.test/x.jpg' }), rendered_text: text }])
  await pass(w)
  assert.equal(w.bp.posts('c1').length, 1)
  assert.equal(w.bp.posts('c1')[0].text, text)
  assert.equal(beeperReqs(w, /assets/).length, 0)
})

// ── ENG-10 ──────────────────────────────────────────────────────────────────
test('ENG-10 suppression runs after the claim and before any lookup or open', async () => {
  const w = makeWorld()
  noSpacing(w)
  const [A, Bo, C] = ['out-a', 'out-b', 'out-c']
  for (const id of [A, Bo, C]) w.pg.tables.inbox_outreach.push({ id, phone: null })
  w.pg.rpc.outreach_canonical_suppression_reason = (b) => {
    if (b.p_outreach_id === A) return 'Opted out'
    if (b.p_outreach_id === C) throw new Error('rpc down')
    return null
  }
  const orig = w.pg.handle.bind(w.pg)
  w.pg.handle = async (req) => {
    if (req.path.endsWith('outreach_canonical_suppression_reason') && req.body?.p_outreach_id === C) return new Response('err', { status: 500 })
    return orig(req)
  }
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0], { outreach_id: A }), smsItem(KEYS[1], { outreach_id: Bo }), smsItem(KEYS[2], { outreach_id: C })])
  await pass(w)
  const [ia, ib, ic] = B.items.map((x) => item(w, x.id))
  assert.equal(ia.status, 'skipped')
  assert.equal(ia.guard_reason, 'Opted out')
  assert.equal(ib.status, 'sent')
  assert.equal(ic.status, 'approved')
  assert.equal(ic.claimed_at, null)
  assert.equal(beeperReqs(w, new RegExp(`\\+61${KEYS[0]}|${KEYS[0]}`)).length, 0)
  assert.equal(w.pg.tables.inbox_new_chat_log.filter((r) => r.phone_key === KEYS[0] || r.phone_key === KEYS[2]).length, 0)
  // For B the RPC precedes its chats/start.
  const rpcB = w.reqs.findIndex((r) => r.body?.p_outreach_id === Bo)
  const startB = w.reqs.findIndex((r) => r.path === '/v1/chats/start' && r.body?.user?.phoneNumber === `+61${KEYS[1]}`)
  assert.ok(rpcB >= 0 && rpcB < startB)
})

// ── ENG-11 / ENG-55 ─────────────────────────────────────────────────────────
test('ENG-11 sms items go by number, never to a stored or dead chat id', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'fb-1', accountID: 'facebookgo.test' })
  const c1 = w.bp.addSmsChat(KEYS[0], { id: 'new-gm-1' })
  const c2 = w.bp.addSmsChat(KEYS[1], { id: 'new-gm-2' })
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0], { beeper_chat_id: '!dead:beeper.local' }), smsItem(KEYS[1], { beeper_chat_id: 'fb-1' })])
  await pass(w)
  assert.equal(w.reqs.filter((r) => r.url.includes('dead') || r.url.includes('fb-1')).length, 0)
  assert.equal(item(w, B.items[0].id).chat_id, c1)
  assert.equal(item(w, B.items[1].id).chat_id, c2)
  assert.equal(pgReqs(w, /PATCH/).filter((r) => r.body && 'beeper_chat_id' in r.body).length, 0)
})

test('ENG-55 data.account_id gmessages is ignored; every scan and open uses the configured id', async () => {
  const w = makeWorld()
  noSpacing(w)
  w.bp.addChat({ id: 'old', accountID: 'gmessages', type: 'single', participants: { items: [{ phoneNumber: `+61${KEYS[0]}` }] } })
  seedBatch(w, 'approved', [smsItem(KEYS[0]), smsItem(KEYS[1])])
  await pass(w)
  const named = beeperReqs(w).filter((r) => /accountIDs=gmessages(&|$)/.test(r.url) || r.body?.accountID === 'gmessages')
  assert.equal(named.length, 0)
  for (const r of beeperReqs(w, /chats\/search/)) assert.ok(r.url.includes('accountIDs=gmessages.test%2F1'))
  for (const r of beeperReqs(w, /chats\/start/)) assert.equal(r.body.accountID, SMS)
  assert.equal(w.bp.posts('old').length, 0)
})

// ── ENG-12 ──────────────────────────────────────────────────────────────────
test('ENG-12 config: blank or bare gmessages refuses to start, naming the setting', () => {
  assert.throws(() => readEngineConfig({ SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'y', BEEPER_ACCESS_TOKEN: 'z' }), /SMS_BEEPER_ACCOUNT_ID/)
  assert.throws(() => readEngineConfig({ SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'y', BEEPER_ACCESS_TOKEN: 'z', SMS_BEEPER_ACCOUNT_ID: 'gmessages' }), /no longer exists/)
  const c = readEngineConfig({ SUPABASE_URL: 'https://p.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'y', BEEPER_ACCESS_TOKEN: 'z', SMS_BEEPER_ACCOUNT_ID: SMS })
  assert.equal(c.smsAccountId, SMS)
  assert.equal(c.supabaseUrl, 'https://p.supabase.co')
})

for (const why of ['unlisted', 'disconnected'] as const) {
  test(`ENG-12 an ${why} SMS account: sms items stay approved, thread items still send`, async () => {
    const w = makeWorld()
    if (why === 'unlisted') w.cfg.smsAccountId = 'gmessages.other/9'
    else w.bp.accounts[0].status = 'disconnected'
    w.bp.addChat({ id: 'fb-1', accountID: 'facebookgo.test' })
    const B = seedBatch(w, 'approved', [smsItem(KEYS[0]), threadItem('fb-1')])
    const state = newEngineState()
    await pass(w, state)
    assert.equal(status(w, B.items[0].id), 'approved')
    assert.equal(item(w, B.items[0].id).claimed_at, null)
    assert.equal(beeperReqs(w, /chats\/start|chats\/search/).length, 0)
    assert.equal(status(w, B.items[1].id), 'sent')
    assert.equal(state.unreachablePasses, 1)
  })
}

// ── ENG-13 / ENG-14 / ENG-15 ────────────────────────────────────────────────
test('ENG-13 an existing name-titled chat is found by scanning the SMS account only', async () => {
  const w = makeWorld()
  for (let i = 0; i < 8000; i++) w.bp.addChat({ id: `wa-${i}`, accountID: 'whatsapp.test', type: 'single', participants: { items: [{ phoneNumber: `+61${KEYS[0]}` }] } })
  for (let i = 0; i < 201; i++) w.bp.addSmsChat(KEYS[14], { id: `filler-${i}`, participants: { items: [{ phoneNumber: '+61491579998' }] } })
  const target = w.bp.addSmsChat(KEYS[0], { id: 'target', title: 'Jordan Example' })
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0])])
  await pass(w)
  const scans = beeperReqs(w, /chats\/search/)
  assert.equal(scans.length, 2)
  for (const s of scans) assert.ok(s.url.includes('accountIDs=gmessages.test%2F1'))
  assert.equal(beeperReqs(w, /chats\/start/).length, 0)
  assert.equal(w.pg.tables.inbox_new_chat_log.length, 0)
  assert.equal(item(w, B.items[0].id).chat_id, target)
})

test('ENG-14 one scan per pass; a failed scan falls back to opening, never to a stored id', async () => {
  const w = makeWorld()
  noSpacing(w)
  w.bp.intercept = (r) => (r.path === '/v1/chats/search' ? new Response('down', { status: 500 }) : undefined)
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0], { beeper_chat_id: '!stored:beeper.local' }), smsItem(KEYS[1])])
  await pass(w)
  assert.equal(beeperReqs(w, /chats\/search/).length, 1)
  assert.equal(beeperReqs(w, /chats\/start/).length, 2)
  assert.equal(w.pg.tables.inbox_new_chat_log.length, 2)
  assert.equal(w.reqs.filter((r) => r.url.includes('stored')).length, 0)
  for (const it of B.items) assert.equal(status(w, it.id), 'sent')
})

test('ENG-15 a chat opened this pass is reused for the same number: one open, one slot', async () => {
  const w = makeWorld()
  w.bp.intercept = (r) => (r.path === '/v1/chats/search' ? new Response('down', { status: 500 }) : undefined)
  const B1 = seedBatch(w, 'approved', [smsItem(KEYS[1])])
  const B2 = seedBatch(w, 'approved', [smsItem(KEYS[1])])
  await pass(w)
  assert.equal(beeperReqs(w, /chats\/start/).length, 1)
  assert.equal(w.pg.tables.inbox_new_chat_log.length, 1)
  assert.equal(item(w, B1.items[0].id).chat_id, item(w, B2.items[0].id).chat_id)
  assert.equal(status(w, B2.items[0].id), 'sent')
})

// ── ENG-16 ──────────────────────────────────────────────────────────────────
test('ENG-16 chats/start body, chat id, and failure texts', async () => {
  const w = makeWorld()
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0])])
  await pass(w)
  const st = beeperReqs(w, /chats\/start/)
  assert.deepEqual(st[0].body, { accountID: SMS, user: { phoneNumber: `+61${KEYS[0]}` } })
  const chat = item(w, B.items[0].id).chat_id
  assert.ok(beeperReqs(w, /POST .*\/messages$/).some((r) => r.path === `/v1/chats/${chat}/messages`))

  const w2 = makeWorld()
  w2.bp.intercept = (r) => (r.path === '/v1/chats/start' ? new Response('{}', { status: 200 }) : undefined)
  const B2 = seedBatch(w2, 'approved', [smsItem(KEYS[1])])
  await pass(w2)
  assert.equal(status(w2, B2.items[0].id), 'failed')
  assert.match(item(w2, B2.items[0].id).error, /answered without a chat id/)
  assert.equal(beeperReqs(w2, /POST .*\/messages$/).length, 0)
  assert.equal(w2.pg.tables.inbox_new_chat_log.length, 1)

  const w3 = makeWorld()
  noSpacing(w3)
  w3.bp.intercept = (r) => (r.path === '/v1/chats/start' ? new Response('bridge error', { status: 500 }) : undefined)
  const B3 = seedBatch(w3, 'approved', [smsItem(KEYS[2])])
  await pass(w3)
  assert.match(item(w3, B3.items[0].id).error, /^Beeper start chat → 500/)
  // The hub re-queues it: the retry reuses op_id item:<id>, still one row.
  Object.assign(item(w3, B3.items[0].id), { status: 'approved', claimed_at: null, error: null })
  w3.pg.tables.inbox_batches[0].status = 'sending'
  w3.bp.intercept = null
  await pass(w3)
  assert.equal(w3.pg.tables.inbox_new_chat_log.filter((r) => r.op_id === `item:${B3.items[0].id}`).length, 1)
  assert.equal(status(w3, B3.items[0].id), 'sent')
})

// ── ENG-17 ──────────────────────────────────────────────────────────────────
test('ENG-17a the slot is reserved (upsert on op_id) before chats/start; an empty 201 is success', async () => {
  const w = makeWorld()
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0])])
  await pass(w)
  const res = w.reqs.findIndex((r) => r.method === 'POST' && r.path.endsWith('inbox_new_chat_log'))
  const start = w.reqs.findIndex((r) => r.path === '/v1/chats/start')
  assert.ok(res >= 0 && res < start)
  const r = w.reqs[res]
  assert.ok(r.url.includes('on_conflict=op_id'))
  assert.equal(r.headers.Prefer, 'resolution=ignore-duplicates,return=minimal')
  assert.deepEqual({ kind: r.body.kind, op_id: r.body.op_id, phone_key: r.body.phone_key }, { kind: 'marketing', op_id: `item:${B.items[0].id}`, phone_key: KEYS[0] })
  assert.equal(status(w, B.items[0].id), 'sent')
})

test('ENG-17b a reserve that commits but times out opens nothing; next pass reuses the row', async () => {
  const w = makeWorld()
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0])])
  let once = true
  w.pg.intercept = async (r) => {
    if (once && r.method === 'POST' && r.path.endsWith('inbox_new_chat_log')) {
      once = false
      w.pg.intercept = null
      await w.pg.handle(r) // commits
      w.pg.intercept = null
      return new Response('gateway timeout', { status: 504 })
    }
    return undefined
  }
  await pass(w)
  assert.equal(beeperReqs(w, /chats\/start/).length, 0)
  assert.equal(status(w, B.items[0].id), 'approved')
  await pass(w)
  assert.equal(w.pg.tables.inbox_new_chat_log.filter((r) => r.op_id === `item:${B.items[0].id}`).length, 1)
  assert.equal(beeperReqs(w, /chats\/start/).length, 1)
  assert.equal(status(w, B.items[0].id), 'sent')
})

test('ENG-17c chats/start creates the chat and loses its answer: next pass finds it, no new slot', async () => {
  const w = makeWorld()
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0])])
  let dropped = false
  w.bp.intercept = async (r) => {
    if (!dropped && r.path === '/v1/chats/start') {
      dropped = true
      w.bp.intercept = null
      await w.bp.handle(r)
      return 'throw'
    }
    return undefined
  }
  await pass(w)
  assert.equal(status(w, B.items[0].id), 'approved')
  w.clock.now += 200_000
  await pass(w)
  assert.equal(beeperReqs(w, /chats\/start/).length, 1)
  assert.equal(w.pg.tables.inbox_new_chat_log.length, 1)
  assert.equal(status(w, B.items[0].id), 'sent')
})

test('ENG-17d a constraint refusal is not retried for ever', async () => {
  const w = makeWorld()
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0])])
  w.pg.intercept = (r) => (r.method === 'POST' && r.path.endsWith('inbox_new_chat_log') ? new Response('{"code":"23514","message":"check"}', { status: 400 }) : undefined)
  await pass(w)
  assert.equal(status(w, B.items[0].id), 'failed')
  assert.match(item(w, B.items[0].id).error, /reserve/)
  assert.equal(beeperReqs(w, /chats\/start/).length, 0)
})

// ── ENG-19 / ENG-20 ─────────────────────────────────────────────────────────
test('ENG-19 the chat id is filled by UPDATE; a failed fill is paid next pass', async () => {
  const w = makeWorld()
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0])])
  let failFill = true
  w.pg.intercept = (r) => {
    if (failFill && r.method === 'PATCH' && r.path.endsWith('inbox_new_chat_log') && r.body?.chat_id) { failFill = false; return new Response('x', { status: 503 }) }
    return undefined
  }
  const state = newEngineState()
  await pass(w, state)
  assert.equal(status(w, B.items[0].id), 'sent')
  assert.equal(w.pg.tables.inbox_new_chat_log[0].chat_id ?? null, null)
  assert.equal(state.fillDebts.size, 1)
  await pass(w, state)
  assert.ok(w.pg.tables.inbox_new_chat_log[0].chat_id)
  assert.equal(w.pg.tables.inbox_new_chat_log.length, 1)
  assert.equal(pgReqs(w, /POST inbox_new_chat_log/).length, 1)
})

test('ENG-20 a slot from an earlier Perth day moves onto today before the open', async () => {
  const w = makeWorld('2026-10-20T16:01:00.000Z') // 00:01 Perth on the 21st
  noSpacing(w)
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0])])
  w.pg.tables.inbox_new_chat_log.push({ id: 'old', kind: 'marketing', op_id: `item:${B.items[0].id}`, phone_key: KEYS[0], opened_at: '2026-10-20T15:59:00.000Z' })
  await pass(w)
  const mv = w.reqs.findIndex((r) => r.method === 'PATCH' && r.path.endsWith('inbox_new_chat_log') && r.body?.opened_at)
  const st = w.reqs.findIndex((r) => r.path === '/v1/chats/start')
  assert.ok(mv >= 0 && mv < st)
  assert.ok(w.reqs[mv].url.includes(`opened_at=lt.${encodeURIComponent(perthDayStartIso(w.clock.now))}`))
  assert.equal(w.pg.tables.inbox_new_chat_log.length, 1)
  assert.ok(new Date(w.pg.tables.inbox_new_chat_log[0].opened_at) >= new Date(perthDayStartIso(w.clock.now)))
})

// ── ENG-21 / ENG-22 / ENG-23 / ENG-24 ───────────────────────────────────────
function fillLog(w: ReturnType<typeof makeWorld>, n: number, kind = 'marketing', at = w.clock.now - 3_600_000) {
  for (let i = 0; i < n; i++) w.pg.tables.inbox_new_chat_log.push({ id: uid('log'), kind, op_id: `${kind}:${i}:${uid()}`, opened_at: new Date(at + i).toISOString() })
}

test('ENG-21a at the cap new numbers stay unclaimed; otp rows do not count; a restart agrees', async () => {
  const w = makeWorld()
  fillLog(w, 50)
  fillLog(w, 30, 'otp')
  const existing = w.bp.addSmsChat(KEYS[1])
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0]), smsItem(KEYS[1])])
  await pass(w)
  await pass(w, newEngineState())
  assert.equal(status(w, B.items[0].id), 'approved')
  assert.equal(item(w, B.items[0].id).claimed_at, null)
  assert.equal(beeperReqs(w, /chats\/start/).length, 0)
  assert.equal(item(w, B.items[1].id).chat_id, existing)
  for (const r of pgReqs(w, /GET inbox_new_chat_log/).filter((x) => x.url.includes('opened_at=gte'))) assert.ok(r.url.includes('kind=eq.marketing'))
})

test('ENG-21b with 49 used, exactly one opens', async () => {
  const w = makeWorld()
  noSpacing(w)
  fillLog(w, 49)
  seedBatch(w, 'approved', [smsItem(KEYS[0]), smsItem(KEYS[1]), smsItem(KEYS[2])])
  await pass(w)
  assert.equal(beeperReqs(w, /chats\/start/).length, 1)
})

test('ENG-21c an unreadable count opens nothing', async () => {
  const w = makeWorld()
  w.pg.intercept = (r) => (r.method === 'GET' && r.path.endsWith('inbox_new_chat_log') ? new Response('x', { status: 500 }) : undefined)
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0])])
  await pass(w)
  assert.equal(beeperReqs(w, /chats\/start/).length, 0)
  assert.equal(status(w, B.items[0].id), 'approved')
})

test('ENG-21d cap 0 opens nothing, but an existing chat still sends', async () => {
  const w = makeWorld()
  w.pg.tables.inbox_settings[0].new_chat_daily_cap = 0
  w.bp.addSmsChat(KEYS[1], { title: 'Sam Example' })
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0]), smsItem(KEYS[1])])
  await pass(w)
  assert.equal(beeperReqs(w, /chats\/start/).length, 0)
  assert.equal(status(w, B.items[1].id), 'sent')
  assert.equal(status(w, B.items[0].id), 'approved')
})

test('ENG-21e a slot from before Perth midnight is not counted', async () => {
  const w = makeWorld('2026-10-20T16:01:00.000Z')
  fillLog(w, 50, 'marketing', new Date('2026-10-20T15:00:00.000Z').getTime())
  seedBatch(w, 'approved', [smsItem(KEYS[0])])
  await pass(w)
  assert.equal(beeperReqs(w, /chats\/start/).length, 1)
})

test('ENG-22 opens are spaced from the table, across restarts; existing chats are not held', async () => {
  const w = makeWorld()
  const existing = w.bp.addSmsChat(KEYS[3])
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0]), smsItem(KEYS[1]), smsItem(KEYS[2]), smsItem(KEYS[3])])
  const T = w.clock.now
  await pass(w)
  assert.equal(beeperReqs(w, /chats\/start/).length, 1)
  assert.equal(item(w, B.items[3].id).chat_id, existing)
  for (const it of [B.items[1], B.items[2]]) assert.deepEqual([item(w, it.id).status, item(w, it.id).claimed_at, item(w, it.id).error], ['approved', null, null])
  w.clock.now = T + 60_000
  await pass(w, newEngineState()) // a restart
  assert.equal(beeperReqs(w, /chats\/start/).length, 1)
  w.clock.now = T + 185_000
  await pass(w)
  const starts = beeperReqs(w, /chats\/start/)
  assert.equal(starts.length, 2)
  assert.ok(starts[1].at - starts[0].at >= 180_000)
})

test('ENG-23 a post-claim reserve failure returns the item, fenced on its own claim; parked batch → pending', async () => {
  const w = makeWorld()
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0])])
  w.pg.intercept = (r) => (r.method === 'POST' && r.path.endsWith('inbox_new_chat_log') ? new Response('x', { status: 503 }) : undefined)
  await pass(w)
  const ret = pgReqs(w, /PATCH inbox_batch_items/).find((r) => r.body?.status === 'approved')!
  assert.match(ret.url, /status=eq\.sending/)
  assert.match(ret.url, /claimed_at=eq\./)
  assert.equal(status(w, B.items[0].id), 'approved')
  assert.equal(item(w, B.items[0].id).error, null)

  const w2 = makeWorld()
  const B2 = seedBatch(w2, 'approved', [smsItem(KEYS[0])])
  w2.pg.intercept = (r) => {
    if (r.method === 'POST' && r.path.endsWith('inbox_new_chat_log')) { w2.pg.tables.inbox_batches[0].status = 'draft'; return new Response('x', { status: 503 }) }
    return undefined
  }
  await pass(w2)
  assert.equal(status(w2, B2.items[0].id), 'pending')
})

test('ENG-24 a marked and an unmarked item are treated alike under the cap', async () => {
  const w = makeWorld()
  noSpacing(w)
  fillLog(w, 49)
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0], { new_chat: true }), { data: { channel: 'sms', phone: `0${KEYS[1]}` } }])
  await pass(w)
  assert.equal(beeperReqs(w, /chats\/start/).length, 1)
  const st = B.items.map((x) => status(w, x.id)).sort()
  assert.deepEqual(st, ['approved', 'sent'])
  assert.equal(B.items.filter((x) => item(w, x.id).status === 'failed').length, 0)
})

// ── ENG-25 / 26 / 27 / 28 / 47 ──────────────────────────────────────────────
test('ENG-25 read back before writing sent; quiet bridge counts as sent; no id means no read', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  w.bp.addChat({ id: 'c2', accountID: 'facebookgo.test' })
  w.bp.addChat({ id: 'c3', accountID: 'facebookgo.test' })
  w.bp.defaultStatus = [null]
  const B = seedBatch(w, 'approved', [threadItem('c1'), threadItem('c2'), threadItem('c3')])
  w.bp.intercept = async (r) => {
    if (r.method === 'POST' && r.path === '/v1/chats/c3/messages') return new Response(JSON.stringify({ chatID: 'c3' }), { status: 200 })
    return undefined
  }
  await pass(w)
  for (const it of B.items) assert.equal(status(w, it.id), 'sent')
  const sentPatch = w.reqs.findIndex((r) => r.method === 'PATCH' && r.url.includes(B.items[0].id) && r.body?.status === 'sent')
  const readBack = w.reqs.findIndex((r) => r.method === 'GET' && /\/v1\/chats\/c1\/messages\/pm-/.test(r.path))
  assert.ok(readBack >= 0 && readBack < sentPatch)
  assert.equal(beeperReqs(w, /GET \/v1\/chats\/c3\/messages\//).length, 0)
  assert.ok(w.readSignals.length > 0 && w.readSignals.every((ms) => ms > 0))
})

test('ENG-26 PENDING and unknown statuses keep polling; only FAIL fails', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  w.bp.addChat({ id: 'c2', accountID: 'facebookgo.test' })
  w.bp.addChat({ id: 'c3', accountID: 'facebookgo.test' })
  const B = seedBatch(w, 'approved', [threadItem('c1'), threadItem('c2'), threadItem('c3')])
  let inner = false
  w.bp.intercept = async (r) => {
    if (!inner && r.method === 'POST' && r.path.endsWith('/messages')) {
      inner = true
      const res = await w.bp.handle({ ...r })
      inner = false
      const body = await res.json()
      const chat = r.path.split('/')[3]
      w.bp.statuses.set(body.pendingMessageID, chat === 'c1' ? ['PENDING', 'QUEUED_UNKNOWN', 'SUCCESS'] : chat === 'c2' ? ['FAIL_RETRIABLE'] : ['QUEUED_UNKNOWN'])
      return new Response(JSON.stringify(body), { status: 200 })
    }
    return undefined
  }
  await pass(w)
  assert.equal(status(w, B.items[0].id), 'sent')
  assert.equal(status(w, B.items[1].id), 'failed')
  assert.match(item(w, B.items[1].id).error, /^Beeper send reported FAIL_RETRIABLE: carrier rejected/)
  assert.equal(status(w, B.items[2].id), 'sending')
  assert.ok(item(w, B.items[2].id).pending_message_id)
  assert.equal(w.bp.posts().length, 3)
})

test('ENG-27 a park survives a restart and resolves without a second post', async () => {
  for (const variant of ['success', 'fail', 'sentWriteFails', 'dismissed'] as const) {
    const w = makeWorld()
    w.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
    w.bp.defaultStatus = ['PENDING']
    const B = seedBatch(w, 'approved', [threadItem('c1')])
    await pass(w)
    const it = item(w, B.items[0].id)
    assert.equal(it.status, 'sending', variant)
    assert.ok(it.pending_message_id)
    const claimed = it.claimed_at
    w.bp.statuses.clear()
    w.bp.defaultStatus = [variant === 'fail' ? 'FAIL_PERMANENT' : 'SUCCESS']
    if (variant === 'dismissed') w.pg.tables.inbox_batches[0].status = 'sent'
    let failOnce = variant === 'sentWriteFails'
    w.pg.intercept = (r) => {
      if (failOnce && r.method === 'PATCH' && r.body?.status === 'sent') { failOnce = false; return new Response('x', { status: 503 }) }
      return undefined
    }
    w.clock.now += 61_000
    await pass(w, newEngineState())
    if (variant === 'sentWriteFails') {
      assert.equal(item(w, B.items[0].id).status, 'sending')
      w.clock.now += 121_000
      await pass(w, newEngineState())
    }
    const final = item(w, B.items[0].id)
    assert.equal(final.status, variant === 'fail' ? 'failed' : 'sent', variant)
    if (variant !== 'fail') assert.equal(final.chat_id, 'c1')
    assert.equal(w.bp.posts().length, 1, variant)
    assert.equal(final.claimed_at, claimed, `${variant}: a park re-check never moves claimed_at`)
  }
})

test('ENG-28 an unanswered post is never reposted: found → sent, absent → failed', async () => {
  // (a) accepted, every read-back unanswered: parked, not failed.
  const a = makeWorld()
  a.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  a.bp.intercept = (r) => (r.method === 'GET' && /\/messages\/pm-/.test(r.path) ? 'throw' : undefined)
  const A = seedBatch(a, 'approved', [threadItem('c1')])
  await pass(a)
  assert.equal(status(a, A.items[0].id), 'sending')
  assert.ok(item(a, A.items[0].id).pending_message_id)

  // (b) post times out but landed: sent after one POST.
  const b = makeWorld()
  b.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  b.bp.intercept = async (r) => {
    if (r.method === 'POST' && r.path.endsWith('/messages')) { b.bp.intercept = null; await b.bp.handle(r); return 'throw' }
    return undefined
  }
  const Bb = seedBatch(b, 'approved', [threadItem('c1')])
  await pass(b)
  assert.equal(status(b, Bb.items[0].id), 'sent')
  assert.equal(b.bp.posts().length, 1)

  // (c) post times out and is absent: failed, one POST across three passes.
  const c = makeWorld()
  c.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  let posts = 0
  c.bp.intercept = (r) => { if (r.method === 'POST' && r.path.endsWith('/messages')) { posts++; return 'throw' } return undefined }
  const C = seedBatch(c, 'approved', [threadItem('c1')])
  for (let i = 0; i < 3; i++) await pass(c)
  assert.equal(status(c, C.items[0].id), 'failed')
  assert.match(item(c, C.items[0].id).error, /^Beeper send got no answer: /)
  assert.equal(posts, 1)
})

test('ENG-47 a hanging status endpoint cannot stall the drain; the next pass resolves', async () => {
  const w = makeWorld()
  for (let i = 0; i < 5; i++) w.bp.addChat({ id: `c${i}`, accountID: 'facebookgo.test' })
  let readTime = 0
  w.bp.intercept = (r) => {
    if (r.method === 'GET' && /\/messages\/pm-/.test(r.path)) { w.clock.now += 20_000; readTime += 20_000; return 'throw' }
    return undefined
  }
  const B = seedBatch(w, 'approved', Array.from({ length: 5 }, (_, i) => threadItem(`c${i}`)))
  await pass(w)
  assert.equal(w.bp.posts().length, 5)
  assert.ok(readTime <= 60_000, `read time ${readTime}`)
  for (const it of B.items) assert.equal(status(w, it.id), 'sending')
  w.bp.intercept = null
  w.clock.now += 61_000
  await pass(w)
  for (const it of B.items) assert.equal(status(w, it.id), 'sent')
  assert.equal(w.bp.posts().length, 5)
})

// ── ENG-29 / 31 ─────────────────────────────────────────────────────────────
test('ENG-29 status and chat_id ride the same update, with the chat actually used', async () => {
  const w = makeWorld()
  noSpacing(w)
  w.bp.addSmsChat(KEYS[0], { id: 'new-gm' })
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0], { beeper_chat_id: '!old:beeper.local' }), smsItem(KEYS[1])])
  await pass(w)
  const sentPatches = pgReqs(w, /PATCH inbox_batch_items/).filter((r) => r.body?.status === 'sent')
  assert.equal(sentPatches.length, 2)
  for (const p of sentPatches) assert.ok(p.body.chat_id)
  assert.equal(item(w, B.items[0].id).chat_id, 'new-gm')
  assert.match(item(w, B.items[1].id).chat_id, /^!opened-/)
})

test('ENG-31 failures carry the API or bridge text verbatim; none is left blank', async () => {
  const w = makeWorld()
  noSpacing(w)
  w.bp.addChat({ id: 'c-bridge', accountID: 'facebookgo.test' })
  w.bp.addChat({ id: 'c-fail', accountID: 'facebookgo.test' })
  w.bp.intercept = async (r) => {
    if (r.path === '/v1/chats/start') return new Response('invalid phone number', { status: 400 })
    if (r.method === 'POST' && r.path === '/v1/chats/c-bridge/messages') return new Response('bridge disconnected', { status: 500 })
    if (r.method === 'POST' && r.path === '/v1/chats/c-fail/messages') {
      w.bp.intercept = null
      const res = await w.bp.handle(r)
      const body = await res.json()
      w.bp.statuses.set(body.pendingMessageID, ['FAIL_PERMANENT'])
      return new Response(JSON.stringify(body), { status: 200 })
    }
    return undefined
  }
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0]), threadItem('c-bridge'), threadItem('c-fail')])
  await pass(w)
  assert.match(item(w, B.items[0].id).error, /invalid phone number/)
  assert.match(item(w, B.items[1].id).error, /bridge disconnected/)
  assert.match(item(w, B.items[2].id).error, /FAIL_PERMANENT: carrier rejected/)
  assert.equal(w.pg.tables.inbox_batch_items.filter((r) => r.status === 'failed' && !r.error).length, 0)
})

// ── ENG-32 / 33 ─────────────────────────────────────────────────────────────
test('ENG-32 a thread item goes straight to its chat, no lookup or open', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'fb-1', accountID: 'facebookgo.test' })
  seedBatch(w, 'approved', [threadItem('fb-1', { phone: `0${KEYS[0]}` })])
  await pass(w)
  assert.deepEqual(beeperReqs(w, /POST/).map((r) => r.path), ['/v1/chats/fb-1/messages'])
  assert.equal(beeperReqs(w, /chats\/search|chats\/start/).length, 0)
  assert.equal(pgReqs(w, /inbox_new_chat_log/).length, 0)
})

test('ENG-33 a route-locked Messenger item never falls back to SMS', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'fb-1', accountID: 'facebookgo.test' })
  w.bp.intercept = (r) => (r.method === 'POST' && r.path === '/v1/chats/fb-1/messages' ? new Response('boom', { status: 500 }) : undefined)
  const data = { channel: 'thread', beeper_chat_id: 'fb-1', route_lock: 'messenger', route_via: 'sibling', phone: `0${KEYS[0]}` }
  const B = seedBatch(w, 'approved', [{ data: { ...data } }])
  await pass(w)
  assert.equal(status(w, B.items[0].id), 'failed')
  assert.equal(beeperReqs(w, /chats\/search|chats\/start/).length, 0)
  assert.deepEqual(item(w, B.items[0].id).data, data)
})

// ── ENG-36 / guards ─────────────────────────────────────────────────────────
test('ENG-36 the engine guard skip keeps the no_reply_<n> shape and posts nothing', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  const B = seedBatch(w, 'approved', [threadItem('c1')])
  await pass(w, newEngineState(), { guard: async () => ({ ok: false, reason: 'no_reply_4' }) })
  assert.equal(status(w, B.items[0].id), 'skipped')
  assert.match(item(w, B.items[0].id).guard_reason, /^no_reply_\d+$/)
  assert.equal(w.bp.posts().length, 0)
})

// ── ENG-37 ──────────────────────────────────────────────────────────────────
test('ENG-37 never touches the signup-code tables; every log row is marketing', async () => {
  const src = fs.readFileSync(path.join(here, 'smsEngine.ts'), 'utf8')
  for (const bad of ['wcp_mobile_otp', 'wcp_otp_reserve_chat_slot', 'kind=eq.otp']) assert.ok(!src.includes(bad), bad)
  const w = makeWorld()
  noSpacing(w)
  seedBatch(w, 'approved', [smsItem(KEYS[0]), smsItem(KEYS[1])])
  await pass(w)
  for (const r of pgReqs(w, /POST inbox_new_chat_log/)) {
    assert.equal(r.body.kind, 'marketing')
    assert.match(r.body.op_id, /^item:/)
  }
})

// ── ENG-38 / 39 ─────────────────────────────────────────────────────────────
const autoPauseCalls = (w: ReturnType<typeof makeWorld>) => pgReqs(w, /rpc\/inbox_auto_pause/)

test('ENG-38a five failures in a row: one auto-pause, the rest stay approved', async () => {
  const w = makeWorld()
  for (let i = 0; i < 7; i++) w.bp.addChat({ id: `c${i}`, accountID: 'facebookgo.test' })
  w.bp.intercept = (r) => (r.method === 'POST' && r.path.endsWith('/messages') ? new Response('bridge down', { status: 502 }) : undefined)
  const B = seedBatch(w, 'approved', Array.from({ length: 7 }, (_, i) => threadItem(`c${i}`)))
  const r = await pass(w)
  assert.equal(autoPauseCalls(w).length, 1)
  assert.ok(r.autoPaused && !r.autoPaused.includes('\n'))
  assert.equal(status(w, B.items[5].id), 'approved')
  assert.equal(status(w, B.items[6].id), 'approved')
  const fifth = w.reqs.findIndex((x) => x.method === 'PATCH' && x.url.includes(B.items[4].id) && x.body?.status === 'failed')
  const rpc = w.reqs.findIndex((x) => x.path.endsWith('rpc/inbox_auto_pause'))
  assert.ok(fifth < rpc)
})

test('ENG-38b Beeper unreachable on two passes in a row: one auto-pause, on the second', async () => {
  const w = makeWorld()
  w.bp.intercept = () => 'throw'
  const state = newEngineState()
  await pass(w, state)
  assert.equal(autoPauseCalls(w).length, 0)
  await pass(w, state)
  assert.equal(autoPauseCalls(w).length, 1)
})

test('ENG-38c holds, parks and suppression skips neither count nor reset the streak', async () => {
  const w = makeWorld()
  for (let i = 0; i < 6; i++) w.bp.addChat({ id: `c${i}`, accountID: 'facebookgo.test' })
  w.pg.tables.inbox_settings[0].new_chat_daily_cap = 0
  w.pg.tables.inbox_outreach.push({ id: 'banned' })
  w.pg.rpc.outreach_canonical_suppression_reason = (b) => (b.p_outreach_id === 'banned' ? 'Banned' : null)
  w.bp.intercept = (r) => (r.method === 'POST' && /\/v1\/chats\/c\d\/messages/.test(r.path) && !r.path.includes('c5') ? new Response('down', { status: 502 }) : undefined)
  w.bp.statuses.set('pm-1', ['PENDING'])
  seedBatch(w, 'approved', [
    threadItem('c0'), threadItem('c1'), threadItem('c2'), threadItem('c3'),
    smsItem(KEYS[0]), // cap hold
    threadItem('c4', { outreach_id: 'banned' }), // suppression skip
    threadItem('c4'), // fifth failure
  ])
  await pass(w)
  assert.equal(autoPauseCalls(w).length, 1)
})

test('ENG-38d a success resets the streak', async () => {
  const w = makeWorld()
  for (let i = 0; i < 9; i++) w.bp.addChat({ id: `c${i}`, accountID: 'facebookgo.test' })
  w.bp.intercept = (r) => (r.method === 'POST' && r.path.endsWith('/messages') && !r.path.includes('/c4/') ? new Response('down', { status: 502 }) : undefined)
  seedBatch(w, 'approved', Array.from({ length: 9 }, (_, i) => threadItem(`c${i}`)))
  await pass(w)
  assert.equal(autoPauseCalls(w).length, 0)
})

test('ENG-38 a per-destination 404 fails the item but stays out of the streak', async () => {
  const w = makeWorld()
  seedBatch(w, 'approved', Array.from({ length: 6 }, (_, i) => threadItem(`!dead-${i}:beeper.local`)))
  await pass(w)
  assert.equal(autoPauseCalls(w).length, 0)
  assert.equal(w.pg.tables.inbox_batch_items.filter((r) => r.status === 'failed').length, 6)
})

test('ENG-39 after the auto-pause nothing more is claimed, this pass or the next', async () => {
  const w = makeWorld()
  for (let i = 0; i < 10; i++) w.bp.addChat({ id: `c${i}`, accountID: 'facebookgo.test' })
  w.bp.intercept = (r) => (r.method === 'POST' && r.path.endsWith('/messages') ? new Response('down', { status: 502 }) : undefined)
  const B = seedBatch(w, 'approved', Array.from({ length: 10 }, (_, i) => threadItem(`c${i}`)))
  await pass(w)
  await pass(w)
  for (const it of B.items.slice(5)) assert.equal(item(w, it.id).claimed_at, null)
  assert.equal(pgReqs(w).filter((r) => r.body && r.body.sends_paused === false).length, 0)
  assert.equal(w.pg.tables.inbox_settings[0].sends_paused, true)
})

// ── ENG-44 / 45 ─────────────────────────────────────────────────────────────
test('ENG-44 chooseChat: single, exact account, non-self number, most recent', () => {
  const key = '491570156'
  const p = (n: string, self = false) => ({ items: [{ isSelf: true, phoneNumber: '+61491579999' }, { isSelf: self, phoneNumber: n }] })
  const chats = [
    { id: 'group', accountID: SMS, type: 'group', participants: p('+61491570156') },
    { id: 'wa', accountID: 'whatsapp.test', type: 'single', participants: p('+61491570156') },
    { id: 'yesterday', accountID: SMS, type: 'single', lastActivity: '2026-10-19T01:00:00Z', participants: p('0491 570 156') },
    { id: 'today', accountID: SMS, type: 'single', lastActivity: '2026-10-20T01:00:00Z', participants: p('+61 491 570 156') },
    { id: 'self-only', accountID: SMS, type: 'single', lastActivity: '2026-10-21T01:00:00Z', participants: { items: [{ isSelf: true, phoneNumber: '+61491570156' }] } },
  ]
  assert.equal(chooseChat(chats, key, SMS), 'today')
  assert.equal(chooseChat([chats[1]], key, SMS), null)
  for (const n of ['0491 570 156', '+61 491 570 156', '61491570156']) assert.equal(phoneKey(n), key)
})

test('ENG-45 key derivation and the mobile rule', async () => {
  for (const raw of ['+61 491 570 156', '0491570156', '61491570156', '491570156']) {
    assert.equal(`+61${phoneKey(raw)}`, '+61491570156')
    assert.ok(isMobileKey(phoneKey(raw)))
  }
  for (const raw of ['(08) 9300 1234', '893001234']) assert.ok(!isMobileKey(phoneKey(raw)))
  const w = makeWorld()
  const B = seedBatch(w, 'approved', [smsItem('893001234')])
  await pass(w)
  assert.equal(status(w, B.items[0].id), 'failed')
  assert.ok(item(w, B.items[0].id).error)
  assert.equal(beeperReqs(w, /chats\/search|chats\/start/).length, 0)
  assert.equal(pgReqs(w, /inbox_new_chat_log/).length, 0)
})

// ── ENG-46 / 48 / 49 / 50 ───────────────────────────────────────────────────
test('ENG-46 a reclaim during a slow chats/start makes the first loop walk away', async () => {
  const w = makeWorld()
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0])])
  w.bp.intercept = async (r) => {
    if (r.path === '/v1/chats/start') {
      w.clock.now += 20_000
      item(w, B.items[0].id).claimed_at = new Date(w.clock.now).toISOString() // another loop reclaimed it
    }
    return undefined
  }
  await pass(w)
  assert.equal(w.bp.posts().length, 0)
})

test('ENG-48 a stale copy writing its verdict matches nothing', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  w.bp.defaultStatus = ['PENDING']
  const B = seedBatch(w, 'approved', [threadItem('c1')])
  await pass(w) // copy A parks pm-1
  const it = item(w, B.items[0].id)
  // Copy B reclaims, posts and parks pm-2.
  Object.assign(it, { claimed_at: new Date(w.clock.now + 1).toISOString(), pending_message_id: 'pm-2' })
  w.bp.statuses.clear()
  w.bp.defaultStatus = ['FAIL_PERMANENT']
  w.clock.now += 61_000
  // A's view of the park is stale: its fenced write must match nothing.
  const stale = { ...it, pending_message_id: 'pm-1' }
  void stale
  await pass(w)
  // The park on pm-2 resolves on its own fence; nothing was written for pm-1.
  assert.equal(pgReqs(w, /PATCH inbox_batch_items/).filter((r) => r.url.includes('pending_message_id=eq.pm-1') && r.body?.status).length, 0)
})

test('ENG-49 every request carries a timeout signal; an empty 201 reserve is success', async () => {
  const w = makeWorld()
  noSpacing(w)
  w.bp.addChat({ id: 'fb', accountID: 'facebookgo.test' })
  seedBatch(w, 'approved', [smsItem(KEYS[0]), threadItem('fb')])
  await pass(w)
  assert.equal(w.reqs.filter((r) => !r.signal).length, 0)
  assert.equal(beeperReqs(w, /chats\/start/).length, 1)
})

test('ENG-50 stamps carry the clock at the write, not the pass start', async () => {
  const w = makeWorld()
  noSpacing(w)
  const start = w.clock.now
  w.bp.intercept = () => { w.clock.now += 20_000; return undefined }
  seedBatch(w, 'approved', [smsItem(KEYS[0]), smsItem(KEYS[1]), smsItem(KEYS[2])])
  await pass(w)
  const third = w.pg.tables.inbox_new_chat_log.find((r) => r.phone_key === KEYS[2])!
  assert.ok(new Date(third.opened_at).getTime() > start + 60_000)
})

// ── ENG-51 ──────────────────────────────────────────────────────────────────
test('ENG-51 a second engine process refuses to start', () => {
  const lock = path.join(fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'eng-lock-')), 'engine.lock')
  const release = acquireInstanceLock(lock)
  // Another live process (our parent) already holds it.
  fs.writeFileSync(lock, String(process.ppid))
  assert.throws(() => acquireInstanceLock(lock), AlreadyRunningError)
  // A lock left by a dead PID is taken over.
  fs.writeFileSync(lock, '999999')
  const r2 = acquireInstanceLock(lock)
  r2()
  release()
  assert.ok(!fs.existsSync(lock))
})

// ── ENG-53 / 54 ─────────────────────────────────────────────────────────────
test('ENG-53 reclaiming a stale claim: park → read back; found → sent; absent → one post; gone batch → untouched', async () => {
  const old = (w: ReturnType<typeof makeWorld>) => new Date(w.clock.now - 10 * 60_000).toISOString()
  // (a) parked
  const a = makeWorld()
  a.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  const A = seedBatch(a, 'sending', [{ ...threadItem('c1'), status: 'sending', claimed_at: old(a), pending_message_id: 'pm-x', pending_chat_id: 'c1' }])
  await pass(a)
  assert.equal(status(a, A.items[0].id), 'sent')
  assert.equal(a.bp.posts().length, 0)
  // (b) no park, text already in the chat
  const b = makeWorld()
  b.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  const Bb = seedBatch(b, 'sending', [{ ...threadItem('c1'), status: 'sending', claimed_at: old(b), rendered_text: 'already there' }])
  b.bp.messages.set('c1', [{ id: 'm0', isSender: true, text: 'already there', timestamp: new Date(b.clock.now - 9 * 60_000).toISOString() }])
  await pass(b)
  assert.equal(status(b, Bb.items[0].id), 'sent')
  assert.equal(b.bp.posts().length, 1) // only the seeded one
  // (c) no park, absent
  const c = makeWorld()
  c.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  const C = seedBatch(c, 'sending', [{ ...threadItem('c1'), status: 'sending', claimed_at: old(c) }])
  const oldClaim = C.items[0].claimed_at
  await pass(c)
  assert.equal(status(c, C.items[0].id), 'sent')
  assert.equal(c.bp.posts().length, 1)
  const reclaim = pgReqs(c, /PATCH inbox_batch_items/).find((r) => r.body?.claimed_at && !r.body.status)!
  assert.ok(reclaim.url.includes(`claimed_at=eq.${encodeURIComponent(oldClaim)}`))
  // (d) batch parked
  const d = makeWorld()
  d.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  const D = seedBatch(d, 'draft', [{ ...threadItem('c1'), status: 'sending', claimed_at: old(d) }])
  await pass(d)
  assert.equal(status(d, D.items[0].id), 'sending')
  assert.equal(beeperReqs(d, /c1/).length, 0)
})

test('ENG-54 a batch with held or parked items stays open', async () => {
  const w = makeWorld()
  noSpacing(w)
  w.pg.tables.inbox_settings[0].new_chat_daily_cap = 5
  const B = seedBatch(w, 'approved', KEYS.slice(0, 8).map((k) => smsItem(k)))
  await pass(w)
  assert.equal(w.pg.tables.inbox_batches[0].status, 'sending')
  assert.equal(B.items.filter((x) => status(w, x.id) === 'approved').length, 3)

  const w2 = makeWorld()
  w2.bp.addChat({ id: 'c1', accountID: 'facebookgo.test' })
  w2.bp.defaultStatus = ['PENDING']
  seedBatch(w2, 'approved', [threadItem('c1')])
  await pass(w2)
  assert.equal(w2.pg.tables.inbox_batches[0].status, 'sending')
  w2.bp.defaultStatus = ['SUCCESS']
  w2.clock.now += 61_000
  await pass(w2)
  await pass(w2)
  assert.equal(w2.pg.tables.inbox_batches[0].status, 'sent')
})

// ── Small helpers ───────────────────────────────────────────────────────────
test('routeOf, versionAtLeast, perthDayStartIso', () => {
  assert.deepEqual(routeOf({ channel: 'sms', beeper_chat_id: 'x' }), { kind: 'sms' })
  assert.deepEqual(routeOf({ route_lock: 'messenger', channel: 'sms', beeper_chat_id: 'fb' }), { kind: 'thread', chatId: 'fb' })
  assert.ok(versionAtLeast('4.3.209.0'))
  assert.ok(versionAtLeast('4.2.808'))
  assert.ok(!versionAtLeast('4.2.807'))
  assert.equal(perthDayStartIso(new Date('2026-10-20T15:59:00Z').getTime()), '2026-10-19T16:00:00.000Z')
  assert.equal(perthDayStartIso(new Date('2026-10-20T16:01:00Z').getTime()), '2026-10-20T16:00:00.000Z')
})
