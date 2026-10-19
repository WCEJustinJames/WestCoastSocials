// node --import tsx --test src/sync/smsEngine.fixes.test.ts
// Tests for the 19 Oct independent review (engine-fix-list.md), written
// before the fixes. Fakes only, like smsEngine.test.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPass, newEngineState, tryReadEngineConfig, PARK_MAX_CHECKS, type Hooks } from './smsEngine'
import { acquireInstanceLock, AlreadyRunningError } from '../lib/instanceLock'
import { makeWorld, seedBatch, smsItem, threadItem, item, beeperReqs, pgReqs, KEYS, uid } from './testkit/fakeWorld'

type W = ReturnType<typeof makeWorld>
const here = path.dirname(fileURLToPath(import.meta.url))
const pass = (w: W, state = newEngineState(), hooks: Hooks = {}, opts = {}) => runPass(w.deps, w.cfg, state, hooks, opts)
const status = (w: W, id: string) => item(w, id).status
const ago = (w: W, ms: number) => new Date(w.clock.now - ms).toISOString()
const copies = (w: W, chat: string, text: string) => w.bp.posts(chat).filter((m) => m.text === text).length

// ── FIX-1 · no double send after a reclaim ──────────────────────────────────
test('FIX-1 a reclaimed, maybe-posted sms item held by a failed scan and spacing is never posted twice', async () => {
  const w = makeWorld()
  const text = 'Game on tonight at the club'
  const chat = w.bp.addSmsChat(KEYS[0], { id: 'gm-1' })
  // Pass N posted it, then the process died before the park write.
  w.bp.messages.set(chat, [{ id: 'm-old', isSender: true, text, timestamp: ago(w, 9 * 60_000) }])
  const B = seedBatch(w, 'sending', [{ ...smsItem(KEYS[0]), rendered_text: text, status: 'sending', claimed_at: ago(w, 10 * 60_000), post_attempted_at: ago(w, 9 * 60_000) }])
  // A recent open makes spacing hold any new open this pass.
  w.pg.tables.inbox_new_chat_log.push({ id: uid('log'), kind: 'marketing', op_id: 'item:other', opened_at: ago(w, 30_000) })
  w.bp.intercept = (r) => (r.path === '/v1/chats/search' ? new Response('down', { status: 500 }) : undefined)
  const state = newEngineState()
  await pass(w, state)
  assert.equal(status(w, B.items[0].id), 'sending', 'never handed back to approved')
  w.bp.intercept = null
  for (let i = 0; i < 3; i++) { w.clock.now += 6 * 60_000; await pass(w, state) }
  assert.equal(copies(w, chat, text), 1)
  assert.equal(status(w, B.items[0].id), 'sent')
})

test('FIX-1 a reclaimed, maybe-posted item whose suppression check errors stays sending, then resolves without a resend', async () => {
  const w = makeWorld()
  const text = 'See you Thursday'
  w.bp.addChat({ id: 'fb-1', accountID: 'facebookgo.test' })
  w.bp.messages.set('fb-1', [{ id: 'm-old', isSender: true, text, timestamp: ago(w, 9 * 60_000) }])
  w.pg.tables.inbox_outreach.push({ id: 'o-1' })
  const B = seedBatch(w, 'sending', [{ ...threadItem('fb-1', { outreach_id: 'o-1' }), rendered_text: text, status: 'sending', claimed_at: ago(w, 10 * 60_000), post_attempted_at: ago(w, 9 * 60_000) }])
  let fail = true
  w.pg.intercept = (r) => (fail && r.path.endsWith('outreach_canonical_suppression_reason') ? new Response('x', { status: 500 }) : undefined)
  const state = newEngineState()
  await pass(w, state)
  assert.equal(status(w, B.items[0].id), 'sending')
  fail = false
  for (let i = 0; i < 2; i++) { w.clock.now += 6 * 60_000; await pass(w, state) }
  assert.equal(copies(w, 'fb-1', text), 1)
  assert.equal(status(w, B.items[0].id), 'sent')
})

test('FIX-1 a fresh claim of a row that carries post_attempted_at checks the chat first', async () => {
  const w = makeWorld()
  const text = 'Already went out'
  w.bp.addChat({ id: 'fb-1', accountID: 'facebookgo.test' })
  w.bp.messages.set('fb-1', [{ id: 'm-old', isSender: true, text, timestamp: ago(w, 20 * 60_000) }])
  const B = seedBatch(w, 'approved', [{ ...threadItem('fb-1'), rendered_text: text, post_attempted_at: ago(w, 20 * 60_000) }])
  await pass(w)
  assert.equal(copies(w, 'fb-1', text), 1)
  assert.equal(status(w, B.items[0].id), 'sent')
})

