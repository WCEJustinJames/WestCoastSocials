import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { runPass, newEngineState } from './smsEngine'
import { FINAL_RECIPIENT as TY, prepareFinalRecipient, isFinalRecipient, finalRecipientId, renderFinalMessage } from './finalRecipient'
import { makeWorld, seedBatch, smsItem, threadItem, KEYS, item } from './testkit/fakeWorld'

process.env.BATCH_FINAL_OUTREACH_ID = '00000000-0000-4000-a000-000000000001'
process.env.BATCH_FINAL_PHONE = '+61491570737'
process.env.BATCH_FINAL_CHAT_ID = 'fake-ty-messenger'
process.env.BATCH_FINAL_NAME = 'Tai Chi Ly'
process.env.BATCH_FINAL_NICKNAME = 'Ty'

type W = ReturnType<typeof makeWorld>
function client(w: W) {
  return createClient(w.cfg.supabaseUrl, 'fake-test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      // The existing fake accepts capitalised Prefer; emulate PostgREST's single mode.
      const r = await w.deps.fetch(String(input), { ...init, headers: { ...headers, Prefer: headers.prefer ?? '' } })
      if (r.ok && headers.accept?.includes('vnd.pgrst.object')) {
        const data = await r.json()
        return new Response(JSON.stringify(Array.isArray(data) ? data[0] : data), { headers: { 'Content-Type': 'application/json' } })
      }
      return r
    } },
  })
}
function setup() {
  const w = makeWorld()
  w.pg.tables.inbox_settings[0].new_chat_spacing_seconds = 0
  w.bp.addSmsChat('491570737', { id: 'ty-sms' })
  w.bp.addSmsChat(KEYS[0], { id: 'player-sms' })
  const db = client(w)
  const hooks = { prepareBatch: (b: any) => prepareFinalRecipient(db, b) }
  return { w, db, hooks }
}
test('final recipient is added once, uses SMS, renders Ty and sends after the audience', async () => {
  const { w, db, hooks } = setup()
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0])], { is_outreach: true, template_body: 'Hey {nickname}, game tonight?\\nSee you there.' })
  await prepareFinalRecipient(db, B.batch as any)
  await prepareFinalRecipient(db, B.batch as any)
  assert.equal(w.pg.tables.inbox_batch_items.filter(r => isFinalRecipient({ data: r.data })).length, 1)
  const final = item(w, finalRecipientId(B.batch.id))
  assert.equal(final.rendered_text, 'Hey Ty, game tonight?\nSee you there.')
  // Put Ty FIRST deliberately: the send-time barrier must still hold him.
  final.created_at = '2000-01-01T00:00:00Z'
  const state = newEngineState()
  await runPass(w.deps, w.cfg, state, hooks)
  assert.equal(final.status, 'approved')
  assert.equal(w.bp.posts('ty-sms').length, 0)
  await runPass(w.deps, w.cfg, state, hooks)
  assert.equal(final.status, 'sent')
  assert.equal(w.bp.posts('ty-sms').length, 1)
  assert.equal(item(w, B.items[0].id).status, 'sent')
  await runPass(w.deps, w.cfg, state, hooks)
  assert.equal(w.bp.posts('ty-sms').length, 1)
})
test('an ordinary Ty Messenger entry is replaced by exactly one final SMS', async () => {
  const { w, db } = setup()
  const B = seedBatch(w, 'approved', [threadItem(TY.chatId, { outreach_id: TY.outreachId }), smsItem(KEYS[0])], { is_outreach: true, template_body: 'Hi {first}' })
  await prepareFinalRecipient(db, B.batch as any)
  assert.equal(item(w, B.items[0].id).status, 'skipped')
  const finals = w.pg.tables.inbox_batch_items.filter(r => isFinalRecipient({ data: r.data }))
  assert.equal(finals.length, 1)
  assert.equal(finals[0].data.channel, 'sms')
  assert.equal(finals[0].data.phone, TY.phone)
})
test('final SMS waits for a recipient still sending; pause and opt-out remain effective', async () => {
  const { w, db, hooks } = setup()
  const B = seedBatch(w, 'sending', [{ ...smsItem(KEYS[0]), status: 'sending', claimed_at: new Date(w.clock.now).toISOString() }], { is_outreach: true, template_body: 'Hi {first}, tonight?' })
  await prepareFinalRecipient(db, B.batch as any)
  await runPass(w.deps, w.cfg, newEngineState(), hooks)
  assert.equal(w.bp.posts('ty-sms').length, 0)
  item(w, B.items[0].id).status = 'sent'
  w.pg.tables.inbox_settings[0].sends_paused = true
  await runPass(w.deps, w.cfg, newEngineState(), hooks)
  assert.equal(w.bp.posts('ty-sms').length, 0)
  w.pg.tables.inbox_settings[0].sends_paused = false
  w.pg.rpc.outreach_canonical_suppression_reason = () => 'do_not_message'
  await runPass(w.deps, w.cfg, newEngineState(), hooks)
  assert.equal(item(w, finalRecipientId(B.batch.id)).status, 'skipped')
  assert.equal(w.bp.posts('ty-sms').length, 0)
})
test('private one-to-one messages and batches already sent to Ty get no extra copy', async () => {
  const { w, db } = setup()
  const one = seedBatch(w, 'approved', [smsItem(KEYS[0])], { is_outreach: false, template_body: 'Private message' })
  await prepareFinalRecipient(db, one.batch as any)
  const sent = seedBatch(w, 'sending', [{ ...smsItem('491570737'), status: 'sent' }, smsItem(KEYS[0])], { is_outreach: true, template_body: 'Hello' })
  await prepareFinalRecipient(db, sent.batch as any)
  assert.equal(w.pg.tables.inbox_batch_items.filter(r => isFinalRecipient({ data: r.data })).length, 0)
})
test('known name placeholders render; unresolved details stop preparation', async () => {
  const { w, db } = setup()
  assert.equal(renderFinalMessage('Hi {{first_name}} / {name} / {{nickname}}'), 'Hi Ty / Tai Chi Ly / Ty')
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0])], { is_outreach: true, template_body: 'Hi {first}, {venue}' })
  await assert.rejects(prepareFinalRecipient(db, B.batch as any), /complete batch template/)
  assert.equal(w.pg.tables.inbox_batch_items.filter(r => isFinalRecipient({ data: r.data })).length, 0)
})

test('a late ordinary Ty send suppresses the queued final copy', async () => {
  const { w, db } = setup()
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0])], { is_outreach: true, template_body: 'Hi Ty, tonight?' })
  await prepareFinalRecipient(db, B.batch as any)
  w.pg.tables.inbox_batch_items.push({ ...smsItem('491570737'), id: 'late-ty', batch_id: B.batch.id, status: 'sent' })
  await prepareFinalRecipient(db, B.batch as any)
  assert.equal(item(w, finalRecipientId(B.batch.id)).status, 'skipped')
})
test('non-outreach notices are never copied, even with several recipients', async () => {
  const { w, db } = setup()
  const B = seedBatch(w, 'approved', [smsItem(KEYS[0]), smsItem(KEYS[1])], { is_outreach: false, template_body: 'Staff payment details' })
  await prepareFinalRecipient(db, B.batch as any)
  assert.equal(w.pg.tables.inbox_batch_items.filter(r => isFinalRecipient({ data: r.data })).length, 0)
})