test('FIX-1 post_attempted_at is written, fenced on the claim, right before the post and never moved', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'fb-1', accountID: 'facebookgo.test' })
  const B = seedBatch(w, 'approved', [threadItem('fb-1')])
  await pass(w)
  const stamp = w.reqs.findIndex((r) => r.method === 'PATCH' && r.body?.post_attempted_at)
  const post = w.reqs.findIndex((r) => r.host === 'beeper' && r.method === 'POST' && r.path.endsWith('/messages'))
  assert.ok(stamp >= 0 && stamp < post)
  assert.match(w.reqs[stamp].url, /claimed_at=eq\./)
  assert.match(w.reqs[stamp].url, /post_attempted_at=is\.null/)
  assert.ok(item(w, B.items[0].id).post_attempted_at)
  assert.equal(pgReqs(w, /PATCH inbox_batch_items/).filter((r) => r.body?.post_attempted_at).length, 1)
})

test('FIX-1 a reclaimed item that never reached a post may still be handed back', async () => {
  const w = makeWorld()
  w.bp.addSmsChat(KEYS[1], { id: 'unrelated' })
  const B = seedBatch(w, 'sending', [{ ...smsItem(KEYS[0]), status: 'sending', claimed_at: ago(w, 10 * 60_000) }])
  w.pg.tables.inbox_settings[0].new_chat_daily_cap = 0
  await pass(w)
  assert.equal(status(w, B.items[0].id), 'approved')
})

// ── FIX-2 · a batch-rail error never escapes runPass ────────────────────────
test('FIX-2 missing park columns: runPass resolves, claims nothing, and says why', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'fb-1', accountID: 'facebookgo.test' })
  const B = seedBatch(w, 'approved', [threadItem('fb-1')])
  w.pg.intercept = (r) => (/pending_message_id|post_attempted_at|park_check/.test(r.url) ? new Response('{"code":"42703","message":"column inbox_batch_items.pending_message_id does not exist"}', { status: 400 }) : undefined)
  const r = await pass(w)
  assert.ok(r.railDisabled && /42703|does not exist/.test(r.railDisabled))
  assert.equal(status(w, B.items[0].id), 'approved')
  assert.equal(beeperReqs(w, /POST/).length, 0)
})

test('FIX-2 a 500 on the batch or item list does not reject the pass', async () => {
  for (const which of ['inbox_batches', 'inbox_batch_items']) {
    const w = makeWorld()
    w.bp.addChat({ id: 'fb-1', accountID: 'facebookgo.test' })
    seedBatch(w, 'approved', [threadItem('fb-1')])
    w.pg.intercept = (r) => (r.method === 'GET' && r.path.endsWith(which) && !r.url.includes('limit=0') && !r.url.includes('id=eq.') ? new Response('boom', { status: 500 }) : undefined)
    await assert.doesNotReject(pass(w), which)
  }
})

// ── FIX-3 · held new-number items do not starve the rest ────────────────────
test('FIX-3 existing-chat items behind more than 60 held new numbers still send', async () => {
  const w = makeWorld()
  w.pg.tables.inbox_settings[0].new_chat_daily_cap = 1
  w.pg.tables.inbox_new_chat_log.push({ id: uid('log'), kind: 'marketing', op_id: 'x', opened_at: ago(w, 3_600_000) })
  for (let i = 0; i < 5; i++) w.bp.addChat({ id: `t${i}`, accountID: 'facebookgo.test' })
  const held = Array.from({ length: 61 }, (_, i) => smsItem(KEYS[i % KEYS.length]))
  const B = seedBatch(w, 'approved', [...held, ...Array.from({ length: 5 }, (_, i) => threadItem(`t${i}`))])
  await pass(w)
  for (const it of B.items.slice(61)) assert.equal(status(w, it.id), 'sent')
  // A known cap verdict is reused: held items do not each re-count the log.
  const counts = pgReqs(w, /GET inbox_new_chat_log/).filter((r) => r.url.includes('opened_at=gte')).length
  assert.ok(counts <= 2, `count reads: ${counts}`)
})

// ── FIX-4 · a lock the OS releases ──────────────────────────────────────────
test('FIX-4 a second engine refuses; a killed holder releases the lock', async () => {
  const name = `wce-engine-test-${process.pid}-${Date.now()}`
  const release = await acquireInstanceLock(name)
  await assert.rejects(acquireInstanceLock(name), AlreadyRunningError)
  release()
  const again = await acquireInstanceLock(name)
  again()

  // A holder that dies without any clean-up (like a closed console window).
  const lockPath = path.join(here, '..', 'lib', 'instanceLock.ts').replace(/\\/g, '/')
  const child = spawn(process.execPath, ['--import', 'tsx', '-e',
    `import('file:///${lockPath}').then(m => m.acquireInstanceLock(${JSON.stringify(name)})).then(() => { console.log('held'); setInterval(() => {}, 1000) })`],
  { cwd: path.join(here, '..', '..'), stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('held')) resolve() })
    child.on('exit', (c) => reject(new Error(`child exited ${c}`)))
  })
  await assert.rejects(acquireInstanceLock(name), AlreadyRunningError)
  child.removeAllListeners('exit')
  await new Promise<void>((r) => { child.on('exit', () => r()); child.kill('SIGKILL') })
  const after = await acquireInstanceLock(name)
  after()
})

// ── FIX-5 · status, deadline and pause re-read right before each claim ──────
test('FIX-5 a pause or an expiry landing during the chat scan stops that claim', async () => {
  for (const how of ['pause', 'expire'] as const) {
    const w = makeWorld()
    w.bp.addSmsChat(KEYS[0])
    const B = seedBatch(w, 'approved', [smsItem(KEYS[0])])
    w.bp.intercept = (r) => {
      if (r.path === '/v1/chats/search') {
        if (how === 'pause') w.pg.tables.inbox_settings[0].sends_paused = true
        else w.pg.tables.inbox_batches[0].expires_at = new Date(w.clock.now - 1).toISOString()
      }
      return undefined
    }
    await pass(w)
    assert.equal(status(w, B.items[0].id), 'approved', how)
    assert.equal(item(w, B.items[0].id).claimed_at, null, how)
    assert.equal(w.bp.posts().length, 0, how)
  }
})

test('FIX-5 a reclaim re-reads the pause right before it claims', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'fb-1', accountID: 'facebookgo.test' })
  const B = seedBatch(w, 'sending', [{ ...threadItem('fb-1'), status: 'sending', claimed_at: ago(w, 10 * 60_000) }])
  w.pg.intercept = (r) => {
    if (r.method === 'GET' && r.path.endsWith('inbox_batch_items') && r.url.includes('claimed_at.lt')) w.pg.tables.inbox_settings[0].sends_paused = true
    return undefined
  }
  await pass(w)
  assert.equal(pgReqs(w, /PATCH inbox_batch_items/).filter((r) => r.body?.claimed_at).length, 0)
  assert.equal(status(w, B.items[0].id), 'sending')
  assert.equal(w.bp.posts().length, 0)
})

// ── FIX-6 · one ledger key for SMS ──────────────────────────────────────────
test('FIX-6 an sms send resolved from a park is recorded under +61<key>, like an in-pass send', async () => {
  const w = makeWorld()
  w.bp.addSmsChat(KEYS[0], { id: 'gm-1' })
  w.bp.addSmsChat(KEYS[1], { id: 'gm-2' })
  const keys: string[] = []
  const hooks: Hooks = { afterSent: async ({ recipientKey }) => { keys.push(recipientKey) } }
  seedBatch(w, 'approved', [smsItem(KEYS[0]), smsItem(KEYS[1])])
  // The first confirms in-pass; the second stays PENDING and is parked.
  let n = 0
  w.bp.intercept = async (r) => {
    if (r.method === 'POST' && r.path.endsWith('/messages') && ++n === 2) {
      const inner = w.bp.intercept; w.bp.intercept = null
      const res = await w.bp.handle(r); const body = await res.json()
      w.bp.intercept = inner
      w.bp.statuses.set(body.pendingMessageID, ['PENDING'])
      return new Response(JSON.stringify(body), { status: 200 })
    }
    return undefined
  }
  await pass(w, newEngineState(), hooks)
  w.bp.intercept = null
  w.bp.statuses.clear()
  w.clock.now += 61_000
  await pass(w, newEngineState(), hooks)
  assert.deepEqual(keys, [`+61${KEYS[0]}`, `+61${KEYS[1]}`])
})

// ── The small items ─────────────────────────────────────────────────────────
test('minor: the "either" park fence quotes the message id inside or=()', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'fb-1', accountID: 'facebookgo.test' })
  seedBatch(w, 'approved', [threadItem('fb-1')])
  await pass(w)
  const sent = pgReqs(w, /PATCH inbox_batch_items/).find((r) => r.body?.status === 'sent')!
  assert.ok(decodeURIComponent(sent.url).includes('pending_message_id.eq."pm-'), sent.url)
})

test('minor: stuck rows of closed batches do not starve a real stale claim', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'fb-1', accountID: 'facebookgo.test' })
  seedBatch(w, 'draft', Array.from({ length: 25 }, () => ({ ...threadItem('fb-x'), status: 'sending', claimed_at: ago(w, 3_600_000) })))
  const R = seedBatch(w, 'sending', [{ ...threadItem('fb-1'), status: 'sending', claimed_at: ago(w, 10 * 60_000) }])
  await pass(w)
  assert.equal(status(w, R.items[0].id), 'sent')
})

test('minor: an outage spends no park re-checks', async () => {
  const w = makeWorld()
  const B = seedBatch(w, 'sending', [{ ...threadItem('fb-1'), status: 'sending', claimed_at: ago(w, 3_600_000), pending_message_id: 'pm-1', pending_chat_id: 'fb-1', park_checks: 2, park_checked_at: ago(w, 3_600_000) }])
  w.bp.intercept = () => 'throw'
  await pass(w)
  assert.equal(item(w, B.items[0].id).park_checks, 2)
})

test('minor: a read-back nobody answers spends no park re-check', async () => {
  const w = makeWorld()
  w.bp.addChat({ id: 'fb-1', accountID: 'facebookgo.test' })
  const B = seedBatch(w, 'sending', [{ ...threadItem('fb-1'), status: 'sending', claimed_at: ago(w, 3_600_000), pending_message_id: 'pm-1', pending_chat_id: 'fb-1', park_checks: 2, park_checked_at: ago(w, 3_600_000) }])
  w.bp.intercept = (r) => (r.method === 'GET' && /\/messages\/pm-1$/.test(r.path) ? 'throw' : undefined)
  await pass(w)
  assert.equal(item(w, B.items[0].id).park_checks, 2)
})

test('minor: a missing SMS account id disables only the send rail', () => {
  const r = tryReadEngineConfig({ SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'y', BEEPER_ACCESS_TOKEN: 'z' })
  assert.equal(r.cfg, null)
  assert.match(r.error!, /SMS_BEEPER_ACCOUNT_ID/)
})

test('minor: an overnight Beeper outage in quiet hours does not pause the next day', async () => {
  const w = makeWorld()
  w.bp.intercept = () => 'throw'
  const state = newEngineState()
  for (let i = 0; i < 10; i++) { await pass(w, state, {}, { allowClaims: false }); w.clock.now += 60_000 }
  assert.equal(pgReqs(w, /rpc\/inbox_auto_pause/).length, 0)
  w.bp.intercept = null
  await pass(w, state) // morning, Beeper back
  assert.equal(pgReqs(w, /rpc\/inbox_auto_pause/).length, 0)
})

test('minor: a park that runs out of checks is settled from the inbox mirror', async () => {
  for (const inMirror of [true, false]) {
    const w = makeWorld()
    w.bp.addChat({ id: 'gm-9', accountID: 'gmessages.test/1' })
    w.bp.defaultStatus = ['PENDING']
    const text = 'Last check text'
    const B = seedBatch(w, 'sending', [{ ...threadItem('gm-9'), rendered_text: text, status: 'sending', claimed_at: ago(w, 3_600_000), post_attempted_at: ago(w, 3_600_000), pending_message_id: 'pm-9', pending_chat_id: 'gm-9', park_checks: PARK_MAX_CHECKS - 1, park_checked_at: ago(w, 3_600_000) }])
    w.pg.tables.inbox_conversations.push({ id: 'conv-9', external_chat_id: 'gm-9', adapter: 'beeper' })
    if (inMirror) w.pg.tables.inbox_messages.push({ id: 'msg-9', conversation_id: 'conv-9', direction: 'outbound', text, timestamp: ago(w, 3_590_000) })
    await pass(w)
    const it = item(w, B.items[0].id)
    if (inMirror) {
      assert.equal(it.status, 'sent')
      assert.equal(it.chat_id, 'gm-9')
    } else {
      assert.equal(it.status, 'failed')
      assert.match(it.error, /never confirmed/)
    }
  }
})

// ── Go-live: alert texts off with a blank NOTIFY_PHONE ──────────────────────
test('go-live: a blank alert number never reaches Beeper', async () => {
  const { BeeperAdapter } = await import('../adapters/beeper/adapter')
  const calls: string[] = []
  const fakeClient = {
    startChat: async () => { calls.push('startChat'); return 'chat-x' },
    sendMessage: async () => { calls.push('sendMessage'); return { pendingMessageID: 'pm' } },
  }
  const adapter = new BeeperAdapter(fakeClient as never, 'gmessages.test/1')
  for (const blank of ['', '   ', '+']) {
    const r = await adapter.startChatAndSend('gmessages', blank, 'WCP opt-out / cold replies')
    assert.equal(r.ok, false)
  }
  assert.deepEqual(calls, [])
  // A real number still goes through.
  const ok = await adapter.startChatAndSend('gmessages', '+61491570156', 'hi')
  assert.equal(ok.ok, true)
  assert.deepEqual(calls, ['startChat', 'sendMessage'])
})
